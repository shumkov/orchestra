'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  chmodSync,
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
  reattestCodexStaticPolicy,
} = require('../lib/codex/preflight');

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

function projectedConfig() {
  const workspaceRule = {
    rootSha256: digest('.'),
    access: 'write',
  };
  return {
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
      filesystem: [workspaceRule],
    }],
    mcpServers: { count: 0, keySha256: [] },
    plugins: { count: 0, keySha256: [] },
    modelProviders: { count: 0, keySha256: [] },
  };
}

function model(overrides = {}) {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    description: 'Fast coding model',
    displayName: 'GPT-5.6 Sol',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    hidden: false,
    isDefault: true,
    ...overrides,
  };
}

function expectedProfile(overrides = {}) {
  const targetReceipt = resolveCodexTargetPin();
  const codexHome = '/srv/orchestra/codex-home';
  const env = {
    HOME: '/srv/orchestra',
    PATH: '/must/not/cross',
    TMPDIR: '/srv/orchestra/tmp',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    SECRET: 'must-not-cross',
  };
  const controlledEnv = buildCodexAppServerEnv(codexHome, env);
  return {
    runtime: 'codex',
    binary: '/opt/orchestra/codex-0.145.0',
    target: targetReceipt.target,
    binarySha256: targetReceipt.binarySha256,
    cliVersion: targetReceipt.cliVersion,
    protocolSchemaSha256:
      protocolSchema.generatedProtocolV2CanonicalSha256,
    codexHome,
    cwd: '/srv/orchestra/workspace',
    env,
    allowlistedEnvironmentFingerprint: digest(controlledEnv),
    ownedConfigSha256: digest('owned-config.toml'),
    expectedConfigSha256: projectedConfig().sha256,
    expectedConfig: projectedConfig(),
    expectedLayers: [{
      type: 'user',
      version: '1',
      disabled: false,
      configSha256: digest('user-layer'),
    }],
    expectedOriginsSha256: digest('origins'),
    expectedRequirements: {
      sha256: digest('requirements'),
      keys: ['allowed_permission_profiles', 'default_permissions'],
    },
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

function staticResults(profile = expectedProfile()) {
  return {
    'config/read': {
      config: profile.expectedConfig,
      layers: profile.expectedLayers,
      originsSha256: profile.expectedOriginsSha256,
    },
    'configRequirements/read': {
      requirements: profile.expectedRequirements,
    },
    'permissionProfile/list': {
      data: profile.expectedPermissionProfiles,
      nextCursor: null,
    },
    'account/read': {
      account: { type: 'chatgpt' },
      requiresOpenaiAuth: true,
    },
    'model/list': {
      data: [model()],
      nextCursor: null,
    },
  };
}

class FakeClient {
  constructor(results, {
    failures = {},
    closeError = null,
    faultOutcome = null,
  } = {}) {
    this.results = results;
    this.failures = failures;
    this.closeError = closeError;
    this.faultOutcome = faultOutcome;
    this.calls = [];
    this.started = 0;
    this.closed = 0;
    this.faultWaits = 0;
    this.onFault = async () => {};
  }

  async start() {
    this.started += 1;
    if (this.failures.start) throw this.failures.start;
    return this;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (this.failures[method]) throw this.failures[method];
    const response = this.results[method];
    return typeof response === 'function'
      ? response(params, this.calls)
      : response;
  }

  async close() {
    this.closed += 1;
    if (this.faultOutcome) await this.onFault(this.faultOutcome);
    if (this.closeError) throw this.closeError;
  }

  async waitForFault() {
    this.faultWaits += 1;
    return this.faultOutcome;
  }
}

function makeFactory(client, observed = []) {
  return (options) => {
    observed.push(options);
    client.onFault = options.onFault;
    return client;
  };
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function deepFrozenClone(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value)
    ? value.map(deepFrozenClone)
    : Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        deepFrozenClone(child),
      ]),
    );
  return Object.freeze(clone);
}

test('live static-policy reattestation uses only policy reads and does not own the client lifecycle', async () => {
  const profile = expectedProfile();
  const client = new FakeClient(staticResults(profile));

  await reattestCodexStaticPolicy(profile, client);

  assert.equal(client.started, 0);
  assert.equal(client.closed, 0);
  assert.deepEqual(client.calls, [
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

test('live static-policy reattestation rejects exact policy drift without auth, model, or mutation calls', async () => {
  const profile = expectedProfile();
  const results = staticResults(profile);
  results['config/read'] = {
    ...results['config/read'],
    originsSha256: digest('drifted-origins'),
  };
  const client = new FakeClient(results);

  await assert.rejects(
    reattestCodexStaticPolicy(profile, client),
    (error) => error.code === 'CODEX_STATIC_PROFILE_MISMATCH',
  );

  assert.deepEqual(
    client.calls.map(({ method }) => method),
    [
      'config/read',
      'configRequirements/read',
      'permissionProfile/list',
    ],
  );
  assert.equal(client.started, 0);
  assert.equal(client.closed, 0);
});

test('preflight attests static policy before auth/model and returns frozen redacted data', async () => {
  const secret = 'MUST_NOT_ESCAPE_PREFLIGHT';
  const profile = expectedProfile({
    env: {
      HOME: '/srv/orchestra',
      TMPDIR: '/srv/orchestra/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      SECRET: secret,
    },
  });
  profile.allowlistedEnvironmentFingerprint = digest(
    buildCodexAppServerEnv(profile.codexHome, profile.env),
  );
  const results = staticResults(profile);
  results['model/list'].data[0].description = secret;
  const client = new FakeClient(results);
  const clientOptions = [];

  const result = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(client, clientOptions),
  });

  assert.equal(client.started, 1);
  assert.equal(client.closed, 1);
  assert.deepEqual(
    client.calls.map(({ method }) => method),
    [
      'config/read',
      'configRequirements/read',
      'permissionProfile/list',
      'account/read',
      'model/list',
    ],
  );
  assert.deepEqual(client.calls.map(({ params }) => params), [
    { cwd: profile.cwd, includeLayers: true },
    undefined,
    { cwd: profile.cwd },
    { refreshToken: false },
    { includeHidden: false, limit: 100 },
  ]);
  assert.equal(clientOptions.length, 1);
  assert.deepEqual(
    {
      binary: clientOptions[0].binary,
      cwd: clientOptions[0].cwd,
      codexHome: clientOptions[0].codexHome,
      env: clientOptions[0].env,
      expectedConfigSha256: clientOptions[0].expectedConfigSha256,
    },
    {
      binary: profile.binary,
      cwd: profile.cwd,
      codexHome: profile.codexHome,
      env: buildCodexAppServerEnv(profile.codexHome, profile.env),
      expectedConfigSha256: profile.ownedConfigSha256,
    },
  );
  assert.equal(typeof clientOptions[0].onNotification, 'function');
  assert.equal(typeof clientOptions[0].onFault, 'function');

  assert.equal(result.runtime, 'codex');
  assert.equal(result.runtimeVersion, protocolSchema.cliVersion);
  assert.equal(
    result.schemaVersion,
    protocolSchema.generatedProtocolV2CanonicalSha256,
  );
  assert.match(result.spawnProfileId, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.auth, {
    authenticated: true,
    accountType: 'chatgpt',
    requiresOpenaiAuth: true,
  });
  assert.equal(result.selected.model, 'gpt-5.6-sol');
  assert.equal(result.selected.effort, 'xhigh');
  assert.deepEqual(result.efforts, ['medium', 'high', 'xhigh']);
  assert.deepEqual(result.models, [{
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    isDefault: true,
  }]);
  assert.equal(result.attestation.layerCount, 1);
  assert.equal(Object.hasOwn(result.attestation, 'target'), false);
  assert.equal(result.attestation.permissionProfile.allowed, true);
  assert.match(
    result.attestation.permissionProfile.idSha256,
    /^[a-f0-9]{64}$/,
  );
  assertDeepFrozen(result);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(secret));
  for (const raw of [
    profile.binary,
    profile.codexHome,
    profile.cwd,
    profile.permissionProfileId,
  ]) {
    assert.equal(serialized.includes(raw), false);
  }
  assert.equal(Object.hasOwn(result, 'config'), false);
  assert.equal(Object.hasOwn(result, 'account'), false);
  assert.equal(Object.hasOwn(result.attestation, 'layers'), false);

  const spawnProfile = createCodexSpawnProfile(profile, result);
  assert.deepEqual(Object.keys(spawnProfile), [
    'runtime',
    'spawnProfileId',
    'expectedStaticProfile',
    'modelCatalog',
  ]);
  assert.equal(spawnProfile.runtime, 'codex');
  assert.equal(spawnProfile.spawnProfileId, result.spawnProfileId);
  assert.equal(spawnProfile.modelCatalog, result.models);
  assertDeepFrozen(spawnProfile);
  assert.doesNotMatch(JSON.stringify(spawnProfile), new RegExp(secret));
});

test('model and effort selection do not change the static spawn fingerprint', async () => {
  const profiles = [
    expectedProfile(),
    expectedProfile({ model: 'gpt-5.6-terra', effort: 'high' }),
  ];
  const catalog = [
    model(),
    model({
      id: 'gpt-5.6-terra',
      model: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['medium', 'high'],
      isDefault: false,
    }),
  ];
  const receipts = [];
  for (const profile of profiles) {
    const results = staticResults(profile);
    results['model/list'] = { data: catalog, nextCursor: null };
    const result = await preflightCodexRuntime(profile, {
      clientFactory: () => new FakeClient(results),
    });
    receipts.push(createCodexSpawnProfile(profile, result));
  }

  assert.equal(receipts[0].spawnProfileId, receipts[1].spawnProfileId);
  assert.deepEqual(receipts[0].modelCatalog, receipts[1].modelCatalog);
});

test('preflight runs through the real U2 client without issuing a mutation', async (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(os.homedir(), '.orchestra-codex-preflight-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  const ownedConfig = 'model = "gpt-5.6-sol"\n';
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    ownedConfig,
    { mode: 0o600 },
  );
  chmodSync(path.join(codexHome, 'config.toml'), 0o600);

  const fixture = path.resolve(
    __dirname,
    'fixtures/fake-codex-app-server.mjs',
  );
  const binary = path.join(root, 'fake-codex-app-server.mjs');
  writeFileSync(
    binary,
    readFileSync(fixture, 'utf8')
      .replace(/^#!.*\n/, `#!${process.execPath}\n`),
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);

  const rawConfig = {
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
        network: { enabled: false },
        filesystem: { '.': 'write' },
      },
    },
    mcp_servers: {},
    plugins: {},
    model_providers: {},
  };
  const rawLayerConfig = { default_permissions: 'polygram-session' };
  const rawOrigins = { default_permissions: 'user' };
  const rawRequirements = {
    allowed_permission_profiles: ['polygram-session'],
    default_permissions: 'polygram-session',
  };
  const scenario = {
    methods: {
        'config/read': {
          result: {
            config: rawConfig,
            layers: [{
              name: { type: 'user' },
              version: '1',
              config: rawLayerConfig,
            }],
            origins: rawOrigins,
          },
        },
        'configRequirements/read': {
          result: { requirements: rawRequirements },
        },
        'permissionProfile/list': {
          result: {
            data: [{
              id: 'polygram-session',
              allowed: true,
              description: 'Owned profile',
            }],
            nextCursor: null,
          },
        },
        'model/list': {
          result: {
            data: [{
              id: 'gpt-5.6-sol',
              model: 'gpt-5.6-sol',
              description: 'Fast coding model',
              displayName: 'GPT-5.6 Sol',
              defaultReasoningEffort: 'high',
              supportedReasoningEfforts: [{
                reasoningEffort: 'high',
                description: 'High',
              }, {
                reasoningEffort: 'xhigh',
                description: 'Extra high',
              }],
              hidden: false,
              isDefault: true,
            }],
            nextCursor: null,
          },
        },
      },
  };
  writeFileSync(
    path.join(cwd, '.fake-codex-app-server.json'),
    `${JSON.stringify(scenario)}\n`,
  );

  const env = {
    HOME: root,
    TMPDIR: root,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
  };
  const profile = expectedProfile({
    binary,
    codexHome,
    cwd,
    env,
    allowlistedEnvironmentFingerprint: digest(
      buildCodexAppServerEnv(codexHome, env),
    ),
    ownedConfigSha256: digest(ownedConfig),
    expectedConfigSha256: digest(rawConfig),
    expectedConfig: {
      sha256: digest(rawConfig),
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
        filesystemSha256: digest({ '.': 'write' }),
        filesystem: [{
          rootSha256: digest('.'),
          access: 'write',
        }],
      }],
      mcpServers: { count: 0, keySha256: [] },
      plugins: { count: 0, keySha256: [] },
      modelProviders: { count: 0, keySha256: [] },
    },
    expectedLayers: [{
      type: 'user',
      version: '1',
      disabled: false,
      configSha256: digest(rawLayerConfig),
    }],
    expectedOriginsSha256: digest(rawOrigins),
    expectedRequirements: {
      sha256: digest(rawRequirements),
      keys: ['allowed_permission_profiles', 'default_permissions'],
    },
    expectedPermissionProfiles: [{
      id: 'polygram-session',
      allowed: true,
      descriptionSha256: digest('Owned profile'),
    }],
  });
  const realClientFactory = (options) => {
    const client = new CodexAppServerClient({
      ...options,
      requestTimeoutMs: 1_000,
      closeGraceMs: 100,
      closeKillMs: 200,
      attestBinaryFn: async (target, targetReceipt) => ({
        path: target,
        target: targetReceipt.target,
        sha256: targetReceipt.binarySha256,
        version: targetReceipt.cliVersion,
      }),
      attestCodexHomeFn: (home, hash) => (
        attestPinnedCodexHome(home, hash, { temporaryRoots: [] })
      ),
    });
    return client;
  };
  const result = await preflightCodexRuntime(profile, {
    clientFactory: realClientFactory,
  });

  assert.equal(result.selected.model, 'gpt-5.6-sol');
  const requests = readFileSync(
    path.join(cwd, 'fake-codex-requests.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    requests
      .filter((message) => Object.hasOwn(message, 'id'))
      .map(({ method }) => method),
    [
      'initialize',
      'config/read',
      'configRequirements/read',
      'permissionProfile/list',
      'account/read',
      'model/list',
    ],
  );
  assert.equal(
    requests.some(({ method }) => (
      method.startsWith('thread/') || method.startsWith('turn/')
    )),
    false,
  );

  scenario.methods['model/list'].lateMessages = [{
    method: 'unexpected/preflight-event',
    params: {},
  }];
  scenario.methods['model/list'].lateDelayMs = 0;
  writeFileSync(
    path.join(cwd, '.fake-codex-app-server.json'),
    `${JSON.stringify(scenario)}\n`,
  );
  await assert.rejects(
    preflightCodexRuntime(profile, {
      clientFactory: realClientFactory,
    }),
    { code: 'CODEX_PREFLIGHT_CLIENT_FAULT' },
  );
});

test('static mismatch stops before account/model and always closes', async () => {
  const profile = expectedProfile();
  const results = staticResults(profile);
  results['config/read'] = {
    ...results['config/read'],
    originsSha256: digest('drifted origins'),
  };
  const client = new FakeClient(results);

  await assert.rejects(
    preflightCodexRuntime(profile, {
      clientFactory: makeFactory(client),
    }),
    { code: 'CODEX_STATIC_PROFILE_MISMATCH' },
  );

  assert.deepEqual(
    client.calls.map(({ method }) => method),
    ['config/read', 'configRequirements/read', 'permissionProfile/list'],
  );
  assert.equal(client.closed, 1);
});

test('expected policy pins OpenAI, user review, and one effective config digest', async () => {
  const cases = [{
    expectedConfig: {
      ...projectedConfig(),
      approvalsReviewer: 'auto_review',
    },
  }, {
    expectedConfig: {
      ...projectedConfig(),
      modelProvider: 'other-provider',
    },
  }, {
    expectedConfig: {
      ...projectedConfig(),
      modelProviders: {
        count: 1,
        keySha256: [digest('openai')],
      },
    },
  }, {
    expectedConfig: {
      ...projectedConfig(),
      modelProviders: {
        count: 0,
        keySha256: [digest('openai')],
      },
    },
  }, {
    expectedConfig: {
      ...projectedConfig(),
      mcpServers: { count: 0, keySha256: [digest('hidden-server')] },
    },
  }, {
    expectedConfigSha256: digest('divergent effective config'),
  }];

  for (const override of cases) {
    const profile = expectedProfile(override);
    let factoryCalls = 0;
    await assert.rejects(
      preflightCodexRuntime(profile, {
        clientFactory: () => {
          factoryCalls += 1;
          return new FakeClient(staticResults(profile));
        },
      }),
      { code: 'CODEX_STATIC_PROFILE_MISMATCH' },
    );
    assert.equal(factoryCalls, 0);
  }
});

test('ChatGPT account is authenticated even when requiresOpenaiAuth is true', async () => {
  const profile = expectedProfile();
  const client = new FakeClient(staticResults(profile));

  const result = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(client),
  });

  assert.equal(result.auth.authenticated, true);
  assert.equal(result.auth.requiresOpenaiAuth, true);
  assert.equal(client.closed, 1);
});

test('missing or non-ChatGPT account fails before model discovery', async () => {
  for (const account of [
    { account: null, requiresOpenaiAuth: true },
    { account: { type: 'apiKey' }, requiresOpenaiAuth: false },
  ]) {
    const profile = expectedProfile();
    const results = staticResults(profile);
    results['account/read'] = account;
    const client = new FakeClient(results);

    await assert.rejects(
      preflightCodexRuntime(profile, {
        clientFactory: makeFactory(client),
      }),
      { code: 'CODEX_AUTH_UNAVAILABLE' },
    );

    assert.equal(
      client.calls.some(({ method }) => method === 'model/list'),
      false,
    );
    assert.equal(client.closed, 1);
  }
});

test('model and effort are exact and validated from the complete catalog', async () => {
  const profile = expectedProfile();
  const results = staticResults(profile);
  results['model/list'] = ({ cursor }) => (
    cursor === undefined
      ? {
          data: [model({
            id: 'gpt-5.5',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
          })],
          nextCursor: 'model-page-2',
        }
      : {
          data: [model()],
          nextCursor: null,
        }
  );
  const client = new FakeClient(results);

  const result = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(client),
  });

  assert.deepEqual(
    client.calls.filter(({ method }) => method === 'model/list'),
    [{
      method: 'model/list',
      params: { includeHidden: false, limit: 100 },
    }, {
      method: 'model/list',
      params: {
        includeHidden: false,
        limit: 100,
        cursor: 'model-page-2',
      },
    }],
  );
  assert.equal(result.models.length, 2);
  assert.equal(result.selected.model, profile.model);
  assert.equal(client.closed, 1);
});

test('unavailable exact model and effort fail closed after bounded catalog discovery', async () => {
  const cases = [{
    override: { model: 'gpt-5.6-so' },
    code: 'CODEX_MODEL_UNAVAILABLE',
  }, {
    override: { effort: 'ultra' },
    code: 'CODEX_EFFORT_UNAVAILABLE',
  }];

  for (const { override, code } of cases) {
    const profile = expectedProfile(override);
    const client = new FakeClient(staticResults(profile));
    await assert.rejects(
      preflightCodexRuntime(profile, {
        clientFactory: makeFactory(client),
      }),
      { code },
    );
    assert.equal(client.closed, 1);
  }
});

test('permission profile pagination is bounded, complete, and exact', async () => {
  const profile = expectedProfile({
    expectedPermissionProfiles: [{
      id: 'read-only',
      allowed: true,
      descriptionSha256: null,
    }, {
      id: 'polygram-session',
      allowed: true,
      descriptionSha256: digest('profile-description'),
    }],
  });
  const results = staticResults(profile);
  results['permissionProfile/list'] = ({ cursor }) => (
    cursor === undefined
      ? {
          data: [profile.expectedPermissionProfiles[0]],
          nextCursor: 'profile-page-2',
        }
      : {
          data: [profile.expectedPermissionProfiles[1]],
          nextCursor: null,
        }
  );
  const client = new FakeClient(results);

  const result = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(client),
  });

  assert.deepEqual(
    client.calls.filter(({ method }) => method === 'permissionProfile/list'),
    [{
      method: 'permissionProfile/list',
      params: { cwd: profile.cwd },
    }, {
      method: 'permissionProfile/list',
      params: { cwd: profile.cwd, cursor: 'profile-page-2' },
    }],
  );
  assert.equal(result.attestation.permissionProfileCatalog.count, 2);
  assert.equal(client.closed, 1);
});

test('cursor loops, excess pages, duplicate profiles, and duplicate models fail closed', async () => {
  const cases = [{
    name: 'cursor loop',
    method: 'permissionProfile/list',
    response: () => ({ data: [], nextCursor: 'same' }),
    code: 'CODEX_PREFLIGHT_PAGINATION',
  }, {
    name: 'excess pages',
    method: 'model/list',
    response: (_params, calls) => ({
      data: [],
      nextCursor: `cursor-${
        calls.filter(({ method }) => method === 'model/list').length
      }`,
    }),
    code: 'CODEX_PREFLIGHT_PAGINATION',
  }, {
    name: 'duplicate profiles',
    method: 'permissionProfile/list',
    response: ({ cursor }) => cursor === undefined
      ? {
          data: [expectedProfile().expectedPermissionProfiles[0]],
          nextCursor: 'next',
        }
      : {
          data: [expectedProfile().expectedPermissionProfiles[0]],
          nextCursor: null,
        },
    code: 'CODEX_PREFLIGHT_DUPLICATE',
  }, {
    name: 'duplicate models',
    method: 'model/list',
    response: ({ cursor }) => cursor === undefined
      ? { data: [model()], nextCursor: 'next' }
      : {
          data: [model({ id: 'alias', displayName: 'Alias' })],
          nextCursor: null,
        },
    code: 'CODEX_PREFLIGHT_DUPLICATE',
  }];

  for (const entry of cases) {
    await test(entry.name, async () => {
      const profile = expectedProfile();
      const results = staticResults(profile);
      results[entry.method] = entry.response;
      const client = new FakeClient(results);

      await assert.rejects(
        preflightCodexRuntime(profile, {
          clientFactory: makeFactory(client),
        }),
        { code: entry.code },
      );
      assert.equal(client.closed, 1);
      assert.equal(
        client.calls.some(({ method }) => (
          method.startsWith('thread/') || method.startsWith('turn/')
        )),
        false,
      );
    });
  }
});

test('every start/request failure closes and no mutation RPC is ever issued', async () => {
  const methods = [
    'start',
    'config/read',
    'configRequirements/read',
    'permissionProfile/list',
    'account/read',
    'model/list',
  ];
  for (const method of methods) {
    const profile = expectedProfile();
    const client = new FakeClient(staticResults(profile), {
      failures: { [method]: new Error(`failed ${method}`) },
    });

    await assert.rejects(
      preflightCodexRuntime(profile, {
        clientFactory: makeFactory(client),
      }),
    );
    assert.equal(client.closed, 1, `${method} failure closed`);
    assert.equal(
      client.calls.some(({ method: called }) => (
        called.startsWith('thread/') || called.startsWith('turn/')
      )),
      false,
    );
  }
});

test('cleanup failure is surfaced separately from an earlier preflight failure', async () => {
  const profile = expectedProfile();
  const primary = Object.assign(new Error('primary'), {
    code: 'CODEX_TEST_PRIMARY',
  });
  const cleanup = Object.assign(new Error('cleanup'), {
    code: 'CODEX_TEST_CLEANUP',
  });
  const client = new FakeClient(staticResults(profile), {
    failures: { 'config/read': primary },
    closeError: cleanup,
  });

  const error = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(client),
  }).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'CODEX_PREFLIGHT_CLOSE_FAILED');
  assert.equal(error.preflightErrorCode, primary.code);
  assert.equal(error.cleanupErrorCode, cleanup.code);
  assert.equal(error.cause, cleanup);
  assert.equal(client.closed, 1);
});

test('late terminal client fault prevents a successful preflight result', async () => {
  const profile = expectedProfile();
  const faultOutcome = Object.freeze({
    kind: 'codex-app-server-fault',
    boundary: 'post-spawn',
    containment: 'unverified',
    cleanup: 'completed',
    errorCode: 'CODEX_PROTOCOL_ERROR',
    cleanupErrorCode: null,
    mutationOutcomeUnknown: false,
  });
  const client = new FakeClient(staticResults(profile), { faultOutcome });

  const error = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(client),
  }).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'CODEX_PREFLIGHT_CLIENT_FAULT');
  assert.equal(error.clientFaultErrorCode, 'CODEX_PROTOCOL_ERROR');
  assert.equal(error.clientFaultBoundary, 'post-spawn');
  assert.equal(error.clientFaultContainment, 'unverified');
  assert.equal(client.closed, 1);
  assert.equal(client.faultWaits, 1);
});

test('primary preflight failure remains primary when fault handoff also settles', async () => {
  const profile = expectedProfile();
  const primary = Object.assign(new Error('primary'), {
    code: 'CODEX_TEST_PRIMARY',
  });
  const client = new FakeClient(staticResults(profile), {
    failures: { 'config/read': primary },
    faultOutcome: Object.freeze({
      kind: 'codex-app-server-fault',
      boundary: 'post-spawn',
      containment: 'unverified',
      cleanup: 'completed',
      errorCode: 'CODEX_PROTOCOL_ERROR',
      cleanupErrorCode: null,
      mutationOutcomeUnknown: false,
    }),
  });

  const error = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(client),
  }).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error, primary);
  assert.equal(error.preflightClientFaultCode, 'CODEX_PROTOCOL_ERROR');
  assert.equal(client.closed, 1);
  assert.equal(client.faultWaits, 1);
});

test('invalid expected profile and environment drift fail before client creation', async () => {
  const currentTarget = resolveCodexTargetPin();
  const oppositeTarget = currentTarget.target === 'aarch64-apple-darwin'
    ? resolveCodexTargetPin('linux', 'x64')
    : resolveCodexTargetPin('darwin', 'arm64');
  const cases = [
    expectedProfile({ runtime: 'sdk' }),
    expectedProfile(oppositeTarget),
    expectedProfile({ binarySha256: digest('wrong binary') }),
    expectedProfile({ permissionProfileId: '' }),
    expectedProfile({ effort: null }),
    expectedProfile({
      allowlistedEnvironmentFingerprint: digest('wrong environment'),
    }),
  ];

  for (const profile of cases) {
    let factoryCalls = 0;
    await assert.rejects(
      preflightCodexRuntime(profile, {
        clientFactory: () => {
          factoryCalls += 1;
          return new FakeClient(staticResults(profile));
        },
      }),
    );
    assert.equal(factoryCalls, 0);
  }
});

test('spawn profile receipt rejects incomplete, extra, or forged preflight data', async () => {
  const profile = expectedProfile();
  const result = await preflightCodexRuntime(profile, {
    clientFactory: makeFactory(new FakeClient(staticResults(profile))),
  });

  assert.throws(
    () => createCodexSpawnProfile({
      ...profile,
      sessionLauncher: '/attacker/launcher',
    }, result),
    /unexpected static profile field/,
  );
  const incomplete = { ...profile };
  delete incomplete.ownedConfigSha256;
  assert.throws(
    () => createCodexSpawnProfile(incomplete, result),
    /missing static profile field/,
  );
  assert.throws(
    () => createCodexSpawnProfile(profile, Object.freeze({
      ...result,
      spawnProfileId: digest('forged preflight identity'),
    })),
    { code: 'CODEX_PREFLIGHT_RECEIPT_INVALID' },
  );
  assert.throws(
    () => createCodexSpawnProfile(profile, Object.freeze({
      ...result,
      unexpected: true,
    })),
    /unexpected preflight result field/,
  );
  assert.throws(
    () => createCodexSpawnProfile(profile, deepFrozenClone(result)),
    { code: 'CODEX_PREFLIGHT_RECEIPT_INVALID' },
  );
});
