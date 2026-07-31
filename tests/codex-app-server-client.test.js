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
  const harness = createHarness(t, {
    methods: {
      'config/read': {
        beforeResponseMessages: [{
          method: 'thread/experimental/unknown',
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
  assert.deepEqual(signals.map(({ signal }) => signal), [0]);
  assert.deepEqual(signals.map(({ pid }) => pid), [-supervisorPid]);
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
