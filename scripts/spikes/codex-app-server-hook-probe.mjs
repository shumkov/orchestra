// Credential-free hook-notification release gate for the pinned Codex
// app-server.
//
// The authoritative lanes drive the production `CodexAppServerClient`, so the
// gate exercises the real schema-backed notification boundary rather than the
// spike transport. A hooks-on and a hooks-off lane each run a real turn to a
// delivered `turn/completed`; `hook/started` and `hook/completed` must never
// reach the production delivered sink. Exact fail-closed handling of every
// other `hook/*` method is covered deterministically by
// "Codex U1a faults a well-formed but unlisted hook notification" in
// tests/codex-app-server-spike.test.js and is not re-proved with a live peer.
//
// Turns complete against a loopback Responses provider declaring
// `requires_openai_auth = false`, inside isolated homes that contain no
// `auth.json`. Credential-free is a property of that construction and is read
// back from the config actually written.
//
// Every emitted value is content-free by construction: booleans, enums,
// counts, and digests only. Peer-controlled strings are matched against closed
// enums and never echoed; anything outside them becomes a failure category.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  CodexAppServerClient,
  attestPinnedCodexBinary,
  protocolSchema,
  resolveCodexTargetPin,
} from '../../lib/codex/app-server-client.js';

export const USAGE = [
  'node scripts/spikes/codex-app-server-hook-probe.mjs \\',
  '  --binary /absolute/versioned/path/to/codex \\',
  '  --probe-root /absolute/non-temporary/probe-root',
].join('\n');

const MOCK_MODEL = 'mock-model';
const PROVIDER_ID = 'u23_loopback';
const PERMISSION_PROFILE = 'polygram-session';
export const EXPECTED_HOOK_EVENTS = Object.freeze(['sessionStart', 'userPromptSubmit']);
const HOOK_CONFIG_KEYS = Object.freeze({
  sessionStart: 'SessionStart',
  userPromptSubmit: 'UserPromptSubmit',
});
// Only `userPromptSubmit` receives `turn_id` on hook stdin; `sessionStart`
// legitimately omits it, so its capture must exist without one.
const STDIN_SUPPLIES_TURN_ID = Object.freeze({
  sessionStart: false,
  userPromptSubmit: true,
});
const HOOK_RUN_STATUSES = Object.freeze([
  'running', 'completed', 'failed', 'blocked', 'stopped',
]);
const HOOK_NOTIFICATION_METHODS = Object.freeze(['hook/started', 'hook/completed']);
const TURN_STATUSES = Object.freeze(['completed', 'interrupted', 'failed', 'inProgress']);
const STDIN_VERDICTS = Object.freeze([
  'matches-authoritative-turn',
  'present-without-turn-id',
  'missing',
  'mismatch',
  'unexpected-turn-id',
  'unexpected-invocation-count',
  'unreadable',
]);
// Capture files are named `<event>.<pid>.json` so every invocation is counted
// rather than overwritten by the last writer.
const CAPTURE_FILE_PATTERN = /^([A-Za-z]+)\.(\d+)\.json$/;

const RAW_NOTIFICATION_METHODS = new Set([
  ...protocolSchema.deliveredServerNotifications,
  ...protocolSchema.droppedServerNotifications,
]);

const MAX_RAW_LINE_BYTES = 1024 * 1024;
const MAX_RAW_MESSAGES = 512;
const MAX_RAW_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_RAW_STDERR_BYTES = 64 * 1024;
const RAW_REQUEST_TIMEOUT_MS = 20_000;
const TURN_COMPLETION_TIMEOUT_MS = 45_000;
const CHILD_EXIT_GRACE_MS = 1_000;
const PROVIDER_CLOSE_TIMEOUT_MS = 2_000;
const STDOUT_DRAIN_TIMEOUT_MS = 5_000;

export const FAILURE_CATEGORIES = Object.freeze([
  'attestation',
  'provisioning',
  'transport',
  'protocol',
  'framing',
  'bounds',
  'timeout',
  'cleanup',
  'unknown',
]);

// Accepts either a thrown error or the frozen fault outcome the production
// client hands to `onFault`, which carries `errorCode` rather than `code`.
export function categorizeFailure(error) {
  const rawCode = error?.code ?? error?.errorCode ?? error?.clientRootErrorCode;
  const code = typeof rawCode === 'string' ? rawCode : '';
  if (code === 'CODEX_BINARY_MISMATCH' || code === 'CODEX_UNSUPPORTED_PLATFORM') {
    return 'attestation';
  }
  if (code === 'CODEX_CONFIG_MISMATCH' || code === 'CODEX_SESSION_LAUNCHER_MISMATCH') {
    return 'provisioning';
  }
  if (
    code === 'CODEX_PROCESS_CLEANUP_UNVERIFIED'
    || code === 'CODEX_PROCESS_CLOSE_TIMEOUT'
  ) return 'cleanup';
  if (code === 'CODEX_PROTOCOL_ERROR' || code === 'CODEX_RPC_REJECTED') return 'protocol';
  if (code === 'CODEX_TRANSPORT_ERROR') return 'transport';
  if (code === 'CODEX_RPC_TIMEOUT' || code === 'CODEX_SINK_TIMEOUT') return 'timeout';
  if (error?.probeCategory && FAILURE_CATEGORIES.includes(error.probeCategory)) {
    return error.probeCategory;
  }
  return 'unknown';
}

function probeFailure(category, stage) {
  const error = new Error(`hook probe ${category} failure`);
  error.probeCategory = FAILURE_CATEGORIES.includes(category) ? category : 'unknown';
  error.probeStage = stage;
  return error;
}

export function stopEnvelope(error) {
  return {
    gate: 'STOP',
    failedChecks: ['probeCompleted'],
    failureCategory: categorizeFailure(error),
  };
}

export function envelopeIsContentFree(envelope) {
  const serialized = JSON.stringify(envelope);
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(serialized)) {
    return false;
  }
  if (/(\/Users\/|\/private\/|\/tmp\/|\/home\/|\.toml|\.json|sha256:)/.test(serialized)) {
    return false;
  }
  return true;
}

// A peer-controlled string is only ever emitted after matching a closed enum.
function closedEnum(value, allowed, stage) {
  if (!allowed.includes(value)) throw probeFailure('framing', stage);
  return value;
}

export function looksLikeEpochSeconds(value) {
  return Number.isSafeInteger(value) && value >= 1_000_000_000 && value < 10_000_000_000;
}

// POSIX single-quote quoting so a probe root containing spaces or quotes still
// produces a correct hook command.
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function hookCommandFor(scriptPath, eventName, extraArgument = '') {
  closedEnum(eventName, EXPECTED_HOOK_EVENTS, 'hook-command-event');
  return `sh ${shellQuote(scriptPath)} ${eventName}${extraArgument}`;
}

// Hook stdin carries the user prompt, cwd, and transcript path, so it is
// parsed in place and never written to disk. Only the closed fields the gate
// needs are persisted: the event, whether a turn id was supplied, and its
// digest.
export function hookCaptureScriptBody(captureDir) {
  const quotedDir = shellQuote(captureDir);
  return [
    '#!/bin/sh',
    'event="$1"',
    'payload=$(head -c 65536)',
    'turn=$(printf %s "$payload" | sed -n \'s/.*"turn_id"[[:space:]]*:[[:space:]]*"\\([0-9A-Za-z-]*\\)".*/\\1/p\' | head -n 1)',
    'if [ -n "$turn" ]; then',
    '  digest=$(printf %s "$turn" | shasum -a 256 | cut -d " " -f 1)',
    `  printf '{"eventName":"%s","turnIdPresent":true,"turnIdSha256":"%s"}\\n' "$event" "$digest" > ${quotedDir}/"$event.$$.json"`,
    'else',
    `  printf '{"eventName":"%s","turnIdPresent":false,"turnIdSha256":null}\\n' "$event" > ${quotedDir}/"$event.$$.json"`,
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

export function readProviderRequiresAuth(configText) {
  const match = /^\s*requires_openai_auth\s*=\s*(true|false)\s*$/m.exec(String(configText));
  return match ? match[1] === 'true' : null;
}

export function renderTrustedHookState(hooks) {
  if (!Array.isArray(hooks) || hooks.length === 0) {
    throw new Error('no hooks were discovered to trust');
  }
  return hooks.map((hook) => {
    if (typeof hook?.key !== 'string' || typeof hook?.currentHash !== 'string') {
      throw new Error('discovered hook is missing its key or current hash');
    }
    return [
      `[hooks.state.${JSON.stringify(hook.key)}]`,
      `trusted_hash = ${JSON.stringify(hook.currentHash)}`,
      'enabled = true',
      '',
    ].join('\n');
  }).join('\n');
}

// Exactly one invocation per configured event, with the expected turn identity
// shape for each.
export function summarizeStdinCaptures(records, authoritativeTurnSha256) {
  const counts = new Map();
  for (const record of records) {
    const eventName = closedEnum(record.eventName, EXPECTED_HOOK_EVENTS, 'stdin-event');
    const entry = counts.get(eventName) ?? { count: 0, digests: [], present: [] };
    entry.count += 1;
    entry.digests.push(record.turnIdSha256 ?? null);
    entry.present.push(record.turnIdPresent === true);
    counts.set(eventName, entry);
  }
  const verdicts = {};
  for (const eventName of EXPECTED_HOOK_EVENTS) {
    const entry = counts.get(eventName);
    if (!entry) {
      verdicts[eventName] = 'missing';
      continue;
    }
    if (entry.count !== 1) {
      verdicts[eventName] = 'unexpected-invocation-count';
      continue;
    }
    const [digest] = entry.digests;
    const [present] = entry.present;
    if (STDIN_SUPPLIES_TURN_ID[eventName]) {
      verdicts[eventName] = present && digest && digest === authoritativeTurnSha256
        ? 'matches-authoritative-turn'
        : 'mismatch';
    } else {
      verdicts[eventName] = present ? 'unexpected-turn-id' : 'present-without-turn-id';
    }
  }
  return verdicts;
}

function sameEventMultiset(observed) {
  if (!Array.isArray(observed)) return false;
  const left = [...observed].sort();
  const right = [...EXPECTED_HOOK_EVENTS].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hookPairsAreExact(pairs) {
  if (!Array.isArray(pairs) || !sameEventMultiset(pairs.map((pair) => pair?.eventName))) {
    return false;
  }
  return pairs.every((pair) => (
    pair.notificationCount === 2
    && pair.orderedStartThenComplete === true
    && pair.startedStatus === 'running'
    && pair.completedStatus === 'completed'
  ));
}

function laneIsClean(lane) {
  return lane.source === 'production-client'
    && lane.turnStatus === 'completed'
    && lane.assistantItemObserved === true
    && (lane.faultCategory ?? null) === null
    && lane.turnStartResponseMatchesStarted === true
    && lane.completedTurnMatchesStarted === true;
}

export function evaluateHookProbeGate(evidence) {
  const authoritative = evidence.authoritative ?? {};
  const control = evidence.control ?? {};
  const lifecycle = evidence.trustLifecycle ?? {};
  const stdin = evidence.hookStdin ?? {};
  const credentialFree = evidence.credentialFree ?? {};
  const checks = {
    pinnedBinaryAttested: evidence.pinnedBinaryAttested === true,
    isolatedCodexHomeMode0700: evidence.isolatedCodexHomeMode0700 === true,
    credentialFreeByConstruction:
      credentialFree.authFileAbsent === true
      && credentialFree.providerRequiresAuth === false,
    hookTrustLifecycle: [
      'discoveredUntrusted',
      'renderedTrusted',
      'mutatedHashChanged',
      'mutatedStatusModified',
      'configDigestUnchangedOnMutation',
      'reRenderedDigestChanged',
      'reRenderedTrusted',
    ].every((step) => lifecycle[step] === true),
    // The gate is about the production boundary; spike or raw evidence cannot
    // stand in for it.
    authoritativeLaneIsProductionClient: authoritative.source === 'production-client',
    authoritativeTurnCompleted:
      authoritative.turnStatus === 'completed'
      && authoritative.assistantItemObserved === true
      && (authoritative.faultCategory ?? null) === null,
    authoritativeTurnIdentityConsistent:
      authoritative.turnStartResponseMatchesStarted === true
      && authoritative.completedTurnMatchesStarted === true,
    authoritativeHookSinkClean:
      Array.isArray(authoritative.deliveredHookMethods)
      && authoritative.deliveredHookMethods.length === 0,
    hookEventSetExact: sameEventMultiset(evidence.hookEvents),
    hookNotificationPairsExact: hookPairsAreExact(evidence.hookPairs),
    hookTimestampsAreSeconds:
      Array.isArray(evidence.hookPairs)
      && evidence.hookPairs.length > 0
      && evidence.hookPairs.every((pair) => (
        pair.startedAtIsSeconds === true && pair.completedAtIsSeconds === true
      )),
    hookStdinCapturesExact:
      Object.keys(stdin).length === EXPECTED_HOOK_EVENTS.length
      && EXPECTED_HOOK_EVENTS.every((eventName) => (
        stdin[eventName] === (STDIN_SUPPLIES_TURN_ID[eventName]
          ? 'matches-authoritative-turn'
          : 'present-without-turn-id')
      )),
    // The control lane is held to the same completion and identity predicates
    // as hooks-on, and additionally must see no hook traffic at all.
    controlLaneClean:
      laneIsClean(control)
      && Array.isArray(control.deliveredHookMethods)
      && control.deliveredHookMethods.length === 0,
    ownedConfigDigestStable: evidence.ownedConfigDigestStable === true,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    gate: failedChecks.length === 0 ? 'CONTINUE' : 'STOP',
    checks,
    failedChecks,
  };
}

function pickBoolean(value, stage) {
  if (typeof value !== 'boolean') throw probeFailure('framing', stage);
  return value;
}

function pickCount(value, stage) {
  if (!Number.isSafeInteger(value) || value < 0) throw probeFailure('framing', stage);
  return value;
}

function pickNullableEnum(value, allowed, stage) {
  if (value == null) return null;
  return closedEnum(value, allowed, stage);
}

const TRUST_LIFECYCLE_STEPS = Object.freeze([
  'discoveredUntrusted',
  'renderedTrusted',
  'mutatedHashChanged',
  'mutatedStatusModified',
  'configDigestUnchangedOnMutation',
  'reRenderedDigestChanged',
  'reRenderedTrusted',
]);

// Every emitted object is built key by key from approved names and approved
// scalar types. Nothing derived from evidence is ever spread, so an unapproved
// key cannot survive by escaping a denylist.
function projectLane(lane, stage) {
  if (!lane || typeof lane !== 'object') throw probeFailure('framing', stage);
  return {
    source: closedEnum(lane.source, ['production-client'], `${stage}-source`),
    turnStatus: pickNullableEnum(lane.turnStatus, TURN_STATUSES, `${stage}-turn-status`),
    assistantItemObserved: pickBoolean(lane.assistantItemObserved, `${stage}-assistant-item`),
    faultCategory: pickNullableEnum(lane.faultCategory, FAILURE_CATEGORIES, `${stage}-fault`),
    turnStartResponseMatchesStarted:
      pickBoolean(lane.turnStartResponseMatchesStarted, `${stage}-start-identity`),
    completedTurnMatchesStarted:
      pickBoolean(lane.completedTurnMatchesStarted, `${stage}-completed-identity`),
    deliveredHookMethods: (lane.deliveredHookMethods ?? []).map(
      (method) => closedEnum(method, HOOK_NOTIFICATION_METHODS, `${stage}-hook-method`),
    ),
  };
}

function projectHookPair(pair, stage) {
  if (!pair || typeof pair !== 'object') throw probeFailure('framing', stage);
  return {
    eventName: closedEnum(pair.eventName, EXPECTED_HOOK_EVENTS, `${stage}-event`),
    notificationCount: pickCount(pair.notificationCount, `${stage}-count`),
    orderedStartThenComplete: pickBoolean(pair.orderedStartThenComplete, `${stage}-order`),
    startedStatus: closedEnum(pair.startedStatus, HOOK_RUN_STATUSES, `${stage}-started-status`),
    completedStatus: closedEnum(pair.completedStatus, HOOK_RUN_STATUSES, `${stage}-completed-status`),
    startedAtIsSeconds: pickBoolean(pair.startedAtIsSeconds, `${stage}-started-seconds`),
    completedAtIsSeconds: pickBoolean(pair.completedAtIsSeconds, `${stage}-completed-seconds`),
    notificationTurnIdMatchesRawTurn:
      pickBoolean(pair.notificationTurnIdMatchesRawTurn, `${stage}-turn-match`),
  };
}

export function buildResultEnvelope(evidence) {
  try {
    const source = evidence ?? {};
    const projected = {
      pinnedBinaryAttested: pickBoolean(source.pinnedBinaryAttested, 'attested'),
      isolatedCodexHomeMode0700: pickBoolean(source.isolatedCodexHomeMode0700, 'home-mode'),
      credentialFree: {
        authFileAbsent: pickBoolean(source.credentialFree?.authFileAbsent, 'auth-absent'),
        providerRequiresAuth: pickBoolean(
          source.credentialFree?.providerRequiresAuth,
          'provider-auth',
        ),
      },
      trustLifecycle: Object.fromEntries(TRUST_LIFECYCLE_STEPS.map((step) => [
        step,
        pickBoolean(source.trustLifecycle?.[step], `lifecycle-${step}`),
      ])),
      authoritative: projectLane(source.authoritative, 'authoritative'),
      control: projectLane(source.control, 'control'),
      hookEvents: (source.hookEvents ?? []).map(
        (eventName) => closedEnum(eventName, EXPECTED_HOOK_EVENTS, 'hook-event'),
      ),
      hookPairs: (source.hookPairs ?? []).map((pair) => projectHookPair(pair, 'pair')),
      hookStdin: Object.fromEntries(Object.entries(source.hookStdin ?? {}).map(
        ([eventName, verdict]) => [
          closedEnum(eventName, EXPECTED_HOOK_EVENTS, 'stdin-key'),
          closedEnum(verdict, STDIN_VERDICTS, 'stdin-verdict'),
        ],
      )),
      ownedConfigDigestStable: pickBoolean(source.ownedConfigDigestStable, 'digest-stable'),
    };
    const gate = evaluateHookProbeGate(projected);
    const envelope = {
      gate: closedEnum(gate.gate, ['CONTINUE', 'STOP'], 'gate'),
      checks: Object.fromEntries(Object.entries(gate.checks).map(([name, passed]) => [
        name,
        pickBoolean(passed, `check-${name}`),
      ])),
      failedChecks: gate.failedChecks.map(
        (name) => closedEnum(name, Object.keys(gate.checks), 'failed-check'),
      ),
      evidence: projected,
    };
    // Defense in depth only; the closed-key projection above is the mechanism.
    if (!envelopeIsContentFree(envelope)) {
      throw probeFailure('framing', 'envelope-content');
    }
    return envelope;
  } catch (error) {
    return stopEnvelope(error);
  }
}

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function startLoopbackProvider() {
  const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const server = createServer((request, response) => {
    let body = 0;
    request.on('data', (chunk) => { body += chunk.length; });
    request.on('end', () => {
      if (body > 1024 * 1024) {
        response.writeHead(413);
        response.end();
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && pathname === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"models":[]}');
        return;
      }
      if (request.method !== 'POST' || pathname !== '/v1/responses') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        sse('response.created', { type: 'response.created', response: { id: 'probe-response' } }),
        sse('response.output_item.done', {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            id: 'probe-message',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        }),
        sse('response.completed', {
          type: 'response.completed',
          response: {
            id: 'probe-response',
            usage: {
              input_tokens: 0,
              input_tokens_details: null,
              output_tokens: 0,
              output_tokens_details: null,
              total_tokens: 0,
            },
          },
        }),
      ].join(''));
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise({
      port: server.address().port,
      close: () => new Promise((done, failClose) => {
        // Force remaining connections closed so a lingering keep-alive handle
        // cannot leave the probe hanging or the server half-open.
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close((error) => (error ? failClose(error) : done()));
      }),
    }));
  });
}

// One provisioning helper for every lane: isolated mode-0700 home, optional
// hooks.json, and the loopback provider block.
function provisionLane({ laneRoot, providerPort, withHooks, trustState = '', hookArgument = '' }) {
  const codexHome = path.join(laneRoot, 'codex-home');
  const workspace = path.join(laneRoot, 'workspace');
  const captureDir = path.join(laneRoot, 'stdin-capture');
  for (const dir of [laneRoot, codexHome, workspace, captureDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const canonicalWorkspace = realpathSync(workspace);
  const hookScript = path.join(laneRoot, 'probe-hook.sh');
  if (withHooks) {
    // `$$` makes every invocation its own capture file so invocations are
    // counted rather than overwritten.
    writeFileSync(hookScript, hookCaptureScriptBody(captureDir), { mode: 0o700 });
    chmodSync(hookScript, 0o700);
    writeFileSync(path.join(codexHome, 'hooks.json'), `${JSON.stringify({
      hooks: Object.fromEntries(EXPECTED_HOOK_EVENTS.map((eventName) => [
        HOOK_CONFIG_KEYS[eventName],
        [{ hooks: [{ type: 'command', command: hookCommandFor(hookScript, eventName, hookArgument) }] }],
      ])),
    }, null, 2)}\n`, { mode: 0o600 });
  }
  const config = [
    `model = ${JSON.stringify(MOCK_MODEL)}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`,
    `default_permissions = ${JSON.stringify(PERMISSION_PROFILE)}`,
    'approval_policy = "never"',
    'approvals_reviewer = "user"',
    'web_search = "disabled"',
    'allow_login_shell = false',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    '',
    `[permissions.${PERMISSION_PROFILE}.filesystem]`,
    '":minimal" = "read"',
    `${JSON.stringify(codexHome)} = "deny"`,
    '":workspace_roots" = { "." = "write" }',
    '',
    `[permissions.${PERMISSION_PROFILE}.network]`,
    'enabled = false',
    '',
    `[projects.${JSON.stringify(canonicalWorkspace)}]`,
    'trust_level = "untrusted"',
    '',
    `[model_providers.${PROVIDER_ID}]`,
    'name = "U23 loopback Responses"',
    `base_url = "http://127.0.0.1:${providerPort}/v1"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'stream_idle_timeout_ms = 5000',
    'requires_openai_auth = false',
    'supports_websockets = false',
    ...(withHooks ? ['', '[features]', 'hooks = true', '', trustState] : []),
  ].join('\n');
  const configPath = path.join(codexHome, 'config.toml');
  writeFileSync(configPath, `${config}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return {
    codexHome,
    workspace: canonicalWorkspace,
    captureDir,
    configPath,
    configSha256: createHash('sha256').update(readFileSync(configPath)).digest('hex'),
    env: { HOME: laneRoot, PATH: '/usr/bin:/bin', TMPDIR: canonicalWorkspace },
  };
}

function configDigest(configPath) {
  return createHash('sha256').update(readFileSync(configPath)).digest('hex');
}

// A single bounded raw stdio session, reused by trust discovery and by the
// secondary characterization of the payloads the production client drops.
// Envelopes are validated and projected on ingestion; nothing arbitrary is
// retained, and any terminal failure fails the whole session.
export async function withRawSession(
  { binary, codexHome, workspace, env, launcher, inspectGroup = inspectOwnedGroup },
  body,
) {
  const args = ['app-server', '--strict-config', '--stdio'];
  const child = spawn(
    launcher || binary,
    launcher ? [binary, ...args] : args,
    {
      cwd: workspace,
      env: { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own the process group so descendants are torn down with the session.
      detached: process.platform !== 'win32',
    },
  );
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let totalBytes = 0;
  let stderrBytes = 0;
  // Responses are routed straight to their pending request and never cached
  // for the session; only bounded closed-field projections survive.
  const pending = new Map();
  const hookSummaries = [];
  const notificationMethods = [];
  const waiters = [];
  let messageCount = 0;
  let failure = null;

  const fail = (category, stage) => {
    failure ??= probeFailure(category, stage);
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
    for (const [, request] of pending) request.reject(failure);
    pending.clear();
  };
  const settleWaiters = (record) => {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(record)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(record);
    }
  };

  const ingest = (message) => {
    const keys = Object.keys(message);
    const hasId = Object.hasOwn(message, 'id');
    const hasMethod = Object.hasOwn(message, 'method');
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasId && hasMethod) return fail('framing', 'raw-ambiguous-envelope');
    if (hasResult && hasError) return fail('framing', 'raw-ambiguous-response');
    // The exact supported key sets the production client accepts; anything
    // else, including an unexpected `jsonrpc` member, is unsupported framing.
    const allowed = hasId
      ? new Set(['id', hasError ? 'error' : 'result'])
      : new Set(['method', 'params', 'emittedAtMs']);
    if (keys.some((key) => !allowed.has(key))) return fail('framing', 'raw-unsupported-keys');
    if (hasId) {
      if (!hasResult && !hasError) return fail('framing', 'raw-empty-response');
      const request = pending.get(message.id);
      if (!request) return fail('framing', 'raw-unexpected-response-id');
      pending.delete(message.id);
      if (hasError) request.reject(probeFailure('protocol', request.stage));
      else request.resolve(message.result);
      return undefined;
    }
    if (!hasMethod) return fail('framing', 'raw-unknown-envelope');
    if (hasResult || hasError) return fail('framing', 'raw-ambiguous-notification');
    if (typeof message.method !== 'string' || !RAW_NOTIFICATION_METHODS.has(message.method)) {
      return fail('framing', 'raw-unknown-method');
    }
    // Project immediately; no arbitrary payload is retained for the session.
    const record = { kind: 'notification', method: message.method };
    if (HOOK_NOTIFICATION_METHODS.includes(message.method)) {
      const run = message.params?.run ?? {};
      // Peer-controlled ids are reduced to digests on ingestion so nothing
      // arbitrary is retained for the life of the session.
      hookSummaries.push({
        method: message.method,
        eventName: run.eventName,
        status: run.status,
        turnIdSha256: message.params?.turnId == null
          ? null
          : createHash('sha256').update(String(message.params.turnId)).digest('hex'),
        startedAtIsSeconds: looksLikeEpochSeconds(run.startedAt),
        completedAtIsSeconds: run.completedAt == null
          ? null
          : looksLikeEpochSeconds(run.completedAt),
      });
    }
    if (message.method === 'turn/completed') {
      record.turnStatus = message.params?.turn?.status ?? null;
      record.turnId = message.params?.turn?.id ?? null;
    }
    notificationMethods.push(message.method);
    return settleWaiters(record);
  };

  child.on('error', () => fail('transport', 'raw-spawn'));
  child.stdin.on('error', () => fail('transport', 'raw-stdin'));
  child.stderr.on('error', () => fail('transport', 'raw-stderr'));
  child.stdout.on('error', () => fail('transport', 'raw-stdout'));
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_RAW_STDERR_BYTES) fail('bounds', 'raw-stderr-bytes');
  });
  child.stdout.on('data', (chunk) => {
    if (failure) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_RAW_TOTAL_BYTES) return fail('bounds', 'raw-total-bytes');
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (Buffer.byteLength(line) > MAX_RAW_LINE_BYTES) return fail('bounds', 'raw-line-bytes');
      messageCount += 1;
      if (messageCount > MAX_RAW_MESSAGES) return fail('bounds', 'raw-message-count');
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return fail('framing', 'raw-json');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail('framing', 'raw-shape');
      }
      ingest(parsed);
      if (failure) return undefined;
    }
    // The bound must hold on an undelimited partial too, matching the
    // production client.
    if (Buffer.byteLength(buffer) > MAX_RAW_LINE_BYTES) {
      buffer = '';
      fail('bounds', 'raw-partial-line');
    }
    return undefined;
  });
  // Resolved only when stdout truly reaches EOF, which requires every writer
  // holding the descriptor — including any inherited grandchild — to close it.
  let stdoutDrained = false;
  const stdoutDrain = new Promise((resolvePromise) => {
    const settle = () => {
      stdoutDrained = true;
      resolvePromise();
    };
    child.stdout.once('end', settle);
    child.stdout.once('close', settle);
  });
  child.stdout.on('end', () => {
    // Flush the decoder: a trailing partial or unfinished work at EOF is a
    // framing failure, not a clean end of stream.
    buffer += decoder.end();
    if (buffer.trim().length > 0) {
      buffer = '';
      return fail('framing', 'raw-trailing-partial');
    }
    if (pending.size > 0) return fail('framing', 'raw-eof-pending');
    return undefined;
  });

  let nextId = 1;
  const session = {
    send(message) {
      if (failure) throw failure;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitFor(predicate, timeoutMs, stage) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolvePromise, reject) => {
        const waiter = { predicate, resolve: resolvePromise, reject };
        waiters.push(waiter);
        setTimeout(() => {
          if (!waiters.includes(waiter)) return;
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(probeFailure('timeout', stage));
        }, timeoutMs).unref?.();
      });
    },
    // The result is handed straight to this caller and never retained; callers
    // digest or project what they need and discard the rest.
    request(method, params, stage, timeoutMs = RAW_REQUEST_TIMEOUT_MS) {
      if (failure) return Promise.reject(failure);
      const id = nextId;
      nextId += 1;
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject, stage });
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(probeFailure('timeout', stage));
        }, timeoutMs);
        timer.unref?.();
        try {
          session.send({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    async initialize() {
      await session.request('initialize', {
        clientInfo: { name: 'u23-hook-probe', version: '0' },
        capabilities: { experimentalApi: true },
      }, 'raw-initialize');
      session.send({ method: 'initialized', params: {} });
    },
    hookSummaries,
    notificationMethods,
    retainedSnapshot: () => ({
      hookSummaries: [...hookSummaries],
      notificationMethods: [...notificationMethods],
      pendingRequests: pending.size,
      messageCount,
    }),
  };

  let bodyValue;
  let bodyError = null;
  try {
    bodyValue = await body(session);
  } catch (error) {
    bodyError = error;
  }
  await terminateRawChild(child, inspectGroup);
  // Bytes can still arrive while the child is being torn down, and an inherited
  // descriptor can outlive the child itself. Awaiting a real stdout EOF — not a
  // fixed number of ticks — is what makes the terminal failure check sound.
  await Promise.race([stdoutDrain, wait(STDOUT_DRAIN_TIMEOUT_MS)]);
  if (bodyError) throw bodyError;
  // A drain that cannot be proved leaves the failure state unknown, so it fails
  // closed rather than reporting success.
  if (!stdoutDrained) throw probeFailure('cleanup', 'raw-stdout-drain-unproved');
  if (failure) throw failure;
  return bodyValue;
}

// Enumerates the owned process group the same way the U1b effect proxy does,
// so emptiness is proved rather than inferred from leader exit alone.
// The live gate enumerates the real process table. A lister that cannot run is
// a cleanup failure, never an assumed-empty group.
export function createGroupInspector(processLister = '/bin/ps') {
  return (pgid) => {
    const result = spawnSync(processLister, ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      throw probeFailure('cleanup', 'raw-group-inspect');
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, group]) => Number.isSafeInteger(pid) && group === pgid)
      .map(([pid]) => pid);
  };
}

const inspectOwnedGroup = createGroupInspector();

async function terminateRawChild(child, inspectGroup = inspectOwnedGroup) {
  const pgid = child.pid;
  const ownGroup = process.platform !== 'win32' && typeof pgid === 'number';
  const signalTree = (signal) => {
    try {
      if (ownGroup) process.kill(-pgid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      try { child.kill(signal); } catch {}
    }
  };
  // Observation is registered before signalling so a fast exit cannot be
  // missed, and the group id is captured before the leader is reaped so a
  // recycled pid cannot be signalled later.
  const exited = new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) resolvePromise(true);
    else child.once('exit', () => resolvePromise(true));
  });
  try { child.stdin.end(); } catch {}
  signalTree('SIGTERM');
  const leaderExited = await Promise.race([
    exited,
    wait(CHILD_EXIT_GRACE_MS).then(() => false),
  ]);
  if (!leaderExited) {
    signalTree('SIGKILL');
    const killed = await Promise.race([exited, wait(CHILD_EXIT_GRACE_MS).then(() => false)]);
    if (!killed) throw probeFailure('cleanup', 'raw-exit-unproved');
  }
  if (!ownGroup) return;
  // Leader exit is not enough: the whole owned group must be gone.
  const deadline = Date.now() + CHILD_EXIT_GRACE_MS * 4;
  let members = inspectGroup(pgid);
  let escalated = false;
  while (members.length > 0 && Date.now() < deadline) {
    if (!escalated) {
      escalated = true;
      signalTree('SIGKILL');
    }
    await wait(20);
    members = inspectGroup(pgid);
  }
  if (members.length > 0) throw probeFailure('cleanup', 'raw-group-not-empty');
}

const HOOK_TRUST_STATUSES = Object.freeze(['managed', 'untrusted', 'trusted', 'modified']);
const MAX_HOOK_KEY_BYTES = 1024;

// Pinned `HookMetadata` carries `command`, `sourcePath` and may carry prompt
// text. Discovery keeps only what the trust lifecycle and trusted-state
// rendering need, so nothing else is retained for the run.
export function projectHookMetadata(entry) {
  if (!entry || typeof entry !== 'object') throw probeFailure('framing', 'hook-metadata');
  const { key, currentHash, trustStatus, enabled } = entry;
  if (
    typeof key !== 'string'
    || key.length === 0
    || Buffer.byteLength(key) > MAX_HOOK_KEY_BYTES
  ) {
    throw probeFailure('framing', 'hook-metadata-key');
  }
  if (typeof currentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(currentHash)) {
    throw probeFailure('framing', 'hook-metadata-hash');
  }
  return {
    key,
    currentHash,
    trustStatus: closedEnum(trustStatus, HOOK_TRUST_STATUSES, 'hook-metadata-trust'),
    enabled: pickBoolean(enabled, 'hook-metadata-enabled'),
  };
}

export async function listHooks(laneSpec, binary) {
  return withRawSession({ binary, ...laneSpec }, async (session) => {
    await session.initialize();
    const result = await session.request('hooks/list', {}, 'raw-hooks-list');
    // Projected immediately: the full response is discarded with this frame.
    return (result?.data ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .map(projectHookMetadata);
  });
}

export async function runProductionLaneWithClient({
  createClient,
  lane,
  binary,
  model,
  completionTimeoutMs = TURN_COMPLETION_TIMEOUT_MS,
}) {
  const delivered = [];
  let completion;
  let observedFaultCategory = null;
  const completed = new Promise((resolvePromise) => { completion = resolvePromise; });
  const client = createClient({
    binary,
    cwd: lane.workspace,
    codexHome: lane.codexHome,
    env: lane.env,
    expectedConfigSha256: lane.configSha256,
    requestTimeoutMs: 30_000,
    // The client's own fault is the precise signal; without it a boundary
    // rejection would be reported only as the downstream completion timeout.
    onFault: async (error) => { observedFaultCategory ??= categorizeFailure(error); },
    onNotification: async (notification) => {
      delivered.push(notification);
      if (notification.method === 'turn/completed') completion(notification);
    },
  });
  const outcome = {
    source: 'production-client',
    turnStatus: null,
    assistantItemObserved: false,
    faultCategory: null,
    turnStartResponseMatchesStarted: false,
    completedTurnMatchesStarted: false,
    deliveredHookMethods: [],
  };
  // State-changing requests must carry the production delivery ledger; the
  // client rejects them otherwise, so the probe honours the same contract.
  const ledger = { onWriteAttempted: () => {}, onResponseObserved: () => {} };
  try {
    await client.start();
    const thread = await client.request('thread/start', {
      cwd: lane.workspace,
      model,
    }, ledger);
    const started = await client.request('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'probe' }],
    }, ledger);
    const completedNotification = await Promise.race([
      completed,
      wait(completionTimeoutMs).then(() => {
        throw probeFailure('timeout', 'authoritative-turn');
      }),
    ]);
    const startedIds = delivered
      .filter((n) => n.method === 'turn/started')
      .map((n) => n.params?.turn?.id);
    outcome.turnStatus = completedNotification.params?.turn?.status ?? null;
    outcome.turnStartResponseMatchesStarted =
      Boolean(started?.turn?.id)
      && startedIds.length === 1
      && startedIds[0] === started.turn.id;
    outcome.completedTurnMatchesStarted =
      completedNotification.params?.turn?.id === started?.turn?.id;
    outcome.assistantItemObserved = delivered.some((n) => (
      n.method === 'item/completed' && n.params?.item?.type === 'agentMessage'
    ));
    outcome.authoritativeTurnId = started?.turn?.id ?? null;
  } catch (error) {
    outcome.faultCategory = observedFaultCategory ?? categorizeFailure(error);
  } finally {
    outcome.deliveredHookMethods = [...new Set(delivered
      .map((n) => n.method)
      .filter((method) => method.startsWith('hook/')))];
    try {
      await client.close();
    } catch (error) {
      // Unverified cleanup outranks any downstream symptom: it must surface
      // rather than be swallowed or masked by an earlier timeout.
      observedFaultCategory = categorizeFailure(error);
    }
    // Read the settled fault after close: the client delivers its fault
    // checkpoint during close, so sampling earlier would lose it.
    outcome.faultCategory = observedFaultCategory ?? outcome.faultCategory ?? null;
  }
  return outcome;
}

function runProductionLane({ binary, lane, model }) {
  return runProductionLaneWithClient({
    createClient: (options) => new CodexAppServerClient(options),
    binary,
    lane,
    model,
  });
}

// Secondary only: reads the hook payloads the production client drops.
async function characterizeDroppedHookPayloads({ binary, lane, model }) {
  return withRawSession({ binary, ...lane }, async (session) => {
    await session.initialize();
    const thread = await session.request(
      'thread/start',
      { cwd: lane.workspace, model },
      'raw-thread-start',
    );
    const threadId = thread?.thread?.id;
    if (!threadId) throw probeFailure('protocol', 'raw-thread-id');
    const turn = await session.request(
      'turn/start',
      { threadId, input: [{ type: 'text', text: 'probe' }] },
      'raw-turn-start',
    );
    const rawTurnIdSha256 = turn?.turn?.id == null
      ? null
      : createHash('sha256').update(String(turn.turn.id)).digest('hex');
    await session.waitFor(
      (record) => record.kind === 'notification' && record.method === 'turn/completed',
      TURN_COMPLETION_TIMEOUT_MS,
      'raw-turn-completed',
    );
    const byEvent = new Map();
    for (const summary of session.hookSummaries) {
      const eventName = closedEnum(summary.eventName, EXPECTED_HOOK_EVENTS, 'raw-hook-event');
      const entry = byEvent.get(eventName) ?? {
        eventName,
        methods: [],
        statuses: [],
        turnIdMatches: true,
        startedAtIsSeconds: true,
        completedAtIsSeconds: true,
      };
      entry.methods.push(summary.method);
      entry.statuses.push(closedEnum(summary.status, HOOK_RUN_STATUSES, 'raw-hook-status'));
      if (summary.turnIdSha256 !== rawTurnIdSha256) entry.turnIdMatches = false;
      if (summary.method === 'hook/started') {
        entry.startedAtIsSeconds = summary.startedAtIsSeconds;
      } else {
        entry.completedAtIsSeconds = summary.completedAtIsSeconds === true;
      }
      byEvent.set(eventName, entry);
    }
    return [...byEvent.values()].map((entry) => ({
      eventName: entry.eventName,
      notificationCount: entry.methods.length,
      orderedStartThenComplete:
        entry.methods[0] === 'hook/started' && entry.methods[1] === 'hook/completed',
      startedStatus: entry.statuses[0] ?? null,
      completedStatus: entry.statuses[1] ?? null,
      startedAtIsSeconds: entry.startedAtIsSeconds,
      completedAtIsSeconds: entry.completedAtIsSeconds,
      notificationTurnIdMatchesRawTurn: entry.turnIdMatches,
    }));
  });
}

// The on-disk capture is already a closed projection; this only validates it.
export function readStdinCaptureRecords(captureDir) {
  const records = [];
  for (const file of existsSync(captureDir) ? readdirSync(captureDir) : []) {
    const match = CAPTURE_FILE_PATTERN.exec(file);
    if (!match) throw probeFailure('framing', 'stdin-capture-filename');
    let payload;
    try {
      payload = JSON.parse(readFileSync(path.join(captureDir, file), 'utf8'));
    } catch {
      throw probeFailure('framing', 'stdin-capture-json');
    }
    const keys = Object.keys(payload).sort().join(',');
    if (keys !== 'eventName,turnIdPresent,turnIdSha256') {
      throw probeFailure('framing', 'stdin-capture-keys');
    }
    const turnIdSha256 = payload.turnIdSha256 == null ? null : String(payload.turnIdSha256);
    if (turnIdSha256 !== null && !/^[a-f0-9]{64}$/.test(turnIdSha256)) {
      throw probeFailure('framing', 'stdin-capture-digest');
    }
    records.push({
      eventName: closedEnum(payload.eventName, EXPECTED_HOOK_EVENTS, 'stdin-capture-event'),
      turnIdPresent: pickBoolean(payload.turnIdPresent, 'stdin-capture-presence'),
      turnIdSha256,
    });
    if (match[1] !== payload.eventName) throw probeFailure('framing', 'stdin-capture-name');
  }
  return records;
}

// Shared bootstrap: provision, discover untrusted, render trusted, re-provision.
async function bootstrapTrustedLane({ laneRoot, providerPort, binary }) {
  const untrustedLane = provisionLane({ laneRoot, providerPort, withHooks: true });
  const discovered = await listHooks(untrustedLane, binary);
  const lane = provisionLane({
    laneRoot,
    providerPort,
    withHooks: true,
    trustState: renderTrustedHookState(discovered),
  });
  const trusted = await listHooks(lane, binary);
  return { lane, discovered, trusted };
}

export async function characterizeHookNotifications(options) {
  const attestBinary = options.attestBinary
    ?? ((binary) => attestPinnedCodexBinary(binary, resolveCodexTargetPin()));
  const startProvider = options.startProvider ?? startLoopbackProvider;
  const targetReceipt = options.attestBinary ? null : resolveCodexTargetPin();
  const runLanes = options.runLanes ?? runProbeLanes;
  // Nested bounded guards: probe-root creation and provider acquisition both
  // sit inside cleanup scope, and a provider close failure or hang can never
  // prevent scratch removal.
  let probeRoot = null;
  let providerCleanupFailed = false;
  try {
    const attestation = await attestBinary(options.binary);
    const binary = attestation.path;
    probeRoot = path.join(realpathSync(options.probeRoot), `u23-hook-probe-${randomUUID()}`);
    mkdirSync(probeRoot, { recursive: true, mode: 0o700 });
    chmodSync(probeRoot, 0o700);
    let provider = null;
    let envelope;
    try {
      provider = await startProvider();
      envelope = await runLanes({ binary, attestation, targetReceipt, probeRoot, provider });
    } finally {
      if (provider) {
        providerCleanupFailed = await Promise.race([
          provider.close().then(() => false, () => true),
          wait(PROVIDER_CLOSE_TIMEOUT_MS).then(() => true),
        ]);
      }
    }
    // A lane result cannot stand if the provider could not be shut down.
    if (providerCleanupFailed) return stopEnvelope(probeFailure('cleanup', 'provider-close'));
    return envelope;
  } catch (error) {
    return stopEnvelope(error);
  } finally {
    if (probeRoot) rmSync(probeRoot, { recursive: true, force: true });
  }
}

async function runProbeLanes({ binary, attestation, targetReceipt, probeRoot, provider }) {
  const evidence = {
    pinnedBinaryAttested: targetReceipt === null
      ? true
      : attestation.sha256 === targetReceipt.binarySha256
        && attestation.version === targetReceipt.cliVersion,
  };

  const hooksOnRoot = path.join(probeRoot, 'hooks-on');
  const bootstrapped = await bootstrapTrustedLane({
    laneRoot: hooksOnRoot, providerPort: provider.port, binary,
  });
  let lane = bootstrapped.lane;
  const { discovered, trusted } = bootstrapped;
  const lifecycle = {
    discoveredUntrusted: discovered.length === EXPECTED_HOOK_EVENTS.length
      && discovered.every((hook) => hook.trustStatus === 'untrusted'),
    renderedTrusted: trusted.length === EXPECTED_HOOK_EVENTS.length
      && trusted.every((hook) => hook.trustStatus === 'trusted' && hook.enabled === true),
  };
  const trustedDigest = configDigest(lane.configPath);

  // Mutate only the hook handler; config.toml keeps the stale trusted hash.
  const hooksPath = path.join(lane.codexHome, 'hooks.json');
  writeFileSync(
    hooksPath,
    readFileSync(hooksPath, 'utf8').replace(/(probe-hook\.sh' \w+)/g, '$1 --drift'),
    { mode: 0o600 },
  );
  const drifted = await listHooks(lane, binary);
  lifecycle.mutatedHashChanged = drifted.length === discovered.length
    && drifted.every((hook, index) => hook.currentHash !== trusted[index]?.currentHash);
  lifecycle.mutatedStatusModified = drifted.every((hook) => hook.trustStatus === 'modified');
  lifecycle.configDigestUnchangedOnMutation = configDigest(lane.configPath) === trustedDigest;

  // Re-render the new trusted hash: now the owned-config digest must move.
  lane = provisionLane({
    laneRoot: hooksOnRoot,
    providerPort: provider.port,
    withHooks: true,
    trustState: renderTrustedHookState(drifted),
    hookArgument: ' --drift',
  });
  lifecycle.reRenderedDigestChanged = lane.configSha256 !== trustedDigest;
  const reTrusted = await listHooks(lane, binary);
  lifecycle.reRenderedTrusted = reTrusted.length === EXPECTED_HOOK_EVENTS.length
    && reTrusted.every((hook) => hook.trustStatus === 'trusted' && hook.enabled === true);
  evidence.trustLifecycle = lifecycle;
  evidence.isolatedCodexHomeMode0700 = (lstatSync(lane.codexHome).mode & 0o777) === 0o700;
  evidence.credentialFree = {
    authFileAbsent: !existsSync(path.join(lane.codexHome, 'auth.json')),
    providerRequiresAuth: readProviderRequiresAuth(readFileSync(lane.configPath, 'utf8')),
  };

  const authoritative = await runProductionLane({ binary, lane, model: MOCK_MODEL });
  evidence.authoritative = authoritative;
  evidence.hookStdin = summarizeStdinCaptures(
    readStdinCaptureRecords(lane.captureDir),
    authoritative.authoritativeTurnId == null
      ? null
      : createHash('sha256').update(String(authoritative.authoritativeTurnId)).digest('hex'),
  );

  // Secondary characterization of the dropped payloads, in its own lane.
  const rawBootstrapped = await bootstrapTrustedLane({
    laneRoot: path.join(probeRoot, 'raw-capture'), providerPort: provider.port, binary,
  });
  const hookPairs = await characterizeDroppedHookPayloads({
    binary, lane: rawBootstrapped.lane, model: MOCK_MODEL,
  });
  evidence.hookPairs = hookPairs;
  evidence.hookEvents = hookPairs.map((pair) => pair.eventName);

  // Hooks-off control on the same production boundary.
  const controlLane = provisionLane({
    laneRoot: path.join(probeRoot, 'hooks-off'),
    providerPort: provider.port,
    withHooks: false,
  });
  const control = await runProductionLane({ binary, lane: controlLane, model: MOCK_MODEL });
  evidence.control = control;
  evidence.ownedConfigDigestStable =
    configDigest(lane.configPath) === lane.configSha256
    && configDigest(controlLane.configPath) === controlLane.configSha256;

  return buildResultEnvelope(evidence);
}

export function parseHookProbeArgs(argv) {
  const options = {
    binary: process.env.POLYGRAM_CODEX_BIN ?? '',
    probeRoot: process.env.ORCHESTRA_CODEX_HOOK_PROBE_ROOT ?? '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = argv[++index] ?? '';
    else if (arg === '--probe-root') options.probeRoot = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['binary', 'probeRoot']) {
    if (!options[key]) throw new Error(`missing required hook probe option: ${key}`);
  }
  return options;
}

async function main() {
  let result;
  try {
    result = await characterizeHookNotifications(parseHookProbeArgs(process.argv.slice(2)));
  } catch (error) {
    process.stdout.write(`${JSON.stringify(stopEnvelope(error), null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // A STOP result is a deliberate nonzero exit, not a crash.
  process.exitCode = result.gate === 'CONTINUE' ? 0 : 1;
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)
) {
  await main();
}
