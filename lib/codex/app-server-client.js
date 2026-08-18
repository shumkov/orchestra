'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  createReadStream,
  lstatSync,
  realpathSync,
  statSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { promisify } = require('node:util');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const protocolSchema = deepFreeze(
  JSON.parse(JSON.stringify(require('./protocol-schema.json'))),
);
const execFileAsync = promisify(execFile);

const CONTROLLED_PATH = '/usr/bin:/bin';
const SUPERVISOR_PATH = path.join(__dirname, 'app-server-supervisor.mjs');
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const DEFAULT_CLOSE_KILL_MS = 1_000;
const CODEX_SUPERVISOR_GRACE_MS =
  DEFAULT_CLOSE_GRACE_MS + DEFAULT_CLOSE_KILL_MS;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_USED_REQUEST_IDS = 65_536;
const DEFAULT_MAX_QUEUED_LINES = 256;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_SINK_TIMEOUT_MS = 5_000;
const CLIENT_ROOT_ERROR_CODES = Object.freeze([
  'CODEX_PROTOCOL_ERROR',
  'CODEX_TRANSPORT_ERROR',
  'CODEX_PROCESS_EXITED',
  'CODEX_PROCESS_ERROR',
  'CODEX_RPC_TIMEOUT',
  'CODEX_SINK_TIMEOUT',
  'CODEX_PROCESS_CLOSE_TIMEOUT',
  'CODEX_PROCESS_CLEANUP_UNVERIFIED',
  'unknown',
]);
const CLIENT_FAULT_CLASSES = Object.freeze([
  'stderr-limit',
  'transport',
  'protocol',
  'process-exit',
  'rpc-timeout',
  'sink',
  'cleanup',
  'unknown',
]);
const CLIENT_ROOT_ERROR_CODE_SET = new Set(CLIENT_ROOT_ERROR_CODES);
const CLIENT_FAULT_CLASS_SET = new Set(CLIENT_FAULT_CLASSES);
const CLIENT_FAULT_CLASS_BY_CODE = Object.freeze({
  CODEX_PROTOCOL_ERROR: 'protocol',
  CODEX_TRANSPORT_ERROR: 'transport',
  CODEX_PROCESS_EXITED: 'process-exit',
  CODEX_PROCESS_ERROR: 'process-exit',
  CODEX_RPC_TIMEOUT: 'rpc-timeout',
  CODEX_SINK_TIMEOUT: 'sink',
  CODEX_PROCESS_CLOSE_TIMEOUT: 'cleanup',
  CODEX_PROCESS_CLEANUP_UNVERIFIED: 'cleanup',
});
const MAX_ID_BYTES = 512;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_COMPLETED_ITEMS = 512;
const MAX_RESPONSE_ARRAY_ITEMS = 512;
const MAX_RESPONSE_OBJECT_KEYS = 512;
const MAX_RESPONSE_NODES = 8_192;
const MAX_RESPONSE_DEPTH = 12;
const SAFE_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*$/;
const FORBIDDEN_REQUEST_FIELDS = new Set([
  'sandbox_mode',
  'sandbox_workspace_write',
  'sandbox',
  'sandboxPolicy',
  'permissions',
  'permissionProfile',
  'config',
]);
// Hook trust is content-addressed and reported only by the app server, so the
// verifier compares a whole inventory against a manifest fixed at construction
// rather than harvesting values entry by entry.
const HOOK_EVENT_NAMES = Object.freeze([
  'preToolUse',
  'permissionRequest',
  'postToolUse',
  'preCompact',
  'postCompact',
  'sessionStart',
  'sessionEnd',
  'userPromptSubmit',
  'subagentStart',
  'subagentStop',
  'stop',
]);
const HOOK_TRUST_STATUSES = Object.freeze([
  'managed',
  'untrusted',
  'trusted',
  'modified',
]);
const HOOK_PHASES = Object.freeze({
  discovery: 'untrusted',
  trusted: 'trusted',
});
const HOOK_METADATA_REQUIRED_FIELDS = Object.freeze([
  'currentHash',
  'displayOrder',
  'enabled',
  'eventName',
  'handlerType',
  'isManaged',
  'key',
  'source',
  'sourcePath',
  'timeoutSec',
  'trustStatus',
]);
// All five are reported on every entry; four of them always null. A missing or
// populated one means the reported shape is not the shape this pin was built
// against, which is a refusal rather than something to interpret.
const HOOK_METADATA_NULL_OPTIONAL_FIELDS = Object.freeze([
  'additionalContextLimit',
  'matcher',
  'pluginId',
  'statusMessage',
]);
const HOOK_METADATA_FIELDS = Object.freeze([
  ...HOOK_METADATA_REQUIRED_FIELDS,
  ...HOOK_METADATA_NULL_OPTIONAL_FIELDS,
  'command',
]);
const HOOK_DESCRIPTOR_FIELDS = Object.freeze([
  'ordinal',
  'configKey',
  'sourcePath',
  'event',
  'handlerType',
  'source',
  'isManaged',
  'displayOrder',
  'timeoutSec',
  'commandSha256',
]);
const HOOK_INVENTORY_ENTRY_FIELDS = Object.freeze([
  'cwd',
  'errors',
  'warnings',
  'hooks',
]);
const MAX_HOOK_DESCRIPTORS = 16;
const HOOK_CURRENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const CONSTRUCTOR_KEYS = new Set([
  'binary',
  'cwd',
  'codexHome',
  'hookManifest',
  'env',
  'spawnFn',
  'killFn',
  'setTimer',
  'clearTimer',
  'requestIdFactory',
  'onNotification',
  'onFault',
  'attestBinaryFn',
  'attestCodexHomeFn',
  'attestSessionLauncherFn',
  'sessionLauncher',
  'expectedSessionLauncherSha256',
  'expectedConfigSha256',
  'requestTimeoutMs',
  'sinkTimeoutMs',
  'closeGraceMs',
  'closeKillMs',
  'maxLineBytes',
  'maxStderrBytes',
  'maxPendingRequests',
  'maxUsedRequestIds',
  'maxQueuedLines',
  'maxQueuedBytes',
]);

// Keyed by the pending record itself, so a forged record inserted into the
// pending map carries no projector and can never yield a raw response.
const RESULT_PROJECTORS = new WeakMap();
const CLIENT_REQUESTS = new Map(Object.entries(protocolSchema.clientRequests));
const CLIENT_NOTIFICATIONS = new Set(protocolSchema.clientNotifications);
const DENIED_CLIENT_REQUESTS = new Set(protocolSchema.deniedClientRequests);
const DELIVERED_NOTIFICATIONS = new Set(
  protocolSchema.deliveredServerNotifications,
);
const DROPPED_NOTIFICATIONS = new Set(
  protocolSchema.droppedServerNotifications,
);
const DENIED_SERVER_REQUESTS = new Map(
  Object.entries(protocolSchema.deniedServerRequests),
);
const RECOGNIZED_RPC_ERRORS = new Map(
  Object.entries(protocolSchema.recognizedRpcErrors)
    .map(([method, messages]) => [method, new Set(messages)]),
);

function faultProvenanceFrom(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (
      (typeof current !== 'object' && typeof current !== 'function')
      || seen.has(current)
    ) {
      break;
    }
    seen.add(current);
    const rootDescriptor = Object.getOwnPropertyDescriptor(
      current,
      'clientRootErrorCode',
    );
    const classDescriptor = Object.getOwnPropertyDescriptor(
      current,
      'clientFaultClass',
    );
    const codeDescriptor = Object.getOwnPropertyDescriptor(current, 'code');
    const rootCode = rootDescriptor?.value;
    const code = codeDescriptor?.value;
    const faultClass = classDescriptor?.value;
    if (
      typeof rootCode === 'string'
      && CLIENT_ROOT_ERROR_CODE_SET.has(rootCode)
      && rootCode !== 'unknown'
    ) {
      return Object.freeze({
        clientRootErrorCode: rootCode,
        clientFaultClass: CLIENT_FAULT_CLASS_SET.has(faultClass)
          ? faultClass
          : (CLIENT_FAULT_CLASS_BY_CODE[rootCode] ?? 'unknown'),
      });
    }
    if (
      typeof code === 'string'
      && CLIENT_ROOT_ERROR_CODE_SET.has(code)
      && code !== 'unknown'
    ) {
      return Object.freeze({
        clientRootErrorCode: code,
        clientFaultClass: CLIENT_FAULT_CLASS_SET.has(faultClass)
          ? faultClass
          : (CLIENT_FAULT_CLASS_BY_CODE[code] ?? 'unknown'),
      });
    }
    const causeDescriptor = Object.getOwnPropertyDescriptor(current, 'cause');
    current = causeDescriptor?.value;
  }
  return Object.freeze({
    clientRootErrorCode: 'unknown',
    clientFaultClass: 'unknown',
  });
}

function defineFaultProvenance(error, provenance) {
  const properties = {
    clientRootErrorCode: {
      value: provenance.clientRootErrorCode,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    clientFaultClass: {
      value: provenance.clientFaultClass,
      enumerable: true,
      writable: false,
      configurable: false,
    },
  };
  try {
    Object.defineProperties(error, properties);
    return error;
  } catch {
    const safeCode = provenance.clientRootErrorCode === 'unknown'
      ? 'CODEX_PROTOCOL_ERROR'
      : provenance.clientRootErrorCode;
    const replacement = new CodexAppServerError(
      'app-server fault could not be annotated',
      safeCode,
      { cause: error },
    );
    Object.defineProperties(replacement, properties);
    return replacement;
  }
}

function faultWithClass(error, clientFaultClass) {
  Object.defineProperty(error, 'clientFaultClass', {
    value: clientFaultClass,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return error;
}

function transportWriteError(cause) {
  if (cause instanceof CodexAppServerError && cause.code === 'CODEX_TRANSPORT_ERROR') {
    return cause;
  }
  return new CodexAppServerError(
    'app-server transport write failed',
    'CODEX_TRANSPORT_ERROR',
    { cause },
  );
}

function assertProtocolSchema() {
  const experimental = [...CLIENT_REQUESTS]
    .filter(([, spec]) => spec.experimental)
    .map(([method]) => method)
    .sort();
  const binaryTargets = Object.keys(
    protocolSchema.binarySha256ByTarget ?? {},
  ).sort();
  if (
    JSON.stringify(experimental) !== JSON.stringify([
      'thread/backgroundTerminals/clean',
      'thread/backgroundTerminals/list',
    ])
    || !CLIENT_NOTIFICATIONS.has('initialized')
    || CLIENT_NOTIFICATIONS.size !== 1
    || protocolSchema.requestIdTypes.join(',') !== 'integer,string'
    || typeof protocolSchema.generatedProtocolV2CanonicalSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(protocolSchema.generatedProtocolV2CanonicalSha256)
    || JSON.stringify(binaryTargets) !== JSON.stringify([
      'aarch64-apple-darwin',
      'x86_64-unknown-linux-musl',
    ])
    || binaryTargets.some(
      (target) => !/^[a-f0-9]{64}$/.test(
        protocolSchema.binarySha256ByTarget[target],
      ),
    )
    || protocolSchema.binarySha256
      !== protocolSchema.binarySha256ByTarget['aarch64-apple-darwin']
  ) {
    throw new Error('Codex app-server protocol pin is inconsistent');
  }
  for (const method of DELIVERED_NOTIFICATIONS) {
    if (DROPPED_NOTIFICATIONS.has(method)) {
      throw new Error('Codex app-server notification classes overlap');
    }
  }
  if (
    CLIENT_REQUESTS.has('thread/backgroundTerminals/terminate')
    || CLIENT_REQUESTS.has('command/exec')
    || !DENIED_CLIENT_REQUESTS.has('command/exec')
  ) {
    throw new Error('Codex app-server privileged method policy drifted');
  }
}

assertProtocolSchema();

class CodexAppServerError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'CodexAppServerError';
    this.code = code;
  }
}

const CODEX_TARGET_BY_HOST = Object.freeze({
  'darwin/arm64': 'aarch64-apple-darwin',
  'linux/x64': 'x86_64-unknown-linux-musl',
});
const CODEX_TARGET_RECEIPTS = Object.freeze(Object.fromEntries(
  Object.entries(protocolSchema.binarySha256ByTarget).map(
    ([target, binarySha256]) => [
      target,
      Object.freeze({
        target,
        cliVersion: protocolSchema.cliVersion,
        binarySha256,
      }),
    ],
  ),
));

function resolveCodexTargetPin(
  platform = process.platform,
  arch = process.arch,
) {
  const target = CODEX_TARGET_BY_HOST[`${platform}/${arch}`];
  if (!target) {
    throw new CodexAppServerError(
      'The native Codex app-server beta does not support this platform',
      'CODEX_UNSUPPORTED_PLATFORM',
    );
  }
  return CODEX_TARGET_RECEIPTS[target];
}

function buildCodexAppServerEnv(codexHome, hostEnv = process.env) {
  return Object.fromEntries(
    Object.entries({
      HOME: hostEnv.HOME,
      PATH: CONTROLLED_PATH,
      TMPDIR: hostEnv.TMPDIR,
      LANG: hostEnv.LANG,
      LC_ALL: hostEnv.LC_ALL,
      CODEX_HOME: codexHome,
    }).filter(([, value]) => value !== undefined),
  );
}

function binaryFingerprint(binary) {
  const stat = statSync(binary, { bigint: true });
  if (!stat.isFile()) {
    throw new CodexAppServerError(
      'pinned Codex binary is not a regular file',
      'CODEX_BINARY_MISMATCH',
    );
  }
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    nlink: Number(stat.nlink),
  };
}

async function hashFile(binary) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(binary);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function attestPinnedCodexBinary(
  binary,
  targetReceipt = resolveCodexTargetPin(),
) {
  if (targetReceipt !== resolveCodexTargetPin()) {
    throw new CodexAppServerError(
      'pinned Codex target receipt mismatch',
      'CODEX_BINARY_MISMATCH',
    );
  }
  if (realpathSync(binary) !== binary) {
    throw new CodexAppServerError(
      'pinned Codex binary path is not canonical',
      'CODEX_BINARY_MISMATCH',
    );
  }
  const root = path.parse(binary).root;
  let component = root;
  for (const part of binary.slice(root.length).split('/').filter(Boolean)) {
    component = path.join(component, part);
    const stat = lstatSync(component);
    if (
      stat.isSymbolicLink()
      || ![0, process.getuid?.()].includes(stat.uid)
      || (stat.mode & 0o022) !== 0
    ) {
      throw new CodexAppServerError(
        'pinned Codex binary path ownership or mode is unsafe',
        'CODEX_BINARY_MISMATCH',
      );
    }
  }
  const fingerprint = binaryFingerprint(binary);
  if (
    (fingerprint.mode & 0o022) !== 0
    || (process.platform !== 'win32' && (fingerprint.mode & 0o111) === 0)
    || ![0, process.getuid?.()].includes(fingerprint.uid)
    || fingerprint.nlink !== 1
  ) {
    throw new CodexAppServerError(
      'pinned Codex binary ownership or mode is unsafe',
      'CODEX_BINARY_MISMATCH',
    );
  }
  const sha256 = await hashFile(binary);
  if (sha256 !== targetReceipt.binarySha256) {
    throw new CodexAppServerError(
      'pinned Codex binary hash mismatch',
      'CODEX_BINARY_MISMATCH',
    );
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024,
      env: { PATH: CONTROLLED_PATH },
    }));
  } catch {
    throw new CodexAppServerError(
      'pinned Codex binary version probe failed',
      'CODEX_BINARY_MISMATCH',
    );
  }
  if (stdout.trim() !== targetReceipt.cliVersion) {
    throw new CodexAppServerError(
      'pinned Codex binary version mismatch',
      'CODEX_BINARY_MISMATCH',
    );
  }
  return {
    path: binary,
    target: targetReceipt.target,
    sha256,
    version: stdout.trim(),
    fingerprint,
  };
}

async function characterizePinnedSessionLauncher(launcher) {
  try {
    if (
      typeof launcher !== 'string'
      || !path.isAbsolute(launcher)
      || realpathSync(launcher) !== launcher
    ) {
      throw new CodexAppServerError(
        'session launcher identity is malformed',
        'CODEX_SESSION_LAUNCHER_MISMATCH',
      );
    }
    const root = path.parse(launcher).root;
    let component = root;
    for (const part of launcher.slice(root.length).split('/').filter(Boolean)) {
      component = path.join(component, part);
      const componentStat = lstatSync(component);
      if (
        componentStat.isSymbolicLink()
        || componentStat.uid !== 0
        || (componentStat.mode & 0o022) !== 0
      ) {
        throw new CodexAppServerError(
          'session launcher path ownership or mode is unsafe',
          'CODEX_SESSION_LAUNCHER_MISMATCH',
        );
      }
    }
    const stat = lstatSync(launcher);
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)
    ) {
      throw new CodexAppServerError(
        'session launcher is not a safe executable file',
        'CODEX_SESSION_LAUNCHER_MISMATCH',
      );
    }
    const sha256 = await hashFile(launcher);
    return Object.freeze({
      path: launcher,
      sha256,
      fingerprint: pathFingerprint(launcher),
    });
  } catch (cause) {
    if (cause?.code === 'CODEX_SESSION_LAUNCHER_MISMATCH') throw cause;
    throw new CodexAppServerError(
      'session launcher could not be attested',
      'CODEX_SESSION_LAUNCHER_MISMATCH',
      { cause },
    );
  }
}

async function attestPinnedSessionLauncher(launcher, expectedSha256) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new CodexAppServerError(
      'session launcher identity is malformed',
      'CODEX_SESSION_LAUNCHER_MISMATCH',
    );
  }
  const attestation = await characterizePinnedSessionLauncher(launcher);
  if (attestation.sha256 !== expectedSha256) {
    throw new CodexAppServerError(
      'session launcher content changed',
      'CODEX_SESSION_LAUNCHER_MISMATCH',
    );
  }
  return attestation;
}

function pathFingerprint(target) {
  const stat = lstatSync(target, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    nlink: Number(stat.nlink),
  };
}

function canonicalTemporaryRoots() {
  const roots = new Set();
  for (const candidate of [
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/folders',
  ]) {
    try {
      roots.add(realpathSync(candidate));
    } catch {}
  }
  return [...roots];
}

function assertSecureOwnedPath(target, {
  kind,
  expectedMode,
  temporaryRoots = canonicalTemporaryRoots(),
}) {
  if (realpathSync(target) !== target) {
    throw new CodexAppServerError(
      `pinned Codex ${kind} path is not canonical`,
      'CODEX_CONFIG_MISMATCH',
    );
  }
  if (temporaryRoots.some((root) => isWithin(root, target))) {
    throw new CodexAppServerError(
      `pinned Codex ${kind} cannot be stored in a temporary directory`,
      'CODEX_CONFIG_MISMATCH',
    );
  }
  const root = path.parse(target).root;
  let component = root;
  for (const part of target.slice(root.length).split('/').filter(Boolean)) {
    component = path.join(component, part);
    const stat = lstatSync(component);
    const isTarget = component === target;
    if (
      stat.isSymbolicLink()
      || ![0, process.getuid?.()].includes(stat.uid)
      || (stat.mode & 0o022) !== 0
      || (
        isTarget
        && expectedMode !== undefined
        && (stat.mode & 0o777) !== expectedMode
      )
    ) {
      throw new CodexAppServerError(
        `pinned Codex ${kind} ownership or mode is unsafe`,
        'CODEX_CONFIG_MISMATCH',
      );
    }
  }
}

function assertSecureCredentialFile(file, label) {
  const stat = lstatSync(file);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (
      typeof process.getuid === 'function'
      && stat.uid !== process.getuid()
    )
    || (stat.mode & 0o777) !== 0o600
    || stat.nlink !== 1
  ) {
    throw new CodexAppServerError(
      `pinned Codex ${label} ownership or mode is unsafe`,
      'CODEX_CONFIG_MISMATCH',
    );
  }
  return pathFingerprint(file);
}

async function attestPinnedCodexHome(
  codexHome,
  expectedConfigSha256,
  { temporaryRoots = canonicalTemporaryRoots() } = {},
) {
  if (
    typeof expectedConfigSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(expectedConfigSha256)
  ) {
    throw new TypeError(
      'CodexAppServerClient: expectedConfigSha256 must be a lowercase SHA-256',
    );
  }
  assertSecureOwnedPath(codexHome, {
    kind: 'credential home',
    expectedMode: 0o700,
    temporaryRoots,
  });
  const homeStat = lstatSync(codexHome);
  if (!homeStat.isDirectory() || homeStat.nlink < 1) {
    throw new CodexAppServerError(
      'pinned Codex credential home is not a directory',
      'CODEX_CONFIG_MISMATCH',
    );
  }

  const configPath = path.join(codexHome, 'config.toml');
  const configFingerprint = assertSecureCredentialFile(
    configPath,
    'config.toml',
  );
  const configSha256 = await hashFile(configPath);
  if (configSha256 !== expectedConfigSha256) {
    throw new CodexAppServerError(
      'pinned Codex config.toml hash mismatch',
      'CODEX_CONFIG_MISMATCH',
    );
  }

  const authPath = path.join(codexHome, 'auth.json');
  let authFingerprint = null;
  try {
    authFingerprint = assertSecureCredentialFile(authPath, 'auth.json');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    path: codexHome,
    configSha256,
    configFingerprint,
    authFingerprint,
  };
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`CodexAppServerClient: ${label} must be an absolute path`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`CodexAppServerClient: ${label} must be a positive integer`);
  }
}

// Beyond this a delay silently collapses to ~1ms instead of waiting, which
// would turn a long close budget into no budget at all.
function assertTimerDelay(value, label) {
  assertPositiveInteger(value, label);
  if (value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `CodexAppServerClient: ${label} must not exceed ${MAX_TIMER_DELAY_MS}`,
    );
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function assertRequestId(id) {
  if (
    !(typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= MAX_ID_BYTES)
    && !Number.isSafeInteger(id)
  ) {
    throw new CodexAppServerError(
      'app-server request ID was outside the pinned schema',
      'CODEX_PROTOCOL_ERROR',
    );
  }
}

function boundedString(value, label, maxBytes = MAX_ID_BYTES) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
    throw new CodexAppServerError(
      `app-server ${label} exceeded the size limit`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return value;
}

function protocolString(value, label, maxBytes = MAX_ID_BYTES) {
  const projected = boundedString(value, label, maxBytes);
  if (projected === undefined) {
    throw new CodexAppServerError(
      `app-server ${label} must be a string`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return projected;
}

function projectThreadStatus(value, label) {
  const status = protocolObject(value, label);
  const type = protocolRequiredString(status.type, `${label} type`);
  if (!['notLoaded', 'idle', 'systemError', 'active'].includes(type)) {
    throw new CodexAppServerError(
      `app-server ${label} is unsupported`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  if (type !== 'active') return { type };
  if (
    !Array.isArray(status.activeFlags)
    || status.activeFlags.length > 32
    || status.activeFlags.some((flag) => (
      !['waitingOnApproval', 'waitingOnUserInput'].includes(flag)
    ))
  ) {
    throw new CodexAppServerError(
      `app-server ${label} active flags are malformed`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return { type, activeFlags: [...status.activeFlags] };
}

function projectCollaborationMode(value) {
  const collaboration = protocolObject(value, 'collaboration mode');
  const mode = protocolRequiredString(collaboration.mode, 'collaboration mode');
  if (!['plan', 'default'].includes(mode)) {
    throw new CodexAppServerError(
      'app-server collaboration mode is unsupported',
      'CODEX_PROTOCOL_ERROR',
    );
  }
  const settings = protocolObject(
    collaboration.settings,
    'collaboration mode settings',
  );
  const projected = {
    mode,
    model: protocolRequiredString(
      settings.model,
      'collaboration mode model',
    ),
  };
  if (settings.reasoning_effort != null) {
    projected.reasoningEffort = protocolRequiredString(
      settings.reasoning_effort,
      'collaboration mode reasoning effort',
    );
  }
  if (
    settings.developer_instructions !== undefined
    && settings.developer_instructions !== null
  ) {
    protocolString(
      settings.developer_instructions,
      'collaboration mode developer instructions',
      MAX_TEXT_BYTES,
    );
  }
  return projected;
}

function projectNotification(message, ownedCwd) {
  const source = protocolObject(
    message.params ?? {},
    `${message.method} notification parameters`,
  );
  const params = {};
  const requiredIds = new Set();
  if (
    message.method === 'thread/status/changed'
    || message.method === 'thread/settings/updated'
    || message.method === 'turn/started'
    || message.method === 'turn/completed'
  ) requiredIds.add('threadId');
  if (
    message.method === 'error'
    || message.method === 'item/started'
    || message.method === 'item/completed'
    || message.method === 'item/agentMessage/delta'
  ) {
    requiredIds.add('threadId');
    requiredIds.add('turnId');
  }
  if (message.method === 'item/agentMessage/delta') requiredIds.add('itemId');
  for (const key of ['threadId', 'turnId', 'itemId']) {
    const value = requiredIds.has(key)
      ? protocolRequiredString(source[key], `notification ${key}`)
      : boundedString(source[key], `notification ${key}`);
    if (value !== undefined) params[key] = value;
  }

  if (message.method === 'error') {
    if (typeof source.willRetry !== 'boolean' || source.error == null) {
      throw new CodexAppServerError(
        'app-server error notification omitted retry ownership',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    protocolObject(source.error, 'error notification payload');
    params.willRetry = source.willRetry;
    params.error = { present: source.error != null };
  } else if (message.method === 'thread/status/changed') {
    params.status = projectThreadStatus(source.status, 'thread status');
  } else if (message.method === 'thread/settings/updated') {
    const settings = protocolObject(
      source.threadSettings,
      'thread settings',
    );
    if (Object.hasOwn(settings, 'runtimeWorkspaceRoots')) {
      throw new CodexAppServerError(
        'app-server thread settings unexpectedly included runtime workspace roots',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (settings.cwd !== ownedCwd) {
      throw new CodexAppServerError(
        'app-server thread settings changed the owned workspace',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    const reviewer = protocolRequiredString(
      settings.approvalsReviewer,
      'thread settings approvals reviewer',
    );
    if (!['user', 'auto_review', 'guardian_subagent'].includes(reviewer)) {
      throw new CodexAppServerError(
        'app-server thread settings approvals reviewer is unsupported',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    params.threadSettings = {
      model: protocolRequiredString(settings.model, 'thread settings model'),
      modelProvider: protocolRequiredString(
        settings.modelProvider,
        'thread settings model provider',
      ),
      approvalPolicy: projectApprovalPolicy(settings.approvalPolicy),
      approvalsReviewer: reviewer,
      collaborationMode: projectCollaborationMode(
        settings.collaborationMode,
      ),
      sandboxPolicy: projectSandbox(settings.sandboxPolicy, ownedCwd),
    };
    if (settings.effort != null) {
      params.threadSettings.effort = protocolRequiredString(
        settings.effort,
        'thread settings effort',
      );
    }
    const profile = settings.activePermissionProfile;
    if (profile != null) {
      params.threadSettings.activePermissionProfile = {
        id: protocolRequiredString(profile.id, 'permission profile id'),
        extends: profile.extends == null
          ? null
          : boundedString(profile.extends, 'permission profile parent'),
      };
    }
  } else if (
    message.method === 'turn/started'
    || message.method === 'turn/completed'
  ) {
    const turn = projectTurn(source.turn, 'notification turn');
    params.turn = {
      id: turn.id,
      status: turn.status,
    };
    if (message.method === 'turn/completed') {
      params.turn.error = turn.error;
      params.turn.items = turn.items;
    }
  } else if (
    message.method === 'item/started'
    || message.method === 'item/completed'
  ) {
    const timestamp = message.method === 'item/started'
      ? source.startedAtMs
      : source.completedAtMs;
    if (!Number.isSafeInteger(timestamp)) {
      throw new CodexAppServerError(
        'app-server item notification timestamp is malformed',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    const item = protocolObject(source.item, 'notification item');
    params.item = {
      id: protocolRequiredString(item.id, 'item id'),
      type: protocolRequiredString(item.type, 'item type'),
    };
    const clientId = boundedString(item.clientId, 'item client id');
    if (clientId !== undefined) params.item.clientId = clientId;
    if (item.type === 'agentMessage') {
      const text = boundedString(item.text, 'agent message', MAX_TEXT_BYTES);
      if (text !== undefined) params.item.text = text;
    }
  } else if (message.method === 'item/agentMessage/delta') {
    params.delta = protocolString(
      source.delta,
      'agent message delta',
      MAX_TEXT_BYTES,
    );
  }
  return { method: message.method, params };
}

function plainObject(value, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new CodexAppServerError(
      `app-server ${label} must be a plain object`,
      'CODEX_RPC_REJECTED',
    );
  }
  return value;
}

function protocolObject(value, label) {
  try {
    return plainObject(value, label);
  } catch (error) {
    throw new CodexAppServerError(
      `app-server ${label} must be a plain object`,
      'CODEX_PROTOCOL_ERROR',
      { cause: error },
    );
  }
}

function boundedRequiredString(value, label, maxBytes = MAX_ID_BYTES) {
  const projected = boundedString(value, label, maxBytes);
  if (projected === undefined || projected.length === 0) {
    throw new CodexAppServerError(
      `app-server ${label} is required`,
      'CODEX_RPC_REJECTED',
    );
  }
  return projected;
}

function protocolRequiredString(value, label, maxBytes = MAX_ID_BYTES) {
  const projected = boundedString(value, label, maxBytes);
  if (projected === undefined || projected.length === 0) {
    throw new CodexAppServerError(
      `app-server ${label} is required`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return projected;
}

function protocolOptionalCursor(value, label = 'pagination cursor') {
  if (value == null) return null;
  return protocolRequiredString(value, label);
}

function cloneBoundedJson(value, label) {
  let nodes = 0;
  const clone = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_RESPONSE_NODES || depth > MAX_RESPONSE_DEPTH) {
      throw new CodexAppServerError(
        `app-server ${label} exceeded structural bounds`,
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      return protocolString(current, label, MAX_TEXT_BYTES);
    }
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (Array.isArray(current)) {
      if (current.length > MAX_RESPONSE_ARRAY_ITEMS) {
        throw new CodexAppServerError(
          `app-server ${label} array exceeded the size limit`,
          'CODEX_PROTOCOL_ERROR',
        );
      }
      return current.map((entry) => clone(entry, depth + 1));
    }
    const object = protocolObject(current, label);
    const entries = Object.entries(object);
    if (entries.length > MAX_RESPONSE_OBJECT_KEYS) {
      throw new CodexAppServerError(
        `app-server ${label} object exceeded the size limit`,
        'CODEX_PROTOCOL_ERROR',
      );
    }
    return Object.fromEntries(entries.map(([key, entry]) => [
      protocolString(key, `${label} key`),
      clone(entry, depth + 1),
    ]));
  };
  return clone(value, 0);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function jsonDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
}

function projectedOptionalString(value, label, maxBytes = MAX_ID_BYTES) {
  if (value == null) return null;
  return protocolString(value, label, maxBytes);
}

function objectKeys(value, label) {
  if (value == null) return [];
  return Object.keys(protocolObject(value, label))
    .map((key) => protocolString(key, `${label} key`))
    .sort();
}

function projectedObjectIndex(value, label) {
  const keys = objectKeys(value, label);
  return {
    count: keys.length,
    keySha256: keys
      .map((key) => createHash('sha256').update(key).digest('hex'))
      .sort(),
  };
}

function projectEffectiveConfig(value) {
  const config = cloneBoundedJson(value, 'config');
  const profileSource = config.permissions == null
    ? {}
    : protocolObject(config.permissions, 'permission profiles');
  const permissionProfiles = Object.entries(profileSource)
    .map(([id, rawProfile]) => {
      const profile = protocolObject(rawProfile, 'permission profile config');
      const filesystem = profile.filesystem == null
        ? {}
        : protocolObject(profile.filesystem, 'permission profile filesystem');
      const network = profile.network == null
        ? {}
        : protocolObject(profile.network, 'permission profile network');
      if (
        network.enabled !== undefined
        && typeof network.enabled !== 'boolean'
      ) {
        throw new CodexAppServerError(
          'app-server permission profile network policy is malformed',
          'CODEX_PROTOCOL_ERROR',
        );
      }
      return {
        id: protocolRequiredString(id, 'permission profile id'),
        extends: projectedOptionalString(
          profile.extends,
          'permission profile parent',
        ),
        networkEnabled: network.enabled ?? null,
        filesystemSha256: jsonDigest(filesystem),
        filesystem: Object.entries(filesystem)
          .filter(([, access]) => typeof access === 'string')
          .map(([root, access]) => ({
            rootSha256: createHash('sha256').update(root).digest('hex'),
            access: protocolRequiredString(
              access,
              'permission profile filesystem access',
            ),
          }))
          .sort((left, right) => (
            left.rootSha256.localeCompare(right.rootSha256)
          )),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const shellEnvironment = config.shell_environment_policy == null
    ? {}
    : protocolObject(
      config.shell_environment_policy,
      'shell environment policy',
    );
  if (
    config.allow_login_shell !== undefined
    && typeof config.allow_login_shell !== 'boolean'
  ) {
    throw new CodexAppServerError(
      'app-server login shell policy is malformed',
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return {
    sha256: jsonDigest(config),
    model: projectedOptionalString(config.model, 'configured model'),
    modelProvider: projectedOptionalString(
      config.model_provider,
      'configured model provider',
    ),
    defaultPermissions: projectedOptionalString(
      config.default_permissions,
      'default permission profile',
    ),
    approvalPolicy: config.approval_policy == null
      ? null
      : projectApprovalPolicy(config.approval_policy),
    approvalsReviewer: projectedOptionalString(
      config.approvals_reviewer,
      'configured approvals reviewer',
    ),
    webSearch: projectedOptionalString(config.web_search, 'web search policy'),
    allowLoginShell: config.allow_login_shell ?? null,
    shellEnvironmentInherit: projectedOptionalString(
      shellEnvironment.inherit,
      'shell environment inheritance',
    ),
    permissionProfiles,
    mcpServers: projectedObjectIndex(config.mcp_servers, 'MCP servers'),
    plugins: projectedObjectIndex(config.plugins, 'plugins'),
    modelProviders: projectedObjectIndex(
      config.model_providers,
      'model providers',
    ),
  };
}

function projectConfigLayer(value) {
  const layer = protocolObject(value, 'config layer');
  const name = (
    typeof layer.name === 'string'
      ? { type: layer.name }
      : protocolObject(layer.name, 'config layer source')
  );
  return {
    type: protocolRequiredString(name.type, 'config layer source type'),
    version: protocolString(layer.version, 'config layer version'),
    disabled: layer.disabledReason != null,
    configSha256: jsonDigest(cloneBoundedJson(layer.config, 'config layer')),
  };
}

function projectTurn(value, label) {
  const turn = protocolObject(value, label);
  if (!Array.isArray(turn.items) || turn.items.length > MAX_COMPLETED_ITEMS) {
    throw new CodexAppServerError(
      `app-server ${label} item list exceeded the size limit`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  const status = protocolRequiredString(turn.status, `${label} status`);
  if (!['completed', 'interrupted', 'failed', 'inProgress'].includes(status)) {
    throw new CodexAppServerError(
      `app-server ${label} status is unsupported`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return {
    id: protocolRequiredString(turn.id, `${label} id`),
    status,
    items: turn.items.map((item) => {
      const projected = protocolObject(item, `${label} item`);
      return {
        id: protocolRequiredString(projected.id, `${label} item id`),
        type: protocolRequiredString(projected.type, `${label} item type`),
      };
    }),
    error: turn.error == null ? null : { present: true },
  };
}

function projectThread(value, label, ownedCwd, modelProvider) {
  const thread = protocolObject(value, label);
  const status = projectThreadStatus(thread.status, `${label} status`);
  if (!Array.isArray(thread.turns) || thread.turns.length > MAX_COMPLETED_ITEMS) {
    throw new CodexAppServerError(
      `app-server ${label} turn list exceeded the size limit`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  for (const [key, maxBytes] of [
    ['cliVersion', MAX_ID_BYTES],
    ['cwd', MAX_TEXT_BYTES],
    ['id', MAX_ID_BYTES],
    ['modelProvider', MAX_ID_BYTES],
    ['preview', MAX_TEXT_BYTES],
    ['sessionId', MAX_ID_BYTES],
    ['source', MAX_ID_BYTES],
  ]) {
    protocolString(thread[key], `${label} ${key}`, maxBytes);
  }
  if (
    !Number.isSafeInteger(thread.createdAt)
    || !Number.isSafeInteger(thread.updatedAt)
    || typeof thread.ephemeral !== 'boolean'
    || thread.cwd !== ownedCwd
    || thread.modelProvider !== modelProvider
  ) {
    throw new CodexAppServerError(
      `app-server ${label} metadata is malformed`,
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return {
    id: protocolRequiredString(thread.id, `${label} id`),
    ephemeral: thread.ephemeral,
    status,
    turns: thread.turns.map((turn) => projectTurn(turn, `${label} turn`)),
  };
}

function projectApprovalPolicy(value) {
  if (typeof value === 'string') {
    if (!['untrusted', 'on-request', 'never'].includes(value)) {
      throw new CodexAppServerError(
        'app-server approval policy is unsupported',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    return value;
  }
  const policy = protocolObject(value, 'approval policy');
  const granular = protocolObject(policy.granular, 'granular approval policy');
  for (const key of ['mcp_elicitations', 'rules', 'sandbox_approval']) {
    if (typeof granular[key] !== 'boolean') {
      throw new CodexAppServerError(
        'app-server granular approval policy is malformed',
        'CODEX_PROTOCOL_ERROR',
      );
    }
  }
  return {
    granular: {
      mcp_elicitations: granular.mcp_elicitations,
      rules: granular.rules,
      sandbox_approval: granular.sandbox_approval,
      request_permissions: granular.request_permissions === true,
      skill_approval: granular.skill_approval === true,
    },
  };
}

function projectSandbox(value, ownedCwd) {
  const sandbox = protocolObject(value, 'sandbox policy');
  const type = protocolRequiredString(sandbox.type, 'sandbox policy type');
  if (
    ![
      'dangerFullAccess',
      'readOnly',
      'externalSandbox',
      'workspaceWrite',
    ].includes(type)
  ) {
    throw new CodexAppServerError(
      'app-server sandbox policy is unsupported',
      'CODEX_PROTOCOL_ERROR',
    );
  }
  const projected = { type };
  if (sandbox.networkAccess !== undefined) {
    if (
      typeof sandbox.networkAccess !== 'boolean'
      && !['restricted', 'enabled'].includes(sandbox.networkAccess)
    ) {
      throw new CodexAppServerError(
        'app-server sandbox network policy is malformed',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    projected.networkAccess = sandbox.networkAccess;
  }
  if (type === 'workspaceWrite') {
    for (const key of ['excludeSlashTmp', 'excludeTmpdirEnvVar']) {
      if (sandbox[key] !== undefined && typeof sandbox[key] !== 'boolean') {
        throw new CodexAppServerError(
          'app-server sandbox temp exclusion is malformed',
          'CODEX_PROTOCOL_ERROR',
        );
      }
      if (sandbox[key] !== undefined) projected[key] = sandbox[key];
    }
    if (
      sandbox.writableRoots !== undefined
      && !Array.isArray(sandbox.writableRoots)
    ) {
      throw new CodexAppServerError(
        'app-server writable root list is malformed',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    const roots = sandbox.writableRoots ?? [];
    if (roots.length > 64) {
      throw new CodexAppServerError(
        'app-server writable root list is malformed',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    const validatedRoots = roots.map((root) => (
      protocolRequiredString(root, 'sandbox writable root', MAX_TEXT_BYTES)
    ));
    if (validatedRoots.some((root) => (
      !path.isAbsolute(root)
      || path.normalize(root) !== root
      || !isWithin(ownedCwd, root)
    ))) {
      throw new CodexAppServerError(
        'app-server writable root escaped the owned workspace',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    projected.writableRootCount = validatedRoots.length;
    projected.writableRootSha256 = validatedRoots
      .map((root) => createHash('sha256').update(root).digest('hex'))
      .sort();
  }
  return projected;
}

function projectRuntimeWorkspaceRoots(value, ownedCwd) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new CodexAppServerError(
      'app-server runtime workspace roots are malformed',
      'CODEX_PROTOCOL_ERROR',
    );
  }
  const roots = value.map((root) => (
    protocolRequiredString(root, 'runtime workspace root', MAX_TEXT_BYTES)
  ));
  if (roots.some((root) => (
    !path.isAbsolute(root)
    || path.normalize(root) !== root
    || !isWithin(ownedCwd, root)
  ))) {
    throw new CodexAppServerError(
      'app-server runtime workspace root escaped the owned workspace',
      'CODEX_PROTOCOL_ERROR',
    );
  }
  if (roots.length !== 1 || roots[0] !== ownedCwd) {
    throw new CodexAppServerError(
      'app-server runtime workspace roots did not match the owned workspace',
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return {
    count: roots.length,
    sha256: roots
      .map((root) => createHash('sha256').update(root).digest('hex'))
      .sort(),
  };
}

function projectRpcResult(method, value, ownedCwd) {
  const result = protocolObject(value, `${method} result`);
  if (method === 'initialize') {
    return {
      codexHome: protocolRequiredString(
        result.codexHome,
        'initialized credential home',
        MAX_TEXT_BYTES,
      ),
      platformFamily: protocolRequiredString(
        result.platformFamily,
        'server platform family',
      ),
      platformOs: protocolRequiredString(result.platformOs, 'server platform OS'),
      userAgent: protocolRequiredString(
        result.userAgent,
        'server user agent',
        4_096,
      ),
    };
  }
  if (method === 'config/read') {
    if (
      !Array.isArray(result.layers)
      || result.layers.length > 64
    ) {
      throw new CodexAppServerError(
        'app-server config layers must be an array',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    const origins = cloneBoundedJson(result.origins, 'config origins');
    return {
      config: projectEffectiveConfig(result.config),
      layers: result.layers.map(projectConfigLayer),
      originsSha256: jsonDigest(origins),
    };
  }
  if (method === 'configRequirements/read') {
    const requirements = result.requirements == null
      ? null
      : cloneBoundedJson(result.requirements, 'config requirements');
    return {
      requirements: requirements == null
        ? null
        : {
            sha256: jsonDigest(requirements),
            keys: objectKeys(requirements, 'config requirements'),
          },
    };
  }
  if (method === 'permissionProfile/list') {
    if (!Array.isArray(result.data) || result.data.length > 100) {
      throw new CodexAppServerError(
        'app-server permission profile page exceeded the size limit',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    return {
      data: result.data.map((profile) => {
        const source = protocolObject(profile, 'permission profile');
        if (typeof source.allowed !== 'boolean') {
          throw new CodexAppServerError(
            'app-server permission profile allowed flag is malformed',
            'CODEX_PROTOCOL_ERROR',
          );
        }
        return {
          id: protocolRequiredString(source.id, 'permission profile id'),
          allowed: source.allowed,
          descriptionSha256: source.description == null
            ? null
            : createHash('sha256')
              .update(protocolString(
                source.description,
                'permission profile description',
                MAX_TEXT_BYTES,
              ))
              .digest('hex'),
        };
      }),
      nextCursor: protocolOptionalCursor(result.nextCursor),
    };
  }
  if (method === 'account/read') {
    if (typeof result.requiresOpenaiAuth !== 'boolean') {
      throw new CodexAppServerError(
        'app-server account auth requirement is malformed',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (result.account == null) {
      return {
        account: null,
        requiresOpenaiAuth: result.requiresOpenaiAuth,
      };
    }
    const account = protocolObject(result.account, 'account');
    const type = protocolRequiredString(account.type, 'account type');
    if (!['apiKey', 'chatgpt', 'amazonBedrock'].includes(type)) {
      throw new CodexAppServerError(
        'app-server account type is unsupported',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (type === 'chatgpt') {
      if (account.email !== null) {
        protocolString(account.email, 'ChatGPT account email', MAX_TEXT_BYTES);
      }
      const planType = protocolRequiredString(
        account.planType,
        'ChatGPT plan type',
      );
      if (![
        'free',
        'go',
        'plus',
        'pro',
        'prolite',
        'team',
        'self_serve_business_usage_based',
        'business',
        'enterprise_cbp_usage_based',
        'enterprise',
        'edu',
        'unknown',
      ].includes(planType)) {
        throw new CodexAppServerError(
          'app-server ChatGPT plan type is unsupported',
          'CODEX_PROTOCOL_ERROR',
        );
      }
    }
    if (
      type === 'amazonBedrock'
      && account.usesCodexManagedCredentials !== undefined
      && typeof account.usesCodexManagedCredentials !== 'boolean'
    ) {
      throw new CodexAppServerError(
        'app-server Bedrock credential flag is malformed',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    return {
      account: { type },
      requiresOpenaiAuth: result.requiresOpenaiAuth,
    };
  }
  if (method === 'model/list') {
    if (!Array.isArray(result.data) || result.data.length > 100) {
      throw new CodexAppServerError(
        'app-server model page exceeded the size limit',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    return {
      data: result.data.map((model) => {
        const source = protocolObject(model, 'model');
        if (
          typeof source.hidden !== 'boolean'
          || typeof source.isDefault !== 'boolean'
          || !Array.isArray(source.supportedReasoningEfforts)
          || source.supportedReasoningEfforts.length > 32
        ) {
          throw new CodexAppServerError(
            'app-server model catalog entry is malformed',
            'CODEX_PROTOCOL_ERROR',
          );
        }
        const projected = {
          id: protocolRequiredString(source.id, 'model id'),
          model: protocolRequiredString(source.model, 'model slug'),
          description: protocolString(
            source.description,
            'model description',
            MAX_TEXT_BYTES,
          ),
          displayName: protocolString(source.displayName, 'model display name'),
          defaultReasoningEffort: protocolRequiredString(
            source.defaultReasoningEffort,
            'model default reasoning effort',
          ),
          hidden: source.hidden,
          isDefault: source.isDefault,
        };
        projected.supportedReasoningEfforts = source.supportedReasoningEfforts
          .map((entry) => {
            const effort = protocolObject(entry, 'model reasoning effort');
            protocolString(
              effort.description,
              'model reasoning effort description',
              MAX_TEXT_BYTES,
            );
            return protocolRequiredString(
              effort.reasoningEffort,
              'model reasoning effort',
            );
          });
        if (
          new Set(projected.supportedReasoningEfforts).size
            !== projected.supportedReasoningEfforts.length
          ||
          !projected.supportedReasoningEfforts
            .includes(projected.defaultReasoningEffort)
        ) {
          throw new CodexAppServerError(
            'app-server model default reasoning effort is unsupported',
            'CODEX_PROTOCOL_ERROR',
          );
        }
        return projected;
      }),
      nextCursor: protocolOptionalCursor(result.nextCursor),
    };
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    if (
      result.cwd !== ownedCwd
      || !['user', 'auto_review', 'guardian_subagent']
        .includes(result.approvalsReviewer)
    ) {
      throw new CodexAppServerError(
        'app-server thread policy response is inconsistent',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    const projected = {
      cwd: ownedCwd,
      model: protocolRequiredString(result.model, 'thread model'),
      modelProvider: protocolRequiredString(
        result.modelProvider,
        'thread model provider',
      ),
      approvalPolicy: projectApprovalPolicy(result.approvalPolicy),
      approvalsReviewer: result.approvalsReviewer,
      runtimeWorkspaceRoots: projectRuntimeWorkspaceRoots(
        result.runtimeWorkspaceRoots,
        ownedCwd,
      ),
      sandbox: projectSandbox(result.sandbox, ownedCwd),
    };
    projected.thread = projectThread(
      result.thread,
      'thread',
      ownedCwd,
      projected.modelProvider,
    );
    if (result.reasoningEffort != null) {
      projected.reasoningEffort = protocolRequiredString(
        result.reasoningEffort,
        'thread reasoning effort',
      );
    }
    if (result.activePermissionProfile != null) {
      const profile = protocolObject(
        result.activePermissionProfile,
        'active permission profile',
      );
      projected.activePermissionProfile = {
        id: protocolRequiredString(profile.id, 'permission profile id'),
        extends: profile.extends == null
          ? null
          : protocolRequiredString(profile.extends, 'permission profile parent'),
      };
    }
    return projected;
  }
  if (method === 'turn/start') {
    return { turn: projectTurn(result.turn, 'started turn') };
  }
  if (method === 'turn/steer') {
    return {
      turnId: protocolRequiredString(result.turnId, 'steered turn id'),
    };
  }
  if (
    method === 'turn/interrupt'
    || method === 'thread/backgroundTerminals/clean'
  ) {
    if (Object.keys(result).length !== 0) {
      throw new CodexAppServerError(
        `app-server ${method} returned an unexpected result`,
        'CODEX_PROTOCOL_ERROR',
      );
    }
    return {};
  }
  if (method === 'thread/backgroundTerminals/list') {
    if (!Array.isArray(result.data) || result.data.length > 100) {
      throw new CodexAppServerError(
        'app-server terminal page exceeded the size limit',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    return {
      count: result.data.length,
      nextCursor: protocolOptionalCursor(result.nextCursor),
    };
  }
  throw new CodexAppServerError(
    'app-server result projection is missing',
    'CODEX_PROTOCOL_ERROR',
  );
}

function projectRpcError(value) {
  const error = protocolObject(value, 'RPC error');
  if (
    !Number.isSafeInteger(error.code)
    || Object.keys(error).some((key) => !['code', 'message', 'data'].includes(key))
  ) {
    throw new CodexAppServerError(
      'app-server returned a malformed RPC error',
      'CODEX_PROTOCOL_ERROR',
    );
  }
  return {
    code: error.code,
    message: protocolRequiredString(error.message, 'RPC error message', 4_096),
  };
}

function projectTextInput(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new CodexAppServerError(
      'app-server input list exceeded the supported bounds',
      'CODEX_RPC_REJECTED',
    );
  }
  return input.map((item) => {
    plainObject(item, 'input item');
    if (
      Object.keys(item).some((key) => !['type', 'text'].includes(key))
      || item.type !== 'text'
    ) {
      throw new CodexAppServerError(
        'app-server input item type is unsupported',
        'CODEX_RPC_REJECTED',
      );
    }
    return {
      type: 'text',
      text: boundedRequiredString(item.text, 'input text', 256 * 1024),
    };
  });
}

function hookEventToken(event) {
  return event.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// The config key Codex reports for a hook is derived from the file that
// declares it and the event it is registered on; the trailing pair is the
// entry's position within that event, which this pin fixes at the first slot.
function hookConfigKeyFor(sourcePath, event) {
  return `${sourcePath}:${hookEventToken(event)}:0:0`;
}

function hookManifestType(message) {
  return new TypeError(`CodexAppServerClient: ${message}`);
}

function normalizeHookManifest(value) {
  if (value == null) return null;
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(['entries', 'ownedCwd'])
  ) {
    throw hookManifestType('hookManifest must be {ownedCwd, entries}');
  }
  const { ownedCwd, entries } = value;
  if (typeof ownedCwd !== 'string' || !path.isAbsolute(ownedCwd)) {
    throw hookManifestType('hookManifest ownedCwd must be an absolute path');
  }
  if (
    !Array.isArray(entries)
    || entries.length < 1
    || entries.length > MAX_HOOK_DESCRIPTORS
  ) {
    throw hookManifestType(
      `hookManifest requires 1..${MAX_HOOK_DESCRIPTORS} descriptors`,
    );
  }
  const events = new Set();
  const normalized = entries.map((entry, index) => {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort())
        !== JSON.stringify([...HOOK_DESCRIPTOR_FIELDS].sort())
    ) {
      throw hookManifestType('hookManifest descriptor shape is unsupported');
    }
    // The ordinal is the descriptor's position and the position Codex reports
    // it in; a manifest that disagrees with itself is refused here rather than
    // compared against a peer response later.
    if (entry.ordinal !== index || entry.displayOrder !== index) {
      throw hookManifestType('hookManifest ordinals must be dense and ordered');
    }
    if (
      typeof entry.sourcePath !== 'string'
      || !path.isAbsolute(entry.sourcePath)
      || !HOOK_EVENT_NAMES.includes(entry.event)
      || entry.handlerType !== 'command'
      || entry.source !== 'user'
      || entry.isManaged !== false
      || !Number.isSafeInteger(entry.timeoutSec)
      || entry.timeoutSec < 1
      || typeof entry.commandSha256 !== 'string'
      || !SHA256_HEX_PATTERN.test(entry.commandSha256)
      || entry.configKey !== hookConfigKeyFor(entry.sourcePath, entry.event)
    ) {
      throw hookManifestType('hookManifest descriptor is outside the pin');
    }
    if (events.has(entry.event)) {
      throw hookManifestType('hookManifest repeats a hook event');
    }
    events.add(entry.event);
    return {
      ordinal: entry.ordinal,
      configKey: entry.configKey,
      sourcePath: entry.sourcePath,
      event: entry.event,
      handlerType: entry.handlerType,
      source: entry.source,
      isManaged: entry.isManaged,
      displayOrder: entry.displayOrder,
      timeoutSec: entry.timeoutSec,
      commandSha256: entry.commandSha256,
    };
  });
  return deepFreeze({ ownedCwd, entries: normalized });
}

function hookTrustUnverified() {
  return new CodexAppServerError(
    'app-server hook inventory did not match the pinned manifest',
    'CODEX_HOOK_TRUST_UNVERIFIED',
  );
}

function hookEntryMatches(hook, descriptor, expectedTrustStatus) {
  if (
    !hook
    || typeof hook !== 'object'
    || Array.isArray(hook)
    || Object.getPrototypeOf(hook) !== Object.prototype
    || Object.getOwnPropertySymbols(hook).length > 0
    || JSON.stringify(Object.keys(hook).sort())
      !== JSON.stringify([...HOOK_METADATA_FIELDS].sort())
  ) return false;
  for (const field of HOOK_METADATA_NULL_OPTIONAL_FIELDS) {
    if (hook[field] !== null) return false;
  }
  if (
    typeof hook.command !== 'string'
    || createHash('sha256').update(hook.command).digest('hex')
      !== descriptor.commandSha256
  ) return false;
  return (
    hook.eventName === descriptor.event
    && hook.key === descriptor.configKey
    && hook.sourcePath === descriptor.sourcePath
    && hook.handlerType === descriptor.handlerType
    && hook.source === descriptor.source
    && hook.isManaged === descriptor.isManaged
    && hook.displayOrder === descriptor.displayOrder
    && hook.timeoutSec === descriptor.timeoutSec
    && hook.enabled === true
    && typeof hook.currentHash === 'string'
    && HOOK_CURRENT_HASH_PATTERN.test(hook.currentHash)
    && HOOK_TRUST_STATUSES.includes(hook.trustStatus)
    && hook.trustStatus === expectedTrustStatus
  );
}

// The whole inventory decides. A per-entry harvest would take a well-typed hash
// off a foreign, duplicated or tampered entry, so nothing is projected until
// every descriptor has matched its reported hook exactly.
function projectHookInventory(value, manifest, phase) {
  const expectedTrustStatus = HOOK_PHASES[phase];
  if (
    !expectedTrustStatus
    || !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || JSON.stringify(Object.keys(value)) !== JSON.stringify(['data'])
    || !Array.isArray(value.data)
    || value.data.length !== 1
  ) throw hookTrustUnverified();
  const entry = value.data[0];
  if (
    !entry
    || typeof entry !== 'object'
    || Array.isArray(entry)
    || Object.getPrototypeOf(entry) !== Object.prototype
    || JSON.stringify(Object.keys(entry).sort())
      !== JSON.stringify([...HOOK_INVENTORY_ENTRY_FIELDS].sort())
    // The response echoes the requested cwd back rather than scoping to it, so
    // this equality pins the response against malformation, nothing more.
    || entry.cwd !== manifest.ownedCwd
    || !Array.isArray(entry.errors)
    || entry.errors.length !== 0
    || !Array.isArray(entry.warnings)
    || entry.warnings.length !== 0
    || !Array.isArray(entry.hooks)
    || entry.hooks.length !== manifest.entries.length
  ) throw hookTrustUnverified();
  const seenKeys = new Set();
  const seenEvents = new Set();
  for (const [index, descriptor] of manifest.entries.entries()) {
    const hook = entry.hooks[index];
    if (!hookEntryMatches(hook, descriptor, expectedTrustStatus)) {
      throw hookTrustUnverified();
    }
    if (seenKeys.has(hook.key) || seenEvents.has(hook.eventName)) {
      throw hookTrustUnverified();
    }
    seenKeys.add(hook.key);
    seenEvents.add(hook.eventName);
  }
  return deepFreeze(manifest.entries.map((descriptor, index) => ({
    ordinal: descriptor.ordinal,
    currentHash: entry.hooks[index].currentHash,
    trustStatus: entry.hooks[index].trustStatus,
    enabled: entry.hooks[index].enabled,
  })));
}

function projectRequestParams(method, params, spec, ownedCwd) {
  if (spec.params === 'omitted') {
    if (params !== undefined) {
      throw new CodexAppServerError(
        `app-server ${method} parameters must be omitted`,
        'CODEX_RPC_REJECTED',
      );
    }
    return undefined;
  }
  plainObject(params, `${method} parameters`);
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_REQUEST_FIELDS.has(key)) {
      throw new CodexAppServerError(
        `app-server ${method} forbids ${key}`,
        'CODEX_RPC_REJECTED',
      );
    }
    if (!allowed.has(key)) {
      throw new CodexAppServerError(
        `app-server ${method} received an unexpected parameter`,
        'CODEX_RPC_REJECTED',
      );
    }
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(params, key)) {
      throw new CodexAppServerError(
        `app-server ${method} omitted a required parameter`,
        'CODEX_RPC_REJECTED',
      );
    }
  }
  const cursor = () => {
    if (!Object.hasOwn(params, 'cursor')) return {};
    return { cursor: boundedRequiredString(params.cursor, 'pagination cursor') };
  };
  const threadId = () => boundedRequiredString(params.threadId, 'thread id');
  const clientMessageId = () => (
    Object.hasOwn(params, 'clientUserMessageId')
      ? {
          clientUserMessageId: boundedRequiredString(
            params.clientUserMessageId,
            'client user message id',
          ),
        }
      : {}
  );
  if (method === 'initialize') {
    plainObject(params.clientInfo, 'initialize clientInfo');
    plainObject(params.capabilities, 'initialize capabilities');
    if (
      params.capabilities.experimentalApi !== true
      || Object.keys(params.capabilities).length !== 1
    ) {
      throw new CodexAppServerError(
        'app-server initialize capabilities changed',
        'CODEX_RPC_REJECTED',
      );
    }
    return {
      clientInfo: {
        name: boundedRequiredString(params.clientInfo.name, 'client name'),
        title: boundedRequiredString(params.clientInfo.title, 'client title'),
        version: boundedRequiredString(params.clientInfo.version, 'client version'),
      },
      capabilities: { experimentalApi: true },
    };
  }
  if (method === 'config/read') {
    if (params.cwd !== ownedCwd || params.includeLayers !== true) {
      throw new CodexAppServerError(
        'app-server config read must target the owned workspace and layers',
        'CODEX_RPC_REJECTED',
      );
    }
    return { cwd: ownedCwd, includeLayers: true };
  }
  if (method === 'permissionProfile/list') {
    if (params.cwd !== ownedCwd) {
      throw new CodexAppServerError(
        'app-server permission profile list changed workspace',
        'CODEX_RPC_REJECTED',
      );
    }
    return { cwd: ownedCwd, ...cursor() };
  }
  if (method === 'account/read') {
    if (params.refreshToken !== false) {
      throw new CodexAppServerError(
        'app-server account read cannot refresh credentials',
        'CODEX_RPC_REJECTED',
      );
    }
    return { refreshToken: false };
  }
  if (method === 'model/list') {
    if (
      params.includeHidden !== false
      || !Number.isSafeInteger(params.limit)
      || params.limit < 1
      || params.limit > 100
    ) {
      throw new CodexAppServerError(
        'app-server model list parameters are outside policy',
        'CODEX_RPC_REJECTED',
      );
    }
    return { includeHidden: false, limit: params.limit, ...cursor() };
  }
  if (method === 'thread/start') {
    if (params.cwd !== ownedCwd) {
      throw new CodexAppServerError(
        'app-server thread start changed workspace',
        'CODEX_RPC_REJECTED',
      );
    }
    return {
      cwd: ownedCwd,
      model: boundedRequiredString(params.model, 'model'),
    };
  }
  if (method === 'hooks/list') {
    if (
      !Array.isArray(params.cwds)
      || params.cwds.length !== 1
      || params.cwds[0] !== ownedCwd
    ) {
      throw new CodexAppServerError(
        'app-server hook listing must target the owned workspace',
        'CODEX_RPC_REJECTED',
      );
    }
    return { cwds: [ownedCwd] };
  }
  if (method === 'thread/resume') return { threadId: threadId() };
  if (method === 'turn/start') {
    const projected = {
      threadId: threadId(),
      input: projectTextInput(params.input),
      ...clientMessageId(),
    };
    if (Object.hasOwn(params, 'model')) {
      projected.model = boundedRequiredString(params.model, 'model');
    }
    if (Object.hasOwn(params, 'effort')) {
      const effort = boundedRequiredString(params.effort, 'reasoning effort');
      if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) {
        throw new CodexAppServerError(
          'app-server reasoning effort is unsupported',
          'CODEX_RPC_REJECTED',
        );
      }
      projected.effort = effort;
    }
    return projected;
  }
  if (method === 'turn/steer') {
    return {
      threadId: threadId(),
      expectedTurnId: boundedRequiredString(
        params.expectedTurnId,
        'expected turn id',
      ),
      input: projectTextInput(params.input),
      ...clientMessageId(),
    };
  }
  if (method === 'turn/interrupt') {
    return {
      threadId: threadId(),
      turnId: boundedRequiredString(params.turnId, 'turn id'),
    };
  }
  if (method === 'thread/backgroundTerminals/list') {
    const projected = { threadId: threadId(), ...cursor() };
    if (Object.hasOwn(params, 'limit')) {
      if (
        !Number.isSafeInteger(params.limit)
        || params.limit < 1
        || params.limit > 100
      ) {
        throw new CodexAppServerError(
          'app-server terminal page limit is outside policy',
          'CODEX_RPC_REJECTED',
        );
      }
      projected.limit = params.limit;
    }
    return projected;
  }
  if (method === 'thread/backgroundTerminals/clean') {
    return { threadId: threadId() };
  }
  throw new CodexAppServerError(
    'app-server request projection is missing',
    'CODEX_RPC_REJECTED',
  );
}

function mutationDeliveryError(
  pending,
  cause,
  provenance = faultProvenanceFrom(cause),
) {
  const code = pending.writeAttempted
    ? 'CODEX_RPC_OUTCOME_UNKNOWN'
    : 'CODEX_RPC_NOT_SENT';
  const message = pending.writeAttempted
    ? `app-server ${pending.method} outcome is unknown`
    : `app-server ${pending.method} was not sent`;
  const error = new CodexAppServerError(message, code, { cause });
  return defineFaultProvenance(error, provenance);
}

function sameFingerprint(left, right) {
  return Boolean(
    left
    && right
    && Object.keys(left).every((key) => left[key] === right[key])
    && Object.keys(right).every((key) => left[key] === right[key]),
  );
}

function sameOptionalFingerprint(left, right) {
  return (
    (left === null && right === null)
    || sameFingerprint(left, right)
  );
}

// Raw dispatch is module-scoped on purpose: it is absent from the supported
// public surface, so neither the internal flag nor the result projector can be
// forged through an options bag handed to request().
function dispatchRequest(client, method, params, {
  internal = false,
  projectResult = null,
  timeoutMs = client.requestTimeoutMs,
  onWriteAttempted,
  onResponseObserved,
} = {}) {
  const spec = CLIENT_REQUESTS.get(method);
  if (
    !spec
    || DENIED_CLIENT_REQUESTS.has(method)
    || (spec.internal && !internal)
  ) {
    return Promise.reject(new CodexAppServerError(
      'app-server request method is not allowlisted',
      'CODEX_RPC_REJECTED',
    ));
  }
  if (client.protocolError) return Promise.reject(client.protocolError);
  // initialize is the one request that runs before readiness; every other
  // internal request is held to the same readiness gate as a public one.
  const requiredState = method === 'initialize' ? 'initializing' : 'ready';
  if (client.state !== requiredState) {
    return Promise.reject(new CodexAppServerError(
      'app-server client is not ready',
      'CODEX_CLIENT_STATE',
    ));
  }
  let projectedParams;
  try {
    projectedParams = projectRequestParams(method, params, spec, client.cwd);
    assertPositiveInteger(timeoutMs, 'request timeout');
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    spec.stateChanging
    && (
      typeof onWriteAttempted !== 'function'
      || typeof onResponseObserved !== 'function'
    )
  ) {
    return Promise.reject(new CodexAppServerError(
      `app-server ${method} requires delivery checkpoints`,
      'CODEX_RPC_REJECTED',
    ));
  }
  if (!client._stdinWritable()) {
    const cause = new CodexAppServerError(
      'app-server stdin is not writable',
      'CODEX_TRANSPORT_ERROR',
    );
    return Promise.reject(
      spec.stateChanging
        ? mutationDeliveryError({ method, writeAttempted: false }, cause)
        : cause,
    );
  }
  if (client.pending.size >= client.maxPendingRequests) {
    return Promise.reject(new CodexAppServerError(
      'app-server pending request limit reached',
      'CODEX_RPC_REJECTED',
    ));
  }
  if (client.usedRequestIds.size >= client.maxUsedRequestIds) {
    const error = new CodexAppServerError(
      'app-server request ID space is exhausted for this generation',
      'CODEX_REQUEST_ID_EXHAUSTED',
    );
    client._fault(error);
    return Promise.reject(error);
  }

  let id;
  try {
    id = client.requestIdFactory
      ? client.requestIdFactory(client.nextRequestId)
      : client.nextRequestId;
    client.nextRequestId += 1;
    assertRequestId(id);
    if (client.usedRequestIds.has(id)) {
      throw new CodexAppServerError(
        'app-server request ID was reused',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    client.usedRequestIds.add(id);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const pending = {
      id,
      method,
      stateChanging: spec.stateChanging,
      writeAttempted: false,
      onWriteAttempted,
      onResponseObserved,
      resolve,
      reject,
      timer: null,
      sinkController: null,
    };
    pending.timer = client.setTimer(() => {
      if (client.pending.get(id) !== pending) return;
      const timeoutError = new CodexAppServerError(
        `app-server ${method} timed out`,
        'CODEX_RPC_TIMEOUT',
      );
      if (pending.stateChanging && pending.writeAttempted) {
        client._fault(timeoutError);
        return;
      }
      pending.sinkController?.abort(timeoutError);
      client.pending.delete(id);
      reject(
        pending.stateChanging
          ? mutationDeliveryError(pending, timeoutError)
          : timeoutError,
      );
    }, timeoutMs);
    if (projectResult) RESULT_PROJECTORS.set(pending, projectResult);
    client.pending.set(id, pending);
    void client._dispatchRequest(pending, projectedParams);
  });
}

class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    for (const key of Object.keys(options)) {
      if (!CONSTRUCTOR_KEYS.has(key)) {
        throw new TypeError(`CodexAppServerClient: unknown option ${key}`);
      }
    }
    const {
      binary,
      cwd,
      codexHome,
      env = process.env,
      spawnFn = spawn,
      killFn = process.kill.bind(process),
      setTimer = setTimeout,
      clearTimer = clearTimeout,
      requestIdFactory = null,
      hookManifest = null,
      onNotification = async () => {},
      onFault,
      attestBinaryFn = attestPinnedCodexBinary,
      attestCodexHomeFn = attestPinnedCodexHome,
      attestSessionLauncherFn = attestPinnedSessionLauncher,
      sessionLauncher = null,
      expectedSessionLauncherSha256 = null,
      expectedConfigSha256,
      requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      sinkTimeoutMs = DEFAULT_SINK_TIMEOUT_MS,
      closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
      closeKillMs = DEFAULT_CLOSE_KILL_MS,
      maxLineBytes = DEFAULT_MAX_LINE_BYTES,
      maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
      maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
      maxUsedRequestIds = DEFAULT_MAX_USED_REQUEST_IDS,
      maxQueuedLines = DEFAULT_MAX_QUEUED_LINES,
      maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
    } = options;
    assertAbsolute(binary, 'binary');
    assertAbsolute(cwd, 'cwd');
    assertAbsolute(codexHome, 'codexHome');
    if (sessionLauncher !== null) assertAbsolute(sessionLauncher, 'sessionLauncher');
    if (
      (sessionLauncher === null) !== (expectedSessionLauncherSha256 === null)
      || (
        expectedSessionLauncherSha256 !== null
        && !/^[a-f0-9]{64}$/.test(expectedSessionLauncherSha256)
      )
    ) {
      throw new TypeError(
        'CodexAppServerClient: session launcher path and SHA-256 must be paired',
      );
    }
    if (
      typeof expectedConfigSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(expectedConfigSha256)
    ) {
      throw new TypeError(
        'CodexAppServerClient: expectedConfigSha256 must be a lowercase SHA-256',
      );
    }
    const targetReceipt = resolveCodexTargetPin();
    for (const [value, label] of [
      [cwd, 'cwd'],
      [codexHome, 'codexHome'],
    ]) {
      if (realpathSync(value) !== value) {
        throw new TypeError(
          `CodexAppServerClient: ${label} must be a canonical path`,
        );
      }
    }
    const workspaceStat = lstatSync(cwd);
    const credentialStat = lstatSync(codexHome);
    if (!workspaceStat.isDirectory()) {
      throw new TypeError('CodexAppServerClient: cwd must be a directory');
    }
    if (
      !credentialStat.isDirectory()
      || credentialStat.isSymbolicLink()
      || (
        typeof process.getuid === 'function'
        && credentialStat.uid !== process.getuid()
      )
      || (credentialStat.mode & 0o777) !== 0o700
      || isWithin(cwd, codexHome)
      || isWithin(codexHome, cwd)
    ) {
      throw new TypeError(
        'CodexAppServerClient: codexHome must be a separate owned 0700 directory',
      );
    }
    for (const [value, label] of [
      [spawnFn, 'spawnFn'],
      [killFn, 'killFn'],
      [setTimer, 'setTimer'],
      [clearTimer, 'clearTimer'],
      [onNotification, 'onNotification'],
      [onFault, 'onFault'],
      [attestBinaryFn, 'attestBinaryFn'],
      [attestCodexHomeFn, 'attestCodexHomeFn'],
      [attestSessionLauncherFn, 'attestSessionLauncherFn'],
    ]) {
      if (typeof value !== 'function') {
        throw new TypeError(`CodexAppServerClient: ${label} must be a function`);
      }
    }
    if (requestIdFactory !== null && typeof requestIdFactory !== 'function') {
      throw new TypeError('CodexAppServerClient: requestIdFactory must be a function');
    }
    for (const [value, label] of [
      [requestTimeoutMs, 'requestTimeoutMs'],
      [sinkTimeoutMs, 'sinkTimeoutMs'],
      [closeGraceMs, 'closeGraceMs'],
      [closeKillMs, 'closeKillMs'],
    ]) {
      assertTimerDelay(value, label);
    }
    // close waits out the supervisor's whole escalation in one timer.
    if (closeGraceMs + closeKillMs > MAX_TIMER_DELAY_MS) {
      throw new TypeError(
        'CodexAppServerClient: closeGraceMs + closeKillMs must not exceed '
        + `${MAX_TIMER_DELAY_MS}`,
      );
    }
    for (const [value, label] of [
      [maxLineBytes, 'maxLineBytes'],
      [maxStderrBytes, 'maxStderrBytes'],
      [maxPendingRequests, 'maxPendingRequests'],
      [maxUsedRequestIds, 'maxUsedRequestIds'],
      [maxQueuedLines, 'maxQueuedLines'],
      [maxQueuedBytes, 'maxQueuedBytes'],
    ]) {
      assertPositiveInteger(value, label);
    }

    Object.assign(this, {
      binary,
      cwd,
      codexHome,
      spawnFn,
      killFn,
      setTimer,
      clearTimer,
      requestIdFactory,
      onNotification,
      onFault,
      attestBinaryFn,
      attestCodexHomeFn,
      attestSessionLauncherFn,
      sessionLauncher,
      expectedSessionLauncherSha256,
      targetReceipt,
      expectedConfigSha256,
      requestTimeoutMs,
      sinkTimeoutMs,
      closeGraceMs,
      closeKillMs,
      maxLineBytes,
      maxStderrBytes,
      maxPendingRequests,
      maxUsedRequestIds,
      maxQueuedLines,
      maxQueuedBytes,
    });
    // Fixed for the client's life: a caller that could pass or replace a
    // manifest later could narrow what a session claims to have verified.
    Object.defineProperty(this, 'hookManifest', {
      value: normalizeHookManifest(hookManifest),
      writable: false,
      configurable: false,
      enumerable: true,
    });
    this.env = buildCodexAppServerEnv(codexHome, env);
    this.state = 'new';
    this.child = null;
    this.startPromise = null;
    this.closePromise = null;
    this.exitPromise = null;
    this.exitInfo = null;
    this.protocolError = null;
    this.faultPromise = null;
    this.faultOutcome = null;
    this.faultProvenance = null;
    this.faultWaitPromise = new Promise((resolve, reject) => {
      this.resolveFaultWait = resolve;
      this.rejectFaultWait = reject;
    });
    this.faultWaitPromise.catch(() => {});
    this.sinkGeneration = 0;
    this.activeSinkControllers = new Set();
    this.pending = new Map();
    this.usedRequestIds = new Set();
    this.nextRequestId = 1;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrBytes = 0;
    this.messageChain = Promise.resolve();
    this.queuedLineCount = 0;
    this.queuedLineBytes = 0;
    this.stdoutPaused = false;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    return this.startPromise;
  }

  async _start() {
    if (this.state !== 'new') {
      throw new CodexAppServerError(
        'app-server start is only valid once',
        'CODEX_CLIENT_STATE',
      );
    }
    this.state = 'starting';
    const args = ['app-server', '--strict-config', '--stdio'];
    const command = process.execPath;
    const commandArgs = [
      SUPERVISOR_PATH,
      `--group-term-grace-ms=${this.closeGraceMs}`,
      ...(this.sessionLauncher
        ? [`--session-launcher=${this.sessionLauncher}`]
        : []),
      this.binary,
      ...args,
    ];
    try {
      const [attestation, homeAttestation, launcherAttestation] = await Promise.all([
        this.attestBinaryFn(this.binary, this.targetReceipt),
        this.attestCodexHomeFn(
          this.codexHome,
          this.expectedConfigSha256,
        ),
        this.sessionLauncher
          ? this.attestSessionLauncherFn(
            this.sessionLauncher,
            this.expectedSessionLauncherSha256,
          )
          : null,
      ]);
      if (
        !attestation
        || attestation.path !== this.binary
        || attestation.target !== this.targetReceipt.target
        || attestation.sha256 !== this.targetReceipt.binarySha256
        || attestation.version !== this.targetReceipt.cliVersion
      ) {
        throw new CodexAppServerError(
          'pinned Codex binary attestation was inconsistent',
          'CODEX_BINARY_MISMATCH',
        );
      }
      if (
        this.sessionLauncher
        && (
          launcherAttestation?.path !== this.sessionLauncher
          || launcherAttestation.sha256
            !== this.expectedSessionLauncherSha256
        )
      ) {
        throw new CodexAppServerError(
          'session launcher attestation was inconsistent',
          'CODEX_SESSION_LAUNCHER_MISMATCH',
        );
      }
      if (
        !homeAttestation
        || homeAttestation.path !== this.codexHome
        || homeAttestation.configSha256 !== this.expectedConfigSha256
        || !homeAttestation.configFingerprint
      ) {
        throw new CodexAppServerError(
          'pinned Codex credential home attestation was inconsistent',
          'CODEX_CONFIG_MISMATCH',
        );
      }
      if (this.state !== 'starting') {
        throw new CodexAppServerError(
          'app-server start was cancelled before spawn',
          'CODEX_CLIENT_CLOSED',
        );
      }
      this.child = this.spawnFn(command, commandArgs, {
        cwd: this.cwd,
        env: this.env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this._attachChild();
      if (
        attestation.fingerprint
        && !sameFingerprint(attestation.fingerprint, binaryFingerprint(this.binary))
      ) {
        throw new CodexAppServerError(
          'pinned Codex binary changed during spawn',
          'CODEX_BINARY_MISMATCH',
        );
      }
      if (launcherAttestation?.fingerprint) {
        let currentLauncherFingerprint;
        try {
          currentLauncherFingerprint = pathFingerprint(this.sessionLauncher);
        } catch (cause) {
          throw new CodexAppServerError(
            'session launcher changed during spawn',
            'CODEX_SESSION_LAUNCHER_MISMATCH',
            { cause },
          );
        }
        if (!sameFingerprint(
          launcherAttestation.fingerprint,
          currentLauncherFingerprint,
        )) {
          throw new CodexAppServerError(
            'session launcher changed during spawn',
            'CODEX_SESSION_LAUNCHER_MISMATCH',
          );
        }
      }
      const afterSpawnHome = await this.attestCodexHomeFn(
        this.codexHome,
        this.expectedConfigSha256,
      );
      if (
        !afterSpawnHome
        || afterSpawnHome.path !== this.codexHome
        || afterSpawnHome.configSha256 !== this.expectedConfigSha256
        || !sameFingerprint(
          homeAttestation.configFingerprint,
          afterSpawnHome.configFingerprint,
        )
        || !sameOptionalFingerprint(
          homeAttestation.authFingerprint,
          afterSpawnHome.authFingerprint,
        )
      ) {
        throw new CodexAppServerError(
          'pinned Codex credential state changed during spawn',
          'CODEX_CONFIG_MISMATCH',
        );
      }
      this.state = 'initializing';
      const result = await dispatchRequest(this, 'initialize', {
        clientInfo: {
          name: 'orchestra',
          title: 'Orchestra',
          version: '0.5.0',
        },
        capabilities: { experimentalApi: true },
      }, { internal: true });
      if (result?.codexHome !== this.codexHome) {
        throw new CodexAppServerError(
          'app-server initialized with an unexpected credential home',
          'CODEX_CONFIG_MISMATCH',
        );
      }
      await this._writeMessage({ method: 'initialized' });
      this.state = 'ready';
      return this;
    } catch (error) {
      this._fault(error);
      throw error;
    }
  }

  _attachChild() {
    const child = this.child;
    if (
      !child
      || !child.stdin
      || !child.stdout
      || !child.stderr
      || typeof child.once !== 'function'
    ) {
      throw new TypeError('CodexAppServerClient: spawnFn returned an invalid child');
    }
    this.exitPromise = new Promise((resolve) => {
      let observed = false;
      const observeExit = (code, signal) => {
        if (observed) return;
        observed = true;
        this.exitInfo = { code, signal };
        try { this.emit('exit', this.exitInfo); } catch {}
      };
      child.once('exit', observeExit);
      child.once('close', (code, signal) => {
        observeExit(code, signal);
        resolve(this.exitInfo);
        if (this.state !== 'closing' && this.state !== 'closed') {
          this._enqueueTerminalFault(new CodexAppServerError(
            'app-server exited unexpectedly',
            'CODEX_PROCESS_EXITED',
          ));
        }
      });
    });
    child.stdout.on('data', (chunk) => this._onStdoutData(chunk));
    child.stdout.once('end', () => this._onStdoutEnd());
    child.stdout.once('error', (error) => this._transportFault(
      'app-server stdout failed',
      error,
    ));
    child.stderr.on('data', (chunk) => this._onStderrData(chunk));
    child.stderr.once('error', (error) => this._transportFault(
      'app-server stderr failed',
      error,
    ));
    child.stdin.on('error', (error) => {
      this._transportFault('app-server stdin failed', error);
    });
    child.once('error', (error) => {
      if (this.state !== 'closing' && this.state !== 'closed') {
        this._fault(new CodexAppServerError(
          'app-server process failed',
          'CODEX_PROCESS_ERROR',
          { cause: error },
        ));
      }
    });
  }

  request(method, params, {
    timeoutMs = this.requestTimeoutMs,
    onWriteAttempted,
    onResponseObserved,
  } = {}) {
    return dispatchRequest(this, method, params, {
      timeoutMs,
      onWriteAttempted,
      onResponseObserved,
    });
  }

  // The only supported path to hooks/list. It answers with ordinals, hashes,
  // statuses and enablement for the manifest it was built with, and nothing
  // else: the raw inventory is reduced where it is parsed and never reaches
  // this frame.
  verifyHooks(options = {}) {
    const manifest = this.hookManifest;
    if (
      !options
      || typeof options !== 'object'
      || Array.isArray(options)
      || JSON.stringify(Object.keys(options)) !== JSON.stringify(['phase'])
      || !Object.hasOwn(HOOK_PHASES, options.phase)
      || !manifest
    ) {
      return Promise.reject(new CodexAppServerError(
        'app-server hook verification is unavailable for this client',
        'CODEX_HOOK_TRUST_UNVERIFIED',
      ));
    }
    const { phase } = options;
    return dispatchRequest(this, 'hooks/list', { cwds: [manifest.ownedCwd] }, {
      internal: true,
      projectResult: (raw) => projectHookInventory(raw, manifest, phase),
    });
  }

  async _dispatchRequest(pending, params) {
    try {
      const message = { id: pending.id, method: pending.method };
      if (params !== undefined) message.params = params;
      const line = this._serializeMessage(message);
      if (pending.stateChanging) {
        const controller = new AbortController();
        pending.sinkController = controller;
        try {
          await this._runSink(
            pending.onWriteAttempted,
            {
              id: pending.id,
              method: pending.method,
            },
            'write checkpoint',
            controller,
            {
              markWriteCommitted: () => {
                pending.writeAttempted = true;
              },
            },
          );
        } finally {
          if (pending.sinkController === controller) {
            pending.sinkController = null;
          }
        }
        if (this.pending.get(pending.id) !== pending) return;
        pending.writeAttempted = true;
      }
      await this._writeLine(line);
    } catch (error) {
      if (this.pending.get(pending.id) !== pending) return;
      if (pending.stateChanging && pending.writeAttempted) {
        this._fault(error);
        return;
      }
      this.pending.delete(pending.id);
      this.clearTimer(pending.timer);
      pending.reject(
        pending.stateChanging
          ? mutationDeliveryError(pending, error)
          : error,
      );
    }
  }

  _serializeMessage(message) {
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      throw new CodexAppServerError(
        'app-server client message was not serializable',
        'CODEX_RPC_REJECTED',
        { cause: error },
      );
    }
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      throw new CodexAppServerError(
        'app-server client message exceeded the size limit',
        'CODEX_RPC_REJECTED',
      );
    }
    return line;
  }

  _writeMessage(message) {
    return this._writeLine(this._serializeMessage(message));
  }

  _writeLine(line) {
    if (this.protocolError) throw this.protocolError;
    if (!this._stdinWritable()) {
      throw new CodexAppServerError(
        'app-server stdin is not writable',
        'CODEX_TRANSPORT_ERROR',
      );
    }
    return this._awaitBounded(
      new Promise((resolve, reject) => {
        try {
          this.child.stdin.write(line, (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      }),
      'transport write',
    ).catch((error) => {
      if (error?.code === 'CODEX_SINK_TIMEOUT') throw error;
      throw transportWriteError(error);
    });
  }

  _awaitBounded(value, label) {
    let timer;
    return Promise.race([
      Promise.resolve(value),
      new Promise((resolve, reject) => {
        timer = this.setTimer(() => reject(new CodexAppServerError(
          `app-server ${label} timed out`,
          'CODEX_SINK_TIMEOUT',
        )), this.sinkTimeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) this.clearTimer(timer);
    });
  }

  _runSink(
    callback,
    payload,
    label,
    controller = new AbortController(),
    capabilities = {},
  ) {
    const generation = this.sinkGeneration;
    let active = true;
    const sinkPayload = { ...payload };
    const assertSinkActive = () => {
      if (
        !active
        || controller.signal.aborted
        || generation !== this.sinkGeneration
      ) {
        throw new CodexAppServerError(
          `app-server ${label} is no longer active`,
          'CODEX_SINK_ABORTED',
        );
      }
    };
    const properties = {
      signal: {
        value: controller.signal,
        enumerable: false,
      },
      assertActive: {
        value: assertSinkActive,
        enumerable: false,
      },
    };
    for (const [name, capability] of Object.entries(capabilities)) {
      properties[name] = {
        value: (...args) => {
          assertSinkActive();
          return capability(...args);
        },
        enumerable: false,
      };
    }
    Object.defineProperties(sinkPayload, properties);
    this.activeSinkControllers.add(controller);
    let timer;
    let sinkPromise;
    try {
      sinkPromise = Promise.resolve(callback(sinkPayload));
    } catch (error) {
      sinkPromise = Promise.reject(error);
    }
    return Promise.race([
      sinkPromise,
      new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          active = false;
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new CodexAppServerError(
                  `app-server ${label} was aborted`,
                  'CODEX_SINK_ABORTED',
                ),
          );
        }, { once: true });
      }),
      new Promise((resolve, reject) => {
        timer = this.setTimer(() => {
          active = false;
          const timeoutError = new CodexAppServerError(
            `app-server ${label} timed out`,
            'CODEX_SINK_TIMEOUT',
          );
          controller.abort(timeoutError);
          reject(timeoutError);
        }, this.sinkTimeoutMs);
      }),
    ]).finally(() => {
      active = false;
      controller.abort();
      this.activeSinkControllers.delete(controller);
      if (timer !== undefined) this.clearTimer(timer);
    });
  }

  _invalidateSinks() {
    this.sinkGeneration += 1;
    for (const controller of this.activeSinkControllers) {
      controller.abort(new CodexAppServerError(
        'app-server sink generation was invalidated',
        'CODEX_SINK_ABORTED',
      ));
    }
    this.activeSinkControllers.clear();
  }

  _stdinWritable() {
    return (
      this.child
      && this.state !== 'closing'
      && this.state !== 'closed'
      && !this.exitInfo
      && this.child.stdin.writable !== false
      && this.child.stdin.destroyed !== true
    );
  }

  _onStdoutData(chunk) {
    if (
      this.state === 'closing'
      || this.state === 'closed'
      || this.protocolError
    ) return;
    this.stdoutBuffer += typeof chunk === 'string'
      ? chunk
      : this.stdoutDecoder.write(chunk);
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this._fault(new CodexAppServerError(
          'app-server line exceeded the size limit',
          'CODEX_PROTOCOL_ERROR',
        ));
        return;
      }
      const lineBytes = Buffer.byteLength(line);
      if (
        this.queuedLineCount + 1 > this.maxQueuedLines
        || this.queuedLineBytes + lineBytes > this.maxQueuedBytes
      ) {
        this._fault(new CodexAppServerError(
          'app-server inbound message queue exceeded the size limit',
          'CODEX_PROTOCOL_ERROR',
        ));
        return;
      }
      this.queuedLineCount += 1;
      this.queuedLineBytes += lineBytes;
      if (
        !this.stdoutPaused
        && this.child?.stdout
        && typeof this.child.stdout.pause === 'function'
        && (
          this.queuedLineCount >= Math.ceil(this.maxQueuedLines / 2)
          || this.queuedLineBytes >= Math.ceil(this.maxQueuedBytes / 2)
        )
      ) {
        this.child.stdout.pause();
        this.stdoutPaused = true;
      }
      this.messageChain = this.messageChain
        .then(async () => {
          this.queuedLineCount -= 1;
          this.queuedLineBytes -= lineBytes;
          this._resumeStdoutIfSafe();
          if (
            this.protocolError
            || this.state === 'closing'
            || this.state === 'closed'
          ) return;
          await this._handleLine(line);
        })
        .catch((error) => this._fault(error));
    }
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxLineBytes) {
      this._fault(new CodexAppServerError(
        'app-server partial line exceeded the size limit',
        'CODEX_PROTOCOL_ERROR',
      ));
    }
  }

  _onStdoutEnd() {
    const trailing = this.stdoutBuffer + this.stdoutDecoder.end();
    this.stdoutBuffer = '';
    this._enqueueTerminalFault(new CodexAppServerError(
      trailing.length > 0
        ? 'app-server output ended with a partial message'
        : 'app-server output closed unexpectedly',
      'CODEX_PROTOCOL_ERROR',
    ));
  }

  _resumeStdoutIfSafe() {
    if (
      !this.stdoutPaused
      || this.protocolError
      || this.state === 'closing'
      || this.state === 'closed'
    ) return;
    if (
      this.queuedLineCount < Math.ceil(this.maxQueuedLines / 2)
      && this.queuedLineBytes < Math.ceil(this.maxQueuedBytes / 2)
    ) {
      this.child?.stdout?.resume?.();
      this.stdoutPaused = false;
    }
  }

  _enqueueTerminalFault(error) {
    if (
      this.state === 'closing'
      || this.state === 'closed'
      || this.protocolError
    ) return;
    this.messageChain = this.messageChain
      .then(() => {
        if (
          this.state !== 'closing'
          && this.state !== 'closed'
          && !this.protocolError
        ) this._fault(error);
      })
      .catch((cause) => this._fault(cause));
  }

  _transportFault(message, cause) {
    if (this.state === 'closing' || this.state === 'closed') return;
    this._enqueueTerminalFault(new CodexAppServerError(
      message,
      'CODEX_TRANSPORT_ERROR',
      { cause },
    ));
  }

  _onStderrData(chunk) {
    this.stderrBytes += Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(String(chunk));
    if (this.stderrBytes > this.maxStderrBytes) {
      this._fault(faultWithClass(new CodexAppServerError(
        'app-server stderr exceeded the size limit',
        'CODEX_PROTOCOL_ERROR',
      ), 'stderr-limit'));
    }
  }

  async _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new CodexAppServerError(
        'app-server emitted malformed JSON',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new CodexAppServerError(
        'app-server emitted a malformed message',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (Object.hasOwn(message, 'jsonrpc')) {
      throw new CodexAppServerError(
        'app-server emitted unsupported JSON-RPC framing',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    const hasId = Object.hasOwn(message, 'id');
    const hasMethod = Object.hasOwn(message, 'method');
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    const keysAllowed = (allowed) => (
      Object.keys(message).every((key) => allowed.includes(key))
    );
    if (hasId) assertRequestId(message.id);
    if (
      hasMethod
      && (
        typeof message.method !== 'string'
        || !SAFE_METHOD_PATTERN.test(message.method)
      )
    ) {
      throw new CodexAppServerError(
        'app-server emitted a malformed method',
        'CODEX_PROTOCOL_ERROR',
      );
    }

    if (hasId && hasMethod) {
      if (hasResult || hasError || !keysAllowed(['id', 'method', 'params'])) {
        throw new CodexAppServerError(
          'app-server emitted an ambiguous server request',
          'CODEX_PROTOCOL_ERROR',
        );
      }
      const denial = DENIED_SERVER_REQUESTS.get(message.method);
      if (!denial) {
        throw new CodexAppServerError(
          'app-server sent an unknown server request',
          'CODEX_PROTOCOL_ERROR',
        );
      }
      await this._writeMessage({ id: message.id, ...denial });
      try { this.emit('server-request-denied', { known: true }); } catch {}
      throw new CodexAppServerError(
        'app-server sent a disabled server request',
        'CODEX_SERVER_REQUEST_DENIED',
      );
    }

    if (hasId) {
      if (
        hasMethod
        || hasResult === hasError
        || !keysAllowed(hasResult ? ['id', 'result'] : ['id', 'error'])
      ) {
        return this._handleMalformedResponse(message.id);
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        throw new CodexAppServerError(
          'app-server returned an unexpected response ID',
          'CODEX_PROTOCOL_ERROR',
        );
      }
      let projectedResult;
      let projectedError;
      try {
        if (hasResult) {
          const projectResult = RESULT_PROJECTORS.get(pending);
          projectedResult = typeof projectResult === 'function'
            ? projectResult(message.result)
            : projectRpcResult(pending.method, message.result, this.cwd);
        } else {
          projectedError = projectRpcError(message.error);
        }
      } catch (error) {
        this._fault(error);
        return;
      }
      this.clearTimer(pending.timer);
      try {
        if (pending.stateChanging) {
          const controller = new AbortController();
          pending.sinkController = controller;
          try {
            await this._runSink(
              pending.onResponseObserved,
              {
                id: pending.id,
                method: pending.method,
                outcome: hasResult ? 'result' : 'error',
              },
              'response checkpoint',
              controller,
            );
          } finally {
            if (pending.sinkController === controller) {
              pending.sinkController = null;
            }
          }
        }
      } catch (error) {
        if (this.pending.get(message.id) === pending) {
          this.pending.delete(message.id);
          const checkpointError = new CodexAppServerError(
            'app-server response checkpoint failed',
            'CODEX_RPC_CHECKPOINT_FAILED',
            { cause: error },
          );
          pending.reject(checkpointError);
          this._fault(checkpointError);
        }
        return;
      }
      if (this.pending.get(message.id) !== pending) return;
      this.pending.delete(message.id);
      if (hasError) {
        const error = new CodexAppServerError(
          `app-server ${pending.method} failed`,
          'CODEX_RPC_ERROR',
        );
        error.rpcCode = projectedError.code;
        if (
          RECOGNIZED_RPC_ERRORS.get(pending.method)
            ?.has(projectedError.message)
        ) {
          error.rpcMessage = projectedError.message;
        }
        pending.reject(error);
      } else {
        pending.resolve(projectedResult);
      }
      return;
    }

    if (
      !hasMethod
      || hasResult
      || hasError
      || !keysAllowed(['method', 'params', 'emittedAtMs'])
      || (
        Object.hasOwn(message, 'emittedAtMs')
        && (
          !Number.isSafeInteger(message.emittedAtMs)
          || message.emittedAtMs < 0
        )
      )
    ) {
      throw new CodexAppServerError(
        'app-server emitted a malformed notification',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (DROPPED_NOTIFICATIONS.has(message.method)) return;
    if (!DELIVERED_NOTIFICATIONS.has(message.method)) {
      throw new CodexAppServerError(
        'app-server sent an unexpected server notification',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    await this._runSink(
      this.onNotification,
      projectNotification(message, this.cwd),
      'notification sink',
    );
  }

  _handleMalformedResponse(id) {
    const pending = this.pending.get(id);
    if (!pending) {
      throw new CodexAppServerError(
        'app-server returned an unexpected response ID',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    this.clearTimer(pending.timer);
    const malformed = new CodexAppServerError(
      `app-server ${pending.method} returned a malformed response`,
      'CODEX_PROTOCOL_ERROR',
    );
    this._fault(malformed);
  }

  _fault(error) {
    if (this.protocolError || this.state === 'closed') return;
    let fault = error instanceof Error
      ? error
      : new CodexAppServerError(
        'app-server protocol failed',
        'CODEX_PROTOCOL_ERROR',
      );
    const provenance = faultProvenanceFrom(fault);
    this.faultProvenance = provenance;
    fault = defineFaultProvenance(fault, provenance);
    const ambiguousMutation = this._rejectAll(fault, provenance);
    this.protocolError = ambiguousMutation ?? fault;
    this._invalidateSinks();
    try { this.emit('protocol-error', this.protocolError); } catch {}
    if (this.state !== 'closing') this.state = 'faulted';
    const postSpawn = Boolean(this.child);
    this.faultPromise = this._settleFault(postSpawn);
    this.faultPromise.then(this.resolveFaultWait, this.rejectFaultWait);
    this.faultPromise.catch(() => {});
  }

  async _settleFault(postSpawn) {
    let cleanupError = null;
    try {
      await this.close();
    } catch (error) {
      cleanupError = error;
    }
    const outcome = Object.freeze({
      kind: 'codex-app-server-fault',
      boundary: postSpawn ? 'post-spawn' : 'pre-spawn',
      containment: postSpawn ? 'unverified' : 'safe',
      cleanup: cleanupError ? 'failed' : 'completed',
      errorCode: this.protocolError?.code ?? 'CODEX_PROTOCOL_ERROR',
      cleanupErrorCode: cleanupError?.code ?? null,
      clientRootErrorCode: this.faultProvenance?.clientRootErrorCode ?? 'unknown',
      clientFaultClass: this.faultProvenance?.clientFaultClass ?? 'unknown',
      mutationOutcomeUnknown:
        this.protocolError?.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
    });
    try {
      await this._runSink(this.onFault, outcome, 'fault checkpoint');
    } catch (error) {
      const handoffError = new CodexAppServerError(
        'app-server fault checkpoint failed',
        'CODEX_FAULT_CHECKPOINT_FAILED',
        { cause: error },
      );
      try { this.emit('fault-checkpoint-error', handoffError); } catch {}
      throw handoffError;
    }
    this.faultOutcome = outcome;
    try { this.emit('fault-outcome', outcome); } catch {}
    return outcome;
  }

  waitForFault() {
    return this.faultWaitPromise;
  }

  _rejectAll(cause, provenance = faultProvenanceFrom(cause)) {
    let ambiguousMutation = null;
    for (const pending of this.pending.values()) {
      this.clearTimer(pending.timer);
      pending.sinkController?.abort(cause);
      const requestError = pending.stateChanging
        ? mutationDeliveryError(pending, cause, provenance)
        : cause;
      if (
        requestError.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
        && ambiguousMutation === null
      ) ambiguousMutation = requestError;
      pending.reject(requestError);
    }
    this.pending.clear();
    return ambiguousMutation;
  }

  assertHealthy() {
    if (this.protocolError) throw this.protocolError;
    if (this.state !== 'ready') {
      throw new CodexAppServerError(
        'app-server client is not ready',
        'CODEX_CLIENT_STATE',
      );
    }
  }

  _childAlive() {
    return Boolean(
      this.child
      && !this.exitInfo
      && this.child.exitCode == null
      && this.child.signalCode == null,
    );
  }

  _waitForExit(timeoutMs) {
    let timer;
    return Promise.race([
      this.exitPromise,
      new Promise((resolve) => {
        timer = this.setTimer(() => resolve(null), timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) this.clearTimer(timer);
    });
  }

  _delay(timeoutMs) {
    return new Promise((resolve) => {
      this.setTimer(resolve, timeoutMs);
    });
  }

  _ownsProcessGroup() {
    return Number.isSafeInteger(this.child?.pid) && this.child.pid >= 2;
  }

  _cleanupUnverified(message, cause) {
    return new CodexAppServerError(
      message,
      'CODEX_PROCESS_CLEANUP_UNVERIFIED',
      cause ? { cause } : undefined,
    );
  }

  // Runs only after the supervisor has exited, and only ever reads: a group id
  // whose leader is gone may be recycled, so signalling it could reach an
  // unrelated process group. ESRCH is the sole proof that the group is empty.
  async _proveOwnedGroupEmpty(timeoutMs) {
    if (!this._ownsProcessGroup()) {
      throw this._cleanupUnverified(
        'could not prove the owned app-server process group is empty',
      );
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        this.killFn(-this.child.pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return;
        throw this._cleanupUnverified(
          'could not read the owned app-server process group',
          error,
        );
      }
      if (Date.now() >= deadline) {
        throw this._cleanupUnverified(
          'the owned app-server process group still holds processes',
        );
      }
      await this._delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this._close();
    return this.closePromise;
  }

  async _close() {
    if (this.state === 'closed') return;
    this.state = 'closing';
    this._invalidateSinks();
    this._rejectAll(new CodexAppServerError(
      'app-server client closed',
      'CODEX_CLIENT_CLOSED',
    ));
    let cleanupError = null;
    if (this._childAlive()) {
      // Ending stdin is the whole shutdown request. Terminating the owned group
      // belongs to the supervisor: only the group's live leader can signal it
      // without racing its own exit and hitting a recycled group id.
      try { this.child.stdin.end(); } catch {}
      await this._waitForExit(this.closeGraceMs + this.closeKillMs);
    }
    if (this._childAlive()) {
      throw new CodexAppServerError(
        'app-server supervisor did not terminate the owned process group',
        'CODEX_PROCESS_CLOSE_TIMEOUT',
      );
    }
    // Nothing was ever spawned before a pre-spawn fault, so there is no owned
    // group to account for.
    if (this.child) {
      try {
        await this._proveOwnedGroupEmpty(this.closeKillMs);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    this.stdoutBuffer = '';
    this.state = 'closed';
    if (!this.protocolError) this.resolveFaultWait(null);
    if (cleanupError) throw cleanupError;
  }
}

module.exports = {
  CODEX_SUPERVISOR_GRACE_MS,
  CodexAppServerClient,
  CodexAppServerError,
  attestPinnedCodexBinary,
  attestPinnedCodexHome,
  attestPinnedSessionLauncher,
  characterizePinnedSessionLauncher,
  buildCodexAppServerEnv,
  normalizeCodexHookManifest: normalizeHookManifest,
  protocolSchema,
  resolveCodexTargetPin,
};
