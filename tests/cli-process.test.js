'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliProcess } = require('../index');
const factory = require('../lib/process/factory');
const { createProcessFactory, pickBackend } = factory;

// Minimal fakes so we can construct without touching tmux / claude.
// Method shape matches lib/tmux/tmux-runner.js exports.
const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
};
const fakeDispatcher = async () => ({ ok: true });

function handshakeProcess(overrides = {}) {
  return new CliProcess({
    sessionKey: 'handshake',
    chatId: '1',
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    claudeBin: '/usr/bin/echo',
    toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    ...overrides,
  });
}

test('CliProcess construction — required params', () => {
  assert.throws(
    () => new CliProcess({}),
    /sessionKey/,
    'sessionKey required',
  );

  assert.throws(
    () => new CliProcess({ sessionKey: 'k', botName: 'b', toolDispatcher: fakeDispatcher }),
    /tmuxRunner required/,
  );

  assert.throws(
    () => new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, toolDispatcher: fakeDispatcher }),
    /botName required/,
  );

  assert.throws(
    () => new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b' }),
    /toolDispatcher.*required/,
  );
});

test('CliProcess construction — valid params', () => {
  const p = new CliProcess({
    sessionKey: 'session-1',
    chatId: '12345',
    threadId: null,
    label: 'test-chat',
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    claudeBin: '/usr/bin/echo',
    toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  assert.equal(p.sessionKey, 'session-1');
  assert.equal(p.chatId, '12345');
  assert.equal(p.threadId, null);
  assert.equal(p.label, 'test-chat');
  assert.equal(p.backend, 'cli');
  assert.equal(p.cost, 3);
  assert.equal(p.closed, false);
  assert.equal(p.inFlight, false);
  assert.equal(p.bridgeReady, false);
});

function activeCleanRestartProcess(overrides = {}) {
  const p = handshakeProcess(overrides);
  const turnId = 'turn-active';
  p.bridgeReady = true;
  p.mcpReady = true;
  p.tmuxSession = 'tmux-active';
  p.bridgeServer = {
    close: async () => {},
  };
  p._hookTail = {
    drain: async () => ({ offset: 123 }),
    close: () => {},
  };
  p._hookNdjsonPath = '/tmp/test-hook.ndjson';
  p.pendingTurns.set(turnId, {
    replies: [],
    startedAt: Date.now(),
    reject: () => {},
  });
  p.pendingQueue.push({
    turnId,
    context: { sourceMsgId: 42 },
  });
  p.inputLedger.set(turnId, {
    turnId,
    source: 'primary',
    msgId: 42,
    state: 'seen',
  });
  return { p, turnId };
}

test('clean restart retirement returns one eligible active CLI source after strict termination and hook drain', async () => {
  const events = [];
  const { p } = activeCleanRestartProcess({
    tmuxRunner: {
      ...fakeRunner,
      killSession: async (_name, opts) => events.push(['tmux', opts]),
      sessionExists: async () => false,
    },
  });
  p.bridgeServer.close = async () => events.push(['bridge']);
  p._hookTail.drain = async () => {
    events.push(['drain']);
    return { offset: 123 };
  };

  const snapshot = await p.retireForCleanRestart({
    getDeliveryEvidence: async (sessionKey, sourceMsgId) => {
      events.push(['delivery', sessionKey, sourceMsgId]);
      return { outputAttempted: false, pending: 0, fenced: true };
    },
  });

  assert.deepEqual(snapshot, {
    sessionKey: 'handshake',
    sourceMsgId: 42,
    eligible: true,
    reason: 'eligible',
  });
  assert.deepEqual(events, [
    ['delivery', 'handshake', 42],
    ['tmux', { strict: true }],
    ['bridge'],
    ['drain'],
  ]);
  assert.equal(p.closed, true);
});

test('clean restart retirement rejects malformed Polygram delivery evidence', () => {
  const malformedEvidence = [
    { pending: 0, fenced: true },
    { outputAttempted: 'false', pending: 0, fenced: true },
    { outputAttempted: false, pending: '1', fenced: true },
    { outputAttempted: false, pending: -1, fenced: true },
    { outputAttempted: false, pending: 0.5, fenced: true },
    { outputAttempted: false, pending: Number.NaN, fenced: true },
    { outputAttempted: false, pending: 0, fenced: false },
  ];

  for (const evidence of malformedEvidence) {
    const { p } = activeCleanRestartProcess();
    assert.deepEqual(
      p._classifyCleanRestart(evidence),
      ['delivery-ambiguous', 42],
      JSON.stringify(evidence),
    );
  }
});

test('delivery ambiguity takes precedence over an unresolved active tool', () => {
  const { p, turnId } = activeCleanRestartProcess();
  p.pendingTurns.get(turnId).activeToolIds = new Set(['tool']);

  assert.deepEqual(
    p._classifyCleanRestart({
      outputAttempted: false,
      pending: 1,
      fenced: true,
    }),
    ['delivery-ambiguous', 42],
  );
});

test('clean restart retirement conservatively rejects sticky output, tool, interaction, input, loss, and delivery evidence', async () => {
  const cases = [
    ['prior-output', ({ pending }) => { pending.outputAttempted = true; }],
    ['unresolved-tool', ({ pending }) => { pending.activeToolIds = new Set(['tool']); }],
    ['unresolved-question', ({ p }) => { p._openQuestions.add('q'); }],
    ['unresolved-approval', ({ p }) => { p._openApprovals.add('a'); }],
    ['active-subagent', ({ p }) => { p._pendingSubagentStarts.push({ toolUseId: 'agent' }); }],
    ['other-action-owner', ({ p }) => {
      p.inputLedger.set('injected', { source: 'inject', msgId: 99, state: 'written' });
    }],
    ['bridge-loss', ({ p }) => { p._cleanRestartEvidenceLost = true; }],
  ];

  for (const [reason, mutate] of cases) {
    const { p, turnId } = activeCleanRestartProcess({
      tmuxRunner: {
        ...fakeRunner,
        killSession: async () => {},
        sessionExists: async () => false,
      },
    });
    p._openApprovals = new Set();
    mutate({ p, pending: p.pendingTurns.get(turnId) });
    const snapshot = await p.retireForCleanRestart({
      getDeliveryEvidence: async () => ({ outputAttempted: false, pending: 0, fenced: true }),
    });
    assert.equal(snapshot.eligible, false, reason);
    assert.equal(snapshot.reason, reason, reason);
  }

  const { p: delivery } = activeCleanRestartProcess({
    tmuxRunner: {
      ...fakeRunner,
      killSession: async () => {},
      sessionExists: async () => false,
    },
  });
  delivery._openApprovals = new Set();
  const deliverySnapshot = await delivery.retireForCleanRestart({
    getDeliveryEvidence: async () => ({
      outputAttempted: false,
      pending: 1,
      fenced: true,
    }),
  });
  assert.equal(deliverySnapshot.reason, 'delivery-ambiguous');

  const { p: externalOutput } = activeCleanRestartProcess({
    tmuxRunner: {
      ...fakeRunner,
      killSession: async () => {},
    },
  });
  const externalOutputSnapshot = await externalOutput.retireForCleanRestart({
    getDeliveryEvidence: async () => ({
      outputAttempted: true,
      pending: 0,
      fenced: true,
    }),
  });
  assert.equal(externalOutputSnapshot.reason, 'prior-output');
});

test('clean restart retirement rejects zero/multiple pendings and missing source correlation', async () => {
  for (const [reason, mutate] of [
    ['no-active-turn', ({ p }) => {
      p.pendingTurns.clear();
      p.pendingQueue.length = 0;
      p.inputLedger.clear();
    }],
    ['multiple-active-turns', ({ p }) => {
      p.pendingTurns.set('other', { replies: [], reject: () => {} });
    }],
    ['uncorrelated-source', ({ p }) => {
      p.pendingQueue[0].context = {};
      p.inputLedger.get('turn-active').msgId = null;
    }],
  ]) {
    const { p } = activeCleanRestartProcess({
      tmuxRunner: {
        ...fakeRunner,
        killSession: async () => {},
        sessionExists: async () => false,
      },
    });
    p._openApprovals = new Set();
    mutate({ p });
    const evidenceArgs = [];
    const snapshot = await p.retireForCleanRestart({
      getDeliveryEvidence: async (...args) => {
        evidenceArgs.push(args);
        return { outputAttempted: false, pending: 0, fenced: true };
      },
    });
    assert.equal(snapshot.reason, reason);
    assert.deepEqual(evidenceArgs, [['handshake', null]]);
  }
});

test('clean restart retirement fails loud on tmux, bridge, or hook-tail uncertainty', async () => {
  for (const [label, configure] of [
    ['tmux', ({ p }) => {
      p.runner.killSession = async () => {
        throw Object.assign(new Error('kill failed'), { code: 'TMUX_KILL_FAILED' });
      };
    }],
    ['bridge', ({ p }) => {
      p.bridgeServer.close = async () => { throw new Error('close failed'); };
    }],
    ['hook', ({ p }) => {
      p._hookTail.drain = async () => { throw new Error('drain failed'); };
    }],
  ]) {
    const { p } = activeCleanRestartProcess({
      tmuxRunner: {
        ...fakeRunner,
        killSession: async () => {},
        sessionExists: async () => false,
      },
    });
    p._openApprovals = new Set();
    configure({ p });
    await assert.rejects(
      p.retireForCleanRestart({
        getDeliveryEvidence: async () => ({ outputAttempted: false, pending: 0, fenced: true }),
      }),
      (error) => error.code === 'CLEAN_RESTART_RETIREMENT_FAILED',
      label,
    );
  }
});

async function exerciseStrictResume(t, {
  createJsonl,
  cwdName = 'workspace',
  existingSessionId = 'resume-session',
  expectedSessionId = 'resume-session',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-resume-'));
  const cwd = path.join(root, cwdName);
  const appDataDir = path.join(root, 'app-data');
  fs.mkdirSync(cwd, { recursive: true });
  t.mock.method(os, 'homedir', () => root);
  const projectDir = path.join(
    root,
    '.claude',
    'projects',
    cwd.replace(/[/.]/g, '-'),
  );
  if (createJsonl) {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${existingSessionId}.jsonl`), '{}\n');
  }
  const spawns = [];
  const p = handshakeProcess({
    appDataDir,
    attachmentBase: path.join(root, 'attachments'),
    tmuxRunner: {
      ...fakeRunner,
      spawn: async (opts) => spawns.push(opts),
    },
  });
  p.sockPath = path.join(root, 'bridge.sock');
  p.sockSecret = 'secret';
  p.claudeSessionId = existingSessionId;
  p._handleStartupDialogs = async () => {};
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = {
    cwd,
    existingSessionId,
    expectedSessionId,
    resumePolicy: 'require-existing-session',
  };
  return { p, opts, spawns };
}

test('strict resume rejects a missing JSONL instead of accepting fresh fallback', async (t) => {
  const { p, opts, spawns } = await exerciseStrictResume(t, { createJsonl: false });

  await assert.rejects(
    p._spawnTmuxClaude({ tmuxName: 'strict', opts }),
    (error) => error.code === 'REQUIRED_SESSION_NOT_FOUND',
  );
  assert.equal(spawns.length, 0);
  assert.equal(p.resumeAttestation, null);
});

test('strict resume requires expectedSessionId to equal the requested existing session', async (t) => {
  const { p, opts, spawns } = await exerciseStrictResume(t, {
    createJsonl: true,
    expectedSessionId: 'different-session',
  });

  await assert.rejects(
    p._spawnTmuxClaude({ tmuxName: 'strict', opts }),
    (error) => error.code === 'REQUIRED_SESSION_MISMATCH',
  );
  assert.equal(spawns.length, 0);
  assert.equal(p.resumeAttestation, null);
});

test('strict resume exposes immutable public attestation for the exact channels session', async (t) => {
  const { p, opts, spawns } = await exerciseStrictResume(t, { createJsonl: true });

  await p._spawnTmuxClaude({ tmuxName: 'strict', opts });

  assert.equal(spawns.length, 1);
  const resumeIndex = spawns[0].args.indexOf('--resume');
  assert.equal(spawns[0].args[resumeIndex + 1], 'resume-session');
  assert.equal(p.resumeAttestation, null);
  assert.deepEqual(p._pendingResumeAttestation, {
    namespace: 'claude:channels',
    sessionId: 'resume-session',
    resumed: true,
    freshFallback: false,
  });
  p._strictExpectedSessionId = 'resume-session';
  p.claudeSessionId = 'resume-session';
  p._resumeAttestation = p._pendingResumeAttestation;
  assert.equal(Object.isFrozen(p.resumeAttestation), true);
  assert.throws(() => {
    p.resumeAttestation.sessionId = 'mutated';
  }, TypeError);
});

test('strict resume finds Claude JSONL when the cwd contains dots', async (t) => {
  const { p, opts, spawns } = await exerciseStrictResume(t, {
    createJsonl: true,
    cwdName: 'workspace.with-dots',
  });

  await p._spawnTmuxClaude({ tmuxName: 'strict', opts });

  assert.equal(spawns.length, 1);
  const resumeIndex = spawns[0].args.indexOf('--resume');
  assert.equal(spawns[0].args[resumeIndex + 1], 'resume-session');
});

test('strict resume publishes attestation only after spawn and handshake succeed', async () => {
  const p = handshakeProcess();
  const attestation = Object.freeze({
    namespace: 'claude:channels',
    sessionId: 'resume-session',
    resumed: true,
    freshFallback: false,
  });
  p._createSocketServer = async () => {};
  p._spawnTmuxClaude = async () => {
    p.claudeSessionId = 'resume-session';
    p._pendingResumeAttestation = attestation;
  };
  p._waitForBridgeHandshake = async () => {};
  p._armHookTail = () => {};
  p._startPingLoop = () => {};
  p._stopStartupPingLoop = () => {};

  await p.start({
    existingSessionId: 'resume-session',
    expectedSessionId: 'resume-session',
    resumePolicy: 'require-existing-session',
  });

  assert.equal(p.resumeAttestation, attestation);
});

test('strict resume never publishes attestation when spawn fails', async () => {
  const p = handshakeProcess();
  p._createSocketServer = async () => {};
  p._spawnTmuxClaude = async () => {
    p._pendingResumeAttestation = Object.freeze({
      namespace: 'claude:channels',
      sessionId: 'resume-session',
      resumed: true,
      freshFallback: false,
    });
    throw new Error('spawn failed');
  };
  p._teardownOnStartFailure = async () => {};

  await assert.rejects(
    p.start({
      existingSessionId: 'resume-session',
      expectedSessionId: 'resume-session',
      resumePolicy: 'require-existing-session',
    }),
    /spawn failed/,
  );
  assert.equal(p.resumeAttestation, null);
});

test('strict resume rejects a bridge-reported different session identity', async () => {
  const p = handshakeProcess();
  p._strictExpectedSessionId = 'expected-session';
  p._pendingResumeAttestation = Object.freeze({
    namespace: 'claude:channels',
    sessionId: 'expected-session',
    resumed: true,
    freshFallback: false,
  });
  const accepted = p._acceptBridgeSessionId('different-session');

  assert.equal(accepted, false);
  assert.equal(p.resumeAttestation, null);
  assert.equal(p._pendingResumeAttestation, null);
  assert.equal(p._bridgeHandshakeCancellationError.code, 'REQUIRED_SESSION_MISMATCH');
});

test('clean restart retirement attempts every containment cleanup after tmux failure', async () => {
  const events = [];
  const { p } = activeCleanRestartProcess({
    tmuxRunner: {
      ...fakeRunner,
      killSession: async () => {
        events.push('tmux');
        throw new Error('tmux failed');
      },
    },
  });
  p.bridgeServer.close = async () => events.push('bridge');
  p._hookTail.drain = async () => events.push('drain');
  p._hookTail.close = () => events.push('tail-close');

  await assert.rejects(
    p.retireForCleanRestart({
      getDeliveryEvidence: async () => ({ outputAttempted: false, pending: 0, fenced: true }),
    }),
    (error) => error.code === 'CLEAN_RESTART_RETIREMENT_FAILED',
  );

  assert.deepEqual(events.slice(0, 4), ['tmux', 'bridge', 'drain', 'tail-close']);
  assert.equal(p.closed, true);
});

test('reply arriving after the clean-restart fence is blocked and sticky-marks output evidence', async () => {
  let dispatches = 0;
  const { p, turnId } = activeCleanRestartProcess({
    toolDispatcher: async () => {
      dispatches++;
      return { ok: true };
    },
  });
  const acknowledgements = [];
  p._writeToBridge = message => {
    acknowledgements.push(message);
    return true;
  };
  p._cleanRestartOutputFenced = true;

  await p._dispatchToolCall({
    kind: 'tool',
    name: 'reply',
    tool_call_id: 'reply-after-fence',
    args: {
      chat_id: '1',
      turn_id: turnId,
      text: 'must not deliver',
    },
  });

  assert.equal(dispatches, 0);
  assert.equal(p.pendingTurns.get(turnId).outputAttempted, true);
  assert.equal(p._cleanRestartEvidenceLost, true);
  assert.equal(acknowledgements[0].ok, false);
  assert.equal(p._classifyCleanRestart({
    outputAttempted: false,
    pending: 0,
    fenced: true,
  })[0], 'prior-output');
});

test('delivery-evidence rejection still runs every containment cleanup', async () => {
  const events = [];
  const { p } = activeCleanRestartProcess({
    tmuxRunner: {
      ...fakeRunner,
      killSession: async () => events.push('tmux'),
    },
  });
  p.bridgeServer.close = async () => events.push('bridge');
  p._hookTail.drain = async () => events.push('drain');
  p._hookTail.close = () => events.push('tail-close');

  await assert.rejects(
    p.retireForCleanRestart({
      getDeliveryEvidence: async (sessionKey, sourceMsgId) => {
        assert.deepEqual([sessionKey, sourceMsgId], ['handshake', 42]);
        throw new Error('registry failed');
      },
    }),
    (error) => error.code === 'CLEAN_RESTART_RETIREMENT_FAILED',
  );

  assert.deepEqual(events.slice(0, 4), ['tmux', 'bridge', 'drain', 'tail-close']);
  assert.equal(p.closed, true);
});

test('Claude 2.1.220 MCP registration keeps a thirty-second readiness window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = handshakeProcess();
  p.bridgeReady = true;
  p.bridgeServer = new EventEmitter();

  assert.equal(p.mcpReadyTimeoutMs, 30_000);
  const outcome = p._waitForBridgeHandshake().then(
    () => 'resolved',
    () => 'rejected',
  );
  t.mock.timers.tick(5_001);
  p.mcpReady = true;
  p.emit('mcp-ready');

  assert.equal(await outcome, 'resolved');

  const timedOut = handshakeProcess();
  timedOut.bridgeReady = true;
  timedOut.bridgeServer = new EventEmitter();
  const timeout = timedOut._waitForBridgeHandshake();
  t.mock.timers.tick(30_000);
  await assert.rejects(
    timeout,
    (error) => error.code === 'CHANNELS_MCP_READY_TIMEOUT',
  );
  assert.equal(timedOut.listenerCount('mcp-ready'), 0);
  assert.equal(timedOut.bridgeServer.listenerCount('bridge-disconnected'), 0);
});

test('startup ping keeps an authenticated bridge alive before MCP readiness', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const p = handshakeProcess();
  const writes = [];
  p._writeToBridge = (message) => {
    writes.push(message);
    return true;
  };

  p._startStartupPingLoop();
  assert.deepEqual(writes, [{ kind: 'ping' }]);
  t.mock.timers.tick(10_000);
  assert.deepEqual(writes, [{ kind: 'ping' }, { kind: 'ping' }]);

  p._stopStartupPingLoop();
  assert.equal(p.startupPingTimer, null);
  t.mock.timers.tick(10_000);
  assert.equal(writes.length, 2);
});

test('bridge disconnect rejects MCP readiness immediately and cleans listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = handshakeProcess();
  p.bridgeReady = true;
  p.bridgeServer = new EventEmitter();
  const pending = p._waitForBridgeHandshake();

  p.bridgeServer.emit('bridge-disconnected');
  t.mock.timers.tick(30_000);

  await assert.rejects(
    pending,
    (error) => error.code === 'BRIDGE_DISCONNECTED',
  );
  assert.equal(p.listenerCount('bridge-ready'), 0);
  assert.equal(p.listenerCount('mcp-ready'), 0);
  assert.equal(p.bridgeServer.listenerCount('bridge-disconnected'), 0);

  const alreadyLost = handshakeProcess();
  alreadyLost.bridgeServer = new EventEmitter();
  alreadyLost._bridgeDisconnecting = true;
  let alreadyLostOutcome = null;
  alreadyLost._waitForBridgeHandshake().then(
    () => { alreadyLostOutcome = 'resolved'; },
    () => { alreadyLostOutcome = 'rejected'; },
  );
  await Promise.resolve();
  assert.equal(alreadyLostOutcome, 'rejected');
});

test('kill and reset cancel pending MCP readiness and detach its bridge listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  for (const lifecycle of ['kill', 'reset']) {
    const p = handshakeProcess();
    const bridge = new EventEmitter();
    bridge.close = async () => {};
    p.bridgeReady = true;
    p.bridgeServer = bridge;
    const pending = p._waitForBridgeHandshake();

    if (lifecycle === 'kill') {
      await p.kill('test shutdown');
    } else {
      await p.resetSession({ reason: 'test reset' });
    }
    t.mock.timers.tick(30_000);

    await assert.rejects(
      pending,
      (error) => error.code === (lifecycle === 'kill' ? 'KILLED' : 'RESET'),
    );
    assert.equal(p.listenerCount('bridge-ready'), 0);
    assert.equal(p.listenerCount('mcp-ready'), 0);
    assert.equal(bridge.listenerCount('bridge-disconnected'), 0);
  }
});

test('start retains kill and reset cancellation while Claude spawn is pending', async () => {
  for (const lifecycle of ['kill', 'reset']) {
    let releaseSpawn;
    let markSpawnEntered;
    const spawnEntered = new Promise((resolve) => {
      markSpawnEntered = resolve;
    });
    const spawnGate = new Promise((resolve) => {
      releaseSpawn = resolve;
    });
    const p = handshakeProcess({ mcpReadyTimeoutMs: 10 });
    p._createSocketServer = async () => {
      const bridge = new EventEmitter();
      bridge.close = async () => {};
      p.bridgeServer = bridge;
    };
    p._spawnTmuxClaude = async () => {
      markSpawnEntered();
      await spawnGate;
    };

    const started = p.start();
    await spawnEntered;
    if (lifecycle === 'kill') {
      await p.kill('test shutdown during spawn');
    } else {
      await p.resetSession({ reason: 'test reset during spawn' });
    }
    releaseSpawn();

    await assert.rejects(
      started,
      (error) => error.code === (lifecycle === 'kill' ? 'KILLED' : 'RESET'),
    );
  }
});

test('CliProcess.respondToPermission validates behavior arg', async () => {
  const p = new CliProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.respondToPermission('abcde', 'maybe'),
    /'allow' or 'deny'/,
  );
});

test('CliProcess.send rejects on unstarted instance', async () => {
  const p = new CliProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.send('hello'),
    /bridge not ready/,
  );
});

// 0.12: pm:'channels' is now an alias for pm:'cli' (the canonical post-0.12
// backend name). pickBackend resolves the alias and emits a once-per-process
// deprecation warn. These tests assert the alias resolves to 'cli'.

test('pickBackend resolves channels alias → cli via chatConfig.pm', () => {
  factory._resetAliasWarnings();
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: () => {} } }), 'cli');
});

test('pickBackend resolves channels alias → cli via topicConfig.pm overriding chat', () => {
  factory._resetAliasWarnings();
  const cfg = {
    chats: {
      '12345': {
        pm: 'sdk',
        topics: { '7': { pm: 'channels' } },
      },
    },
  };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: '7', logger: { warn: () => {} } }), 'cli');
});

test('pickBackend resolves channels alias → cli via bot.pm default', () => {
  factory._resetAliasWarnings();
  const cfg = { bot: { pm: 'channels' } };
  assert.equal(pickBackend({ config: cfg, chatId: '99', threadId: null, logger: { warn: () => {} } }), 'cli');
});

test('pickBackend emits once-per-process deprecation warn on channels alias', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  assert.equal(warns.length, 1, 'should warn exactly once for repeated calls');
  assert.match(warns[0], /'channels' is deprecated/);
});

// 0.12 Phase 4.5.3 (R12 mitigation tests). Operators migrating from
// pm:'tmux' to the cli alias without setting permissionMode silently lose
// approval gating. The R12 warning surfaces this as a deliberate trade-off.

test('R12: pm:"tmux" alias WITHOUT permissionMode emits per-chat migration warning', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'tmux' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  assert.equal(warns.length, 2, 'should emit BOTH deprecation alias warn AND R12 migration warn');
  assert.ok(warns.some(w => /'tmux' is deprecated/.test(w)), 'alias deprecation warn');
  assert.ok(warns.some(w => /R12 migration warning/.test(w)), 'R12 migration warn');
  assert.ok(warns.some(w => /permissionMode/.test(w)), 'R12 warn mentions permissionMode opt-in');
});

test('R12: pm:"tmux" alias WITH permissionMode:"default" suppresses R12 warn', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'tmux', permissionMode: 'default' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  // Alias deprecation still fires; R12 should NOT.
  assert.ok(warns.some(w => /'tmux' is deprecated/.test(w)));
  assert.ok(!warns.some(w => /R12 migration warning/.test(w)),
    'R12 must not fire when operator explicitly opted into a non-bypass mode');
});

test('R12: pm:"channels" alias (which had no implicit approvals) does NOT fire R12 warn', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  // Channels alias deprecation fires; R12 should NOT — channels backend in 0.11
  // also had bypassPermissions default, so there's no UX regression to warn about.
  assert.ok(warns.some(w => /'channels' is deprecated/.test(w)));
  assert.ok(!warns.some(w => /R12 migration warning/.test(w)));
});

test('R12: warning is per-chat-tuple — different chats each warn once', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '111': { pm: 'tmux' }, '222': { pm: 'tmux' } } };
  pickBackend({ config: cfg, chatId: '111', threadId: null, logger: { warn: msg => warns.push(msg) } });
  pickBackend({ config: cfg, chatId: '222', threadId: null, logger: { warn: msg => warns.push(msg) } });
  pickBackend({ config: cfg, chatId: '111', threadId: null, logger: { warn: msg => warns.push(msg) } });
  // Alias warn fires once (process-wide). R12 fires once per chat.
  const aliasWarns = warns.filter(w => /'tmux' is deprecated/.test(w));
  const r12Warns = warns.filter(w => /R12 migration warning/.test(w));
  assert.equal(aliasWarns.length, 1, 'alias warn is process-wide-once');
  assert.equal(r12Warns.length, 2, 'R12 warn fires once per (chatId, threadId) tuple');
});

test('factory falls back to sdk when channels wiring incomplete', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const logger = { warn: msg => warns.push(msg) };
  const cfg = { bot: { pm: 'channels' } };

  // Missing toolDispatcher + channelsClaudeBin
  const f = createProcessFactory({
    config: cfg,
    spawnFn: () => ({}),
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    logger,
  });

  const proc = f('sess-1', { chatId: '99' });
  assert.equal(proc.backend, 'sdk', 'falls back to SDK');
  // 0.12: two warns expected — alias deprecation AND wiring-incomplete.
  // No R12 warn (channels alias doesn't trigger R12; that's tmux-only).
  assert.equal(warns.length, 2, 'logged 2 warnings (alias deprecation + wiring-incomplete fallback)');
  assert.ok(warns.some(w => /'channels' is deprecated/.test(w)), 'alias deprecation warn');
  const wiringWarn = warns.find(w => /toolDispatcher/.test(w));
  assert.ok(wiringWarn, 'wiring-incomplete warn');
  assert.match(wiringWarn, /pm:'cli'/);
  assert.match(wiringWarn, /channelsClaudeBin/);

  // cleanup — SdkProcess construction may have spun up internals
  proc.kill?.('test-cleanup').catch(() => {});
});

test('factory constructs CliProcess when fully wired', () => {
  const cfg = { bot: { pm: 'channels' } };
  const factory = createProcessFactory({
    config: cfg,
    spawnFn: () => ({}),
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  const proc = factory('sess-2', { chatId: '99' });
  assert.equal(proc.backend, 'cli');
  assert.equal(proc.cost, 3);
});

test('factory forwards an executable session launcher to CliProcess', () => {
  const launcher = process.execPath;
  const factory = createProcessFactory({
    config: { bot: { pm: 'cli' } },
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    sessionLauncher: launcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  const proc = factory('launcher-session', { chatId: '99' });
  assert.equal(proc.sessionLauncher, launcher);
});

test('CliProcess rejects relative, missing, non-executable, and directory session launchers', () => {
  const common = {
    sessionKey: 'launcher-validation', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
  };

  assert.throws(
    () => new CliProcess({ ...common, sessionLauncher: 'claude-session-scope' }),
    err => err.code === 'SESSION_LAUNCHER_INVALID' && /absolute/.test(err.message),
  );
  assert.throws(
    () => new CliProcess({ ...common, sessionLauncher: '/definitely/missing/launcher' }),
    err => err.code === 'SESSION_LAUNCHER_INVALID' && /executable/.test(err.message),
  );
  assert.throws(
    () => new CliProcess({ ...common, sessionLauncher: os.tmpdir() }),
    err => err.code === 'SESSION_LAUNCHER_INVALID' && /executable file/.test(err.message),
  );

  const nonExecutable = path.join(os.tmpdir(), `orchestra-launcher-${process.pid}`);
  fs.writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  try {
    assert.throws(
      () => new CliProcess({ ...common, sessionLauncher: nonExecutable }),
      err => err.code === 'SESSION_LAUNCHER_INVALID' && /executable/.test(err.message),
    );
  } finally {
    fs.unlinkSync(nonExecutable);
  }
});

// Review AC3: pickBackend warns + falls back on unknown pm value (typo path)
test('pickBackend warns and falls back to sdk on unknown pm value', () => {
  const warns = [];
  const cfg = { bot: { pm: 'channel' } };  // singular typo
  const got = pickBackend({ config: cfg, chatId: '99', threadId: null, logger: { warn: m => warns.push(m) } });
  assert.equal(got, 'sdk');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /unknown pm value 'channel'/);
  assert.match(warns[0], /falling back to 'sdk'/);
});

// Review #11: tmux session name carries the orchestra-${botName}- prefix so
// orphan-sweep (lib/tmux/orphan-sweep.js) finds channels sessions at boot.
test('CliProcess.start tmux session name uses polygram- prefix for orphan-sweep', async () => {
  const calls = [];
  const runner = {
    spawn: async opts => { calls.push(opts); },
    killSession: async () => {},
    sendControl: async () => {},
    captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
  };
  // We need a fake bridge that handshakes so start() resolves. Quickest path:
  // tap into _createSocketServer to discover sockPath, connect a node net
  // client, then send hello+session_init.
  const net = require('node:net');
  const p = new CliProcess({
    sessionKey: 'sess-prefix', chatId: '111', threadId: null, label: 'prefix-test',
    tmuxRunner: runner,
    botName: 'shumorobot',
    claudeBin: '/usr/bin/true',
    toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    handshakeTimeoutMs: 2000,
  });
  const startP = p.start();
  // Wait until socket appears
  for (let i = 0; i < 50 && (!p.sockPath || !require('fs').existsSync(p.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  // Connect fake bridge
  const sock = net.connect(p.sockPath);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
  // 0.12 Phase 1.6: also synthesize the mcp-ready signal that real bridges
  // emit on first claude ListToolsRequest. Without it, _waitForBridgeHandshake
  // would block until the configured mcp-ready timeout.
  sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
  await startP;
  assert.equal(calls.length, 1);
  assert.match(calls[0].name, /^orchestra-shumorobot-channels-/, `tmux name should start with orchestra-<botName>-channels- but got '${calls[0].name}'`);
  sock.end();
  await p.kill('test');
});

// Review #8: respondToPermission idempotent — second call for the same
// request_id is dropped (no second perm_verdict).
test('respondToPermission is idempotent — second call dropped', async () => {
  const warns = [];
  const p = new CliProcess({
    sessionKey: 'sess-idemp', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: m => warns.push(m), error: () => {}, log: () => {} },
  });
  const writes = [];
  p._writeToBridge = (obj) => writes.push(obj);

  await p.respondToPermission('req-abc', 'allow');
  await p.respondToPermission('req-abc', 'deny');     // should be dropped

  assert.equal(writes.length, 1, 'only first verdict written');
  assert.equal(writes[0].behavior, 'allow');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /duplicate for request_id=req-abc/);
});

// P1 #9: socket created with mode 0o600 from inode birth (no TOCTOU window
// between listen() and chmod). Verified by reading the mode AFTER listen but
// BEFORE the explicit chmod has run — which means we observe the umask-derived
// mode. Integration test "start() completes after fake bridge handshakes"
// already asserts `mode = 0o600`; this is a lighter unit test that the umask
// wrap is in place in the (post-M1-refactor) ChannelsBridgeServer.
test('P1 #9: ChannelsBridgeServer wraps listen() in restrictive umask', () => {
  assert.ok(
    require('node:fs').readFileSync(
      require.resolve('../lib/process/channels-bridge-server'), 'utf8',
    ).match(/process\.umask\(0o077\)/),
    'P1 #9: process.umask(0o077) wraps listen() in channels-bridge-server.js',
  );
});

// Parity audit P4 + P7 + P8 — agent / topic-precedence / --resume.

async function captureSpawnArgs(constructorOpts, startOpts, { includeProcess = false } = {}) {
  const spawnedArgs = [];
  const runner = {
    spawn: async opts => { spawnedArgs.push(...opts.args); },
    killSession: async () => {},
    sendControl: async () => {},
    captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
  };
  const fs = require('node:fs');
  const net = require('node:net');
  const p = new CliProcess({
    sessionKey: 'sess-x',
    chatId: '1', threadId: null, label: 'parity-test',
    tmuxRunner: runner, botName: 'b',
    toolDispatcher: fakeDispatcher,
    claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    handshakeTimeoutMs: 2000,
    ...constructorOpts,
  });
  const startP = p.start(startOpts || {});
  for (let i = 0; i < 50 && (!p.sockPath || !fs.existsSync(p.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const sock = net.connect(p.sockPath);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
  sock.write(JSON.stringify({
    kind: 'session_init',
    claude_session_id: startOpts?.expectedSessionId || 'test-sid',
  }) + '\n');
  // 0.12 Phase 1.6: also synthesize the mcp-ready signal that real bridges
  // emit on first claude ListToolsRequest. Without it, _waitForBridgeHandshake
  // would block until the configured mcp-ready timeout.
  sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
  await startP;
  const resumeAttestation = p.resumeAttestation;
  sock.end();
  await p.kill('test');
  return includeProcess ? { spawnedArgs, resumeAttestation } : spawnedArgs;
}

test('P4 parity: --agent flag passed when chatConfig.agent set', async () => {
  const args = await captureSpawnArgs({}, { chatConfig: { agent: 'music-curation' } });
  const agentIdx = args.indexOf('--agent');
  assert.ok(agentIdx >= 0, 'has --agent flag');
  assert.equal(args[agentIdx + 1], 'music-curation');
});

test('P7 parity: topicConfig.agent overrides chatConfig.agent', async () => {
  const args = await captureSpawnArgs({ threadId: '42' }, {
    threadId: '42',
    chatConfig: {
      agent: 'fallback',
      topics: { '42': { agent: 'topic-special' } },
    },
  });
  const agentIdx = args.indexOf('--agent');
  assert.equal(args[agentIdx + 1], 'topic-special');
});

test('P5 parity: --effort flag passed when set', async () => {
  const args = await captureSpawnArgs({}, { chatConfig: { effort: 'high' } });
  const effortIdx = args.indexOf('--effort');
  assert.ok(effortIdx >= 0);
  assert.equal(args[effortIdx + 1], 'high');
});

// rc.8 ghost-session guard: --resume is only passed when the session
// JSONL actually exists under the launch cwd. If polygram's DB has a
// session id but claude doesn't have the file (because an early channels
// attempt failed before claude completed any turn), drop the ghost and
// use --session-id with a fresh uuid. Live shumorobot Music topic
// 2026-05-26 04:04:29 reproduced this exact ghost-session stall.

test('rc.8: --resume used when existingSessionId set AND session file exists on disk', async () => {
  // Stage a fake session JSONL at the path claude indexes by cwd.
  // resolvedCwd → ~/.claude/projects/<cwd-mangled>/<id>.jsonl
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rc8-resume-'));
  const sid = 'prior-sid-with-file';
  const projectsDir = path.join(os.homedir(), '.claude', 'projects', testCwd.replace(/\//g, '-'));
  fs.mkdirSync(projectsDir, { recursive: true });
  const sidFile = path.join(projectsDir, `${sid}.jsonl`);
  fs.writeFileSync(sidFile, '{"role":"user","content":"hi"}\n');
  try {
    const args = await captureSpawnArgs({}, {
      existingSessionId: sid,
      chatConfig: { cwd: testCwd },
    });
    const resumeIdx = args.indexOf('--resume');
    assert.ok(resumeIdx >= 0, 'has --resume when file exists');
    assert.equal(args[resumeIdx + 1], sid);
    assert.equal(args.indexOf('--session-id'), -1,
      '--session-id NOT present when --resume is in effect');
  } finally {
    fs.rmSync(sidFile, { force: true });
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmdirSync(testCwd);
  }
});

test('strict resume attestation follows the real spawn and bridge handshake path', async () => {
  const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-integration-'));
  const sid = 'strict-integrated-session';
  const projectsDir = path.join(os.homedir(), '.claude', 'projects', testCwd.replace(/\//g, '-'));
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, `${sid}.jsonl`), '{}\n');
  try {
    const { spawnedArgs, resumeAttestation } = await captureSpawnArgs({}, {
      cwd: testCwd,
      existingSessionId: sid,
      expectedSessionId: sid,
      resumePolicy: 'require-existing-session',
    }, { includeProcess: true });
    assert.equal(spawnedArgs[spawnedArgs.indexOf('--resume') + 1], sid);
    assert.deepEqual(resumeAttestation, {
      namespace: 'claude:channels',
      sessionId: sid,
      resumed: true,
      freshFallback: false,
    });
    assert.equal(Object.isFrozen(resumeAttestation), true);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(testCwd, { recursive: true, force: true });
  }
});

test('rc.8: ghost-session guard — DB id with no local file falls back to --session-id', async () => {
  // No fixture file created — simulates the live Music-topic ghost
  // (DB has session id from a failed prior channels attempt; claude
  // never persisted the JSONL).
  const args = await captureSpawnArgs({}, {
    existingSessionId: 'ghost-sid-no-file',
    chatConfig: { cwd: '/tmp/path-that-does-not-have-a-jsonl-fixture' },
  });
  assert.equal(args.indexOf('--resume'), -1,
    'ghost session must NOT be resumed (file does not exist)');
  assert.ok(args.indexOf('--session-id') >= 0,
    'fresh --session-id used when ghost id is dropped');
});

test('rc.8: ghost-session guard fires even with no cwd (can\'t check → don\'t resume)', async () => {
  const args = await captureSpawnArgs({}, { existingSessionId: 'sid-no-cwd' });
  assert.equal(args.indexOf('--resume'), -1,
    'no cwd → can\'t verify file → safer to NOT --resume');
  assert.ok(args.indexOf('--session-id') >= 0);
});

test('P8 parity: --session-id used when NO existingSessionId (fresh session)', async () => {
  const args = await captureSpawnArgs({}, {});
  // For fresh sessions, --session-id is correct (claude generates the id we pass)
  assert.ok(args.indexOf('--session-id') >= 0, 'fresh session uses --session-id');
  assert.equal(args.indexOf('--resume'), -1, 'no --resume on fresh');
});

// rc.7 (2026-05-26): channels-mode spawn carries a SINGLE
// --append-system-prompt block combining the Telegram display rules AND
// the channels-mode reply-tool contract. Originally two separate flags
// (rc.6) — but that broke MCP server registration, suspected
// --append-system-prompt variadic greedy-eating --setting-sources and
// --mcp-config. Merging into one block sidesteps it.
test('rc.7: channels-mode spawn has ONE --append-system-prompt with both display + channels hints', async () => {
  const args = await captureSpawnArgs({ displayHint: 'ORCHESTRA_DISPLAY_MARKER Tables — HARD RULE' }, {});
  const appendIdxs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--append-system-prompt') appendIdxs.push(i);
  }
  assert.equal(appendIdxs.length, 1,
    'EXACTLY ONE --append-system-prompt — multiple instances break --mcp-config arg parsing');
  const hint = args[appendIdxs[0] + 1];
  // Display half (ORCHESTRA_DISPLAY_HINT content)
  assert.match(hint, /ORCHESTRA_DISPLAY_MARKER|Tables — HARD RULE/i,
    'block contains the injected display hint');
  // Channels half (reply-tool contract)
  assert.match(hint, /channels mode/i, 'block mentions channels mode');
  assert.match(hint, /mcp__orchestra-bridge__reply/, 'mentions the exact tool name');
  assert.match(hint, /HARD CONTRACT|MUST/i, 'reply-tool directive is unambiguous');
  assert.match(hint, /Do NOT respond conversationally|inline text will/i,
    'explicitly tells claude not to respond inline');
  // 2026-06-08 wedge mitigation: AskUserQuestion / interactive menus open a
  // blocking TUI widget the channel can't answer → session parks. The prompt
  // must forbid it (numbered-list-in-reply instead). REMOVE this assertion when
  // the rich question→Telegram-keyboard feature ships (deliberate, not forgotten).
  assert.match(hint, /NEVER use the AskUserQuestion tool/i,
    'forbids the interactive AskUserQuestion widget (wedge mitigation)');
  // 0.12.2 autosteer-fold fix (docs/0.13-autosteer-fold-drop-spec.md): the
  // consumed_turn_ids contract is strengthened to cut the ~8.9% miss rate that
  // produced false `input-fold-suspected` drops. These assertions fail on the
  // pre-0.12.2 prompt (which lacked the every-reply / short / two-id emphasis).
  assert.match(hint, /consumed_turn_ids/, 'states the consumed_turn_ids fold-ack contract');
  assert.match(hint, /EVERY reply|short one-line/i,
    'contract emphasizes it applies to EVERY reply incl short ones (the fold-miss case)');
  assert.match(hint, /both turn_ids/i,
    'contract gives the two-id fold example so a folded follow-up is not omitted');
  // #9 progressive-status restore (docs/0.13-progressive-status-prompt-spec.md):
  // strengthen the long-task responsiveness contract. The invariant that must
  // survive every rewrite: an edit carries no consumed_turn_ids and does not
  // notify, so a final answer delivered as an edit would re-open the fold-drop
  // bug. What an edit MAY carry has since widened (below); what it may never
  // be is the answer.
  // Scoped to the section that carries the edit contract, and whitespace-
  // normalized. `reply(files` in particular appears in the file-send directive
  // further down, so an unscoped assertion would pass on that one and prove
  // nothing about this section.
  const progressSection = hint
    .slice(hint.indexOf('### Staying responsive on a long task'))
    .split(/\n### /)[0]
    .replace(/\s+/g, ' ');
  assert.match(progressSection, /NEVER delivers the final answer|never the final answer/i,
    'edit_message updates work in progress, never the turn\'s answer');
  assert.match(progressSection, /FINAL answer as a fresh `?reply/i,
    'the final answer must be a fresh reply (notifies + carries consumed_turn_ids)');
  // An edit re-renders the bubble through the same pipeline the original reply
  // used, so a rich chat re-renders an edited checklist rich. That makes
  // ticking items off in place the canonical progress idiom — the whole reason
  // the daemon-side feature exists — and the prompt has to actually say so, or
  // the agent keeps treating checkboxes as decoration.
  assert.match(progressSection, /- \[x\]/i, 'shows the checked-item syntax an update re-sends');
  assert.match(progressSection, /check items off|tick(ing)? (them|items) off/i,
    'names checking items off as the canonical progressive-update idiom');
  // 2026-07-29 live failure: the agent posted the plan checklist and ENDED the
  // turn waiting for approval; the user had to say "do it" before any work (or
  // any ticking) happened. The contract must make the plan a progress display,
  // not a proposal — and the checklist the FIRST action of multi-step work, in
  // the same hard register that fixed reply adoption.
  assert.match(progressSection, /FIRST visible action MUST/i,
    'the plan checklist must be the first visible action of multi-step work');
  assert.match(progressSection, /NOT a stopping point/i,
    'posting the plan must not end the turn awaiting approval');
  assert.match(progressSection, /after EVERY step|after each one/i,
    'ticking happens after every completed step, not at the end');
  assert.match(progressSection, /CONTRACT VIOLATION/i,
    'silent work then a dump is named a contract violation, not a style choice');
  // The in-progress marker: trailing, single, at line END — a leading marker
  // would break the checkbox column alignment (user-specified placement).
  assert.match(progressSection, /trailing hourglass|END of that line/i,
    'the current-item marker is specified as TRAILING, never leading');
  assert.match(progressSection, /⏳/, 'shows the literal marker the agent should use');
  assert.match(progressSection, /Exactly one item/i,
    'only one item may carry the marker at a time');
  // 2026-07-30 live failure: the agent worked a 5-item checklist, delivered the
  // final report, and ended the turn with the bubble frozen at 4/5 — the last
  // item still unticked and still carrying ⏳. "Tick after every step" never
  // said the checklist must be CLOSED OUT, so the user was left looking at work
  // that reads as abandoned one item from the end.
  assert.match(progressSection, /final answer COMPLETES the last step|completes the last step/i,
    'delivering the final answer IS the completion of the last step');
  assert.match(progressSection, /zero ⏳|no ⏳|all `?- \[x\]`?, zero/i,
    'pins the checklist\'s required final state: everything checked, marker gone');
  assert.match(
    progressSection,
    /ends with a lingering ⏳.{0,90}CONTRACT VIOLATION/i,
    'a turn ending on a leftover in-progress marker is named a CONTRACT VIOLATION');
  // The close-out rule must not force a lie. If work stops early — a step fails,
  // is skipped, or is blocked — "tick everything or be a named violation" leaves
  // only two moves, and a model that obeys hard contracts will tick the lie.
  // The unfinished item stays unticked and says WHY; the marker is what must go.
  assert.match(progressSection, /NEVER tick an item you did not|MUST NOT be ticked/i,
    'ticking work that was not actually completed is forbidden outright');
  assert.match(progressSection, /name the reason|leave that item unticked/i,
    'stopping early still closes out: marker gone, item unticked, reason on the line');
  // Same live test: the final report used `- [ ]` for RECOMMENDATIONS addressed
  // to the user ("decide the fate of X", "you could clean up Y") — items the
  // agent will never close, in the same document where other recommendations
  // were plain bullets. A checkbox is a commitment to tick it, not decoration:
  // user-facing items masquerading as checkboxes also make the close-out rule
  // above impossible to satisfy honestly.
  assert.match(progressSection, /EXCLUSIVELY for your own work/i,
    'checkboxes are reserved for the agent\'s own work items');
  assert.match(progressSection, /commit(ment|ting) to tick it/i,
    'writing a checkbox is stated as a commitment to tick it yourself');
  // The production misuse was in the FINAL REPORT, not the progress checklist,
  // so the rule has to say out loud that it is not scoped to the checklist.
  assert.match(progressSection, /EVERY message you send.{0,40}final answer/i,
    'the ownership rule covers every message, the final answer included');
  assert.match(progressSection, /addressed to the USER/i,
    'names the misuse case: items aimed at the user');
  assert.match(progressSection, /recommendation/i,
    'recommendations are the observed misuse and are named as such');
  assert.match(progressSection, /plain bullet/i,
    'user-facing recommendations must be plain bullets, never checkboxes');
  assert.match(progressSection, /re-?render/i, 'states that an edit re-renders (rich stays rich)');
  assert.match(progressSection, /whole list|full list|entire list/i,
    'an edit REPLACES the body, so a partial re-send would lose the rest of the list');
  // Caps stated honestly rather than "keep it short": the agent cannot see the
  // chat's richText setting, so it needs both numbers and the fact that the
  // tool reports which one applied.
  assert.match(progressSection, /4,?000/, 'states the plain single-bubble cap');
  assert.match(progressSection, /32,?000/, 'states the larger rich cap');
  // Reply and edit are NOT at parity, and prose that implies they are earns an
  // agent that tries to attach a file by editing. Structure re-renders; media
  // does not travel through an edit at all.
  assert.match(progressSection, /TEXT-ONLY|text only/i, 'an edit renders text, not media');
  assert.match(progressSection, /reply\(files/i, 'names the tool that DOES carry media');
  assert.match(progressSection, /in a chat that renders rich|chat that renders rich/i,
    'rich re-rendering is per-chat — an unqualified promise is one the daemon may not keep');
  assert.match(hint, /one or two tool calls, just answer/i,
    'over-trigger guard: quick tasks get one reply, no status bubble');
  // File-send directive (2026-06-16): the agent was curling the Bot API to send
  // files (it has the token), landing them in the WRONG topic — because the old
  // wording claimed curl "fails" (false: it succeeds, just wrong-topic), so the
  // agent disproved it and ignored it. The instruction must give the TRUE reason
  // (wrong topic) and pre-empt the "but the upload returned 200" rationalization.
  assert.match(hint, /reply\(files/i, 'names reply(files) as the file-send tool');
  assert.match(hint, /wrong topic/i,
    'file-send directive states the TRUE consequence (wrong topic), not the false "those fail"');
  assert.doesNotMatch(hint, /to send files — those fail/i,
    'the disprovable "those fail" rationale must not return (agent empirically ignores it)');
});

// rc.7: --mcp-config must remain the LAST flag in args (variadic <configs...>)
// to avoid the variadic flag eating subsequent args. Regression guard for
// the bug where two --append-system-prompt flags broke MCP registration.
test('rc.7: --mcp-config is the LAST flag in claudeArgs (variadic safety)', async () => {
  const args = await captureSpawnArgs({}, {});
  const mcpIdx = args.indexOf('--mcp-config');
  assert.ok(mcpIdx >= 0, '--mcp-config present');
  // After the mcp-config value there should be no more flags.
  // Allowed: only the value immediately following.
  for (let i = mcpIdx + 2; i < args.length; i++) {
    assert.ok(!args[i].startsWith('--'),
      `found flag '${args[i]}' AFTER --mcp-config <path>; --mcp-config is variadic and will eat it`);
  }
});

// rc.9 (2026-05-26): channels backend defaults to permissionMode='bypassPermissions'.
// Without it, claude TUI shows the interactive permission prompt for every
// mcp__orchestra-bridge__reply call — channels mode has no interactive surface
// to answer it, so every first turn hangs until the 30-min turn timeout. The
// reproducing spike is scripts/spikes/channels-first-turn.mjs.
test('channels backend defaults to bypassPermissions (rc.9: first-turn-dead-zone fix)', async () => {
  const net = require('node:net');
  const fs = require('node:fs');

  // Helper: start with given permissionMode, fake-bridge handshake, capture spawn args, kill.
  async function captureSpawnArgs(permissionMode) {
    const spawnedArgs = [];
    const runner = {
      spawn: async opts => { spawnedArgs.push(...opts.args); },
      killSession: async () => {},
      sendControl: async () => {},
      captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
    };
    const p = new CliProcess({
      sessionKey: `sess-${permissionMode || 'default'}`,
      chatId: '1', tmuxRunner: runner, botName: 'b',
      toolDispatcher: fakeDispatcher,
      claudeBin: '/usr/bin/echo',
      logger: { warn: () => {}, error: () => {}, log: () => {} },
      handshakeTimeoutMs: 2000,
    });
    const startP = p.start({ permissionMode });
    for (let i = 0; i < 50 && (!p.sockPath || !fs.existsSync(p.sockPath)); i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    const sock = net.connect(p.sockPath);
    await new Promise(r => sock.once('connect', r));
    sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
    sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
    // Synthesize mcp-ready so _waitForBridgeHandshake does not wait for its timeout.
    sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
    await startP;
    sock.end();
    await p.kill('test');
    return spawnedArgs;
  }

  // rc.9: with NO permissionMode override, the default is bypassPermissions —
  // the only mode that lets a fresh-spawn channels turn actually reply.
  const defaultArgs = await captureSpawnArgs(undefined);
  assert.ok(defaultArgs.includes('--dangerously-skip-permissions'),
    'default channels mode: skip-permissions flag is on (no interactive surface)');
  assert.deepEqual(
    defaultArgs.slice(defaultArgs.indexOf('--permission-mode'), defaultArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'bypassPermissions'],
    'default channels mode: permission-mode=bypassPermissions');

  // Explicit bypassPermissions still works (idempotent with default).
  const bypassArgs = await captureSpawnArgs('bypassPermissions');
  assert.ok(bypassArgs.includes('--dangerously-skip-permissions'),
    'explicit bypassPermissions: skip-permissions flag still present');
  assert.deepEqual(
    bypassArgs.slice(bypassArgs.indexOf('--permission-mode'), bypassArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'bypassPermissions'],
    'explicit bypassPermissions: permission-mode flag carries the value');

  // Explicit non-bypass override is honored — chat owner can opt out of the
  // default if they actually want a different permission mode wired up.
  const acceptEditsArgs = await captureSpawnArgs('acceptEdits');
  assert.ok(!acceptEditsArgs.includes('--dangerously-skip-permissions'),
    'acceptEdits override: skip-permissions NOT added');
  assert.deepEqual(
    acceptEditsArgs.slice(acceptEditsArgs.indexOf('--permission-mode'), acceptEditsArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'acceptEdits'],
    'acceptEdits override: permission-mode carries the override value');
});

// rc.5: launch cwd MUST be the resolved topic/chat cwd, not opts.cwd ||
// process.cwd(). Without this, claude indexes session storage by the
// daemon's own working directory (e.g. ~/.orchestra) instead of the
// project root, and `--resume <id>` prints "No conversation found"
// then exits clean — the exact failure mode reproduced on shumorobot
// Music topic at 2026-05-25T22:30 (session 4837f61a-...).
async function captureSpawnOpts(constructorOpts, startOpts) {
  let capturedOpts = null;
  const runner = {
    spawn: async (opts) => { capturedOpts = opts; },
    killSession: async () => {},
    sendControl: async () => {},
    captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
  };
  const fs = require('node:fs');
  const net = require('node:net');
  const p = new CliProcess({
    sessionKey: 'sess-cwd-test',
    chatId: '1', threadId: null, label: 'cwd-test',
    tmuxRunner: runner, botName: 'b',
    toolDispatcher: fakeDispatcher,
    claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    handshakeTimeoutMs: 2000,
    ...constructorOpts,
  });
  const startP = p.start(startOpts || {});
  for (let i = 0; i < 50 && (!p.sockPath || !fs.existsSync(p.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const sock = net.connect(p.sockPath);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
  // 0.12 Phase 1.6: also synthesize the mcp-ready signal that real bridges
  // emit on first claude ListToolsRequest. Without it, _waitForBridgeHandshake
  // would block until the configured mcp-ready timeout.
  sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
  await startP;
  sock.end();
  await p.kill('test');
  return capturedOpts;
}

test('rc.5: tmuxRunner.spawn cwd honors topicConfig.cwd', async () => {
  const opts = await captureSpawnOpts({}, {
    threadId: '3',
    chatConfig: {
      cwd: '/Users/test/home',
      topics: { '3': { cwd: '/Users/test/Music/rekordbox' } },
    },
  });
  assert.equal(opts.cwd, '/Users/test/Music/rekordbox',
    'spawn cwd must be the topic cwd, not the chat cwd or daemon process.cwd()');
});

test('rc.5: tmuxRunner.spawn cwd honors chatConfig.cwd when no topic', async () => {
  const opts = await captureSpawnOpts({}, {
    chatConfig: { cwd: '/Users/test/home' },
  });
  assert.equal(opts.cwd, '/Users/test/home',
    'spawn cwd falls back to chat cwd when no topic override');
});

test('rc.5: tmuxRunner.spawn cwd falls back to opts.cwd then process.cwd() when no config', async () => {
  const opts = await captureSpawnOpts({}, { cwd: '/tmp/fallback' });
  assert.equal(opts.cwd, '/tmp/fallback',
    'spawn cwd falls back to opts.cwd when no topic/chat config');
});

// Review M2: claudeBin is required (factory enforces this, but the class
// should reject missing claudeBin if env not set too).
test('CliProcess throws when claudeBin missing and env unset', () => {
  const oldEnv = process.env.ORCHESTRA_CLAUDE_BIN;
  delete process.env.ORCHESTRA_CLAUDE_BIN;
  try {
    assert.throws(
      () => new CliProcess({
        sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
        toolDispatcher: fakeDispatcher,
        logger: { warn: () => {}, error: () => {}, log: () => {} },
      }),
      /claudeBin required/,
    );
  } finally {
    if (oldEnv) process.env.ORCHESTRA_CLAUDE_BIN = oldEnv;
  }
});

// ─── 0.12.0 background-work lifecycle: probe + stall-watchdog ────────
//
// P0 (docs/0.12.0-background-work-lifecycle-plan.md) confirmed claude 2.1.158's
// TUI mode line shows a live `· N shell ·` count while a run_in_background Bash
// outlives its turn, clearing in-place on exit. P1 = the probe; P2 = the
// stall-watchdog that re-invokes the agent (read-only) via fireUserMessage —
// NOT injectUserMessage, which no-ops when !inFlight (the idle state here).

function makeBgProc(captureWide) {
  const p = new CliProcess({
    sessionKey: 'k', chatId: '1', threadId: null, label: 'bgtest',
    tmuxRunner: { spawn: async () => {}, killSession: async () => {}, sendControl: async () => {}, captureWide },
    botName: 'b', claudeBin: '/usr/bin/echo', toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  p.tmuxSession = 'fake-tmux'; // probeBusyState early-returns without it
  return p;
}

test('P1 probe: detects `· 1 shell ·` background-shell count in the mode line', async () => {
  const pane = ['╭─ Claude Code ─╮', 'output', '❯ ', '  ⏵⏵ auto mode on · 1 shell · ← for agents · ↓ to manage'].join('\n');
  const p = makeBgProc(async () => pane);
  const s = await p.probeBusyState();
  assert.equal(s.backgroundShell, true);
  assert.equal(s.shellCount, 1);
  assert.equal(s.streaming, false);
  assert.equal(s.busy, false, 'busy stays streaming-only — abort path unchanged');
  assert.deepEqual(await p.hasLiveBackgroundWork(), { live: true, count: 1 });
});

test('P1 probe: plural shells parse the count', async () => {
  const p = makeBgProc(async () => '  ⏵⏵ auto mode on · 3 shells · ← for agents · ↓ to manage');
  assert.equal((await p.probeBusyState()).shellCount, 3);
});

test('P1 probe: idle mode line with no shells → no background work', async () => {
  const p = makeBgProc(async () => '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)');
  const s = await p.probeBusyState();
  assert.equal(s.backgroundShell, false);
  assert.equal(s.shellCount, 0);
});

test('P1 probe: streaming hint alone is NOT background work', async () => {
  const p = makeBgProc(async () => '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt');
  const s = await p.probeBusyState();
  assert.equal(s.streaming, true);
  assert.equal(s.backgroundShell, false);
});

test('P1 probe: a `· 1 shell ·` scrolled into history (not the tail) is ignored', async () => {
  const stale = '  ⏵⏵ auto mode on · 1 shell · ← for agents';
  const pane = stale + '\n' + 'x'.repeat(600) + '\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)';
  const p = makeBgProc(async () => pane);
  assert.equal((await p.probeBusyState()).backgroundShell, false, 'viewport-anchored: stale scrollback must not match');
});

// Prod regression (shumorobot Music, 2026-06-04): the live mode line reads
// "⏵⏵ bypass permissions on · 1 shell …", NOT "auto mode on …" — every
// shumorobot session runs bypass-permissions mode, but the P0 spike was captured
// in auto mode, so BACKGROUND_SHELL_RE anchored on "auto mode on" and NEVER
// matched in production (bg-work-status fired zero times ever). The bg-shell
// detector must be mode-INDEPENDENT: the `· N shell ·` count is identical across
// modes; only the mode prefix differs.
test('P1 probe: detects shells in BYPASS-PERMISSIONS mode (the prod default — was a silent miss)', async () => {
  // Verbatim tail captured from the live shumorobot Music pane.
  const pane = [
    "⏺ I'll report back when the background job completes.",
    '✻ Baked for 1m 35s · 1 shell still running',
    '❯ ',
    '  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage',
  ].join('\n');
  const p = makeBgProc(async () => pane);
  const s = await p.probeBusyState();
  assert.equal(s.backgroundShell, true, 'bypass-permissions mode line must detect the bg shell');
  assert.equal(s.shellCount, 1);
  assert.deepEqual(await p.hasLiveBackgroundWork(), { live: true, count: 1 });
});

test('P1 probe: accept-edits mode also detects shells (mode-independent anchor)', async () => {
  const p = makeBgProc(async () => '  ⏵⏵ accept edits on · 2 shells · ← for agents · ↓ to manage');
  assert.equal((await p.probeBusyState()).shellCount, 2);
});

function makeWatchdogProc({ live, count = 1, stallMs = 1000 } = {}) {
  const p = makeBgProc(async () => '');
  p.bridgeReady = true;
  p.bgWorkStallMs = stallMs;
  p._probeState = { live, count };
  p.hasLiveBackgroundWork = async () => p._probeState;
  p._fired = [];
  p.fireUserMessage = (text) => { p._fired.push(text); return true; };
  return p;
}

test('P2 watchdog: live shell while idle → starts the clock, no fire on first tick', async () => {
  const p = makeWatchdogProc({ live: true });
  await p._pollBackgroundWork();
  assert.notEqual(p._bgWorkSince, null, 'clock started');
  assert.equal(p._fired.length, 0, 'no self-check on first observation');
});

test('P2 watchdog: stalled > bgWorkStallMs → exactly one read-only self-check via fireUserMessage', async () => {
  const p = makeWatchdogProc({ live: true, stallMs: 1000 });
  await p._pollBackgroundWork();        // start clock
  p._bgWorkSince = Date.now() - 5000;   // simulate 5s elapsed (> 1s stall)
  await p._pollBackgroundWork();        // should fire
  assert.equal(p._fired.length, 1, 'one self-check fired');
  assert.match(p._fired[0], /background job/i);
  assert.match(p._fired[0], /do NOT start new work|report only/i, 'read-only framing');
  await p._pollBackgroundWork();        // must NOT re-fire
  assert.equal(p._fired.length, 1, 'one self-check per window');
});

test('P2 watchdog: no live shell → no fire, clock + escalations reset', async () => {
  const p = makeWatchdogProc({ live: false, count: 0 });
  p._bgWorkSince = Date.now() - 999999;
  p._bgWorkEscalations = 1;
  await p._pollBackgroundWork();
  assert.equal(p._bgWorkSince, null);
  assert.equal(p._bgWorkEscalations, 0);
  assert.equal(p._fired.length, 0);
});

test('P2 watchdog: skips while a turn is in flight (no fire, clock preserved)', async () => {
  const p = makeWatchdogProc({ live: true });
  p._bgWorkSince = Date.now() - 999999; // would otherwise be stalled
  p.pendingTurns.set('turn-1', {});     // active turn
  await p._pollBackgroundWork();
  assert.equal(p._fired.length, 0, 'no watchdog while a turn is active');
  assert.notEqual(p._bgWorkSince, null, 'clock preserved — same shell still running');
});

test('P2 watchdog: a fresh background-work window gets its own self-check', async () => {
  const p = makeWatchdogProc({ live: true, stallMs: 1000 });
  await p._pollBackgroundWork();
  p._bgWorkSince = Date.now() - 5000;
  await p._pollBackgroundWork();        // fires (window 1)
  assert.equal(p._fired.length, 1);
  p._probeState = { live: false, count: 0 };
  await p._pollBackgroundWork();        // work clears → reset
  assert.equal(p._bgWorkSince, null);
  p._probeState = { live: true, count: 1 };
  await p._pollBackgroundWork();        // window 2: start clock
  p._bgWorkSince = Date.now() - 5000;
  await p._pollBackgroundWork();        // window 2: fires again
  assert.equal(p._fired.length, 2, 'fresh window → fresh self-check');
});

test('P4 visibility: emits bg-work-status running on first detection, cleared on clear', async () => {
  const p = makeWatchdogProc({ live: true });
  const events = [];
  p.on('bg-work-status', (e) => events.push(e));
  await p._pollBackgroundWork();                 // first detection → running
  assert.equal(p._bgWorkStatusShown, true);
  assert.deepEqual(events, [{ state: 'running', count: 1 }]);
  p._probeState = { live: false, count: 0 };
  await p._pollBackgroundWork();                 // work clears → cleared
  assert.equal(p._bgWorkStatusShown, false);
  assert.deepEqual(events, [{ state: 'running', count: 1 }, { state: 'cleared' }]);
});

test('P4 visibility: exactly one running emit while work stays live', async () => {
  const p = makeWatchdogProc({ live: true });
  const events = [];
  p.on('bg-work-status', (e) => events.push(e));
  await p._pollBackgroundWork();
  await p._pollBackgroundWork();
  await p._pollBackgroundWork();
  assert.equal(events.filter((e) => e.state === 'running').length, 1, 'one running emit per window');
});

// 0.12.0 LRU eviction-pin: the sync pin signal _evictLRU reads to skip a session with a live
// detached background job. Mirrors _bgWorkSince exactly — NO time cap (a long job stays pinned).
test('eviction-pin: hasActiveBackgroundWork() mirrors _bgWorkSince (no expiry)', () => {
  const p = new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b', toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/false' });
  assert.equal(p._bgWorkSince, null, 'starts with no background work');
  assert.equal(p.hasActiveBackgroundWork(), false, 'null → false');
  p._bgWorkSince = Date.now();
  assert.equal(p.hasActiveBackgroundWork(), true, 'set → true');
  p._bgWorkSince = Date.now() - 60 * 60 * 1000;   // an hour ago
  assert.equal(p.hasActiveBackgroundWork(), true, 'a long-running job still pins — no time cap');
  p._bgWorkSince = null;
  assert.equal(p.hasActiveBackgroundWork(), false, 'cleared → false');
});

// 0.12.0 question-progress-resume: when a blocking `ask` resolves with a REAL answer, the turn
// resumes working but the reactor cleared during the wait and no hooks re-light it. emit
// 'question-resumed' so polygram re-arms the reactor (prod: hire topic — "no progress after submit").
test('writeQuestionAnswer emits question-resumed on a real answer (re-light progress)', () => {
  const p = new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b', toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/false' });
  p._writeToBridge = () => true;   // isolate from the bridge transport
  p._openQuestions.add('tc1');
  let resumed = 0;
  p.on('question-resumed', () => resumed++);
  p.writeQuestionAnswer('tc1', { answers: [{ header: 'X', selected: ['a'] }] });
  assert.equal(resumed, 1, 'real answer + no open questions left → emits question-resumed');
});

test('writeQuestionAnswer does NOT emit question-resumed on cancelled/timeout (turn is ending)', () => {
  const p = new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b', toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/false' });
  p._writeToBridge = () => true;
  let resumed = 0;
  p.on('question-resumed', () => resumed++);
  p._openQuestions.add('tc1'); p.writeQuestionAnswer('tc1', { cancelled: true });
  p._openQuestions.add('tc2'); p.writeQuestionAnswer('tc2', { timedout: true });
  assert.equal(resumed, 0, 'terminal results end the turn — no re-arm');
});
