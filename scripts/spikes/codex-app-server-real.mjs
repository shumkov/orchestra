#!/usr/bin/env node

import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  createReadStream,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import canonicalJson from '../../lib/canonical-json.js';
import { AppServerConnection } from './codex-app-server-rpc.mjs';

export { AppServerConnection } from './codex-app-server-rpc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  attestPinnedCodexBinary: attestProductionCodexBinary,
  protocolSchema: productionProtocolSchema,
} = require('../../lib/codex/app-server-client.js');
const fixtureDir = resolve(here, '../../tests/fixtures/codex-app-server-0.145.0');
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'));
const profileProvenanceFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'profile-provenance.json'), 'utf8'),
);
const interruptObservationFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'interrupt-observation.json'), 'utf8'),
);
const { canonicalizeToolInput } = canonicalJson;
const SUBPROCESS_TIMEOUT_MS = 60_000;
const PROFILE_LIST_MAX_PAGES = 100;
const BACKGROUND_TERMINAL_LIST_MAX_PAGES = 100;
const BACKGROUND_TERMINAL_MAX_POLLS = 20;
const MAX_RESUME_EVIDENCE_TURNS = 1_000;
const MAX_RESUME_EVIDENCE_ITEMS_PER_TURN = 1_000;
const TRACKED_TERMINAL_SLEEP_SECONDS = 120;
const PROCESS_CANARY_LIFETIME_MS = 90_000;
const SIDE_CHANNEL_TIMEOUT_MS = 10_000;
const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = 103;
const PROFILE_ID = 'polygram-session';
const CONTROLLED_PATH = '/usr/bin:/bin';
const DAEMON_SECRET_PROBE = '.orchestra-codex-u1a-deny-probe';
const STEERING_VALUES = ['U1A_STEER_ALPHA', 'U1A_STEER_BETA'];
const STEERING_CLIENT_IDS = ['u1a-steer-first', 'u1a-steer-second'];
const SAME_USER_SIDE_CHANNEL_GATE = (
  'same-user process, descriptor, Keychain, and local-socket isolation'
);
const BLOCKING_U1A_FINDINGS = [];

function parseArgs(argv) {
  const options = {
    binary: process.env.POLYGRAM_CODEX_BIN ?? '',
    launcher: process.env.ORCHESTRA_SESSION_LAUNCHER ?? '',
    codexHome: process.env.ORCHESTRA_CODEX_HOME ?? '',
    workspace: process.env.ORCHESTRA_CODEX_WORKSPACE ?? '',
    daemonSecretRoots: [],
  };
  let explicitDaemonRoots = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = argv[++index] ?? '';
    else if (arg === '--launcher') options.launcher = argv[++index] ?? '';
    else if (arg === '--codex-home') options.codexHome = argv[++index] ?? '';
    else if (arg === '--workspace') options.workspace = argv[++index] ?? '';
    else if (arg === '--daemon-secret-root') {
      if (!explicitDaemonRoots) {
        options.daemonSecretRoots = [];
        explicitDaemonRoots = true;
      }
      options.daemonSecretRoots.push(argv[++index] ?? '');
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!explicitDaemonRoots) {
    options.daemonSecretRoots = (
      process.env.ORCHESTRA_CODEX_DAEMON_SECRET_ROOTS ?? ''
    ).split(delimiter).filter(Boolean);
  }
  return options;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function canonicalJsonSha256(value) {
  return createHash('sha256')
    .update(canonicalizeToolInput(value))
    .digest('hex');
}

function validateExecutable(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const target = statSync(path);
  if (!target.isFile() || (target.mode & 0o111) === 0) {
    throw new Error(`${label} must be an executable regular file`);
  }

  const root = parse(path).root;
  let component = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    component = join(component, part);
    const stat = lstatSync(component);
    if (stat.uid !== 0 && stat.uid !== process.getuid?.()) {
      throw new Error(`${label} path chain contains an unexpected owner`);
    }
    if (stat.mode & 0o022) {
      throw new Error(`${label} path chain contains a group/world-writable component`);
    }
  }
  return target;
}

export async function attestPinnedCodexBinary(options) {
  if (
    productionProtocolSchema.binarySha256 !== manifest.binarySha256
    || productionProtocolSchema.cliVersion !== manifest.cliVersion
  ) throw new Error('production Codex binary pin differs from the U1 fixture');
  await attestProductionCodexBinary(options.binary);
  if (options.launcher) validateExecutable(options.launcher, 'session launcher');
  return true;
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function canonicalExistingPath(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const canonical = realpathSync(path);
  if (canonical !== path) throw new Error(`${label} must already be a canonical path`);
  return canonical;
}

function validatePrivateOwnedFile(path, label, optional = false) {
  let link;
  try {
    link = lstatSync(path);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return;
    throw error;
  }
  const target = statSync(path);
  if (link.isSymbolicLink() || !target.isFile()) {
    throw new Error(`${label} must be a real file`);
  }
  if ((target.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be group/world accessible`);
  }
  if (target.uid !== process.getuid?.()) {
    throw new Error(`${label} must be owned by the service user`);
  }
  if (target.nlink !== 1) {
    throw new Error(`${label} must not have hard-link aliases`);
  }
  return target;
}

export function validateCodexHome(path, options = {}) {
  const canonical = canonicalExistingPath(path, 'CODEX_HOME');
  const temporaryRoots = options.temporaryRoots ?? [
    tmpdir(),
    process.env.TMP,
    process.env.TEMP,
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/tmp',
  ].filter(Boolean).filter(existsSync).map((root) => realpathSync(root));
  if (temporaryRoots.some((root) => isWithin(root, canonical))) {
    throw new Error('CODEX_HOME must not be inside a temporary filesystem root');
  }

  const link = lstatSync(canonical);
  const target = statSync(canonical);
  if (link.isSymbolicLink() || !target.isDirectory()) {
    throw new Error('CODEX_HOME must be a real directory');
  }
  if ((target.mode & 0o777) !== 0o700) {
    throw new Error('CODEX_HOME permissions must be 0700');
  }
  if (target.uid !== process.getuid?.()) {
    throw new Error('CODEX_HOME must be owned by the service user');
  }

  const configPath = join(canonical, 'config.toml');
  validatePrivateOwnedFile(configPath, 'CODEX_HOME config.toml');
  validatePrivateOwnedFile(join(canonical, 'auth.json'), 'CODEX_HOME auth.json', true);
  return canonical;
}

function validateWorkspace(path, codexHome) {
  const canonical = canonicalExistingPath(path, 'workspace');
  if (!statSync(canonical).isDirectory()) throw new Error('workspace must be a directory');
  if (isWithin(codexHome, canonical) || isWithin(canonical, codexHome)) {
    throw new Error('workspace and CODEX_HOME must not contain one another');
  }
  return canonical;
}

export function validateDaemonSecretRoots(paths, codexHome, workspace) {
  if (paths.length === 0) throw new Error('pass at least one --daemon-secret-root');
  const roots = [...new Set(paths.map((path) => (
    canonicalExistingPath(path, 'daemon secret root')
  )))];
  for (const root of roots) {
    if (!statSync(root).isDirectory()) throw new Error('daemon secret root must be a directory');
    if (
      isWithin(root, codexHome)
      || isWithin(codexHome, root)
      || isWithin(root, workspace)
      || isWithin(workspace, root)
    ) {
      throw new Error('daemon secret roots must be separate from CODEX_HOME and workspace');
    }
    const sentinel = validatePrivateOwnedFile(
      join(root, DAEMON_SECRET_PROBE),
      `daemon secret root ${DAEMON_SECRET_PROBE}`,
    );
    if (sentinel.size === 0) {
      throw new Error('daemon secret root sentinel must not be empty');
    }
    if ((sentinel.mode & 0o400) === 0) {
      throw new Error('daemon secret root sentinel must be owner-readable');
    }
    try {
      accessSync(join(root, DAEMON_SECRET_PROBE), constants.R_OK);
    } catch {
      throw new Error('daemon secret root sentinel must be readable by the service user');
    }
  }
  return roots;
}

function ownedProfileConfig(codexHome, workspace, daemonSecretRoots) {
  const filesystem = {
    ':minimal': 'read',
    [codexHome]: 'deny',
  };
  for (const root of daemonSecretRoots) filesystem[root] = 'deny';
  filesystem[':workspace_roots'] = { '.': 'write' };

  return {
    model_provider: 'openai',
    cli_auth_credentials_store: 'file',
    default_permissions: PROFILE_ID,
    approval_policy: 'never',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    shell_environment_policy: {
      inherit: 'none',
      ignore_default_excludes: false,
      set: {
        HOME: join(workspace, '.codex-command-home'),
        TMPDIR: join(workspace, '.codex-command-tmp'),
        PATH: CONTROLLED_PATH,
      },
    },
    permissions: {
      [PROFILE_ID]: {
        filesystem,
        network: { enabled: false },
      },
    },
    projects: {
      [workspace]: { trust_level: 'untrusted' },
    },
  };
}

function sameLayerName(actual, expected) {
  return actual?.type === expected.type
    && actual?.file === expected.file
    && (actual?.profile ?? null) === null;
}

export function attestNamedProfileConfig({
  configRead,
  requirements,
  codexHome,
  workspace,
  daemonSecretRoots,
  rawConfigSha256,
}) {
  const expected = ownedProfileConfig(codexHome, workspace, daemonSecretRoots);
  const layers = configRead?.layers;
  if (!Array.isArray(layers)) throw new Error('config/read omitted loaded layers');

  let userLayer;
  for (const layer of layers) {
    const type = layer?.name?.type;
    if (type === 'user') {
      if (userLayer) throw new Error('multiple user config layers are not allowed');
      userLayer = layer;
      continue;
    }
    if (type === 'system' && isDeepStrictEqual(layer?.config, {})) continue;
    throw new Error(`unexpected config layer type: ${type ?? 'unknown'}`);
  }
  if (!userLayer) throw new Error('owned user config layer is missing');

  const expectedLayerName = {
    type: 'user',
    file: join(codexHome, 'config.toml'),
    profile: null,
  };
  if (!sameLayerName(userLayer.name, expectedLayerName)) {
    throw new Error('owned user config source changed');
  }
  if (!isDeepStrictEqual(userLayer.config, expected)) {
    throw new Error('owned user config does not exactly match polygram-session');
  }

  const effective = configRead.config ?? {};
  const expectedProfile = expected.permissions[PROFILE_ID];
  const expectedEffective = {
    ...expected,
    shell_environment_policy: {
      ...expected.shell_environment_policy,
      exclude: null,
      include_only: null,
      experimental_use_profile: null,
    },
    permissions: {
      [PROFILE_ID]: {
        description: null,
        extends: null,
        workspace_roots: null,
        filesystem: {
          glob_scan_max_depth: null,
          ...expectedProfile.filesystem,
        },
        network: {
          ...expectedProfile.network,
          proxy_url: null,
          enable_socks5: null,
          socks_url: null,
          enable_socks5_udp: null,
          allow_upstream_proxy: null,
          dangerously_allow_non_loopback_proxy: null,
          dangerously_allow_all_unix_sockets: null,
          mode: null,
          domains: null,
          unix_sockets: null,
          allow_local_binding: null,
          mitm: null,
        },
      },
    },
  };
  for (const [key, value] of Object.entries(expectedEffective)) {
    if (!isDeepStrictEqual(effective[key], value)) {
      throw new Error(`effective config differs at ${key}`);
    }
  }
  if (effective.sandbox_mode != null || effective.sandbox_workspace_write != null) {
    throw new Error('legacy sandbox config is active');
  }
  if (
    !isDeepStrictEqual(effective.mcp_servers ?? {}, {})
    || !isDeepStrictEqual(effective.plugins ?? {}, {})
    || !isDeepStrictEqual(effective.marketplaces ?? {}, {})
    || !isDeepStrictEqual(effective.profiles ?? {}, {})
    || effective.apps != null
    || effective.skills != null
    || effective.tools != null
    || effective.profile != null
    || effective.include_apps_instructions === true
    || effective.hooks != null
  ) {
    throw new Error('unexpected MCP, app, tool, skill, plugin, profile, marketplace, or hook capability is active');
  }

  const origins = Object.entries(configRead.origins ?? {});
  if (origins.length === 0) throw new Error('config/read omitted source origins');
  for (const [, metadata] of origins) {
    if (
      !sameLayerName(metadata?.name, expectedLayerName)
      || metadata?.version !== userLayer.version
    ) {
      throw new Error('effective config has an unexpected source origin');
    }
  }
  const originKeys = origins.map(([key]) => key);
  const requiredOriginKeys = [
    'model_provider',
    'cli_auth_credentials_store',
    'default_permissions',
    'approval_policy',
    'approvals_reviewer',
    'web_search',
    'allow_login_shell',
    `permissions.${PROFILE_ID}.filesystem.:minimal`,
    `permissions.${PROFILE_ID}.network.enabled`,
    `projects.${workspace}.trust_level`,
    ...[codexHome, ...daemonSecretRoots].map(
      (root) => `permissions.${PROFILE_ID}.filesystem.${root}`,
    ),
  ];
  for (const key of requiredOriginKeys) {
    if (!originKeys.includes(key)) {
      throw new Error(`effective config origin missing for ${key}`);
    }
  }
  const requiredOriginNamespaces = [
    'shell_environment_policy.',
    `permissions.${PROFILE_ID}.filesystem.:workspace_roots.`,
  ];
  for (const namespace of requiredOriginNamespaces) {
    if (!originKeys.some((key) => key.startsWith(namespace))) {
      throw new Error(`effective config origin missing for ${namespace}`);
    }
  }

  if (requirements != null) {
    const allowedProfiles = requirements.allowedPermissionProfiles;
    if (allowedProfiles != null && allowedProfiles[PROFILE_ID] !== true) {
      throw new Error('requirements do not allow polygram-session');
    }
    if (
      requirements.defaultPermissions != null
      && requirements.defaultPermissions !== PROFILE_ID
    ) {
      throw new Error('requirements select a different default permission profile');
    }
    if (
      requirements.allowedApprovalPolicies != null
      && !requirements.allowedApprovalPolicies.includes('never')
    ) {
      throw new Error('requirements do not allow approval policy never');
    }
    if (
      requirements.allowedWebSearchModes != null
      && !requirements.allowedWebSearchModes.includes('disabled')
    ) {
      throw new Error('requirements do not allow disabled web search');
    }
  }

  return {
    rawConfigSha256: rawConfigSha256 ?? sha256(join(codexHome, 'config.toml')),
    effectivePolicySha256: canonicalJsonSha256(effective),
    layerVersion: userLayer.version,
    layerTypes: layers.map((layer) => layer.name.type),
  };
}

export async function attestConnectionPolicy(
  connection,
  options,
  rawConfigSha256,
  readConfigSha256 = () => sha256(join(options.codexHome, 'config.toml')),
) {
  if (readConfigSha256() !== rawConfigSha256) {
    throw new Error('owned config changed before connection attestation');
  }
  const configRead = await connection.request('config/read', {
    cwd: options.workspace,
    includeLayers: true,
  });
  const requirementsResult = await connection.request('configRequirements/read');
  const attestation = attestNamedProfileConfig({
    configRead,
    requirements: requirementsResult.requirements ?? null,
    codexHome: options.codexHome,
    workspace: options.workspace,
    daemonSecretRoots: options.daemonSecretRoots,
    rawConfigSha256,
  });
  if (readConfigSha256() !== rawConfigSha256) {
    throw new Error('owned config changed during connection attestation');
  }
  return attestation;
}

const NAMED_PROFILE_CHECKS = [
  'schemaHashesVerified',
  'stableProfileMethodsVerified',
  'configSourceAttested',
  'configUnchangedAtEnd',
  'requirementsAttested',
  'profileListed',
  'commandWorkspaceRead',
  'commandWorkspaceWrite',
  'commandCodexHomeDenied',
  'commandDaemonSecretsDenied',
  'commandNetworkDenied',
  'legacySandboxAbsent',
  'accountAuthenticated',
  'freshProfileProvenance',
  'resumeProfileProvenance',
  'resumableTurnCompleted',
  'noUnexpectedServerRequests',
];
const STEERING_CHECKS = [
  'completed',
  'activeTurnSteerMatched',
  'orderedSteersObserved',
  'finalSteerSemanticsObserved',
  'singleSleepCommandObserved',
  'noTurnErrors',
  'definiteStaleSteerRejected',
];

export function evaluateNamedProfileGate(evidence) {
  const failedChecks = NAMED_PROFILE_CHECKS.filter((check) => evidence[check] !== true);
  return {
    gate: failedChecks.length === 0 ? 'CONTINUE' : 'STOP',
    exitCode: failedChecks.length === 0 ? 0 : 2,
    failedChecks,
  };
}

export function evaluateSteeringGate(evidence) {
  const failedChecks = STEERING_CHECKS.filter((check) => evidence[check] !== true);
  return {
    gate: failedChecks.length === 0 ? 'CONTINUE' : 'STOP',
    exitCode: failedChecks.length === 0 ? 0 : 2,
    failedChecks,
  };
}

const SAME_USER_SIDE_CHANNEL_CHECKS = [
  ['processHostControl', (evidence) => evidence.processHostControl === true],
  [
    'processArgvDenied',
    (evidence) => evidence.processArgvInspectionExitCode === 0,
  ],
  ['debuggerHostControl', (evidence) => evidence.debuggerHostControl === true],
  [
    'debuggerDenied',
    (evidence) => (
      Number.isSafeInteger(evidence.debuggerExitCode)
      && evidence.debuggerExitCode !== 0
    ),
  ],
  ['keychainHostControl', (evidence) => evidence.keychainHostControl === true],
  ['keychainDenied', (evidence) => evidence.keychainExitCode === 0],
  ['tcpHostControl', (evidence) => evidence.tcpHostControl === true],
  [
    'tcpDenied',
    (evidence) => (
      Number.isSafeInteger(evidence.tcpExitCode)
      && evidence.tcpExitCode !== 0
      && evidence.tcpCanaryReached === false
    ),
  ],
  ['udpHostControl', (evidence) => evidence.udpHostControl === true],
  [
    'udpDenied',
    (evidence) => (
      Number.isSafeInteger(evidence.udpCommandExitCode)
      && evidence.udpCanaryReached === false
    ),
  ],
  ['dnsHostControl', (evidence) => evidence.dnsHostControl === true],
  [
    'dnsProtocolDenied',
    (evidence) => (
      Number.isSafeInteger(evidence.dnsCommandExitCode)
      && evidence.dnsCanaryReached === false
    ),
  ],
  [
    'unixSocketHostControl',
    (evidence) => evidence.unixSocketHostControl === true,
  ],
  [
    'unixSocketDenied',
    (evidence) => (
      Number.isSafeInteger(evidence.unixSocketExitCode)
      && evidence.unixSocketExitCode !== 0
      && evidence.unixSocketCanaryReached === false
    ),
  ],
  [
    'inheritedDescriptorHostControl',
    (evidence) => evidence.inheritedDescriptorHostControl === true,
  ],
  [
    'inheritedDescriptorDenied',
    (evidence) => evidence.inheritedDescriptorExitCode === 0,
  ],
  [
    'processCanaryCleanup',
    (evidence) => evidence.processCanaryCleanup === true,
  ],
  ['keychainCleanup', (evidence) => evidence.keychainCleanup === true],
];

export function evaluateSameUserSideChannelProbe(evidence) {
  const failedChecks = SAME_USER_SIDE_CHANNEL_CHECKS
    .filter(([, passed]) => !passed(evidence))
    .map(([name]) => name);
  return {
    gate: failedChecks.length === 0 ? 'CONTINUE' : 'STOP',
    exitCode: failedChecks.length === 0 ? 0 : 2,
    failedChecks,
  };
}

export function evaluateOverallU1aGate({
  namedProfileGate,
  steeringGate,
  trackedTerminalStopGate,
  sameUserSideChannelGate,
} = {}) {
  const gates = [
    ['named profile and authenticated enforcement', namedProfileGate],
    ['active-turn steering and definite stale rejection', steeringGate],
    ['turn interruption and tracked-terminal cleanup', trackedTerminalStopGate],
    [SAME_USER_SIDE_CHANNEL_GATE, sameUserSideChannelGate],
  ];
  const remainingU1aGates = gates
    .filter(([, result]) => result?.gate !== 'CONTINUE')
    .map(([name]) => name);
  const passed = (
    BLOCKING_U1A_FINDINGS.length === 0
    && remainingU1aGates.length === 0
  );
  return {
    gate: passed ? 'CONTINUE' : 'STOP',
    exitCode: passed ? 0 : 2,
    blockingU1aFindings: [...BLOCKING_U1A_FINDINGS],
    remainingU1aGates,
  };
}

export function runCommand(
  options,
  args,
  spawnOptions = {},
  timeoutMs = SUBPROCESS_TIMEOUT_MS,
) {
  const command = options.launcher || options.binary;
  const commandArgs = options.launcher ? [options.binary, ...args] : args;
  return spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...spawnOptions,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

export function buildSchemaGenerationArgs(out, experimental = false) {
  return [
    'app-server',
    'generate-json-schema',
    ...(experimental ? ['--experimental'] : []),
    '--out',
    out,
  ];
}

export function assertExperimentalTerminalSurfaces(
  clientRequestSchema,
  protocolSchema,
) {
  const methods = new Set(
    (clientRequestSchema.oneOf ?? [])
      .map((request) => request.properties?.method?.enum?.[0])
      .filter(Boolean),
  );
  for (const method of [
    'thread/settings/update',
    'thread/backgroundTerminals/list',
    'thread/backgroundTerminals/clean',
  ]) {
    if (!methods.has(method)) {
      throw new Error(`experimental app-server method missing: ${method}`);
    }
  }

  const definitions = protocolSchema.definitions?.v2 ?? {};
  const expectedDefinitions = {
    ThreadBackgroundTerminalsListParams: {
      required: ['threadId'],
      properties: ['cursor', 'limit', 'threadId'],
    },
    ThreadBackgroundTerminalsListResponse: {
      required: ['data'],
      properties: ['data', 'nextCursor'],
    },
    ThreadBackgroundTerminalsCleanParams: {
      required: ['threadId'],
      properties: ['threadId'],
    },
    ThreadBackgroundTerminalsCleanResponse: {
      required: [],
      properties: [],
    },
  };
  for (const [name, expected] of Object.entries(expectedDefinitions)) {
    const definition = definitions[name];
    if (definition?.type !== 'object') {
      throw new Error(`experimental terminal schema missing: ${name}`);
    }
    const required = [...(definition.required ?? [])].sort();
    const properties = Object.keys(definition.properties ?? {}).sort();
    if (
      !isDeepStrictEqual(required, [...expected.required].sort())
      || !isDeepStrictEqual(properties, [...expected.properties].sort())
    ) {
      throw new Error(`experimental terminal schema changed: ${name}`);
    }
  }
  return {
    settingsUpdate: true,
    list: true,
    clean: true,
  };
}

export function assertTransportCorrelationSurfaces(protocolSchema) {
  const definitions = protocolSchema.definitions ?? {};
  const nullableString = ['string', 'null'];
  for (const name of ['TurnStartParams', 'TurnSteerParams']) {
    const clientId = definitions[name]?.properties?.clientUserMessageId;
    if (!isDeepStrictEqual(clientId?.type, nullableString)) {
      throw new Error(`${name} omits clientUserMessageId correlation`);
    }
  }

  const resumeThread = definitions.ThreadResumeResponse?.properties?.thread;
  if (resumeThread?.$ref !== '#/definitions/Thread') {
    throw new Error('thread/resume response omits thread evidence');
  }
  const turns = definitions.Thread?.properties?.turns;
  if (
    turns?.type !== 'array'
    || turns.items?.$ref !== '#/definitions/Turn'
  ) {
    throw new Error('thread/resume thread omits turn evidence');
  }
  const userMessage = (definitions.ThreadItem?.oneOf ?? []).find(
    (definition) => definition?.title === 'UserMessageThreadItem',
  );
  if (
    !userMessage
    || !isDeepStrictEqual(
      userMessage.properties?.clientId?.type,
      nullableString,
    )
  ) {
    throw new Error('resume user message omits clientId correlation');
  }

  return {
    turnStartClientId: true,
    turnSteerClientId: true,
    resumeUserMessageClientId: true,
    semantics: 'correlation-only',
  };
}

export function findClientUserMessageEvidence(
  thread,
  clientUserMessageId,
  expectedTurnId = null,
) {
  if (
    typeof clientUserMessageId !== 'string'
    || clientUserMessageId === ''
    || Buffer.byteLength(clientUserMessageId) > 512
  ) {
    throw new Error('resume evidence client id is invalid');
  }
  if (
    expectedTurnId !== null
    && (
      typeof expectedTurnId !== 'string'
      || expectedTurnId === ''
      || Buffer.byteLength(expectedTurnId) > 512
    )
  ) {
    throw new Error('resume evidence expected turn id is invalid');
  }
  if (
    !thread
    || typeof thread !== 'object'
    || Array.isArray(thread)
    || !Array.isArray(thread.turns)
  ) {
    throw new Error('resume evidence omitted thread turns');
  }
  if (thread.turns.length > MAX_RESUME_EVIDENCE_TURNS) {
    throw new Error('resume evidence exceeded the turn limit');
  }

  const matches = [];
  for (const turn of thread.turns) {
    if (
      !turn
      || typeof turn !== 'object'
      || Array.isArray(turn)
      || !Array.isArray(turn.items)
    ) {
      throw new Error('resume evidence contained an invalid turn');
    }
    if (turn.items.length > MAX_RESUME_EVIDENCE_ITEMS_PER_TURN) {
      throw new Error('resume evidence exceeded the item limit');
    }
    for (const item of turn.items) {
      if (
        !item
        || typeof item !== 'object'
        || Array.isArray(item)
        || item.type !== 'userMessage'
      ) {
        continue;
      }
      if (
        item.clientId !== null
        && item.clientId !== undefined
        && typeof item.clientId !== 'string'
      ) {
        throw new Error('resume evidence contained an invalid client id');
      }
      if (item.clientId !== clientUserMessageId) continue;
      if (
        typeof turn.id !== 'string'
        || turn.id === ''
        || Buffer.byteLength(turn.id) > 512
        || typeof turn.status !== 'string'
        || turn.status === ''
        || Buffer.byteLength(turn.status) > 64
      ) {
        throw new Error('resume evidence match had invalid turn metadata');
      }
      matches.push({ turnId: turn.id, turnStatus: turn.status });
    }
  }

  if (matches.length === 0) {
    return {
      status: 'unknown',
      matchCount: 0,
      turnId: null,
      turnStatus: null,
    };
  }
  if (matches.length > 1) {
    throw new Error('resume client id appeared multiple times');
  }
  if (
    expectedTurnId !== null
    && matches[0].turnId !== expectedTurnId
  ) {
    throw new Error('resume client id appeared in an unexpected turn');
  }
  return {
    status: 'observed',
    matchCount: 1,
    ...matches[0],
  };
}

function requireSuccess(result, operation) {
  if (result.error) throw new Error(`${operation} could not start: ${result.error.code ?? 'UNKNOWN'}`);
  if (result.signal) throw new Error(`${operation} ended by signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${operation} exited ${result.status}`);
}

function assertHash(path, expected, label) {
  const actual = sha256(path);
  if (actual !== expected) throw new Error(`${label} schema hash mismatch`);
}

function assertCanonicalHash(value, expected, label) {
  const actual = canonicalJsonSha256(value);
  if (actual !== expected) throw new Error(`${label} canonical schema hash mismatch`);
}

function assertStableProfileSurfaces(clientRequestSchema, protocolSchema) {
  const methods = new Set(
    (clientRequestSchema.oneOf ?? [])
      .map((request) => request.properties?.method?.enum?.[0])
      .filter(Boolean),
  );
  for (const method of [
    'initialize',
    'config/read',
    'configRequirements/read',
    'permissionProfile/list',
    'account/read',
    'command/exec',
    'thread/start',
    'thread/resume',
  ]) {
    if (!methods.has(method)) throw new Error(`stable app-server method missing: ${method}`);
  }

  const settings = protocolSchema.definitions?.ThreadSettings;
  if (!Object.hasOwn(settings?.properties ?? {}, 'activePermissionProfile')) {
    throw new Error('stable thread settings omit active permission profile provenance');
  }
  for (const definition of ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams']) {
    const properties = protocolSchema.definitions?.[definition]?.properties ?? {};
    if (Object.hasOwn(properties, 'permissions') || Object.hasOwn(properties, 'permissionProfile')) {
      throw new Error(`${definition} unexpectedly exposes an experimental profile selector`);
    }
  }
  return true;
}

export function sanitizedAppServerEnv(options) {
  return Object.fromEntries(
    Object.entries({
      HOME: process.env.HOME,
      PATH: CONTROLLED_PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      CODEX_HOME: options.codexHome,
    }).filter(([, value]) => value !== undefined),
  );
}

export async function initializeConnection(connection, expectedCodexHome) {
  const result = await connection.request('initialize', {
    clientInfo: {
      name: 'orchestra_codex_u1a',
      title: 'Orchestra Codex U1a',
      version: '0.0.0',
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  if (realpathSync(result.codexHome) !== expectedCodexHome) {
    throw new Error('app-server initialized with an unexpected CODEX_HOME');
  }
  connection.notify('initialized');
}

export function evaluateInterruptSettlement({
  interruptAccepted,
  interruptStale,
  terminalMatches,
  terminalStatus,
}) {
  const terminalIsSettled = ['completed', 'failed', 'interrupted'].includes(
    terminalStatus,
  );
  if (
    terminalMatches
    && terminalIsSettled
    && (interruptAccepted || interruptStale)
  ) {
    return {
      reconciled: true,
      reason: terminalStatus === 'interrupted'
        ? 'interrupted'
        : 'natural-terminal-won-race',
    };
  }
  return {
    reconciled: false,
    reason: interruptStale
      ? 'unmatched-stale-interrupt'
      : 'interrupt-terminal-unresolved',
  };
}

export async function waitForBackgroundTerminalsEmpty(
  connection,
  threadId,
  {
    maxPolls = BACKGROUND_TERMINAL_MAX_POLLS,
    pollDelayMs = 100,
  } = {},
) {
  if (!Number.isInteger(maxPolls) || maxPolls < 1) {
    throw new Error('background terminal maxPolls must be a positive integer');
  }
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const result = await connection.request('thread/backgroundTerminals/list', {
      threadId,
    });
    if (!Array.isArray(result?.data)) {
      throw new Error('background terminal list omitted data');
    }
    const nextCursor = result.nextCursor ?? null;
    if (
      nextCursor !== null
      && (typeof nextCursor !== 'string' || nextCursor === '')
    ) {
      throw new Error('background terminal list returned an invalid cursor');
    }
    if (result.data.length === 0) {
      if (nextCursor !== null) {
        throw new Error('background terminal empty page returned a cursor');
      }
      return true;
    }
    if (poll + 1 < maxPolls && pollDelayMs > 0) {
      await delay(pollDelayMs);
    }
  }
  throw new Error('background terminals did not become empty within the poll limit');
}

export async function listBackgroundTerminals(connection, threadId) {
  const terminals = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < BACKGROUND_TERMINAL_LIST_MAX_PAGES; page += 1) {
    const result = await connection.request('thread/backgroundTerminals/list', {
      threadId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) {
      throw new Error('background terminal list omitted data');
    }
    for (const entry of result.data) {
      if (
        !entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || typeof entry.itemId !== 'string'
        || entry.itemId === ''
        || typeof entry.processId !== 'string'
        || entry.processId === ''
        || typeof entry.command !== 'string'
        || typeof entry.cwd !== 'string'
        || (
          entry.osPid != null
          && (!Number.isSafeInteger(entry.osPid) || entry.osPid < 1)
        )
      ) {
        throw new Error('background terminal list returned an invalid terminal entry');
      }
    }
    terminals.push(...result.data);
    cursor = result.nextCursor ?? null;
    if (cursor === null) return terminals;
    if (typeof cursor !== 'string' || cursor === '') {
      throw new Error('background terminal list returned an invalid cursor');
    }
    if (seenCursors.has(cursor)) {
      throw new Error('background terminal pagination repeated a cursor');
    }
    seenCursors.add(cursor);
  }
  throw new Error('background terminal pagination exceeded the page limit');
}

const TRACKED_TERMINAL_STOP_CHECKS = [
  'commandStarted',
  'markerObserved',
  'terminalReconciled',
  'listedAfterTerminal',
  'commandAliveAfterTerminal',
  'cleanAccepted',
  'freshFirstPageEmpty',
  'observedSyntheticPidDead',
];

export function evaluateTrackedTerminalStopGate(evidence) {
  const failedChecks = TRACKED_TERMINAL_STOP_CHECKS.filter(
    (check) => evidence[check] !== true,
  );
  return {
    gate: failedChecks.length === 0 ? 'CONTINUE' : 'STOP',
    exitCode: failedChecks.length === 0 ? 0 : 2,
    failedChecks,
    scope: 'tracked-terminal-characterization-only',
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForCondition(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  return null;
}

export async function characterizeTrackedTerminalStop(
  connection,
  threadId,
  workspace,
) {
  const fixture = mkdtempSync(join(workspace, '.orchestra-codex-u1a-stop-'));
  chmodSync(fixture, 0o700);
  const marker = join(fixture, 'pid');
  const relativeMarker = relative(workspace, marker);
  const command = [
    '/bin/sh -c',
    `'printf "%s\\n" "$$" > "$1"; exec /bin/sleep ${TRACKED_TERMINAL_SLEEP_SECONDS}'`,
    'orchestra-u1a',
    `'${relativeMarker.replaceAll("'", "'\\''")}'`,
  ].join(' ');
  let syntheticPid;
  const evidence = {
    commandStarted: false,
    markerObserved: false,
    terminalReconciled: false,
    terminalSettlementClass: 'not-run',
    listedAfterTerminal: false,
    commandAliveAfterTerminal: false,
    cleanAccepted: false,
    freshFirstPageEmpty: false,
    observedSyntheticPidDead: false,
  };

  try {
    const started = await connection.request('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: [
          'Use the command-execution tool immediately.',
          `Run exactly this single command: ${command}`,
          'Do not alter it, do not run another command, and do not answer before it finishes.',
        ].join(' '),
      }],
    });
    const turnId = started.turn?.id;
    if (!turnId) throw new Error('tracked-terminal turn/start omitted turn id');

    const commandStarted = await connection.waitForNotification(
      (message) => (
        message.method === 'item/started'
        && message.params?.threadId === threadId
        && message.params?.turnId === turnId
        && message.params?.item?.type === 'commandExecution'
        && String(message.params.item.command).includes(relativeMarker)
        && String(message.params.item.command).includes(
          `/bin/sleep ${TRACKED_TERMINAL_SLEEP_SECONDS}`,
        )
      ),
      60_000,
    );
    if (!commandStarted) throw new Error('tracked-terminal command did not start');
    const commandItemId = commandStarted.params.item.id;
    if (typeof commandItemId !== 'string' || commandItemId === '') {
      throw new Error('tracked-terminal command omitted its item id');
    }
    evidence.commandStarted = true;

    syntheticPid = await waitForCondition(() => {
      try {
        const parsed = Number.parseInt(readFileSync(marker, 'utf8').trim(), 10);
        return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : null;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }, 5_000);
    if (!syntheticPid || !processAlive(syntheticPid)) {
      throw new Error('synthetic sleep PID was not observed alive');
    }
    evidence.markerObserved = true;

    const terminalPromise = connection.waitForNotification(
      (message) => (
        message.method === 'turn/completed'
        && message.params?.threadId === threadId
        && message.params?.turn?.id === turnId
      ),
      20_000,
    );
    let interruptAccepted = false;
    let interruptStale = false;
    try {
      await connection.request('turn/interrupt', { threadId, turnId });
      interruptAccepted = true;
    } catch (error) {
      interruptStale = (
        error.rpcCode === -32600
        && error.rpcMessage === 'no active turn to interrupt'
      );
      if (!interruptStale) throw error;
    }
    const terminal = await terminalPromise;
    const terminalStatus = terminal?.params?.turn?.status ?? null;
    const settlement = evaluateInterruptSettlement({
      interruptAccepted,
      interruptStale,
      terminalMatches: Boolean(terminal),
      terminalStatus,
    });
    evidence.terminalReconciled = settlement.reconciled;
    evidence.terminalSettlementClass = settlement.reason;
    if (!settlement.reconciled) {
      throw new Error('interrupt did not reconcile to the exact terminal');
    }

    const terminals = await listBackgroundTerminals(connection, threadId);
    evidence.listedAfterTerminal = terminals.some(
      (entry) => entry.itemId === commandItemId,
    );
    evidence.commandAliveAfterTerminal = processAlive(syntheticPid);

    const cleanResult = await connection.request(
      'thread/backgroundTerminals/clean',
      { threadId },
    );
    evidence.cleanAccepted = (
      cleanResult
      && typeof cleanResult === 'object'
      && !Array.isArray(cleanResult)
      && Object.keys(cleanResult).length === 0
    );
    evidence.freshFirstPageEmpty = await waitForBackgroundTerminalsEmpty(
      connection,
      threadId,
    );
    evidence.observedSyntheticPidDead = Boolean(
      await waitForCondition(() => !processAlive(syntheticPid), 10_000),
    );
    return evidence;
  } finally {
    if (syntheticPid && processAlive(syntheticPid)) {
      try {
        await connection.request('thread/backgroundTerminals/clean', { threadId });
        await waitForCondition(() => !processAlive(syntheticPid), 5_000);
      } catch {
        // The synthetic command self-expires after a bounded duration.
      }
    }
    rmSync(fixture, { recursive: true, force: true });
  }
}

export async function listPermissionProfiles(connection, cwd) {
  const profiles = [];
  const seenCursors = new Set();
  let cursor;
  let pageCount = 0;
  do {
    if (pageCount >= PROFILE_LIST_MAX_PAGES) {
      throw new Error('permission profile pagination exceeded the page limit');
    }
    pageCount += 1;
    const result = await connection.request('permissionProfile/list', {
      cwd,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result.data)) {
      throw new Error('permission profile list omitted data');
    }
    profiles.push(...result.data);
    cursor = result.nextCursor ?? null;
    if (cursor != null) {
      if (typeof cursor !== 'string' || cursor === '') {
        throw new Error('permission profile list returned an invalid cursor');
      }
      if (seenCursors.has(cursor)) {
        throw new Error('permission profile pagination repeated a cursor');
      }
      seenCursors.add(cursor);
    }
  } while (cursor);
  return profiles;
}

export function exactActiveProfile(value) {
  return isDeepStrictEqual(value, profileProvenanceFixture.profile);
}

function redactedRoots(roots) {
  if (!Array.isArray(roots)) return null;
  return {
    count: roots.length,
    sha256: roots
      .map((root) => createHash('sha256').update(root).digest('hex'))
      .sort(),
  };
}

export function characterizeNamedProfilePolicy(
  source,
  cwd,
  { attachment = false } = {},
) {
  const sandbox = source?.sandbox ?? source?.sandboxPolicy;
  const runtimeWorkspaceRoots = attachment
    ? redactedRoots(source?.runtimeWorkspaceRoots)
    : null;
  const legacyRoots = Array.isArray(sandbox?.writableRoots)
    ? redactedRoots(sandbox.writableRoots)
    : (
        Number.isSafeInteger(sandbox?.writableRootCount)
        && Array.isArray(sandbox?.writableRootSha256)
          ? {
              count: sandbox.writableRootCount,
              sha256: [...sandbox.writableRootSha256].sort(),
            }
          : null
      );
  const legacySandbox = sandbox && legacyRoots && {
    type: sandbox.type,
    networkAccess: sandbox.networkAccess,
    excludeSlashTmp: sandbox.excludeSlashTmp,
    excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar,
    writableRootCount: legacyRoots.count,
    writableRootSha256: legacyRoots.sha256,
  };
  const expectedRuntimeWorkspaceRoots = {
    count: profileProvenanceFixture.attachmentRuntimeWorkspaceRoots.count,
    sha256: [createHash('sha256').update(cwd).digest('hex')],
  };
  return {
    exact: (
      source?.modelProvider === 'openai'
      && source?.approvalPolicy === 'never'
      && source?.approvalsReviewer === 'user'
      && exactActiveProfile(source?.activePermissionProfile)
      && isDeepStrictEqual(
        legacySandbox,
        profileProvenanceFixture.legacySandbox,
      )
      && (
        attachment
          ? isDeepStrictEqual(
              runtimeWorkspaceRoots,
              expectedRuntimeWorkspaceRoots,
            )
          : (
              profileProvenanceFixture.settingsIncludesRuntimeWorkspaceRoots
                === Object.hasOwn(source ?? {}, 'runtimeWorkspaceRoots')
            )
      )
    ),
    runtimeWorkspaceRoots,
    legacySandbox,
    includesRuntimeWorkspaceRoots: Object.hasOwn(
      source ?? {},
      'runtimeWorkspaceRoots',
    ),
  };
}

export function evaluateProfileProvenance({ schemaDeclared, fresh, resume }) {
  const responsePair = (
    profileProvenanceFixture.surface === 'response-extension'
    && profileProvenanceFixture.schemaDeclared === false
    && profileProvenanceFixture.freshExact === true
    && profileProvenanceFixture.resumeExact === true
    && profileProvenanceFixture.profile?.id === PROFILE_ID
    && (profileProvenanceFixture.profile?.extends ?? null) === null
    && schemaDeclared === false
    && fresh.responseExtensionExact
    && resume.responseExtensionExact
  );
  return {
    accepted: Boolean(responsePair),
    surface: responsePair ? 'response-extension' : 'thread/settings/updated',
    schemaDeclared: responsePair ? false : true,
    fragile: responsePair,
  };
}

export async function characterizeThreadProfile(connection, method, params) {
  const result = await connection.request(method, params);
  const threadId = result.thread?.id;
  if (!threadId) throw new Error(`${method} omitted thread id`);
  if (method === 'thread/resume' && threadId !== params.threadId) {
    throw new Error('thread/resume returned a different thread id');
  }
  const notification = await connection.waitForNotification(
    (message) => (
      message.method === 'thread/settings/updated'
      && message.params?.threadId === threadId
    ),
  );
  const attachmentPolicy = characterizeNamedProfilePolicy(
    result,
    params.cwd ?? result.cwd,
    { attachment: true },
  );
  if (!attachmentPolicy.exact) {
    throw new Error(`${method} returned unexpected named-profile policy`);
  }
  const settingsPolicy = notification
    ? characterizeNamedProfilePolicy(
        notification.params.threadSettings,
        params.cwd ?? result.cwd,
    )
    : null;
  if (settingsPolicy && !settingsPolicy.exact) {
    throw new Error(`${method} emitted unexpected named-profile settings`);
  }
  return {
    threadId,
    model: result.model,
    reasoningEffort: result.reasoningEffort ?? null,
    responseExtensionExact: exactActiveProfile(result.activePermissionProfile),
    settingsNotificationExact: exactActiveProfile(
      notification?.params?.threadSettings?.activePermissionProfile,
    ),
    attachmentPolicy,
    settingsPolicy,
  };
}

export async function completePersistenceTurn(connection, threadId) {
  const started = await connection.request('turn/start', {
    threadId,
    input: [{
      type: 'text',
      text: 'Reply with exactly U1A_READY. Do not use tools.',
    }],
  });
  const turnId = started.turn?.id;
  if (!turnId) throw new Error('turn/start omitted turn id');
  const completed = await connection.waitForNotification(
    (message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === threadId
      && message.params?.turn?.id === turnId
    ),
    120_000,
  );
  if (completed?.params?.turn?.status !== 'completed') {
    throw new Error('persistence turn did not complete');
  }
  const allowedItemTypes = new Set(['userMessage', 'agentMessage', 'reasoning']);
  if (
    (completed.params.turn.items ?? [])
      .some((item) => !allowedItemTypes.has(item.type))
  ) {
    throw new Error('persistence turn unexpectedly used a tool');
  }
  return true;
}

export async function characterizeActiveTurnSteering(connection, threadId) {
  const started = await connection.request('turn/start', {
    threadId,
    input: [{
      type: 'text',
      text: [
        'You MUST invoke the command-execution tool now and run /bin/sleep 8 exactly once.',
        'Do not answer before that tool finishes.',
        'While it runs, two steering messages will provide two values.',
        'After the command finishes, do not use another tool.',
        'Return only the requested structured object with both values in steering arrival order.',
      ].join(' '),
    }],
    outputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ['values'],
      additionalProperties: false,
    },
  });
  const turnId = started.turn?.id;
  if (!turnId) throw new Error('steering turn/start omitted turn id');

  const commandStarted = await connection.waitForNotification(
    (message) => (
      message.method === 'item/started'
      && message.params?.threadId === threadId
      && message.params?.turnId === turnId
      && message.params?.item?.type === 'commandExecution'
      && message.params.item.command.includes('/bin/sleep 8')
    ),
    60_000,
  );
  if (!commandStarted) throw new Error('steering sleep command did not start');

  const steerPromises = STEERING_VALUES.map((value, index) => (
    connection.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{
        type: 'text',
        text: [
          `The ${index === 0 ? 'first' : 'second'} steering value is ${value}.`,
          `Preserve it as the ${index === 0 ? 'first' : 'second'} array value.`,
        ].join(' '),
      }],
      clientUserMessageId: STEERING_CLIENT_IDS[index],
    })
  ));
  const steerResults = await Promise.all(steerPromises);
  const completed = await connection.waitForNotification(
    (message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === threadId
      && message.params?.turn?.id === turnId
    ),
    120_000,
  );
  if (!completed) throw new Error('steered turn did not complete');

  const startedSteers = connection.notifications
    .filter((message) => (
      message.method === 'item/started'
      && message.params?.threadId === threadId
      && message.params?.turnId === turnId
      && message.params?.item?.type === 'userMessage'
      && STEERING_CLIENT_IDS.includes(message.params.item.clientId)
    ))
    .map((message) => message.params.item.clientId);
  const completedAgentItems = connection.notifications
    .filter((message) => (
      message.method === 'item/completed'
      && message.params?.threadId === threadId
      && message.params?.turnId === turnId
      && message.params?.item?.type === 'agentMessage'
    ))
    .map((message) => message.params.item);
  let structuredValues = null;
  try {
    const parsed = JSON.parse(completedAgentItems.at(-1)?.text ?? '');
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Array.isArray(parsed.values)
    ) {
      structuredValues = parsed.values;
    }
  } catch {
    // The boolean result below records a structured-output failure.
  }
  const commandItems = connection.notifications.filter((message) => (
    message.method === 'item/started'
    && message.params?.threadId === threadId
    && message.params?.turnId === turnId
    && message.params?.item?.type === 'commandExecution'
  ));
  const unexpectedToolItems = connection.notifications.filter((message) => (
    message.method === 'item/started'
    && message.params?.threadId === threadId
    && message.params?.turnId === turnId
    && !['userMessage', 'agentMessage', 'reasoning', 'commandExecution'].includes(
      message.params?.item?.type,
    )
  ));
  const turnErrors = connection.notifications.filter((message) => (
    message.method === 'error'
    && message.params?.threadId === threadId
    && message.params?.turnId === turnId
  ));

  let staleSteerRpcCode = null;
  let staleSteerClass = 'accepted';
  try {
    await connection.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: 'STALE_STEER' }],
    });
  } catch (error) {
    staleSteerRpcCode = error.rpcCode ?? null;
    staleSteerClass = (
      error.rpcCode === -32600
      && error.rpcMessage === 'no active turn to steer'
    ) ? 'definite-stale' : 'other-error';
  }

  return {
    completed: completed.params?.turn?.status === 'completed',
    activeTurnSteerMatched: steerResults.every((result) => result.turnId === turnId),
    orderedSteersObserved: isDeepStrictEqual(
      startedSteers,
      STEERING_CLIENT_IDS,
    ),
    finalSteerSemanticsObserved: isDeepStrictEqual(
      structuredValues,
      STEERING_VALUES,
    ),
    singleSleepCommandObserved: (
      commandItems.length === 1
      && commandItems[0].params.item.command.includes('/bin/sleep 8')
      && unexpectedToolItems.length === 0
    ),
    noTurnErrors: turnErrors.length === 0,
    definiteStaleSteerRejected: staleSteerClass === 'definite-stale',
    staleSteerRpcCode,
    staleSteerClass,
  };
}

async function createNetworkCanary() {
  const server = createServer((socket) => socket.end());
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

export function resolveNetworkProbeBinary(candidates = ['/usr/bin/nc', '/bin/nc']) {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    validateExecutable(canonical, 'network probe binary');
    return canonical;
  }
  throw new Error('a controlled netcat executable is required for the network probe');
}

function shellPositional(index) {
  return `"\${${index}}"`;
}

export function buildFileEnforcementScript(daemonSecretRootCount) {
  const daemonChecks = Array.from(
    { length: daemonSecretRootCount },
    (_, index) => (
      `if /usr/bin/head -c 1 ${shellPositional(index + 5)} >/dev/null 2>&1; then exit 30; fi`
    ),
  );
  return [
    '/usr/bin/head -c 1 "$1" >/dev/null 2>&1 || exit 10',
    ': > "$2" || exit 11',
    'if exec 3<"$3"; then exit 12; fi',
    'if [ -e "$4" ] && exec 4<"$4"; then exit 13; fi',
    ...daemonChecks,
    'exit 0',
  ].join('; ');
}

export function buildFileEnforcementCommand(fixture, options) {
  return [
    '/bin/sh',
    '-c',
    buildFileEnforcementScript(options.daemonSecretRoots.length),
    'orchestra-u1a',
    fixture.readable,
    fixture.marker,
    join(options.codexHome, 'config.toml'),
    join(options.codexHome, 'auth.json'),
    ...options.daemonSecretRoots.map(
      (root) => join(root, DAEMON_SECRET_PROBE),
    ),
  ];
}

export function createCommandProbeFixture(workspace) {
  const directory = mkdtempSync(join(workspace, '.orchestra-codex-u1a-'));
  chmodSync(directory, 0o700);
  const readable = join(directory, 'readable');
  const marker = join(directory, 'marker');
  const descriptor = openSync(
    readable,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_NOFOLLOW
      | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, 'x\n');
  } finally {
    closeSync(descriptor);
  }
  return { directory, marker, readable };
}

function isRegularMarker(path) {
  try {
    const marker = lstatSync(path);
    return !marker.isSymbolicLink() && marker.isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function runCommandEnforcementProbe(connection, options) {
  const fixture = createCommandProbeFixture(options.workspace);
  const network = await createNetworkCanary();
  try {
    const networkArgs = [
      '-z',
      '-w',
      '1',
      '127.0.0.1',
      String(network.port),
    ];
    const positiveControl = spawnSync(options.networkProbeBinary, networkArgs, {
      encoding: 'utf8',
      env: { PATH: CONTROLLED_PATH },
      timeout: 5_000,
    });
    requireSuccess(positiveControl, 'network probe positive control');

    const fileResult = await connection.request('command/exec', {
      cwd: options.workspace,
      command: buildFileEnforcementCommand(fixture, options),
      outputBytesCap: 2_000,
      timeoutMs: 10_000,
    });
    const networkResult = await connection.request('command/exec', {
      cwd: options.workspace,
      command: [options.networkProbeBinary, ...networkArgs],
      outputBytesCap: 2_000,
      timeoutMs: 10_000,
    });
    return {
      fileExitCode: fileResult.exitCode,
      fileStdoutEmpty: fileResult.stdout === '',
      workspaceMarkerCreated: isRegularMarker(fixture.marker),
      networkExitCode: networkResult.exitCode,
      networkStdoutEmpty: networkResult.stdout === '',
    };
  } finally {
    await network.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

export function evaluateCommandProbe(commandProbe) {
  const knownFileExit = [0, 10, 11, 12, 13, 30].includes(
    commandProbe.fileExitCode,
  );
  const cleanFileResult = knownFileExit && commandProbe.fileStdoutEmpty;
  return {
    workspaceReadPassed: (
      cleanFileResult
      && commandProbe.fileExitCode !== 10
    ),
    workspaceWritePassed: (
      cleanFileResult
      && ![10, 11].includes(commandProbe.fileExitCode)
      && commandProbe.workspaceMarkerCreated
    ),
    codexHomeDenied: (
      cleanFileResult
      && [0, 30].includes(commandProbe.fileExitCode)
    ),
    daemonSecretsDenied: (
      cleanFileResult
      && commandProbe.fileExitCode === 0
    ),
    networkPassed: (
      commandProbe.networkExitCode === 1
      && commandProbe.networkStdoutEmpty
    ),
  };
}

function assertCanaryHash(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('side-channel canary hash is invalid');
  }
}

export function buildProcessArgvInspectionCommand(pid, canaryHash) {
  if (!Number.isSafeInteger(pid) || pid < 2) {
    throw new Error('process canary identifier is invalid');
  }
  assertCanaryHash(canaryHash);
  return [
    '/bin/sh',
    '-c',
    [
      '/bin/ps -ww -p "$1" -o command= 2>/dev/null',
      '| /usr/bin/tr " " "\\n"',
      '| while IFS= read -r word; do',
      'printf %s "$word" | /usr/bin/shasum -a 256 | /usr/bin/cut -d " " -f 1;',
      'done',
      '| /usr/bin/grep -F -x "$2" >/dev/null',
      '&& exit 41;',
      'exit 0',
    ].join(' '),
    'orchestra-u1a',
    String(pid),
    canaryHash,
  ];
}

export function buildInheritedDescriptorProbeCommand(descriptor, canaryHash) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    throw new Error('descriptor canary identifier is invalid');
  }
  assertCanaryHash(canaryHash);
  return [
    '/bin/sh',
    '-c',
    [
      'if [ -f "/dev/fd/$1" ]; then',
      'hash=$(/usr/bin/shasum -a 256 "/dev/fd/$1" 2>/dev/null',
      '| /usr/bin/cut -d " " -f 1);',
      '[ "$hash" = "$2" ] && exit 43;',
      'fi;',
      'exit 0',
    ].join(' '),
    'orchestra-u1a',
    String(descriptor),
    canaryHash,
  ];
}

function createInheritedDescriptorCanary(daemonSecretRoot) {
  let directory;
  let descriptor;
  let closed = false;
  try {
    directory = mkdtempSync(
      join(daemonSecretRoot, '.orchestra-codex-u1a-fd-'),
    );
    chmodSync(directory, 0o700);
    const path = join(directory, 'canary');
    const value = randomBytes(32).toString('hex');
    writeFileSync(path, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    return {
      descriptor,
      hash: createHash('sha256').update(value).digest('hex'),
      close() {
        if (closed) return;
        closed = true;
        try {
          closeSync(descriptor);
          rmSync(directory, { recursive: true, force: true });
        } catch {
          throw new Error('inherited-descriptor canary cleanup failed');
        }
      },
    };
  } catch {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch {
      // The generic setup error below remains the public diagnostic.
    }
    throw new Error('inherited-descriptor canary setup failed');
  }
}

function resolveSideChannelUtility(path, label) {
  try {
    validateExecutable(path, label);
    return realpathSync(path);
  } catch {
    throw new Error(`required side-channel ${label} is unavailable`);
  }
}

function resolveSideChannelUtilities() {
  if (process.platform !== 'darwin') {
    throw new Error('same-user side-channel probe is not implemented for this platform');
  }
  return {
    dig: resolveSideChannelUtility('/usr/bin/dig', 'DNS probe'),
    ps: resolveSideChannelUtility('/bin/ps', 'process probe'),
    sample: resolveSideChannelUtility('/usr/bin/sample', 'debugger probe'),
    security: resolveSideChannelUtility('/usr/bin/security', 'Keychain probe'),
  };
}

function startSingleProcessCanary() {
  const canary = randomUUID();
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        'const lifetime = Number(process.argv[1]);',
        'const timer = setTimeout(() => process.exit(0), lifetime);',
        'const stop = () => { clearTimeout(timer); process.exit(0); };',
        "process.on('message', (message) => { if (message === 'close') stop(); });",
        "process.on('disconnect', stop);",
      ].join(' '),
      String(PROCESS_CANARY_LIFETIME_MS),
      canary,
    ],
    {
      env: { PATH: CONTROLLED_PATH },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  return {
    child,
    hash: createHash('sha256').update(canary).digest('hex'),
    value: canary,
  };
}

export async function stopSingleProcessCanary(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise((resolvePromise) => {
    child.once('exit', () => resolvePromise(true));
  });
  const waitForExit = (timeoutMs) => Promise.race([
    exited,
    delay(timeoutMs).then(() => false),
  ]);
  try {
    if (child.connected) child.send('close');
  } catch {
    // Disconnect below still asks the self-expiring canary to exit.
  }
  if (await waitForExit(250)) return true;
  try {
    if (child.connected) child.disconnect();
  } catch {
    // Forced termination below remains the final cleanup boundary.
  }
  if (await waitForExit(250)) return true;
  try {
    child.kill('SIGKILL');
  } catch {
    // The final bounded exit check below remains authoritative.
  }
  return waitForExit(1_000);
}

async function startStreamCanary(listenOptions) {
  const server = createServer((socket) => socket.end());
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(listenOptions, resolvePromise);
  });
  return server;
}

async function startDatagramCanary() {
  const server = createSocket('udp4');
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.bind(0, '127.0.0.1', resolvePromise);
  });
  return server;
}

function waitForStreamConnection(server, timeoutMs = 1_500) {
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), timeoutMs);
    server.once('connection', () => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
}

function waitForDatagram(server, timeoutMs = 1_500) {
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), timeoutMs);
    server.once('message', () => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
}

function closeStreamCanary(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function closeDatagramCanary(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolvePromise) => {
    server.close(resolvePromise);
  });
}

function probeExitCode(result, label) {
  if (!Number.isSafeInteger(result?.exitCode)) {
    throw new Error(`${label} did not return an exit code`);
  }
  return result.exitCode;
}

function sideChannelCommand(connection, cwd, command) {
  return connection.request('command/exec', {
    cwd,
    command,
    outputBytesCap: 2_000,
    timeoutMs: SIDE_CHANNEL_TIMEOUT_MS,
  });
}

export function runHostSideChannelCommand(
  command,
  spawnImplementation = spawnSync,
) {
  if (
    !Array.isArray(command)
    || command.length === 0
    || command.some((value) => typeof value !== 'string')
  ) {
    throw new Error('host side-channel probe command is invalid');
  }
  return spawnImplementation(command[0], command.slice(1), {
    stdio: 'ignore',
    timeout: 5_000,
  });
}

export function runHostSideChannelCommandAsync(command) {
  if (
    !Array.isArray(command)
    || command.length === 0
    || command.some((value) => typeof value !== 'string')
  ) {
    throw new Error('host side-channel probe command is invalid');
  }
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ status });
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 5_000);
    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code));
  });
}

export function buildUnixSocketProbeCommand(networkProbeBinary, socketPath) {
  if (
    typeof socketPath !== 'string'
    || Buffer.byteLength(socketPath) > DARWIN_UNIX_SOCKET_PATH_MAX_BYTES
  ) {
    throw new Error('Unix-socket canary path exceeds the macOS limit');
  }
  return [
    networkProbeBinary,
    '-z',
    '-U',
    '-w',
    '1',
    socketPath,
  ];
}

export function cleanupKeychainCanary(
  securityBinary,
  keychainId,
  spawnImplementation = spawnSync,
) {
  const deleteArgs = [
    'delete-generic-password',
    '-a',
    keychainId,
    '-s',
    keychainId,
  ];
  const findArgs = [
    'find-generic-password',
    '-a',
    keychainId,
    '-s',
    keychainId,
    '-w',
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    spawnImplementation(securityBinary, deleteArgs, {
      stdio: 'ignore',
      timeout: 5_000,
    });
    const verification = spawnImplementation(securityBinary, findArgs, {
      stdio: 'ignore',
      timeout: 5_000,
    });
    if (verification.status === 44) return true;
  }
  return false;
}

async function runSameUserSideChannelProbeUnsafe(
  connection,
  options,
  inheritedDescriptor,
) {
  const utilities = resolveSideChannelUtilities();
  const fixture = mkdtempSync(join(tmpdir(), 'orchestra-u1a-side-'));
  chmodSync(fixture, 0o700);
  const unixSocketPath = join(fixture, 'local.sock');
  const processCanary = startSingleProcessCanary();
  const keychainId = `orchestra-u1a-${randomUUID()}`;
  const keychainSecret = randomUUID();
  let keychainCreated = false;
  let tcp;
  let udp;
  let dns;
  let unixSocket;
  let processCanaryCleanup = false;
  let keychainCleanup = false;
  let observation;
  let primaryError;

  try {
    tcp = await startStreamCanary({ host: '127.0.0.1', port: 0 });
    udp = await startDatagramCanary();
    dns = await startDatagramCanary();
    unixSocket = await startStreamCanary(unixSocketPath);
    await delay(50);

    const processProbeCommand = buildProcessArgvInspectionCommand(
      processCanary.child.pid,
      processCanary.hash,
    );
    const processHost = runHostSideChannelCommand(processProbeCommand);
    const processHostControl = processHost.status === 41;

    const debuggerHost = spawnSync(utilities.sample, [
      String(processCanary.child.pid),
      '1',
      '10',
      '-file',
      '/dev/null',
    ], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    const debuggerHostControl = debuggerHost.status === 0;

    const keychainAdd = spawnSync(utilities.security, [
      'add-generic-password',
      '-a',
      keychainId,
      '-s',
      keychainId,
      '-w',
      keychainSecret,
    ], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    keychainCreated = keychainAdd.status === 0;
    const keychainProbeCommand = [
      '/bin/sh',
      '-c',
      [
        '/usr/bin/security find-generic-password',
        '-a "$1" -s "$2" -w >/dev/null 2>&1',
        '&& exit 42;',
        'exit 0',
      ].join(' '),
      'orchestra-u1a',
      keychainId,
      keychainId,
    ];
    const keychainHost = runHostSideChannelCommand(keychainProbeCommand);
    const keychainHostControl = (
      keychainCreated
      && keychainHost.status === 42
    );

    const inheritedDescriptorHost = spawnSync(
      '/bin/sh',
      buildInheritedDescriptorProbeCommand(
        3,
        inheritedDescriptor.hash,
      ).slice(1),
      {
        stdio: ['ignore', 'ignore', 'ignore', inheritedDescriptor.descriptor],
        timeout: 2_000,
      },
    );
    const inheritedDescriptorHostControl = (
      inheritedDescriptorHost.status === 43
    );

    const tcpProbeCommand = [
      options.networkProbeBinary,
      '-z',
      '-w',
      '1',
      '127.0.0.1',
      String(tcp.address().port),
    ];
    const tcpHostObserved = waitForStreamConnection(tcp);
    const tcpHost = runHostSideChannelCommand(tcpProbeCommand);
    const tcpHostControl = (
      tcpHost.status === 0
      && await tcpHostObserved
    );

    const unixSocketProbeCommand = buildUnixSocketProbeCommand(
      options.networkProbeBinary,
      unixSocketPath,
    );
    const unixHostObserved = waitForStreamConnection(unixSocket, 5_000);
    const unixHost = await runHostSideChannelCommandAsync(
      unixSocketProbeCommand,
    );
    const unixSocketHostControl = (
      Number.isSafeInteger(unixHost.status)
      && await unixHostObserved
    );

    const udpProbeCommand = [
      '/bin/sh',
      '-c',
      'printf x | "$1" -u -w 1 127.0.0.1 "$2"',
      'orchestra-u1a',
      options.networkProbeBinary,
      String(udp.address().port),
    ];
    const udpHostObserved = waitForDatagram(udp);
    const udpHost = runHostSideChannelCommand(udpProbeCommand);
    const udpHostControl = (
      udpHost.status === 0
      && await udpHostObserved
    );

    const dnsArgs = [
      '@127.0.0.1',
      '-p',
      String(dns.address().port),
      'u1a.invalid',
      'A',
      '+time=1',
      '+tries=1',
    ];
    const dnsHostObserved = waitForDatagram(dns);
    const dnsHost = spawnSync(utilities.dig, dnsArgs, {
      stdio: 'ignore',
      timeout: 5_000,
    });
    const dnsHostControl = (
      Number.isSafeInteger(dnsHost.status)
      && await dnsHostObserved
    );

    const processResult = await sideChannelCommand(
      connection,
      options.workspace,
      processProbeCommand,
    );
    const debuggerResult = await sideChannelCommand(
      connection,
      options.workspace,
      [
        utilities.sample,
        String(processCanary.child.pid),
        '1',
        '10',
        '-file',
        '/dev/null',
      ],
    );
    const keychainResult = await sideChannelCommand(
      connection,
      options.workspace,
      keychainProbeCommand,
    );

    const tcpObserved = waitForStreamConnection(tcp);
    const tcpResult = await sideChannelCommand(
      connection,
      options.workspace,
      tcpProbeCommand,
    );
    const tcpCanaryReached = await tcpObserved;

    const udpObserved = waitForDatagram(udp);
    const udpResult = await sideChannelCommand(
      connection,
      options.workspace,
      udpProbeCommand,
    );
    const udpCanaryReached = await udpObserved;

    const dnsObserved = waitForDatagram(dns);
    const dnsResult = await sideChannelCommand(
      connection,
      options.workspace,
      [utilities.dig, ...dnsArgs],
    );
    const dnsCanaryReached = await dnsObserved;

    const unixObserved = waitForStreamConnection(unixSocket);
    const unixSocketResult = await sideChannelCommand(
      connection,
      options.workspace,
      unixSocketProbeCommand,
    );
    const unixSocketCanaryReached = await unixObserved;

    const inheritedDescriptorResult = await sideChannelCommand(
      connection,
      options.workspace,
      buildInheritedDescriptorProbeCommand(
        inheritedDescriptor.descriptor,
        inheritedDescriptor.hash,
      ),
    );

    observation = {
      processHostControl,
      processArgvInspectionExitCode: probeExitCode(
        processResult,
        'process inspection probe',
      ),
      debuggerHostControl,
      debuggerExitCode: probeExitCode(debuggerResult, 'debugger probe'),
      keychainHostControl,
      keychainExitCode: probeExitCode(keychainResult, 'Keychain probe'),
      tcpHostControl,
      tcpExitCode: probeExitCode(tcpResult, 'TCP probe'),
      tcpCanaryReached,
      udpHostControl,
      udpCommandExitCode: probeExitCode(udpResult, 'UDP probe'),
      udpCanaryReached,
      dnsHostControl,
      dnsCommandExitCode: probeExitCode(dnsResult, 'DNS probe'),
      dnsCanaryReached,
      unixSocketHostControl,
      unixSocketExitCode: probeExitCode(
        unixSocketResult,
        'Unix-socket probe',
      ),
      unixSocketCanaryReached,
      inheritedDescriptorHostControl,
      inheritedDescriptorExitCode: probeExitCode(
        inheritedDescriptorResult,
        'inherited-descriptor probe',
      ),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupFailures = [];
    try {
      processCanaryCleanup = await stopSingleProcessCanary(
        processCanary.child,
      );
      if (!processCanaryCleanup) cleanupFailures.push('process');
    } catch {
      cleanupFailures.push('process');
    }
    try {
      keychainCleanup = cleanupKeychainCanary(
        utilities.security,
        keychainId,
      );
      if (!keychainCleanup) cleanupFailures.push('Keychain');
    } catch {
      cleanupFailures.push('Keychain');
    }
    const resourceResults = await Promise.allSettled([
        closeStreamCanary(tcp),
        closeDatagramCanary(udp),
        closeDatagramCanary(dns),
        closeStreamCanary(unixSocket),
    ]);
    if (resourceResults.some((result) => result.status === 'rejected')) {
      cleanupFailures.push('socket');
    }
    try {
      rmSync(fixture, { recursive: true, force: true });
    } catch {
      cleanupFailures.push('fixture');
    }
    if (cleanupFailures.length > 0) {
      throw new Error('side-channel resource cleanup failed');
    }
  }

  if (primaryError) throw primaryError;
  return {
    ...observation,
    processCanaryCleanup,
    keychainCleanup,
  };
}

async function runSameUserSideChannelProbe(
  connection,
  options,
  inheritedDescriptor,
) {
  try {
    return await runSameUserSideChannelProbeUnsafe(
      connection,
      options,
      inheritedDescriptor,
    );
  } catch {
    throw new Error('same-user side-channel probe failed');
  }
}

export function workspaceWritePolicyFrom(schema) {
  return schema.definitions?.SandboxPolicy?.oneOf?.find(
    (policy) => policy.title === 'WorkspaceWriteSandboxPolicy',
  );
}

export function hasRestrictedWorkspaceReadPolicy(schema) {
  return Object.hasOwn(
    workspaceWritePolicyFrom(schema)?.properties ?? {},
    'readOnlyAccess',
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.binary) throw new Error('pass the pinned binary with --binary or POLYGRAM_CODEX_BIN');
  if (!options.codexHome) throw new Error('pass --codex-home or ORCHESTRA_CODEX_HOME');
  if (!options.workspace) throw new Error('pass --workspace or ORCHESTRA_CODEX_WORKSPACE');
  validateExecutable(options.binary, 'Codex binary');
  if (realpathSync(options.binary) !== options.binary) {
    throw new Error('Codex binary must already be the resolved versioned path');
  }
  if (options.launcher) validateExecutable(options.launcher, 'session launcher');
  if (await sha256File(options.binary) !== manifest.binarySha256) {
    throw new Error('Codex binary hash mismatch');
  }

  options.codexHome = validateCodexHome(options.codexHome);
  options.workspace = validateWorkspace(options.workspace, options.codexHome);
  options.daemonSecretRoots = validateDaemonSecretRoots(
    options.daemonSecretRoots,
    options.codexHome,
    options.workspace,
  );
  options.networkProbeBinary = resolveNetworkProbeBinary();
  const initialConfigSha256 = sha256(join(options.codexHome, 'config.toml'));
  const env = sanitizedAppServerEnv(options);

  const version = runCommand(options, ['--version'], { env });
  requireSuccess(version, 'version check');
  if (version.stdout.trim() !== manifest.cliVersion) throw new Error('Codex binary version mismatch');

  const inheritedDescriptor = createInheritedDescriptorCanary(
    options.daemonSecretRoots[0],
  );
  let scratch;
  let connection;
  let freshConnection;
  let resumeConnection;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'orchestra-codex-u1a-'));
    const stable = join(scratch, 'stable');
    const experimental = join(scratch, 'experimental');

    const stableResult = runCommand(
      options,
      buildSchemaGenerationArgs(stable),
      { env },
    );
    requireSuccess(stableResult, 'stable schema generation');
    const experimentalResult = runCommand(
      options,
      buildSchemaGenerationArgs(experimental, true),
      { env },
    );
    requireSuccess(experimentalResult, 'experimental schema generation');

    const stableClientRequestPath = join(stable, 'ClientRequest.json');
    assertHash(
      stableClientRequestPath,
      manifest.schemaSha256.stableClientRequest,
      'stable ClientRequest',
    );
    assertHash(
      join(stable, 'codex_app_server_protocol.schemas.json'),
      manifest.schemaSha256.stableProtocol,
      'stable protocol',
    );
    const schema = JSON.parse(
      readFileSync(join(stable, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'),
    );
    const experimentalV2Schema = JSON.parse(
      readFileSync(join(experimental, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'),
    );
    assertCanonicalHash(
      schema,
      manifest.schemaSha256.stableProtocolV2Canonical,
      'stable v2 protocol',
    );
    assertHash(
      join(experimental, 'ClientRequest.json'),
      manifest.schemaSha256.experimentalClientRequest,
      'experimental ClientRequest',
    );
    assertHash(
      join(experimental, 'codex_app_server_protocol.schemas.json'),
      manifest.schemaSha256.experimentalProtocol,
      'experimental protocol',
    );
    assertCanonicalHash(
      experimentalV2Schema,
      manifest.schemaSha256.experimentalProtocolV2Canonical,
      'experimental v2 protocol',
    );
    const experimentalClientRequest = JSON.parse(
      readFileSync(join(experimental, 'ClientRequest.json'), 'utf8'),
    );
    const terminalSurfaces = assertExperimentalTerminalSurfaces(
      experimentalClientRequest,
      JSON.parse(
        readFileSync(
          join(experimental, 'codex_app_server_protocol.schemas.json'),
          'utf8',
        ),
      ),
    );

    const turnSteer = schema.definitions?.TurnSteerParams;
    const recordedTurnSteer = JSON.parse(
      readFileSync(join(fixtureDir, 'turn-steer.schema.json'), 'utf8'),
    );
    if (canonicalizeToolInput(turnSteer) !== canonicalizeToolInput(recordedTurnSteer)) {
      throw new Error('recorded turn/steer fixture differs from generated schema');
    }
    const required = [...(turnSteer?.required ?? [])].sort();
    const expectedRequired = ['expectedTurnId', 'input', 'threadId'];
    if (JSON.stringify(required) !== JSON.stringify(expectedRequired)) {
      throw new Error('turn/steer active-turn precondition changed');
    }
    const description = turnSteer.properties?.expectedTurnId?.description ?? '';
    if (!description.includes('active turn id precondition')) {
      throw new Error('turn/steer active-turn targeting description changed');
    }

    const stableClientRequest = JSON.parse(readFileSync(stableClientRequestPath, 'utf8'));
    const stableProfileMethodsVerified = assertStableProfileSurfaces(
      stableClientRequest,
      schema,
    );
    const transportCorrelationSurfaces = assertTransportCorrelationSurfaces(
      schema,
    );
    const profileResponseSchemaDeclared = (
      Object.hasOwn(
        schema.definitions?.ThreadStartResponse?.properties ?? {},
        'activePermissionProfile',
      )
      || Object.hasOwn(
        schema.definitions?.ThreadResumeResponse?.properties ?? {},
        'activePermissionProfile',
      )
    );
    const workspaceWritePolicy = workspaceWritePolicyFrom(schema);
    const recordedWorkspaceWrite = JSON.parse(
      readFileSync(join(fixtureDir, 'workspace-write-sandbox.schema.json'), 'utf8'),
    );
    delete recordedWorkspaceWrite.observation;
    if (
      canonicalizeToolInput(workspaceWritePolicy)
      !== canonicalizeToolInput(recordedWorkspaceWrite)
    ) {
      throw new Error('recorded workspaceWrite fixture differs from generated schema');
    }
    const hasRestrictedReadPolicy = hasRestrictedWorkspaceReadPolicy(schema);
    if (hasRestrictedReadPolicy !== manifest.observations.workspaceWriteReadOnlyAccessField) {
      throw new Error('workspaceWrite read-access surface changed');
    }

    connection = new AppServerConnection(options, env);
    await initializeConnection(connection, options.codexHome);
    const configAttestation = await attestConnectionPolicy(
      connection,
      options,
      initialConfigSha256,
    );
    const profiles = await listPermissionProfiles(connection, options.workspace);
    const profileListed = profiles.some(
      (profile) => profile.id === PROFILE_ID && profile.allowed === true,
    );
    const account = await connection.request('account/read', { refreshToken: false });
    const accountAuthenticated = account.account?.type === 'chatgpt';
    const commandProbe = await runCommandEnforcementProbe(connection, options);
    const sameUserSideChannelEvidence = await runSameUserSideChannelProbe(
      connection,
      options,
      inheritedDescriptor,
    );

    let freshProfile = {
      threadId: null,
      responseExtensionExact: false,
      settingsNotificationExact: false,
    };
    let resumeProfile = {
      responseExtensionExact: false,
      settingsNotificationExact: false,
    };
    let resumableTurnCompleted = false;
    let steering = {
      completed: false,
      activeTurnSteerMatched: false,
      orderedSteersObserved: false,
      finalSteerSemanticsObserved: false,
      singleSleepCommandObserved: false,
      noTurnErrors: false,
      definiteStaleSteerRejected: false,
      staleSteerRpcCode: null,
      staleSteerClass: 'not-run',
    };
    let trackedTerminalStop = {
      commandStarted: false,
      markerObserved: false,
      terminalReconciled: false,
      terminalSettlementClass: 'not-run',
      listedAfterTerminal: false,
      commandAliveAfterTerminal: false,
      cleanAccepted: false,
      freshFirstPageEmpty: false,
      observedSyntheticPidDead: false,
    };
    if (accountAuthenticated) {
      const preFreshAttestation = await attestConnectionPolicy(
        connection,
        options,
        initialConfigSha256,
      );
      if (!isDeepStrictEqual(preFreshAttestation, configAttestation)) {
        throw new Error('connection policy changed before fresh thread');
      }
      freshProfile = await characterizeThreadProfile(connection, 'thread/start', {
        cwd: options.workspace,
        approvalPolicy: 'never',
      });
      resumableTurnCompleted = await completePersistenceTurn(
        connection,
        freshProfile.threadId,
      );
      freshConnection = connection;
      await freshConnection.close();
      connection = null;
      validateCodexHome(options.codexHome);
      if (sha256(join(options.codexHome, 'config.toml')) !== initialConfigSha256) {
        throw new Error('owned config changed before replacement connection');
      }
      resumeConnection = new AppServerConnection(options, env);
      await initializeConnection(resumeConnection, options.codexHome);
      const replacementAttestation = await attestConnectionPolicy(
        resumeConnection,
        options,
        initialConfigSha256,
      );
      if (!isDeepStrictEqual(replacementAttestation, configAttestation)) {
        throw new Error('replacement connection policy attestation changed');
      }
      resumeProfile = await characterizeThreadProfile(resumeConnection, 'thread/resume', {
        threadId: freshProfile.threadId,
        cwd: options.workspace,
      });
      const preSteeringAttestation = await attestConnectionPolicy(
        resumeConnection,
        options,
        initialConfigSha256,
      );
      if (!isDeepStrictEqual(preSteeringAttestation, configAttestation)) {
        throw new Error('connection policy changed before steering thread');
      }
      const steeringProfile = await characterizeThreadProfile(
        resumeConnection,
        'thread/start',
        {
          cwd: options.workspace,
          approvalPolicy: 'never',
        },
      );
      if (
        !steeringProfile.responseExtensionExact
        && !steeringProfile.settingsNotificationExact
      ) {
        throw new Error('steering thread omitted named-profile provenance');
      }
      steering = await characterizeActiveTurnSteering(
        resumeConnection,
        steeringProfile.threadId,
      );
      const stopProfile = await characterizeThreadProfile(
        resumeConnection,
        'thread/start',
        {
          cwd: options.workspace,
          approvalPolicy: 'never',
        },
      );
      if (
        !stopProfile.responseExtensionExact
        && !stopProfile.settingsNotificationExact
      ) {
        throw new Error('tracked-terminal thread omitted named-profile provenance');
      }
      trackedTerminalStop = await characterizeTrackedTerminalStop(
        resumeConnection,
        stopProfile.threadId,
        options.workspace,
      );
    }

    await connection?.close();
    await resumeConnection?.close();
    connection?.assertProtocolHealthy();
    freshConnection?.assertProtocolHealthy();
    resumeConnection?.assertProtocolHealthy();
    const unexpectedServerRequestCount = (
      (freshConnection?.unexpectedServerRequests.length ?? 0)
      + (connection?.unexpectedServerRequests.length ?? 0)
      + (resumeConnection?.unexpectedServerRequests.length ?? 0)
    );
    const noUnexpectedRequests = unexpectedServerRequestCount === 0;
    let configUnchangedAtEnd = false;
    try {
      configUnchangedAtEnd = (
        sha256(join(options.codexHome, 'config.toml'))
        === initialConfigSha256
      );
    } catch {
      configUnchangedAtEnd = false;
    }
    const {
      workspaceReadPassed,
      workspaceWritePassed,
      codexHomeDenied,
      daemonSecretsDenied,
      networkPassed: networkProbePassed,
    } = evaluateCommandProbe(commandProbe);
    const provenance = evaluateProfileProvenance({
      schemaDeclared: profileResponseSchemaDeclared,
      fresh: freshProfile,
      resume: resumeProfile,
    });
    const evidence = {
      schemaHashesVerified: true,
      stableProfileMethodsVerified,
      configSourceAttested: true,
      configUnchangedAtEnd,
      requirementsAttested: true,
      profileListed,
      commandWorkspaceRead: workspaceReadPassed,
      commandWorkspaceWrite: workspaceWritePassed,
      commandCodexHomeDenied: codexHomeDenied,
      commandDaemonSecretsDenied: daemonSecretsDenied,
      commandNetworkDenied: networkProbePassed,
      legacySandboxAbsent: true,
      accountAuthenticated,
      freshProfileProvenance: provenance.accepted,
      resumeProfileProvenance: provenance.accepted,
      resumableTurnCompleted,
      noUnexpectedServerRequests: noUnexpectedRequests,
    };
    const namedProfileGate = evaluateNamedProfileGate(evidence);
    const steeringGate = evaluateSteeringGate(steering);
    const trackedTerminalStopGate = evaluateTrackedTerminalStopGate(
      trackedTerminalStop,
    );
    const sameUserSideChannelGate = evaluateSameUserSideChannelProbe(
      sameUserSideChannelEvidence,
    );
    const overallU1aGate = evaluateOverallU1aGate({
      namedProfileGate,
      steeringGate,
      trackedTerminalStopGate,
      sameUserSideChannelGate,
    });
    const result = {
      ...overallU1aGate,
      cliVersion: manifest.cliVersion,
      binarySha256: manifest.binarySha256,
      launcherMode: options.launcher ? 'configured-wrapper' : 'direct',
      activeTurnTargeting: 'expectedTurnId required',
      profileId: PROFILE_ID,
      terminalSurfaces,
      transportCorrelationSurfaces,
      namedProfileGate,
      evidence,
      sameUserSideChannelGate,
      sameUserSideChannelEvidence,
      steeringGate,
      steeringEvidence: {
        completed: steering.completed,
        activeTurnSteerMatched: steering.activeTurnSteerMatched,
        orderedSteersObserved: steering.orderedSteersObserved,
        finalSteerSemanticsObserved: steering.finalSteerSemanticsObserved,
        singleSleepCommandObserved: steering.singleSleepCommandObserved,
        noTurnErrors: steering.noTurnErrors,
        definiteStaleSteerRejected: steering.definiteStaleSteerRejected,
      },
      staleSteerRpcCode: steering.staleSteerRpcCode,
      staleSteerClass: steering.staleSteerClass,
      trackedTerminalStopGate,
      trackedTerminalStopEvidence: trackedTerminalStop,
      crashContainmentObservation: {
        appServerLossLeavesCommandAlive: (
          interruptObservationFixture
            .crashLoss
            .commandAliveAfterAppServerProcessGroupTermination
        ),
        reconnectCannotRecoverTrackedTerminal: (
          !interruptObservationFixture.crashLoss.resumedThreadCouldListOldTerminal
        ),
        logicalProcessIdIsNotOsPid: (
          !interruptObservationFixture.crashLoss.logicalProcessIdMatchedOsPid
        ),
        strongProcessTreeContainmentProved: (
          interruptObservationFixture.strongProcessTreeContainmentProved
        ),
      },
      configAttestation,
      legacyWorkspaceWriteReadOnlyAccessField: hasRestrictedReadPolicy,
      freshProfileResponseExtensionExact: freshProfile.responseExtensionExact,
      freshProfileSettingsNotificationExact: freshProfile.settingsNotificationExact,
      freshAttachmentPolicy: freshProfile.attachmentPolicy,
      freshSettingsPolicy: freshProfile.settingsPolicy,
      resumeProfileResponseExtensionExact: resumeProfile.responseExtensionExact,
      resumeProfileSettingsNotificationExact: resumeProfile.settingsNotificationExact,
      resumeAttachmentPolicy: resumeProfile.attachmentPolicy,
      resumeSettingsPolicy: resumeProfile.settingsPolicy,
      provenanceSurface: provenance.surface,
      provenanceSchemaDeclared: provenance.schemaDeclared,
      provenanceFragile: provenance.fragile,
      commandProbeFileExitCode: commandProbe.fileExitCode,
      commandProbeNetworkExitCode: commandProbe.networkExitCode,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = overallU1aGate.exitCode;
  } finally {
    await connection?.close();
    await freshConnection?.close();
    await resumeConnection?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    inheritedDescriptor.close();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`codex-app-server U1a check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
