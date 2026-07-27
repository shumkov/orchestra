'use strict';

const assert = require('node:assert/strict');
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
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { homedir, tmpdir } = require('node:os');
const path = require('node:path');

const spikeUrl = pathToFileURL(
  path.resolve(__dirname, '../scripts/spikes/codex-app-server-real.mjs'),
);
const u1bSpikeUrl = pathToFileURL(
  path.resolve(__dirname, '../scripts/spikes/codex-app-server-u1b.mjs'),
);
const u1bResourceSpikeUrl = pathToFileURL(
  path.resolve(__dirname, '../scripts/spikes/codex-app-server-resources.mjs'),
);
const u1bEffectsSpikeUrl = pathToFileURL(
  path.resolve(__dirname, '../scripts/spikes/codex-app-server-effects-retries.mjs'),
);

function transportCutParams(method) {
  if (method === 'turn/start') {
    return {
      threadId: 'thread-transport-cut',
      input: [{ type: 'text', text: 'TRANSPORT_CUT_START' }],
      clientUserMessageId: 'client-start-transport-cut',
    };
  }
  if (method === 'turn/steer') {
    return {
      threadId: 'thread-transport-cut',
      expectedTurnId: 'turn-transport-cut',
      input: [{ type: 'text', text: 'TRANSPORT_CUT_STEER' }],
      clientUserMessageId: 'client-steer-transport-cut',
    };
  }
  if (method === 'turn/interrupt') {
    return {
      threadId: 'thread-transport-cut',
      turnId: 'turn-transport-cut',
    };
  }
  if (method === 'thread/backgroundTerminals/clean') {
    return { threadId: 'thread-transport-cut' };
  }
  if (method === 'command/exec') {
    return {
      cwd: process.cwd(),
      command: ['/usr/bin/true'],
      outputBytesCap: 1_000,
      timeoutMs: 1_000,
    };
  }
  if (method === 'thread/start') {
    return { cwd: process.cwd() };
  }
  if (method === 'thread/resume') {
    return { threadId: 'thread-transport-cut' };
  }
  throw new Error(`missing transport-cut parameters for ${method}`);
}

const stateChangingTransportMethods = [
  'command/exec',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/backgroundTerminals/clean',
];

function createTransportCutFixture(
  t,
  { exitAfterLine, responseAfterLine = null },
) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-transport-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, 'line-observation.json');
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import { writeFileSync } from 'node:fs';",
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      'let lineCount = 0;',
      "lines.on('line', (line) => {",
      '  lineCount += 1;',
      '  const request = JSON.parse(line);',
      `  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      '    lineCount,',
      '    method: request.method,',
      "    hasClientUserMessageId: typeof request.params?.clientUserMessageId === 'string',",
      "    hasExpectedTurnId: typeof request.params?.expectedTurnId === 'string',",
      '  }));',
      ...(responseAfterLine === null
        ? []
        : [
          `  process.stdout.write(${JSON.stringify(`${responseAfterLine}\n`)});`,
        ]),
      ...(exitAfterLine ? ['  process.exit(0);'] : []),
      '});',
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );
  return { fakeServer, marker, scratch };
}

test('Codex U1a named profile clears the obsolete readOnlyAccess false-negative', async () => {
  const { evaluateNamedProfileGate } = await import(spikeUrl);
  const evidence = {
    schemaHashesVerified: true,
    stableProfileMethodsVerified: true,
    configSourceAttested: true,
    configUnchangedAtEnd: true,
    requirementsAttested: true,
    profileListed: true,
    commandWorkspaceRead: true,
    commandWorkspaceWrite: true,
    commandCodexHomeDenied: true,
    commandDaemonSecretsDenied: true,
    commandNetworkDenied: true,
    legacySandboxAbsent: true,
    accountAuthenticated: true,
    freshProfileProvenance: true,
    resumeProfileProvenance: true,
    resumableTurnCompleted: true,
    noUnexpectedServerRequests: true,
  };

  assert.deepEqual(evaluateNamedProfileGate(evidence), {
    gate: 'CONTINUE',
    exitCode: 0,
    failedChecks: [],
  });
});

test('Codex U1a profile name alone cannot clear the gate', async () => {
  const { evaluateNamedProfileGate } = await import(spikeUrl);
  const result = evaluateNamedProfileGate({
    schemaHashesVerified: true,
    stableProfileMethodsVerified: true,
    configSourceAttested: false,
    configUnchangedAtEnd: true,
    requirementsAttested: true,
    profileListed: true,
    commandWorkspaceRead: true,
    commandWorkspaceWrite: true,
    commandCodexHomeDenied: true,
    commandDaemonSecretsDenied: true,
    commandNetworkDenied: true,
    legacySandboxAbsent: true,
    accountAuthenticated: true,
    freshProfileProvenance: true,
    resumeProfileProvenance: true,
    resumableTurnCompleted: true,
    noUnexpectedServerRequests: true,
  });

  assert.equal(result.gate, 'STOP');
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.failedChecks, ['configSourceAttested']);
});

test('Codex U1a named profile stops if Codex rewrites config during runtime', async () => {
  const { evaluateNamedProfileGate } = await import(spikeUrl);
  const result = evaluateNamedProfileGate({
    schemaHashesVerified: true,
    stableProfileMethodsVerified: true,
    configSourceAttested: true,
    configUnchangedAtEnd: false,
    requirementsAttested: true,
    profileListed: true,
    commandWorkspaceRead: true,
    commandWorkspaceWrite: true,
    commandCodexHomeDenied: true,
    commandDaemonSecretsDenied: true,
    commandNetworkDenied: true,
    legacySandboxAbsent: true,
    accountAuthenticated: true,
    freshProfileProvenance: true,
    resumeProfileProvenance: true,
    resumableTurnCompleted: true,
    noUnexpectedServerRequests: true,
  });

  assert.deepEqual(result.failedChecks, ['configUnchangedAtEnd']);
});

test('Codex U1a overall result requires every integrated runtime gate', async () => {
  const { evaluateOverallU1aGate } = await import(spikeUrl);

  assert.deepEqual(evaluateOverallU1aGate(), {
    gate: 'STOP',
    exitCode: 2,
    blockingU1aFindings: [],
    remainingU1aGates: [
      'named profile and authenticated enforcement',
      'active-turn steering and definite stale rejection',
      'turn interruption and tracked-terminal cleanup',
      'same-user process, descriptor, Keychain, and local-socket isolation',
    ],
  });
});

function passingSameUserSideChannelEvidence() {
  return {
    processHostControl: true,
    processArgvInspectionExitCode: 0,
    debuggerHostControl: true,
    debuggerExitCode: 1,
    keychainHostControl: true,
    keychainExitCode: 0,
    tcpHostControl: true,
    tcpExitCode: 1,
    tcpCanaryReached: false,
    udpHostControl: true,
    udpCommandExitCode: 0,
    udpCanaryReached: false,
    dnsHostControl: true,
    dnsCommandExitCode: 9,
    dnsCanaryReached: false,
    unixSocketHostControl: true,
    unixSocketExitCode: 1,
    unixSocketCanaryReached: false,
    inheritedDescriptorHostControl: true,
    inheritedDescriptorExitCode: 0,
    processCanaryCleanup: true,
    keychainCleanup: true,
  };
}

test('Codex U1a same-user side-channel gate requires every positive control and denial', async () => {
  const {
    evaluateOverallU1aGate,
    evaluateSameUserSideChannelProbe,
  } = await import(spikeUrl);
  const gate = evaluateSameUserSideChannelProbe(
    passingSameUserSideChannelEvidence(),
  );

  assert.deepEqual(gate, {
    gate: 'CONTINUE',
    exitCode: 0,
    failedChecks: [],
  });
  assert.deepEqual(
    evaluateOverallU1aGate({
      namedProfileGate: { gate: 'CONTINUE' },
      steeringGate: { gate: 'CONTINUE' },
      trackedTerminalStopGate: { gate: 'CONTINUE' },
      sameUserSideChannelGate: gate,
    }),
    {
      gate: 'CONTINUE',
      exitCode: 0,
      blockingU1aFindings: [],
      remainingU1aGates: [],
    },
  );
});

test('Codex U1a same-user side-channel gate fails closed on recovery or cleanup drift', async () => {
  const { evaluateSameUserSideChannelProbe } = await import(spikeUrl);
  const evidence = {
    ...passingSameUserSideChannelEvidence(),
    processArgvInspectionExitCode: 41,
    debuggerExitCode: 0,
    keychainExitCode: 42,
    tcpExitCode: 0,
    tcpCanaryReached: true,
    udpCanaryReached: true,
    dnsCanaryReached: true,
    unixSocketExitCode: 0,
    unixSocketCanaryReached: true,
    inheritedDescriptorExitCode: 43,
    processCanaryCleanup: false,
    keychainCleanup: false,
  };

  assert.deepEqual(
    evaluateSameUserSideChannelProbe(evidence),
    {
      gate: 'STOP',
      exitCode: 2,
      failedChecks: [
        'processArgvDenied',
        'debuggerDenied',
        'keychainDenied',
        'tcpDenied',
        'udpDenied',
        'dnsProtocolDenied',
        'unixSocketDenied',
        'inheritedDescriptorDenied',
        'processCanaryCleanup',
        'keychainCleanup',
      ],
    },
  );
});

test('Codex U1a side-channel command builders expose hashes but not canary contents', async () => {
  const {
    buildInheritedDescriptorProbeCommand,
    buildProcessArgvInspectionCommand,
    buildUnixSocketProbeCommand,
    cleanupKeychainCanary,
    runHostSideChannelCommand,
    runHostSideChannelCommandAsync,
  } = await import(spikeUrl);
  const processHash = 'a'.repeat(64);
  const descriptorHash = 'b'.repeat(64);
  const processCommand = buildProcessArgvInspectionCommand(1234, processHash);
  const descriptorCommand = buildInheritedDescriptorProbeCommand(
    19,
    descriptorHash,
  );

  assert.deepEqual(processCommand.slice(0, 2), ['/bin/sh', '-c']);
  assert.deepEqual(processCommand.slice(-2), ['1234', processHash]);
  assert.match(processCommand[2], /exit 41/);
  assert.doesNotMatch(processCommand[2], /[ab]{64}/);

  assert.deepEqual(descriptorCommand.slice(0, 2), ['/bin/sh', '-c']);
  assert.deepEqual(descriptorCommand.slice(-2), ['19', descriptorHash]);
  assert.match(descriptorCommand[2], /exit 43/);
  assert.doesNotMatch(descriptorCommand[2], /[ab]{64}/);

  let executed;
  const hostResult = runHostSideChannelCommand(
    processCommand,
    (binary, args, options) => {
      executed = [binary, ...args];
      assert.deepEqual(options, {
        stdio: 'ignore',
        timeout: 5_000,
      });
      return { status: 41 };
    },
  );
  assert.deepEqual(executed, processCommand);
  assert.equal(hostResult.status, 41);

  const keychainCalls = [];
  const keychainCleanup = cleanupKeychainCanary(
    '/usr/bin/security',
    'test-keychain-id',
    (binary, args) => {
      keychainCalls.push([binary, ...args]);
      const isFind = args[0] === 'find-generic-password';
      return { status: isFind && keychainCalls.length === 4 ? 44 : 0 };
    },
  );
  assert.equal(keychainCleanup, true);
  assert.deepEqual(
    keychainCalls.map((command) => command[1]),
    [
      'delete-generic-password',
      'find-generic-password',
      'delete-generic-password',
      'find-generic-password',
    ],
  );

  const processSyntax = spawnSync(
    '/bin/sh',
    ['-n', '-c', processCommand[2]],
    { stdio: 'ignore' },
  );
  assert.equal(processSyntax.status, 0);

  assert.deepEqual(
    buildUnixSocketProbeCommand('/usr/bin/nc', '/private/test.sock'),
    [
      '/usr/bin/nc',
      '-z',
      '-U',
      '-w',
      '1',
      '/private/test.sock',
    ],
  );
  assert.throws(
    () => buildUnixSocketProbeCommand('/usr/bin/nc', `/${'x'.repeat(103)}`),
    /path exceeds the macOS limit/,
  );
  assert.deepEqual(
    await runHostSideChannelCommandAsync(['/usr/bin/true']),
    { status: 0 },
  );
});

test('Codex U1a process-canary cleanup force-terminates an uncooperative owned child', async () => {
  const { stopSingleProcessCanary } = await import(spikeUrl);
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );

  assert.equal(await stopSingleProcessCanary(child), true);
  assert.notEqual(child.signalCode, null);
});

test('Codex U1a initializes with the experimental API only for terminal cleanup', async (t) => {
  const { initializeConnection } = await import(spikeUrl);
  const codexHome = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-init-test-')),
  );
  t.after(() => rmSync(codexHome, { recursive: true, force: true }));
  const requests = [];
  const notifications = [];
  const connection = {
    async request(method, params) {
      requests.push({ method, params });
      return { codexHome };
    },
    notify(method, params = {}) {
      notifications.push({ method, params });
    },
  };

  await initializeConnection(connection, codexHome);

  assert.deepEqual(requests, [{
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'orchestra_codex_u1a',
        title: 'Orchestra Codex U1a',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  }]);
  assert.deepEqual(notifications, [{ method: 'initialized', params: {} }]);
});

test('Codex U1a classifies a deterministic pre-write cut as definitely not sent', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);

  for (const method of ['turn/start', 'turn/steer']) {
    await t.test(method, async (subtest) => {
      const { fakeServer, marker, scratch } = createTransportCutFixture(
        subtest,
        { exitAfterLine: false },
      );
      const connection = new AppServerConnection(
        {
          binary: fakeServer,
          launcher: process.execPath,
          workspace: scratch,
          beforeRequestWrite(observation) {
            assert.deepEqual(observation, { method });
            throw new Error('deterministic pre-write cut');
          },
        },
        { PATH: process.env.PATH ?? '' },
      );
      subtest.after(() => connection.close());

      await assert.rejects(
        connection.request(method, transportCutParams(method), 200),
        (error) => {
          assert.equal(error.code, 'CODEX_RPC_NOT_SENT');
          return true;
        },
      );
      await delay(30);
      assert.equal(existsSync(marker), false);
      assert.equal(connection.pending.size, 0);
      connection.assertProtocolHealthy();
    });
  }
});

test('Codex U1a classifies every written state-changing request with a lost response as outcome unknown', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);

  for (const method of stateChangingTransportMethods) {
    await t.test(method, async (subtest) => {
      const { fakeServer, marker, scratch } = createTransportCutFixture(
        subtest,
        { exitAfterLine: true },
      );
      const connection = new AppServerConnection(
        {
          binary: fakeServer,
          launcher: process.execPath,
          workspace: scratch,
        },
        { PATH: process.env.PATH ?? '' },
      );
      subtest.after(() => connection.close());

      await assert.rejects(
        connection.request(method, transportCutParams(method), 5_000),
        (error) => {
          assert.equal(error.code, 'CODEX_RPC_OUTCOME_UNKNOWN');
          return true;
        },
      );
      assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
        lineCount: 1,
        method,
        hasClientUserMessageId: ['turn/start', 'turn/steer'].includes(method),
        hasExpectedTurnId: method === 'turn/steer',
      });
      assert.throws(
        () => connection.assertProtocolHealthy(),
        (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
      );
      await assert.rejects(
        connection.request(method, transportCutParams(method), 200),
        (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
      );
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).lineCount, 1);
    });
  }
});

test('Codex U1a classifies malformed state-changing responses as outcome unknown', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);

  for (const malformed of [
    JSON.stringify({ id: 1 }),
    JSON.stringify({ id: 1, result: {}, error: { code: -1 } }),
  ]) {
    await t.test(malformed, async (subtest) => {
      const method = 'turn/interrupt';
      const lateResponse = JSON.stringify({ id: 1, result: {} });
      const { fakeServer, marker, scratch } = createTransportCutFixture(
        subtest,
        {
          exitAfterLine: false,
          responseAfterLine: `${malformed}\n${lateResponse}`,
        },
      );
      const connection = new AppServerConnection(
        {
          binary: fakeServer,
          launcher: process.execPath,
          workspace: scratch,
        },
        { PATH: process.env.PATH ?? '' },
      );
      subtest.after(() => connection.close());

      await assert.rejects(
        connection.request(method, transportCutParams(method), 1_000),
        (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
      );
      assert.throws(
        () => connection.assertProtocolHealthy(),
        (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
      );
      await assert.rejects(
        connection.request(method, transportCutParams(method), 200),
        (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
      );
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).lineCount, 1);
    });
  }
});

test('Codex U1a faults the connection when a mutating request times out after write', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const { fakeServer, marker, scratch } = createTransportCutFixture(
    t,
    { exitAfterLine: false },
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  const pending = connection.request(
    'turn/start',
    transportCutParams('turn/start'),
    500,
  );
  for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
    await delay(5);
  }
  assert.equal(existsSync(marker), true);
  await assert.rejects(
    pending,
    (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
  );
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).lineCount, 1);
  assert.throws(
    () => connection.assertProtocolHealthy(),
    (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
  );
});

test('Codex U1a planned close does not turn a healthy connection into a protocol failure', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-close-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\\n`);',
      '});',
      "lines.once('close', () => process.exit(0));",
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );

  assert.deepEqual(
    await connection.request('config/read', {
      cwd: scratch,
      includeLayers: true,
    }, 1_000),
    {},
  );
  await connection.close();
  connection.assertProtocolHealthy();
});

test('Codex U1a close never signals a process group after its owned child exited', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract');
    return;
  }
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-stale-pgid-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(fakeServer, 'process.exit(0);\n');
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  for (let attempt = 0; attempt < 100 && !connection.closed; attempt += 1) {
    await delay(5);
  }
  assert.equal(connection.closed, true);

  const originalKill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => {
    signals.push({ pid, signal });
    return true;
  };
  try {
    await connection.close();
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(signals, []);
});

test('Codex U1a pins correlation-only schema surfaces without claiming deduplication', async () => {
  const { assertTransportCorrelationSurfaces } = await import(spikeUrl);
  const clientId = { type: ['string', 'null'] };
  const schema = {
    definitions: {
      TurnStartParams: {
        type: 'object',
        properties: { clientUserMessageId: clientId },
      },
      TurnSteerParams: {
        type: 'object',
        properties: { clientUserMessageId: clientId },
      },
      Thread: {
        type: 'object',
        properties: {
          turns: {
            type: 'array',
            items: { $ref: '#/definitions/Turn' },
          },
        },
      },
      ThreadResumeResponse: {
        type: 'object',
        properties: {
          thread: { $ref: '#/definitions/Thread' },
        },
      },
      ThreadItem: {
        oneOf: [{
          title: 'UserMessageThreadItem',
          type: 'object',
          properties: {
            clientId,
            content: { type: 'array' },
            id: { type: 'string' },
            type: { enum: ['userMessage'] },
          },
        }],
      },
    },
  };

  assert.deepEqual(assertTransportCorrelationSurfaces(schema), {
    turnStartClientId: true,
    turnSteerClientId: true,
    resumeUserMessageClientId: true,
    semantics: 'correlation-only',
  });

  delete schema.definitions.ThreadItem.oneOf[0].properties.clientId;
  assert.throws(
    () => assertTransportCorrelationSurfaces(schema),
    /resume user message omits clientId/,
  );
});

test('Codex U1a resume evidence stays unknown when absent and fails on conflicts', async () => {
  const { findClientUserMessageEvidence } = await import(spikeUrl);
  const opaqueUserMessage = (clientId) => {
    const item = { type: 'userMessage', clientId };
    Object.defineProperty(item, 'content', {
      enumerable: true,
      get() {
        throw new Error('resume evidence must not inspect message content');
      },
    });
    return item;
  };
  const unreadableContent = {
    get value() {
      throw new Error('resume evidence must not inspect message content');
    },
  };
  const makeThread = (items, turnId = 'turn-1') => ({
    id: 'thread-1',
    turns: [{
      id: turnId,
      status: 'completed',
      items,
    }],
  });

  assert.deepEqual(
    findClientUserMessageEvidence(
      makeThread([opaqueUserMessage('other'), unreadableContent]),
      'target-client-id',
    ),
    {
      status: 'unknown',
      matchCount: 0,
      turnId: null,
      turnStatus: null,
    },
  );
  assert.deepEqual(
    findClientUserMessageEvidence(
      makeThread([opaqueUserMessage('target-client-id')]),
      'target-client-id',
      'turn-1',
    ),
    {
      status: 'observed',
      matchCount: 1,
      turnId: 'turn-1',
      turnStatus: 'completed',
    },
  );
  assert.throws(
    () => findClientUserMessageEvidence(
      makeThread([
        { type: 'userMessage', clientId: 'target-client-id' },
        { type: 'userMessage', clientId: 'target-client-id' },
      ]),
      'target-client-id',
    ),
    /appeared multiple times/,
  );
  assert.throws(
    () => findClientUserMessageEvidence(
      makeThread([
        { type: 'userMessage', clientId: 'target-client-id' },
      ], 'wrong-turn'),
      'target-client-id',
      'expected-turn',
    ),
    /appeared in an unexpected turn/,
  );
});

test('Codex U1a reconciles only the exact terminal when completion wins interrupt', async () => {
  const { evaluateInterruptSettlement } = await import(spikeUrl);

  assert.deepEqual(evaluateInterruptSettlement({
    interruptAccepted: false,
    interruptStale: true,
    terminalMatches: true,
    terminalStatus: 'completed',
  }), {
    reconciled: true,
    reason: 'natural-terminal-won-race',
  });
  assert.deepEqual(evaluateInterruptSettlement({
    interruptAccepted: false,
    interruptStale: true,
    terminalMatches: false,
    terminalStatus: 'completed',
  }), {
    reconciled: false,
    reason: 'unmatched-stale-interrupt',
  });
  assert.deepEqual(evaluateInterruptSettlement({
    interruptAccepted: true,
    interruptStale: false,
    terminalMatches: true,
    terminalStatus: 'interrupted',
  }), {
    reconciled: true,
    reason: 'interrupted',
  });
  assert.deepEqual(evaluateInterruptSettlement({
    interruptAccepted: true,
    interruptStale: false,
    terminalMatches: true,
    terminalStatus: 'completed',
  }), {
    reconciled: true,
    reason: 'natural-terminal-won-race',
  });
  assert.deepEqual(evaluateInterruptSettlement({
    interruptAccepted: true,
    interruptStale: false,
    terminalMatches: true,
    terminalStatus: 'failed',
  }), {
    reconciled: true,
    reason: 'natural-terminal-won-race',
  });
});

test('Codex U1a verifies background-terminal emptiness from a fresh first page', async () => {
  const { waitForBackgroundTerminalsEmpty } = await import(spikeUrl);
  const calls = [];
  const responses = [
    {
      data: [{ itemId: 'item-1', processId: 'logical-1', command: 'redacted', cwd: 'redacted' }],
      nextCursor: 'ignored-live-snapshot-cursor',
    },
    { data: [], nextCursor: null },
  ];
  const connection = {
    async request(method, params) {
      calls.push({ method, params });
      return responses.shift();
    },
  };

  assert.equal(await waitForBackgroundTerminalsEmpty(
    connection,
    'thread-1',
    { maxPolls: 2, pollDelayMs: 0 },
  ), true);
  assert.deepEqual(calls, [
    {
      method: 'thread/backgroundTerminals/list',
      params: { threadId: 'thread-1' },
    },
    {
      method: 'thread/backgroundTerminals/list',
      params: { threadId: 'thread-1' },
    },
  ]);
});

test('Codex U1a background-terminal verification fails closed on cursor and timeout anomalies', async () => {
  const {
    listBackgroundTerminals,
    waitForBackgroundTerminalsEmpty,
  } = await import(spikeUrl);

  await assert.rejects(
    waitForBackgroundTerminalsEmpty(
      {
        async request() {
          return { data: [], nextCursor: 'unexpected-cursor' };
        },
      },
      'thread-1',
      { maxPolls: 1, pollDelayMs: 0 },
    ),
    /empty page returned a cursor/,
  );

  await assert.rejects(
    waitForBackgroundTerminalsEmpty(
      {
        async request() {
          return {
            data: [{ itemId: 'item-1', processId: 'logical-1', command: '', cwd: '' }],
            nextCursor: null,
          };
        },
      },
      'thread-1',
      { maxPolls: 2, pollDelayMs: 0 },
    ),
    /did not become empty/,
  );

  await assert.rejects(
    listBackgroundTerminals(
      {
        async request() {
          return {
            data: [{
              processId: 'logical-1',
              command: 'redacted',
              cwd: 'redacted',
            }],
            nextCursor: null,
          };
        },
      },
      'thread-1',
    ),
    /invalid terminal entry/,
  );
});

test('Codex U1a tracked-terminal stop gate requires cleanup and observed PID death', async () => {
  const { evaluateTrackedTerminalStopGate } = await import(spikeUrl);
  const passing = {
    commandStarted: true,
    markerObserved: true,
    terminalReconciled: true,
    listedAfterTerminal: true,
    commandAliveAfterTerminal: true,
    cleanAccepted: true,
    freshFirstPageEmpty: true,
    observedSyntheticPidDead: true,
  };

  assert.deepEqual(evaluateTrackedTerminalStopGate(passing), {
    gate: 'CONTINUE',
    exitCode: 0,
    failedChecks: [],
    scope: 'tracked-terminal-characterization-only',
  });
  assert.deepEqual(
    evaluateTrackedTerminalStopGate({
      ...passing,
      freshFirstPageEmpty: false,
    }).failedChecks,
    ['freshFirstPageEmpty'],
  );
});

test('Codex U1a steering gate fails closed on any missing observation', async () => {
  const { evaluateSteeringGate } = await import(spikeUrl);
  const result = evaluateSteeringGate({
    completed: true,
    activeTurnSteerMatched: true,
    orderedSteersObserved: true,
    finalSteerSemanticsObserved: false,
    singleSleepCommandObserved: true,
    noTurnErrors: true,
    definiteStaleSteerRejected: true,
  });

  assert.deepEqual(result, {
    gate: 'STOP',
    exitCode: 2,
    failedChecks: ['finalSteerSemanticsObserved'],
  });
});

test('Codex U1a schema generation omits the unsupported strict-config flag', async () => {
  const {
    assertExperimentalTerminalSurfaces,
    buildSchemaGenerationArgs,
  } = await import(spikeUrl);

  assert.deepEqual(buildSchemaGenerationArgs('/schemas/stable'), [
    'app-server',
    'generate-json-schema',
    '--out',
    '/schemas/stable',
  ]);
  assert.deepEqual(buildSchemaGenerationArgs('/schemas/experimental', true), [
    'app-server',
    'generate-json-schema',
    '--experimental',
    '--out',
    '/schemas/experimental',
  ]);
  assert.deepEqual(assertExperimentalTerminalSurfaces(
    {
      oneOf: [
        {
          properties: {
            method: { enum: ['thread/settings/update'] },
          },
        },
        {
          properties: {
            method: { enum: ['thread/backgroundTerminals/list'] },
          },
        },
        {
          properties: {
            method: { enum: ['thread/backgroundTerminals/clean'] },
          },
        },
      ],
    },
    {
      definitions: {
        v2: {
          ThreadBackgroundTerminalsListParams: {
            type: 'object',
            required: ['threadId'],
            properties: {
              cursor: { type: ['string', 'null'] },
              limit: { type: ['integer', 'null'] },
              threadId: { type: 'string' },
            },
          },
          ThreadBackgroundTerminalsListResponse: {
            type: 'object',
            required: ['data'],
            properties: {
              data: { type: 'array' },
              nextCursor: { type: ['string', 'null'] },
            },
          },
          ThreadBackgroundTerminalsCleanParams: {
            type: 'object',
            required: ['threadId'],
            properties: {
              threadId: { type: 'string' },
            },
          },
          ThreadBackgroundTerminalsCleanResponse: {
            type: 'object',
          },
        },
      },
    },
  ), {
    settingsUpdate: true,
    list: true,
    clean: true,
  });
});

test('Codex U1a accepts only the fixture-pinned fresh and resume provenance pair', async () => {
  const {
    evaluateProfileProvenance,
    exactActiveProfile,
  } = await import(spikeUrl);
  assert.equal(exactActiveProfile({
    id: 'polygram-session',
    extends: null,
  }), true);
  assert.equal(exactActiveProfile({ id: 'polygram-session' }), false);
  assert.equal(exactActiveProfile({
    id: 'polygram-session',
    extends: null,
    extra: true,
  }), false);

  const accepted = evaluateProfileProvenance({
    schemaDeclared: false,
    fresh: { responseExtensionExact: true, settingsNotificationExact: false },
    resume: { responseExtensionExact: true, settingsNotificationExact: false },
  });
  assert.deepEqual(accepted, {
    accepted: true,
    surface: 'response-extension',
    schemaDeclared: false,
    fragile: true,
  });

  const missingResume = evaluateProfileProvenance({
    schemaDeclared: false,
    fresh: { responseExtensionExact: true, settingsNotificationExact: false },
    resume: { responseExtensionExact: false, settingsNotificationExact: false },
  });
  assert.equal(missingResume.accepted, false);
});

test('Codex U1a attests the complete owned profile and rejects source drift', async () => {
  const {
    attestConnectionPolicy,
    attestNamedProfileConfig,
  } = await import(spikeUrl);
  const codexHome = '/srv/orchestra/codex-home';
  const workspace = '/srv/orchestra/workspace';
  const daemonSecretRoot = '/srv/orchestra/daemon-secrets';
  const version = 'sha256:owned-profile';
  const layerName = {
    type: 'user',
    file: `${codexHome}/config.toml`,
    profile: null,
  };
  const ownedConfig = {
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
        HOME: `${workspace}/.codex-command-home`,
        TMPDIR: `${workspace}/.codex-command-tmp`,
        PATH: '/usr/bin:/bin',
      },
    },
    permissions: {
      'polygram-session': {
        filesystem: {
          ':minimal': 'read',
          [codexHome]: 'deny',
          [daemonSecretRoot]: 'deny',
          ':workspace_roots': { '.': 'write' },
        },
        network: { enabled: false },
      },
    },
    projects: {
      [workspace]: { trust_level: 'untrusted' },
    },
  };
  const configRead = {
    config: {
      ...ownedConfig,
      shell_environment_policy: {
        ...ownedConfig.shell_environment_policy,
        exclude: null,
        include_only: null,
        experimental_use_profile: null,
      },
      permissions: {
        'polygram-session': {
          description: null,
          extends: null,
          workspace_roots: null,
          filesystem: {
            glob_scan_max_depth: null,
            ...ownedConfig.permissions['polygram-session'].filesystem,
          },
          network: {
            ...ownedConfig.permissions['polygram-session'].network,
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
      sandbox_mode: null,
      sandbox_workspace_write: null,
      mcp_servers: {},
      plugins: {},
      hooks: null,
    },
    layers: [
      { name: layerName, version, config: ownedConfig },
      {
        name: { type: 'system', file: '/etc/codex/config.toml' },
        version: 'sha256:empty-system',
        config: {},
      },
    ],
    origins: Object.fromEntries(
      [
        'cli_auth_credentials_store',
        'default_permissions',
        'approval_policy',
        'approvals_reviewer',
        'web_search',
        'allow_login_shell',
        'shell_environment_policy.inherit',
        'shell_environment_policy.ignore_default_excludes',
        'shell_environment_policy.set',
        'permissions.polygram-session.filesystem.:minimal',
        `permissions.polygram-session.filesystem.${codexHome}`,
        `permissions.polygram-session.filesystem.${daemonSecretRoot}`,
        'permissions.polygram-session.filesystem.:workspace_roots..',
        'permissions.polygram-session.network.enabled',
        `projects.${workspace}.trust_level`,
      ].map((key) => [key, { name: layerName, version }]),
    ),
  };

  const attested = attestNamedProfileConfig({
    configRead,
    requirements: null,
    codexHome,
    workspace,
    daemonSecretRoots: [daemonSecretRoot],
    rawConfigSha256: 'fixture-raw-sha256',
  });
  const requestedMethods = [];
  const replacementAttested = await attestConnectionPolicy({
    async request(method) {
      requestedMethods.push(method);
      if (method === 'config/read') return configRead;
      if (method === 'configRequirements/read') {
        return { requirements: null };
      }
      throw new Error(`unexpected request: ${method}`);
    },
  }, {
    codexHome,
    workspace,
    daemonSecretRoots: [daemonSecretRoot],
  }, 'fixture-raw-sha256', () => 'fixture-raw-sha256');
  assert.deepEqual(requestedMethods, [
    'config/read',
    'configRequirements/read',
  ]);
  assert.deepEqual(replacementAttested, attested);
  const changingHashes = ['fixture-raw-sha256', 'changed-after-read'];
  await assert.rejects(
    attestConnectionPolicy({
      async request(method) {
        if (method === 'config/read') return configRead;
        if (method === 'configRequirements/read') {
          return { requirements: null };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    }, {
      codexHome,
      workspace,
      daemonSecretRoots: [daemonSecretRoot],
    }, 'fixture-raw-sha256', () => changingHashes.shift()),
    /owned config changed during connection attestation/,
  );

  const changedEffectiveConfig = structuredClone(configRead);
  changedEffectiveConfig.config.runtime_default = 'changed';
  const changedAttestation = attestNamedProfileConfig({
    configRead: changedEffectiveConfig,
    requirements: null,
    codexHome,
    workspace,
    daemonSecretRoots: [daemonSecretRoot],
    rawConfigSha256: 'fixture-raw-sha256',
  });
  assert.notEqual(
    changedAttestation.effectivePolicySha256,
    attested.effectivePolicySha256,
  );

  const trustedWorkspace = structuredClone(configRead);
  trustedWorkspace.layers[0].config.projects[workspace].trust_level = 'trusted';
  trustedWorkspace.config.projects[workspace].trust_level = 'trusted';
  assert.throws(
    () => attestNamedProfileConfig({
      configRead: trustedWorkspace,
      requirements: null,
      codexHome,
      workspace,
      daemonSecretRoots: [daemonSecretRoot],
      rawConfigSha256: 'fixture-raw-sha256',
    }),
    /owned user config does not exactly match polygram-session/,
  );

  const prefixedOrigin = structuredClone(configRead);
  delete prefixedOrigin.origins.approval_policy;
  prefixedOrigin.origins.approval_policy_extra = {
    name: layerName,
    version,
  };
  assert.throws(
    () => attestNamedProfileConfig({
      configRead: prefixedOrigin,
      requirements: null,
      codexHome,
      workspace,
      daemonSecretRoots: [daemonSecretRoot],
      rawConfigSha256: 'fixture-raw-sha256',
    }),
    /effective config origin missing for approval_policy/,
  );

  const aliasedRootOrigin = structuredClone(configRead);
  const codexHomeOrigin = `permissions.polygram-session.filesystem.${codexHome}`;
  delete aliasedRootOrigin.origins[codexHomeOrigin];
  aliasedRootOrigin.origins[`${codexHomeOrigin}-alias`] = {
    name: layerName,
    version,
  };
  assert.throws(
    () => attestNamedProfileConfig({
      configRead: aliasedRootOrigin,
      requirements: null,
      codexHome,
      workspace,
      daemonSecretRoots: [daemonSecretRoot],
      rawConfigSha256: 'fixture-raw-sha256',
    }),
    new RegExp(`effective config origin missing for ${codexHomeOrigin}`),
  );

  const drifted = structuredClone(configRead);
  drifted.layers.push({
    name: { type: 'project', dotCodexFolder: `${workspace}/.codex` },
    version: 'sha256:project-drift',
    config: { sandbox_mode: 'danger-full-access' },
  });
  assert.throws(
    () => attestNamedProfileConfig({
      configRead: drifted,
      requirements: null,
      codexHome,
      workspace,
      daemonSecretRoots: [daemonSecretRoot],
      rawConfigSha256: 'fixture-raw-sha256',
    }),
    /unexpected config layer type: project/,
  );
});

test('Codex U1a bounds permission-profile pagination', async () => {
  const { listPermissionProfiles } = await import(spikeUrl);
  let calls = 0;
  const connection = {
    async request() {
      calls += 1;
      return { data: [], nextCursor: 'repeated' };
    },
  };

  await assert.rejects(
    listPermissionProfiles(connection, '/workspace'),
    /permission profile pagination repeated a cursor/,
  );
  assert.equal(calls, 2);
});

test('Codex U1a rejects resume provenance from a different thread', async () => {
  const { characterizeThreadProfile } = await import(spikeUrl);
  const connection = {
    async request() {
      return { thread: { id: 'different-thread' } };
    },
    waitForNotification() {
      throw new Error('must not wait after a mismatched resume');
    },
  };

  await assert.rejects(
    characterizeThreadProfile(connection, 'thread/resume', {
      threadId: 'expected-thread',
      cwd: '/workspace',
    }),
    /thread\/resume returned a different thread id/,
  );
});

test('Codex U1a completes one no-tools turn before cross-process resume', async () => {
  const { completePersistenceTurn } = await import(spikeUrl);
  let observedParams;
  const connection = {
    async request(method, params) {
      assert.equal(method, 'turn/start');
      observedParams = params;
      return { turn: { id: 'turn-1' } };
    },
    async waitForNotification(predicate) {
      const notification = {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            items: [{ type: 'agentMessage' }],
            status: 'completed',
          },
        },
      };
      assert.equal(predicate(notification), true);
      return notification;
    },
  };

  assert.equal(
    await completePersistenceTurn(connection, 'thread-1'),
    true,
  );
  assert.deepEqual(observedParams, {
    threadId: 'thread-1',
    input: [{
      type: 'text',
      text: 'Reply with exactly U1A_READY. Do not use tools.',
    }],
  });
});

test('Codex U1a braces multi-digit daemon-root probe arguments', async () => {
  const { buildFileEnforcementScript } = await import(spikeUrl);
  const script = buildFileEnforcementScript(6);

  assert.match(script, /head -c 1 "\$1"/);
  assert.match(script, /head -c 1 "\$\{10\}"/);
  assert.doesNotMatch(script, /"\$10"/);
  assert.doesNotMatch(script, /\bcd\b/);
});

test('Codex U1a passes protected sentinel files to the command probe', async () => {
  const { buildFileEnforcementCommand } = await import(spikeUrl);
  const command = buildFileEnforcementCommand(
    {
      marker: '/workspace/probe/marker',
      readable: '/workspace/probe/readable',
    },
    {
      codexHome: '/state/codex',
      daemonSecretRoots: ['/secrets/one', '/secrets/two'],
    },
  );

  assert.deepEqual(command.slice(-2), [
    '/secrets/one/.orchestra-codex-u1a-deny-probe',
    '/secrets/two/.orchestra-codex-u1a-deny-probe',
  ]);
});

test('Codex U1a creates command probes without following workspace symlinks', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX no-follow contract');
    return;
  }
  const { createCommandProbeFixture } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-probe-test-'));
  const workspace = path.join(scratch, 'workspace');
  const externalTarget = path.join(scratch, 'external-target');
  mkdirSync(workspace, { mode: 0o700 });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  symlinkSync(
    externalTarget,
    path.join(workspace, '.orchestra-codex-u1a-readable'),
  );
  const fixture = createCommandProbeFixture(workspace);

  assert.equal(existsSync(externalTarget), false);
  assert.equal(lstatSync(fixture.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(fixture.readable).isFile(), true);
  assert.equal(lstatSync(fixture.readable).mode & 0o777, 0o600);
});

test('Codex U1a requires a controlled network probe executable', async (t) => {
  const {
    evaluateCommandProbe,
    resolveNetworkProbeBinary,
  } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(
    homedir(),
    '.orchestra-codex-u1a-net-test-',
  ));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const probe = path.join(scratch, 'nc');
  writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(probe, 0o700);

  assert.equal(resolveNetworkProbeBinary([probe]), realpathSync(probe));
  assert.throws(
    () => resolveNetworkProbeBinary([path.join(scratch, 'missing-nc')]),
    /controlled netcat executable is required/,
  );
  assert.deepEqual(evaluateCommandProbe({
    fileExitCode: 0,
    fileStdoutEmpty: true,
    workspaceMarkerCreated: true,
    networkExitCode: 1,
    networkStdoutEmpty: true,
  }), {
    workspaceReadPassed: true,
    workspaceWritePassed: true,
    codexHomeDenied: true,
    daemonSecretsDenied: true,
    networkPassed: true,
  });
  assert.deepEqual(evaluateCommandProbe({
    fileExitCode: 30,
    fileStdoutEmpty: true,
    workspaceMarkerCreated: true,
    networkExitCode: 1,
    networkStdoutEmpty: true,
  }), {
    workspaceReadPassed: true,
    workspaceWritePassed: true,
    codexHomeDenied: true,
    daemonSecretsDenied: false,
    networkPassed: true,
  });
  assert.equal(evaluateCommandProbe({
    fileExitCode: 0,
    fileStdoutEmpty: true,
    workspaceMarkerCreated: true,
    networkExitCode: 127,
    networkStdoutEmpty: true,
  }).networkPassed, false);
});

test('Codex U1a allowlists every launcher environment', async (t) => {
  const { sanitizedAppServerEnv } = await import(spikeUrl);
  const previous = process.env.ORCHESTRA_U1A_SENTINEL_SECRET;
  process.env.ORCHESTRA_U1A_SENTINEL_SECRET = 'must-not-cross';
  t.after(() => {
    if (previous === undefined) delete process.env.ORCHESTRA_U1A_SENTINEL_SECRET;
    else process.env.ORCHESTRA_U1A_SENTINEL_SECRET = previous;
  });

  const env = sanitizedAppServerEnv({ codexHome: '/srv/codex-home' });
  assert.equal(Object.hasOwn(env, 'ORCHESTRA_U1A_SENTINEL_SECRET'), false);
  assert.equal(env.CODEX_HOME, '/srv/codex-home');
  assert.deepEqual(
    Object.keys(env).filter((key) => ![
      'HOME',
      'PATH',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'CODEX_HOME',
    ].includes(key)),
    [],
  );
});

test('Codex U1a rejects response IDs with a different JSON type', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-rpc-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({ id: String(request.id), result: {} })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  await assert.rejects(
    connection.request('config/read', {
      cwd: scratch,
      includeLayers: true,
    }, 1_000),
    /unexpected response id/,
  );
});

test('Codex U1a retains bounded RPC error diagnostics without error data', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-rpc-error-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      '    id: request.id,',
      "    error: { code: -32001, message: 'thread not found', data: { secret: 'hidden' } },",
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  const error = await connection.request('thread/resume', {
    threadId: 'missing',
    cwd: scratch,
  }, 1_000).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error.rpcCode, -32001);
  assert.equal(error.rpcMessage, 'thread not found');
  assert.equal(Object.hasOwn(error, 'rpcData'), false);
});

test('Codex U1a drops unrecognized server-controlled RPC diagnostics', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-rpc-secret-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      '    id: request.id,',
      "    error: { code: 'SECRET_CODE', message: 'SECRET_MESSAGE' },",
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  const error = await connection.request('config/read', {
    cwd: scratch,
    includeLayers: true,
  }, 1_000).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(Object.hasOwn(error, 'rpcCode'), false);
  assert.equal(Object.hasOwn(error, 'rpcMessage'), false);
  assert.doesNotMatch(error.message, /SECRET/);
});

test('Codex U1a sends no bytes for a non-allowlisted client method', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-allowlist-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, 'request-seen');
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import { writeFileSync } from 'node:fs';",
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      `lines.on('line', (line) => writeFileSync(${JSON.stringify(marker)}, line));`,
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  assert.throws(
    () => connection.request('thread/fork', {}),
    /request method is not allowlisted/,
  );
  await delay(50);
  assert.equal(existsSync(marker), false);
});

test('Codex U1a allowlists the minimal persistence turn request', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-turn-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      '    id: request.id,',
      "    result: { turn: { id: 'turn-1', items: [], status: 'inProgress' } },",
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  const result = await connection.request('turn/start', {
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'Reply exactly U1A_READY.' }],
  }, 1_000);
  assert.equal(result.turn.id, 'turn-1');
});

test('Codex U1a allowlists active-turn steering with an exact turn precondition', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-steer-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      '    id: request.id,',
      "    result: { turnId: request.params.expectedTurnId },",
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  const result = await connection.request('turn/steer', {
    threadId: 'thread-1',
    expectedTurnId: 'turn-1',
    input: [{ type: 'text', text: 'STEER_ONE' }],
  }, 1_000);
  assert.equal(result.turnId, 'turn-1');
});

test('Codex U1a allowlists interrupt only for one exact active turn', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-interrupt-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      '    id: request.id,',
      '    result: {},',
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  assert.deepEqual(await connection.request('turn/interrupt', {
    threadId: 'thread-1',
    turnId: 'turn-1',
  }, 1_000), {});
});

test('Codex U1a allowlists list and clean but not per-terminal terminate', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-clean-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.on('line', (line) => {",
      '  const request = JSON.parse(line);',
      "  const result = request.method.endsWith('/list')",
      '    ? { data: [], nextCursor: null }',
      '    : {};',
      '  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  assert.deepEqual(await connection.request('thread/backgroundTerminals/list', {
    threadId: 'thread-1',
  }, 1_000), {
    data: [],
    nextCursor: null,
  });
  assert.deepEqual(await connection.request('thread/backgroundTerminals/clean', {
    threadId: 'thread-1',
  }, 1_000), {});
  assert.throws(
    () => connection.request('thread/backgroundTerminals/terminate', {
      threadId: 'thread-1',
      processId: 'logical-1',
    }),
    /request method is not allowlisted/,
  );
  assert.throws(
    () => connection.request('thread/backgroundTerminals/list', {
      threadId: 'thread-1',
      command: 'must-not-cross',
    }),
    /unexpected parameter/,
  );
});

test('Codex U1b allowlists only the exact paginated model catalog parameters', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1b-model-list-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.on('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      '    id: request.id,',
      '    result: { data: [], nextCursor: null },',
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  assert.deepEqual(await connection.request('model/list', {
    cursor: null,
    includeHidden: false,
    limit: 100,
  }, 1_000), {
    data: [],
    nextCursor: null,
  });
  assert.throws(
    () => connection.request('model/list', {
      cursor: null,
      includeHidden: false,
      limit: 100,
      provider: 'must-not-cross',
    }),
    /unexpected parameter/,
  );
});

test('Codex U1b retains retry ownership without retaining provider error text', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1b-retry-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      "    method: 'error',",
      '    params: {',
      "      error: { message: 'SECRET_PROVIDER_ERROR', codexErrorInfo: null },",
      "      threadId: 'thread-1',",
      "      turnId: 'turn-1',",
      '      willRetry: true,',
      '    },',
      '  })}\\n`);',
      '  process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  assert.deepEqual(await connection.request('config/read', {
    cwd: scratch,
    includeLayers: true,
  }, 1_000), {});
  assert.deepEqual(connection.notifications, [{
    method: 'error',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: { present: true },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(connection.notifications), /SECRET_PROVIDER_ERROR/);
});

test('Codex U1b retains only effective model and effort from settings updates', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1b-settings-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      "    method: 'thread/settings/updated',",
      '    params: {',
      "      threadId: 'thread-1',",
      '      threadSettings: {',
      "        model: 'gpt-5.6-sol',",
      "        effort: 'xhigh',",
      "        cwd: 'SECRET_CWD',",
      '      },',
      '    },',
      '  })}\\n`);',
      '  process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  assert.deepEqual(await connection.request('config/read', {
    cwd: scratch,
    includeLayers: true,
  }, 1_000), {});
  assert.deepEqual(connection.notifications, [{
    method: 'thread/settings/updated',
    params: {
      threadId: 'thread-1',
      threadSettings: {
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(connection.notifications), /SECRET_CWD/);
});

test('Codex U1b paginates the model catalog and rejects cursor loops', async () => {
  const { listModelCatalog } = await import(u1bSpikeUrl);
  const requests = [];
  const connection = {
    async request(method, params) {
      requests.push({ method, params });
      if (requests.length === 1) {
        return {
          data: [{
            id: 'model-one',
            model: 'gpt-one',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'medium' },
            ],
          }],
          nextCursor: 'cursor-two',
        };
      }
      return {
        data: [{
          id: 'model-two',
          model: 'gpt-two',
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
        }],
        nextCursor: null,
      };
    },
  };

  assert.deepEqual(await listModelCatalog(connection), [{
    id: 'model-one',
    model: 'gpt-one',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium'],
  }, {
    id: 'model-two',
    model: 'gpt-two',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['high'],
  }]);
  assert.deepEqual(requests, [{
    method: 'model/list',
    params: { includeHidden: false, limit: 100 },
  }, {
    method: 'model/list',
    params: {
      includeHidden: false,
      limit: 100,
      cursor: 'cursor-two',
    },
  }]);

  let calls = 0;
  await assert.rejects(
    listModelCatalog({
      async request() {
        calls += 1;
        return { data: [], nextCursor: 'same-cursor' };
      },
    }),
    /repeated a cursor/,
  );
  assert.equal(calls, 2);
});

test('Codex U1b model selection rejects unavailable values instead of downgrading', async () => {
  const {
    evaluateModelPersistence,
    selectAdvertisedModelEffort,
  } = await import(u1bSpikeUrl);
  const catalog = [{
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  }];

  assert.deepEqual(
    selectAdvertisedModelEffort(catalog, 'gpt-5.6-sol', 'xhigh'),
    {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      defaultReasoningEffort: 'medium',
    },
  );
  assert.throws(
    () => selectAdvertisedModelEffort(catalog, 'missing-model', 'xhigh'),
    /not advertised/,
  );
  assert.throws(
    () => selectAdvertisedModelEffort(catalog, 'gpt-5.6-sol', 'ultra'),
    /does not advertise effort/,
  );
  assert.equal(evaluateModelPersistence({
    selected: { model: 'gpt-5.6-sol', effort: 'low' },
    freshResponse: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    },
    settingsUpdate: null,
    resumeResponse: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    },
    laterTurnCompleted: true,
  }).gate, 'CONTINUE');
  assert.equal(evaluateModelPersistence({
    selected: { model: 'gpt-5.6-sol', effort: 'low' },
    freshResponse: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    },
    settingsUpdate: {
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
    resumeResponse: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    },
    laterTurnCompleted: true,
  }).gate, 'STOP');
});

test('Codex U1b resource summaries preserve labels and reject incomplete samples', async () => {
  const { summarizeResourceSamples } = await import(u1bSpikeUrl);
  assert.deepEqual(summarizeResourceSamples('idle-real', [{
    rootRssKiB: 100,
    treeRssKiB: 120,
    rootFdCount: 10,
    treeFdCount: 12,
    descendantCount: 1,
  }, {
    rootRssKiB: 200,
    treeRssKiB: 260,
    rootFdCount: 20,
    treeFdCount: 24,
    descendantCount: 2,
  }]), {
    label: 'idle-real',
    sampleCount: 2,
    rootRssKiB: { median: 150, max: 200 },
    treeRssKiB: { median: 190, max: 260 },
    rootFdCount: { median: 15, max: 20 },
    treeFdCount: { median: 18, max: 24 },
    descendantCount: { median: 1.5, max: 2 },
  });
  assert.throws(
    () => summarizeResourceSamples('idle-real', [{
      rootRssKiB: 100,
    }]),
    /incomplete resource sample/,
  );
});

test('Codex U1b resource parsers count only the exact owned process tree and numeric FDs', async () => {
  const {
    parseProcessSnapshot,
    parseLsofDescriptorCounts,
    summarizeOwnedProcessTree,
  } = await import(u1bResourceSpikeUrl);
  const processes = parseProcessSnapshot([
    ' 100 1 100 100 S 50000 codex',
    ' 101 100 100 100 S 10000 helper one',
    ' 102 101 100 100 S 5000 helper-two',
    ' 200 1 200 200 S 90000 unrelated',
  ].join('\n'));
  const descriptorCounts = parseLsofDescriptorCounts([
    'p100',
    'fcwd',
    'f0',
    'f12',
    'p101',
    'ftxt',
    'f3',
    'p200',
    'f9',
  ].join('\n'));

  assert.deepEqual(summarizeOwnedProcessTree(
    [100],
    processes,
    descriptorCounts,
  ), {
    rootRssKiB: 50000,
    treeRssKiB: 65000,
    rootFdCount: 2,
    treeFdCount: 3,
    descendantCount: 2,
  });
  assert.throws(
    () => summarizeOwnedProcessTree([999], processes, descriptorCounts),
    /owned root process was absent/,
  );
});

test('Codex U1b retry traces require provider-owned attempts and one ordered terminal', async () => {
  const { evaluateRetryTrace } = await import(u1bEffectsSpikeUrl);
  assert.deepEqual(evaluateRetryTrace({
    expectedAttempts: 2,
    providerAttempts: 2,
    turnStartRequests: 1,
    notifications: [
      { method: 'error', willRetry: true },
      { method: 'turn/completed', status: 'completed' },
    ],
    expectedTerminal: 'completed',
  }), {
    gate: 'CONTINUE',
    providerAttempts: 2,
    retrySignals: [true],
    terminalStatus: 'completed',
  });
  assert.throws(
    () => evaluateRetryTrace({
      expectedAttempts: 2,
      providerAttempts: 2,
      turnStartRequests: 2,
      notifications: [
        { method: 'error', willRetry: true },
        { method: 'turn/completed', status: 'completed' },
      ],
      expectedTerminal: 'completed',
    }),
    /exactly one client turn\/start/,
  );
  assert.throws(
    () => evaluateRetryTrace({
      expectedAttempts: 2,
      providerAttempts: 2,
      turnStartRequests: 1,
      notifications: [
        { method: 'turn/completed', status: 'failed' },
        { method: 'error', willRetry: true },
      ],
      expectedTerminal: 'failed',
    }),
    /retry signal followed the terminal/,
  );
});

test('Codex U1b effect classification never treats marker absence or resume as replay proof', async () => {
  const {
    classifyEffectWindow,
    parseOwnedProcessId,
  } = await import(u1bEffectsSpikeUrl);
  assert.equal(parseOwnedProcessId('234\n'), 234);
  for (const unsafe of ['', '0', '1', '-1', 'NaN', '2x']) {
    assert.throws(() => parseOwnedProcessId(unsafe), /owned process ID/);
  }
  assert.deepEqual(classifyEffectWindow({
    requestWriteAttempted: true,
    markerPresent: false,
    resumedStatus: 'completed',
    clientObservedTerminal: false,
  }), {
    effect: 'unknown',
    replayAllowed: false,
    markerProvesEffect: false,
    resumeIsReplayTruth: false,
  });
  assert.deepEqual(classifyEffectWindow({
    requestWriteAttempted: true,
    markerPresent: true,
    resumedStatus: null,
    clientObservedTerminal: false,
  }), {
    effect: 'occurred',
    replayAllowed: false,
    markerProvesEffect: true,
    resumeIsReplayTruth: false,
  });
});

test('Codex U1b durable observations are sanitized and preserve every gate', () => {
  const fixtureRoot = path.resolve(
    __dirname,
    'fixtures/codex-app-server-0.145.0',
  );
  const fixtures = [
    'model-effort-observation.json',
    'resource-observation.json',
    'retry-effect-observation.json',
  ].map((name) => JSON.parse(readFileSync(path.join(fixtureRoot, name), 'utf8')));
  const serialized = JSON.stringify(fixtures);
  assert.doesNotMatch(
    serialized,
    /threadId|turnId|generationId|clientUserMessageId|processId|rawCommand|commandText|prompt|header|authorization|errorMessage|requestBody|\/Users\/|\/private\/|SECRET_/i,
  );
  assert.equal(fixtures.every((fixture) => fixture.gate === 'CONTINUE'), true);
  assert.deepEqual(
    fixtures[2].retryOwnership.scenarios.retryableExhausted.retrySignals,
    [true, false],
  );
  assert.equal(
    fixtures[2].effectWindows.every((window) => window.replayAllowed === false),
    true,
  );
});

test('Codex U1a faults an unknown inbound experimental notification without leaking metadata', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-inbound-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', () => {",
      '  process.stdout.write(`${JSON.stringify({',
      "    method: 'thread/experimental/unknown\\nSECRET_METHOD',",
      "    params: { command: 'SECRET_COMMAND', cwd: 'SECRET_CWD' },",
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  const error = await connection.request('config/read', {
    cwd: scratch,
    includeLayers: true,
  }, 1_000).then(
    () => null,
    (caught) => caught,
  );
  assert.match(error.message, /malformed method|unexpected server notification/);
  assert.doesNotMatch(error.message, /SECRET_METHOD|SECRET_COMMAND|SECRET_CWD/);
});

test('Codex U1a drops noisy notification payloads', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-notification-bound-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      '  process.stdout.write(`${JSON.stringify({',
      "    method: 'item/commandExecution/outputDelta',",
      "    params: { delta: 'SECRET_OUTPUT', threadId: 'thread-1', turnId: 'turn-1' },",
      '  })}\\n`);',
      '  process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  assert.deepEqual(await connection.request('config/read', {
    cwd: scratch,
    includeLayers: true,
  }, 1_000), {});
  assert.doesNotMatch(JSON.stringify(connection.notifications), /SECRET_OUTPUT/);
});

test('Codex U1a rejects oversized server lines without retaining their payload', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-line-bound-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', () => {",
      '  process.stdout.write(`${JSON.stringify({',
      "    method: 'warning',",
      "    params: { message: `SECRET_${'X'.repeat(1_100_000)}` },",
      '  })}\\n`);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  const error = await connection.request('config/read', {
    cwd: scratch,
    includeLayers: true,
  }, 2_000).then(
    () => null,
    (caught) => caught,
  );
  assert.match(error.message, /line exceeded the size limit/);
  assert.doesNotMatch(error.message, /SECRET_/);
  assert.equal(connection.notifications.length, 0);
});

test('Codex U1a characterizes ordered semantic steering and definite stale rejection', async () => {
  const { characterizeActiveTurnSteering } = await import(spikeUrl);
  const pendingSteers = [];
  const notifications = [];
  const connection = {
    notifications,
    async request(method, params) {
      if (method === 'turn/start') {
        assert.equal(params.threadId, 'thread-1');
        assert.deepEqual(params.outputSchema.required, ['values']);
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'turn/steer' && params.input[0].text === 'STALE_STEER') {
        const error = new Error('stale');
        error.rpcCode = -32600;
        error.rpcMessage = 'no active turn to steer';
        throw error;
      }
      if (method === 'turn/steer') {
        return new Promise((resolvePromise) => {
          pendingSteers.push({ params, resolvePromise });
          if (pendingSteers.length !== 2) return;
          for (const pending of pendingSteers) {
            notifications.push({
              method: 'item/started',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                  type: 'userMessage',
                  clientId: pending.params.clientUserMessageId,
                },
              },
            });
            pending.resolvePromise({ turnId: 'turn-1' });
          }
        });
      }
      throw new Error(`unexpected request: ${method}`);
    },
    async waitForNotification(predicate) {
      if (notifications.length === 0) {
        const commandStarted = {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              command: '/bin/sleep 8',
            },
          },
        };
        notifications.push(commandStarted);
        assert.equal(predicate(commandStarted), true);
        return commandStarted;
      }
      notifications.push({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'agentMessage',
            text: '{"values":["U1A_STEER_ALPHA","U1A_STEER_BETA"]}',
          },
        },
      });
      const completed = {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', items: [], status: 'completed' },
        },
      };
      notifications.push(completed);
      assert.equal(predicate(completed), true);
      return completed;
    },
  };

  assert.deepEqual(
    await characterizeActiveTurnSteering(connection, 'thread-1'),
    {
      completed: true,
      activeTurnSteerMatched: true,
      orderedSteersObserved: true,
      finalSteerSemanticsObserved: true,
      singleSleepCommandObserved: true,
      noTurnErrors: true,
      definiteStaleSteerRejected: true,
      staleSteerRpcCode: -32600,
      staleSteerClass: 'definite-stale',
    },
  );
  assert.equal(pendingSteers.length, 2);
});

test('Codex U1a denies an unexpected server request and latches failure', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-server-request-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, 'denial.json');
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import { writeFileSync } from 'node:fs';",
      "import readline from 'node:readline';",
      'process.on(\'SIGTERM\', () => {});',
      'const lines = readline.createInterface({ input: process.stdin });',
      'let first = true;',
      "lines.on('line', (line) => {",
      '  if (first) {',
      '    first = false;',
      "    process.stdout.write(`${JSON.stringify({ id: 77, method: 'item/request', params: {} })}\\n`);",
      '    return;',
      '  }',
      `  writeFileSync(${JSON.stringify(marker)}, line);`,
      '  process.exit(0);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  await assert.rejects(
    connection.request('config/read', {
      cwd: scratch,
      includeLayers: true,
    }, 1_000),
    /unexpected server request/,
  );
  await assert.rejects(
    connection.request('config/read', {
      cwd: scratch,
      includeLayers: true,
    }, 1_000),
    /unexpected server request/,
  );
  await connection.close();
  assert.throws(
    () => connection.assertProtocolHealthy(),
    /unexpected server request/,
  );
  assert.deepEqual(connection.unexpectedServerRequests, ['denied']);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
    id: 77,
    error: {
      code: -32601,
      message: 'U1a checker denies unexpected server requests',
    },
  });
});

test('Codex U1a rejects later work after an idle stray response', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-sticky-rpc-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import readline from 'node:readline';",
      "process.stdout.write(`${JSON.stringify({ id: 999, result: {} })}\\n`);",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.on('line', (line) => {",
      '  const request = JSON.parse(line);',
      "  process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\\n`);",
      '});',
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  t.after(() => connection.close());

  for (let attempt = 0; attempt < 100 && !connection.protocolError; attempt += 1) {
    await delay(10);
  }
  assert.match(connection.protocolError?.message ?? '', /unexpected response id/);
  assert.throws(
    () => connection.assertProtocolHealthy(),
    /unexpected response id/,
  );
  await assert.rejects(
    connection.request('config/read', {
      cwd: scratch,
      includeLayers: true,
    }, 1_000),
    /unexpected response id/,
  );
});

test('Codex U1a observes protocol failure emitted during final drain', async (t) => {
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-drain-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  const ready = path.join(scratch, 'ready');
  writeFileSync(
    fakeServer,
    [
      "import { writeFileSync } from 'node:fs';",
      "import readline from 'node:readline';",
      'process.on(\'SIGTERM\', () => {});',
      'const lines = readline.createInterface({ input: process.stdin });',
      `writeFileSync(${JSON.stringify(ready)}, '');`,
      "lines.once('close', () => {",
      "  process.stdout.write('not-json\\n');",
      '  setTimeout(() => process.exit(0), 10);',
      '});',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );

  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
    await delay(10);
  }
  assert.equal(existsSync(ready), true);
  await connection.close();
  assert.throws(
    () => connection.assertProtocolHealthy(),
    /emitted malformed JSON/,
  );
});

test('Codex U1a rejects temporary or loosely-permissioned credential homes', async (t) => {
  const { validateCodexHome } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-home-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  assert.throws(
    () => validateCodexHome(realpathSync(scratch)),
    /CODEX_HOME must not be inside a temporary filesystem root/,
  );

  const workspaceHome = path.join(process.cwd(), '.u1a-codex-home-test');
  mkdirSync(workspaceHome, { mode: 0o755 });
  t.after(() => rmSync(workspaceHome, { recursive: true, force: true }));
  assert.throws(
    () => validateCodexHome(workspaceHome, { temporaryRoots: [] }),
    /CODEX_HOME permissions must be 0700/,
  );

  const privateHome = mkdtempSync(path.join(process.cwd(), '.u1a-codex-private-home-test-'));
  chmodSync(privateHome, 0o700);
  const authTarget = path.join(process.cwd(), '.u1a-codex-auth-target');
  t.after(() => {
    rmSync(privateHome, { recursive: true, force: true });
    rmSync(authTarget, { force: true });
  });
  writeFileSync(path.join(privateHome, 'config.toml'), '', { mode: 0o600 });
  writeFileSync(authTarget, '{}', { mode: 0o600 });
  const authPath = path.join(privateHome, 'auth.json');
  symlinkSync(authTarget, authPath);
  assert.throws(
    () => validateCodexHome(privateHome, { temporaryRoots: [] }),
    /CODEX_HOME auth.json must be a real file/,
  );

  unlinkSync(authPath);
  linkSync(authTarget, authPath);
  assert.throws(
    () => validateCodexHome(privateHome, { temporaryRoots: [] }),
    /CODEX_HOME auth.json must not have hard-link aliases/,
  );

  unlinkSync(authPath);
  writeFileSync(authPath, '{}', { mode: 0o600 });
  assert.equal(
    validateCodexHome(privateHome, { temporaryRoots: [] }),
    realpathSync(privateHome),
  );
});

test('Codex U1a requires a non-empty private sentinel in each daemon secret root', async (t) => {
  const { validateDaemonSecretRoots } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-secret-root-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const codexHome = path.join(scratch, 'codex-home');
  const workspace = path.join(scratch, 'workspace');
  const daemonRoot = path.join(scratch, 'daemon-root');
  for (const directory of [codexHome, workspace, daemonRoot]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const sentinel = path.join(daemonRoot, '.orchestra-codex-u1a-deny-probe');
  writeFileSync(sentinel, '', { mode: 0o600 });

  assert.throws(
    () => validateDaemonSecretRoots(
      [realpathSync(daemonRoot)],
      realpathSync(codexHome),
      realpathSync(workspace),
    ),
    /daemon secret root sentinel must not be empty/,
  );

  writeFileSync(sentinel, 'x\n', { mode: 0o600 });
  chmodSync(sentinel, 0o000);
  assert.throws(
    () => validateDaemonSecretRoots(
      [realpathSync(daemonRoot)],
      realpathSync(codexHome),
      realpathSync(workspace),
    ),
    /daemon secret root sentinel must be owner-readable/,
  );

  chmodSync(sentinel, 0o600);
  assert.deepEqual(
    validateDaemonSecretRoots(
      [realpathSync(daemonRoot)],
      realpathSync(codexHome),
      realpathSync(workspace),
    ),
    [realpathSync(daemonRoot)],
  );
});

test('Codex U1a bounds a hung launcher subprocess', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher contract');
    return;
  }
  const { runCommand } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const binaryPath = path.join(scratch, 'codex');
  const launcherPath = path.join(scratch, 'launcher');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(launcherPath, '#!/bin/sh\nexec sleep 5\n', { mode: 0o700 });
  chmodSync(binaryPath, 0o700);
  chmodSync(launcherPath, 0o700);

  const startedAt = Date.now();
  const result = runCommand(
    { binary: binaryPath, launcher: launcherPath },
    ['--version'],
    {},
    50,
  );

  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.ok(Date.now() - startedAt < 1_000);
});

test('Codex U1a connection close removes its POSIX command descendants', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract');
    return;
  }
  const { AppServerConnection } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-tree-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, 'descendant-pid');
  const fakeServer = path.join(scratch, 'fake-app-server.mjs');
  writeFileSync(
    fakeServer,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );
  const connection = new AppServerConnection(
    {
      binary: fakeServer,
      launcher: process.execPath,
      workspace: scratch,
    },
    { PATH: process.env.PATH ?? '' },
  );
  let descendantPid;
  t.after(() => {
    if (!descendantPid) return;
    try {
      process.kill(descendantPid, 'SIGKILL');
    } catch {
      // The assertion below expects the process to be absent already.
    }
  });
  for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
    await delay(10);
  }
  descendantPid = Number.parseInt(readFileSync(marker, 'utf8'), 10);
  assert.equal(Number.isSafeInteger(descendantPid), true);

  await connection.close();
  await delay(100);
  let descendantGone = false;
  try {
    process.kill(descendantPid, 0);
  } catch (error) {
    descendantGone = error.code === 'ESRCH';
  }
  assert.equal(descendantGone, true);
});
