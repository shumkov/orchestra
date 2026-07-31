'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CliProcess,
  CodexProcess,
  createCodexSpawnProfile,
  preflightCodexRuntime,
  reattestCodexStaticPolicy,
} = require('../index');
const { createProcessFactory } = require('../lib/process/factory');
const {
  buildCodexAppServerEnv,
  protocolSchema,
  resolveCodexTargetPin,
} = require('../lib/codex/app-server-client');

// Minimal fakes so the 'cli' backend wiring is satisfied and the factory
// actually constructs a CliProcess (rather than logging "not wired" and
// falling back to SDK). Shapes match lib/tmux/tmux-runner.js + the
// toolDispatcher contract. Nothing is started, so no method fires here.
const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
};
const fakeDispatcher = async () => ({ ok: true });
const quietLogger = { warn: () => {}, error: () => {}, log: () => {} };
const acknowledgedCheckpointSink = async () => {};

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
    .update(typeof value === 'string'
      ? value
      : JSON.stringify(canonical(value)))
    .digest('hex');
}

function codexExpectedStaticProfile(overrides = {}) {
  const targetReceipt = resolveCodexTargetPin();
  const codexHome = '/srv/orchestra/codex-home';
  const env = {
    HOME: '/srv/orchestra',
    TMPDIR: '/srv/orchestra/tmp',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
  };
  const expectedConfig = {
    sha256: digest('effective-config'),
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
      filesystemSha256: digest('filesystem-policy'),
      filesystem: [{
        rootSha256: digest('.'),
        access: 'write',
      }],
    }],
    mcpServers: { count: 0, keySha256: [] },
    plugins: { count: 0, keySha256: [] },
    modelProviders: { count: 0, keySha256: [] },
  };
  return {
    runtime: 'codex',
    binary: '/opt/orchestra/codex-0.145.0',
    target: targetReceipt.target,
    binarySha256: targetReceipt.binarySha256,
    cliVersion: targetReceipt.cliVersion,
    protocolSchemaSha256:
      protocolSchema.generatedProtocolV2CanonicalSha256,
    codexHome,
    cwd: '/trusted/workspace',
    env,
    allowlistedEnvironmentFingerprint: digest(
      buildCodexAppServerEnv(codexHome, env),
    ),
    ownedConfigSha256: digest('owned-config'),
    expectedConfigSha256: expectedConfig.sha256,
    expectedConfig,
    expectedLayers: [],
    expectedOriginsSha256: digest('origins'),
    expectedRequirements: null,
    expectedPermissionProfiles: [{
      id: 'polygram-session',
      allowed: true,
      descriptionSha256: digest('profile-description'),
    }],
    permissionProfileId: 'polygram-session',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    ...overrides,
  };
}

async function codexSpawnProfile({
  additionalModels = [],
  ...overrides
} = {}) {
  const profile = codexExpectedStaticProfile(overrides);
  const client = {
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
        return {
          account: { type: 'chatgpt' },
          requiresOpenaiAuth: true,
        };
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
          }, ...additionalModels],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected test preflight method ${method}`);
    },
    async close() {},
    async waitForFault() { return null; },
  };
  const result = await preflightCodexRuntime(profile, {
    clientFactory: () => client,
  });
  return createCodexSpawnProfile(profile, result);
}

async function makeCodexFactory(overrides = {}) {
  const spawnProfile = overrides.codexSpawnProfile
    ?? await codexSpawnProfile();
  const normalizedOverrides = { ...overrides };
  delete normalizedOverrides.codexSpawnProfile;
  return createProcessFactory({
    config: { chats: {} },
    logger: quietLogger,
    codexClientFactory: () => ({
      start: async () => {},
      request: async () => ({}),
      close: async () => {},
    }),
    codexCheckpointSink: acknowledgedCheckpointSink,
    codexHostIdentity: 'host-a',
    codexBootSessionIdentity: 'boot-a',
    codexExpectedStaticProfile: () => spawnProfile,
    ...normalizedOverrides,
  });
}

// Base wiring shared by every factory in this file. displayHint is layered on
// per-test. pmDefault:'cli' + empty config → every spawn routes to CliProcess.
function makeFactory(displayHint) {
  return createProcessFactory({
    config: { chats: {} },
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: quietLogger,
    displayHint,
    pmDefault: 'cli',
  });
}

test('displayHint function is resolved per spawn with (chatId, threadId, config)', () => {
  const config = { chats: {} };
  const calls = [];
  const resolver = (chatId, threadId, cfg) => {
    calls.push([chatId, threadId, cfg]);
    return `hint for ${chatId}/${threadId}`;
  };

  const factory = createProcessFactory({
    config,
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: quietLogger,
    displayHint: resolver,
    pmDefault: 'cli',
  });

  const proc = factory('session-1', { chatId: '123', threadId: '77', label: 'chat-a' });

  assert.ok(proc instanceof CliProcess, 'should construct a CliProcess');
  // The resolver ran once, with the spawning chat/topic and the closed-over config.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['123', '77']);
  assert.equal(calls[0][2], config, 'resolver receives the factory config object');
  // The CliProcess got the RESOLVED string — not the function, not a fallback.
  assert.equal(proc.displayHint, 'hint for 123/77');
  assert.equal(typeof proc.displayHint, 'string');
});

test('displayHint function resolves independently for each chat/topic', () => {
  const factory = makeFactory((chatId) => (chatId === 'rich' ? 'RICH TEXT ON' : ''));

  const rich = factory('s-rich', { chatId: 'rich', threadId: null });
  const plain = factory('s-plain', { chatId: 'plain', threadId: null });

  assert.equal(rich.displayHint, 'RICH TEXT ON');
  assert.equal(plain.displayHint, '');
});

test('displayHint string is forwarded unchanged (back-compat)', () => {
  const factory = makeFactory('static hint for all chats');

  const proc = factory('session-2', { chatId: '456', threadId: null, label: 'chat-b' });

  assert.ok(proc instanceof CliProcess);
  assert.equal(proc.displayHint, 'static hint for all chats');
});

test('displayHint default (omitted) is empty string', () => {
  const factory = createProcessFactory({
    config: { chats: {} },
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: quietLogger,
    pmDefault: 'cli',
  });

  const proc = factory('session-3', { chatId: '789', threadId: null });
  assert.equal(proc.displayHint, '');
});

test('runtime:codex constructs CodexProcess only from trusted factory profile inputs', async () => {
  const resolverCalls = [];
  const spawnProfile = await codexSpawnProfile();
  const profile = spawnProfile.expectedStaticProfile;
  const policyCalls = [];
  const fakeClient = {
    start: async () => {},
    request: async (method, params) => {
      policyCalls.push({ method, params });
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
      throw new Error(`unexpected runtime policy method ${method}`);
    },
    close: async () => {},
  };
  let clientFactoryOptions = null;
  const factory = await makeCodexFactory({
    codexSpawnProfile: spawnProfile,
    codexExpectedStaticProfile: (sessionKey, ctx) => {
      resolverCalls.push([sessionKey, ctx]);
      return spawnProfile;
    },
    codexClientFactory: (options) => {
      clientFactoryOptions = options;
      return fakeClient;
    },
  });
  const untrustedContext = {
    runtime: 'codex',
    spawnProfileId: spawnProfile.spawnProfileId,
    modelSettings: {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    },
    chatId: '123',
    threadId: '77',
    label: 'codex-chat',
    existingSessionId: 'thread_123',
  };

  const proc = factory('codex-session', untrustedContext);

  assert.ok(proc instanceof CodexProcess);
  assert.equal(proc.backend, 'codex');
  assert.equal(proc.runtime, 'codex');
  assert.equal(proc.spawnProfileId, spawnProfile.spawnProfileId);
  assert.equal(proc.cwd, '/trusted/workspace');
  assert.equal(proc.expectedPermissionProfileId, 'polygram-session');
  assert.deepEqual(proc.expectedStaticPolicy, {
    modelProvider: 'openai',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    runtimeWorkspaceRoots: {
      count: 1,
      sha256: [digest('/trusted/workspace')],
    },
    sandbox: {
      type: 'workspaceWrite',
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      writableRootCount: 0,
      writableRootSha256: [],
    },
    permissionProfile: {
      id: 'polygram-session',
      extends: null,
    },
  });
  assert.ok(Object.isFrozen(proc.expectedStaticPolicy));
  assert.ok(Object.isFrozen(proc.expectedStaticPolicy.runtimeWorkspaceRoots));
  assert.ok(Object.isFrozen(proc.expectedStaticPolicy.runtimeWorkspaceRoots.sha256));
  assert.ok(Object.isFrozen(proc.expectedStaticPolicy.sandbox));
  assert.ok(Object.isFrozen(proc.expectedStaticPolicy.sandbox.writableRootSha256));
  assert.ok(Object.isFrozen(proc.expectedStaticPolicy.permissionProfile));
  assert.deepEqual(proc.modelCatalog, spawnProfile.modelCatalog.map((entry) => ({
    model: entry.model,
    supportedReasoningEfforts: entry.supportedReasoningEfforts,
  })));
  assert.deepEqual(proc.spawnOptions, {
    existingSessionId: 'thread_123',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  assert.ok(Object.isFrozen(proc.spawnOptions));
  assert.equal(Object.hasOwn(proc, 'expectedStaticProfile'), false);
  assert.equal(Object.hasOwn(proc, 'env'), false);
  assert.equal(Object.hasOwn(proc, 'sessionLauncher'), false);
  assert.equal(typeof proc.staticPolicyAttestor, 'function');
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0][0], 'codex-session');
  assert.deepEqual(resolverCalls[0][1], {
    runtime: 'codex',
    spawnProfileId: spawnProfile.spawnProfileId,
  });
  assert.ok(Object.isFrozen(resolverCalls[0][1]));

  const onNotification = () => {};
  const onFault = () => {};
  assert.equal(proc.clientFactory({ onNotification, onFault }), fakeClient);
  assert.deepEqual(clientFactoryOptions, {
    sessionKey: 'codex-session',
    expectedStaticProfile: profile,
    onNotification,
    onFault,
  });
  assert.equal(clientFactoryOptions.expectedStaticProfile, profile);
  assert.ok(Object.isFrozen(clientFactoryOptions));
  await proc.staticPolicyAttestor(fakeClient);
  assert.deepEqual(policyCalls, [
    {
      method: 'config/read',
      params: { cwd: profile.cwd, includeLayers: true },
    },
    {
      method: 'configRequirements/read',
      params: undefined,
    },
    {
      method: 'permissionProfile/list',
      params: { cwd: profile.cwd },
    },
  ]);
});

test('factory-created named-profile threads reach turn/start with real runtime policy', async (t) => {
  for (const existingSessionId of [null, 'thread-existing']) {
    await t.test(existingSessionId ? 'resume' : 'fresh', async () => {
      const spawnProfile = await codexSpawnProfile();
      const profile = spawnProfile.expectedStaticProfile;
      const calls = [];
      let callbacks;
      const fakeClient = {
        start: async () => {},
        request: async (method, params) => {
          calls.push({ method, params });
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
          if (method === 'thread/start' || method === 'thread/resume') {
            const threadId = params.threadId ?? 'thread-fresh';
            await callbacks.onNotification({
              method: 'thread/settings/updated',
              params: {
                threadId,
                threadSettings: {
                  model: 'gpt-5.6-sol',
                  effort: 'xhigh',
                  modelProvider: 'openai',
                  approvalPolicy: 'never',
                  approvalsReviewer: 'user',
                  sandboxPolicy: {
                    type: 'workspaceWrite',
                    networkAccess: false,
                    excludeSlashTmp: true,
                    excludeTmpdirEnvVar: true,
                    writableRootCount: 0,
                    writableRootSha256: [],
                  },
                  activePermissionProfile: {
                    id: 'polygram-session',
                    extends: null,
                  },
                },
              },
            });
            return {
              cwd: profile.cwd,
              model: 'gpt-5.6-sol',
              modelProvider: 'openai',
              reasoningEffort: 'xhigh',
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              runtimeWorkspaceRoots: {
                count: 1,
                sha256: [digest(profile.cwd)],
              },
              sandbox: {
                type: 'workspaceWrite',
                networkAccess: false,
                excludeSlashTmp: true,
                excludeTmpdirEnvVar: true,
                writableRootCount: 0,
                writableRootSha256: [],
              },
              activePermissionProfile: {
                id: 'polygram-session',
                extends: null,
              },
              thread: {
                id: threadId,
                status: { type: 'idle' },
                turns: [],
              },
            };
          }
          if (method === 'turn/start') {
            setImmediate(async () => {
              await callbacks.onNotification({
                method: 'turn/started',
                params: {
                  threadId: existingSessionId ?? 'thread-fresh',
                  turn: {
                    id: 'turn-1',
                    status: 'inProgress',
                    items: [],
                    error: null,
                  },
                },
              });
              await callbacks.onNotification({
                method: 'turn/completed',
                params: {
                  threadId: existingSessionId ?? 'thread-fresh',
                  turn: {
                    id: 'turn-1',
                    status: 'completed',
                    items: [],
                    error: null,
                  },
                },
              });
            });
            return {
              turn: {
                id: 'turn-1',
                status: 'inProgress',
                items: [],
                error: null,
              },
            };
          }
          if (method === 'thread/backgroundTerminals/list') {
            return { count: 0, nextCursor: null };
          }
          throw new Error(`unexpected request ${method}`);
        },
        close: async () => {},
        waitForFault: () => new Promise(() => {}),
      };
      const factory = await makeCodexFactory({
        codexSpawnProfile: spawnProfile,
        codexExpectedStaticProfile: () => spawnProfile,
        codexClientFactory: (options) => {
          callbacks = options;
          return fakeClient;
        },
      });
      const proc = factory(`named-profile-${existingSessionId ?? 'fresh'}`, {
        runtime: 'codex',
        spawnProfileId: spawnProfile.spawnProfileId,
        modelSettings: { model: 'gpt-5.6-sol', effort: 'xhigh' },
        chatId: '123',
        threadId: null,
        label: 'named-profile',
        existingSessionId,
      });

      try {
        await proc.start(proc.spawnOptions);
        await proc.send('first prompt');
        assert.equal(
          calls.filter(({ method }) => method === 'turn/start').length,
          1,
        );
      } catch (error) {
        if (error.code === 'CODEX_THREAD_POLICY_MISMATCH') {
          assert.equal(
            calls.some(({ method }) => method === 'turn/start'),
            false,
            'policy mismatch must reject before dispatching the prompt',
          );
        }
        throw error;
      }
    });
  }
});

test('runtime:codex keeps deployment model defaults separate from the selected thread model', async () => {
  const cases = [
    {
      deploymentModel: null,
      selectedModel: 'gpt-5.6-sol',
    },
    {
      deploymentModel: 'deployment-default-model',
      selectedModel: 'selected-thread-model',
    },
  ];

  for (const { deploymentModel, selectedModel } of cases) {
    const baseProfile = codexExpectedStaticProfile();
    const spawnProfile = await codexSpawnProfile({
      model: selectedModel,
      expectedConfig: {
        ...baseProfile.expectedConfig,
        model: deploymentModel,
      },
    });
    const factory = await makeCodexFactory({
      codexSpawnProfile: spawnProfile,
    });

    const proc = factory(`codex-${selectedModel}`, {
      runtime: 'codex',
      spawnProfileId: spawnProfile.spawnProfileId,
      modelSettings: {
        model: selectedModel,
        effort: 'xhigh',
      },
    });

    assert.equal(proc.spawnOptions.model, selectedModel);
    assert.equal(
      proc.modelCatalog.some(({ model }) => model === selectedModel),
      true,
    );
  }
});

test('runtime:codex starts from a catalog-valid dynamic model pair', async () => {
  const spawnProfile = await codexSpawnProfile({
    additionalModels: [{
      id: 'gpt-5.5-codex',
      model: 'gpt-5.5-codex',
      description: 'Alternate coding model',
      displayName: 'GPT-5.5 Codex',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      hidden: false,
      isDefault: false,
    }],
  });
  const factory = await makeCodexFactory({
    codexSpawnProfile: spawnProfile,
  });

  const proc = factory('codex-dynamic-settings', {
    runtime: 'codex',
    spawnProfileId: spawnProfile.spawnProfileId,
    modelSettings: {
      model: 'gpt-5.5-codex',
      effort: 'low',
    },
  });

  assert.deepEqual(proc.spawnOptions, {
    model: 'gpt-5.5-codex',
    effort: 'low',
  });

  for (const modelSettings of [
    { model: 'gpt-5.5-codex', effort: 'xhigh' },
    { model: 'missing-model', effort: 'low' },
    { model: 'gpt-5.5-codex' },
    { model: 'gpt-5.5-codex', effort: 'low', cwd: '/attacker' },
  ]) {
    assert.throws(
      () => factory('codex-invalid-dynamic-settings', {
        runtime: 'codex',
        spawnProfileId: spawnProfile.spawnProfileId,
        modelSettings,
      }),
      (error) => error?.code === 'CODEX_BACKEND_NOT_CONFIGURED',
    );
  }
});

test('runtime:codex rejects an interrupted turn without strict recovery policy', async () => {
  const spawnProfile = await codexSpawnProfile();
  const factory = await makeCodexFactory({ codexSpawnProfile: spawnProfile });

  assert.throws(
    () => factory('codex-orphaned-turn', {
      runtime: 'codex',
      spawnProfileId: spawnProfile.spawnProfileId,
      modelSettings: {
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      },
      existingSessionId: 'thread-existing',
      expectedInterruptedTurnId: 'turn-without-policy',
    }),
    (error) => error?.code === 'CODEX_BACKEND_NOT_CONFIGURED',
  );
});

test('runtime:codex rejects raw launcher, environment, and policy context', async () => {
  const spawnProfile = await codexSpawnProfile();
  let clientFactoryCalls = 0;
  const factory = await makeCodexFactory({
    codexSpawnProfile: spawnProfile,
    codexClientFactory: () => {
      clientFactoryCalls += 1;
      return {};
    },
  });
  const forbidden = {
    cwd: '/attacker/cwd',
    model: 'attacker-model',
    effort: 'attacker-effort',
    env: { PATH: '/attacker/bin' },
    sessionLauncher: '/attacker/launcher',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'danger-full-access' },
    permissions: { profile: 'attacker' },
    config: { model_provider: 'attacker' },
  };

  for (const [key, value] of Object.entries(forbidden)) {
    assert.throws(
      () => factory('codex-session', {
        runtime: 'codex',
        spawnProfileId: spawnProfile.spawnProfileId,
        [key]: value,
      }),
      error => error?.code === 'CODEX_BACKEND_NOT_CONFIGURED',
      `expected raw ${key} to be rejected`,
    );
  }
  assert.equal(clientFactoryCalls, 0);
});

test('runtime:codex missing or mismatched trusted wiring fails typed before SDK construction', async () => {
  let sdkConstructions = 0;
  const spawnProfile = await codexSpawnProfile();
  class CountingSdkProcess {
    constructor() {
      sdkConstructions += 1;
      this.backend = 'sdk';
    }
  }
  const base = {
    config: { chats: {} },
    logger: quietLogger,
    SdkProcess: CountingSdkProcess,
    codexClientFactory: () => ({}),
    codexCheckpointSink: acknowledgedCheckpointSink,
    codexHostIdentity: 'host-a',
    codexBootSessionIdentity: 'boot-a',
    codexExpectedStaticProfile: () => spawnProfile,
  };
  const cases = [
    ['CodexProcess', null],
    ['CodexProcess', () => ({})],
    ['codexClientFactory', undefined],
    ['codexCheckpointSink', undefined],
    ['codexHostIdentity', null],
    ['codexBootSessionIdentity', ''],
    ['codexExpectedStaticProfile', undefined],
    ['codexExpectedStaticProfile', () => null],
    ['codexExpectedStaticProfile', () => ({ ...spawnProfile })],
    ['codexExpectedStaticProfile', () => spawnProfile.expectedStaticProfile],
  ];

  for (const [key, value] of cases) {
    const factory = createProcessFactory({ ...base, [key]: value });
    assert.throws(
      () => factory('codex-session', {
        runtime: 'codex',
        spawnProfileId: spawnProfile.spawnProfileId,
      }),
      error => error?.code === 'CODEX_BACKEND_NOT_CONFIGURED',
      `expected typed failure for ${key}`,
    );
  }

  const mismatchFactory = createProcessFactory(base);
  assert.throws(
    () => mismatchFactory('codex-session', {
      runtime: 'codex',
      spawnProfileId: 'different-profile',
    }),
    error => error?.code === 'CODEX_BACKEND_NOT_CONFIGURED',
  );
  assert.equal(sdkConstructions, 0);
});

test('an explicit unknown runtime fails typed without entering any Claude backend', () => {
  let sdkConstructions = 0;
  class CountingSdkProcess {
    constructor() {
      sdkConstructions += 1;
    }
  }
  const factory = createProcessFactory({
    config: { chats: {} },
    SdkProcess: CountingSdkProcess,
    logger: quietLogger,
  });

  assert.throws(
    () => factory('mistyped-runtime', {
      runtime: 'codxe',
      chatId: '123',
    }),
    error => error?.code === 'RUNTIME_UNKNOWN',
  );
  assert.equal(sdkConstructions, 0);
});

test('runtime:codex accepts only a bounded opaque existingSessionId', async () => {
  const spawnProfile = await codexSpawnProfile();
  const factory = await makeCodexFactory({
    codexSpawnProfile: spawnProfile,
  });
  for (const existingSessionId of ['', 'bad\u0000id', 'x'.repeat(513)]) {
    assert.throws(
      () => factory('codex-session', {
        runtime: 'codex',
        spawnProfileId: spawnProfile.spawnProfileId,
        existingSessionId,
      }),
      error => error?.code === 'CODEX_BACKEND_NOT_CONFIGURED',
    );
  }
});

test('omitted or claude runtime preserves Claude backend aliases and fallback', () => {
  class FakeSdkProcess {
    constructor() {
      this.backend = 'sdk';
    }
  }
  const factory = createProcessFactory({
    config: { chats: {} },
    logger: quietLogger,
    SdkProcess: FakeSdkProcess,
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
  });

  assert.ok(factory('omitted-runtime', {
    chatId: '1',
    pm: 'ignored-context-field',
  }) instanceof CliProcess);
  assert.ok(factory('claude-runtime', {
    runtime: 'claude',
    chatId: '2',
  }) instanceof CliProcess);

  const unknownFactory = createProcessFactory({
    config: { bot: { pm: 'unknown-backend' } },
    logger: quietLogger,
    SdkProcess: FakeSdkProcess,
  });
  assert.equal(
    unknownFactory('unknown', { runtime: 'claude', chatId: '3' }).backend,
    'sdk',
  );
});

test("pm:'codex' remains an unknown Claude backend and never selects Codex", async () => {
  let codexConstructions = 0;
  class CountingCodexProcess {
    constructor() {
      codexConstructions += 1;
      this.backend = 'codex';
    }
  }
  class FakeSdkProcess {
    constructor() {
      this.backend = 'sdk';
    }
  }
  const factory = await makeCodexFactory({
    config: { bot: { pm: 'codex' } },
    CodexProcess: CountingCodexProcess,
    SdkProcess: FakeSdkProcess,
  });

  const proc = factory('claude-session', { chatId: '123' });

  assert.equal(proc.backend, 'sdk');
  assert.equal(codexConstructions, 0);
});

test('public Codex exports are inert at package require time', () => {
  assert.equal(typeof CodexProcess, 'function');
  assert.equal(typeof require('..').CodexAppServerClient, 'function');
  assert.equal(typeof preflightCodexRuntime, 'function');
  assert.equal(typeof createCodexSpawnProfile, 'function');
  assert.equal(typeof reattestCodexStaticPolicy, 'function');
  assert.equal(typeof require('..').assertCodexSpawnProfile, 'function');
  assert.equal(typeof require('..').attestPinnedCodexHome, 'function');
  assert.equal(typeof require('..').buildCodexAppServerEnv, 'function');
  assert.equal(typeof require('..').codexProtocolSchema, 'object');

  const script = [
    `const pkg = require(${JSON.stringify(path.resolve(__dirname, '..'))});`,
    "process.stdout.write(JSON.stringify([typeof pkg.CodexProcess, typeof pkg.CodexAppServerClient, typeof pkg.preflightCodexRuntime, typeof pkg.reattestCodexStaticPolicy, typeof pkg.createCodexSpawnProfile, typeof pkg.assertCodexSpawnProfile, typeof pkg.attestPinnedCodexHome, typeof pkg.buildCodexAppServerEnv, typeof pkg.codexProtocolSchema]));",
  ].join('');
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    child.stdout,
    '["function","function","function","function","function","function","function","function","object"]',
  );
});
