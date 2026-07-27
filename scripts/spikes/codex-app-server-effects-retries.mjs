#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  AppServerConnection,
  characterizeThreadProfile,
  exactActiveProfile,
  initializeConnection,
  sanitizedAppServerEnv,
  validateDaemonSecretRoots,
} from './codex-app-server-real.mjs';

const MOCK_MODEL = 'mock-model';
const RETRY_TERMINAL_TIMEOUT_MS = 20_000;
const EFFECT_BOUNDARY_TIMEOUT_MS = 20_000;
const PINNED_VERSION = 'codex-cli 0.145.0';
const PINNED_BINARY_SHA256 = '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590';

function assertPinnedBinary(binary) {
  if (realpathSync(binary) !== binary || !statSync(binary).isFile()) {
    throw new Error('U1b binary must be a canonical regular file');
  }
  const hash = createHash('sha256').update(readFileSync(binary)).digest('hex');
  if (hash !== PINNED_BINARY_SHA256) throw new Error('U1b binary hash mismatch');
  const version = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (version.status !== 0 || version.stdout.trim() !== PINNED_VERSION) {
    throw new Error('U1b binary version mismatch');
  }
}

export function evaluateRetryTrace({
  expectedAttempts,
  providerAttempts,
  turnStartRequests,
  notifications,
  expectedTerminal,
}) {
  if (turnStartRequests !== 1) {
    throw new Error('retry trace requires exactly one client turn/start');
  }
  if (providerAttempts !== expectedAttempts) {
    throw new Error('provider attempt count did not prove retry ownership');
  }
  const terminalIndexes = [];
  const retrySignals = [];
  let firstTerminalIndex = null;
  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];
    if (notification.method === 'turn/completed') {
      terminalIndexes.push(index);
      firstTerminalIndex ??= index;
    }
    if (notification.method === 'error') {
      if (firstTerminalIndex !== null) {
        throw new Error('retry signal followed the terminal');
      }
      if (typeof notification.willRetry !== 'boolean') {
        throw new Error('retry trace omitted willRetry');
      }
      retrySignals.push(notification.willRetry);
    }
  }
  if (terminalIndexes.length !== 1) {
    throw new Error('retry trace requires exactly one terminal');
  }
  if (terminalIndexes[0] !== notifications.length - 1) {
    throw new Error('retry trace contained an event after terminal');
  }
  const terminalStatus = notifications[terminalIndexes[0]].status;
  if (terminalStatus !== expectedTerminal) {
    throw new Error('retry trace reached an unexpected terminal');
  }
  if (expectedAttempts > 1 && !retrySignals.includes(true)) {
    throw new Error('provider retry occurred without an intermediate retry signal');
  }
  if (
    terminalStatus === 'failed'
    && retrySignals.at(-1) !== false
  ) {
    throw new Error('failed retry trace omitted the final non-retryable error');
  }
  if (
    terminalStatus === 'completed'
    && retrySignals.some((willRetry) => !willRetry)
  ) {
    throw new Error('successful retry trace included a final error');
  }
  return {
    gate: 'CONTINUE',
    providerAttempts,
    retrySignals,
    terminalStatus,
  };
}

export function classifyEffectWindow({
  requestWriteAttempted,
  markerPresent,
  clientObservedTerminal,
}) {
  if (!requestWriteAttempted) {
    return {
      effect: 'not-sent',
      replayAllowed: true,
      markerProvesEffect: false,
      resumeIsReplayTruth: false,
    };
  }
  return {
    effect: markerPresent ? 'occurred' : 'unknown',
    replayAllowed: false,
    markerProvesEffect: Boolean(markerPresent),
    resumeIsReplayTruth: false,
  };
}

export function parseOwnedProcessId(value) {
  if (typeof value !== 'string' || !/^[0-9]+\s*$/.test(value)) {
    throw new Error('owned process ID was malformed');
  }
  const pid = Number(value.trim());
  if (!Number.isSafeInteger(pid) || pid < 2) {
    throw new Error('owned process ID was outside the safe range');
  }
  return pid;
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function completedResponse(id) {
  return [
    sseEvent('response.created', {
      type: 'response.created',
      response: { id },
    }),
    sseEvent('response.completed', {
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    }),
  ].join('');
}

function effectToolResponse(command) {
  return [
    sseEvent('response.created', {
      type: 'response.created',
      response: { id: 'resp-effect-tool' },
    }),
    sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call-effect-1',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: command,
          yield_time_ms: 10_000,
        }),
      },
    }),
    sseEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp-effect-tool',
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    }),
  ].join('');
}

function effectFinalResponse() {
  return [
    sseEvent('response.created', {
      type: 'response.created',
      response: { id: 'resp-effect-final' },
    }),
    sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: 'msg-effect-final',
        content: [{ type: 'output_text', text: 'done' }],
      },
    }),
    sseEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp-effect-final',
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    }),
  ].join('');
}

function sendJsonError(response, status, type) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    error: {
      type,
      message: 'synthetic U1b provider error',
    },
  }));
}

function sendCompleted(response, id) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(completedResponse(id));
}

async function createScriptedProvider(record = () => {}) {
  let scenario = null;
  let effectCommand = null;
  const attemptCounts = new Map();
  const advertisedTools = new Map();
  const requestInputTypes = new Map();
  const toolOutputCategories = new Map();
  const server = createServer((request, response) => {
    let body = '';
    let bodyExceededLimit = false;
    request.on('data', (chunk) => {
      if (bodyExceededLimit) return;
      body += chunk.toString();
      if (Buffer.byteLength(body) > 1024 * 1024) {
        bodyExceededLimit = true;
        body = '';
      }
    });
    request.on('end', () => {
      if (bodyExceededLimit) {
        response.writeHead(413);
        response.end();
        return;
      }
      const pathname = new URL(
        request.url ?? '/',
        'http://127.0.0.1',
      ).pathname;
      if (request.method === 'GET' && pathname === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"models":[]}');
        return;
      }
      if (request.method !== 'POST' || pathname !== '/v1/responses' || !scenario) {
        response.writeHead(404);
        response.end();
        return;
      }
      const attempt = (attemptCounts.get(scenario) ?? 0) + 1;
      attemptCounts.set(scenario, attempt);
      record({ type: 'provider-attempt', scenario, attempt });
      try {
        const parsed = JSON.parse(body);
        advertisedTools.set(
          scenario,
          (parsed.tools ?? [])
            .map((tool) => tool?.name)
            .filter((name) => typeof name === 'string'),
        );
        const previousTypes = requestInputTypes.get(scenario) ?? [];
        previousTypes.push((parsed.input ?? []).map((item) => item?.type ?? 'unknown'));
        requestInputTypes.set(scenario, previousTypes);
        const outputs = (parsed.input ?? [])
          .filter((item) => item?.type === 'function_call_output')
          .map((item) => String(item.output ?? ''));
        const categoryFlags = {
          permission: outputs.some((value) => /permission|denied|not permitted|approval/i.test(value)),
          invalid: outputs.some((value) => /invalid|parse|missing|unknown/i.test(value)),
          notFound: outputs.some((value) => /no such|not found/i.test(value)),
          timeout: outputs.some((value) => /timed out|timeout/i.test(value)),
          sandbox: outputs.some((value) => /sandbox/i.test(value)),
          outputCount: outputs.length,
        };
        toolOutputCategories.set(scenario, categoryFlags);
      } catch {
        advertisedTools.set(scenario, []);
      }
      body = '';
      if (scenario.startsWith('effect-')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          attempt === 1
            ? effectToolResponse(effectCommand)
            : effectFinalResponse(),
        );
      } else if (scenario === 'missing-terminal') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(sseEvent('response.created', {
          type: 'response.created',
          response: { id: 'resp-missing-terminal' },
        }));
        const keepalive = setInterval(() => response.write(': keepalive\n\n'), 100);
        response.on('close', () => clearInterval(keepalive));
      } else if (scenario === 'retryable-success' && attempt === 2) {
        sendCompleted(response, 'resp-retry-success');
      } else if (
        scenario === 'retryable-success'
        || scenario === 'retryable-exhausted'
      ) {
        sendJsonError(response, 500, 'server_error');
      } else if (scenario === 'non-retryable') {
        sendJsonError(response, 400, 'invalid_request_error');
      } else {
        response.writeHead(500);
        response.end();
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    port: server.address().port,
    select(nextScenario, options = {}) {
      scenario = nextScenario;
      effectCommand = options.effectCommand ?? null;
      attemptCounts.set(nextScenario, 0);
    },
    attempts(selectedScenario) {
      return attemptCounts.get(selectedScenario) ?? 0;
    },
    tools(selectedScenario) {
      return advertisedTools.get(selectedScenario) ?? [];
    },
    inputTypes(selectedScenario) {
      return requestInputTypes.get(selectedScenario) ?? [];
    },
    toolOutputCategory(selectedScenario) {
      return toolOutputCategories.get(selectedScenario) ?? {};
    },
    async close() {
      await new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    },
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function createSyntheticRuntime(options, providerPort, streamMaxRetries = 1) {
  const parent = dirname(realpathSync(options.codexHome));
  const codexHome = realpathSync(mkdtempSync(join(parent, 'codex-u1b-retry-')));
  chmodSync(codexHome, 0o700);
  const workspace = realpathSync(options.workspace);
  const commandHome = join(workspace, `.u1b-command-home-${randomUUID()}`);
  const commandTmp = join(workspace, `.u1b-command-tmp-${randomUUID()}`);
  mkdirSync(commandHome, { mode: 0o700 });
  mkdirSync(commandTmp, { mode: 0o700 });
  const config = [
    `model = ${tomlString(MOCK_MODEL)}`,
    'model_provider = "u1b_loopback"',
    'cli_auth_credentials_store = "file"',
    'default_permissions = "polygram-session"',
    'approval_policy = "never"',
    'approvals_reviewer = "user"',
    'web_search = "disabled"',
    'allow_login_shell = false',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'ignore_default_excludes = false',
    '',
    '[shell_environment_policy.set]',
    `HOME = ${tomlString(commandHome)}`,
    `TMPDIR = ${tomlString(commandTmp)}`,
    'PATH = "/usr/bin:/bin"',
    '',
    '[permissions.polygram-session.filesystem]',
    '":minimal" = "read"',
    `${tomlString(codexHome)} = "deny"`,
    ...options.daemonSecretRoots.map(
      (root) => `${tomlString(realpathSync(root))} = "deny"`,
    ),
    '":workspace_roots" = { "." = "write" }',
    '',
    '[permissions.polygram-session.network]',
    'enabled = false',
    '',
    `[projects.${tomlString(workspace)}]`,
    'trust_level = "untrusted"',
    '',
    '[features]',
    'unified_exec = true',
    '',
    '[model_providers.u1b_loopback]',
    'name = "U1B loopback Responses"',
    `base_url = "http://127.0.0.1:${providerPort}/v1"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    `stream_max_retries = ${streamMaxRetries}`,
    'stream_idle_timeout_ms = 2000',
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
  ].join('\n');
  writeFileSync(join(codexHome, 'config.toml'), config, { mode: 0o600 });
  const filesystem = {
    ':minimal': 'read',
    [codexHome]: 'deny',
    ...Object.fromEntries(
      options.daemonSecretRoots.map((root) => [realpathSync(root), 'deny']),
    ),
    ':workspace_roots': { '.': 'write' },
  };
  const expectedUserConfig = {
    model: MOCK_MODEL,
    model_provider: 'u1b_loopback',
    cli_auth_credentials_store: 'file',
    default_permissions: 'polygram-session',
    approval_policy: 'never',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    shell_environment_policy: {
      inherit: 'none',
      ignore_default_excludes: false,
      set: {
        HOME: commandHome,
        TMPDIR: commandTmp,
        PATH: '/usr/bin:/bin',
      },
    },
    permissions: {
      'polygram-session': {
        filesystem,
        network: { enabled: false },
      },
    },
    projects: {
      [workspace]: { trust_level: 'untrusted' },
    },
    features: { unified_exec: true },
    model_providers: {
      u1b_loopback: {
        name: 'U1B loopback Responses',
        base_url: `http://127.0.0.1:${providerPort}/v1`,
        wire_api: 'responses',
        request_max_retries: 0,
        stream_max_retries: streamMaxRetries,
        stream_idle_timeout_ms: 2000,
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
  };
  return {
    options: { ...options, codexHome, workspace },
    providerPort,
    streamMaxRetries,
    expectedUserConfig,
    cleanup() {
      rmSync(commandHome, { recursive: true, force: true });
      rmSync(commandTmp, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    },
  };
}

async function attestSyntheticRuntime(connection, runtime) {
  const result = await connection.request('config/read', {
    cwd: runtime.options.workspace,
    includeLayers: true,
  });
  const userLayers = (result.layers ?? []).filter(
    (layer) => layer?.name?.type === 'user',
  );
  const otherNonEmptyLayers = (result.layers ?? []).filter(
    (layer) => (
      layer?.name?.type !== 'user'
      && JSON.stringify(layer?.config ?? {}) !== '{}'
    ),
  );
  const config = result.config ?? {};
  const provider = config.model_providers?.u1b_loopback;
  const profile = config.permissions?.['polygram-session'];
  if (
    userLayers.length !== 1
    || !isDeepStrictEqual(userLayers[0]?.config, runtime.expectedUserConfig)
    || otherNonEmptyLayers.length !== 0
    || config.model !== MOCK_MODEL
    || config.model_provider !== 'u1b_loopback'
    || config.default_permissions !== 'polygram-session'
    || config.approval_policy !== 'never'
    || config.web_search !== 'disabled'
    || config.allow_login_shell !== false
    || config.shell_environment_policy?.inherit !== 'none'
    || profile?.network?.enabled !== false
    || profile?.filesystem?.[':minimal'] !== 'read'
    || profile?.filesystem?.[runtime.options.codexHome] !== 'deny'
    || provider?.base_url !== `http://127.0.0.1:${runtime.providerPort}/v1`
    || provider?.request_max_retries !== 0
    || provider?.stream_max_retries !== runtime.streamMaxRetries
    || provider?.requires_openai_auth !== false
    || provider?.supports_websockets !== false
    || Object.keys(config.mcp_servers ?? {}).length !== 0
    || Object.keys(config.plugins ?? {}).length !== 0
  ) {
    throw new Error('synthetic U1b runtime config attestation failed');
  }
  for (const root of runtime.options.daemonSecretRoots) {
    if (profile.filesystem?.[root] !== 'deny') {
      throw new Error('synthetic U1b runtime omitted a daemon-secret deny');
    }
  }
}

function shellQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('effect command path was invalid');
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function createEffectFixture(runtime, boundary, lossType) {
  const root = realpathSync(mkdtempSync(
    join(runtime.options.workspace, '.codex-u1b-effect-'),
  ));
  chmodSync(root, 0o700);
  const paths = Object.fromEntries([
    'ack',
    'boundary',
    'cleanup',
    'cleanupSuccess',
    'cut',
    'marker',
    'release',
    'supervisorRelease',
    'childPid',
  ].map((name) => [name, join(root, name)]));
  const scenarioHash = randomUUID();
  const helper = join(root, 'effect-helper.py');
  const proxy = join(root, 'cut-proxy.mjs');
  const supervisor = join(root, 'app-server-supervisor.mjs');
  writeFileSync(helper, [
    'import argparse',
    'import os',
    'import time',
    'parser = argparse.ArgumentParser()',
    "parser.add_argument('--marker', required=True)",
    "parser.add_argument('--release', required=True)",
    "parser.add_argument('--scenario', required=True)",
    'args = parser.parse_args()',
    'descriptor = os.open(args.marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
    "os.write(descriptor, args.scenario.encode('utf-8'))",
    'os.fsync(descriptor)',
    'os.close(descriptor)',
    "print('U1B_FIRST_OUTPUT', flush=True)",
    'deadline = time.monotonic() + 10',
    'while not os.path.exists(args.release) and time.monotonic() < deadline:',
    '    time.sleep(0.025)',
    'if not os.path.exists(args.release):',
    '    raise SystemExit(42)',
    '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(supervisor, [
    `#!${process.execPath}`,
    "import { existsSync, renameSync, writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    `const paths = ${JSON.stringify(paths)};`,
    'const [binary, ...args] = process.argv.slice(2);',
    "const child = spawn(binary, args, {",
    '  cwd: process.cwd(),',
    '  env: process.env,',
    "  stdio: ['pipe', 'pipe', 'pipe'],",
    '});',
    "writeFileSync(`${paths.childPid}.tmp`, `${child.pid}\\n`, { mode: 0o600 });",
    "renameSync(`${paths.childPid}.tmp`, paths.childPid);",
    'process.stdin.pipe(child.stdin);',
    'child.stdout.pipe(process.stdout);',
    'child.stderr.pipe(process.stderr);',
    "process.on('SIGTERM', () => {});",
    'let childExited = false;',
    "child.on('exit', () => { childExited = true; });",
    'const releaseTimer = setInterval(() => {',
    '  if (!childExited || !existsSync(paths.supervisorRelease)) return;',
    '  clearInterval(releaseTimer);',
    '  process.exit(0);',
    '}, 20);',
    '',
  ].join('\n'), { mode: 0o700 });
  writeFileSync(proxy, [
    `#!${process.execPath}`,
    "import { existsSync, renameSync, writeFileSync } from 'node:fs';",
    "import { spawn, spawnSync } from 'node:child_process';",
    `const boundary = ${JSON.stringify(boundary)};`,
    `const lossType = ${JSON.stringify(lossType)};`,
    `const paths = ${JSON.stringify(paths)};`,
    `const supervisor = ${JSON.stringify(supervisor)};`,
    'const [binary, ...args] = process.argv.slice(2);',
    "const child = spawn(supervisor, [binary, ...args], {",
    '  cwd: process.cwd(),',
    '  env: process.env,',
    '  detached: true,',
    "  stdio: ['pipe', 'pipe', 'pipe'],",
    '});',
    'process.stdin.pipe(child.stdin);',
    "child.stderr.on('data', () => {});",
    "if (lossType === 'transport') process.on('SIGTERM', () => {});",
    'let buffer = "";',
    'let armed = false;',
    'let dropping = false;',
    'let cutPerformed = false;',
    'let cleanupStarted = false;',
    'let cleanupComplete = false;',
    'let cleanupFailed = false;',
    'function signalOwnedGroupOnce(signal) {',
    "  if (child.exitCode !== null || child.signalCode !== null) throw new Error('owned supervisor exited before cleanup signal');",
    '  try { process.kill(-child.pid, signal); } catch (error) {',
    "    throw new Error(`owned supervisor group signal failed: ${error.code ?? 'unknown'}`);",
    '  }',
    '}',
    'function processGroupMembers() {',
    "  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 1_000 });",
    "  if (result.status !== 0) throw new Error('could not inspect owned supervisor group');",
    "  return result.stdout.split('\\n').map((line) => line.trim().split(/\\s+/).map(Number)).filter(([pid, pgid]) => Number.isSafeInteger(pid) && pgid === child.pid).map(([pid]) => pid);",
    '  }',
    'function finishCleanup() {',
    '  cleanupComplete = true;',
    "  writeFileSync(paths.supervisorRelease, '', { mode: 0o600 });",
    '  }',
    'function failCleanup() {',
    '  cleanupFailed = true;',
    "  signalOwnedGroupOnce('SIGKILL');",
    '  }',
    'function beginCleanup() {',
    '  if (cleanupStarted) return;',
    '  cleanupStarted = true;',
    "  signalOwnedGroupOnce('SIGTERM');",
    '  const startedAt = Date.now();',
    '  const timer = setInterval(() => {',
    '    const members = processGroupMembers();',
    "    if (members.length === 1 && members[0] === child.pid) { clearInterval(timer); finishCleanup(); return; }",
    '    if (Date.now() - startedAt >= 5_000) { clearInterval(timer); failCleanup(); }',
    '  }, 20);',
    '}',
    'function matches(message) {',
    "  if (boundary === 'item-start') return message.method === 'item/started' && message.params?.item?.type === 'commandExecution';",
    "  if (boundary === 'first-output') return message.method === 'item/commandExecution/outputDelta' && String(message.params?.delta ?? '').includes('U1B_FIRST_OUTPUT');",
    "  return message.method === 'turn/completed';",
    '}',
    'function armCut(forwardedLine) {',
    '  if (armed) return;',
    '  armed = true;',
    '  child.stdout.pause();',
    "  writeFileSync(paths.boundary, '', { mode: 0o600 });",
    '  const timer = setInterval(() => {',
    '    if (!existsSync(paths.ack)) return;',
    '    clearInterval(timer);',
    '    cutPerformed = true;',
    "    writeFileSync(paths.cut, '', { mode: 0o600 });",
    "    if (lossType === 'app-server') {",
    '      beginCleanup();',
    '    } else {',
    '      dropping = true;',
    '      process.stdout.end();',
    '      child.stdout.resume();',
    '    }',
    '  }, 10);',
    '  timer.unref?.();',
    '  if (forwardedLine) process.stdout.write(`${forwardedLine}\\n`);',
    '}',
    'function handleLine(line) {',
    '  let message;',
    '  try { message = JSON.parse(line); } catch { process.stdout.write(`${line}\\n`); return; }',
    '  if (!matches(message)) { process.stdout.write(`${line}\\n`); return; }',
    "  armCut(boundary === 'terminal-held' ? null : line);",
    '}',
    "child.stdout.on('data', (chunk) => {",
    '  if (dropping) return;',
    '  buffer += chunk.toString();',
    '  if (Buffer.byteLength(buffer) > 1024 * 1024) { beginCleanup(); return; }',
    '  let newline;',
    '  while (!armed && (newline = buffer.indexOf("\\n")) !== -1) {',
    '    const line = buffer.slice(0, newline);',
    '    buffer = buffer.slice(newline + 1);',
    '    handleLine(line);',
    '  }',
    '});',
    'const cleanupTimer = setInterval(() => {',
    '  if (!existsSync(paths.cleanup)) return;',
    '  clearInterval(cleanupTimer);',
    '  beginCleanup();',
    '}, 20);',
    "process.on('SIGTERM', () => {",
    "  if (lossType === 'transport' && cutPerformed && !existsSync(paths.cleanup)) return;",
    '  beginCleanup();',
    '});',
    'child.on("exit", () => {',
    '  if (cleanupComplete) {',
    "    writeFileSync(paths.cleanupSuccess, '', { mode: 0o600 });",
    '    process.stdout.end();',
    '    process.exit(0);',
    '  }',
    '  process.exit(cleanupFailed ? 2 : 3);',
    '});',
    '',
  ].join('\n'), { mode: 0o700 });
  const command = [
    '/usr/bin/python3',
    shellQuote(helper),
    '--marker',
    shellQuote(paths.marker),
    '--release',
    shellQuote(paths.release),
    '--scenario',
    shellQuote(scenarioHash),
  ].join(' ');
  return {
    root,
    paths,
    proxy,
    command,
    scenarioHash,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitForFile(path, label) {
  const deadline = Date.now() + EFFECT_BOUNDARY_TIMEOUT_MS;
  while (!existsSync(path) && Date.now() < deadline) await delay(20);
  if (!existsSync(path)) throw new Error(`${label} timed out`);
}

async function waitForPidGone(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  throw new Error('owned effect process survived cleanup');
}

async function resumeEffectThread(runtime, threadId, turnId) {
  let connection;
  try {
    connection = new AppServerConnection(
      { ...runtime.options, launcher: '' },
      sanitizedAppServerEnv(runtime.options),
    );
    await initializeConnection(connection, runtime.options.codexHome);
    await attestSyntheticRuntime(connection, runtime);
    const result = await connection.request('thread/resume', { threadId });
    const settings = await connection.waitForNotification(
      (message) => (
        message.method === 'thread/settings/updated'
        && message.params?.threadId === threadId
      ),
    );
    if (
      !exactActiveProfile(result.activePermissionProfile)
      && !exactActiveProfile(
        settings?.params?.threadSettings?.activePermissionProfile,
      )
    ) {
      throw new Error('effect resume omitted exact permission-profile provenance');
    }
    const turn = result.thread?.turns?.find((candidate) => candidate.id === turnId);
    const status = turn?.status ?? 'absent';
    return ['completed', 'failed', 'interrupted', 'inProgress', 'absent'].includes(status)
      ? status
      : 'other';
  } finally {
    await connection?.close();
  }
}

async function runEffectScenario(runtime, provider, boundary, lossType) {
  const fixture = createEffectFixture(runtime, boundary, lossType);
  let connection;
  let appServerPid = null;
  try {
    provider.select(`effect-${boundary}-${lossType}`, {
      effectCommand: fixture.command,
    });
    connection = new AppServerConnection(
      { ...runtime.options, launcher: fixture.proxy },
      sanitizedAppServerEnv(runtime.options),
    );
    await initializeConnection(connection, runtime.options.codexHome);
    await attestSyntheticRuntime(connection, runtime);
    await waitForFile(fixture.paths.childPid, 'effect app-server PID');
    const appServerPidCandidate = parseOwnedProcessId(
      readFileSync(fixture.paths.childPid, 'utf8'),
    );
    appServerPid = appServerPidCandidate;
    const profile = await characterizeThreadProfile(connection, 'thread/start', {
      cwd: runtime.options.workspace,
      model: MOCK_MODEL,
    });
    if (!profile.responseExtensionExact && !profile.settingsNotificationExact) {
      throw new Error('effect thread omitted exact permission-profile provenance');
    }
    const started = await connection.request('turn/start', {
      threadId: profile.threadId,
      input: [{ type: 'text', text: 'U1B synthetic effect-window probe.' }],
    });
    const turnId = started.turn?.id;
    if (!turnId) throw new Error('effect turn/start omitted turn id');

    if (boundary === 'item-start') {
      const observed = await connection.waitForNotification(
        (message) => (
          message.method === 'item/started'
          && message.params?.threadId === profile.threadId
          && message.params?.turnId === turnId
          && message.params?.item?.type === 'commandExecution'
        ),
        EFFECT_BOUNDARY_TIMEOUT_MS,
      );
      if (!observed) {
        throw new Error(
          `effect item-start boundary was not observed (proxy=${existsSync(fixture.paths.boundary)}, marker=${existsSync(fixture.paths.marker)}, attempts=${provider.attempts(`effect-${boundary}-${lossType}`)}, tools=${provider.tools(`effect-${boundary}-${lossType}`).join(',')}, inputs=${JSON.stringify(provider.inputTypes(`effect-${boundary}-${lossType}`))}, outputCategory=${JSON.stringify(provider.toolOutputCategory(`effect-${boundary}-${lossType}`))}, methods=${connection.notifications.map((message) => `${message.method}:${message.params?.item?.type ?? '-'}`).join(',')})`,
        );
      }
    } else if (boundary === 'first-output') {
      const observed = await connection.waitForNotification(
        (message) => (
          message.method === 'item/commandExecution/outputDelta'
          && message.params?.threadId === profile.threadId
          && message.params?.turnId === turnId
        ),
        EFFECT_BOUNDARY_TIMEOUT_MS,
      );
      if (!observed) {
        throw new Error(
          `effect first-output boundary was not observed (proxy=${existsSync(fixture.paths.boundary)}, attempts=${provider.attempts(`effect-${boundary}-${lossType}`)}, methods=${connection.notifications.map((message) => message.method).join(',')})`,
        );
      }
    } else {
      const output = await connection.waitForNotification(
        (message) => (
          message.method === 'item/commandExecution/outputDelta'
          && message.params?.threadId === profile.threadId
          && message.params?.turnId === turnId
        ),
        EFFECT_BOUNDARY_TIMEOUT_MS,
      );
      if (!output) throw new Error('terminal-held setup output was not observed');
      writeFileSync(fixture.paths.release, '', { mode: 0o600 });
      await waitForFile(fixture.paths.boundary, 'terminal-held boundary');
    }
    writeFileSync(fixture.paths.ack, '', { mode: 0o600 });
    await waitForFile(fixture.paths.cut, 'effect transport cut');
    await delay(100);

    const markerPresent = existsSync(fixture.paths.marker);
    const markerHashMatch = markerPresent
      && readFileSync(fixture.paths.marker, 'utf8') === fixture.scenarioHash;
    if (markerPresent && !markerHashMatch) {
      throw new Error('effect marker content did not match the scenario');
    }
    if (boundary !== 'item-start' && !markerHashMatch) {
      throw new Error(
        `effect ${boundary}/${lossType} boundary omitted the expected durable marker`,
      );
    }
    if (!existsSync(fixture.paths.release)) {
      writeFileSync(fixture.paths.release, '', { mode: 0o600 });
    }
    if (lossType === 'transport') await delay(1_000);
    writeFileSync(fixture.paths.cleanup, '', { mode: 0o600 });
    await waitForPidGone(appServerPid);
    await waitForPidGone(connection.child.pid);
    if (!existsSync(fixture.paths.cleanupSuccess)) {
      throw new Error('effect proxy did not prove process-group cleanup');
    }
    await connection.close();
    connection = null;

    const resumedStatus = await resumeEffectThread(
      runtime,
      profile.threadId,
      turnId,
    );
    const scenarioName = `effect-${boundary}-${lossType}`;
    const providerAttempts = provider.attempts(scenarioName);
    const inputTypes = provider.inputTypes(scenarioName);
    const expectedAttempts = boundary === 'terminal-held' ? 2 : 1;
    if (providerAttempts !== expectedAttempts || inputTypes.length !== expectedAttempts) {
      throw new Error('effect trace contained an unexpected provider replay');
    }
    if (
      inputTypes[0]?.includes('function_call_output')
      || (
        expectedAttempts === 2
        && (
          !inputTypes[1]?.includes('function_call')
          || !inputTypes[1]?.includes('function_call_output')
        )
      )
    ) {
      throw new Error('effect trace request sequence did not match one tool continuation');
    }
    return {
      gate: 'CONTINUE',
      boundary,
      lossType,
      markerPresent,
      markerHashMatch,
      resumedStatus,
      classification: classifyEffectWindow({
        requestWriteAttempted: true,
        markerPresent,
        resumedStatus,
        clientObservedTerminal: false,
      }),
      providerAttempts,
    };
  } finally {
    try {
      if (connection && !connection.closed && !existsSync(fixture.paths.cleanup)) {
        writeFileSync(fixture.paths.cleanup, '', { mode: 0o600 });
        await waitForPidGone(connection.child.pid);
      }
      if (connection && !existsSync(fixture.paths.cleanupSuccess)) {
        throw new Error('effect proxy cleanup did not complete safely');
      }
    } finally {
      await connection?.close();
      fixture.cleanup();
    }
  }
}

export async function characterizeEffects(options) {
  options = {
    ...options,
    daemonSecretRoots: validateDaemonSecretRoots(
      options.daemonSecretRoots,
      realpathSync(options.codexHome),
      realpathSync(options.workspace),
    ),
  };
  assertPinnedBinary(options.binary);
  const provider = await createScriptedProvider();
  const runtime = createSyntheticRuntime(options, provider.port, 0);
  try {
    const scenarios = [];
    for (const boundary of ['item-start', 'first-output', 'terminal-held']) {
      for (const lossType of ['transport', 'app-server']) {
        scenarios.push(await runEffectScenario(
          runtime,
          provider,
          boundary,
          lossType,
        ));
      }
    }
    return { gate: 'CONTINUE', scenarios };
  } finally {
    const cleanup = await Promise.allSettled([provider.close()]);
    runtime.cleanup();
    const rejected = cleanup.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
}

async function runRetryScenario(
  connection,
  provider,
  definition,
  workspace,
  trace,
) {
  provider.select(definition.name);
  const profile = await characterizeThreadProfile(connection, 'thread/start', {
    cwd: workspace,
    model: MOCK_MODEL,
    ephemeral: true,
  });
  if (!profile.responseExtensionExact && !profile.settingsNotificationExact) {
    throw new Error('retry thread omitted exact permission-profile provenance');
  }
  const notificationOffset = connection.notifications.length;
  const started = await connection.request('turn/start', {
    threadId: profile.threadId,
    input: [{ type: 'text', text: 'U1B synthetic provider retry probe.' }],
  });
  const turnId = started.turn?.id;
  if (!turnId) throw new Error('retry turn/start omitted turn id');
  trace.push({
    type: 'turn-start-response',
    threadId: profile.threadId,
    turnId,
  });
  const terminal = await connection.waitForNotification(
    (message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === profile.threadId
      && message.params?.turn?.id === turnId
    ),
    RETRY_TERMINAL_TIMEOUT_MS,
  );
  if (!terminal) throw new Error('retry scenario timed out before terminal');
  const notifications = connection.notifications
    .slice(notificationOffset)
    .filter((message) => (
      message.params?.threadId === profile.threadId
      && (
        (
          message.method === 'error'
          && message.params?.turnId === turnId
        )
        || (
          message.method === 'turn/completed'
          && message.params?.turn?.id === turnId
        )
      )
    ))
    .map((message) => message.method === 'error'
      ? { method: 'error', willRetry: message.params.willRetry }
      : {
        method: 'turn/completed',
        status: message.params.turn.status,
      });
  const correlatedEvents = trace.filter(
    (event) => event.type === 'error' || event.type === 'turn/completed',
  );
  if (correlatedEvents.some(
    (event) => event.threadId !== profile.threadId || event.turnId !== turnId,
  )) {
    throw new Error('retry trace contained a mismatched thread or turn ID');
  }
  const orderedKinds = trace
    .filter((event) => (
      event.type === 'provider-attempt'
      || event.type === 'error'
      || event.type === 'turn/completed'
    ))
    .map((event) => (
      event.type === 'error'
        ? `error:${event.willRetry}`
        : event.type
    ));
  const expectedKinds = definition.name === 'retryable-success'
    ? ['provider-attempt', 'error:true', 'provider-attempt', 'turn/completed']
    : definition.name === 'retryable-exhausted'
      ? [
        'provider-attempt',
        'error:true',
        'provider-attempt',
        'error:false',
        'turn/completed',
      ]
      : ['provider-attempt', 'error:false', 'turn/completed'];
  if (JSON.stringify(orderedKinds) !== JSON.stringify(expectedKinds)) {
    throw new Error('retry trace ordering differed from the pinned contract');
  }
  return {
    ...evaluateRetryTrace({
    expectedAttempts: definition.expectedAttempts,
    providerAttempts: provider.attempts(definition.name),
    turnStartRequests: trace.filter(
      (event) => event.type === 'client-write' && event.method === 'turn/start',
    ).length,
    notifications,
    expectedTerminal: definition.expectedTerminal,
    }),
    clientTurnStarts: 1,
    exactCorrelation: true,
    orderExact: true,
  };
}

async function runMissingTerminalScenario(
  connection,
  provider,
  workspace,
  trace,
) {
  provider.select('missing-terminal');
  const profile = await characterizeThreadProfile(connection, 'thread/start', {
    cwd: workspace,
    model: MOCK_MODEL,
    ephemeral: true,
  });
  const started = await connection.request('turn/start', {
    threadId: profile.threadId,
    input: [{ type: 'text', text: 'U1B missing-terminal timeout probe.' }],
  });
  const turnId = started.turn?.id;
  if (!turnId) throw new Error('missing-terminal turn/start omitted turn id');
  const terminal = await connection.waitForNotification(
    (message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === profile.threadId
      && message.params?.turn?.id === turnId
    ),
    300,
  );
  if (terminal !== null) {
    throw new Error('missing-terminal scenario unexpectedly reached terminal');
  }
  const turnWrites = trace.filter(
    (event) => event.type === 'client-write' && event.method === 'turn/start',
  ).length;
  if (turnWrites !== 1 || provider.attempts('missing-terminal') !== 1) {
    throw new Error('missing-terminal scenario replayed a client or provider request');
  }
  await connection.request('turn/interrupt', {
    threadId: profile.threadId,
    turnId,
  });
  const interrupted = await connection.waitForNotification(
    (message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === profile.threadId
      && message.params?.turn?.id === turnId
    ),
    5_000,
  );
  if (interrupted?.params?.turn?.status !== 'interrupted') {
    throw new Error('missing-terminal cleanup did not interrupt the exact turn');
  }
  return {
    gate: 'CONTINUE',
    providerAttempts: 1,
    clientTurnStarts: 1,
    boundedTimeoutObserved: true,
    cleanupTerminalStatus: 'interrupted',
  };
}

export async function characterizeRetries(options) {
  options = {
    ...options,
    daemonSecretRoots: validateDaemonSecretRoots(
      options.daemonSecretRoots,
      realpathSync(options.codexHome),
      realpathSync(options.workspace),
    ),
  };
  assertPinnedBinary(options.binary);
  const trace = [];
  let activeScenarioTrace = null;
  const provider = await createScriptedProvider((event) => {
    trace.push(event);
    activeScenarioTrace?.push(event);
  });
  let runtime;
  try {
    runtime = createSyntheticRuntime(options, provider.port);
    const env = sanitizedAppServerEnv(runtime.options);
    const definitions = [
      {
        name: 'retryable-success',
        expectedAttempts: 2,
        expectedTerminal: 'completed',
      },
      {
        name: 'retryable-exhausted',
        expectedAttempts: 2,
        expectedTerminal: 'failed',
      },
      {
        name: 'non-retryable',
        expectedAttempts: 1,
        expectedTerminal: 'failed',
      },
      {
        name: 'missing-terminal',
      },
    ];
    const scenarios = {};
    for (const definition of definitions) {
      let connection;
      const scenarioTrace = [];
      activeScenarioTrace = scenarioTrace;
      const record = (event) => {
        trace.push(event);
        scenarioTrace.push(event);
      };
      try {
        connection = new AppServerConnection({
          ...runtime.options,
          beforeRequestWrite({ method }) {
            record({ type: 'client-write', method });
          },
          onRetainedNotification(message) {
            record({
              type: message.method,
              threadId: message.params?.threadId,
              turnId: message.params?.turnId ?? message.params?.turn?.id,
              willRetry: message.params?.willRetry,
              status: message.params?.turn?.status,
            });
          },
        }, env);
        await initializeConnection(connection, runtime.options.codexHome);
        await attestSyntheticRuntime(connection, runtime);
        scenarios[definition.name] = definition.name === 'missing-terminal'
          ? await runMissingTerminalScenario(
            connection,
            provider,
            runtime.options.workspace,
            scenarioTrace,
          )
          : await runRetryScenario(
            connection,
            provider,
            definition,
            runtime.options.workspace,
            scenarioTrace,
          );
      } finally {
        activeScenarioTrace = null;
        await connection?.close();
      }
    }
    return { gate: 'CONTINUE', scenarios };
  } finally {
    const cleanup = await Promise.allSettled([provider.close()]);
    runtime?.cleanup();
    const rejected = cleanup.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
}

function parseArgs(argv) {
  const options = {
    binary: process.env.POLYGRAM_CODEX_BIN ?? '',
    launcher: process.env.ORCHESTRA_SESSION_LAUNCHER ?? '',
    codexHome: process.env.ORCHESTRA_CODEX_HOME ?? '',
    workspace: process.env.ORCHESTRA_CODEX_WORKSPACE ?? '',
    daemonSecretRoots: [],
    lane: 'all',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = argv[++index] ?? '';
    else if (arg === '--launcher') options.launcher = argv[++index] ?? '';
    else if (arg === '--codex-home') options.codexHome = argv[++index] ?? '';
    else if (arg === '--workspace') options.workspace = argv[++index] ?? '';
    else if (arg === '--daemon-secret-root') {
      options.daemonSecretRoots.push(argv[++index] ?? '');
    } else if (arg === '--lane') {
      options.lane = argv[++index] ?? '';
    } else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['binary', 'codexHome', 'workspace']) {
    if (!options[key]) throw new Error(`missing required retry option: ${key}`);
  }
  if (
    options.daemonSecretRoots.length === 0
    || options.daemonSecretRoots.some((root) => !root)
  ) {
    throw new Error('at least one daemon secret root is required');
  }
  if (!['all', 'retries', 'effects'].includes(options.lane)) {
    throw new Error('lane must be all, retries, or effects');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const retries = options.lane === 'effects'
    ? { gate: 'NOT_RUN' }
    : await characterizeRetries(options);
  const effects = options.lane === 'retries'
    ? { gate: 'NOT_RUN' }
    : await characterizeEffects(options);
  const result = {
    gate: [retries, effects]
      .filter((lane) => lane.gate !== 'NOT_RUN')
      .every((lane) => lane.gate === 'CONTINUE')
      ? 'CONTINUE'
      : 'STOP',
    retries,
    effects,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.gate === 'CONTINUE' ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await main();
}
