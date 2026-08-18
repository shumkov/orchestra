'use strict';

// Composition proof: a spawn profile carrying hook material, handed to the
// process factory, reaches a real CodexAppServerClient over a real app-server
// transport and issues hooks/list before the thread is attached and again
// before every turn. The consumer seam here stands in for Polygram's; what is
// proven is Orchestra's own wiring end to end, not the consumer's.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  attestPinnedCodexHome,
  buildCodexAppServerEnv,
  CodexAppServerClient,
  protocolSchema,
  resolveCodexTargetPin,
} = require('../lib/codex/app-server-client');
const {
  createCodexSpawnProfile,
  preflightCodexRuntime,
} = require('../lib/codex/preflight');
const { createProcessFactory } = require('../lib/process/factory');

const FIXTURE = path.resolve(__dirname, 'fixtures/fake-codex-app-server.mjs');
const REQUEST_LOG = 'fake-codex-requests.jsonl';
const SILENT = { debug() {}, error() {}, info() {}, log() {}, warn() {} };
const HOOK_SOURCE_PATH = '/opt/orchestra/hook-artifacts/1/hooks.json';
const HOOK_EVENTS = ['sessionStart', 'userPromptSubmit', 'stop'];
const HOOK_EVENT_SNAKE = {
  sessionStart: 'session_start',
  userPromptSubmit: 'user_prompt_submit',
  stop: 'stop',
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
    .digest('hex');
}

function hookCommand(event) {
  return `/opt/orchestra/hook-artifacts/1/node /opt/orchestra/hook-artifacts/1/wrapper.js ${event}`;
}

function hookDescriptor(event, ordinal) {
  return {
    ordinal,
    configKey: `${HOOK_SOURCE_PATH}:${HOOK_EVENT_SNAKE[event]}:0:0`,
    sourcePath: HOOK_SOURCE_PATH,
    event,
    handlerType: 'command',
    source: 'user',
    isManaged: false,
    displayOrder: ordinal,
    timeoutSec: 600,
    commandSha256: digest(hookCommand(event)),
  };
}

function hookMetadata(event, ordinal, trustStatus = 'trusted') {
  return {
    currentHash: `sha256:${digest(`current:${event}`)}`,
    displayOrder: ordinal,
    enabled: true,
    eventName: event,
    handlerType: 'command',
    isManaged: false,
    key: `${HOOK_SOURCE_PATH}:${HOOK_EVENT_SNAKE[event]}:0:0`,
    source: 'user',
    sourcePath: HOOK_SOURCE_PATH,
    timeoutSec: 600,
    trustStatus,
    additionalContextLimit: null,
    command: hookCommand(event),
    matcher: null,
    pluginId: null,
    statusMessage: null,
  };
}

// The raw shapes the pinned app server returns, and the profile the client
// projects them into. Both are written out here so a drift in either one fails
// this test rather than being papered over by a helper.
function rawPolicy(cwd) {
  const config = {
    model: 'gpt-5.6-sol',
    model_provider: 'openai',
    default_permissions: 'polygram-session',
    approval_policy: 'never',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    shell_environment_policy: { inherit: 'none' },
    permissions: {
      'polygram-session': {
        filesystem: { [cwd]: 'write' },
        network: { enabled: false },
      },
    },
    mcp_servers: {},
    plugins: {},
    model_providers: {},
  };
  const layerConfig = { model: 'gpt-5.6-sol' };
  return {
    config,
    layers: [{ name: 'user', version: '1', config: layerConfig }],
    origins: {},
    layerConfig,
    profileDescription: 'Isolated session profile',
  };
}

function projectedPolicy(cwd) {
  const raw = rawPolicy(cwd);
  return {
    expectedConfig: {
      sha256: digest(raw.config),
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      defaultPermissions: 'polygram-session',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      webSearch: 'disabled',
      allowLoginShell: false,
      shellEnvironmentInherit: 'none',
      permissionProfiles: [{
        id: 'polygram-session',
        extends: null,
        networkEnabled: false,
        filesystemSha256: digest({ [cwd]: 'write' }),
        filesystem: [{ rootSha256: digest(cwd), access: 'write' }],
      }],
      mcpServers: { count: 0, keySha256: [] },
      plugins: { count: 0, keySha256: [] },
      modelProviders: { count: 0, keySha256: [] },
    },
    expectedLayers: [{
      type: 'user',
      version: '1',
      disabled: false,
      configSha256: digest(raw.layerConfig),
    }],
    expectedOriginsSha256: digest(raw.origins),
    expectedRequirements: null,
    expectedPermissionProfiles: [{
      id: 'polygram-session',
      allowed: true,
      descriptionSha256: digest(raw.profileDescription),
    }],
  };
}

// One turn's worth of peer behaviour: the response, then the notifications that
// carry it to completion. Each turn needs its own id, so these are supplied as
// a per-call sequence rather than one static descriptor.
function turnStep(turnId, threadId = 'thread-1') {
  return {
    result: { turn: { id: turnId, status: 'inProgress', items: [] } },
    lateMessages: [
      {
        method: 'turn/started',
        params: {
          threadId,
          turn: { id: turnId, status: 'inProgress', items: [] },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: turnId, status: 'completed', items: [], error: null },
        },
      },
    ],
  };
}

function readRequests(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

// `trustStatuses`, when given, is one hooks/list answer per call: the peer
// reports that status for every hook on that call. Omitted, every call reports
// the trusted inventory the manifest expects.
function buildWorkspace(t, { trustStatuses = null } = {}) {
  const root = realpathSync(
    mkdtempSync(path.join(os.homedir(), '.orchestra-u23-composition-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  const ownedConfig = 'model = "gpt-5.6-sol"\n';
  const configPath = path.join(codexHome, 'config.toml');
  writeFileSync(configPath, ownedConfig, { mode: 0o600 });
  chmodSync(configPath, 0o600);

  const raw = rawPolicy(cwd);
  const hooks = HOOK_EVENTS.map(
    (event, index) => hookMetadata(event, index),
  );
  const scenario = {
    methods: {
      'config/read': {
        result: { config: raw.config, layers: raw.layers, origins: raw.origins },
      },
      'configRequirements/read': { result: { requirements: null } },
      'permissionProfile/list': {
        result: {
          data: [{
            id: 'polygram-session',
            allowed: true,
            description: raw.profileDescription,
          }],
          nextCursor: null,
        },
      },
      'model/list': {
        result: {
          data: [{
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            description: 'Pinned coding model',
            displayName: 'GPT-5.6 Sol',
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [
              { reasoningEffort: 'high', description: 'High' },
              { reasoningEffort: 'xhigh', description: 'Extra high' },
            ],
            hidden: false,
            isDefault: true,
          }],
          nextCursor: null,
        },
      },
      'turn/start': { sequence: [turnStep('turn-1'), turnStep('turn-2')] },
      'hooks/list': trustStatuses === null
        ? { result: { data: [{ cwd, errors: [], warnings: [], hooks }] } }
        : {
            sequence: trustStatuses.map((trustStatus) => ({
              result: {
                data: [{
                  cwd,
                  errors: [],
                  warnings: [],
                  hooks: HOOK_EVENTS.map(
                    (event, index) => hookMetadata(event, index, trustStatus),
                  ),
                }],
              },
            })),
          },
    },
  };
  writeFileSync(
    path.join(cwd, '.fake-codex-app-server.json'),
    `${JSON.stringify(scenario)}\n`,
  );

  const binary = path.join(cwd, 'fake-codex-direct.mjs');
  writeFileSync(
    binary,
    readFileSync(FIXTURE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`),
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);

  const env = {
    HOME: '/controlled/home',
    TMPDIR: cwd,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
  };
  const targetReceipt = resolveCodexTargetPin();
  const profile = {
    runtime: 'codex',
    binary,
    target: targetReceipt.target,
    binarySha256: targetReceipt.binarySha256,
    cliVersion: targetReceipt.cliVersion,
    protocolSchemaSha256: protocolSchema.generatedProtocolV2CanonicalSha256,
    codexHome,
    cwd,
    env,
    allowlistedEnvironmentFingerprint: digest(
      buildCodexAppServerEnv(codexHome, env),
    ),
    ownedConfigSha256: digest(ownedConfig),
    expectedConfigSha256: projectedPolicy(cwd).expectedConfig.sha256,
    ...projectedPolicy(cwd),
    permissionProfileId: 'polygram-session',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    hookManifest: {
      ownedCwd: cwd,
      entries: HOOK_EVENTS.map(hookDescriptor),
    },
    hookArtifactsSha256: digest('hook-artifacts'),
  };
  return { root, cwd, codexHome, binary, env, profile };
}

function makeRealClient(workspace, clients, {
  expectedConfigSha256,
  hookManifest,
  onNotification,
  onFault,
}) {
  const client = new CodexAppServerClient({
    binary: workspace.binary,
    cwd: workspace.cwd,
    codexHome: workspace.codexHome,
    env: workspace.env,
    expectedConfigSha256,
    ...(hookManifest == null ? {} : { hookManifest }),
    requestTimeoutMs: 5_000,
    closeGraceMs: 100,
    closeKillMs: 200,
    attestBinaryFn: async (binary, targetReceipt) => ({
      path: binary,
      target: targetReceipt.target,
      sha256: targetReceipt.binarySha256,
      version: targetReceipt.cliVersion,
    }),
    attestCodexHomeFn: (home, expectedHash) => (
      attestPinnedCodexHome(home, expectedHash, { temporaryRoots: [] })
    ),
    onNotification,
    onFault,
  });
  clients.push(client);
  return client;
}

function preflightClientFactory(workspace, clients) {
  return (options) => makeRealClient(workspace, clients, {
    expectedConfigSha256: options.expectedConfigSha256,
    hookManifest: options.hookManifest,
    onNotification: options.onNotification,
    onFault: options.onFault,
  });
}

// Stands in for the consumer seam: it sees only the profile the factory hands
// it, and takes the manifest from there.
function sessionClientFactory(workspace, clients) {
  return (options) => makeRealClient(workspace, clients, {
    expectedConfigSha256: options.expectedStaticProfile.ownedConfigSha256,
    hookManifest: options.expectedStaticProfile.hookManifest,
    onNotification: options.onNotification,
    onFault: options.onFault,
  });
}

test('a hook-carrying profile verifies over the real transport before the thread and before every turn', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the pinned app-server client is not supported on Windows');
    return;
  }
  const workspace = buildWorkspace(t);
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });
  const requestLog = path.join(workspace.cwd, REQUEST_LOG);

  const preflightResult = await preflightCodexRuntime(workspace.profile, {
    clientFactory: preflightClientFactory(workspace, clients),
  });
  const spawnProfile = createCodexSpawnProfile(
    workspace.profile,
    preflightResult,
  );

  const factory = createProcessFactory({
    config: { chats: {} },
    logger: SILENT,
    codexClientFactory: sessionClientFactory(workspace, clients),
    codexCheckpointSink: async () => {},
    codexHostIdentity: 'host-composition',
    codexBootSessionIdentity: 'boot-composition',
    codexExpectedStaticProfile: () => spawnProfile,
  });
  const proc = factory('codex-composition', {
    runtime: 'codex',
    spawnProfileId: spawnProfile.spawnProfileId,
    modelSettings: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    chatId: 'composition',
    threadId: null,
    label: 'composition',
  });
  t.after(() => proc.kill());

  await proc.start(proc.spawnOptions);
  await proc.send('composition prompt');
  // A second turn on the same live session: the point of re-verifying is that
  // a session cannot coast on the attachment's verification.
  await proc.send('second composition prompt');
  await waitFor(
    () => readRequests(requestLog).filter(
      (message) => message.method === 'turn/start',
    ).length === 2,
    'both turn/start requests on the wire',
  );

  const dispatched = readRequests(requestLog)
    .filter((message) => Object.hasOwn(message, 'id'))
    .map((message) => message.method);
  assert.deepEqual(dispatched, [
    // preflight generation
    'initialize',
    'config/read',
    'configRequirements/read',
    'permissionProfile/list',
    'hooks/list',
    'account/read',
    'model/list',
    // session generation
    'initialize',
    'hooks/list',
    'thread/start',
    'config/read',
    'configRequirements/read',
    'permissionProfile/list',
    'hooks/list',
    'turn/start',
    'thread/backgroundTerminals/list',
    'config/read',
    'configRequirements/read',
    'permissionProfile/list',
    'hooks/list',
    'turn/start',
    'thread/backgroundTerminals/list',
  ]);

  const sessionRequests = readRequests(requestLog)
    .filter((message) => Object.hasOwn(message, 'id'));
  const sessionStart = sessionRequests.findLastIndex(
    (message) => message.method === 'initialize',
  );
  const session = sessionRequests.slice(sessionStart);
  const hookIndexes = session
    .map((message, index) => (message.method === 'hooks/list' ? index : -1))
    .filter((index) => index !== -1);
  const threadIndex = session.findIndex(
    (message) => message.method === 'thread/start',
  );
  const turnIndexes = session
    .map((message, index) => (message.method === 'turn/start' ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(hookIndexes.length, 3);
  assert.equal(turnIndexes.length, 2);
  assert.ok(hookIndexes[0] < threadIndex, 'verified before thread attachment');
  assert.ok(hookIndexes[1] > threadIndex, 're-verified for the first turn');
  assert.ok(hookIndexes[1] < turnIndexes[0], 'verified before the first turn');
  assert.ok(
    hookIndexes[2] > turnIndexes[0] && hookIndexes[2] < turnIndexes[1],
    'verified again between the first and second turn',
  );
  for (const message of session.filter((entry) => entry.method === 'hooks/list')) {
    assert.deepEqual(message.params, { cwds: [workspace.cwd] });
  }

  await proc.kill();
});

test('a resumed attachment is verified over the real transport before it resumes and before its turn', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the pinned app-server client is not supported on Windows');
    return;
  }
  const workspace = buildWorkspace(t);
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });
  const requestLog = path.join(workspace.cwd, REQUEST_LOG);

  const preflightResult = await preflightCodexRuntime(workspace.profile, {
    clientFactory: preflightClientFactory(workspace, clients),
  });
  const spawnProfile = createCodexSpawnProfile(
    workspace.profile,
    preflightResult,
  );
  const factory = createProcessFactory({
    config: { chats: {} },
    logger: SILENT,
    codexClientFactory: sessionClientFactory(workspace, clients),
    codexCheckpointSink: async () => {},
    codexHostIdentity: 'host-composition',
    codexBootSessionIdentity: 'boot-composition',
    codexExpectedStaticProfile: () => spawnProfile,
  });
  const proc = factory('codex-composition-resume', {
    runtime: 'codex',
    spawnProfileId: spawnProfile.spawnProfileId,
    modelSettings: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    chatId: 'composition',
    threadId: null,
    label: 'composition-resume',
    existingSessionId: 'thread-1',
  });
  t.after(() => proc.kill());

  await proc.start(proc.spawnOptions);
  await proc.send('resumed composition prompt');
  await waitFor(
    () => readRequests(requestLog).some(
      (message) => message.method === 'turn/start',
    ),
    'turn/start on the wire',
  );

  const sessionRequests = readRequests(requestLog)
    .filter((message) => Object.hasOwn(message, 'id'));
  const session = sessionRequests.slice(
    sessionRequests.findLastIndex((message) => message.method === 'initialize'),
  );
  assert.deepEqual(session.map((message) => message.method), [
    'initialize',
    'hooks/list',
    'thread/resume',
    'config/read',
    'configRequirements/read',
    'permissionProfile/list',
    'hooks/list',
    'turn/start',
    'thread/backgroundTerminals/list',
  ]);
  // A resumed thread executes hooks exactly as a fresh one does, so the
  // resume boundary is verified in its own right, not inherited from start.
  assert.ok(
    session.findIndex((message) => message.method === 'hooks/list')
      < session.findIndex((message) => message.method === 'thread/resume'),
    'verified before the thread resumed',
  );
  assert.equal(
    session.filter((message) => message.method === 'hooks/list').length,
    2,
  );
  assert.equal(proc.claudeSessionId, 'thread-1');

  await proc.kill();
});

// The peer's sequence cursor lives in the app-server process, and preflight
// runs its own. The refusal tests below are about the session's refusal, so the
// profile is minted through a policy-only client and every real-transport
// hooks/list call belongs to the session under test. The three tests above
// already prove the preflight leg over the real transport.
function policyPreflightClient(profile) {
  return {
    async start() {},
    async request(method) {
      if (method === 'config/read') {
        return {
          config: profile.expectedConfig,
          layers: profile.expectedLayers,
          originsSha256: profile.expectedOriginsSha256,
        };
      }
      if (method === 'configRequirements/read') {
        return { requirements: profile.expectedRequirements };
      }
      if (method === 'permissionProfile/list') {
        return {
          data: profile.expectedPermissionProfiles,
          nextCursor: null,
        };
      }
      if (method === 'account/read') {
        return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
      }
      if (method === 'model/list') {
        return {
          data: [{
            id: profile.model,
            model: profile.model,
            description: 'Pinned coding model',
            displayName: 'GPT-5.6 Sol',
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: ['high', 'xhigh'],
            hidden: false,
            isDefault: true,
          }],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected preflight method ${method}`);
    },
    async close() {},
    async waitForFault() { return null; },
    async verifyHooks() { return []; },
  };
}

async function composeUntilRefusal(t, { trustStatuses, existingSessionId = null }) {
  const workspace = buildWorkspace(t, { trustStatuses });
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });
  const preflightResult = await preflightCodexRuntime(workspace.profile, {
    clientFactory: () => policyPreflightClient(workspace.profile),
  });
  const spawnProfile = createCodexSpawnProfile(
    workspace.profile,
    preflightResult,
  );
  const factory = createProcessFactory({
    config: { chats: {} },
    logger: SILENT,
    codexClientFactory: sessionClientFactory(workspace, clients),
    codexCheckpointSink: async () => {},
    codexHostIdentity: 'host-composition',
    codexBootSessionIdentity: 'boot-composition',
    codexExpectedStaticProfile: () => spawnProfile,
  });
  const proc = factory('codex-composition-refusal', {
    runtime: 'codex',
    spawnProfileId: spawnProfile.spawnProfileId,
    modelSettings: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    chatId: 'composition',
    threadId: null,
    label: 'composition-refusal',
    ...(existingSessionId === null ? {} : { existingSessionId }),
  });
  t.after(() => proc.kill());
  return {
    workspace,
    proc,
    clients,
    requestLog: path.join(workspace.cwd, REQUEST_LOG),
  };
}

function sessionMethods(requestLog) {
  const dispatched = readRequests(requestLog)
    .filter((message) => Object.hasOwn(message, 'id'));
  return dispatched
    .slice(dispatched.findLastIndex((message) => message.method === 'initialize'))
    .map((message) => message.method);
}

const PROTECTED_MUTATIONS = [
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
];

// Both refusals are driven by the peer changing its answer between calls
// against a real session client, so what is asserted is the state the transport
// and the process are actually left in, not a fake verifier being killed.
test('a refused hook inventory at startup leaves no mutation and a completed cleanup', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the pinned app-server client is not supported on Windows');
    return;
  }
  // The session's very first hooks/list already disagrees with the manifest.
  const { proc, clients, requestLog } = await composeUntilRefusal(t, {
    trustStatuses: ['modified'],
  });

  const error = await proc.start(proc.spawnOptions).then(
    () => null,
    (caught) => caught,
  );

  assert.ok(error);
  assert.equal(error.code, 'CODEX_HOOK_TRUST_UNVERIFIED');
  const methods = sessionMethods(requestLog);
  assert.deepEqual(methods, ['initialize', 'hooks/list']);
  for (const mutation of PROTECTED_MUTATIONS) {
    assert.equal(methods.includes(mutation), false, mutation);
  }

  const sessionClient = clients.at(-1);
  const outcome = await sessionClient.waitForFault();
  assert.equal(outcome.errorCode, 'CODEX_HOOK_TRUST_UNVERIFIED');
  assert.equal(outcome.cleanup, 'completed');
  assert.equal(outcome.boundary, 'post-spawn');
  assert.equal(outcome.mutationOutcomeUnknown, false);
  assert.equal(sessionClient.state, 'closed');
  assert.notEqual(sessionClient.exitInfo, null);
  assert.throws(() => sessionClient.assertHealthy());
  assert.equal(proc.claudeSessionId, null);
});

test('a refused hook inventory mid-session leaves the turn unsent and a completed cleanup', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the pinned app-server client is not supported on Windows');
    return;
  }
  // The attachment verifies, and the hooks change before the turn.
  const { proc, clients, requestLog } = await composeUntilRefusal(t, {
    trustStatuses: ['trusted', 'modified'],
  });
  await proc.start(proc.spawnOptions);

  const error = await proc.send('prompt after the hooks changed').then(
    () => null,
    (caught) => caught,
  );

  assert.ok(error);
  assert.equal(error.code, 'CODEX_HOOK_TRUST_UNVERIFIED');
  assert.equal(error.deliveryState, 'not-sent');
  const methods = sessionMethods(requestLog);
  assert.deepEqual(methods, [
    'initialize',
    'hooks/list',
    'thread/start',
    'config/read',
    'configRequirements/read',
    'permissionProfile/list',
    'hooks/list',
  ]);
  assert.equal(methods.includes('turn/start'), false);
  assert.equal(methods.at(-1), 'hooks/list');

  const sessionClient = clients.at(-1);
  const outcome = await sessionClient.waitForFault();
  assert.equal(outcome.errorCode, 'CODEX_HOOK_TRUST_UNVERIFIED');
  assert.equal(outcome.cleanup, 'completed');
  assert.equal(outcome.mutationOutcomeUnknown, false);
  assert.equal(sessionClient.state, 'closed');
  assert.notEqual(sessionClient.exitInfo, null);
  assert.throws(() => sessionClient.assertHealthy());
});

test('a hooks-off profile composes into the same session traffic it always had', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the pinned app-server client is not supported on Windows');
    return;
  }
  const workspace = buildWorkspace(t);
  const { hookManifest, hookArtifactsSha256, ...hooksOffProfile } =
    workspace.profile;
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });
  const requestLog = path.join(workspace.cwd, REQUEST_LOG);

  const preflightResult = await preflightCodexRuntime(hooksOffProfile, {
    clientFactory: preflightClientFactory(workspace, clients),
  });
  const spawnProfile = createCodexSpawnProfile(
    hooksOffProfile,
    preflightResult,
  );
  const factory = createProcessFactory({
    config: { chats: {} },
    logger: SILENT,
    codexClientFactory: sessionClientFactory(workspace, clients),
    codexCheckpointSink: async () => {},
    codexHostIdentity: 'host-composition',
    codexBootSessionIdentity: 'boot-composition',
    codexExpectedStaticProfile: () => spawnProfile,
  });
  const proc = factory('codex-composition-off', {
    runtime: 'codex',
    spawnProfileId: spawnProfile.spawnProfileId,
    modelSettings: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    chatId: 'composition',
    threadId: null,
    label: 'composition-off',
  });
  t.after(() => proc.kill());

  await proc.start(proc.spawnOptions);
  await proc.send('composition prompt');

  assert.equal(proc.hookVerifier, null);
  assert.equal(clients[1].hookManifest, null);
  assert.deepEqual(
    readRequests(requestLog)
      .filter((message) => Object.hasOwn(message, 'id'))
      .map((message) => message.method),
    [
      'initialize',
      'config/read',
      'configRequirements/read',
      'permissionProfile/list',
      'account/read',
      'model/list',
      'initialize',
      'thread/start',
      'config/read',
      'configRequirements/read',
      'permissionProfile/list',
      'turn/start',
      'thread/backgroundTerminals/list',
    ],
  );
  await proc.kill();
});
