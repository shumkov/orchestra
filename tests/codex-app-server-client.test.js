'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const {
  CodexAppServerClient,
  attestPinnedCodexBinary,
  attestPinnedCodexHome,
  attestPinnedSessionLauncher,
  characterizePinnedSessionLauncher,
  protocolSchema,
  resolveCodexTargetPin,
} = require('../lib/codex/app-server-client');

const FIXTURE = path.resolve(__dirname, 'fixtures/fake-codex-app-server.mjs');
const SUPERVISOR = path.resolve(
  __dirname,
  '../lib/codex/app-server-supervisor.mjs',
);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const REQUEST_LOG = 'fake-codex-requests.jsonl';
const SPAWN_LOG = 'fake-codex-spawn.json';

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(check, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

async function rejectedWithCode(promise, expectedCode) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, `expected ${expectedCode} rejection`);
  assert.equal(error.code, expectedCode);
  return error;
}

async function rejectedWithinWithCode(
  promise,
  expectedCode,
  deadlineMs = 300,
) {
  let timer;
  const outcome = await Promise.race([
    promise.then(
      () => ({ settled: true, error: null }),
      (error) => ({ settled: true, error }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), deadlineMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  assert.equal(outcome.settled, true, `expected rejection within ${deadlineMs}ms`);
  assert.ok(outcome.error, `expected ${expectedCode} rejection`);
  assert.equal(outcome.error.code, expectedCode);
  return outcome.error;
}

function createHarness(t, scenario = {}) {
  const root = realpathSync(
    mkdtempSync(path.join(os.homedir(), '.orchestra-u2-client-')),
  );
  const cwd = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  const config = 'model = "gpt-5.6-sol"\n';
  const configPath = path.join(codexHome, 'config.toml');
  writeFileSync(configPath, config, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  const expectedConfigSha256 = createHash('sha256')
    .update(config)
    .digest('hex');
  writeFileSync(
    path.join(cwd, '.fake-codex-app-server.json'),
    `${JSON.stringify(scenario)
      .replaceAll('"__OWNED_CWD__"', JSON.stringify(cwd))}\n`,
  );

  const directBinary = path.join(cwd, 'fake-codex-direct.mjs');
  const fixtureSource = readFileSync(FIXTURE, 'utf8')
    .replace(/^#!.*\n/, `#!${process.execPath}\n`);
  writeFileSync(directBinary, fixtureSource, { mode: 0o700 });
  chmodSync(directBinary, 0o700);

  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    rmSync(root, { recursive: true, force: true });
  });

  function makeClient(overrides = {}) {
    const client = new CodexAppServerClient({
      binary: directBinary,
      cwd,
      codexHome,
      env: {
        HOME: '/controlled/home',
        PATH: '/must/not/pass',
        TMPDIR: cwd,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        ORCHESTRA_TEST_SECRET: 'MUST_NOT_CROSS',
      },
      requestTimeoutMs: 2_000,
      closeGraceMs: 100,
      closeKillMs: 200,
      expectedConfigSha256,
      onFault: async () => {},
      attestBinaryFn: async (binary, targetReceipt) => ({
        path: binary,
        target: targetReceipt.target,
        sha256: targetReceipt.binarySha256,
        version: targetReceipt.cliVersion,
      }),
      attestCodexHomeFn: (home, expectedHash) => (
        attestPinnedCodexHome(home, expectedHash, { temporaryRoots: [] })
      ),
      ...overrides,
    });
    clients.push(client);
    return client;
  }

  return {
    cwd,
    codexHome,
    configPath,
    authPath: path.join(codexHome, 'auth.json'),
    expectedConfigSha256,
    directBinary,
    requestLog: path.join(cwd, REQUEST_LOG),
    spawnLog: path.join(cwd, SPAWN_LOG),
    makeClient,
    requests: () => readJsonLines(path.join(cwd, REQUEST_LOG)),
  };
}

function mutationOptions(events = [], overrides = {}) {
  return {
    timeoutMs: 2_000,
    onWriteAttempted: async (checkpoint) => {
      events.push({ type: 'write-attempted', checkpoint });
    },
    onResponseObserved: async (checkpoint) => {
      events.push({ type: 'response-observed', checkpoint });
    },
    ...overrides,
  };
}

async function waitForInitializedLog(harness) {
  await waitFor(
    () => harness.requests().some(
      (message) => message.method === 'initialized',
    ),
    'initialized notification',
  );
}

function methodParams(method, cwd) {
  switch (method) {
    case 'config/read':
      return { cwd, includeLayers: true };
    case 'configRequirements/read':
      return undefined;
    case 'permissionProfile/list':
      return { cwd };
    case 'account/read':
      return { refreshToken: false };
    case 'model/list':
      return { includeHidden: false, limit: 100 };
    case 'thread/start':
      return { cwd, model: 'gpt-5.6-sol' };
    case 'thread/resume':
      return { threadId: 'thread-1' };
    case 'turn/start':
      return {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello' }],
      };
    case 'turn/steer':
      return {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'follow up' }],
      };
    case 'turn/interrupt':
      return { threadId: 'thread-1', turnId: 'turn-1' };
    case 'thread/backgroundTerminals/list':
    case 'thread/backgroundTerminals/clean':
      return { threadId: 'thread-1' };
    default:
      throw new Error(`missing test parameters for ${method}`);
  }
}

test('Codex target pins resolve lazily to immutable reviewed receipts', () => {
  const darwin = resolveCodexTargetPin('darwin', 'arm64');
  const linux = resolveCodexTargetPin('linux', 'x64');

  assert.deepEqual(darwin, {
    target: 'aarch64-apple-darwin',
    cliVersion: 'codex-cli 0.145.0',
    binarySha256:
      '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
  });
  assert.deepEqual(linux, {
    target: 'x86_64-unknown-linux-musl',
    cliVersion: 'codex-cli 0.145.0',
    binarySha256:
      'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
  });
  assert.equal(Object.isFrozen(darwin), true);
  assert.equal(Object.isFrozen(linux), true);
  assert.equal(resolveCodexTargetPin('darwin', 'arm64'), darwin);
  assert.equal(resolveCodexTargetPin('linux', 'x64'), linux);
  assert.deepEqual(protocolSchema.binarySha256ByTarget, {
    'aarch64-apple-darwin':
      '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
    'x86_64-unknown-linux-musl':
      'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
  });
  assert.equal(
    protocolSchema.binarySha256,
    protocolSchema.binarySha256ByTarget['aarch64-apple-darwin'],
  );

  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
    ['freebsd', 'x64'],
  ]) {
    assert.throws(
      () => resolveCodexTargetPin(platform, arch),
      { code: 'CODEX_UNSUPPORTED_PLATFORM' },
    );
  }
});

test('requiring Orchestra stays inert on an unsupported host until Codex is selected', () => {
  const entry = path.resolve(__dirname, '..');
  const child = spawnSync(process.execPath, ['-e', [
    "Object.defineProperty(process, 'platform', { value: 'freebsd' });",
    "Object.defineProperty(process, 'arch', { value: 'x64' });",
    `const pkg = require(${JSON.stringify(entry)});`,
    "if (typeof pkg.CodexProcess !== 'function') process.exit(2);",
    'const factory = pkg.createProcessFactory({',
    "config: { bot: { pm: 'sdk' } },",
    'spawnFn: () => ({ query: {}, inputController: {} }),',
    '});',
    "const claude = factory('claude-only', { runtime: 'claude', chatId: '1' });",
    "if (!(claude instanceof pkg.SdkProcess) || claude.backend !== 'sdk') process.exit(4);",
    'try { pkg.resolveCodexTargetPin(); process.exit(3); }',
    "catch (error) { if (error.code !== 'CODEX_UNSUPPORTED_PLATFORM') throw error; }",
  ].join('')], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(child.status, 0, child.stderr);
});

test('start is single-flight, spawns once, and initializes before readiness', async (t) => {
  const harness = createHarness(t, { initializeDelayMs: 50 });
  const spawnCalls = [];
  const client = harness.makeClient({
    spawnFn: (...args) => {
      spawnCalls.push(args);
      return spawn(...args);
    },
  });

  const starts = [client.start(), client.start(), client.start()];
  assert.equal(starts[0], starts[1]);
  assert.equal(starts[1], starts[2]);

  await waitFor(
    () => harness.requests().some((message) => message.method === 'initialize'),
    'initialize request',
  );
  await rejectedWithCode(
    client.request(
      'thread/start',
      methodParams('thread/start', harness.cwd),
      mutationOptions(),
    ),
    'CODEX_CLIENT_STATE',
  );
  assert.deepEqual(
    harness.requests().map((message) => message.method),
    ['initialize'],
  );

  const started = await Promise.all(starts);
  assert.equal(started[0], client);
  assert.equal(started[1], client);
  assert.equal(spawnCalls.length, 1);
  assert.doesNotThrow(() => client.assertHealthy());
  await waitFor(
    () => harness.requests().some((message) => message.method === 'initialized'),
    'initialized notification',
  );
  assert.deepEqual(
    harness.requests().map((message) => message.method),
    ['initialize', 'initialized'],
  );
  const initialize = harness.requests()[0];
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
  assert.equal(Object.hasOwn(initialize, 'jsonrpc'), false);
});

test('initialize accepts only the pinned generated response fields', async (t) => {
  const harness = createHarness(t, {
    methods: {
      initialize: {
        result: {
          codexHome: 'ignored-by-malformed-response',
          serverInfo: { name: 'invented', version: '0.145.0' },
        },
      },
    },
  });
  const client = harness.makeClient();

  await rejectedWithCode(client.start(), 'CODEX_PROTOCOL_ERROR');
  assert.throws(
    () => client.assertHealthy(),
    { code: 'CODEX_PROTOCOL_ERROR' },
  );
});

test('binary attestation completes before spawn is attempted', async (t) => {
  const harness = createHarness(t);
  let releaseAttestation;
  const attestationGate = new Promise((resolve) => {
    releaseAttestation = resolve;
  });
  let attestationEntered = false;
  const spawnCalls = [];
  const client = harness.makeClient({
    attestBinaryFn: async (binary, targetReceipt) => {
      attestationEntered = true;
      await attestationGate;
      return {
        path: binary,
        target: targetReceipt.target,
        sha256: targetReceipt.binarySha256,
        version: targetReceipt.cliVersion,
      };
    },
    spawnFn: (...args) => {
      spawnCalls.push(args);
      return spawn(...args);
    },
  });

  const starting = client.start();
  await waitFor(() => attestationEntered, 'binary attestation');
  assert.equal(spawnCalls.length, 0);
  releaseAttestation();
  await starting;
  assert.equal(spawnCalls.length, 1);
  if (process.platform === 'win32') {
    assert.equal(spawnCalls[0][0], harness.directBinary);
  } else {
    assert.equal(spawnCalls[0][0], process.execPath);
    assert.deepEqual(
      spawnCalls[0][1],
      [
        SUPERVISOR,
        '--group-term-grace-ms=100',
        harness.directBinary,
        'app-server',
        '--strict-config',
        '--stdio',
      ],
    );
  }
});

test('binary pin mismatch prevents spawn', async (t) => {
  const harness = createHarness(t);
  let spawnCalls = 0;
  const mismatch = new Error('test binary does not match the pin');
  mismatch.code = 'CODEX_BINARY_MISMATCH';
  const client = harness.makeClient({
    attestBinaryFn: async () => {
      throw mismatch;
    },
    spawnFn: (...args) => {
      spawnCalls += 1;
      return spawn(...args);
    },
  });

  await rejectedWithCode(client.start(), 'CODEX_BINARY_MISMATCH');
  assert.equal(spawnCalls, 0);
  assert.throws(
    () => client.assertHealthy(),
    { code: 'CODEX_BINARY_MISMATCH' },
  );
});

test('opposite-target binary attestation prevents spawn', async (t) => {
  const harness = createHarness(t);
  const targetReceipt = resolveCodexTargetPin();
  const oppositeTarget = targetReceipt.target === 'aarch64-apple-darwin'
    ? 'x86_64-unknown-linux-musl'
    : 'aarch64-apple-darwin';
  let spawnCalls = 0;
  const client = harness.makeClient({
    attestBinaryFn: async (binary) => ({
      path: binary,
      target: oppositeTarget,
      sha256: targetReceipt.binarySha256,
      version: targetReceipt.cliVersion,
    }),
    attestCodexHomeFn: async (codexHome, expectedConfigSha256) => ({
      path: codexHome,
      configSha256: expectedConfigSha256,
      configFingerprint: {},
      authFingerprint: null,
    }),
    spawnFn: (...args) => {
      spawnCalls += 1;
      return spawn(...args);
    },
  });

  await rejectedWithCode(client.start(), 'CODEX_BINARY_MISMATCH');
  assert.equal(spawnCalls, 0);
});

test('production attesters reject unsafe binary and credential metadata', async (t) => {
  await t.test('binary symlink', async (subtest) => {
    const harness = createHarness(subtest);
    const link = `${harness.directBinary}.link`;
    symlinkSync(harness.directBinary, link);
    await rejectedWithCode(
      attestPinnedCodexBinary(link),
      'CODEX_BINARY_MISMATCH',
    );
  });

  await t.test('binary hardlink', async (subtest) => {
    const harness = createHarness(subtest);
    linkSync(harness.directBinary, `${harness.directBinary}.hardlink`);
    await rejectedWithCode(
      attestPinnedCodexBinary(harness.directBinary),
      'CODEX_BINARY_MISMATCH',
    );
  });

  await t.test('binary group-writable mode', async (subtest) => {
    const harness = createHarness(subtest);
    chmodSync(harness.directBinary, 0o720);
    await rejectedWithCode(
      attestPinnedCodexBinary(harness.directBinary),
      'CODEX_BINARY_MISMATCH',
    );
  });

  for (const [name, mutate] of [
    ['config symlink', (harness) => {
      const replacement = `${harness.configPath}.replacement`;
      writeFileSync(replacement, 'model = "other"\n', { mode: 0o600 });
      chmodSync(replacement, 0o600);
      unlinkSync(harness.configPath);
      symlinkSync(replacement, harness.configPath);
    }],
    ['config hardlink', (harness) => {
      linkSync(harness.configPath, `${harness.configPath}.hardlink`);
    }],
    ['config group-readable mode', (harness) => {
      chmodSync(harness.configPath, 0o640);
    }],
  ]) {
    await t.test(name, async (subtest) => {
      const harness = createHarness(subtest);
      mutate(harness);
      await rejectedWithCode(
        attestPinnedCodexHome(
          harness.codexHome,
          harness.expectedConfigSha256,
          { temporaryRoots: [] },
        ),
        'CODEX_CONFIG_MISMATCH',
      );
    });
  }
});

test('constructor rejects noncanonical, nested, or non-0700 credential homes', (t) => {
  const harness = createHarness(t);
  const root = path.dirname(harness.cwd);
  const options = (codexHome) => ({
    binary: harness.directBinary,
    cwd: harness.cwd,
    codexHome,
    expectedConfigSha256: harness.expectedConfigSha256,
    onFault: async () => {},
  });

  const linkedHome = path.join(root, 'codex-home-link');
  symlinkSync(harness.codexHome, linkedHome);
  assert.throws(
    () => new CodexAppServerClient(options(linkedHome)),
    /canonical path/,
  );

  const nestedHome = path.join(harness.cwd, 'nested-home');
  mkdirSync(nestedHome, { mode: 0o700 });
  assert.throws(
    () => new CodexAppServerClient(options(nestedHome)),
    /separate owned 0700 directory/,
  );

  chmodSync(harness.codexHome, 0o755);
  assert.throws(
    () => new CodexAppServerClient(options(harness.codexHome)),
    /separate owned 0700 directory/,
  );
  chmodSync(harness.codexHome, 0o700);
});

test('close during binary attestation prevents a late spawn', async (t) => {
  const harness = createHarness(t);
  let releaseAttestation;
  let attestationEntered = false;
  const gate = new Promise((resolve) => {
    releaseAttestation = resolve;
  });
  let spawnCalls = 0;
  const client = harness.makeClient({
    attestBinaryFn: async (binary, targetReceipt) => {
      attestationEntered = true;
      await gate;
      return {
        path: binary,
        target: targetReceipt.target,
        sha256: targetReceipt.binarySha256,
        version: targetReceipt.cliVersion,
      };
    },
    spawnFn: (...args) => {
      spawnCalls += 1;
      return spawn(...args);
    },
  });

  const start = client.start();
  await waitFor(() => attestationEntered, 'binary attestation');
  await client.close();
  releaseAttestation();

  await rejectedWithCode(start, 'CODEX_CLIENT_CLOSED');
  assert.equal(spawnCalls, 0);
});

test('credential metadata cannot change between pre-spawn and post-spawn attestation', async (t) => {
  for (const [name, beforeSpawn, duringSpawn] of [
    [
      'auth.json cannot appear during spawn',
      () => {},
      (harness) => {
        writeFileSync(harness.authPath, '{"token":"new"}\n', { mode: 0o600 });
        chmodSync(harness.authPath, 0o600);
      },
    ],
    [
      'auth.json cannot be replaced during spawn',
      (harness) => {
        writeFileSync(harness.authPath, '{"token":"old"}\n', { mode: 0o600 });
        chmodSync(harness.authPath, 0o600);
      },
      (harness) => {
        writeFileSync(
          harness.authPath,
          '{"token":"replacement-longer"}\n',
          { mode: 0o600 },
        );
        chmodSync(harness.authPath, 0o600);
      },
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const harness = createHarness(subtest);
      beforeSpawn(harness);
      const client = harness.makeClient({
        spawnFn: (...args) => {
          duringSpawn(harness);
          return spawn(...args);
        },
      });

      await rejectedWithCode(client.start(), 'CODEX_CONFIG_MISMATCH');
      const outcome = await client.waitForFault();
      assert.equal(outcome.boundary, 'post-spawn');
      assert.equal(outcome.containment, 'unverified');
    });
  }
});

test('owned supervisor preserves exact app-server argv, cwd, and filtered environment', async (t) => {
  const direct = createHarness(t);
  const directCalls = [];
  const directClient = direct.makeClient({
    spawnFn: (...args) => {
      directCalls.push(args);
      return spawn(...args);
    },
  });
  await directClient.start();

  assert.equal(directCalls.length, 1);
  const call = directCalls[0];
  assert.equal(call[0], process.execPath);
  assert.deepEqual(call[1], [
    SUPERVISOR,
    '--group-term-grace-ms=100',
    direct.directBinary,
    'app-server',
    '--strict-config',
    '--stdio',
  ]);
  assert.equal(call[2].cwd, direct.cwd);
  assert.deepEqual(call[2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(call[2].env, {
    HOME: '/controlled/home',
    PATH: '/usr/bin:/bin',
    TMPDIR: direct.cwd,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    CODEX_HOME: direct.codexHome,
  });

  const observed = JSON.parse(readFileSync(direct.spawnLog, 'utf8'));
  assert.deepEqual(
    observed.argv,
    ['app-server', '--strict-config', '--stdio'],
  );
  assert.equal(observed.cwd, realpathSync(direct.cwd));
  assert.equal(observed.env.CODEX_HOME, direct.codexHome);
  assert.equal(observed.forbiddenEnvPresent, false);
});

test('owned supervisor launches Codex through the separately attested session launcher', async (t) => {
  const harness = createHarness(t);
  const calls = [];
  const launcherSha256 = 'a'.repeat(64);
  const client = harness.makeClient({
    sessionLauncher: '/usr/bin/env',
    expectedSessionLauncherSha256: launcherSha256,
    attestSessionLauncherFn: async (launcher, expectedSha256) => ({
      path: launcher,
      sha256: expectedSha256,
    }),
    spawnFn: (...args) => {
      calls.push(args);
      return spawn(...args);
    },
  });

  await client.start();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [
    SUPERVISOR,
    '--group-term-grace-ms=100',
    '--session-launcher=/usr/bin/env',
    harness.directBinary,
    'app-server',
    '--strict-config',
    '--stdio',
  ]);
  const observed = JSON.parse(readFileSync(harness.spawnLog, 'utf8'));
  assert.deepEqual(
    observed.argv,
    ['app-server', '--strict-config', '--stdio'],
  );
});

test('production session-launcher characterization is strict and hash-bound', async (t) => {
  const launcher = realpathSync('/usr/bin/env');
  const characterized = await characterizePinnedSessionLauncher(launcher);
  assert.equal(characterized.path, launcher);
  assert.match(characterized.sha256, /^[a-f0-9]{64}$/);
  assert.ok(characterized.fingerprint);
  assert.deepEqual(
    await attestPinnedSessionLauncher(launcher, characterized.sha256),
    characterized,
  );
  await assert.rejects(
    attestPinnedSessionLauncher(launcher, '0'.repeat(64)),
    (error) => error.code === 'CODEX_SESSION_LAUNCHER_MISMATCH',
  );
  await assert.rejects(
    characterizePinnedSessionLauncher('/definitely/missing/session-launcher'),
    (error) => error.code === 'CODEX_SESSION_LAUNCHER_MISMATCH',
  );

  const harness = createHarness(t);
  const linked = path.join(harness.cwd, 'linked-launcher');
  symlinkSync(launcher, linked);
  await assert.rejects(
    characterizePinnedSessionLauncher(linked),
    (error) => error.code === 'CODEX_SESSION_LAUNCHER_MISMATCH',
  );
  await assert.rejects(
    characterizePinnedSessionLauncher(harness.directBinary),
    (error) => error.code === 'CODEX_SESSION_LAUNCHER_MISMATCH',
  );
});

test('session-launcher replacement during spawn fails before initialization', async (t) => {
  const harness = createHarness(t);
  const launcher = harness.directBinary;
  const stat = lstatSync(launcher, { bigint: true });
  const fingerprint = {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    nlink: Number(stat.nlink),
  };
  const launcherSha256 = 'a'.repeat(64);
  const client = harness.makeClient({
    sessionLauncher: launcher,
    expectedSessionLauncherSha256: launcherSha256,
    attestSessionLauncherFn: async () => ({
      path: launcher,
      sha256: launcherSha256,
      fingerprint,
    }),
    spawnFn: (...args) => {
      chmodSync(launcher, 0o711);
      return spawn(...args);
    },
  });

  await assert.rejects(
    client.start(),
    (error) => error.code === 'CODEX_SESSION_LAUNCHER_MISMATCH',
  );
});

test('the pinned positive request allowlist accepts only required U2 methods', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  const expectedMethods = Object.entries(protocolSchema.clientRequests)
    .filter(([, spec]) => !spec.internal)
    .map(([method]) => method);

  for (const method of expectedMethods) {
    const events = [];
    const spec = protocolSchema.clientRequests[method];
    const result = await client.request(
      method,
      methodParams(method, harness.cwd),
      spec.stateChanging ? mutationOptions(events) : { timeoutMs: 500 },
    );
    assert.ok(result && typeof result === 'object', `${method} returned`);
    if (method === 'thread/resume') {
      assert.equal(result.thread.ephemeral, false);
    }
    assert.deepEqual(
      events.map((event) => event.type),
      spec.stateChanging
        ? ['write-attempted', 'response-observed']
        : [],
      `${method} checkpoint ownership`,
    );
  }

  assert.deepEqual(
    harness.requests()
      .filter((message) => Object.hasOwn(message, 'id'))
      .map((message) => message.method),
    ['initialize', ...expectedMethods],
  );
  assert.deepEqual(
    expectedMethods.filter(
      (method) => protocolSchema.clientRequests[method].experimental,
    ).sort(),
    [
      'thread/backgroundTerminals/clean',
      'thread/backgroundTerminals/list',
    ],
  );
});

test('command/exec, terminal terminate, host APIs, and unknown methods write zero bytes', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  await waitForInitializedLog(harness);
  const before = harness.requests().length;
  const methods = [
    'command/exec',
    'thread/settings/update',
    'thread/backgroundTerminals/terminate',
    'filesystem/read',
    'config/write',
    'plugin/install',
    'mcpServer/reload',
    'unknown/method',
  ];

  for (const method of methods) {
    const hookEvents = [];
    await rejectedWithCode(
      client.request(
        method,
        { command: 'MUST_NOT_CROSS', cwd: harness.cwd },
        mutationOptions(hookEvents),
      ),
      'CODEX_RPC_REJECTED',
    );
    assert.deepEqual(hookEvents, [], `${method} did not run hooks`);
  }
  assert.equal(harness.requests().length, before);
  assert.doesNotThrow(() => client.assertHealthy());
});

test('sandbox, profile, and config overrides are rejected before hooks or bytes', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  await waitForInitializedLog(harness);
  const before = harness.requests().length;
  const fields = [
    'cwd',
    'approvalPolicy',
    'approvalsReviewer',
    'sandbox_mode',
    'sandbox_workspace_write',
    'sandbox',
    'sandboxPolicy',
    'permissions',
    'permissionProfile',
    'personality',
    'serviceTier',
    'config',
    'unknownSetting',
  ];

  for (const field of fields) {
    const hookEvents = [];
    await rejectedWithCode(
      client.request('turn/start', {
        ...methodParams('turn/start', harness.cwd),
        [field]: { secret: 'MUST_NOT_CROSS' },
      }, mutationOptions(hookEvents)),
      'CODEX_RPC_REJECTED',
    );
    assert.deepEqual(hookEvents, [], `${field} did not run hooks`);
  }
  assert.equal(harness.requests().length, before);
});

test('mutation waits for acknowledged write and response checkpoints in order', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  await waitForInitializedLog(harness);
  const before = harness.requests().length;
  let releaseWrite;
  let releaseResponse;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
  const events = [];
  let settled = false;

  const request = client.request(
    'turn/start',
    methodParams('turn/start', harness.cwd),
    mutationOptions(events, {
      onWriteAttempted: async (checkpoint) => {
        events.push({ type: 'write-entered', checkpoint });
        await writeGate;
        events.push({ type: 'write-committed', checkpoint });
      },
      onResponseObserved: async (checkpoint) => {
        events.push({ type: 'response-entered', checkpoint });
        await responseGate;
        events.push({ type: 'response-committed', checkpoint });
      },
    }),
  );
  request.then(() => { settled = true; }, () => { settled = true; });

  await waitFor(
    () => events.some((event) => event.type === 'write-entered'),
    'write checkpoint entry',
  );
  assert.equal(harness.requests().length, before);
  releaseWrite();
  await waitFor(
    () => events.some((event) => event.type === 'response-entered'),
    'response checkpoint entry',
  );
  assert.equal(harness.requests().length, before + 1);
  assert.equal(settled, false);
  releaseResponse();
  await request;
  assert.equal(settled, true);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'write-entered',
      'write-committed',
      'response-entered',
      'response-committed',
    ],
  );
});

test('durable write commitment can never be downgraded to not-sent', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  await waitForInitializedLog(harness);
  let releaseWrite;
  let markEntered;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });

  const request = client.request(
    'turn/start',
    methodParams('turn/start', harness.cwd),
    mutationOptions([], {
      onWriteAttempted: async (checkpoint) => {
        markEntered();
        await writeGate;
        checkpoint.markWriteCommitted();
        throw new Error('caller cancellation raced durable intent');
      },
    }),
  );
  await entered;
  releaseWrite();

  await rejectedWithCode(request, 'CODEX_RPC_OUTCOME_UNKNOWN');
  await client.waitForFault();
});

test('every mutation is definitely not sent when its write checkpoint rejects', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  await waitForInitializedLog(harness);
  const before = harness.requests().length;
  let responseCalls = 0;
  const mutationMethods = Object.entries(protocolSchema.clientRequests)
    .filter(([, spec]) => spec.stateChanging)
    .map(([method]) => method);

  for (const method of mutationMethods) {
    const error = await rejectedWithCode(
      client.request(
        method,
        methodParams(method, harness.cwd),
        mutationOptions([], {
          onWriteAttempted: async () => {
            throw new Error('checkpoint unavailable');
          },
          onResponseObserved: async () => {
            responseCalls += 1;
          },
        }),
      ),
      'CODEX_RPC_NOT_SENT',
    );
    assert.match(error.message, /was not sent/, method);
  }
  assert.equal(responseCalls, 0);
  assert.equal(harness.requests().length, before);
  assert.doesNotThrow(() => client.assertHealthy());
});

test('transport loss after every mutation write is outcome-unknown and sticky', async (t) => {
  const mutationMethods = Object.entries(protocolSchema.clientRequests)
    .filter(([, spec]) => spec.stateChanging)
    .map(([method]) => method);

  for (const method of mutationMethods) {
    await t.test(method, async (subtest) => {
      const harness = createHarness(subtest, {
        methods: {
          [method]: { closeAfterRead: true },
        },
      });
      const client = harness.makeClient();
      await client.start();
      const events = [];

      const error = await rejectedWithCode(
        client.request(
          method,
          methodParams(method, harness.cwd),
          mutationOptions(events),
        ),
        'CODEX_RPC_OUTCOME_UNKNOWN',
      );
      assert.match(error.message, /outcome is unknown/);
      assert.deepEqual(
        events.map((event) => event.type),
        ['write-attempted'],
      );
      assert.throws(
        () => client.assertHealthy(),
        { code: 'CODEX_RPC_OUTCOME_UNKNOWN' },
      );
      await rejectedWithCode(
        client.request('account/read', { refreshToken: false }),
        'CODEX_RPC_OUTCOME_UNKNOWN',
      );
    });
  }
});

test('a valid RPC error is definitive, checkpointed, and does not fault the client', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'turn/steer': {
        error: { code: -32600, message: 'no active turn to steer' },
      },
    },
  });
  const client = harness.makeClient();
  await client.start();
  const events = [];
  const error = await rejectedWithCode(
    client.request(
      'turn/steer',
      methodParams('turn/steer', harness.cwd),
      mutationOptions(events),
    ),
    'CODEX_RPC_ERROR',
  );
  assert.equal(error.rpcCode, -32600);
  assert.equal(error.rpcMessage, 'no active turn to steer');
  assert.deepEqual(
    events.map((event) => event.type),
    ['write-attempted', 'response-observed'],
  );
  assert.deepEqual(events[1].checkpoint, {
    id: 2,
    method: 'turn/steer',
    outcome: 'error',
  });
  assert.doesNotThrow(() => client.assertHealthy());
});

test('malformed matching response after a mutation write stays outcome-unknown without leaking fields', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'turn/start': { malformedMatching: 'both-result-and-error' },
    },
  });
  const client = harness.makeClient();
  await client.start();
  const events = [];
  const error = await rejectedWithCode(
    client.request(
      'turn/start',
      methodParams('turn/start', harness.cwd),
      mutationOptions(events),
    ),
    'CODEX_RPC_OUTCOME_UNKNOWN',
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['write-attempted'],
  );
  assert.doesNotMatch(
    `${error.message} ${error.cause?.message ?? ''}`,
    /SECRET_MALFORMED_ERROR/,
  );
  await waitFor(
    () => {
      try {
        client.assertHealthy();
        return false;
      } catch {
        return true;
      }
    },
    'malformed-response fault',
  );
});

test('malformed method-specific mutation result is not exposed and latches outcome-unknown', async (t) => {
  const secret = 'SECRET_INVALID_TURN_RESULT';
  const harness = createHarness(t, {
    methods: {
      'turn/start': {
        result: {
          turn: {
            id: 17,
            status: 'inProgress',
            items: [],
            secret,
          },
        },
      },
    },
  });
  const client = harness.makeClient();
  await client.start();
  const events = [];

  const error = await rejectedWithCode(
    client.request(
      'turn/start',
      methodParams('turn/start', harness.cwd),
      mutationOptions(events),
    ),
    'CODEX_RPC_OUTCOME_UNKNOWN',
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['write-attempted'],
  );
  assert.doesNotMatch(
    `${error.message} ${error.cause?.message ?? ''}`,
    new RegExp(secret),
  );
  assert.throws(
    () => client.assertHealthy(),
    { code: 'CODEX_RPC_OUTCOME_UNKNOWN' },
  );
  await rejectedWithCode(
    client.request('account/read', { refreshToken: false }),
    'CODEX_RPC_OUTCOME_UNKNOWN',
  );
});

test('numeric and string IDs correlate out of order and restart per client instance', async (t) => {
  const numeric = createHarness(t, {
    batchSize: 2,
    reverseBatch: true,
    lineEnding: '\r\n',
    splitEveryByte: true,
    chunkDelayMs: 1,
    methods: {
      'account/read': {
        result: {
          account: { type: 'chatgpt', email: null, planType: 'pro' },
          requiresOpenaiAuth: true,
        },
      },
      'model/list': {
        result: {
          data: [{
            id: 'model-🙂',
            model: 'model-🙂',
            description: 'utf8-🙂',
            displayName: 'ok-🙂',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{
              description: 'balanced-🙂',
              reasoningEffort: 'medium',
            }],
          }],
          nextCursor: null,
        },
      },
    },
  });
  const numericClient = numeric.makeClient({ requestTimeoutMs: 2_000 });
  await numericClient.start();
  const [account, models] = await Promise.all([
    numericClient.request('account/read', { refreshToken: false }),
    numericClient.request('model/list', { includeHidden: false, limit: 100 }),
  ]);
  assert.deepEqual(account, {
    account: { type: 'chatgpt' },
    requiresOpenaiAuth: true,
  });
  assert.deepEqual(models, {
    data: [{
      id: 'model-🙂',
      model: 'model-🙂',
      description: 'utf8-🙂',
      displayName: 'ok-🙂',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['medium'],
    }],
    nextCursor: null,
  });
  assert.deepEqual(
    numeric.requests()
      .filter((message) => Object.hasOwn(message, 'id'))
      .map((message) => message.id),
    [1, 2, 3],
  );

  const strings = createHarness(t);
  const stringClient = strings.makeClient({
    requestIdFactory: (id) => `request-${id}`,
  });
  await stringClient.start();
  await stringClient.request('account/read', { refreshToken: false });
  assert.deepEqual(
    strings.requests()
      .filter((message) => Object.hasOwn(message, 'method'))
      .map((message) => message.id)
      .filter((id) => id !== undefined),
    ['request-1', 'request-2'],
  );

  const replacement = createHarness(t);
  const replacementClient = replacement.makeClient();
  await replacementClient.start();
  await replacementClient.request('account/read', { refreshToken: false });
  assert.deepEqual(
    replacement.requests()
      .filter((message) => Object.hasOwn(message, 'id'))
      .map((message) => message.id),
    [1, 2],
  );
});

test('request IDs are never reused after a completed request', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient({
    requestIdFactory: (nextId) => (nextId === 3 ? 2 : nextId),
  });
  await client.start();
  await client.request('account/read', { refreshToken: false });
  const before = harness.requests().length;

  await rejectedWithCode(
    client.request('model/list', { includeHidden: false, limit: 100 }),
    'CODEX_PROTOCOL_ERROR',
  );
  assert.equal(harness.requests().length, before);
  assert.deepEqual(
    harness.requests()
      .filter((message) => Object.hasOwn(message, 'id'))
      .map((message) => message.id),
    [1, 2],
  );
});

test('mismatched response IDs fault the generation and reject pending work', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'account/read': { mismatchedId: 'not-the-request-id' },
    },
  });
  const client = harness.makeClient();
  await client.start();

  await rejectedWithCode(
    client.request('account/read', { refreshToken: false }),
    'CODEX_PROTOCOL_ERROR',
  );
  assert.throws(
    () => client.assertHealthy(),
    { code: 'CODEX_PROTOCOL_ERROR' },
  );
});

test('request-ID exhaustion faults once and stays sticky', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient({ maxUsedRequestIds: 2 });
  await client.start();
  await client.request('account/read', { refreshToken: false });

  await rejectedWithCode(
    client.request('model/list', { includeHidden: false, limit: 100 }),
    'CODEX_REQUEST_ID_EXHAUSTED',
  );
  assert.throws(
    () => client.assertHealthy(),
    { code: 'CODEX_REQUEST_ID_EXHAUSTED' },
  );
  await rejectedWithCode(
    client.request('account/read', { refreshToken: false }),
    'CODEX_REQUEST_ID_EXHAUSTED',
  );
});

test('notifications are projected, noisy methods are dropped, and sensitive fields never escape', async (t) => {
  const secret = 'SECRET_COMMAND_CWD_ERROR';
  const notifications = [];
  const harness = createHarness(t, {
    methods: {
      'config/read': {
        beforeResponseMessages: [{
          method: 'thread/settings/updated',
          emittedAtMs: 1_785_226_000_000,
          params: {
            threadId: 'thread-1',
            command: secret,
            cwd: secret,
            threadSettings: {
              model: 'gpt-5.6-sol',
              effort: 'xhigh',
              modelProvider: 'openai',
              approvalPolicy: 'never',
              approvalsReviewer: 'auto_review',
              collaborationMode: {
                mode: 'default',
                settings: {
                  model: 'gpt-5.6-sol',
                  reasoning_effort: 'xhigh',
                  developer_instructions: secret,
                },
              },
              cwd: '__OWNED_CWD__',
              sandboxPolicy: {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeSlashTmp: true,
                excludeTmpdirEnvVar: true,
              },
              activePermissionProfile: {
                id: 'polygram-session',
                extends: null,
              },
            },
          },
        }, {
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: true,
            error: { message: secret, command: secret, cwd: secret },
          },
        }, {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1',
              status: 'completed',
              error: { message: secret },
              items: [{
                id: 'item-1',
                type: 'commandExecution',
                command: secret,
                cwd: secret,
              }],
            },
          },
        }, {
          method: 'remoteControl/status/changed',
          emittedAtMs: 1_785_226_000_000,
          params: { status: secret, command: secret, cwd: secret },
        }],
      },
    },
  });
  const client = harness.makeClient({
    onNotification: async (notification) => {
      notifications.push(notification);
    },
  });
  await client.start();
  await client.request('config/read', {
    cwd: harness.cwd,
    includeLayers: true,
  });

  assert.deepEqual(notifications, [{
    method: 'thread/settings/updated',
    params: {
      threadId: 'thread-1',
      threadSettings: {
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        modelProvider: 'openai',
        approvalPolicy: 'never',
        approvalsReviewer: 'auto_review',
        collaborationMode: {
          mode: 'default',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
        },
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
  }, {
    method: 'error',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: { present: true },
    },
  }, {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        error: { present: true },
        items: [{ id: 'item-1', type: 'commandExecution' }],
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(notifications), new RegExp(secret));
});

// Codex emits these whenever the active config enables hooks. Orchestra
// deliberately does not consume hook detail — turn status stays the
// authoritative signal — so the run summary is dropped before projection
// instead of faulting an otherwise healthy turn. The payloads below carry the
// pinned `HookRunSummary` shape, with the operator-controlled handler path and
// hook output text standing in for the sensitive fields a real run exposes.
test('Codex hook lifecycle notifications drop instead of faulting the turn', async (t) => {
  const secret = 'SECRET_HOOK_PATH_AND_OUTPUT';
  const notifications = [];
  const hookRun = {
    id: 'hook-run-1',
    displayOrder: 0,
    eventName: 'preToolUse',
    executionMode: 'sync',
    handlerType: 'command',
    scope: 'turn',
    source: 'user',
    sourcePath: `/Users/example/.codex/hooks/${secret}.toml`,
    // Hook run timestamps are epoch seconds; only the `*Ms` fields are millis.
    startedAt: 1_785_226_000,
  };
  const harness = createHarness(t, {
    methods: {
      'config/read': {
        beforeResponseMessages: [{
          method: 'hook/started',
          emittedAtMs: 1_785_226_000_000,
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            run: { ...hookRun, status: 'running', entries: [] },
          },
        }, {
          method: 'hook/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            run: {
              ...hookRun,
              status: 'completed',
              statusMessage: secret,
              completedAt: 1_785_226_002,
              durationMs: 1_500,
              entries: [
                { kind: 'context', text: secret },
                { kind: 'warning', text: secret },
              ],
            },
          },
        }],
      },
    },
  });
  const client = harness.makeClient({
    onNotification: async (notification) => {
      notifications.push(notification);
    },
  });
  await client.start();
  const result = await client.request('config/read', {
    cwd: harness.cwd,
    includeLayers: true,
  });

  assert.ok(result);
  assert.deepEqual(notifications, []);
  client.assertHealthy();
});

test('notification envelope rejects malformed timestamps and unknown fields', async (t) => {
  const cases = [{
    name: 'string timestamp',
    message: {
      method: 'remoteControl/status/changed',
      emittedAtMs: '1785226000000',
      params: {},
    },
  }, {
    name: 'fractional timestamp',
    message: {
      method: 'remoteControl/status/changed',
      emittedAtMs: 1.5,
      params: {},
    },
  }, {
    name: 'negative timestamp',
    message: {
      method: 'remoteControl/status/changed',
      emittedAtMs: -1,
      params: {},
    },
  }, {
    name: 'unsafe timestamp',
    message: {
      method: 'remoteControl/status/changed',
      emittedAtMs: Number.MAX_SAFE_INTEGER + 1,
      params: {},
    },
  }, {
    name: 'unknown envelope field',
    message: {
      method: 'remoteControl/status/changed',
      emittedAtMs: 1_785_226_000_000,
      secret: 'MUST_NOT_BE_ACCEPTED',
      params: {},
    },
  }];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const harness = createHarness(subtest, {
        methods: {
          'config/read': {
            beforeResponseMessages: [entry.message],
            hold: true,
          },
        },
      });
      const client = harness.makeClient();
      await client.start();

      await rejectedWithCode(
        client.request('config/read', {
          cwd: harness.cwd,
          includeLayers: true,
        }),
        'CODEX_PROTOCOL_ERROR',
      );
      assert.throws(
        () => client.assertHealthy(),
        { code: 'CODEX_PROTOCOL_ERROR' },
      );
    });
  }
});

test('state notifications must match the pinned generated schema', async (t) => {
  const cases = [{
    name: 'active status requires activeFlags',
    message: {
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: { type: 'active' },
      },
    },
  }, {
    name: 'thread settings require the full policy envelope',
    message: {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: { model: 'gpt-5.6-sol' },
      },
    },
  }, {
    name: 'thread settings reject runtime workspace roots',
    message: {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          modelProvider: 'openai',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          cwd: '__OWNED_CWD__',
          runtimeWorkspaceRoots: ['__OWNED_CWD__'],
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
          activePermissionProfile: {
            id: 'polygram-session',
            extends: null,
          },
        },
      },
    },
  }, {
    name: 'thread settings reject permission profile extras',
    message: {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          modelProvider: 'openai',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          cwd: '__OWNED_CWD__',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
          activePermissionProfile: {
            id: 'polygram-session',
            extends: null,
            extra: true,
          },
        },
      },
    },
  }, {
    name: 'thread settings require permission profile parent',
    message: {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          modelProvider: 'openai',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          cwd: '__OWNED_CWD__',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
          activePermissionProfile: {
            id: 'polygram-session',
          },
        },
      },
    },
  }, {
    name: 'turn status is restricted to the generated enum',
    message: {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'mystery',
          items: [],
        },
      },
    },
  }];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const harness = createHarness(subtest, {
        methods: {
          'config/read': {
            beforeResponseMessages: [entry.message],
            hold: true,
          },
        },
      });
      const client = harness.makeClient();
      await client.start();
      await rejectedWithCode(
        client.request('config/read', {
          cwd: harness.cwd,
          includeLayers: true,
        }),
        'CODEX_PROTOCOL_ERROR',
      );
      assert.throws(
        () => client.assertHealthy(),
        { code: 'CODEX_PROTOCOL_ERROR' },
      );
    });
  }
});

test('method results expose bounded projections rather than raw config, account, history, or terminal data', async (t) => {
  const secret = 'SECRET_RESULT_PAYLOAD';
  const secretRoot = `/private/${secret}`;
  const harness = createHarness(t, {
    methods: {
      'config/read': {
        result: {
          config: {
            model: 'gpt-5.6-sol',
            model_provider: 'openai',
            default_permissions: 'polygram-session',
            approval_policy: 'never',
            approvals_reviewer: 'auto_review',
            web_search: 'disabled',
            allow_login_shell: false,
            shell_environment_policy: { inherit: 'none' },
            permissions: {
              'polygram-session': {
                network: { enabled: false },
                filesystem: {
                  glob_scan_max_depth: null,
                  ':workspace_roots': { '.': 'write' },
                  [secretRoot]: 'deny',
                },
              },
            },
            model_providers: {
              openai: { http_headers: { Authorization: secret } },
            },
            mcp_servers: {},
            plugins: {},
          },
          layers: [{
            name: { type: 'user' },
            version: '1',
            config: { private_value: secret },
          }],
          origins: { private_origin: secret },
        },
      },
      'account/read': {
        result: {
          account: {
            type: 'chatgpt',
            email: `${secret}@example.invalid`,
            planType: 'pro',
          },
          requiresOpenaiAuth: true,
        },
      },
      'permissionProfile/list': {
        result: {
          data: [{
            id: 'polygram-session',
            allowed: true,
            description: secret,
          }],
          nextCursor: null,
        },
      },
      'thread/backgroundTerminals/list': {
        result: {
          data: [{ command: secret, cwd: secretRoot, processId: secret }],
          nextCursor: null,
        },
      },
    },
  });
  const client = harness.makeClient();
  await client.start();

  const config = await client.request('config/read', {
    cwd: harness.cwd,
    includeLayers: true,
  });
  const account = await client.request('account/read', { refreshToken: false });
  const profiles = await client.request('permissionProfile/list', {
    cwd: harness.cwd,
  });
  const thread = await client.request(
    'thread/start',
    methodParams('thread/start', harness.cwd),
    mutationOptions(),
  );
  const terminals = await client.request(
    'thread/backgroundTerminals/list',
    { threadId: 'thread-1' },
  );

  assert.equal(config.config.model, 'gpt-5.6-sol');
  assert.equal(config.config.permissionProfiles[0].filesystem.length, 1);
  assert.match(
    config.config.permissionProfiles[0].filesystemSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.match(config.config.sha256, /^[a-f0-9]{64}$/);
  assert.match(config.originsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(account, {
    account: { type: 'chatgpt' },
    requiresOpenaiAuth: true,
  });
  assert.deepEqual(profiles.data[0], {
    id: 'polygram-session',
    allowed: true,
    descriptionSha256: createHash('sha256').update(secret).digest('hex'),
  });
  assert.equal(Object.hasOwn(thread.sandbox, 'writableRoots'), false);
  assert.deepEqual(thread.runtimeWorkspaceRoots, {
    count: 1,
    sha256: [
      createHash('sha256').update(harness.cwd).digest('hex'),
    ],
  });
  assert.deepEqual(thread.sandbox, {
    type: 'workspaceWrite',
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
    writableRootCount: 0,
    writableRootSha256: [],
  });
  assert.deepEqual(thread.runtimeWorkspaceRoots.sha256, [
    createHash('sha256').update(harness.cwd).digest('hex'),
  ]);
  assert.deepEqual(terminals, { count: 1, nextCursor: null });
  assert.doesNotMatch(
    JSON.stringify({ config, account, profiles, thread, terminals }),
    new RegExp(secret),
  );
});

test('thread attachment runtime workspace roots fail closed on malformed shapes', async (t) => {
  const cases = [
    ['missing', (result) => delete result.runtimeWorkspaceRoots],
    ['non-array', (result) => { result.runtimeWorkspaceRoots = result.cwd; }],
    ['duplicated', (result) => {
      result.runtimeWorkspaceRoots = [result.cwd, result.cwd];
    }],
    ['additional', (result) => {
      result.runtimeWorkspaceRoots = [result.cwd, path.join(result.cwd, 'other')];
    }],
    ['outside workspace', (result) => {
      result.runtimeWorkspaceRoots = [path.dirname(result.cwd)];
    }],
    ['nested runtime root', (result) => {
      result.runtimeWorkspaceRoots = [path.join(result.cwd, 'nested')];
    }],
    ['non-canonical', (result) => {
      result.runtimeWorkspaceRoots = [`${result.cwd}/../workspace`];
    }],
    ['permission profile extras', (result) => {
      result.activePermissionProfile.extra = true;
    }],
    ['permission profile parent missing', (result) => {
      delete result.activePermissionProfile.extends;
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const harness = createHarness(t);
      const result = {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [],
        },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        cwd: harness.cwd,
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: 'medium',
        runtimeWorkspaceRoots: [harness.cwd],
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
        activePermissionProfile: {
          id: 'polygram-session',
          extends: null,
        },
      };
      mutate(result);
      writeFileSync(
        path.join(harness.cwd, '.fake-codex-app-server.json'),
        `${JSON.stringify({
          methods: { 'thread/start': { result } },
        })}\n`,
      );
      const client = harness.makeClient();
      await client.start();

      await rejectedWithCode(
        client.request(
          'thread/start',
          methodParams('thread/start', harness.cwd),
          mutationOptions(),
        ),
        'CODEX_RPC_OUTCOME_UNKNOWN',
      );
    });
  }
});

test('ChatGPT account responses require generated email and plan fields', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'account/read': {
        result: {
          account: { type: 'chatgpt' },
          requiresOpenaiAuth: true,
        },
      },
    },
  });
  const client = harness.makeClient();
  await client.start();

  await rejectedWithCode(
    client.request('account/read', { refreshToken: false }),
    'CODEX_PROTOCOL_ERROR',
  );
  assert.throws(
    () => client.assertHealthy(),
    { code: 'CODEX_PROTOCOL_ERROR' },
  );
});

test('known server requests receive their exact denial and fault the generation', async (t) => {
  const method = 'item/tool/requestUserInput';
  const harness = createHarness(t, {
    exitAfterServerResponse: true,
    afterInitialized: [{
      id: 'server-request-1',
      method,
      params: {
        command: 'SECRET_SERVER_COMMAND',
        cwd: 'SECRET_SERVER_CWD',
      },
    }],
  });
  const client = harness.makeClient();
  let denialEvent;
  client.once('server-request-denied', (event) => {
    denialEvent = event;
  });
  await client.start();

  const response = await waitFor(
    () => harness.requests().find(
      (message) => (
        message.id === 'server-request-1'
        && !Object.hasOwn(message, 'method')
      ),
    ),
    'server-request denial',
  );
  assert.deepEqual(response, {
    id: 'server-request-1',
    ...protocolSchema.deniedServerRequests[method],
  });
  await waitFor(
    () => {
      try {
        client.assertHealthy();
        return false;
      } catch {
        return true;
      }
    },
    'server-request fault',
  );
  assert.deepEqual(denialEvent, { known: true });
  let fault;
  try {
    client.assertHealthy();
  } catch (error) {
    fault = error;
  }
  assert.equal(fault.code, 'CODEX_SERVER_REQUEST_DENIED');
  assert.doesNotMatch(
    `${fault.message} ${fault.cause?.message ?? ''}`,
    /SECRET_SERVER_COMMAND|SECRET_SERVER_CWD/,
  );
});

test('an unknown server request faults while a client RPC is pending', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'config/read': {
        beforeResponseMessages: [{
          id: 'unknown-server-request',
          method: 'item/tool/newUndocumentedRequest',
          params: { secret: 'MUST_NOT_ESCAPE' },
        }],
        hold: true,
      },
    },
  });
  const client = harness.makeClient();
  await client.start();

  const error = await rejectedWithCode(
    client.request('config/read', {
      cwd: harness.cwd,
      includeLayers: true,
    }),
    'CODEX_PROTOCOL_ERROR',
  );
  assert.doesNotMatch(
    `${error.message} ${error.cause?.message ?? ''}`,
    /MUST_NOT_ESCAPE/,
  );
  assert.throws(() => client.assertHealthy());
});

test('unknown notifications fault without exposing their payload', async (t) => {
  // The `hook/` case pins that dropping the two known hook notifications did
  // not widen into tolerance for the whole namespace.
  for (const method of [
    'thread/experimental/unknown',
    'hook/experimental/unknown',
  ]) {
    await t.test(method, async (subtest) => {
      const harness = createHarness(subtest, {
        methods: {
          'config/read': {
            beforeResponseMessages: [{
              method,
              params: {
                command: 'SECRET_UNKNOWN_COMMAND',
                cwd: 'SECRET_UNKNOWN_CWD',
              },
            }],
            hold: true,
          },
        },
      });
      const client = harness.makeClient();
      await client.start();
      const error = await client.request('config/read', {
        cwd: harness.cwd,
        includeLayers: true,
      }).then(
        () => null,
        (caught) => caught,
      );
      assert.ok(error);
      assert.equal(error.code, 'CODEX_PROTOCOL_ERROR');
      assert.doesNotMatch(
        `${error.message} ${error.cause?.message ?? ''}`,
        /SECRET_UNKNOWN_COMMAND|SECRET_UNKNOWN_CWD/,
      );
      assert.throws(() => client.assertHealthy());
    });
  }
});

test('pending request cap rejects before writing another request', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'account/read': { hold: true },
    },
  });
  const client = harness.makeClient({ maxPendingRequests: 2 });
  await client.start();
  const pending = [
    client.request('account/read', { refreshToken: false }),
    client.request('account/read', { refreshToken: false }),
  ];
  for (const request of pending) request.catch(() => {});
  await waitFor(
    () => harness.requests().filter(
      (message) => message.method === 'account/read',
    ).length === 2,
    'two pending account requests',
  );
  const before = harness.requests().length;

  await rejectedWithCode(
    client.request('account/read', { refreshToken: false }),
    'CODEX_RPC_REJECTED',
  );
  assert.equal(harness.requests().length, before);
  await client.close();
  await Promise.allSettled(pending);
});

test('inbound line and byte queue caps fault instead of buffering without bound', async (t) => {
  const warnings = Array.from(
    { length: 10 },
    () => ({ method: 'warning', params: {} }),
  );
  const cases = [{
    name: 'line cap',
    options: {
      maxQueuedLines: 2,
      maxQueuedBytes: 1_024,
    },
  }, {
    name: 'byte cap',
    options: {
      maxQueuedLines: 20,
      maxQueuedBytes: 256,
    },
  }];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const harness = createHarness(subtest, {
        methods: {
          'config/read': {
            beforeResponseMessages: warnings,
            hold: true,
          },
        },
      });
      const client = harness.makeClient(entry.options);
      await client.start();

      await rejectedWithinWithCode(
        client.request('config/read', {
          cwd: harness.cwd,
          includeLayers: true,
        }),
        'CODEX_PROTOCOL_ERROR',
      );
      assert.throws(
        () => client.assertHealthy(),
        { code: 'CODEX_PROTOCOL_ERROR' },
      );
    });
  }
});

test('oversized, malformed, partial, and stderr failures reject pending work without leaking content', async (t) => {
  const cases = [{
    name: 'oversized line',
    scenario: {
      methods: { 'config/read': { oversizedBytes: 2_048 } },
    },
    options: { maxLineBytes: 512 },
  }, {
    name: 'malformed JSON',
    scenario: {
      methods: {
        'config/read': {
          rawMalformed: '{"command":"SECRET_MALFORMED_COMMAND"',
        },
      },
    },
  }, {
    name: 'partial EOF',
    scenario: {
      methods: { 'config/read': { partialThenExit: true } },
    },
  }, {
    name: 'bounded stderr',
    scenario: {
      methods: {
        'config/read': {
          stderr: 'SECRET_STDERR_CONTENT'.repeat(20),
          hold: true,
        },
      },
    },
    options: { maxStderrBytes: 32 },
  }];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const harness = createHarness(subtest, entry.scenario);
      const client = harness.makeClient(entry.options);
      await client.start();
      const error = await client.request('config/read', {
        cwd: harness.cwd,
        includeLayers: true,
      }).then(
        () => null,
        (caught) => caught,
      );
      assert.ok(error);
      assert.doesNotMatch(
        `${error.message} ${error.cause?.message ?? ''}`,
        /SECRET_MALFORMED_COMMAND|SECRET_STDERR_CONTENT/,
      );
      assert.throws(() => client.assertHealthy());
    });
  }
});

test('gradual cumulative stderr failure after a clean mutation is content-free and classified', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'thread/backgroundTerminals/clean': {
        stderr: 'x'.repeat(6),
      },
    },
  });
  let observed;
  const client = harness.makeClient({
    maxStderrBytes: 10,
    onFault: async (outcome) => {
      observed = outcome;
    },
  });
  await client.start();
  const options = mutationOptions();

  await client.request(
    'thread/backgroundTerminals/clean',
    { threadId: 'thread-1' },
    options,
  );
  await assert.rejects(
    client.request(
      'thread/backgroundTerminals/clean',
      { threadId: 'thread-1' },
      options,
    ),
    (error) => (
      error.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
      && error.clientRootErrorCode === 'CODEX_PROTOCOL_ERROR'
      && error.clientFaultClass === 'stderr-limit'
    ),
  );

  const outcome = await client.waitForFault();
  assert.equal(outcome.clientRootErrorCode, 'CODEX_PROTOCOL_ERROR');
  assert.equal(outcome.clientFaultClass, 'stderr-limit');
  assert.equal(JSON.stringify(outcome).includes('xxxxxxxx'), false);
  assert.equal(Object.getOwnPropertyDescriptor(outcome, 'clientRootErrorCode').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(outcome, 'clientFaultClass').writable, false);
});

test('mutation wrappers preserve normalized root provenance through outcome-unknown fault', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'thread/backgroundTerminals/clean': {
        closeAfterRead: true,
      },
    },
  });
  let observed;
  const client = harness.makeClient({
    onFault: async (outcome) => {
      observed = outcome;
    },
  });
  await client.start();

  const error = await client.request(
    'thread/backgroundTerminals/clean',
    { threadId: 'thread-1' },
    mutationOptions(),
  ).then(() => null, (caught) => caught);
  assert.equal(error.code, 'CODEX_RPC_OUTCOME_UNKNOWN');
  assert.equal(error.clientRootErrorCode, 'CODEX_PROTOCOL_ERROR');
  assert.equal(error.clientFaultClass, 'protocol');
  assert.equal(Object.getOwnPropertyDescriptor(error, 'clientRootErrorCode').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(error, 'clientFaultClass').writable, false);

  const outcome = await client.waitForFault();
  assert.deepEqual(observed, outcome);
  assert.equal(outcome.clientRootErrorCode, 'CODEX_PROTOCOL_ERROR');
  assert.equal(outcome.clientFaultClass, 'protocol');
});

test('raw transport write failures normalize before mutation wrapping', async (t) => {
  const harness = createHarness(t);
  let observed;
  const client = harness.makeClient({
    onFault: async (outcome) => {
      observed = outcome;
    },
  });
  await client.start();
  const stdin = client.child.stdin;
  const rawTransportError = Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
  stdin.write = (_line, callback) => callback(rawTransportError);

  const error = await client.request(
    'thread/backgroundTerminals/clean',
    { threadId: 'thread-1' },
    mutationOptions(),
  ).then(() => null, (caught) => caught);
  assert.equal(error.code, 'CODEX_RPC_OUTCOME_UNKNOWN');
  assert.equal(error.clientRootErrorCode, 'CODEX_TRANSPORT_ERROR');
  assert.equal(error.clientFaultClass, 'transport');
  const outcome = await client.waitForFault();
  assert.deepEqual(observed, outcome);
  assert.equal(outcome.clientRootErrorCode, 'CODEX_TRANSPORT_ERROR');
  assert.equal(outcome.clientFaultClass, 'transport');
});

test('fault provenance fallback is bounded and cycle-safe', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  const cyclic = new Error('SECRET_CYCLIC_FAULT');
  cyclic.code = 'NOT_AN_ALLOWLISTED_CODE';
  cyclic.cause = cyclic;
  client._fault(cyclic);

  const outcome = await client.waitForFault();
  assert.equal(outcome.clientRootErrorCode, 'unknown');
  assert.equal(outcome.clientFaultClass, 'unknown');
  assert.equal(JSON.stringify(outcome).includes('SECRET_CYCLIC_FAULT'), false);
});

test('fault containment survives errors that cannot accept provenance fields', async (t) => {
  await t.test('frozen notification sink error', async (subtest) => {
    const harness = createHarness(subtest, {
      methods: {
        'config/read': {
          beforeResponseMessages: [{
            method: 'thread/status/changed',
            params: {
              threadId: 'thread-1',
              status: { type: 'active', activeFlags: [] },
            },
          }],
          hold: true,
        },
      },
    });
    const sinkError = Object.freeze(new Error(
      'SECRET_FROZEN_NOTIFICATION_PAYLOAD',
    ));
    const client = harness.makeClient({
      onNotification: () => {
        throw sinkError;
      },
    });
    await client.start();

    const requestError = await rejectedWithinWithCode(
      client.request('config/read', {
        cwd: harness.cwd,
        includeLayers: true,
      }),
      'CODEX_PROTOCOL_ERROR',
      1_000,
    );
    assert.notEqual(requestError, sinkError);
    assert.equal(requestError.cause, sinkError);
    assert.equal(requestError.message, 'app-server fault could not be annotated');
    assert.equal(requestError.clientRootErrorCode, 'unknown');
    assert.equal(requestError.clientFaultClass, 'unknown');
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(requestError, 'clientRootErrorCode'),
      {
        value: 'unknown',
        enumerable: true,
        writable: false,
        configurable: false,
      },
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(requestError, 'clientFaultClass'),
      {
        value: 'unknown',
        enumerable: true,
        writable: false,
        configurable: false,
      },
    );

    const outcome = await client.waitForFault();
    assert.equal(client.state, 'closed');
    assert.equal(outcome.boundary, 'post-spawn');
    assert.equal(outcome.containment, 'unverified');
    assert.equal(outcome.cleanup, 'completed');
    assert.equal(outcome.errorCode, 'CODEX_PROTOCOL_ERROR');
    assert.equal(outcome.clientRootErrorCode, 'unknown');
    assert.equal(outcome.clientFaultClass, 'unknown');
    assert.equal(
      JSON.stringify(outcome).includes('SECRET_FROZEN_NOTIFICATION_PAYLOAD'),
      false,
    );
  });

  await t.test('conflicting immutable provenance descriptors', async (subtest) => {
    const harness = createHarness(subtest);
    const client = harness.makeClient();
    await client.start();
    const conflicting = new Error('SECRET_CONFLICTING_FAULT_PAYLOAD');
    Object.defineProperties(conflicting, {
      code: {
        value: 'SECRET_RAW_ERROR_CODE',
        enumerable: true,
        writable: false,
        configurable: false,
      },
      clientRootErrorCode: {
        value: 'SECRET_ROOT_ERROR_CODE',
        enumerable: true,
        writable: false,
        configurable: false,
      },
      clientFaultClass: {
        value: 'SECRET_FAULT_CLASS',
        enumerable: true,
        writable: false,
        configurable: false,
      },
    });

    assert.doesNotThrow(() => client._fault(conflicting));
    const outcome = await client.waitForFault();
    assert.equal(client.state, 'closed');
    assert.notEqual(client.protocolError, conflicting);
    assert.equal(client.protocolError.cause, conflicting);
    assert.equal(client.protocolError.code, 'CODEX_PROTOCOL_ERROR');
    assert.equal(client.protocolError.clientRootErrorCode, 'unknown');
    assert.equal(client.protocolError.clientFaultClass, 'unknown');
    assert.equal(outcome.boundary, 'post-spawn');
    assert.equal(outcome.containment, 'unverified');
    assert.equal(outcome.cleanup, 'completed');
    assert.equal(outcome.errorCode, 'CODEX_PROTOCOL_ERROR');
    assert.equal(outcome.clientRootErrorCode, 'unknown');
    assert.equal(outcome.clientFaultClass, 'unknown');
    const serialized = JSON.stringify(outcome);
    assert.equal(serialized.includes('SECRET_CONFLICTING_FAULT_PAYLOAD'), false);
    assert.equal(serialized.includes('SECRET_RAW_ERROR_CODE'), false);
    assert.equal(serialized.includes('SECRET_ROOT_ERROR_CODE'), false);
    assert.equal(serialized.includes('SECRET_FAULT_CLASS'), false);
  });
});

test('queued valid response is processed before a following stdout EOF fault', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'account/read': {
        result: {
          account: { type: 'chatgpt', email: null, planType: 'pro' },
          requiresOpenaiAuth: true,
        },
        exitAfterResponse: true,
      },
    },
  });
  const client = harness.makeClient();
  await client.start();

  assert.deepEqual(
    await client.request('account/read', { refreshToken: false }),
    {
      account: { type: 'chatgpt' },
      requiresOpenaiAuth: true,
    },
  );
  await waitFor(
    () => {
      try {
        client.assertHealthy();
        return false;
      } catch {
        return true;
      }
    },
    'post-response EOF fault',
  );
});

test('an exit event cannot overtake a final response still draining from stdout', async (t) => {
  const harness = createHarness(t);
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12_345,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  let stdinBuffer = '';
  child.stdin.on('data', (chunk) => {
    stdinBuffer += chunk.toString();
    let newline;
    while ((newline = stdinBuffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(stdinBuffer.slice(0, newline));
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (message.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({
          id: message.id,
          result: {
            codexHome: harness.codexHome,
            platformFamily: 'unix',
            platformOs: 'macos',
            userAgent: 'fake-codex-app-server/0.145.0',
          },
        })}\n`);
      } else if (message.method === 'account/read') {
        child.emit('exit', 0, null);
        child.stdout.write(`${JSON.stringify({
          id: message.id,
          result: {
            account: { type: 'chatgpt', email: null, planType: 'pro' },
            requiresOpenaiAuth: true,
          },
        })}\n`);
        child.exitCode = 0;
        child.stdout.end();
        child.emit('close', 0, null);
      }
    }
  });
  const client = harness.makeClient({ spawnFn: () => child });
  await client.start();

  assert.deepEqual(
    await client.request('account/read', { refreshToken: false }),
    {
      account: { type: 'chatgpt' },
      requiresOpenaiAuth: true,
    },
  );
  await client.waitForFault();
});

test('timeout followed by a late response settles once and leaves no reusable pending entry', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'account/read': {
        delayMs: 80,
        result: {
          account: { type: 'chatgpt', email: null, planType: 'pro' },
          requiresOpenaiAuth: true,
        },
      },
    },
  });
  let faults = 0;
  const client = harness.makeClient({
    onFault: () => { faults += 1; },
  });
  await client.start();
  let settlements = 0;
  const request = client.request(
    'account/read',
    { refreshToken: false },
    { timeoutMs: 20 },
  );
  request.then(
    () => { settlements += 1; },
    () => { settlements += 1; },
  );
  await rejectedWithCode(request, 'CODEX_RPC_TIMEOUT');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settlements, 1);
  await client.waitForFault();
  assert.equal(faults, 1);
  assert.throws(() => client.assertHealthy());
});

test('mutation timeout after write latches outcome-unknown for the generation', async (t) => {
  const harness = createHarness(t, {
    methods: {
      'turn/start': { hold: true },
    },
  });
  const client = harness.makeClient();
  await client.start();
  const events = [];

  await rejectedWithCode(
    client.request(
      'turn/start',
      methodParams('turn/start', harness.cwd),
      mutationOptions(events, { timeoutMs: 20 }),
    ),
    'CODEX_RPC_OUTCOME_UNKNOWN',
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['write-attempted'],
  );
  assert.throws(
    () => client.assertHealthy(),
    { code: 'CODEX_RPC_OUTCOME_UNKNOWN' },
  );
  await rejectedWithCode(
    client.request('account/read', { refreshToken: false }),
    'CODEX_RPC_OUTCOME_UNKNOWN',
  );
});

test('response checkpoint failure rejects before exposure and faults once', async (t) => {
  const harness = createHarness(t);
  let faults = 0;
  const client = harness.makeClient({
    onFault: () => { faults += 1; },
  });
  await client.start();
  let settled = false;
  const request = client.request(
    'turn/start',
    methodParams('turn/start', harness.cwd),
    mutationOptions([], {
      onResponseObserved: async () => {
        throw new Error('durability unavailable');
      },
    }),
  );
  request.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const error = await rejectedWithCode(
    request,
    'CODEX_RPC_CHECKPOINT_FAILED',
  );
  assert.equal(settled, true);
  assert.match(error.message, /response checkpoint failed/);
  await client.waitForFault();
  assert.equal(faults, 1);
  assert.throws(() => client.assertHealthy());
});

test('write, response, and notification sinks have bounded deadlines', async (t) => {
  await t.test('write checkpoint', async (subtest) => {
    const harness = createHarness(subtest);
    const client = harness.makeClient({ sinkTimeoutMs: 20 });
    await client.start();
    await waitForInitializedLog(harness);
    const before = harness.requests().length;
    let sideEffects = 0;
    let observedAbort = false;

    await rejectedWithinWithCode(
      client.request(
        'turn/start',
        methodParams('turn/start', harness.cwd),
        mutationOptions([], {
          onWriteAttempted: async (checkpoint) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            observedAbort = checkpoint.signal.aborted;
            checkpoint.assertActive();
            sideEffects += 1;
          },
        }),
      ),
      'CODEX_RPC_NOT_SENT',
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(harness.requests().length, before);
    assert.equal(observedAbort, true);
    assert.equal(sideEffects, 0);
    assert.doesNotThrow(() => client.assertHealthy());
  });

  await t.test('request timeout revokes an in-flight write checkpoint', async (subtest) => {
    const harness = createHarness(subtest);
    const client = harness.makeClient({ sinkTimeoutMs: 200 });
    await client.start();
    await waitForInitializedLog(harness);
    const before = harness.requests().length;
    let sideEffects = 0;
    let observedAbort = false;

    await rejectedWithinWithCode(
      client.request(
        'turn/start',
        methodParams('turn/start', harness.cwd),
        mutationOptions([], {
          timeoutMs: 20,
          onWriteAttempted: async (checkpoint) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            observedAbort = checkpoint.signal.aborted;
            checkpoint.assertActive();
            sideEffects += 1;
          },
        }),
      ),
      'CODEX_RPC_NOT_SENT',
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(observedAbort, true);
    assert.equal(sideEffects, 0);
    assert.equal(harness.requests().length, before);
    assert.doesNotThrow(() => client.assertHealthy());
  });

  await t.test('response checkpoint', async (subtest) => {
    const harness = createHarness(subtest);
    const client = harness.makeClient({ sinkTimeoutMs: 20 });
    await client.start();

    await rejectedWithinWithCode(
      client.request(
        'turn/start',
        methodParams('turn/start', harness.cwd),
        mutationOptions([], {
          onResponseObserved: () => new Promise(() => {}),
        }),
      ),
      'CODEX_RPC_CHECKPOINT_FAILED',
    );
    assert.throws(
      () => client.assertHealthy(),
      { code: 'CODEX_RPC_CHECKPOINT_FAILED' },
    );
  });

  await t.test('notification sink', async (subtest) => {
    const harness = createHarness(subtest, {
      methods: {
        'config/read': {
          beforeResponseMessages: [{
            method: 'thread/status/changed',
            params: {
              threadId: 'thread-1',
              status: { type: 'active', activeFlags: [] },
            },
          }],
          hold: true,
        },
      },
    });
    const client = harness.makeClient({
      sinkTimeoutMs: 20,
      onNotification: () => new Promise(() => {}),
    });
    await client.start();

    await rejectedWithinWithCode(
      client.request('config/read', {
        cwd: harness.cwd,
        includeLayers: true,
      }),
      'CODEX_SINK_TIMEOUT',
    );
    assert.throws(
      () => client.assertHealthy(),
      { code: 'CODEX_SINK_TIMEOUT' },
    );
  });
});

test('fault handoff distinguishes safe pre-spawn failure from quarantined post-spawn loss', async (t) => {
  await t.test('pre-spawn attestation failure is safe', async (subtest) => {
    const harness = createHarness(subtest);
    let observed;
    const mismatch = new Error('pin mismatch');
    mismatch.code = 'CODEX_BINARY_MISMATCH';
    const client = harness.makeClient({
      attestBinaryFn: async () => {
        throw mismatch;
      },
      onFault: async (outcome) => {
        observed = outcome;
      },
    });

    await rejectedWithCode(client.start(), 'CODEX_BINARY_MISMATCH');
    const outcome = await client.waitForFault();
    assert.deepEqual(observed, outcome);
    assert.deepEqual(outcome, {
      kind: 'codex-app-server-fault',
      boundary: 'pre-spawn',
      containment: 'safe',
      cleanup: 'completed',
      errorCode: 'CODEX_BINARY_MISMATCH',
      cleanupErrorCode: null,
      clientRootErrorCode: 'unknown',
      clientFaultClass: 'unknown',
      mutationOutcomeUnknown: false,
    });
  });

  await t.test('post-spawn protocol loss requires quarantine', async (subtest) => {
    const harness = createHarness(subtest, {
      afterInitialized: [{
        method: 'thread/undocumented/event',
        params: { secret: 'MUST_NOT_ESCAPE' },
      }],
    });
    let observed;
    const client = harness.makeClient({
      onFault: async (outcome) => {
        observed = outcome;
      },
    });
    await client.start();

    const outcome = await client.waitForFault();
    assert.deepEqual(observed, outcome);
    assert.equal(outcome.boundary, 'post-spawn');
    assert.equal(outcome.containment, 'unverified');
    assert.equal(outcome.cleanup, 'completed');
    assert.equal(outcome.errorCode, 'CODEX_PROTOCOL_ERROR');
  });

  await t.test('cleanup failure is included in the durable handoff', async (subtest) => {
    const harness = createHarness(subtest);
    let observed;
    const client = harness.makeClient({
      spawnFn: () => ({}),
      onFault: async (outcome) => {
        observed = outcome;
      },
    });

    await assert.rejects(client.start(), /invalid child/);
    const outcome = await client.waitForFault();
    assert.deepEqual(observed, outcome);
    assert.equal(outcome.boundary, 'post-spawn');
    assert.equal(outcome.containment, 'unverified');
    assert.equal(outcome.cleanup, 'failed');
  });
});

test('close reaps the supervisor when the app-server exits first', async (t) => {
  // The order that breaks a piped stdin: the child goes away, the pipe unpipes
  // itself, our stdin is left paused, and the EOF that asks the supervisor to
  // shut down is never delivered. The supervisor then leads its group forever.
  const harness = createHarness(t, {
    methods: { 'config/read': { partialThenExit: true } },
  });
  const client = harness.makeClient({ closeGraceMs: 500, closeKillMs: 500 });
  await client.start();
  const supervisorPid = client.child.pid;
  await client.request('config/read', {
    cwd: harness.cwd,
    includeLayers: true,
  }).catch(() => {});

  await closeAllowingRecycledGroupId(client);

  await waitFor(
    () => {
      try {
        process.kill(supervisorPid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    },
    'supervisor to exit',
  );
});

// Once the leader exits, the group id it held can be recycled — on this host
// that has been observed mid-run, with the read-only probe answering EPERM for
// a group that had become someone else's. Only that one outcome is tolerated:
// it carries an EPERM cause and means the group is not ours to read. A group
// that still holds processes reports the same code with no cause, and must
// still fail the test — otherwise a supervisor that left its group populated
// would pass unnoticed.
async function closeAllowingRecycledGroupId(client) {
  try {
    await client.close();
  } catch (error) {
    const recycled = error.code === 'CODEX_PROCESS_CLEANUP_UNVERIFIED'
      && error.cause?.code === 'EPERM';
    if (!recycled) throw error;
  }
}

// Terminating the owned group belongs to the supervisor. A parent that checks
// "is the leader still alive?" and then signals -pgid cannot close the window
// between the two: the leader may exit and the id be recycled in between, so
// the kill can land on an unrelated group. Only the group's live leader can
// signal it without racing its own exit, so the parent signals nothing lethal
// and confines itself to a read-only proof once the supervisor is gone.
test('the supervisor terminates a stubborn tree without any parent signal', async (t) => {
  const harness = createHarness(t, {
    ignoreSigterm: true,
    ignoreStdinClose: true,
  });
  const signals = [];
  const client = harness.makeClient({
    closeGraceMs: 1_000,
    closeKillMs: 1_000,
    killFn: (pid, signal) => {
      signals.push({ pid, signal });
      return process.kill(pid, signal);
    },
  });
  await client.start();
  const supervisorPid = client.child.pid;

  const closes = [client.close(), client.close(), client.close()];
  assert.equal(closes[0], closes[1]);
  assert.equal(closes[1], closes[2]);
  await closeAllowingRecycledGroupId(client);

  // The claim under test: the tree came down without the parent ever aiming a
  // signal at a process group it could not prove was still its own.
  assert.ok(signals.length >= 1);
  assert.equal(signals.every(({ signal }) => signal === 0), true);
  assert.equal(signals.every(({ pid }) => pid === -supervisorPid), true);
  assert.doesNotThrow(() => client.close());
});

test('close sends no signal at all when the tree exits on its own', async (t) => {
  const harness = createHarness(t);
  const signals = [];
  const client = harness.makeClient({
    closeGraceMs: 1_000,
    closeKillMs: 1_000,
    killFn: (pid, signal) => {
      signals.push({ pid, signal });
      return process.kill(pid, signal);
    },
  });
  await client.start();
  await closeAllowingRecycledGroupId(client);

  assert.equal(signals.every(({ signal }) => signal === 0), true);
  assert.doesNotThrow(() => client.close());
});

// Terminating the owned group is the supervisor's job, so the parent's only
// remaining kill(2) call is the read-only emptiness probe. A wedged
// `/bin/ps -axo pid=,pgid=` used to leave close() awaiting forever — execFile's
// timeout only sends SIGTERM, so the promise never settled.
const OWNED_PID = 999_001;

function fakeSupervisorChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.exit = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  return child;
}

function killError(code) {
  const error = new Error(`kill ${code}`);
  error.code = code;
  return error;
}

async function resolvedWithin(promise, deadlineMs = 1_500) {
  let timer;
  const outcome = await Promise.race([
    promise.then(() => ({ resolved: true }), (error) => ({ resolved: false, error })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ resolved: false, error: null }), deadlineMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  assert.equal(
    outcome.resolved,
    true,
    outcome.error
      ? `expected close to succeed, got ${outcome.error.code ?? outcome.error.message}`
      : `expected close to settle within ${deadlineMs}ms`,
  );
}

// Stands in for a supervisor that terminates its own group: ending stdin is the
// only request the parent makes, and the supervisor's exit is the only answer it
// waits for. `retires: false` models a supervisor that never finishes.
function attachFakeSupervisor(harness, options = {}) {
  const {
    onProbe = () => { throw killError('ESRCH'); },
    retires = true,
  } = options;
  const child = fakeSupervisorChild(OWNED_PID);
  const signals = [];
  const client = harness.makeClient({
    closeGraceMs: 60,
    closeKillMs: 60,
    killFn: (target, signal) => {
      signals.push({ pid: target, signal });
      return onProbe(signal);
    },
    ...options.client,
  });
  client.child = child;
  client._attachChild();
  if (retires) child.stdin.once('finish', () => child.exit(0, null));
  return { client, child, signals };
}

test('close requests shutdown with stdin alone and only reads the group', async (t) => {
  const harness = createHarness(t);
  const { client, child, signals } = attachFakeSupervisor(harness);

  await client.close();

  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(signals, [{ pid: -OWNED_PID, signal: 0 }]);
});

test('close ignores the process-table probe that used to wedge it', async (t) => {
  const harness = createHarness(t);
  const { client, signals } = attachFakeSupervisor(harness);
  // The shipped cleanup awaited this inside its poll loop, so a wedged
  // `/bin/ps` left close() unable to settle at all.
  client._ownedGroupMembers = () => new Promise(() => {});

  await resolvedWithin(client.close());

  assert.deepEqual(signals, [{ pid: -OWNED_PID, signal: 0 }]);
});

test('close fails closed when the owned group never proves empty', async (t) => {
  const harness = createHarness(t);
  // Every read reports members, so emptiness is never proven.
  const { client, signals } = attachFakeSupervisor(harness, {
    onProbe: () => true,
  });

  await rejectedWithinWithCode(
    client.close(),
    'CODEX_PROCESS_CLEANUP_UNVERIFIED',
    1_500,
  );
  assert.ok(signals.length >= 1);
  assert.equal(signals.every(({ signal }) => signal === 0), true);
});

test('close fails closed when the owned group cannot be read', async (t) => {
  const harness = createHarness(t);
  const { client, signals } = attachFakeSupervisor(harness, {
    onProbe: () => { throw killError('EPERM'); },
  });

  await rejectedWithinWithCode(
    client.close(),
    'CODEX_PROCESS_CLEANUP_UNVERIFIED',
    1_500,
  );
  assert.equal(signals.every(({ signal }) => signal === 0), true);
});

test('close fails closed when the supervisor never terminates its group', async (t) => {
  const harness = createHarness(t);
  const { client, signals } = attachFakeSupervisor(harness, { retires: false });

  await rejectedWithinWithCode(
    client.close(),
    'CODEX_PROCESS_CLOSE_TIMEOUT',
    1_500,
  );
  // Escalating here is exactly what is unsafe: the parent cannot know the
  // leader is still alive at the instant a group signal would land.
  assert.deepEqual(signals, []);
});

test('supervisor terminates a stubborn tree on stdin EOF', async (t) => {
  const harness = createHarness(t);
  const stubborn = path.join(harness.cwd, 'stubborn-child.mjs');
  writeFileSync(stubborn, [
    "process.on('SIGTERM', () => {});",
    'process.stdin.resume();',
    "process.stdout.write('ready\\n');",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const { supervisor, pgid, state } = spawnSupervisor(
    t,
    harness,
    [process.execPath, stubborn],
  );

  let seen = '';
  supervisor.stdout.on('data', (chunk) => { seen += chunk.toString(); });
  await waitFor(() => seen.includes('ready'), 'stubborn child startup');

  supervisor.stdin.end();
  const exited = await settledWithin(
    new Promise((resolve) => supervisor.once('close', () => resolve('exited'))),
    5_000,
  );
  assert.equal(exited, 'exited', 'supervisor must terminate its own group');

  // Nothing may be left in the group the supervisor led. Members killed with
  // the leader linger as zombies until reaped, so this polls exactly as the
  // client's own proof does.
  await waitFor(
    () => {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    },
    'owned process group to drain',
  );
  state.groupProvenEmpty = true;
});

// Asks the supervisor to tear down the group it leads, the one safe way to do
// it, and reports loudly if it will not. Signalling the group here is what the
// whole design forbids, so a supervisor that ignores its shutdown request is a
// leak to be surfaced, never something to kill our way out of.
async function reapSupervisor(supervisor, state, timeoutMs = 2_000) {
  if (state.groupProvenEmpty) return;
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  supervisor.stdin.end();
  let timer;
  const outcome = await Promise.race([
    new Promise((resolve) => supervisor.once('close', () => resolve('closed'))),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === 'closed') return;
  // Drop our own handles so the runner is not held open by the process we are
  // about to report.
  supervisor.stdout?.destroy();
  supervisor.stderr?.destroy();
  supervisor.stdin?.destroy();
  supervisor.unref?.();
  throw new Error(
    `leaked supervisor pid ${supervisor.pid}: it did not terminate its own `
    + `process group within ${timeoutMs}ms`,
  );
}

function spawnSupervisor(t, harness, childArgs) {
  const supervisor = spawn(
    process.execPath,
    [SUPERVISOR, '--group-term-grace-ms=100', ...childArgs],
    { cwd: harness.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  );
  const pgid = supervisor.pid;
  const state = { groupProvenEmpty: false };
  t.after(() => reapSupervisor(supervisor, state));
  return { supervisor, pgid, state };
}

test('supervisor teardown surfaces one that will not terminate its group', async () => {
  const stuck = fakeSupervisorChild(4_242);
  await assert.rejects(
    reapSupervisor(stuck, { groupProvenEmpty: false }, 50),
    /leaked supervisor pid 4242/,
  );
  assert.equal(stuck.stdin.destroyed, true, 'handles must be released');
});

test('supervisor teardown asks a live supervisor to shut itself down', async () => {
  const willing = fakeSupervisorChild(4_243);
  willing.stdin.once('finish', () => willing.exit(0, null));
  await reapSupervisor(willing, { groupProvenEmpty: false }, 1_000);
  assert.equal(willing.stdin.writableEnded, true);
});

test('supervisor teardown leaves a proven-empty group untouched', async () => {
  const done = fakeSupervisorChild(4_244);
  await reapSupervisor(done, { groupProvenEmpty: true }, 50);
  assert.equal(done.stdin.writableEnded, false);
});

function settledWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

test('supervisor exits on parent EOF after its child has already gone', async (t) => {
  const harness = createHarness(t);
  const quick = path.join(harness.cwd, 'quick-exit-child.mjs');
  writeFileSync(quick, "process.stdout.write('bye\\n');\nprocess.exit(0);\n");
  const { supervisor, pgid, state } = spawnSupervisor(
    t,
    harness,
    [process.execPath, quick],
  );

  // The child's exit reaches us as stdout EOF. This is the ordering that leaves
  // a piped stdin unpiped and paused, losing the EOF that follows.
  supervisor.stdout.resume();
  const sawEof = await settledWithin(
    new Promise((resolve) => supervisor.stdout.once('end', () => resolve('eof'))),
    5_000,
  );
  assert.equal(sawEof, 'eof');
  assert.equal(supervisor.exitCode, null, 'supervisor must outlive its child');

  supervisor.stdin.end();
  const exited = await settledWithin(
    new Promise((resolve) => supervisor.once('close', () => resolve('exited'))),
    5_000,
  );
  assert.equal(exited, 'exited', 'parent EOF must still reach the supervisor');

  await waitFor(
    () => {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    },
    'owned process group to drain',
  );
  state.groupProvenEmpty = true;
});

test('supervisor forwards parent stdin to its child exactly once', async (t) => {
  const harness = createHarness(t);
  const echo = path.join(harness.cwd, 'echo-child.mjs');
  writeFileSync(echo, [
    "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
    'process.stdin.resume();',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  const { supervisor } = spawnSupervisor(t, harness, [process.execPath, echo]);

  let seen = '';
  supervisor.stdout.on('data', (chunk) => { seen += chunk.toString(); });
  supervisor.stdin.write('ping\n');
  await waitFor(() => seen.includes('ping'), 'echoed stdin');
  // Let any duplicate arrive before counting.
  await new Promise((resolve) => setTimeout(resolve, 150));

  // A second forwarder alongside the pipe would deliver — and echo — twice.
  assert.equal(seen.split('ping').length - 1, 1, `forwarded more than once: ${seen}`);
});

test('supervisor reports its child gone when the child never starts', async (t) => {
  const harness = createHarness(t);
  const missing = path.join(harness.cwd, 'does-not-exist');
  const { supervisor } = spawnSupervisor(t, harness, [missing, 'app-server']);

  // A failed spawn still emits 'close', so dropping the generic 'error' report
  // must not cost the parent its EOF.
  supervisor.stdout.resume();
  const closed = await settledWithin(
    new Promise((resolve) => supervisor.stdout.on('end', () => resolve('eof'))),
    4_000,
  );

  assert.equal(closed, 'eof');
});

test('cleanup never shells out to a process table query', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../lib/codex/app-server-client.js'),
    'utf8',
  );
  assert.equal(source.includes('/bin/ps'), false);
  assert.equal(/\bp(?:s|grep)\b\s*['"]/.test(source), false);
  assert.equal(source.includes('pgrep'), false);
});

test('close timer budgets must stay inside the platform timer range', async (t) => {
  const harness = createHarness(t);
  // Past the range a delay collapses to ~1ms, so a long close budget would
  // silently become no budget rather than a long wait.
  assert.throws(
    () => harness.makeClient({ closeGraceMs: MAX_TIMER_DELAY_MS + 1 }),
    /closeGraceMs must not exceed/,
  );
  assert.throws(
    () => harness.makeClient({ closeKillMs: MAX_TIMER_DELAY_MS + 1 }),
    /closeKillMs must not exceed/,
  );
  // close waits out grace and kill in a single timer, so the sum matters even
  // when each half is individually legal.
  assert.throws(
    () => harness.makeClient({
      closeGraceMs: MAX_TIMER_DELAY_MS,
      closeKillMs: 1,
    }),
    /closeGraceMs \+ closeKillMs must not exceed/,
  );
  assert.doesNotThrow(() => harness.makeClient({
    closeGraceMs: MAX_TIMER_DELAY_MS - 1,
    closeKillMs: 1,
  }));
  // Byte and count limits are not delays and keep their existing range.
  assert.doesNotThrow(
    () => harness.makeClient({ maxQueuedBytes: MAX_TIMER_DELAY_MS + 1 }),
  );
});

// --- manifest-bound hook verifier -------------------------------------------
// The verifier is the only path to `hooks/list`. Its whole contract is that a
// peer response either matches the frozen manifest exactly and yields four
// closed fields per descriptor, or yields nothing at all.

const HOOK_SOURCE_PATH = '/pinned/hooks.json';
const HOOK_EVENTS = ['sessionStart', 'userPromptSubmit', 'stop'];
const MAX_MANIFEST_ENTRIES = 16;
const HOOK_EVENT_SNAKE = {
  sessionStart: 'session_start',
  userPromptSubmit: 'user_prompt_submit',
  stop: 'stop',
  // Pinned, but deliberately absent from this manifest: it gives the mutation
  // cases a well-formed key and event that collide with nothing.
  sessionEnd: 'session_end',
};

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function hookCommand(event) {
  return `/pinned/runtime /pinned/recorder.js ${event} /pinned/capture`;
}

function hookConfigKey(event, index = 0, sub = 0) {
  return `${HOOK_SOURCE_PATH}:${HOOK_EVENT_SNAKE[event]}:${index}:${sub}`;
}

function hookDescriptor(event, ordinal) {
  return {
    ordinal,
    configKey: hookConfigKey(event),
    sourcePath: HOOK_SOURCE_PATH,
    event,
    handlerType: 'command',
    source: 'user',
    isManaged: false,
    displayOrder: ordinal,
    timeoutSec: 600,
    commandSha256: sha256Hex(hookCommand(event)),
  };
}

function hookManifest(ownedCwd, overrides = {}) {
  return {
    ownedCwd,
    entries: HOOK_EVENTS.map(hookDescriptor),
    ...overrides,
  };
}

function hookMetadata(event, ordinal, trustStatus) {
  return {
    currentHash: `sha256:${sha256Hex(`hash:${event}`)}`,
    displayOrder: ordinal,
    enabled: true,
    eventName: event,
    handlerType: 'command',
    isManaged: false,
    key: hookConfigKey(event),
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

function hooksListResult(trustStatus = 'trusted', mutate) {
  const hooks = HOOK_EVENTS.map(
    (event, index) => hookMetadata(event, index, trustStatus),
  );
  const entry = {
    cwd: '__OWNED_CWD__',
    errors: [],
    warnings: [],
    hooks,
  };
  const result = { data: [entry] };
  if (mutate) mutate(hooks, entry, result);
  return result;
}

function hooksScenario(result) {
  return { methods: { 'hooks/list': { result } } };
}

function expectedVerification(trustStatus = 'trusted') {
  return HOOK_EVENTS.map((event, ordinal) => ({
    ordinal,
    currentHash: `sha256:${sha256Hex(`hash:${event}`)}`,
    trustStatus,
    enabled: true,
  }));
}

function collectStrings(value, into = [], seen = new Set()) {
  if (typeof value === 'string') {
    into.push(value);
    return into;
  }
  if (value instanceof Error) {
    into.push(String(value.message), String(value.stack));
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'message' || key === 'stack') continue;
      collectStrings(value[key], into, seen);
    }
    return into;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return into;
  seen.add(value);
  for (const child of Object.values(value)) collectStrings(child, into, seen);
  return into;
}

async function verifierHarness(t, scenario) {
  const harness = createHarness(t, scenario);
  const emitted = [];
  const faults = [];
  const client = harness.makeClient({
    hookManifest: hookManifest(harness.cwd),
    onFault: async (outcome) => { faults.push(outcome); },
  });
  const originalEmit = client.emit.bind(client);
  client.emit = (event, ...args) => {
    emitted.push({ event, args });
    return originalEmit(event, ...args);
  };
  await client.start();
  return { harness, client, emitted, faults };
}

test('the hook verifier projects a matching inventory to closed ordinal trust', async (t) => {
  const { harness, client } = await verifierHarness(
    t,
    hooksScenario(hooksListResult('trusted')),
  );

  const verified = await client.verifyHooks({ phase: 'trusted' });

  assert.deepEqual(verified, expectedVerification('trusted'));
  assert.equal(Object.isFrozen(verified), true);
  for (const entry of verified) {
    assert.equal(Object.isFrozen(entry), true);
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['currentHash', 'enabled', 'ordinal', 'trustStatus'],
    );
  }
  assert.deepEqual(
    verified.map((entry) => entry.ordinal),
    [0, 1, 2],
  );
  const dispatched = harness.requests()
    .filter((message) => message.method === 'hooks/list');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].params, { cwds: [harness.cwd] });
});

test('the discovery phase accepts the observed enabled-and-untrusted state', async (t) => {
  const { client } = await verifierHarness(
    t,
    hooksScenario(hooksListResult('untrusted')),
  );

  assert.deepEqual(
    await client.verifyHooks({ phase: 'discovery' }),
    expectedVerification('untrusted'),
  );
});

test('hooks/list stays refused on the public request surface', async (t) => {
  const { harness, client } = await verifierHarness(
    t,
    hooksScenario(hooksListResult('trusted')),
  );
  await waitForInitializedLog(harness);
  const before = harness.requests().length;

  await rejectedWithCode(
    client.request('hooks/list', { cwds: [harness.cwd] }, { timeoutMs: 500 }),
    'CODEX_RPC_REJECTED',
  );
  await rejectedWithCode(
    client.request('hooks/list', {}, { timeoutMs: 500 }),
    'CODEX_RPC_REJECTED',
  );

  assert.equal(harness.requests().length, before);
  assert.doesNotThrow(() => client.assertHealthy());
  assert.equal(protocolSchema.clientRequests['hooks/list'].internal, true);
  assert.deepEqual(
    protocolSchema.clientRequests['hooks/list'].required,
    ['cwds'],
  );
  assert.deepEqual(protocolSchema.clientRequests['hooks/list'].optional, []);
  assert.equal(
    protocolSchema.clientRequests['hooks/list'].stateChanging,
    false,
  );
});

test('a manifest cwd outside the owned workspace is rejected before the wire', async (t) => {
  const harness = createHarness(t, hooksScenario(hooksListResult('trusted')));
  const client = harness.makeClient({
    hookManifest: hookManifest(harness.cwd, {
      ownedCwd: path.join(path.dirname(harness.cwd), 'foreign-workspace'),
    }),
  });
  await client.start();
  await waitForInitializedLog(harness);
  const before = harness.requests().length;

  await rejectedWithCode(
    client.verifyHooks({ phase: 'trusted' }),
    'CODEX_RPC_REJECTED',
  );

  assert.equal(harness.requests().length, before);
});

test('the frozen manifest cannot be replaced, narrowed, or supplied per call', async (t) => {
  const harness = createHarness(t, hooksScenario(hooksListResult('trusted')));
  const source = hookManifest(harness.cwd);
  const client = harness.makeClient({ hookManifest: source });
  await client.start();

  source.entries.pop();
  source.ownedCwd = '/elsewhere';
  assert.throws(() => {
    client.hookManifest = hookManifest(harness.cwd, { entries: [] });
  }, TypeError);
  assert.equal(Object.isFrozen(client.hookManifest), true);
  assert.equal(Object.isFrozen(client.hookManifest.entries), true);
  assert.equal(Object.isFrozen(client.hookManifest.entries[0]), true);

  await rejectedWithCode(
    client.verifyHooks({
      phase: 'trusted',
      hookManifest: hookManifest(harness.cwd, { entries: [] }),
    }),
    'CODEX_HOOK_TRUST_UNVERIFIED',
  );
  await rejectedWithCode(
    client.verifyHooks({ phase: 'nonsense' }),
    'CODEX_HOOK_TRUST_UNVERIFIED',
  );
  assert.deepEqual(
    await client.verifyHooks({ phase: 'trusted' }),
    expectedVerification('trusted'),
  );
});

test('a client without a manifest cannot verify hooks at all', async (t) => {
  const harness = createHarness(t, hooksScenario(hooksListResult('trusted')));
  const client = harness.makeClient();
  await client.start();
  await waitForInitializedLog(harness);
  const before = harness.requests().length;

  assert.equal(client.hookManifest, null);
  await rejectedWithCode(
    client.verifyHooks({ phase: 'trusted' }),
    'CODEX_HOOK_TRUST_UNVERIFIED',
  );
  assert.equal(harness.requests().length, before);
});

test('hook verification is refused before the client is ready', async (t) => {
  const harness = createHarness(t, hooksScenario(hooksListResult('trusted')));
  const client = harness.makeClient({
    hookManifest: hookManifest(harness.cwd),
  });

  await rejectedWithCode(
    client.verifyHooks({ phase: 'trusted' }),
    'CODEX_CLIENT_STATE',
  );
});

test('no hook peer text crosses into the return value, errors, events, or faults', async (t) => {
  const sentinel = 'MUST_NOT_CROSS_HOOK_TEXT';
  const { client, emitted, faults } = await verifierHarness(
    t,
    hooksScenario(hooksListResult('trusted', (hooks, entry) => {
      hooks[0].key = `${sentinel}_KEY`;
      hooks[0].sourcePath = `${sentinel}_SOURCE_PATH`;
      hooks[0].command = `${sentinel}_COMMAND`;
      hooks[0].statusMessage = `${sentinel}_STATUS`;
      hooks[0].matcher = `${sentinel}_MATCHER`;
      hooks[0].pluginId = `${sentinel}_PLUGIN`;
      hooks[0].additionalContextLimit = 4096;
      entry.cwd = `${sentinel}_CWD`;
      entry.errors = [`${sentinel}_ERROR`];
      entry.warnings = [`${sentinel}_WARNING`];
    })),
  );

  const error = await rejectedWithCode(
    client.verifyHooks({ phase: 'trusted' }),
    'CODEX_HOOK_TRUST_UNVERIFIED',
  );

  // An inventory that cannot be trusted ends the client rather than leaving a
  // session that could still dispatch a turn.
  assert.throws(() => client.assertHealthy(), (thrown) => (
    thrown.code === 'CODEX_HOOK_TRUST_UNVERIFIED'
  ));
  const outcome = await client.waitForFault();
  assert.equal(outcome.errorCode, 'CODEX_HOOK_TRUST_UNVERIFIED');
  assert.deepEqual(faults, [outcome]);

  const observed = [
    ...collectStrings(error),
    ...collectStrings(emitted),
    ...collectStrings(faults),
  ];
  assert.ok(observed.length > 0);
  for (const text of observed) {
    assert.equal(
      text.includes(sentinel),
      false,
      `hook peer text leaked: ${text}`,
    );
  }
});

test('phase rules reject every wrong-phase trust status and disabled hook', async (t) => {
  const cases = [
    ['trusted entry during discovery', 'discovery', (hooks) => {
      hooks[1].trustStatus = 'trusted';
    }],
    ['untrusted entry during trusted', 'trusted', (hooks) => {
      hooks[2].trustStatus = 'untrusted';
    }],
    ['modified entry during trusted', 'trusted', (hooks) => {
      hooks[0].trustStatus = 'modified';
    }],
    ['managed entry during trusted', 'trusted', (hooks) => {
      hooks[0].trustStatus = 'managed';
    }],
    ['managed entry during discovery', 'discovery', (hooks) => {
      hooks[0].trustStatus = 'managed';
    }],
    ['disabled hook during trusted', 'trusted', (hooks) => {
      hooks[1].enabled = false;
    }],
    ['disabled hook during discovery', 'discovery', (hooks) => {
      hooks[1].enabled = false;
    }],
    ['unknown trust status', 'trusted', (hooks) => {
      hooks[0].trustStatus = 'partiallyTrusted';
    }],
  ];

  for (const [name, phase, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const base = phase === 'discovery' ? 'untrusted' : 'trusted';
      const { client } = await verifierHarness(
        subtest,
        hooksScenario(hooksListResult(base, mutate)),
      );
      await rejectedWithCode(
        client.verifyHooks({ phase }),
        'CODEX_HOOK_TRUST_UNVERIFIED',
      );
    });
  }
});

test('the pinned optional shape is the only accepted one', async (t) => {
  const cases = [
    ['command missing', (hooks) => { delete hooks[0].command; }],
    ['command null', (hooks) => { hooks[0].command = null; }],
    ['command digest mismatch', (hooks) => {
      hooks[0].command = `${hookCommand(HOOK_EVENTS[0])} --extra`;
    }],
    ['additionalContextLimit missing', (hooks) => {
      delete hooks[1].additionalContextLimit;
    }],
    ['additionalContextLimit non-null', (hooks) => {
      hooks[1].additionalContextLimit = 0;
    }],
    ['matcher missing', (hooks) => { delete hooks[1].matcher; }],
    ['matcher non-null', (hooks) => { hooks[1].matcher = '*'; }],
    ['pluginId missing', (hooks) => { delete hooks[2].pluginId; }],
    ['pluginId non-null', (hooks) => { hooks[2].pluginId = 'plugin'; }],
    ['statusMessage missing', (hooks) => { delete hooks[2].statusMessage; }],
    ['statusMessage non-null', (hooks) => { hooks[2].statusMessage = 'ok'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const { client } = await verifierHarness(
        subtest,
        hooksScenario(hooksListResult('trusted', mutate)),
      );
      await rejectedWithCode(
        client.verifyHooks({ phase: 'trusted' }),
        'CODEX_HOOK_TRUST_UNVERIFIED',
      );
    });
  }
});

test('whole-inventory exactness refuses every manifest deviation', async (t) => {
  const cases = [
    ['extra hook', (hooks) => {
      hooks.push(hookMetadata('stop', 3, 'trusted'));
    }],
    ['missing hook', (hooks) => { hooks.pop(); }],
    ['single-entry inventory', (hooks) => { hooks.splice(1); }],
    ['empty inventory', (hooks) => { hooks.splice(0); }],
    ['duplicate key', (hooks) => {
      hooks[2].key = hooks[1].key;
      hooks[2].eventName = hooks[1].eventName;
    }],
    ['reordered inventory', (hooks) => {
      const [first, ...rest] = hooks.splice(0);
      hooks.push(...rest, first);
    }],
    ['nonzero key index', (hooks) => {
      hooks[0].key = hookConfigKey(HOOK_EVENTS[0], 1, 0);
    }],
    ['nonzero key sub-index', (hooks) => {
      hooks[0].key = hookConfigKey(HOOK_EVENTS[0], 0, 1);
    }],
    ['foreign source path', (hooks) => {
      hooks[1].sourcePath = '/foreign/hooks.json';
    }],
    ['handlerType mismatch', (hooks) => { hooks[0].handlerType = 'prompt'; }],
    ['source mismatch', (hooks) => { hooks[0].source = 'project'; }],
    ['isManaged mismatch', (hooks) => { hooks[0].isManaged = true; }],
    ['wrong displayOrder', (hooks) => { hooks[1].displayOrder = 7; }],
    ['wrong timeoutSec', (hooks) => { hooks[1].timeoutSec = 60; }],
    ['unknown field', (hooks) => { hooks[2].experimental = true; }],
    ['malformed currentHash', (hooks) => {
      hooks[2].currentHash = 'not-a-digest';
    }],
    ['uppercase currentHash', (hooks) => {
      hooks[2].currentHash = `sha256:${'A'.repeat(64)}`;
    }],
    ['missing required field', (hooks) => { delete hooks[0].timeoutSec; }],
    // Each of these moves exactly one field and leaves every other field of
    // every entry exactly right, so a peer that matches on everything else
    // cannot hide a comparison that was dropped.
    // A pinned event the manifest does not carry: neither the closed enum nor
    // per-event uniqueness can catch this, only the comparison against the
    // descriptor's own event.
    ['eventName swapped for an unmanifested pinned event', (hooks) => {
      hooks[0].eventName = 'sessionEnd';
    }],
    ['eventName outside the pinned set', (hooks) => {
      hooks[0].eventName = 'sessionRestart';
    }],
    // A well-formed key for an event the manifest does not carry: no other
    // entry collides with it, so only the comparison against the descriptor's
    // own key can refuse it.
    ['key swapped for an unmanifested well-formed key', (hooks) => {
      hooks[0].key = hookConfigKey('sessionEnd');
    }],
    ['sourcePath swapped for a sibling path', (hooks) => {
      hooks[1].sourcePath = `${HOOK_SOURCE_PATH}.bak`;
    }],
    ['enabled as a string', (hooks) => { hooks[1].enabled = 'true'; }],
    ['isManaged as a string', (hooks) => { hooks[1].isManaged = 'false'; }],
    ['timeoutSec as a string', (hooks) => { hooks[1].timeoutSec = '600'; }],
    ['displayOrder as a string', (hooks) => { hooks[2].displayOrder = '2'; }],
    ['currentHash without its algorithm prefix', (hooks) => {
      hooks[2].currentHash = sha256Hex('hash:stop');
    }],
    ['command as a number', (hooks) => { hooks[2].command = 600; }],
    ['trustStatus as a boolean', (hooks) => { hooks[0].trustStatus = true; }],
    ['non-empty errors', (_hooks, entry) => { entry.errors = ['boom']; }],
    ['non-empty warnings', (_hooks, entry) => { entry.warnings = ['careful']; }],
    ['foreign cwd', (_hooks, entry) => { entry.cwd = '/foreign/workspace'; }],
    ['unknown entry field', (_hooks, entry) => { entry.extra = 1; }],
    ['duplicated cwd entry', (_hooks, entry, result) => {
      result.data.push({ ...entry });
    }],
    ['unknown result field', (_hooks, _entry, result) => {
      result.nextCursor = null;
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const { client } = await verifierHarness(
        subtest,
        hooksScenario(hooksListResult('trusted', mutate)),
      );
      await rejectedWithCode(
        client.verifyHooks({ phase: 'trusted' }),
        'CODEX_HOOK_TRUST_UNVERIFIED',
      );
    });
  }
});

test('a session without a manifest issues no hook verification traffic', async (t) => {
  const harness = createHarness(t);
  const client = harness.makeClient();
  await client.start();
  await client.request('config/read', {
    cwd: harness.cwd,
    includeLayers: true,
  }, { timeoutMs: 500 });
  await waitForInitializedLog(harness);

  assert.deepEqual(
    harness.requests()
      .filter((message) => Object.hasOwn(message, 'id'))
      .map((message) => message.method),
    ['initialize', 'config/read'],
  );
});

test('manifest descriptors are rejected unless displayOrder is the ordinal', async (t) => {
  const harness = createHarness(t, hooksScenario(hooksListResult('trusted')));
  const misordered = hookManifest(harness.cwd);
  misordered.entries[0] = { ...misordered.entries[0], displayOrder: 9 };

  assert.throws(
    () => harness.makeClient({ hookManifest: misordered }),
    TypeError,
  );

  const sparse = hookManifest(harness.cwd);
  sparse.entries[2] = { ...sparse.entries[2], ordinal: 3 };
  assert.throws(
    () => harness.makeClient({ hookManifest: sparse }),
    TypeError,
  );

  const displaced = hookManifest(harness.cwd);
  displaced.entries[1] = { ...displaced.entries[1], displayOrder: 2 };
  displaced.entries[2] = { ...displaced.entries[2], displayOrder: 1 };
  assert.throws(
    () => harness.makeClient({ hookManifest: displaced }),
    TypeError,
  );

  assert.doesNotThrow(
    () => harness.makeClient({ hookManifest: hookManifest(harness.cwd) }),
  );
});

// The boundary these two tests assert: `hooks/list` is absent from the
// supported public request() surface, and no raw hook metadata reaches a
// verifier return, a thrown error, an emitted event or a fault outcome.
// Underscore-prefixed transport internals and the child's own streams are
// same-process internals; they are not a boundary against a caller that
// already holds the client object.
test('every manifest constraint is enforced one field at a time', async (t) => {
  const harness = createHarness(t, hooksScenario(hooksListResult('trusted')));
  // A caller-supplied manifest is refused at construction, before any peer is
  // consulted, so a wrong expectation can never become the thing a response is
  // measured against.
  const cases = [
    ['ownedCwd relative', (manifest) => { manifest.ownedCwd = 'workspace'; }],
    ['ownedCwd not a string', (manifest) => { manifest.ownedCwd = 1; }],
    ['entries empty', (manifest) => { manifest.entries = []; }],
    ['entries not an array', (manifest) => { manifest.entries = {}; }],
    ['entries past the bound', (manifest) => {
      manifest.entries = Array.from(
        { length: MAX_MANIFEST_ENTRIES + 1 },
        () => hookDescriptor(HOOK_EVENTS[0], 0),
      );
    }],
    ['manifest missing a key', (manifest) => { delete manifest.ownedCwd; }],
    ['manifest carrying an extra key', (manifest) => { manifest.phase = 'trusted'; }],
    ['ordinal not the index', (manifest) => {
      manifest.entries[1] = { ...manifest.entries[1], ordinal: 0 };
    }],
    ['displayOrder not the ordinal', (manifest) => {
      manifest.entries[1] = { ...manifest.entries[1], displayOrder: 0 };
    }],
    ['configKey not derived from its own event', (manifest) => {
      manifest.entries[0] = {
        ...manifest.entries[0],
        configKey: hookConfigKey('stop'),
      };
    }],
    ['configKey with a nonzero index', (manifest) => {
      manifest.entries[0] = {
        ...manifest.entries[0],
        configKey: hookConfigKey(HOOK_EVENTS[0], 1, 0),
      };
    }],
    ['event swapped for another pinned event', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], event: 'stop' };
    }],
    ['event outside the pinned set', (manifest) => {
      manifest.entries[0] = {
        ...manifest.entries[0],
        event: 'sessionRestart',
        configKey: `${HOOK_SOURCE_PATH}:session_restart:0:0`,
      };
    }],
    ['sourcePath relative', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], sourcePath: 'hooks.json' };
    }],
    ['handlerType not command', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], handlerType: 'prompt' };
    }],
    ['source not user', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], source: 'project' };
    }],
    ['isManaged true', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], isManaged: true };
    }],
    ['timeoutSec zero', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], timeoutSec: 0 };
    }],
    ['timeoutSec fractional', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], timeoutSec: 600.5 };
    }],
    ['timeoutSec as a string', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], timeoutSec: '600' };
    }],
    ['commandSha256 uppercase', (manifest) => {
      manifest.entries[0] = {
        ...manifest.entries[0],
        commandSha256: 'A'.repeat(64),
      };
    }],
    ['commandSha256 truncated', (manifest) => {
      manifest.entries[0] = {
        ...manifest.entries[0],
        commandSha256: 'a'.repeat(63),
      };
    }],
    ['descriptor missing a key', (manifest) => {
      const { timeoutSec, ...rest } = manifest.entries[0];
      manifest.entries[0] = rest;
    }],
    ['descriptor carrying an extra key', (manifest) => {
      manifest.entries[0] = { ...manifest.entries[0], matcher: null };
    }],
    ['a repeated hook event', (manifest) => {
      manifest.entries[2] = {
        ...manifest.entries[0],
        ordinal: 2,
        displayOrder: 2,
      };
    }],
  ];

  for (const [name, mutate] of cases) {
    const manifest = hookManifest(harness.cwd);
    mutate(manifest);
    assert.throws(
      () => harness.makeClient({ hookManifest: manifest }),
      TypeError,
      name,
    );
  }

  // The same builder, unmutated, is accepted — so the table above is rejecting
  // its mutations, not a manifest that was never constructible.
  assert.doesNotThrow(
    () => harness.makeClient({ hookManifest: hookManifest(harness.cwd) }),
  );
});

test('no supported public request surface path can dispatch hooks/list or read raw metadata', async (t) => {
  const sentinel = 'MUST_NOT_CROSS_RAW_INVENTORY';
  const { harness, client } = await verifierHarness(
    t,
    hooksScenario(hooksListResult('trusted', (hooks, entry) => {
      hooks[0].command = `${sentinel}_COMMAND`;
      hooks[0].key = `${sentinel}_KEY`;
      entry.cwd = `${sentinel}_CWD`;
    })),
  );
  await waitForInitializedLog(harness);
  const before = harness.requests().length;

  // The raw dispatcher is not a method, so no options bag handed to the
  // supported surface can carry an internal flag or a projector into it.
  assert.equal(client._request, undefined);
  for (
    let proto = Object.getPrototypeOf(client);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    assert.equal(
      Object.getOwnPropertyNames(proto).includes('_request'),
      false,
    );
  }

  const attempts = [
    () => client.request('hooks/list', { cwds: [harness.cwd] }, {
      timeoutMs: 500,
      internal: true,
      projectResult: (raw) => raw,
    }),
    () => client.request('hooks/list', { cwds: [harness.cwd] }, {
      timeoutMs: 500,
      internal: true,
    }),
    () => client.request('hooks/list', { cwds: [harness.cwd] }, {
      timeoutMs: 500,
      projectResult: (raw) => raw,
    }),
  ];
  const observed = [];
  for (const attempt of attempts) {
    const error = await rejectedWithCode(attempt(), 'CODEX_RPC_REJECTED');
    observed.push(...collectStrings(error));
  }

  assert.equal(harness.requests().length, before);
  assert.doesNotThrow(() => client.assertHealthy());
  for (const text of observed) {
    assert.equal(text.includes(sentinel), false, `raw metadata leaked: ${text}`);
  }

  // The one supported path still refuses this inventory, and refuses it
  // without echoing a byte of it.
  const refusal = await rejectedWithCode(
    client.verifyHooks({ phase: 'trusted' }),
    'CODEX_HOOK_TRUST_UNVERIFIED',
  );
  for (const text of collectStrings(refusal)) {
    assert.equal(text.includes(sentinel), false, `raw metadata leaked: ${text}`);
  }
});

test('an in-flight hook verification carries no projector on its pending record', async (t) => {
  const harness = createHarness(t, {
    methods: { 'hooks/list': { hold: true } },
  });
  const client = harness.makeClient({
    hookManifest: hookManifest(harness.cwd),
    requestTimeoutMs: 500,
  });
  await client.start();

  const verification = client.verifyHooks({ phase: 'trusted' }).then(
    () => null,
    (error) => error,
  );
  await waitFor(() => client.pending.size === 1, 'hooks/list in flight');

  const [record] = [...client.pending.values()];
  assert.equal(record.method, 'hooks/list');
  // The projector lives in module-private state keyed by this record, so a
  // record forged into the pending map has no projector to borrow.
  assert.equal(Object.hasOwn(record, 'projectResult'), false);
  assert.equal(
    Object.values(record).some((value) => typeof value === 'function'
      && value.name.includes('project')),
    false,
  );

  const error = await verification;
  assert.equal(error.code, 'CODEX_RPC_TIMEOUT');
});
