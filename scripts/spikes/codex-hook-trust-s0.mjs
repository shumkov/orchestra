// Credential-free characterization of Codex hook trust for the pinned
// app-server.
//
// This is the measurement half of the hook work. The checked-in release gate
// `codex-app-server-hook-probe.mjs` proves that a hook-enabled turn survives
// the production notification boundary; this script answers the questions a
// production hook-trust design has to settle before it can be written:
//
//   - the shape of the user-layer config object once trust state is present,
//     and whether it is exactly the parse of what was written;
//   - which wire params the hook list method accepts, and how the response is
//     scoped to the requested working directories;
//   - whether the hooks feature flag is required for discovery or execution;
//   - the exact config key each event derives;
//   - whether a hook's content hash is re-validated when the hook fires or
//     only when it is listed;
//   - where each hook fires relative to the turn start response, the turn
//     started notification, and turn completion;
//   - which optional hook metadata fields appear at all;
//   - the system runtime and shipped artifact receipts the hook command names,
//     and whether the rendered command is byte stable;
//   - whether the trust stanza and the hook manifest survive a turn unchanged.
//
// Every hardened primitive — bounded raw framing, owned process group
// teardown, the loopback provider, the closed-enum discipline — is imported
// from the release gate rather than reimplemented. The release gate's own
// event set, evidence shape and CONTINUE/STOP contract are left untouched:
// this script characterizes three events where the gate characterizes two, and
// a shared mutable event set would silently redefine the gate.
//
// Output discipline is the gate's: booleans, closed enums, counts and digests
// only. No host path, hook command, config key, hook payload, peer message or
// status text is emitted, retained past the frame that projects it, or written
// to disk.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CodexAppServerClient,
  attestPinnedCodexBinary,
  resolveCodexTargetPin,
} from '../../lib/codex/app-server-client.js';
import {
  FAILURE_CATEGORIES,
  categorizeFailure,
  createGroupInspector,
  envelopeIsContentFree,
  shellQuote,
  startLoopbackProvider,
  withRawSession,
} from './codex-app-server-hook-probe.mjs';
import { RECORDER_FILE_PATTERN, RECORDER_RECORD_KEYS } from './u23-hook-recorder.mjs';

// Re-exported so the containment assertion is applied to this module's
// envelopes through the same implementation the release gate uses.
export { envelopeIsContentFree };

// `--runtime` exists because the runtime is an attested artifact: it must be a
// canonical, owner-or-root, non-group-writable file under an equally tight
// parent chain. A package-manager-installed Node often sits under a
// group-writable prefix and is correctly rejected, so the invoking Node is only
// the default, never a requirement.
export const USAGE = [
  'node scripts/spikes/codex-hook-trust-s0.mjs \\',
  '  --binary /absolute/versioned/path/to/codex \\',
  '  --probe-root /absolute/non-temporary/probe-root \\',
  '  [--runtime /absolute/path/to/node]   # defaults to the invoking runtime',
].join('\n');

const MOCK_MODEL = 'mock-model';
const PROVIDER_ID = 'u23_loopback';
const PERMISSION_PROFILE = 'polygram-session';

// Exactly the manifest the amendment plan's section 8 declares: three events,
// one hook each. `SessionStart` is the required negative — a capture that
// exists without a turn id.
export const S0_EVENTS = Object.freeze(['sessionStart', 'userPromptSubmit', 'stop']);
export const S0_CONFIG_KEYS = Object.freeze({
  sessionStart: 'SessionStart',
  userPromptSubmit: 'UserPromptSubmit',
  stop: 'Stop',
});
// The `key` derivation candidate under test. Inferred from two observed
// samples in the plan; this run either confirms it per event or reports the
// mismatch.
export const S0_EVENT_SNAKE = Object.freeze({
  sessionStart: 'session_start',
  userPromptSubmit: 'user_prompt_submit',
  stop: 'stop',
});

// Generated-schema facts, read from the pinned binary's own
// `generate-json-schema --experimental` bundle. They are the closed enums this
// run validates observed values against; a value outside them is a framing
// failure, never an emitted string.
export const HOOK_TRUST_STATUSES = Object.freeze([
  'managed', 'untrusted', 'trusted', 'modified',
]);
export const HOOK_HANDLER_TYPES = Object.freeze(['command', 'prompt', 'agent']);
export const HOOK_SOURCES = Object.freeze([
  'system', 'user', 'project', 'mdm', 'sessionFlags', 'plugin',
  'cloudRequirements', 'cloudManagedConfig', 'legacyManagedConfigFile',
  'legacyManagedConfigMdm', 'unknown',
]);
export const HOOK_EVENT_NAMES = Object.freeze([
  'preToolUse', 'permissionRequest', 'postToolUse', 'preCompact', 'postCompact',
  'sessionStart', 'sessionEnd', 'userPromptSubmit', 'subagentStart',
  'subagentStop', 'stop',
]);
export const HOOK_METADATA_REQUIRED_FIELDS = Object.freeze([
  'currentHash', 'displayOrder', 'enabled', 'eventName', 'handlerType',
  'isManaged', 'key', 'source', 'sourcePath', 'timeoutSec', 'trustStatus',
]);
// `command` is optional and nullable in the pinned type. An earlier draft of
// the consuming plan listed it as always present; it is not.
export const HOOK_METADATA_OPTIONAL_FIELDS = Object.freeze([
  'additionalContextLimit', 'command', 'matcher', 'pluginId', 'statusMessage',
]);
export const CONFIG_LAYER_TYPES = Object.freeze([
  'mdm', 'system', 'enterpriseManaged', 'user', 'project', 'sessionFlags',
  'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm',
]);

export const PARAM_FORMS = Object.freeze([
  'omitted', 'empty', 'emptyCwds', 'ownedCwd', 'foreignCwd', 'bothCwds',
]);
export const HOOKS_LIST_RESPONSE_KEYS = Object.freeze(['data']);

// The release gate's reader matches a bare TOML key. This rendering quotes
// every key, so the credential-free assertion needs a reader that accepts
// both rather than silently reporting "unknown".
export function readRequiresOpenAiAuth(configText) {
  const match = /^\s*"?requires_openai_auth"?\s*=\s*(true|false)\s*$/m
    .exec(String(configText));
  return match ? match[1] === 'true' : null;
}
export const PARAM_VERDICTS = Object.freeze(['accepted', 'rejected', 'failed']);
export const RPC_ERROR_CLASSES = Object.freeze([
  'none', 'method-not-found', 'invalid-params', 'invalid-request',
  'internal-error', 'other',
]);
export const FIRE_TIME_CONTENT_SOURCES = Object.freeze([
  'on-disk-at-fire-time', 'thread-start-snapshot', 'refused',
]);
export const ORDER_VERDICTS = Object.freeze([
  'before', 'after', 'ambiguous', 'unobserved',
]);
// Durations are bucketed rather than emitted: the margin between the turn
// start response and the first hook is the budget a durable checkpoint sink
// has before a hook can overtake it, and that is a decision input.
export const MARGIN_BUCKETS = Object.freeze([
  'negative', 'under-1ms', '1-10ms', '10-100ms', '100ms-1s', 'over-1s', 'unobserved',
]);

export function bucketMargin(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'unobserved';
  const delta = to - from;
  if (delta < 0) return 'negative';
  if (delta < 1) return 'under-1ms';
  if (delta < 10) return '1-10ms';
  if (delta < 100) return '10-100ms';
  if (delta < 1000) return '100ms-1s';
  return 'over-1s';
}
export const TURN_STATUSES = Object.freeze([
  'completed', 'interrupted', 'failed', 'inProgress',
]);
// 'none' is a value, not an absence: a null fault slot would make an
// off-enum category indistinguishable from a clean turn.
export const FAULT_CATEGORIES = Object.freeze(['none', ...FAILURE_CATEGORIES]);
// `postStart` swaps after `initialize` and before the `thread/start` request;
// `postThread` swaps after the `thread/start` response. So the middle outcome
// brackets the fixing point *inside* thread/start, and the labels say exactly
// that rather than something wider.
export const SNAPSHOT_BOUNDARIES = Object.freeze([
  'at-or-before-process-spawn',
  'during-thread-start',
  'after-thread-start-response',
]);
export const ARTIFACT_KINDS = Object.freeze(['system-runtime', 'shipped-artifact']);
export const CODEX_TARGETS = Object.freeze([
  'aarch64-apple-darwin', 'x86_64-unknown-linux-musl',
]);

// Top-level config table names this run writes. Anything else appearing in the
// user layer is counted, never named.
export const S0_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'model', 'model_provider', 'default_permissions', 'approval_policy',
  'approvals_reviewer', 'web_search', 'allow_login_shell',
  'shell_environment_policy', 'permissions', 'projects', 'model_providers',
  'features', 'hooks',
]);
export const HOOKS_TABLE_KEYS = Object.freeze([
  'state', ...Object.values(S0_EVENT_SNAKE),
  'session_end', 'pre_tool_use', 'post_tool_use', 'permission_request',
  'pre_compact', 'post_compact', 'subagent_start', 'subagent_stop',
]);
export const HOOK_STATE_ENTRY_KEYS = Object.freeze(['enabled', 'trusted_hash']);

const TURN_COMPLETION_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_CLOSE_TIMEOUT_MS = 2_000;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_CAPTURE_FILES = 64;
const MAX_CAPTURE_FILE_BYTES = 4096;
const MAX_CAPTURE_TOTAL_BYTES = 64 * 1024;
const CHILD_RETIRE_TIMEOUT_MS = 4000;

const RECORDER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'u23-hook-recorder.mjs',
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A rejecting deadline that can be disarmed. `wait().then(throw)` cannot be,
// and a live timer is enough to hold the process open.
function boundedDeadline(ms, stage) {
  let timer = null;
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(s0Failure('timeout', stage)), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => { if (timer !== null) clearTimeout(timer); } };
}

export function s0Failure(category, stage) {
  const error = new Error(`hook trust characterization ${category} failure`);
  error.probeCategory = FAILURE_CATEGORIES.includes(category) ? category : 'unknown';
  error.probeStage = stage;
  return error;
}

function closedEnum(value, allowed, stage) {
  if (!allowed.includes(value)) throw s0Failure('framing', stage);
  return value;
}

// ---------------------------------------------------------------------------
// Typed command descriptors. A hook command is rendered from a descriptor and
// never parsed from arbitrary shell text; the descriptor is the attestation
// subject and the command string is its output.
// ---------------------------------------------------------------------------

export function assertLiteralArgument(value, stage) {
  if (typeof value !== 'string' || value.length === 0) {
    throw s0Failure('bounds', stage);
  }
  if (Buffer.byteLength(value) > MAX_ARGUMENT_BYTES) throw s0Failure('bounds', stage);
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) throw s0Failure('bounds', stage);
  }
  // Rejected even though the renderer single-quotes every token: the
  // descriptor is the attestation subject, and a token that would need
  // quoting to be safe is a token nobody should be declaring.
  if (/[$`\\!*?~<>^()[\]{};&|"']/.test(value)) throw s0Failure('bounds', stage);
  return value;
}

export function assertAttestedPath(value, attestedPaths, stage) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw s0Failure('attestation', stage);
  }
  if (!attestedPaths.has(value)) throw s0Failure('attestation', stage);
  return value;
}

// A deterministic function of {runtime.path, artifacts[].path, argv}. A
// descriptor naming an unattested path cannot be rendered at all, so the
// rejection happens before any command string exists.
export function renderHookCommand(descriptor, attestedPaths) {
  const runtime = descriptor?.runtime ?? {};
  closedEnum(runtime.kind, ARTIFACT_KINDS, 'descriptor-runtime-kind');
  assertAttestedPath(runtime.path, attestedPaths, 'descriptor-runtime-path');
  const artifacts = Array.isArray(descriptor?.artifacts) ? descriptor.artifacts : null;
  if (!artifacts || artifacts.length === 0) throw s0Failure('bounds', 'descriptor-artifacts');
  for (const artifact of artifacts) {
    closedEnum(artifact?.kind, ARTIFACT_KINDS, 'descriptor-artifact-kind');
    assertAttestedPath(artifact?.path, attestedPaths, 'descriptor-artifact-path');
  }
  const argv = Array.isArray(descriptor?.argv) ? descriptor.argv : null;
  if (!argv) throw s0Failure('bounds', 'descriptor-argv');
  for (const argument of argv) assertLiteralArgument(argument, 'descriptor-argv-literal');
  return [
    runtime.path,
    ...artifacts.map((artifact) => artifact.path),
    ...argv,
  ].map(shellQuote).join(' ');
}

export function commandDigest(command) {
  return createHash('sha256').update(command).digest('hex');
}

// ---------------------------------------------------------------------------
// Artifact and runtime attestation. The ownership and mode rule differs by
// kind: a shared system runtime is legitimately root-owned 0755 and must not
// be required to be owner-only.
// ---------------------------------------------------------------------------

// A file is only as protected as the directories that lead to it: a
// group- or world-writable ancestor lets someone replace the file wholesale
// without ever touching its own mode or owner.
export function parentChainIsSafe(target) {
  let current;
  try {
    // The canonical chain is the one that actually governs access; walking the
    // literal path would judge a symlinked prefix instead of its target.
    current = path.dirname(realpathSync.native(target));
  } catch {
    return false;
  }
  const self = process.getuid();
  for (let depth = 0; depth < 64; depth += 1) {
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return false;
    if (stats.uid !== 0 && stats.uid !== self) return false;
    // A world- or group-writable directory is only acceptable when it is
    // sticky: sticky is what stops another user renaming or removing an entry
    // they do not own, which is the substitution this walk exists to prevent.
    if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return false;
}

export function attestArtifact(target, kind) {
  closedEnum(kind, ARTIFACT_KINDS, 'attest-kind');
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw s0Failure('attestation', 'attest-path');
  }
  const stats = lstatSync(target, { throwIfNoEntry: false });
  if (!stats) throw s0Failure('attestation', 'attest-missing');
  const mode = stats.mode & 0o777;
  const receipt = {
    kind,
    sha256: stats.isFile()
      ? createHash('sha256').update(readFileSync(target)).digest('hex')
      : null,
    nlink: stats.nlink,
    isRegularFile: stats.isFile(),
    isSymlink: stats.isSymbolicLink(),
    isCanonicalPath: realpathSync.native(target) === target,
    ownerIsSelf: stats.uid === process.getuid(),
    ownerIsRoot: stats.uid === 0,
    groupOrWorldWritable: (mode & 0o022) !== 0,
    ownerExecutable: (mode & 0o100) !== 0,
    ownerOnlyMode: mode === 0o700,
    parentChainSafe: parentChainIsSafe(target),
  };
  const shared = receipt.isRegularFile
    && !receipt.isSymlink
    && receipt.nlink === 1
    && !receipt.groupOrWorldWritable
    && receipt.parentChainSafe
    && receipt.sha256 !== null;
  receipt.satisfiesKindRule = kind === 'system-runtime'
    ? shared && (receipt.ownerIsRoot || receipt.ownerIsSelf)
    : shared && receipt.ownerIsSelf;
  return receipt;
}

// The enforcing form. `attestArtifact` describes; this one refuses. Every
// production call site uses this, so an unsafe receipt can never be carried
// forward as evidence of a successful attestation.
export function attestArtifactStrict(target, kind) {
  const receipt = attestArtifact(target, kind);
  if (!receipt.satisfiesKindRule) throw s0Failure('attestation', 'attest-unsafe');
  return receipt;
}

// The hook's content hash binds the command string, which names the artifact's
// *path* — not the bytes at that path. Replacing the script body between
// attestation and launch leaves the trust stanza valid and changes what runs,
// so every pinned artifact is re-read and re-compared immediately before any
// child is started.
export function verifyPinnedArtifacts(pinned, paths) {
  for (const [name, receipt] of Object.entries(pinned)) {
    const target = paths[name];
    if (typeof target !== 'string') throw s0Failure('attestation', 'reattest-path');
    const current = attestArtifactStrict(target, receipt.kind);
    if (current.sha256 !== receipt.sha256) throw s0Failure('attestation', 'reattest-digest');
    if (current.nlink !== receipt.nlink) throw s0Failure('attestation', 'reattest-nlink');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Canonical JSON digest, mirroring the production client's own digest so a
// layer digest measured here is the digest a consumer would compute.
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function jsonDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

// ---------------------------------------------------------------------------
// The owned config, built once as an object model and rendered to TOML from
// that same model. The object model is the comparison basis for the user
// layer: if the layer digest equals this object's digest, the layer is exactly
// the parse of what was written and a consumer can mirror it.
// ---------------------------------------------------------------------------

export function buildS0Config({
  codexHome, workspace, providerPort, withFeaturesHooks, trustState = null,
}) {
  const config = {
    model: MOCK_MODEL,
    model_provider: PROVIDER_ID,
    default_permissions: PERMISSION_PROFILE,
    approval_policy: 'never',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    shell_environment_policy: { inherit: 'none' },
    permissions: {
      [PERMISSION_PROFILE]: {
        filesystem: {
          ':minimal': 'read',
          [codexHome]: 'deny',
          ':workspace_roots': { '.': 'write' },
        },
        network: { enabled: false },
      },
    },
    projects: { [workspace]: { trust_level: 'untrusted' } },
    model_providers: {
      [PROVIDER_ID]: {
        name: 'U23 loopback Responses',
        base_url: `http://127.0.0.1:${providerPort}/v1`,
        wire_api: 'responses',
        request_max_retries: 0,
        stream_max_retries: 0,
        stream_idle_timeout_ms: 5000,
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
  };
  if (withFeaturesHooks) config.features = { hooks: true };
  if (trustState && Object.keys(trustState).length > 0) {
    config.hooks = {
      state: Object.fromEntries(
        Object.keys(trustState).sort().map((key) => [key, {
          enabled: true,
          trusted_hash: trustState[key],
        }]),
      ),
    };
  }
  return config;
}

const tomlValue = (value) => {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
};

const tomlInline = (value) => `{ ${Object.entries(value)
  .map(([key, entry]) => `${JSON.stringify(key)} = ${tomlValue(entry)}`)
  .join(', ')} }`;

function tomlTable(header, table) {
  const lines = [`[${header}]`];
  for (const [key, value] of Object.entries(table)) {
    lines.push(
      value && typeof value === 'object' && !Array.isArray(value)
        ? `${JSON.stringify(key)} = ${tomlInline(value)}`
        : `${JSON.stringify(key)} = ${tomlValue(value)}`,
    );
  }
  lines.push('');
  return lines;
}

// Renders exactly the object model above; the two are generated from one
// source so a rendering and its object model cannot drift apart.
export function renderS0Config(config) {
  const lines = [];
  for (const key of [
    'model', 'model_provider', 'default_permissions', 'approval_policy',
    'approvals_reviewer', 'web_search', 'allow_login_shell',
  ]) {
    lines.push(`${key} = ${tomlValue(config[key])}`);
  }
  lines.push('');
  lines.push(...tomlTable('shell_environment_policy', config.shell_environment_policy));
  for (const [profile, body] of Object.entries(config.permissions)) {
    lines.push(...tomlTable(`permissions.${JSON.stringify(profile)}.filesystem`, body.filesystem));
    lines.push(...tomlTable(`permissions.${JSON.stringify(profile)}.network`, body.network));
  }
  for (const [project, body] of Object.entries(config.projects)) {
    lines.push(...tomlTable(`projects.${JSON.stringify(project)}`, body));
  }
  for (const [provider, body] of Object.entries(config.model_providers)) {
    lines.push(...tomlTable(`model_providers.${JSON.stringify(provider)}`, body));
  }
  if (config.features) lines.push(...tomlTable('features', config.features));
  for (const [key, entry] of Object.entries(config.hooks?.state ?? {})) {
    lines.push(...tomlTable(`hooks.state.${JSON.stringify(key)}`, entry));
  }
  return `${lines.join('\n')}\n`;
}

export function fileDigest(target) {
  return createHash('sha256').update(readFileSync(target)).digest('hex');
}

// ---------------------------------------------------------------------------
// Hook metadata projection. `key`, `sourcePath`, `command`, `matcher`,
// `pluginId` and `statusMessage` carry absolute host paths, the full hook
// command line and operator-facing prose. They are compared against locally
// held expectations and discarded in the same frame; only verdicts survive.
// ---------------------------------------------------------------------------

// The discovery response is cwd-scoped and exactly shaped, or it is not read.
// Nothing peer-supplied — a cwd, an error message, a warning, an unexpected
// envelope key — survives the rejection.
export function validateHooksListEnvelope(result, ownedCwd) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw s0Failure('framing', 'discovery-envelope');
  }
  const keys = Object.keys(result);
  if (keys.length !== 1 || keys[0] !== 'data') {
    throw s0Failure('framing', 'discovery-envelope-keys');
  }
  const entries = result.data;
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw s0Failure('framing', 'discovery-entry-count');
  }
  const [entry] = entries;
  if (!entry || typeof entry !== 'object') throw s0Failure('framing', 'discovery-entry');
  if (entry.cwd !== ownedCwd) throw s0Failure('framing', 'discovery-entry-cwd');
  if (!Array.isArray(entry.errors) || entry.errors.length !== 0) {
    throw s0Failure('framing', 'discovery-entry-errors');
  }
  if (!Array.isArray(entry.warnings) || entry.warnings.length !== 0) {
    throw s0Failure('framing', 'discovery-entry-warnings');
  }
  if (!Array.isArray(entry.hooks)) throw s0Failure('framing', 'discovery-entry-hooks');
  return entry.hooks;
}

export function deriveHookKey(sourcePath, eventName, index = 0, sub = 0) {
  const snake = S0_EVENT_SNAKE[eventName];
  if (!snake) throw s0Failure('framing', 'derive-key-event');
  return `${sourcePath}:${snake}:${index}:${sub}`;
}

export function classifyHookKey(key, sourcePath, eventName) {
  const snake = S0_EVENT_SNAKE[eventName] ?? null;
  const verdict = {
    matchesTemplate: false,
    snakeTokenMatches: false,
    indexI: null,
    indexJ: null,
  };
  if (typeof key !== 'string' || typeof sourcePath !== 'string' || snake === null) {
    return verdict;
  }
  const prefix = `${sourcePath}:${snake}:`;
  if (!key.startsWith(prefix)) return verdict;
  verdict.snakeTokenMatches = true;
  const tail = key.slice(prefix.length);
  const parsed = /^(\d+):(\d+)$/.exec(tail);
  if (!parsed) return verdict;
  verdict.indexI = Number(parsed[1]);
  verdict.indexJ = Number(parsed[2]);
  verdict.matchesTemplate = key === deriveHookKey(
    sourcePath,
    eventName,
    verdict.indexI,
    verdict.indexJ,
  );
  return verdict;
}

export function projectHookEntry(entry, expectations) {
  if (!entry || typeof entry !== 'object') throw s0Failure('framing', 'hook-entry');
  const eventName = closedEnum(entry.eventName, HOOK_EVENT_NAMES, 'hook-entry-event');
  const missingRequired = HOOK_METADATA_REQUIRED_FIELDS
    .filter((field) => !Object.hasOwn(entry, field) || entry[field] == null);
  const known = new Set([
    ...HOOK_METADATA_REQUIRED_FIELDS,
    ...HOOK_METADATA_OPTIONAL_FIELDS,
  ]);
  const keyVerdict = classifyHookKey(entry.key, entry.sourcePath, eventName);
  const renderedCommand = expectations?.commandByEvent?.[eventName] ?? null;
  return {
    eventName,
    trustStatus: closedEnum(entry.trustStatus, HOOK_TRUST_STATUSES, 'hook-entry-trust'),
    handlerType: closedEnum(entry.handlerType, HOOK_HANDLER_TYPES, 'hook-entry-handler'),
    source: closedEnum(entry.source, HOOK_SOURCES, 'hook-entry-source'),
    enabled: entry.enabled === true,
    isManaged: entry.isManaged === true,
    displayOrder: Number.isSafeInteger(entry.displayOrder) ? entry.displayOrder : null,
    timeoutSec: Number.isSafeInteger(entry.timeoutSec) ? entry.timeoutSec : null,
    requiredFieldsPresent: missingRequired.length === 0,
    currentHashWellFormed: typeof entry.currentHash === 'string'
      && /^sha256:[a-f0-9]{64}$/.test(entry.currentHash),
    keyMatchesTemplate: keyVerdict.matchesTemplate,
    keySnakeTokenMatches: keyVerdict.snakeTokenMatches,
    keyIndexI: keyVerdict.indexI,
    keyIndexJ: keyVerdict.indexJ,
    sourcePathMatchesManifest: typeof entry.sourcePath === 'string'
      && entry.sourcePath === expectations?.sourcePath,
    commandPresent: typeof entry.command === 'string',
    commandMatchesRendered: typeof entry.command === 'string'
      && renderedCommand !== null
      && entry.command === renderedCommand,
    optionalFieldsWithKey: HOOK_METADATA_OPTIONAL_FIELDS
      .filter((field) => Object.hasOwn(entry, field)),
    optionalFieldsNonNull: HOOK_METADATA_OPTIONAL_FIELDS
      .filter((field) => entry[field] != null),
    unknownFieldCount: Object.keys(entry).filter((field) => !known.has(field)).length,
  };
}

// The exact optional-field shape the U23 fixture produces: five optional keys
// present, only `command` carrying a value. A populated `matcher`,
// `pluginId`, `statusMessage` or `additionalContextLimit` is a different hook
// from the one that was attested.
export const EXPECTED_APP_SERVER_LAUNCHES = 19;
export const FIXTURE_TIMEOUT_SEC = 600;

const FIXTURE_OPTIONAL_WITH_KEY = Object.freeze([...HOOK_METADATA_OPTIONAL_FIELDS]);
const FIXTURE_OPTIONAL_NON_NULL = Object.freeze(['command']);

const sameNameSet = (observed, expected) => Array.isArray(observed)
  && observed.length === expected.length
  && [...observed].sort().join(',') === [...expected].sort().join(',');

// Everything about a fixture hook that must hold whatever its trust state is,
// and whatever happened to its command. `enabled`, ordering, timeout and the
// optional shape all decide whether the hook will actually run, so they are
// invariants rather than incidental detail — and they are defined once, here,
// so the trust whitelist and the modified control cannot drift apart.
function entryMatchesFixtureInvariants(projected, expectedOrder) {
  return projected.requiredFieldsPresent === true
    && projected.currentHashWellFormed === true
    && projected.keyMatchesTemplate === true
    && projected.keyIndexI === 0
    && projected.keyIndexJ === 0
    && projected.sourcePathMatchesManifest === true
    && projected.handlerType === 'command'
    && projected.source === 'user'
    && projected.isManaged === false
    && projected.enabled === true
    && projected.displayOrder === expectedOrder
    && projected.timeoutSec === FIXTURE_TIMEOUT_SEC
    && projected.commandPresent === true
    && projected.unknownFieldCount === 0
    && sameNameSet(projected.optionalFieldsWithKey, FIXTURE_OPTIONAL_WITH_KEY)
    && sameNameSet(projected.optionalFieldsNonNull, FIXTURE_OPTIONAL_NON_NULL);
}

// One projected entry is only safe to harvest a key and hash from if every
// invariant held, its trust state is the expected one, and its command is
// still the command that was attested. A hook that will not run is not a hook
// whose hash should be rendered into a trust stanza.
function entryIsWhitelistable(projected, expectations, expectedOrder) {
  return entryMatchesFixtureInvariants(projected, expectedOrder)
    && projected.trustStatus === expectations?.trustStatus
    && projected.commandMatchesRendered === true;
}

// The trust half never enters the envelope; it exists only so the next
// rendering can carry the hash the app-server reported.
//
// It is produced **only** when the inventory is an exact one-to-one match for
// the expected manifest. Harvesting a key and hash per-entry — the earlier
// shape — would let a foreign, duplicated, or tampered entry contribute a
// trust stanza as long as it happened to carry two well-typed strings, which
// is precisely the hook nobody intended to trust.
export function splitHookInventory(rawEntries, expectations) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const expectedEvents = expectations?.events ?? S0_EVENTS;
  const projected = entries.map((entry) => projectHookEntry(entry, expectations));
  const byEvent = new Map();
  // An expected trust status is mandatory: without one, a hook listed as
  // `modified` would whitelist just as readily as a `trusted` one.
  let trustable = entries.length === expectedEvents.length
    && HOOK_TRUST_STATUSES.includes(expectations?.trustStatus);
  for (let index = 0; index < projected.length; index += 1) {
    const entry = projected[index];
    if (!expectedEvents.includes(entry.eventName)) trustable = false;
    else if (byEvent.has(entry.eventName)) trustable = false;
    else byEvent.set(entry.eventName, entries[index]);
    if (!entryIsWhitelistable(entry, expectations, expectedEvents.indexOf(entry.eventName))) {
      trustable = false;
    }
  }
  if (expectedEvents.some((eventName) => !byEvent.has(eventName))) trustable = false;
  const keys = new Set(entries.map((entry) => entry?.key));
  if (keys.size !== entries.length) trustable = false;
  return {
    projected,
    trustable,
    trust: trustable
      ? expectedEvents.map((eventName) => ({
          key: byEvent.get(eventName).key,
          currentHash: byEvent.get(eventName).currentHash,
        }))
      : [],
  };
}

// Exactness without trustability. The fresh-session control lists a manifest
// that was deliberately mutated, so its commands no longer match the rendering
// and it is correctly untrustable. That is the *only* licensed difference:
// every other fixture invariant still has to hold, and the command mismatch is
// required rather than tolerated, because a control whose command still
// matches proves the mutation never landed.
export function inventoryIsExactSet(projected, trustStatus, { expectCommandMatch = true } = {}) {
  const entries = Array.isArray(projected) ? projected : [];
  if (entries.length !== S0_EVENTS.length) return false;
  if (!S0_EVENTS.every((eventName) => (
    entries.filter((entry) => entry.eventName === eventName).length === 1
  ))) return false;
  if (!HOOK_TRUST_STATUSES.includes(trustStatus)) return false;
  return entries.every((entry) => (
    entryMatchesFixtureInvariants(entry, S0_EVENTS.indexOf(entry.eventName))
    && entry.trustStatus === trustStatus
    && entry.commandMatchesRendered === expectCommandMatch
  ));
}

// The only path from a discovered inventory to a rendered trust stanza.
export function trustStateFromInventory(inventory) {
  if (inventory?.trustable !== true) throw s0Failure('attestation', 'trust-not-whitelisted');
  if (!Array.isArray(inventory.trust) || inventory.trust.length === 0) {
    throw s0Failure('attestation', 'trust-empty');
  }
  return Object.fromEntries(inventory.trust.map((entry) => [entry.key, entry.currentHash]));
}

export function classifyRpcErrorCode(code) {
  if (code == null) return 'none';
  if (code === -32601) return 'method-not-found';
  if (code === -32602) return 'invalid-params';
  if (code === -32600) return 'invalid-request';
  if (code === -32603) return 'internal-error';
  return 'other';
}

// ---------------------------------------------------------------------------
// Ordering. Every emitted ordering fact is a closed verdict derived from two
// wall-clock readings; the readings themselves are never emitted.
// ---------------------------------------------------------------------------

export function compareObservations(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 'unobserved';
  if (left < right) return 'before';
  if (left > right) return 'after';
  return 'ambiguous';
}

// Ordering is only meaningful if every identity in the turn agrees: the
// turn/start response, the turn/started notification, the turn/completed
// notification, and the turn id each hook was handed on stdin. If they
// disagree, the timings being compared may belong to different turns.
export function projectTurnIdentity(turn, captures, authoritativeTurnSha256) {
  const hookRecords = (Array.isArray(captures) ? captures : [])
    .filter((record) => record.turnIdPresent === true);
  const hookTurnIdsMatchResponse = hookRecords.length > 0
    && authoritativeTurnSha256 !== null
    && hookRecords.every((record) => record.turnIdSha256 === authoritativeTurnSha256);
  const responseMatchesStarted = turn?.responseMatchesStarted === true;
  const responseMatchesCompleted = turn?.responseMatchesCompleted === true;
  return {
    responseMatchesStarted,
    responseMatchesCompleted,
    hookTurnIdsMatchResponse,
    allConsistent: responseMatchesStarted
      && responseMatchesCompleted
      && hookTurnIdsMatchResponse,
  };
}

export function deriveOrdering(timings, captures) {
  const firstAt = (eventName) => {
    const times = captures
      .filter((record) => record.eventName === eventName)
      .map((record) => record.observedAtMs)
      .filter((value) => Number.isFinite(value));
    return times.length === 0 ? null : Math.min(...times);
  };
  const sessionStart = firstAt('sessionStart');
  const userPromptSubmit = firstAt('userPromptSubmit');
  const stop = firstAt('stop');
  return {
    sessionStartVsThreadStartResponse:
      compareObservations(sessionStart, timings.threadStartResponseMs),
    userPromptSubmitVsTurnStartResponse:
      compareObservations(userPromptSubmit, timings.turnStartResponseMs),
    userPromptSubmitVsTurnStartedNotification:
      compareObservations(userPromptSubmit, timings.turnStartedNotificationMs),
    userPromptSubmitVsStop: compareObservations(userPromptSubmit, stop),
    stopVsTurnStartedNotification:
      compareObservations(stop, timings.turnStartedNotificationMs),
    stopVsTurnCompletedNotification:
      compareObservations(stop, timings.turnCompletedNotificationMs),
    turnStartedNotificationVsTurnStartResponse: compareObservations(
      timings.turnStartedNotificationMs,
      timings.turnStartResponseMs,
    ),
    // The production `turn-accepted` checkpoint is recorded strictly after the
    // turn/start response is validated, so a hook observed before that
    // response is unconditionally before the checkpoint. A hook observed after
    // it is not bounded by timing alone; the deterministic ordering test in
    // tests/codex-process.test.js pins the code ordering instead.
    userPromptSubmitStrictlyBeforeTurnAccepted:
      compareObservations(userPromptSubmit, timings.turnStartResponseMs) === 'before',
    stopStrictlyBeforeTurnAccepted:
      compareObservations(stop, timings.turnStartResponseMs) === 'before',
    threadStartResponseToSessionStartBucket:
      bucketMargin(timings.threadStartResponseMs, sessionStart),
    turnStartResponseToUserPromptSubmitBucket:
      bucketMargin(timings.turnStartResponseMs, userPromptSubmit),
    turnStartedNotificationToUserPromptSubmitBucket:
      bucketMargin(timings.turnStartedNotificationMs, userPromptSubmit),
    userPromptSubmitToStopBucket: bucketMargin(userPromptSubmit, stop),
    stopToTurnCompletedBucket:
      bucketMargin(stop, timings.turnCompletedNotificationMs),
  };
}

// ---------------------------------------------------------------------------
// Capture reading. The on-disk record is already a closed projection; this
// only validates it.
// ---------------------------------------------------------------------------

// A capture directory is written by a child process, so every file in it is
// validated — name, type, ownership, mode, link count and size — before a
// single byte is read.
export function readS0Captures(captureDir, { onBeforeOpen = null } = {}) {
  const records = [];
  const files = existsSync(captureDir) ? readdirSync(captureDir) : [];
  if (files.length > MAX_CAPTURE_FILES) throw s0Failure('bounds', 'capture-file-count');
  let totalBytes = 0;
  for (const file of files) {
    if (!RECORDER_FILE_PATTERN.test(file)) throw s0Failure('framing', 'capture-filename');
    const target = path.join(captureDir, file);
    // Test seam: lets a regression swap the entry after its name has been
    // vetted and immediately before the open, which is the exact window a
    // path-based read leaves open.
    if (onBeforeOpen) onBeforeOpen(file);
    // Opened once, with no-follow, and validated on the descriptor rather than
    // on the path: a stat followed by a read of the same name is a race, and
    // the bytes that get parsed must be the bytes that were checked.
    let fd = null;
    let payload;
    try {
      try {
        fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        throw s0Failure('framing', 'capture-open');
      }
      const stats = fstatSync(fd);
      if (!stats.isFile()) throw s0Failure('framing', 'capture-type');
      if (stats.nlink !== 1) throw s0Failure('framing', 'capture-nlink');
      if (stats.uid !== process.getuid()) throw s0Failure('framing', 'capture-owner');
      if ((stats.mode & 0o777) !== 0o600) throw s0Failure('framing', 'capture-mode');
      if (stats.size > MAX_CAPTURE_FILE_BYTES) throw s0Failure('bounds', 'capture-file-bytes');
      totalBytes += stats.size;
      if (totalBytes > MAX_CAPTURE_TOTAL_BYTES) throw s0Failure('bounds', 'capture-total-bytes');
      const buffer = Buffer.alloc(stats.size);
      const read = readSync(fd, buffer, 0, stats.size, 0);
      if (read !== stats.size) throw s0Failure('framing', 'capture-short-read');
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch {
        throw s0Failure('framing', 'capture-json');
      }
    } finally {
      if (fd !== null) closeSync(fd);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw s0Failure('framing', 'capture-shape');
    }
    if (Object.keys(payload).sort().join(',') !== RECORDER_RECORD_KEYS) {
      throw s0Failure('framing', 'capture-keys');
    }
    const digest = payload.turnIdSha256 == null ? null : String(payload.turnIdSha256);
    if (digest !== null && !/^[a-f0-9]{64}$/.test(digest)) {
      throw s0Failure('framing', 'capture-digest');
    }
    records.push({
      eventName: payload.eventName === null
        ? null
        : closedEnum(payload.eventName, S0_EVENTS, 'capture-event'),
      turnIdPresent: payload.turnIdPresent === true,
      turnIdSha256: digest,
      payloadParsed: payload.payloadParsed === true,
      observedAtMs: Number.isFinite(payload.observedAtMs) ? payload.observedAtMs : null,
    });
  }
  return records;
}

export function summarizeCaptures(records, authoritativeTurnSha256) {
  const summary = {};
  for (const eventName of S0_EVENTS) {
    const forEvent = records.filter((record) => record.eventName === eventName);
    summary[eventName] = {
      invocationCount: forEvent.length,
      turnIdPresentOnEvery: forEvent.length > 0
        && forEvent.every((record) => record.turnIdPresent === true),
      turnIdAbsentOnEvery: forEvent.length > 0
        && forEvent.every((record) => record.turnIdPresent === false),
      turnIdMatchesAuthoritative: forEvent.length > 0
        && authoritativeTurnSha256 !== null
        && forEvent.every((record) => record.turnIdSha256 === authoritativeTurnSha256),
      payloadParsedOnEvery: forEvent.length > 0
        && forEvent.every((record) => record.payloadParsed === true),
    };
  }
  summary.unrecognizedEventCount = records
    .filter((record) => record.eventName === null).length;
  return summary;
}

// ---------------------------------------------------------------------------
// Lane provisioning.
// ---------------------------------------------------------------------------

function provisionS0Lane({
  laneRoot,
  providerPort,
  withHooks,
  withFeaturesHooks,
  trustState = null,
  captureDirName = 'capture-a',
  attestedPaths,
  nodePath,
}) {
  const codexHome = path.join(laneRoot, 'codex-home');
  const workspace = path.join(laneRoot, 'workspace');
  const foreign = path.join(laneRoot, 'foreign');
  const captureA = path.join(laneRoot, 'capture-a');
  const captureB = path.join(laneRoot, 'capture-b');
  for (const dir of [laneRoot, codexHome, workspace, foreign, captureA, captureB]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const canonicalWorkspace = realpathSync(workspace);
  const captureDir = realpathSync(path.join(laneRoot, captureDirName));
  const hooksPath = path.join(codexHome, 'hooks.json');
  const commandByEvent = {};
  if (withHooks) {
    for (const eventName of S0_EVENTS) {
      commandByEvent[eventName] = renderHookCommand({
        runtime: { path: nodePath, kind: 'system-runtime' },
        artifacts: [{ path: RECORDER_PATH, kind: 'shipped-artifact' }],
        argv: [eventName, captureDir],
      }, attestedPaths);
    }
    writeFileSync(hooksPath, `${JSON.stringify({
      hooks: Object.fromEntries(S0_EVENTS.map((eventName) => [
        S0_CONFIG_KEYS[eventName],
        [{ hooks: [{ type: 'command', command: commandByEvent[eventName] }] }],
      ])),
    }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(hooksPath, 0o600);
  }
  const configModel = buildS0Config({
    codexHome,
    workspace: canonicalWorkspace,
    providerPort,
    withFeaturesHooks,
    trustState,
  });
  const configPath = path.join(codexHome, 'config.toml');
  writeFileSync(configPath, renderS0Config(configModel), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return {
    codexHome,
    workspace: canonicalWorkspace,
    foreignCwd: realpathSync(foreign),
    captureDir,
    captureA: realpathSync(captureA),
    captureB: realpathSync(captureB),
    configPath,
    hooksPath,
    configModel,
    configModelDigest: jsonDigest(configModel),
    configSha256: fileDigest(configPath),
    hooksSha256: withHooks ? fileDigest(hooksPath) : null,
    commandByEvent,
    env: { HOME: laneRoot, PATH: '/usr/bin:/bin', TMPDIR: canonicalWorkspace },
  };
}

function laneSpec(lane) {
  return { codexHome: lane.codexHome, workspace: lane.workspace, env: lane.env };
}

// ---------------------------------------------------------------------------
// Raw measurements.
// ---------------------------------------------------------------------------

async function requestHooks(session, form, lane, stage) {
  const params = {
    omitted: undefined,
    empty: {},
    emptyCwds: { cwds: [] },
    ownedCwd: { cwds: [lane.workspace] },
    foreignCwd: { cwds: [lane.foreignCwd] },
    bothCwds: { cwds: [lane.workspace, lane.foreignCwd] },
  }[form];
  try {
    const result = await session.request('hooks/list', params, stage, REQUEST_TIMEOUT_MS);
    const entries = Array.isArray(result?.data) ? result.data : [];
    return {
      verdict: 'accepted',
      rpcErrorClass: 'none',
      // No cursor, no continuation token, no total: whether the method pages
      // at a larger cardinality is not something one small response can say,
      // so only the observed envelope shape is recorded.
      responseKeysAreDataOnly: Object.keys(result ?? {}).length === 1
        && Object.keys(result ?? {})[0] === HOOKS_LIST_RESPONSE_KEYS[0],
      entryCount: entries.length,
      hookCount: entries.reduce(
        (total, entry) => total + (Array.isArray(entry.hooks) ? entry.hooks.length : 0),
        0,
      ),
      everyEntryCwdEqualsOwned: entries.length > 0
        && entries.every((entry) => entry.cwd === lane.workspace),
      anyEntryCwdEqualsRequestedForeign: entries
        .some((entry) => entry.cwd === lane.foreignCwd),
      errorsEmptyOnEvery: entries.every((entry) => (entry.errors ?? []).length === 0),
      warningsEmptyOnEvery: entries.every((entry) => (entry.warnings ?? []).length === 0),
    };
  } catch (error) {
    if (categorizeFailure(error) !== 'protocol') throw error;
    return {
      verdict: 'rejected',
      rpcErrorClass: classifyRpcErrorCode(error.rpcErrorCode ?? null),
      responseKeysAreDataOnly: false,
      entryCount: 0,
      hookCount: 0,
      everyEntryCwdEqualsOwned: false,
      anyEntryCwdEqualsRequestedForeign: false,
      errorsEmptyOnEvery: true,
      warningsEmptyOnEvery: true,
    };
  }
}

async function listHookInventory(lane, binary, guard, trustStatus) {
  if (typeof guard !== 'function') throw s0Failure('attestation', 'launch-unguarded');
  guard();
  return withRawSession({ binary, ...laneSpec(lane) }, async (session) => {
    await session.initialize();
    // The frozen params form, not the permissive one: discovery reads exactly
    // the owned workspace or it fails.
    const result = await session.request(
      'hooks/list',
      { cwds: [lane.workspace] },
      'inventory',
      REQUEST_TIMEOUT_MS,
    );
    const raw = validateHooksListEnvelope(result, lane.workspace);
    // Projected immediately; the raw response is discarded with this frame.
    return splitHookInventory(raw, {
      sourcePath: lane.hooksPath,
      commandByEvent: lane.commandByEvent,
      trustStatus,
    });
  });
}

async function measureParamForms(lane, binary, guard) {
  if (typeof guard !== 'function') throw s0Failure('attestation', 'launch-unguarded');
  guard();
  return withRawSession({ binary, ...laneSpec(lane) }, async (session) => {
    await session.initialize();
    const measured = {};
    for (const form of PARAM_FORMS) {
      measured[form] = await requestHooks(session, form, lane, `params-${form}`);
    }
    return measured;
  });
}

function projectConfigLayers(result, lane) {
  const layers = Array.isArray(result?.layers) ? result.layers : [];
  const named = layers.map((layer) => ({
    type: typeof layer?.name === 'string' ? layer.name : layer?.name?.type,
    config: layer?.config,
  }));
  const userLayer = named.find((layer) => layer.type === 'user') ?? null;
  const config = userLayer?.config ?? null;
  const hooks = config && typeof config === 'object' ? config.hooks : null;
  const state = hooks && typeof hooks === 'object' ? hooks.state : null;
  const predeclared = new Set(Object.keys(lane.configModel.hooks?.state ?? {}));
  const stateKeys = state && typeof state === 'object' ? Object.keys(state) : [];
  const stateEntryFields = new Set();
  for (const key of stateKeys) {
    for (const field of Object.keys(state[key] ?? {})) stateEntryFields.add(field);
  }
  const topLevelKeys = config && typeof config === 'object' ? Object.keys(config) : [];
  const hooksTableKeys = hooks && typeof hooks === 'object' ? Object.keys(hooks) : [];
  const effective = result?.config ?? null;
  const effectiveHooks = effective && typeof effective === 'object' ? effective.hooks : null;
  return {
    layerCount: layers.length,
    layerTypes: named
      .map((layer) => layer.type)
      .filter((type) => CONFIG_LAYER_TYPES.includes(type)),
    unrecognizedLayerCount: named
      .filter((layer) => !CONFIG_LAYER_TYPES.includes(layer.type)).length,
    userLayerPresent: userLayer !== null,
    userLayerDigest: config == null ? null : jsonDigest(config),
    userLayerEqualsWrittenObjectModel: config != null
      && jsonDigest(config) === lane.configModelDigest,
    userLayerTopLevelKeyCount: topLevelKeys.length,
    userLayerUnexpectedTopLevelKeyCount: topLevelKeys
      .filter((key) => !S0_CONFIG_TOP_LEVEL_KEYS.includes(key)).length,
    userLayerHooksPresent: hooks != null,
    userLayerHooksTableKeys: hooksTableKeys.filter((key) => HOOKS_TABLE_KEYS.includes(key)),
    userLayerHooksUnexpectedTableKeyCount: hooksTableKeys
      .filter((key) => !HOOKS_TABLE_KEYS.includes(key)).length,
    userLayerHooksStateEntryCount: stateKeys.length,
    userLayerHooksStateKeysEqualPredeclared: stateKeys.length === predeclared.size
      && stateKeys.every((key) => predeclared.has(key)),
    userLayerHooksStateFieldNames: [...stateEntryFields]
      .filter((field) => HOOK_STATE_ENTRY_KEYS.includes(field)),
    userLayerHooksStateUnexpectedFieldCount: [...stateEntryFields]
      .filter((field) => !HOOK_STATE_ENTRY_KEYS.includes(field)).length,
    effectiveConfigDigest: effective == null ? null : jsonDigest(effective),
    effectiveHooksPresent: effectiveHooks != null,
    effectiveHooksTableKeyCount: effectiveHooks && typeof effectiveHooks === 'object'
      ? Object.keys(effectiveHooks).length
      : 0,
  };
}

async function readConfigLayers(lane, binary, guard) {
  if (typeof guard !== 'function') throw s0Failure('attestation', 'launch-unguarded');
  guard();
  return withRawSession({ binary, ...laneSpec(lane) }, async (session) => {
    await session.initialize();
    const result = await session.request(
      'config/read',
      { cwd: lane.workspace, includeLayers: true },
      'config-read',
      REQUEST_TIMEOUT_MS,
    );
    // Projected immediately; the raw config object is discarded with this frame.
    return projectConfigLayers(result, lane);
  });
}

// ---------------------------------------------------------------------------
// Snapshot boundary.
//
// Each boundary lane starts with manifest content A on disk while the trust
// stanza pins content B, then swaps A→B at one point in the startup sequence.
// If B runs, the swap beat the snapshot; if nothing runs, A was snapshotted and
// is `modified`. The last point at which B still runs locates the boundary.
// ---------------------------------------------------------------------------

export const BOUNDARY_LANE_VERDICTS = Object.freeze([
  'new-content', 'old-content', 'none', 'ambiguous',
]);

// A lane that faulted produces no captures, which reads exactly like "the
// swapped-in content did not run". Health is therefore checked before the
// capture split is allowed to mean anything: an unhealthy lane abstains.
export function classifyBoundaryLane({ newCount, oldCount, healthy } = {}) {
  if (healthy !== true) return null;
  if (!Number.isSafeInteger(newCount) || !Number.isSafeInteger(oldCount)) return null;
  if (newCount > 0 && oldCount > 0) return 'ambiguous';
  if (newCount > 0) return 'new-content';
  if (oldCount > 0) return 'old-content';
  return 'none';
}

export function classifySnapshotBoundary({ preSpawn, postStart, postThread } = {}) {
  const lanes = [preSpawn, postStart, postThread];
  // Any lane that could not be classified, ran content its stanza does not
  // trust, or produced both contents at once leaves the boundary unlocated.
  if (lanes.some((lane) => lane !== 'new-content' && lane !== 'none')) return null;
  // Without the control the experiment proved nothing, and a non-monotonic
  // result means the swap point is not what decided the outcome.
  if (preSpawn !== 'new-content') return null;
  if (postStart !== 'new-content' && postThread === 'new-content') return null;
  if (postThread === 'new-content') return 'after-thread-start-response';
  if (postStart === 'new-content') return 'during-thread-start';
  return 'at-or-before-process-spawn';
}

// Every production lane in this run — the characterization lane, the fresh
// session, the feature-flag control and each boundary lane — has to clear the
// same bar before its result is evidence of anything.
export function sessionLaneIsHealthy(session, turn) {
  return session != null
    && session.error == null
    && session.outcome?.faultCategory === 'none'
    && session.outcome?.closeClean === true
    && session.outcome?.childRetired === true
    && session.outcome?.deliveredHookMethodCount === 0
    && turn != null
    && turn.status === 'completed'
    && turn.identityConsistent === true
    && turn.assistantItemObserved === true;
}

// Parity, not presence: "a guard ran at least once" would be satisfied by one
// guarded launch out of nine.
export function launchAttestationIsComplete({ intended, guarded } = {}) {
  return Number.isSafeInteger(intended)
    && Number.isSafeInteger(guarded)
    && intended > 0
    && guarded === intended;
}

// ---------------------------------------------------------------------------
// Production-client turn lanes, instrumented for ordering.
// ---------------------------------------------------------------------------

// The client spawns its child detached, so the child leads its own process
// group. Retirement is proved against that pid and group, not against a text
// match on a command line.
async function defaultVerifyRetired(child, inspectGroup) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  const deadline = Date.now() + CHILD_RETIRE_TIMEOUT_MS;
  let escalated = false;
  while (Date.now() < deadline) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw s0Failure('cleanup', 'retire-probe');
    }
    const members = inspectGroup(pid);
    if (!alive && members.length === 0) return true;
    if (!escalated) {
      escalated = true;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await wait(25);
  }
  return false;
}

export async function withProductionSession(options, body) {
  const {
    binary,
    lane,
    model,
    createClient = (clientOptions) => new CodexAppServerClient(clientOptions),
    guard,
    verifyRetired = defaultVerifyRetired,
    inspectGroup = createGroupInspector(),
    onStarted = async () => {},
    onThreadStarted = async () => {},
  } = options;
  // Every app-server launch is attested immediately beforehand. Making the
  // guard a required argument is what stops a new call site from quietly
  // launching a child without one.
  if (typeof guard !== 'function') throw s0Failure('attestation', 'launch-unguarded');
  const delivered = [];
  // One record per turn. A single mutable slot would let the second turn
  // overwrite the first turn's identity and timings, which is exactly how an
  // ordering derived from mismatched turns goes unnoticed.
  const turns = [];
  let current = null;
  let observedFaultCategory = null;
  let completion = null;
  const client = createClient({
    binary,
    cwd: lane.workspace,
    codexHome: lane.codexHome,
    env: lane.env,
    expectedConfigSha256: lane.configSha256,
    requestTimeoutMs: 30_000,
    onFault: async (error) => { observedFaultCategory ??= categorizeFailure(error); },
    onNotification: async (notification) => {
      delivered.push(notification.method);
      if (notification.method === 'turn/started' && current) {
        current.startedAtMs ??= Date.now();
        current.startedId ??= notification.params?.turn?.id ?? null;
      }
      // Correlated to this turn and typed: a lane-wide "some item completed"
      // flag is overwritten by the next turn and is satisfied by any item.
      if (notification.method === 'item/completed' && current) {
        if (
          notification.params?.item?.type === 'agentMessage'
          && notification.params?.turnId != null
          && notification.params.turnId === current.responseId
        ) current.assistantItemObserved = true;
      }
      if (notification.method === 'turn/completed' && current) {
        current.completedAtMs = Date.now();
        current.completedId = notification.params?.turn?.id ?? null;
        completion?.(notification);
      }
    },
  });
  const ledger = { onWriteAttempted: () => {}, onResponseObserved: () => {} };
  const outcome = {
    turnStatus: null,
    assistantItemObserved: false,
    faultCategory: 'none',
    deliveredHookMethodCount: 0,
    closeClean: false,
    childRetired: false,
    turnCount: 0,
  };
  const handle = {
    turns,
    outcome,
    async runTurn(threadId) {
      const record = {
        responseId: null,
        startedId: null,
        completedId: null,
        threadStartResponseMs: handle.threadStartResponseMs ?? null,
        responseAtMs: null,
        startedAtMs: null,
        completedAtMs: null,
        status: null,
        assistantItemObserved: false,
        responseMatchesStarted: false,
        responseMatchesCompleted: false,
        identityConsistent: false,
      };
      current = record;
      const completed = new Promise((resolve) => { completion = resolve; });
      const started = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'probe' }],
      }, ledger);
      // The same position in the sequence at which CodexProcess records its
      // durable `turn-accepted` checkpoint: after the response carries a turn
      // id, before the turn/started confirmation is awaited.
      if (!started?.turn?.id) throw s0Failure('protocol', 'turn-start-id');
      record.responseAtMs = Date.now();
      record.responseId = started.turn.id;
      // Cancelled on the way out. An armed 45s timer would keep the event
      // loop alive long after a turn that resolved in milliseconds, so the
      // run would only ever exit by being forced to.
      const deadline = boundedDeadline(TURN_COMPLETION_TIMEOUT_MS, 'turn-completion');
      let completedNotification;
      try {
        completedNotification = await Promise.race([completed, deadline.promise]);
      } finally {
        deadline.cancel();
      }
      record.status = completedNotification.params?.turn?.status ?? null;
      // The response is compared against the turn/**started** id, which is the
      // identity the hook payload carries. Comparing it against the completed
      // id instead reports a consistent turn whenever the two notifications
      // disagree — the one case worth catching.
      record.responseMatchesStarted = record.startedId !== null
        && record.startedId === record.responseId;
      record.responseMatchesCompleted = record.completedId !== null
        && record.completedId === record.responseId;
      record.identityConsistent =
        record.responseMatchesStarted && record.responseMatchesCompleted;
      turns.push(record);
      outcome.turnCount = turns.length;
      outcome.turnStatus = record.status;
      return record;
    },
  };
  let bodyValue;
  let bodyError = null;
  try {
    guard();
    await client.start();
    await onStarted();
    const thread = await client.request('thread/start', {
      cwd: lane.workspace,
      model,
    }, ledger);
    handle.threadStartResponseMs = Date.now();
    handle.threadId = thread.thread.id;
    await onThreadStarted();
    bodyValue = await body(handle);
  } catch (error) {
    bodyError = error;
    observedFaultCategory ??= categorizeFailure(error);
  } finally {
    outcome.deliveredHookMethodCount = delivered
      .filter((method) => method.startsWith('hook/')).length;
    outcome.assistantItemObserved = delivered.includes('item/completed');
    const child = client.child ?? null;
    try {
      await client.close();
      outcome.closeClean = true;
    } catch (error) {
      // A close that did not verify its own containment invalidates the lane;
      // it is not a downstream symptom to be absorbed by an earlier result.
      observedFaultCategory = categorizeFailure(error);
      outcome.closeClean = false;
    }
    try {
      outcome.childRetired = await verifyRetired(child, inspectGroup);
    } catch (error) {
      observedFaultCategory ??= categorizeFailure(error);
      outcome.childRetired = false;
    }
    if (!outcome.childRetired) observedFaultCategory ??= 'cleanup';
    outcome.faultCategory = observedFaultCategory ?? 'none';
  }
  return { value: bodyValue, error: bodyError, outcome, turns };
}

// ---------------------------------------------------------------------------
// Strict projection. Every emitted object is built key by key from approved
// names and approved scalar types; nothing derived from a measurement is ever
// spread, so an unapproved key cannot survive by escaping a denylist.
// ---------------------------------------------------------------------------

const asBool = (value) => value === true;
const asNullableBool = (value) => (typeof value === 'boolean' ? value : null);
const asCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const asInt = (value) => (Number.isSafeInteger(value) ? value : null);
const asDigest = (value) => (
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
);
const asEnum = (allowed) => (value) => (allowed.includes(value) ? value : null);
const asEnumList = (allowed) => (value) => (
  Array.isArray(value) ? value.filter((entry) => allowed.includes(entry)) : []
);

function projectShape(source, spec) {
  const projected = {};
  for (const [key, pick] of Object.entries(spec)) {
    projected[key] = pick(source == null ? undefined : source[key]);
  }
  return projected;
}

const PARAM_FORM_SPEC = {
  verdict: asEnum(PARAM_VERDICTS),
  rpcErrorClass: asEnum(RPC_ERROR_CLASSES),
  responseKeysAreDataOnly: asBool,
  entryCount: asCount,
  hookCount: asCount,
  everyEntryCwdEqualsOwned: asBool,
  anyEntryCwdEqualsRequestedForeign: asBool,
  errorsEmptyOnEvery: asBool,
  warningsEmptyOnEvery: asBool,
};

const HOOK_ENTRY_SPEC = {
  eventName: asEnum(S0_EVENTS),
  trustStatus: asEnum(HOOK_TRUST_STATUSES),
  handlerType: asEnum(HOOK_HANDLER_TYPES),
  source: asEnum(HOOK_SOURCES),
  enabled: asBool,
  isManaged: asBool,
  displayOrder: asInt,
  timeoutSec: asInt,
  requiredFieldsPresent: asBool,
  currentHashWellFormed: asBool,
  keyMatchesTemplate: asBool,
  keySnakeTokenMatches: asBool,
  keyIndexI: asInt,
  keyIndexJ: asInt,
  sourcePathMatchesManifest: asBool,
  commandPresent: asBool,
  commandMatchesRendered: asBool,
  optionalFieldsWithKey: asEnumList(HOOK_METADATA_OPTIONAL_FIELDS),
  optionalFieldsNonNull: asEnumList(HOOK_METADATA_OPTIONAL_FIELDS),
  unknownFieldCount: asCount,
};

const LAYER_SPEC = {
  layerCount: asCount,
  layerTypes: asEnumList(CONFIG_LAYER_TYPES),
  unrecognizedLayerCount: asCount,
  userLayerPresent: asBool,
  userLayerDigest: asDigest,
  userLayerEqualsWrittenObjectModel: asBool,
  userLayerTopLevelKeyCount: asCount,
  userLayerUnexpectedTopLevelKeyCount: asCount,
  userLayerHooksPresent: asBool,
  userLayerHooksTableKeys: asEnumList(HOOKS_TABLE_KEYS),
  userLayerHooksUnexpectedTableKeyCount: asCount,
  userLayerHooksStateEntryCount: asCount,
  userLayerHooksStateKeysEqualPredeclared: asBool,
  userLayerHooksStateFieldNames: asEnumList(HOOK_STATE_ENTRY_KEYS),
  userLayerHooksStateUnexpectedFieldCount: asCount,
  effectiveConfigDigest: asDigest,
  effectiveHooksPresent: asBool,
  effectiveHooksTableKeyCount: asCount,
};

const CAPTURE_EVENT_SPEC = {
  invocationCount: asCount,
  turnIdPresentOnEvery: asBool,
  turnIdAbsentOnEvery: asBool,
  turnIdMatchesAuthoritative: asBool,
  payloadParsedOnEvery: asBool,
};

const RECEIPT_SPEC = {
  kind: asEnum(ARTIFACT_KINDS),
  sha256: asDigest,
  nlink: asCount,
  isRegularFile: asBool,
  isSymlink: asBool,
  isCanonicalPath: asBool,
  ownerIsSelf: asBool,
  ownerIsRoot: asBool,
  groupOrWorldWritable: asBool,
  ownerExecutable: asBool,
  ownerOnlyMode: asBool,
  parentChainSafe: asBool,
  satisfiesKindRule: asBool,
};

const TURN_OUTCOME_SPEC = {
  turnStatus: asEnum(TURN_STATUSES),
  faultCategory: asEnum(FAULT_CATEGORIES),
  deliveredHookMethodCount: asCount,
  closeClean: asBool,
  childRetired: asBool,
  turnCount: asCount,
};

const FIRST_TURN_SPEC = {
  status: asEnum(TURN_STATUSES),
  assistantItemObserved: asBool,
  identityConsistent: asBool,
};

const TURN_IDENTITY_SPEC = {
  responseMatchesStarted: asBool,
  responseMatchesCompleted: asBool,
  hookTurnIdsMatchResponse: asBool,
  allConsistent: asBool,
};

const ORDERING_SPEC = {
  sessionStartVsThreadStartResponse: asEnum(ORDER_VERDICTS),
  userPromptSubmitVsTurnStartResponse: asEnum(ORDER_VERDICTS),
  userPromptSubmitVsTurnStartedNotification: asEnum(ORDER_VERDICTS),
  userPromptSubmitVsStop: asEnum(ORDER_VERDICTS),
  stopVsTurnStartedNotification: asEnum(ORDER_VERDICTS),
  stopVsTurnCompletedNotification: asEnum(ORDER_VERDICTS),
  turnStartedNotificationVsTurnStartResponse: asEnum(ORDER_VERDICTS),
  userPromptSubmitStrictlyBeforeTurnAccepted: asNullableBool,
  stopStrictlyBeforeTurnAccepted: asNullableBool,
  threadStartResponseToSessionStartBucket: asEnum(MARGIN_BUCKETS),
  turnStartResponseToUserPromptSubmitBucket: asEnum(MARGIN_BUCKETS),
  turnStartedNotificationToUserPromptSubmitBucket: asEnum(MARGIN_BUCKETS),
  userPromptSubmitToStopBucket: asEnum(MARGIN_BUCKETS),
  stopToTurnCompletedBucket: asEnum(MARGIN_BUCKETS),
};

function projectCaptureSummary(summary) {
  return {
    ...Object.fromEntries(S0_EVENTS.map((eventName) => [
      eventName,
      projectShape(summary?.[eventName], CAPTURE_EVENT_SPEC),
    ])),
    unrecognizedEventCount: asCount(summary?.unrecognizedEventCount) ?? 0,
  };
}

function projectInventory(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => projectShape(entry, HOOK_ENTRY_SPEC));
}

// ---------------------------------------------------------------------------
// The gate.
//
// "Every decision was attempted" is not "every decision produced a safe,
// present answer". These predicates are evaluated over the **projected**
// evidence, so a value that collapsed to null on its way through the
// projection fails here rather than passing as a clean absence.
// ---------------------------------------------------------------------------

export const S0_GATE_CHECKS = Object.freeze([
  'unmeasuredLabelsRecognized',
  'appServerLaunchesAllPrelaunchAttested',
  'auxiliaryLanesHealthy',
  'pinnedBinaryAttested',
  'targetReceiptRecognized',
  'systemRuntimeReceiptSafe',
  'shippedArtifactReceiptSafe',
  'commandRenderingDeterministic',
  'commandDigestsComplete',
  'credentialFreeByConstruction',
  'paramFormEvidenceComplete',
  'ownedCwdFormUsable',
  'userLayerEvidenceComplete',
  'userLayerIsExactParse',
  'trustStateVisibleInUserLayer',
  'featureFlagEvidenceComplete',
  'keyDerivationConfirmed',
  'hookInventoryComplete',
  'currentHashStableAcrossSessions',
  'fireTimeEvidenceComplete',
  'snapshotBoundaryLocated',
  'orderingEvidenceComplete',
  'turnIdentityConsistent',
  'characterizationTurnClean',
  'hookCapturesComplete',
  'turnFileStabilityHeld',
  'ownedProcessesRetired',
  'scratchRemoved',
]);

function receiptIsSafe(receipt, kind) {
  return receipt != null
    && receipt.kind === kind
    && receipt.satisfiesKindRule === true
    && receipt.sha256 !== null
    && receipt.isRegularFile === true
    && receipt.isSymlink === false
    && receipt.nlink === 1
    && receipt.groupOrWorldWritable === false
    && receipt.parentChainSafe === true
    && receipt.isCanonicalPath === true
    && (kind === 'system-runtime'
      ? (receipt.ownerIsRoot === true || receipt.ownerIsSelf === true)
      : receipt.ownerIsSelf === true);
}

function inventoryIsComplete(entries, trustStatus) {
  return Array.isArray(entries)
    && entries.length === S0_EVENTS.length
    && S0_EVENTS.every((eventName) => (
      entries.filter((entry) => entry.eventName === eventName).length === 1
    ))
    && entries.every((entry) => entry.trustStatus === trustStatus
      && entry.handlerType === 'command'
      && entry.source === 'user'
      && entry.isManaged === false
      && entry.displayOrder !== null
      && entry.timeoutSec !== null
      && entry.requiredFieldsPresent === true
      && entry.currentHashWellFormed === true
      && entry.keyMatchesTemplate === true
      && entry.sourcePathMatchesManifest === true
      && entry.commandMatchesRendered === true
      && entry.unknownFieldCount === 0);
}

function layerEvidenceIsComplete(layer) {
  return layer != null
    && layer.userLayerPresent === true
    && layer.userLayerDigest !== null
    && layer.effectiveConfigDigest !== null
    && layer.layerTypes.includes('user')
    && layer.unrecognizedLayerCount === 0
    && layer.userLayerUnexpectedTopLevelKeyCount === 0
    && layer.userLayerHooksUnexpectedTableKeyCount === 0
    && layer.userLayerHooksStateUnexpectedFieldCount === 0;
}

export function evaluateS0Gate(evidence) {
  const receipts = evidence.receipts ?? {};
  const credential = evidence.credentialFree ?? {};
  const forms = evidence.e2ParamForms ?? {};
  const layers = evidence.e1UserLayer ?? {};
  const flag = evidence.e4FeatureFlag ?? {};
  const keys = evidence.e5KeyDerivation ?? {};
  const metadata = evidence.metadata ?? {};
  const fireTime = evidence.e6FireTime ?? {};
  const ordering = evidence.e7Ordering ?? {};
  const identity = evidence.turnIdentity ?? {};
  const hooksOn = evidence.turn?.hooksOn ?? {};
  const firstTurn = evidence.turn?.firstTurn ?? {};
  const captures = evidence.turn?.captures ?? {};
  const stability = evidence.stability ?? {};
  const cleanup = evidence.cleanup ?? {};
  const acceptedForms = PARAM_FORMS
    .map((form) => forms[form])
    .filter((form) => form?.verdict === 'accepted');
  const lanes = evidence.auxiliaryLanes ?? {};
  const checks = {
    // An unrecognized decision label is a decision nobody can account for; it
    // must stop the run rather than be filtered out of sight.
    unmeasuredLabelsRecognized: evidence.unrecognizedUnmeasuredCount === 0,
    // Parity, not presence: every intended app-server launch was preceded by a
    // fresh artifact attestation, not merely the first one.
    appServerLaunchesAllPrelaunchAttested: launchAttestationIsComplete({
      intended: receipts.appServerLaunchesIntended,
      guarded: receipts.appServerLaunchesAttested,
    }) && receipts.appServerLaunchesIntended === EXPECTED_APP_SERVER_LAUNCHES,
    // The boundary lanes, the fresh session and the feature-flag control all
    // feed conclusions, so all of them are held to the characterization lane's
    // bar rather than merely to "it did not throw".
    auxiliaryLanesHealthy: lanes.newSessionLaneHealthy === true
      && lanes.featureFlagLaneHealthy === true
      && lanes.boundaryLanesHealthy === true,
    pinnedBinaryAttested: receipts.pinnedBinaryAttested === true,
    targetReceiptRecognized: receipts.target !== null,
    systemRuntimeReceiptSafe: receiptIsSafe(receipts.systemRuntime, 'system-runtime'),
    shippedArtifactReceiptSafe: receiptIsSafe(receipts.shippedArtifact, 'shipped-artifact'),

    commandRenderingDeterministic: receipts.commandRenderIsDeterministic === true,
    commandDigestsComplete: S0_EVENTS
      .every((eventName) => receipts.commandDigestByEvent?.[eventName] !== null),
    credentialFreeByConstruction: credential.authFileAbsent === true
      && credential.providerRequiresAuth === false
      && credential.isolatedHomeMode0700 === true,
    paramFormEvidenceComplete: PARAM_FORMS.every((form) => forms[form]?.verdict !== null)
      && acceptedForms.length > 0
      && acceptedForms.every((form) => form.responseKeysAreDataOnly === true
        && form.errorsEmptyOnEvery === true
        && form.warningsEmptyOnEvery === true
        && form.entryCount !== null
        && form.hookCount !== null),
    ownedCwdFormUsable: forms.ownedCwd?.verdict === 'accepted'
      && forms.ownedCwd.entryCount === 1
      && forms.ownedCwd.hookCount === S0_EVENTS.length
      && forms.ownedCwd.everyEntryCwdEqualsOwned === true,
    userLayerEvidenceComplete: layerEvidenceIsComplete(layers.hooksPresentNoTrust)
      && layerEvidenceIsComplete(layers.trusted)
      && layers.userLayerDigestStableAcrossSessions === true,
    userLayerIsExactParse:
      layers.hooksPresentNoTrust?.userLayerEqualsWrittenObjectModel === true
      && layers.trusted?.userLayerEqualsWrittenObjectModel === true,
    trustStateVisibleInUserLayer:
      layers.hooksPresentNoTrust?.userLayerHooksPresent === false
      && layers.trusted?.userLayerHooksPresent === true
      && layers.trusted?.userLayerHooksStateEntryCount === S0_EVENTS.length
      && layers.trusted?.userLayerHooksStateKeysEqualPredeclared === true
      && [...(layers.trusted?.userLayerHooksStateFieldNames ?? [])].sort().join(',')
        === 'enabled,trusted_hash',
    featureFlagEvidenceComplete: flag.requiredForDiscovery !== null
      && flag.requiredForExecution !== null
      && flag.withFlag?.hookCountListed !== null
      && flag.withFlag?.firedEventCount !== null
      && flag.withoutFlag?.hookCountListed !== null
      && flag.withoutFlag?.firedEventCount !== null,
    keyDerivationConfirmed: S0_EVENTS.every((eventName) => (
      keys[eventName]?.matchesTemplate === true
      && keys[eventName]?.indexI !== null
      && keys[eventName]?.indexJ !== null
    )),
    hookInventoryComplete: inventoryIsComplete(metadata.untrustedInventory, 'untrusted')
      && inventoryIsComplete(metadata.trustedInventory, 'trusted')
      && metadata.untrustedInventoryTrustable === true
      && metadata.trustedInventoryTrustable === true,
    currentHashStableAcrossSessions: metadata.currentHashStableAcrossSessions === true,
    fireTimeEvidenceComplete: fireTime.sameSessionContentSource !== null
      && fireTime.revalidatesAtFireTime !== null
      && fireTime.firstTurnCaptureCount === S0_EVENTS.length
      // Exactly one status, and it must be `modified`: the fresh session is
      // the negative control, and a partially-modified inventory proves less.
      && (fireTime.newSessionTrustStatusAfterMutation ?? []).length === 1
      && fireTime.newSessionTrustStatusAfterMutation[0] === 'modified'
      && fireTime.newSessionInventoryExact === true
      // The mutated-manifest turn is judged on its own record.
      && fireTime.sameSessionSecondTurn?.status === 'completed'
      && fireTime.sameSessionSecondTurn?.assistantItemObserved === true
      && fireTime.sameSessionSecondTurn?.identityConsistent === true
      && fireTime.newSessionTurnCompleted === true,
    snapshotBoundaryLocated: fireTime.snapshotBoundary !== null
      && fireTime.boundaryPreSpawnVerdict === 'new-content'
      && fireTime.boundaryPostStartVerdict !== null
      && fireTime.boundaryPostThreadVerdict !== null,
    orderingEvidenceComplete: Object.entries(ordering).every(([name, verdict]) => {
      // An absent boolean must not read as an observed `false`.
      if (name.endsWith('BeforeTurnAccepted')) return typeof verdict === 'boolean';
      if (name.endsWith('Bucket')) return verdict !== null && verdict !== 'unobserved';
      return verdict === 'before' || verdict === 'after';
    }),
    turnIdentityConsistent: identity.responseMatchesStarted === true
      && identity.responseMatchesCompleted === true
      && identity.hookTurnIdsMatchResponse === true
      && identity.allConsistent === true,
    characterizationTurnClean: firstTurn.status === 'completed'
      && firstTurn.assistantItemObserved === true
      && firstTurn.identityConsistent === true
      && hooksOn.faultCategory === 'none'
      && hooksOn.deliveredHookMethodCount === 0
      && hooksOn.closeClean === true
      && hooksOn.childRetired === true
      && (hooksOn.turnCount ?? 0) >= 1,
    hookCapturesComplete: S0_EVENTS.every((eventName) => (
      captures[eventName]?.invocationCount === 1
      && captures[eventName]?.payloadParsedOnEvery === true
    ))
      && captures.sessionStart?.turnIdAbsentOnEvery === true
      && ['userPromptSubmit', 'stop'].every((eventName) => (
        captures[eventName]?.turnIdPresentOnEvery === true
        && captures[eventName]?.turnIdMatchesAuthoritative === true
      ))
      && captures.unrecognizedEventCount === 0,
    turnFileStabilityHeld: stability.configDigestUnchangedAcrossTurn === true
      && stability.hooksManifestDigestUnchangedAcrossTurn === true
      && stability.configDigestChangedByTrustRender === true,
    ownedProcessesRetired: cleanup.strayProcessCount === 0,
    scratchRemoved: cleanup.probeRootRemoved === true,
  };
  return {
    checks,
    failedChecks: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name),
  };
}

export function buildS0Envelope(measured) {
  try {
    const source = measured ?? {};
    const evidence = {
      receipts: {
        pinnedBinaryAttested: asBool(source.receipts?.pinnedBinaryAttested),
        target: asEnum(CODEX_TARGETS)(source.receipts?.target),
        systemRuntime: projectShape(source.receipts?.systemRuntime, RECEIPT_SPEC),
        shippedArtifact: projectShape(source.receipts?.shippedArtifact, RECEIPT_SPEC),
        commandRenderIsDeterministic: asBool(source.receipts?.commandRenderIsDeterministic),
        appServerLaunchesIntended: asCount(source.receipts?.appServerLaunchesIntended),
        appServerLaunchesAttested: asCount(source.receipts?.appServerLaunchesAttested),
        commandDigestByEvent: Object.fromEntries(S0_EVENTS.map((eventName) => [
          eventName,
          asDigest(source.receipts?.commandDigestByEvent?.[eventName]),
        ])),
      },
      credentialFree: {
        authFileAbsent: asBool(source.credentialFree?.authFileAbsent),
        providerRequiresAuth: asNullableBool(source.credentialFree?.providerRequiresAuth),
        isolatedHomeMode0700: asBool(source.credentialFree?.isolatedHomeMode0700),
      },
      e2ParamForms: Object.fromEntries(PARAM_FORMS.map((form) => [
        form,
        projectShape(source.e2ParamForms?.[form], PARAM_FORM_SPEC),
      ])),
      e1UserLayer: {
        hooksPresentNoTrust: projectShape(source.e1UserLayer?.hooksPresentNoTrust, LAYER_SPEC),
        trusted: projectShape(source.e1UserLayer?.trusted, LAYER_SPEC),
        userLayerDigestStableAcrossSessions:
          asBool(source.e1UserLayer?.userLayerDigestStableAcrossSessions),
      },
      e4FeatureFlag: {
        withFlag: {
          hookCountListed: asCount(source.e4FeatureFlag?.withFlag?.hookCountListed),
          allTrustedAfterRender: asBool(source.e4FeatureFlag?.withFlag?.allTrustedAfterRender),
          firedEventCount: asCount(source.e4FeatureFlag?.withFlag?.firedEventCount),
        },
        withoutFlag: {
          hookCountListed: asCount(source.e4FeatureFlag?.withoutFlag?.hookCountListed),
          allTrustedAfterRender: asBool(source.e4FeatureFlag?.withoutFlag?.allTrustedAfterRender),
          firedEventCount: asCount(source.e4FeatureFlag?.withoutFlag?.firedEventCount),
        },
        requiredForDiscovery: asNullableBool(source.e4FeatureFlag?.requiredForDiscovery),
        requiredForExecution: asNullableBool(source.e4FeatureFlag?.requiredForExecution),
      },
      e5KeyDerivation: Object.fromEntries(S0_EVENTS.map((eventName) => [
        eventName,
        {
          matchesTemplate: asBool(source.e5KeyDerivation?.[eventName]?.matchesTemplate),
          snakeTokenMatches: asBool(source.e5KeyDerivation?.[eventName]?.snakeTokenMatches),
          indexI: asInt(source.e5KeyDerivation?.[eventName]?.indexI),
          indexJ: asInt(source.e5KeyDerivation?.[eventName]?.indexJ),
        },
      ])),
      metadata: {
        untrustedInventory: projectInventory(source.metadata?.untrustedInventory),
        trustedInventory: projectInventory(source.metadata?.trustedInventory),
        untrustedInventoryTrustable: asBool(source.metadata?.untrustedInventoryTrustable),
        trustedInventoryTrustable: asBool(source.metadata?.trustedInventoryTrustable),
        currentHashStableAcrossSessions:
          asBool(source.metadata?.currentHashStableAcrossSessions),
      },
      e6FireTime: {
        firstTurnCaptureCount: asCount(source.e6FireTime?.firstTurnCaptureCount),
        sameSessionAfterMutationOldPathCount:
          asCount(source.e6FireTime?.sameSessionAfterMutationOldPathCount),
        sameSessionAfterMutationNewPathCount:
          asCount(source.e6FireTime?.sameSessionAfterMutationNewPathCount),
        sameSessionSecondTurn: projectShape(source.e6FireTime?.sameSessionSecondTurn, FIRST_TURN_SPEC),
        newSessionInventoryExact: asBool(source.e6FireTime?.newSessionInventoryExact),
        sameSessionContentSource:
          asEnum(FIRE_TIME_CONTENT_SOURCES)(source.e6FireTime?.sameSessionContentSource),
        newSessionTrustStatusAfterMutation:
          asEnumList(HOOK_TRUST_STATUSES)(source.e6FireTime?.newSessionTrustStatusAfterMutation),
        newSessionOldPathCaptureCount: asCount(source.e6FireTime?.newSessionOldPathCaptureCount),
        newSessionNewPathCaptureCount: asCount(source.e6FireTime?.newSessionNewPathCaptureCount),
        newSessionTurnCompleted: asBool(source.e6FireTime?.newSessionTurnCompleted),
        revalidatesAtFireTime: asNullableBool(source.e6FireTime?.revalidatesAtFireTime),
        snapshotBoundary: asEnum(SNAPSHOT_BOUNDARIES)(source.e6FireTime?.snapshotBoundary),
        boundaryPreSpawnVerdict:
          asEnum(BOUNDARY_LANE_VERDICTS)(source.e6FireTime?.boundaryPreSpawnVerdict),
        boundaryPostStartVerdict:
          asEnum(BOUNDARY_LANE_VERDICTS)(source.e6FireTime?.boundaryPostStartVerdict),
        boundaryPostThreadVerdict:
          asEnum(BOUNDARY_LANE_VERDICTS)(source.e6FireTime?.boundaryPostThreadVerdict),
      },
      e7Ordering: projectShape(source.e7Ordering, ORDERING_SPEC),
      turnIdentity: projectShape(source.turnIdentity, TURN_IDENTITY_SPEC),
      auxiliaryLanes: {
        newSessionLaneHealthy: asBool(source.auxiliaryLanes?.newSessionLaneHealthy),
        featureFlagLaneHealthy: asBool(source.auxiliaryLanes?.featureFlagLaneHealthy),
        boundaryLanesHealthy: asBool(source.auxiliaryLanes?.boundaryLanesHealthy),
      },
      turn: {
        hooksOn: projectShape(source.turn?.hooksOn, TURN_OUTCOME_SPEC),
        firstTurn: projectShape(source.turn?.firstTurn, FIRST_TURN_SPEC),
        captures: projectCaptureSummary(source.turn?.captures),
      },
      stability: {
        configDigestUnchangedAcrossTurn: asBool(source.stability?.configDigestUnchangedAcrossTurn),
        hooksManifestDigestUnchangedAcrossTurn:
          asBool(source.stability?.hooksManifestDigestUnchangedAcrossTurn),
        configDigestChangedByTrustRender:
          asBool(source.stability?.configDigestChangedByTrustRender),
      },
      cleanup: {
        strayProcessCount: asCount(source.cleanup?.strayProcessCount),
        probeRootRemoved: asBool(source.cleanup?.probeRootRemoved),
      },
    };
    const rawUnmeasured = Array.isArray(source.unmeasured) ? source.unmeasured : [];
    const unmeasured = rawUnmeasured.filter((label) => S0_DECISIONS.includes(label));
    // The unknown label itself is never echoed; only that there was one.
    evidence.unrecognizedUnmeasuredCount = rawUnmeasured.length - unmeasured.length;
    // Evaluated over the projected evidence, never the raw measurement, so a
    // value that collapsed to null in projection fails the gate instead of
    // reading as a clean absence.
    const gate = evaluateS0Gate(evidence);
    const envelope = {
      gate: unmeasured.length === 0 && gate.failedChecks.length === 0 ? 'CONTINUE' : 'STOP',
      unmeasured,
      failedChecks: gate.failedChecks.map(
        (name) => closedEnum(name, S0_GATE_CHECKS, 'failed-check'),
      ),
      checks: Object.fromEntries(Object.entries(gate.checks).map(([name, passed]) => [
        closedEnum(name, S0_GATE_CHECKS, 'check-name'),
        passed === true,
      ])),
      evidence,
    };
    if (!envelopeIsContentFree(envelope)) throw s0Failure('framing', 'envelope-content');
    return envelope;
  } catch (error) {
    return s0StopEnvelope(error);
  }
}

export function s0StopEnvelope(error) {
  return {
    gate: 'STOP',
    unmeasured: [...S0_DECISIONS],
    failedChecks: [...S0_GATE_CHECKS],
    failureCategory: categorizeFailure(error),
  };
}

export const S0_DECISIONS = Object.freeze([
  'E1', 'E2', 'E4', 'E5', 'E6', 'E7',
  'metadata-shape', 'runtime-receipt', 'turn-stability',
]);

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function countStrayProcesses(marker, processLister = '/bin/ps') {
  const result = spawnSync(processLister, ['-axo', 'command='], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw s0Failure('cleanup', 'stray-inspect');
  }
  // Only the count leaves this function; no command line is retained.
  return result.stdout.split('\n').filter((line) => line.includes(marker)).length;
}

// Locates when the app-server fixes the manifest content it will execute.
//
// Each lane starts with manifest content A on disk while the trust stanza pins
// content B, then swaps A→B at one point in the startup sequence. Because
// trust is content-addressed, only one of the two can ever run: if B runs the
// swap beat the snapshot, and if nothing runs A was snapshotted and is
// `modified`. Three lanes bracket spawn, initialize and thread start.
async function locateSnapshotBoundary({
  binary, probeRoot, provision, guardLaunch,
}) {
  const ranNewContentAt = async (swapPoint) => {
    const laneRoot = path.join(probeRoot, `boundary-${swapPoint}`);
    // Content B first, purely to learn the hashes its commands produce.
    const contentB = provision({
      laneRoot, withHooks: true, withFeaturesHooks: true, captureDirName: 'capture-b',
    });
    const inventoryB = await listHookInventory(contentB, binary, guardLaunch, 'untrusted');
    // Read before re-provisioning: both provisionings share this lane root and
    // therefore the same manifest path, so reading afterwards would capture
    // content A and the swap would be a no-op.
    const manifestB = readFileSync(contentB.hooksPath, 'utf8');
    // Now content A on disk, with the trust stanza pinning content B.
    const lane = provision({
      laneRoot,
      withHooks: true,
      withFeaturesHooks: true,
      captureDirName: 'capture-a',
      trustState: trustStateFromInventory(inventoryB),
    });
    const swapToB = async () => {
      writeFileSync(lane.hooksPath, manifestB, { mode: 0o600 });
      chmodSync(lane.hooksPath, 0o600);
    };
    if (swapPoint === 'preSpawn') await swapToB();
    const session = await withProductionSession({
      binary,
      lane,
      model: MOCK_MODEL,
      guard: guardLaunch,
      onStarted: swapPoint === 'postStart' ? swapToB : undefined,
      onThreadStarted: swapPoint === 'postThread' ? swapToB : undefined,
    }, async (handle) => handle.runTurn(handle.threadId));
    // Content B writes into capture-b, content A into capture-a. A lane that
    // faulted produces neither, which is why health is checked before the
    // split is allowed to mean anything.
    return classifyBoundaryLane({
      newCount: readS0Captures(lane.captureB).length,
      oldCount: readS0Captures(lane.captureA).length,
      healthy: sessionLaneIsHealthy(session, session.turns[0] ?? null),
    });
  };
  const preSpawn = await ranNewContentAt('preSpawn');
  const postStart = await ranNewContentAt('postStart');
  const postThread = await ranNewContentAt('postThread');
  return {
    boundaryPreSpawnVerdict: preSpawn,
    boundaryPostStartVerdict: postStart,
    boundaryPostThreadVerdict: postThread,
    boundaryLanesHealthy: [preSpawn, postStart, postThread].every((v) => v !== null),
    snapshotBoundary: classifySnapshotBoundary({ preSpawn, postStart, postThread }),
  };
}

async function runS0Lanes({
  binary, attestation, targetReceipt, probeRoot, provider, runtime,
}) {
  const unmeasured = new Set(S0_DECISIONS);
  const measured = { unmeasured: [] };
  const nodePath = realpathSync.native(runtime ?? process.execPath);
  const recorderPath = realpathSync.native(RECORDER_PATH);
  if (recorderPath !== RECORDER_PATH) throw s0Failure('attestation', 'recorder-canonical');
  // Enforcing, not merely describing: an unsafe receipt stops the run here
  // rather than being carried forward as evidence that attestation happened.
  const systemRuntime = attestArtifactStrict(nodePath, 'system-runtime');
  const shippedArtifact = attestArtifactStrict(recorderPath, 'shipped-artifact');
  const attestedPaths = new Set([nodePath, recorderPath]);
  const pinnedArtifacts = { runtime: systemRuntime, recorder: shippedArtifact };
  const artifactPaths = { runtime: nodePath, recorder: recorderPath };
  // The hook hash binds the command string, and therefore the artifact path —
  // not the bytes at that path. Every app-server launch re-reads both
  // artifacts first. This closes the window up to launch; it does **not**
  // cover the window between launch and the moment a hook fires, which
  // nothing here closes.
  let launchesIntended = 0;
  let launchesAttested = 0;
  const guardLaunch = () => {
    launchesIntended += 1;
    verifyPinnedArtifacts(pinnedArtifacts, artifactPaths);
    launchesAttested += 1;
  };
  measured.receipts = {
    pinnedBinaryAttested: targetReceipt === null
      ? true
      : attestation.sha256 === targetReceipt.binarySha256
        && attestation.version === targetReceipt.cliVersion,
    target: targetReceipt?.target ?? null,
    systemRuntime,
    shippedArtifact,
  };
  unmeasured.delete('runtime-receipt');

  const provision = (options) => provisionS0Lane({
    providerPort: provider.port, attestedPaths, nodePath, ...options,
  });

  // --- Lane A: features flag on, full trust lifecycle -----------------------
  const laneARoot = path.join(probeRoot, 'features-on');
  let laneA = provision({
    laneRoot: laneARoot, withHooks: true, withFeaturesHooks: true,
  });
  measured.receipts.commandDigestByEvent = Object.fromEntries(
    S0_EVENTS.map((eventName) => [eventName, commandDigest(laneA.commandByEvent[eventName])]),
  );
  const reRendered = provision({
    laneRoot: path.join(probeRoot, 'render-check'), withHooks: true, withFeaturesHooks: true,
  });
  measured.receipts.commandRenderIsDeterministic = S0_EVENTS.every((eventName) => (
    renderHookCommand({
      runtime: { path: nodePath, kind: 'system-runtime' },
      artifacts: [{ path: recorderPath, kind: 'shipped-artifact' }],
      argv: [eventName, laneA.captureDir],
    }, attestedPaths) === laneA.commandByEvent[eventName]
  )) && reRendered.commandByEvent.stop !== laneA.commandByEvent.stop;

  measured.e2ParamForms = await measureParamForms(laneA, binary, guardLaunch);
  unmeasured.delete('E2');

  const untrusted = await listHookInventory(laneA, binary, guardLaunch, 'untrusted');
  measured.metadata = {
    untrustedInventory: untrusted.projected,
    untrustedInventoryTrustable: untrusted.trustable,
  };
  measured.e1UserLayer = {
    hooksPresentNoTrust: await readConfigLayers(laneA, binary, guardLaunch),
  };

  // Fails closed here, before any turn: an inventory that is not an exact
  // match for the expected manifest yields nothing to render.
  const trustState = trustStateFromInventory(untrusted);
  const untrustedConfigSha256 = laneA.configSha256;
  laneA = provision({
    laneRoot: laneARoot, withHooks: true, withFeaturesHooks: true, trustState,
  });
  const trusted = await listHookInventory(laneA, binary, guardLaunch, 'trusted');
  const trustedAgain = await listHookInventory(laneA, binary, guardLaunch, 'trusted');
  measured.metadata.trustedInventory = trusted.projected;
  measured.metadata.trustedInventoryTrustable = trusted.trustable;
  measured.metadata.currentHashStableAcrossSessions =
    trusted.trust.length === trustedAgain.trust.length
    && trusted.trust.every((entry, index) => (
      entry.currentHash === trustedAgain.trust[index]?.currentHash
      && entry.key === trustedAgain.trust[index]?.key
    ));
  unmeasured.delete('metadata-shape');

  measured.e5KeyDerivation = Object.fromEntries(S0_EVENTS.map((eventName) => {
    const entry = trusted.projected.find((item) => item.eventName === eventName);
    return [eventName, {
      matchesTemplate: entry?.keyMatchesTemplate === true,
      snakeTokenMatches: entry?.keySnakeTokenMatches === true,
      indexI: entry?.keyIndexI ?? null,
      indexJ: entry?.keyIndexJ ?? null,
    }];
  }));
  unmeasured.delete('E5');

  measured.e1UserLayer.trusted = await readConfigLayers(laneA, binary, guardLaunch);
  const trustedLayerAgain = await readConfigLayers(laneA, binary, guardLaunch);
  measured.e1UserLayer.userLayerDigestStableAcrossSessions =
    measured.e1UserLayer.trusted.userLayerDigest != null
    && measured.e1UserLayer.trusted.userLayerDigest === trustedLayerAgain.userLayerDigest;
  unmeasured.delete('E1');

  measured.stability = {
    configDigestChangedByTrustRender: laneA.configSha256 !== untrustedConfigSha256,
  };

  // --- Lane A turn: ordering, execution, fire-time re-validation ------------
  const hooksBeforeTurn = fileDigest(laneA.hooksPath);
  const configBeforeTurn = fileDigest(laneA.configPath);
  const laneASession = await withProductionSession(
    { binary, lane: laneA, model: MOCK_MODEL, guard: guardLaunch },
    async (handle) => {
      const firstTurn = await handle.runTurn(handle.threadId);
      const firstTurnCaptures = readS0Captures(laneA.captureA);
      // Sampled before the deliberate mutation below, so the stability claim
      // is about what a turn does to the files, not what this lane does.
      const hooksAfterFirstTurn = fileDigest(laneA.hooksPath);
      const configAfterFirstTurn = fileDigest(laneA.configPath);
      // Mutate the manifest so every hook now writes to a second capture
      // directory. Whether the mutated command runs, the pre-mutation command
      // runs, or nothing runs is what separates fire-time re-validation from
      // list-time re-validation.
      const mutatedCommands = Object.fromEntries(S0_EVENTS.map((eventName) => [
        eventName,
        renderHookCommand({
          runtime: { path: nodePath, kind: 'system-runtime' },
          artifacts: [{ path: recorderPath, kind: 'shipped-artifact' }],
          argv: [eventName, laneA.captureB],
        }, attestedPaths),
      ]));
      writeFileSync(laneA.hooksPath, `${JSON.stringify({
        hooks: Object.fromEntries(S0_EVENTS.map((eventName) => [
          S0_CONFIG_KEYS[eventName],
          [{ hooks: [{ type: 'command', command: mutatedCommands[eventName] }] }],
        ])),
      }, null, 2)}\n`, { mode: 0o600 });
      let secondTurn = null;
      try {
        secondTurn = await handle.runTurn(handle.threadId);
      } catch {
        secondTurn = null;
      }
      return {
        firstTurn,
        firstTurnCaptures,
        secondTurn,
        hooksAfterFirstTurn,
        configAfterFirstTurn,
      };
    },
  );
  if (laneASession.error) throw laneASession.error;
  const {
    firstTurn,
    firstTurnCaptures,
    secondTurn,
    hooksAfterFirstTurn,
    configAfterFirstTurn,
  } = laneASession.value;
  const authoritativeDigest = firstTurn.responseId == null
    ? null
    : createHash('sha256').update(String(firstTurn.responseId)).digest('hex');
  measured.turn = {
    hooksOn: laneASession.outcome,
    // The first turn's own record, not the lane outcome the second turn
    // overwrites.
    firstTurn: {
      status: firstTurn.status,
      assistantItemObserved: firstTurn.assistantItemObserved,
      identityConsistent: firstTurn.identityConsistent,
    },
    captures: summarizeCaptures(firstTurnCaptures, authoritativeDigest),
  };
  measured.turnIdentity = projectTurnIdentity(
    firstTurn, firstTurnCaptures, authoritativeDigest,
  );
  // Every reading below belongs to the first turn's own record, so an ordering
  // can never be assembled from two different turns' events.
  measured.e7Ordering = deriveOrdering({
    threadStartResponseMs: firstTurn.threadStartResponseMs,
    turnStartResponseMs: firstTurn.responseAtMs,
    turnStartedNotificationMs: firstTurn.startedAtMs,
    turnCompletedNotificationMs: firstTurn.completedAtMs,
  }, firstTurnCaptures);
  unmeasured.delete('E7');
  // Both digests are sampled before and immediately after the turn, and the
  // claim only counts if the turn actually fired hooks.
  measured.stability.configDigestUnchangedAcrossTurn =
    firstTurnCaptures.length > 0 && configAfterFirstTurn === configBeforeTurn;
  measured.stability.hooksManifestDigestUnchangedAcrossTurn =
    firstTurnCaptures.length > 0 && hooksAfterFirstTurn === hooksBeforeTurn;
  unmeasured.delete('turn-stability');

  const oldPathAfterMutation = readS0Captures(laneA.captureA).length;
  const newPathAfterMutation = readS0Captures(laneA.captureB).length;
  const sameSessionOld = Math.max(oldPathAfterMutation - firstTurnCaptures.length, 0);
  const newSessionInventory = await listHookInventory(
    laneA, binary, guardLaunch, 'modified',
  );
  const newSessionTurn = await withProductionSession(
    { binary, lane: laneA, model: MOCK_MODEL, guard: guardLaunch },
    async (handle) => handle.runTurn(handle.threadId),
  );
  const newSessionOld = readS0Captures(laneA.captureA).length - oldPathAfterMutation;
  const newSessionNew = readS0Captures(laneA.captureB).length - newPathAfterMutation;
  measured.e6FireTime = {
    firstTurnCaptureCount: firstTurnCaptures.length,
    sameSessionAfterMutationOldPathCount: sameSessionOld,
    sameSessionAfterMutationNewPathCount: newPathAfterMutation,
    // Judged on its own record, not on having failed to throw.
    sameSessionSecondTurn: {
      status: secondTurn?.status ?? null,
      assistantItemObserved: secondTurn?.assistantItemObserved === true,
      identityConsistent: secondTurn?.identityConsistent === true,
    },
    // Which copy of the manifest a same-session hook actually executes is the
    // whole question: the on-disk bytes at fire time, the bytes fixed when the
    // thread started, or nothing at all. The boundary experiment below locates
    // that fixing point at thread/start, which is what the term names.
    sameSessionContentSource: newPathAfterMutation > 0
      ? 'on-disk-at-fire-time'
      : (sameSessionOld > 0 ? 'thread-start-snapshot' : 'refused'),
    revalidatesAtFireTime: newPathAfterMutation > 0 || sameSessionOld > 0 ? false : true,
    newSessionTrustStatusAfterMutation: [
      ...new Set(newSessionInventory.projected.map((entry) => entry.trustStatus)),
    ],
    newSessionOldPathCaptureCount: Math.max(newSessionOld, 0),
    newSessionNewPathCaptureCount: Math.max(newSessionNew, 0),
    // The manifest was rewritten to a second capture directory, so a matching
    // command here would mean the mutation never took effect.
    newSessionInventoryExact: inventoryIsExactSet(
      newSessionInventory.projected, 'modified', { expectCommandMatch: false },
    ),
    newSessionTurnCompleted: sessionLaneIsHealthy(
      newSessionTurn, newSessionTurn.turns[0] ?? null,
    ) || (newSessionTurn.error === null && newSessionTurn.turns[0]?.status === 'completed'),
    ...(await locateSnapshotBoundary({
      binary, probeRoot, provision, guardLaunch,
    })),
  };
  unmeasured.delete('E6');

  // --- Lane B: identical, without the hooks feature flag --------------------
  const laneBRoot = path.join(probeRoot, 'features-off');
  let laneB = provision({
    laneRoot: laneBRoot, withHooks: true, withFeaturesHooks: false,
  });
  const laneBUntrusted = await listHookInventory(laneB, binary, guardLaunch, 'untrusted');
  let laneBTrusted = { projected: [], trust: [], trustable: false };
  if (laneBUntrusted.trustable) {
    laneB = provision({
      laneRoot: laneBRoot,
      withHooks: true,
      withFeaturesHooks: false,
      trustState: Object.fromEntries(
        laneBUntrusted.trust.map((entry) => [entry.key, entry.currentHash]),
      ),
    });
    laneBTrusted = await listHookInventory(laneB, binary, guardLaunch, 'trusted');
  }
  const laneBTurn = await withProductionSession(
    { binary, lane: laneB, model: MOCK_MODEL, guard: guardLaunch },
    async (handle) => handle.runTurn(handle.threadId),
  );
  const laneBCaptures = readS0Captures(laneB.captureA);
  const withFlagFired = new Set(
    firstTurnCaptures.map((record) => record.eventName).filter(Boolean),
  ).size;
  const withoutFlagFired = new Set(
    laneBCaptures.map((record) => record.eventName).filter(Boolean),
  ).size;
  measured.e4FeatureFlag = {
    withFlag: {
      hookCountListed: untrusted.projected.length,
      allTrustedAfterRender: trusted.projected.length > 0
        && trusted.projected.every((entry) => entry.trustStatus === 'trusted' && entry.enabled),
      firedEventCount: withFlagFired,
    },
    withoutFlag: {
      hookCountListed: laneBUntrusted.projected.length,
      allTrustedAfterRender: laneBTrusted.projected.length > 0
        && laneBTrusted.projected.every(
          (entry) => entry.trustStatus === 'trusted' && entry.enabled,
        ),
      firedEventCount: withoutFlagFired,
    },
    requiredForDiscovery: laneBUntrusted.projected.length === 0
      && untrusted.projected.length > 0,
    requiredForExecution: withoutFlagFired === 0 && withFlagFired > 0,
  };
  if (laneBTurn.error || laneBTurn.outcome.faultCategory !== 'none') {
    // A lane that did not complete cleanly cannot answer whether the flag is
    // required for execution; reporting a value here would invent one.
    measured.e4FeatureFlag.requiredForExecution = null;
  }
  // The fresh session deliberately runs with a `modified` manifest, so no hook
  // fires and no assistant-bearing hook capture exists — but the turn itself
  // must still be clean for its result to mean anything.
  measured.auxiliaryLanes = {
    newSessionLaneHealthy: sessionLaneIsHealthy(
      newSessionTurn, newSessionTurn.turns[0] ?? null,
    ),
    featureFlagLaneHealthy: sessionLaneIsHealthy(laneBTurn, laneBTurn.turns[0] ?? null),
    boundaryLanesHealthy: measured.e6FireTime.boundaryLanesHealthy === true,
  };
  unmeasured.delete('E4');

  measured.credentialFree = {
    authFileAbsent: !existsSync(path.join(laneA.codexHome, 'auth.json'))
      && !existsSync(path.join(laneB.codexHome, 'auth.json')),
    providerRequiresAuth: readRequiresOpenAiAuth(readFileSync(laneA.configPath, 'utf8')),
    isolatedHomeMode0700: (lstatSync(laneA.codexHome).mode & 0o777) === 0o700
      && (lstatSync(laneB.codexHome).mode & 0o777) === 0o700,
  };

  measured.receipts.appServerLaunchesIntended = launchesIntended;
  measured.receipts.appServerLaunchesAttested = launchesAttested;
  measured.cleanup = {
    strayProcessCount: countStrayProcesses(probeRoot),
    probeRootRemoved: false,
  };
  measured.unmeasured = [...unmeasured];
  return measured;
}

export async function characterizeHookTrust(options) {
  const attestBinary = options.attestBinary
    ?? ((binary) => attestPinnedCodexBinary(binary, resolveCodexTargetPin()));
  const startProvider = options.startProvider ?? startLoopbackProvider;
  const targetReceipt = options.attestBinary ? null : resolveCodexTargetPin();
  const runLanes = options.runLanes ?? runS0Lanes;
  let probeRoot = null;
  let providerCleanupFailed = false;
  try {
    const attestation = await attestBinary(options.binary);
    const binary = attestation.path;
    probeRoot = path.join(realpathSync(options.probeRoot), `u23-hook-trust-${randomUUID()}`);
    mkdirSync(probeRoot, { recursive: true, mode: 0o700 });
    chmodSync(probeRoot, 0o700);
    let provider = null;
    let measured;
    try {
      provider = await startProvider();
      measured = await runLanes({
        binary, attestation, targetReceipt, probeRoot, provider,
        runtime: options.runtime,
      });
    } finally {
      if (provider) {
        providerCleanupFailed = await Promise.race([
          provider.close().then(() => false, () => true),
          wait(PROVIDER_CLOSE_TIMEOUT_MS).then(() => true),
        ]);
      }
    }
    if (providerCleanupFailed) {
      return s0StopEnvelope(s0Failure('cleanup', 'provider-close'));
    }
    rmSync(probeRoot, { recursive: true, force: true });
    measured.cleanup = {
      ...(measured.cleanup ?? {}),
      probeRootRemoved: !existsSync(probeRoot),
    };
    probeRoot = null;
    return buildS0Envelope(measured);
  } catch (error) {
    return s0StopEnvelope(error);
  } finally {
    if (probeRoot) rmSync(probeRoot, { recursive: true, force: true });
  }
}

export function parseS0Args(argv, execPath = process.execPath) {
  const options = {
    binary: process.env.POLYGRAM_CODEX_BIN ?? '',
    probeRoot: process.env.ORCHESTRA_CODEX_HOOK_PROBE_ROOT ?? '',
    runtime: process.env.ORCHESTRA_CODEX_HOOK_RUNTIME ?? execPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = argv[++index] ?? '';
    else if (arg === '--probe-root') options.probeRoot = argv[++index] ?? '';
    else if (arg === '--runtime') options.runtime = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['binary', 'probeRoot', 'runtime']) {
    if (!options[key]) throw new Error(`missing required characterization option: ${key}`);
  }
  return options;
}

async function main() {
  let result;
  try {
    result = await characterizeHookTrust(parseS0Args(process.argv.slice(2)));
  } catch (error) {
    process.stdout.write(`${JSON.stringify(s0StopEnvelope(error), null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.gate === 'CONTINUE' ? 0 : 1;
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
