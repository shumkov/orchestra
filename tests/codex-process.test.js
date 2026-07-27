'use strict';

const { createHash, randomUUID } = require('node:crypto');
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
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CodexAppServerClient,
  attestPinnedCodexHome,
  protocolSchema,
} = require('../lib/codex/app-server-client');
const { CodexProcess } = require('../lib/process/codex-process');

const REAL_CLIENT_FIXTURE = path.resolve(
  __dirname,
  'fixtures/fake-codex-app-server.mjs',
);

const SILENT = {
  debug() {},
  error() {},
  info() {},
  log() {},
  warn() {},
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rpcError(message, code = 'CODEX_RPC_ERROR', options = {}) {
  const error = Object.assign(new Error(message, options), { code });
  if (code === 'CODEX_RPC_ERROR') error.rpcMessage = message;
  return error;
}

class FakeClient {
  constructor({ onNotification, onFault, handlers = {} }) {
    this.onNotification = onNotification;
    this.onFault = onFault;
    this.handlers = handlers;
    this.requests = [];
    this.closed = false;
    this.closeCount = 0;
    this.faultOutcome = null;
  }

  async start() {
    if (this.handlers.start) await this.handlers.start(this);
    return this;
  }

  async request(method, params, options = {}) {
    const record = { method, params, options };
    this.requests.push(record);
    if (options.onWriteAttempted) {
      let writeCommitted = false;
      try {
        await options.onWriteAttempted({
          id: this.requests.length,
          method,
          assertActive() {},
          markWriteCommitted() {
            writeCommitted = true;
          },
        });
      } catch (error) {
        throw rpcError(
          writeCommitted
            ? 'request outcome is unknown'
            : 'request was not sent',
          writeCommitted
            ? 'CODEX_RPC_OUTCOME_UNKNOWN'
            : 'CODEX_RPC_NOT_SENT',
          { cause: error },
        );
      }
    }
    let result;
    let responseError = null;
    try {
      if (this.handlers[method]) {
        result = await this.handlers[method](params, this, record);
      } else {
        result = this.defaultResult(method, params);
      }
    } catch (error) {
      if (error?.code !== 'CODEX_RPC_ERROR') throw error;
      responseError = error;
    }
    if (options.onResponseObserved) {
      try {
        await options.onResponseObserved({
          id: this.requests.length,
          method,
          outcome: responseError ? 'error' : 'result',
          assertActive() {},
        });
      } catch (error) {
        throw rpcError(
          'response checkpoint failed',
          'CODEX_RPC_CHECKPOINT_FAILED',
          { cause: error },
        );
      }
    }
    if (responseError) throw responseError;
    return result;
  }

  defaultResult(method, params) {
    if (method === 'thread/start') {
      return threadResult('codex-thread', params.model);
    }
    if (method === 'thread/resume') {
      return threadResult(params.threadId, 'gpt-5.6-sol');
    }
    if (method === 'turn/start') {
      return { turn: { id: randomUUID(), status: 'inProgress', items: [], error: null } };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'thread/backgroundTerminals/list') {
      return { count: 0, nextCursor: null };
    }
    return {};
  }

  notify(method, params, {
    assertActive = () => {},
    signal = new AbortController().signal,
  } = {}) {
    const notification = { method, params };
    Object.defineProperties(notification, {
      assertActive: { value: assertActive, enumerable: false },
      signal: { value: signal, enumerable: false },
    });
    return this.onNotification(notification);
  }

  async fault(outcome = {
    boundary: 'post-spawn',
    containment: 'unverified',
    cleanup: 'completed',
    errorCode: 'CODEX_PROCESS_EXITED',
  }) {
    this.faultOutcome = outcome;
    return this.onFault(outcome);
  }

  async close() {
    this.closeCount += 1;
    if (this.handlers.close) await this.handlers.close(this);
    this.closed = true;
  }

  async waitForFault() {
    return this.faultOutcome;
  }
}

const EXPECTED_THREAD_POLICY = Object.freeze({
  model: 'gpt-5.6-sol',
  effort: 'xhigh',
  modelProvider: 'openai',
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandbox: Object.freeze({ type: 'workspaceWrite' }),
  permissionProfile: Object.freeze({
    id: 'polygram-session',
    extends: null,
  }),
});

const MODEL_CATALOG = Object.freeze([{
  model: 'gpt-5.6-sol',
  supportedReasoningEfforts: Object.freeze(['high', 'xhigh']),
}, {
  model: 'gpt-5.6-terra',
  supportedReasoningEfforts: Object.freeze(['medium', 'high']),
}]);

function threadResult(
  threadId,
  model = 'gpt-5.6-sol',
  status = { type: 'idle' },
) {
  return {
    cwd: '/workspace',
    model,
    modelProvider: 'openai',
    reasoningEffort: 'xhigh',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite' },
    activePermissionProfile: { id: 'polygram-session', extends: null },
    thread: { id: threadId, status, turns: [] },
  };
}

function makeProcess({
  handlers = {},
  checkpointSink = async () => {},
  queueCap = 2,
  protocolFaultThreshold = 1,
  existingSessionId = null,
  processOptions = {},
} = {}) {
  let client;
  const proc = new CodexProcess({
    sessionKey: 'chat:1',
    chatId: '1',
    threadId: null,
    label: 'codex-test',
    cwd: '/workspace',
    checkpointSink,
    hostIdentity: 'host-test',
    bootSessionIdentity: 'boot-test',
    expectedThreadPolicy: EXPECTED_THREAD_POLICY,
    modelCatalog: MODEL_CATALOG,
    queueCap,
    protocolFaultThreshold,
    logger: SILENT,
    ...processOptions,
    clientFactory(callbacks) {
      client = new FakeClient({ ...callbacks, handlers });
      return client;
    },
  });
  const start = () => proc.start({
    existingSessionId,
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  return { proc, start, get client() { return client; } };
}

async function startTurnAndComplete(client, {
  threadId = 'codex-thread',
  turnId = 'turn-1',
  text = 'hello',
} = {}) {
  await client.notify('turn/started', {
    threadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  await client.notify('item/started', {
    threadId,
    turnId,
    item: { id: 'item-1', type: 'agentMessage' },
  });
  await client.notify('item/agentMessage/delta', {
    threadId,
    turnId,
    itemId: 'item-1',
    delta: text,
  });
  await client.notify('item/completed', {
    threadId,
    turnId,
    item: { id: 'item-1', type: 'agentMessage', text },
  });
  await client.notify('turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed', items: [], error: null },
  });
}

test('fresh start checkpoints one stable thread and emits init once', async () => {
  const checkpoints = [];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => checkpoints.push(checkpoint),
  });
  const initEvents = [];
  fixture.proc.on('init', (event) => initEvents.push(event));

  await fixture.start();

  assert.equal(fixture.proc.providerSessionId, 'codex-thread');
  assert.match(fixture.proc.generationId, /^[0-9a-f-]{36}$/);
  assert.equal(initEvents.length, 1);
  assert.equal(initEvents[0].session_id, 'codex-thread');
  assert.equal(initEvents[0].providerSessionId, 'codex-thread');
  assert.equal(initEvents[0].generationId, fixture.proc.generationId);
  assert.equal(checkpoints[0].kind, 'request-prepared');
  assert.equal(checkpoints.at(-1).kind, 'thread-initialized');
  assert.ok(checkpoints.every((entry) => entry.generationId === fixture.proc.generationId));
  await fixture.proc.kill();
});

test('resume preserves the provider thread; an active resumed thread is a recovery conflict', async () => {
  const fixture = makeProcess({
    existingSessionId: 'thread-existing',
    handlers: {
      'thread/resume': async ({ threadId }) => (
        threadResult(threadId, 'gpt-5.6-sol', { type: 'active', activeFlags: [] })
      ),
    },
  });

  await fixture.start();

  assert.equal(fixture.proc.providerSessionId, 'thread-existing');
  assert.equal(fixture.proc.state, 'RecoveryConflict');
  await assert.rejects(
    fixture.proc.send('must not attach to foreign active work'),
    (error) => error.code === 'CODEX_RECOVERY_CONFLICT',
  );
  assert.deepEqual(
    await fixture.proc.steerTurn('also unavailable'),
    { outcome: 'unavailable', reason: 'recovery-conflict' },
  );
  assert.equal(
    fixture.client.requests.some(({ method }) => method === 'turn/start'),
    false,
  );
  const closes = [];
  fixture.proc.on('close', (...args) => closes.push(args));
  await fixture.proc.kill();
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(fixture.proc.closed, false);
  assert.deepEqual(closes, []);
});

test('fresh attach accepts a matching settings notification before thread/start response', async () => {
  const fixture = makeProcess({
    handlers: {
      'thread/start': async ({ model }, client) => {
        await client.notify('thread/settings/updated', {
          threadId: 'codex-thread',
          threadSettings: {
            model,
            effort: 'xhigh',
            modelProvider: 'openai',
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            collaborationMode: {
              mode: 'default',
              model,
            },
            sandboxPolicy: { type: 'workspaceWrite' },
            activePermissionProfile: {
              id: 'polygram-session',
              extends: null,
            },
          },
        });
        return threadResult('codex-thread', model);
      },
    },
  });

  await fixture.start();

  assert.equal(fixture.proc.providerSessionId, 'codex-thread');
  assert.equal(fixture.proc.state, 'Idle');
  await fixture.proc.kill();
});

test('an observed settings notification after a completed turn remains healthy', async () => {
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        const turnId = 'turn-observed-settings';
        setImmediate(() => {
          startTurnAndComplete(client, { turnId });
        });
        return {
          turn: {
            id: turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
    },
  });
  await fixture.start();
  await fixture.proc.send('complete one turn');

  await fixture.client.notify('thread/settings/updated', {
    threadId: 'codex-thread',
    threadSettings: {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      modelProvider: 'openai',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite' },
      activePermissionProfile: {
        id: 'polygram-session',
        extends: null,
      },
    },
  });

  assert.equal(fixture.proc.state, 'Idle');
  assert.deepEqual(fixture.proc.observedThreadSettings, {
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  await fixture.proc.kill();
});

test('send serializes turns and captures the selected model/effort on every turn', async () => {
  let nextTurn = 0;
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        nextTurn += 1;
        const turnId = `turn-${nextTurn}`;
        setImmediate(() => {
          startTurnAndComplete(client, {
            turnId,
            text: nextTurn === 1 ? 'first reply' : 'second reply',
          });
        });
        return { turn: { id: turnId, status: 'inProgress', items: [], error: null } };
      },
    },
  });
  const chunks = [];
  fixture.proc.on('stream-chunk', (text) => chunks.push(text));
  await fixture.start();

  const first = fixture.proc.send('one', { context: { sourceMsgId: 'm1' } });
  const second = fixture.proc.send('two', { context: { sourceMsgId: 'm2' } });
  const [one, two] = await Promise.all([first, second]);

  assert.equal(one.text, 'first reply');
  assert.equal(two.text, 'second reply');
  assert.equal(one.sessionId, 'codex-thread');
  assert.equal(one.providerSessionId, 'codex-thread');
  assert.equal(one.providerTurnId, 'turn-1');
  assert.equal(one.generationId, fixture.proc.generationId);
  assert.deepEqual(chunks, ['first reply', 'second reply']);
  const starts = fixture.client.requests.filter(({ method }) => method === 'turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].params.model, 'gpt-5.6-sol');
  assert.equal(starts[0].params.effort, 'xhigh');
  assert.equal(starts[1].params.model, 'gpt-5.6-sol');
  assert.equal(starts[1].params.effort, 'xhigh');
  await fixture.proc.kill();
});

test('active selection preserves the turn and generation while the queued turn uses the new pair', async () => {
  let starts = 0;
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (params, client) => {
        starts += 1;
        const turnId = `turn-settings-${starts}`;
        if (starts === 2) {
          await client.notify('thread/settings/updated', {
            threadId: 'codex-thread',
            threadSettings: {
              model: params.model,
              effort: params.effort,
              modelProvider: 'openai',
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              sandboxPolicy: { type: 'workspaceWrite' },
              activePermissionProfile: {
                id: 'polygram-session',
                extends: null,
              },
            },
          });
        }
        await client.notify('turn/started', {
          threadId: 'codex-thread',
          turn: { id: turnId, status: 'inProgress' },
        });
        if (starts === 2) {
          setImmediate(() => client.notify('turn/completed', {
            threadId: 'codex-thread',
            turn: {
              id: turnId,
              status: 'completed',
              items: [],
              error: null,
            },
          }));
        }
        return {
          turn: {
            id: turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
    },
  });
  await fixture.start();
  const generationId = fixture.proc.generationId;
  const threadId = fixture.proc.providerSessionId;
  const first = fixture.proc.send('first');
  await new Promise((resolve) => setImmediate(resolve));
  const queued = fixture.proc.send('queued');

  assert.deepEqual(
    await fixture.proc.selectModelSettings({
      model: 'gpt-5.6-terra',
      effort: 'high',
    }),
    {
      outcome: 'updated-live',
      threadId,
      generationId,
      currentTurn: { model: 'gpt-5.6-sol', effort: 'xhigh' },
      nextTurn: { model: 'gpt-5.6-terra', effort: 'high' },
    },
  );
  const steer = await fixture.proc.steerTurn('keep working');
  assert.equal(steer.outcome, 'accepted');
  assert.equal(steer.turnId, 'turn-settings-1');
  await startTurnAndComplete(fixture.client, {
    turnId: 'turn-settings-1',
  });
  await Promise.all([first, queued]);

  const requests = fixture.client.requests.filter(
    ({ method }) => method === 'turn/start',
  );
  assert.deepEqual(
    requests.map(({ params }) => ({
      model: params.model,
      effort: params.effort,
    })),
    [
      { model: 'gpt-5.6-sol', effort: 'xhigh' },
      { model: 'gpt-5.6-terra', effort: 'high' },
    ],
  );
  assert.equal(fixture.proc.generationId, generationId);
  assert.equal(fixture.proc.providerSessionId, threadId);
  assert.deepEqual(fixture.proc.observedThreadSettings, {
    model: 'gpt-5.6-terra',
    effort: 'high',
  });
  await fixture.proc.kill();
});

test('two selections racing turn admission serialize and the final pair wins the next turn', async () => {
  const admissionEntered = deferred();
  const releaseAdmission = deferred();
  let starts = 0;
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        starts += 1;
        const turnId = `turn-admission-race-${starts}`;
        await client.notify('turn/started', {
          threadId: 'codex-thread',
          turn: { id: turnId, status: 'inProgress' },
        });
        if (starts === 1) {
          admissionEntered.resolve();
          await releaseAdmission.promise;
        } else {
          setImmediate(() => client.notify('turn/completed', {
            threadId: 'codex-thread',
            turn: {
              id: turnId,
              status: 'completed',
              items: [],
              error: null,
            },
          }));
        }
        return {
          turn: {
            id: turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
    },
  });
  await fixture.start();
  const first = fixture.proc.send('admit A');
  await admissionEntered.promise;
  let firstSelectionSettled = false;
  let secondSelectionSettled = false;
  const firstSelection = fixture.proc.selectModelSettings({
    model: 'gpt-5.6-terra',
    effort: 'high',
  });
  const secondSelection = fixture.proc.selectModelSettings({
    model: 'gpt-5.6-terra',
    effort: 'medium',
  });
  firstSelection.finally(() => {
    firstSelectionSettled = true;
  });
  secondSelection.finally(() => {
    secondSelectionSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSelectionSettled, false);
  assert.equal(secondSelectionSettled, false);

  releaseAdmission.resolve();
  assert.deepEqual(await firstSelection, {
    outcome: 'updated-live',
    threadId: 'codex-thread',
    generationId: fixture.proc.generationId,
    currentTurn: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    nextTurn: { model: 'gpt-5.6-terra', effort: 'high' },
  });
  assert.deepEqual(await secondSelection, {
    outcome: 'updated-live',
    threadId: 'codex-thread',
    generationId: fixture.proc.generationId,
    currentTurn: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    nextTurn: { model: 'gpt-5.6-terra', effort: 'medium' },
  });
  await fixture.client.notify('turn/completed', {
    threadId: 'codex-thread',
    turn: {
      id: 'turn-admission-race-1',
      status: 'completed',
      items: [],
      error: null,
    },
  });
  await first;
  await fixture.proc.send('next C');

  assert.deepEqual(
    fixture.client.requests
      .filter(({ method }) => method === 'turn/start')
      .map(({ params }) => ({
        model: params.model,
        effort: params.effort,
      })),
    [
      { model: 'gpt-5.6-sol', effort: 'xhigh' },
      { model: 'gpt-5.6-terra', effort: 'medium' },
    ],
  );
  await fixture.proc.kill();
});

test('selection validates the complete authenticated model/effort pair', async () => {
  const fixture = makeProcess();
  await fixture.start();

  await assert.rejects(
    fixture.proc.selectModelSettings({
      model: 'missing-model',
      effort: 'high',
    }),
    (error) => error.code === 'CODEX_MODEL_UNAVAILABLE',
  );
  await assert.rejects(
    fixture.proc.selectModelSettings({
      model: 'gpt-5.6-terra',
      effort: 'xhigh',
    }),
    (error) => error.code === 'CODEX_EFFORT_UNAVAILABLE',
  );
  assert.deepEqual(fixture.proc.desiredSettings, {
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  });
  await fixture.proc.kill();
});

test('queued turn results expose their own immutable checkpoint attemptId', async () => {
  const generatedAttemptIds = [
    'startup-attempt',
    'first-turn-attempt',
    'second-turn-attempt',
  ];
  const checkpoints = [];
  let nextTurn = 0;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => checkpoints.push(checkpoint),
    processOptions: {
      mutationAttemptIdFactory: () => generatedAttemptIds.shift(),
    },
    handlers: {
      'turn/start': async (_params, client) => {
        nextTurn += 1;
        const turnId = `turn-result-${nextTurn}`;
        setImmediate(() => {
          startTurnAndComplete(client, {
            turnId,
            text: `reply-${nextTurn}`,
          });
        });
        return {
          turn: {
            id: turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
    },
  });
  await fixture.start();

  const first = fixture.proc.send('one', {
    context: { attemptId: 'untrusted-first-attempt' },
  });
  const second = fixture.proc.send('two', {
    context: { attemptId: 'untrusted-second-attempt' },
  });
  const [one, two] = await Promise.all([first, second]);

  assert.equal(one.attemptId, 'first-turn-attempt');
  assert.equal(two.attemptId, 'second-turn-attempt');
  assert.notEqual(one.attemptId, two.attemptId);
  for (const result of [one, two]) {
    assert.equal(result.runtime, 'codex');
    assert.equal(result.backend, 'codex');
    const descriptor = Object.getOwnPropertyDescriptor(result, 'attemptId');
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.throws(() => {
      result.attemptId = 'forged-after-completion';
    }, TypeError);
  }

  const turnCheckpoints = checkpoints.filter((checkpoint) => (
    checkpoint.method === 'turn/start'
    || checkpoint.kind === 'turn-accepted'
    || checkpoint.kind === 'turn-started'
    || checkpoint.kind === 'turn-terminal'
  ));
  assert.deepEqual(
    [...new Set(turnCheckpoints.map(({ attemptId }) => attemptId))],
    [one.attemptId, two.attemptId],
  );
  assert.equal(
    turnCheckpoints.every(({ attemptId }) => (
      attemptId === one.attemptId || attemptId === two.attemptId
    )),
    true,
  );
  await fixture.proc.kill();
});

test('mutation attemptId is bounded before checkpoint or transport exposure', async () => {
  const checkpoints = [];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => checkpoints.push(checkpoint),
    processOptions: {
      mutationAttemptIdFactory: () => 'x'.repeat(513),
    },
  });

  try {
    await assert.rejects(
      fixture.start(),
      (error) => (
        error instanceof TypeError
        && error.message.includes('bounded mutation attemptId')
      ),
    );
    assert.equal(checkpoints.length, 0);
    assert.equal(
      fixture.client.requests.some(({ method }) => method === 'thread/start'),
      false,
    );
  } finally {
    await fixture.proc.kill();
  }
});

test('static policy attestor runs on the live client immediately before every turn start', async () => {
  const order = [];
  let nextTurn = 0;
  let liveClient = null;
  const fixture = makeProcess({
    processOptions: {
      staticPolicyAttestor: async (client) => {
        assert.equal(client, liveClient);
        order.push('reattest');
      },
    },
    handlers: {
      'turn/start': async (_params, client) => {
        order.push('turn/start');
        nextTurn += 1;
        const turnId = `turn-reattest-${nextTurn}`;
        setImmediate(() => {
          startTurnAndComplete(client, { turnId, text: `reply-${nextTurn}` });
        });
        return {
          turn: {
            id: turnId,
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
    },
  });
  await fixture.start();
  liveClient = fixture.client;

  await fixture.proc.send('first');
  await fixture.proc.send('second');

  assert.deepEqual(order, [
    'reattest',
    'turn/start',
    'reattest',
    'turn/start',
  ]);
  await fixture.proc.kill();
});

test('static policy drift is definitely not sent and never reaches turn/start', async () => {
  const drift = Object.assign(new Error('static policy drifted'), {
    code: 'CODEX_STATIC_PROFILE_MISMATCH',
  });
  let attestations = 0;
  const fixture = makeProcess({
    processOptions: {
      staticPolicyAttestor: async () => {
        attestations += 1;
        throw drift;
      },
    },
  });
  await fixture.start();

  await assert.rejects(
    fixture.proc.send('must not leave Orchestra'),
    (error) => (
      error.code === 'CODEX_STATIC_PROFILE_MISMATCH'
      && error.deliveryState === 'not-sent'
      && error.cause === drift
    ),
  );

  assert.equal(attestations, 1);
  assert.equal(
    fixture.client.requests.some(({ method }) => method === 'turn/start'),
    false,
  );
  assert.equal(fixture.proc.state, 'Idle');
  await fixture.proc.kill();
});

test('started notification may beat turn/start response, but the IDs must match', async () => {
  const gate = deferred();
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        await client.notify('turn/started', {
          threadId: 'codex-thread',
          turn: { id: 'turn-notification', status: 'inProgress' },
        });
        await gate.promise;
        return {
          turn: {
            id: 'turn-response',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('mismatch');
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();

  await assert.rejects(
    send,
    (error) => error.code === 'CODEX_CONTAINMENT_FAILED',
  );
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  await fixture.proc.kill();
});

test('steerTurn waits for the accepted turn ID and preserves steering order', async () => {
  const responseGate = deferred();
  const steers = [];
  const checkpoints = [];
  const generatedAttemptIds = [
    'startup-attempt',
    'target-turn-attempt',
    'first-steer-attempt',
    'second-steer-attempt',
  ];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => checkpoints.push(checkpoint),
    processOptions: {
      mutationAttemptIdFactory: () => generatedAttemptIds.shift(),
    },
    handlers: {
      'turn/start': async (_params, client) => {
        setImmediate(() => client.notify('turn/started', {
          threadId: 'codex-thread',
          turn: { id: 'turn-active', status: 'inProgress' },
        }));
        await responseGate.promise;
        return {
          turn: { id: 'turn-active', status: 'inProgress', items: [], error: null },
        };
      },
      'turn/steer': async (params) => {
        steers.push(params.input[0].text);
        return { turnId: params.expectedTurnId };
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('primary');
  const steerOne = fixture.proc.steerTurn('first steer', {
    context: {
      sourceMsgId: 's1',
      attemptId: 'forged-first-steer',
      targetAttemptId: 'forged-first-target',
      generationId: 'forged-first-generation',
      turnId: 'forged-first-turn',
    },
  });
  const steerTwo = fixture.proc.steerTurn('second steer', {
    context: {
      sourceMsgId: 's2',
      attemptId: 'forged-second-steer',
      targetAttemptId: 'forged-second-target',
      generationId: 'forged-second-generation',
      turnId: 'forged-second-turn',
    },
  });
  responseGate.resolve();

  const firstResult = await steerOne;
  const secondResult = await steerTwo;
  assert.deepEqual(firstResult, {
    outcome: 'accepted',
    turnId: 'turn-active',
    generationId: fixture.proc.generationId,
    attemptId: 'first-steer-attempt',
    targetAttemptId: 'target-turn-attempt',
  });
  assert.deepEqual(secondResult, {
    outcome: 'accepted',
    turnId: 'turn-active',
    generationId: fixture.proc.generationId,
    attemptId: 'second-steer-attempt',
    targetAttemptId: 'target-turn-attempt',
  });
  for (const result of [firstResult, secondResult]) {
    assert.equal(Object.isFrozen(result), true);
    assert.throws(() => {
      result.attemptId = 'forged-after-acceptance';
    }, TypeError);
    assert.throws(() => {
      result.targetAttemptId = 'forged-after-acceptance';
    }, TypeError);
  }
  assert.deepEqual(
    [...new Set(
      checkpoints
        .filter(({ method, kind }) => (
          method === 'turn/steer' || kind === 'turn-steer-accepted'
        ))
        .map(({ attemptId }) => attemptId),
    )],
    [firstResult.attemptId, secondResult.attemptId],
  );
  assert.deepEqual(
    [...new Set(
      checkpoints
        .filter(({ method, kind }) => (
          method === 'turn/start'
          || kind === 'turn-accepted'
          || kind === 'turn-started'
        ))
        .map(({ attemptId }) => attemptId),
    )],
    [firstResult.targetAttemptId],
  );
  assert.deepEqual(steers, ['first steer', 'second steer']);
  await startTurnAndComplete(fixture.client, { turnId: 'turn-active', text: 'done' });
  await send;
  await fixture.proc.kill();
});

test('stale steer is queueable once; unknown delivery is never queueable', async () => {
  let mode = 'stale';
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: { id: 'turn-active', status: 'inProgress', items: [], error: null },
      }),
      'turn/steer': async () => {
        if (mode === 'stale') throw rpcError('no active turn to steer');
        throw rpcError('outcome unknown', 'CODEX_RPC_OUTCOME_UNKNOWN');
      },
    },
  });
  const lifecycle = [];
  fixture.proc.on('codex-lifecycle', (event) => lifecycle.push(event.kind));
  await fixture.start();
  const send = fixture.proc.send('primary');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-active', status: 'inProgress' },
  });

  assert.deepEqual(
    await fixture.proc.steerTurn('raced completion'),
    { outcome: 'queueable-not-active', turnId: 'turn-active' },
  );
  mode = 'unknown';
  await assert.rejects(
    fixture.proc.steerTurn('ambiguous'),
    (error) => error.code === 'CODEX_RPC_OUTCOME_UNKNOWN',
  );
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.deepEqual(
    lifecycle.filter((kind) => (
      kind === 'failed-ambiguous'
      || kind === 'containment-failed'
    )),
    ['failed-ambiguous', 'containment-failed'],
  );
  await assert.rejects(send);
  await fixture.proc.kill();
});

test('turn/start RPC error observed after dispatch is ambiguous and never replayable', async () => {
  const lifecycle = [];
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => {
        throw rpcError('generic provider rejection');
      },
    },
  });
  fixture.proc.on('codex-lifecycle', (event) => lifecycle.push(event.kind));
  await fixture.start();

  await assert.rejects(
    fixture.proc.send('must not be replayed'),
    (error) => error.code === 'CODEX_RPC_ERROR',
  );

  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.deepEqual(
    lifecycle.filter((kind) => (
      kind === 'failed-ambiguous'
      || kind === 'containment-failed'
    )),
    ['failed-ambiguous', 'containment-failed'],
  );
  await assert.rejects(
    fixture.proc.send('a retry would duplicate an unknown mutation'),
    (error) => error.code === 'CODEX_CONTAINMENT_FAILED',
  );
});

test('generic turn/steer RPC error enters containment and is never queueable', async () => {
  const lifecycle = [];
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: { id: 'turn-active', status: 'inProgress', items: [], error: null },
      }),
      'turn/steer': async () => {
        throw rpcError('generic provider rejection');
      },
    },
  });
  fixture.proc.on('codex-lifecycle', (event) => lifecycle.push(event.kind));
  await fixture.start();
  const send = fixture.proc.send('primary');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-active', status: 'inProgress' },
  });

  await assert.rejects(
    fixture.proc.steerTurn('must not become a queued turn'),
    (error) => error.code === 'CODEX_RPC_ERROR',
  );
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.deepEqual(
    lifecycle.filter((kind) => (
      kind === 'failed-ambiguous'
      || kind === 'containment-failed'
    )),
    ['failed-ambiguous', 'containment-failed'],
  );
  await assert.rejects(
    fixture.proc.send('must remain fenced'),
    (error) => error.code === 'CODEX_CONTAINMENT_FAILED',
  );
  await assert.rejects(send);
  await fixture.proc.kill();
});

test('queue cap excludes the active turn and rejects the newest waiter with its context', async () => {
  const turnStartEntered = deferred();
  const turnGate = deferred();
  const fixture = makeProcess({
    queueCap: 1,
    handlers: {
      'turn/start': async (_params, client) => {
        turnStartEntered.resolve();
        await turnGate.promise;
        setImmediate(() => client.notify('turn/started', {
          threadId: 'codex-thread',
          turn: { id: 'turn-1', status: 'inProgress' },
        }));
        return {
          turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
        };
      },
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-1',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
    },
  });
  await fixture.start();
  const active = fixture.proc.send('active');
  await turnStartEntered.promise;
  const waiting = fixture.proc.send('waiting', {
    context: { sourceMsgId: 'waiter' },
  });
  const overflow = fixture.proc.send('overflow', {
    context: { sourceMsgId: 'overflow' },
  });

  await assert.rejects(
    overflow,
    (error) => (
      error.code === 'QUEUE_OVERFLOW'
      && error.context.sourceMsgId === 'overflow'
    ),
  );
  assert.equal(fixture.proc.pendingQueue.length, 2);
  assert.equal(fixture.proc.drainQueue('TEST_DONE'), 1);
  const waitingRejected = assert.rejects(waiting);
  const kill = fixture.proc.kill();
  turnGate.resolve();
  await waitingRejected;
  assert.equal((await active).error, 'interrupted');
  await kill;
});

test('interrupt waits for exact terminal, clean, fresh empty page, and durable stop checkpoints', async () => {
  const checkpoints = [];
  const terminalGate = deferred();
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      checkpoints.push(checkpoint);
      if (checkpoint.kind === 'turn-terminal') terminalGate.resolve();
    },
    handlers: {
      'turn/start': async () => ({
        turn: { id: 'turn-stop', status: 'inProgress', items: [], error: null },
      }),
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-stop',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('long task');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-stop', status: 'inProgress' },
  });

  assert.equal(fixture.proc.drainQueue('INTERRUPTED'), 0);
  assert.equal(fixture.proc.activeTurnId, 'turn-stop');
  const stopped = await fixture.proc.interrupt();
  await terminalGate.promise;

  assert.equal(stopped, true);
  assert.equal(fixture.proc.state, 'Stopped');
  assert.deepEqual(
    fixture.client.requests
      .filter(({ method }) => (
        method === 'turn/interrupt'
        || method.startsWith('thread/backgroundTerminals/')
      ))
      .map(({ method, params }) => [method, params.cursor]),
    [
      ['turn/interrupt', undefined],
      ['thread/backgroundTerminals/clean', undefined],
      ['thread/backgroundTerminals/list', undefined],
    ],
  );
  const stopKinds = checkpoints
    .map(({ kind }) => kind)
    .filter((kind) => [
      'stop-terminal-reconciled',
      'stop-clean-accepted',
      'stop-empty-registry-observed',
    ].includes(kind));
  assert.deepEqual(stopKinds, [
    'stop-terminal-reconciled',
    'stop-clean-accepted',
    'stop-empty-registry-observed',
  ]);
  const result = await send;
  assert.equal(result.error, 'interrupted');
  await assert.rejects(
    fixture.proc.send('after stop'),
    (error) => error.code === 'CODEX_PROCESS_QUIESCING',
  );
  await fixture.proc.kill();
});

test('a checkpoint failure after dispatch is typed, non-replayable, and refuses later work', async () => {
  let failWriteAttempt = false;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (failWriteAttempt && checkpoint.kind === 'request-response-observed') {
        throw new Error('database unavailable');
      }
    },
    handlers: {
      'turn/start': async () => {
        failWriteAttempt = true;
        return {
          turn: { id: 'turn-ambiguous', status: 'inProgress', items: [], error: null },
        };
      },
    },
  });
  await fixture.start();

  await assert.rejects(
    fixture.proc.send('has crossed dispatch'),
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  await assert.rejects(
    fixture.proc.send('must not retry'),
    (error) => error.code === 'CODEX_CONTAINMENT_FAILED',
  );
  await fixture.proc.kill();
});

test('prepared and write-attempt checkpoint failures are safe-not-sent but block later work', async (t) => {
  for (const failedKind of ['request-prepared', 'request-write-attempted']) {
    await t.test(failedKind, async () => {
      let failTurn = false;
      const fixture = makeProcess({
        checkpointSink: async (checkpoint) => {
          if (
            failTurn
            && checkpoint.method === 'turn/start'
            && checkpoint.kind === failedKind
          ) {
            throw new Error('durability unavailable');
          }
        },
      });
      await fixture.start();
      failTurn = true;

      await assert.rejects(
        fixture.proc.send('definitely not sent'),
        (error) => error.code === 'CODEX_DURABILITY_FAILED',
      );
      assert.equal(fixture.proc.state, 'DurabilityBlocked');
      assert.equal(fixture.proc.containmentReason, null);
      const turnStartRequests = fixture.client.requests
        .filter(({ method }) => method === 'turn/start');
      assert.equal(
        turnStartRequests.length,
        failedKind === 'request-prepared' ? 0 : 1,
      );
      await assert.rejects(
        fixture.proc.send('persistence still unhealthy'),
        (error) => error.code === 'CODEX_DURABILITY_FAILED',
      );
      await fixture.proc.kill();
      assert.equal(fixture.proc.state, 'DurabilityBlocked');
      assert.equal(fixture.proc.closed, false);
    });
  }
});

test('an external durability fence immediately blocks active, queued, and later work', async () => {
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-external-durability',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
    },
  });
  await fixture.start();
  const active = fixture.proc.send('active before delivery persistence');
  const queued = fixture.proc.send('queued before delivery persistence');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-external-durability', status: 'inProgress' },
  });
  const checkpointError = new Error('Telegram checkpoint unavailable');

  assert.equal(fixture.proc.blockDurability(checkpointError), true);

  await assert.rejects(
    active,
    (error) => (
      error.code === 'CODEX_DURABILITY_FAILED'
      && error.cause === checkpointError
    ),
  );
  await assert.rejects(
    queued,
    (error) => (
      error.code === 'CODEX_DURABILITY_FAILED'
      && error.cause === checkpointError
    ),
  );
  assert.equal(fixture.proc.state, 'DurabilityBlocked');
  assert.equal(fixture.proc.pendingQueue.length, 0);
  await assert.rejects(
    fixture.proc.send('later send'),
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  assert.deepEqual(
    await fixture.proc.steerTurn('later steer'),
    { outcome: 'unavailable', reason: 'durability-blocked' },
  );
});

test('write checkpoint commitment stays ambiguous when later sink work rejects', async () => {
  let failTurnWrite = false;
  let markerCalls = 0;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (
        failTurnWrite
        && checkpoint.method === 'turn/start'
        && checkpoint.kind === 'request-write-attempted'
      ) {
        assert.equal(
          Object.keys(checkpoint).includes('markWriteCommitted'),
          false,
        );
        assert.equal(typeof checkpoint.markWriteCommitted, 'function');
        checkpoint.markWriteCommitted();
        markerCalls += 1;
        throw new Error('post-commit sink bookkeeping failed');
      }
    },
  });
  await fixture.start();
  failTurnWrite = true;

  await assert.rejects(
    fixture.proc.send('durably ambiguous'),
    (error) => (
      error.code === 'CODEX_DURABILITY_FAILED'
      && error.cause?.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
    ),
  );
  assert.equal(markerCalls, 1);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  await assert.rejects(
    fixture.proc.send('must not retry'),
    (error) => error.code === 'CODEX_CONTAINMENT_FAILED',
  );
  await fixture.proc.kill();
});

test('accepted turn timeout interrupts and cleans instead of returning to idle', async () => {
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: { id: 'turn-timeout', status: 'inProgress', items: [], error: null },
      }),
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-timeout',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('times out', { timeoutMs: 5, maxTurnMs: 5 });
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-timeout', status: 'inProgress' },
  });

  await assert.rejects(send, (error) => error.code === 'CODEX_TURN_TIMEOUT');
  assert.equal(fixture.proc.state, 'Stopped');
  assert.deepEqual(
    fixture.client.requests
      .map(({ method }) => method)
      .filter((method) => (
        method === 'turn/interrupt'
        || method.startsWith('thread/backgroundTerminals/')
      )),
    [
      'turn/interrupt',
      'thread/backgroundTerminals/clean',
      'thread/backgroundTerminals/list',
    ],
  );
  await fixture.proc.kill();
});

test('natural completion leaving BackgroundWorking later cleans and releases on idle status', async () => {
  let cleaned = false;
  const checkpoints = [];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => checkpoints.push(checkpoint),
    handlers: {
      'turn/start': async (_params, client) => {
        setImmediate(() => startTurnAndComplete(client, {
          turnId: 'turn-background',
          text: 'server started',
        }));
        return {
          turn: {
            id: 'turn-background',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
      'thread/backgroundTerminals/list': async () => (
        cleaned
          ? { count: 0, nextCursor: null }
          : { count: 1, nextCursor: null }
      ),
      'thread/backgroundTerminals/clean': async () => {
        cleaned = true;
        return {};
      },
    },
  });
  await fixture.start();

  const result = await fixture.proc.send('start a background server');
  assert.equal(result.text, 'server started');
  assert.equal(fixture.proc.state, 'BackgroundWorking');
  assert.equal(fixture.proc.hasActiveBackgroundWork(), true);

  const settled = new Promise((resolve) => {
    fixture.proc.once('codex-settled', resolve);
  });
  await fixture.client.notify('thread/status/changed', {
    threadId: 'codex-thread',
    status: { type: 'idle' },
  });
  const settlement = await settled;

  assert.equal(settlement.kind, 'background-settled');
  assert.equal(fixture.proc.state, 'Idle');
  assert.equal(cleaned, true);
  assert.equal(
    checkpoints.some(({ kind, turnId }) => (
      kind === 'background-terminal-reconciled'
      && turnId === 'turn-background'
    )),
    true,
  );
  await fixture.proc.kill();
});

test('background work missing idle status is exactly stopped at the original turn deadline', async () => {
  let cleaned = false;
  const fixture = makeProcess({
    processOptions: {
      interruptTimeoutMs: 100,
      cleanupTimeoutMs: 100,
      cleanupPollMs: 1,
    },
    handlers: {
      'turn/start': async (_params, client) => {
        setImmediate(() => startTurnAndComplete(client, {
          turnId: 'turn-background-watchdog',
          text: 'background started',
        }));
        return {
          turn: {
            id: 'turn-background-watchdog',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
      'thread/backgroundTerminals/list': async () => (
        cleaned
          ? { count: 0, nextCursor: null }
          : { count: 1, nextCursor: null }
      ),
      'thread/backgroundTerminals/clean': async () => {
        cleaned = true;
        return {};
      },
    },
  });
  await fixture.start();
  const settled = new Promise((resolve) => {
    fixture.proc.on('codex-settled', (event) => {
      if (event.kind === 'stopped') resolve(event);
    });
  });

  const result = await fixture.proc.send('start background work', {
    maxTurnMs: 80,
  });
  assert.equal(result.text, 'background started');
  assert.equal(fixture.proc.state, 'BackgroundWorking');

  const event = await Promise.race([
    settled,
    new Promise((_, reject) => setTimeout(() => {
      reject(new Error('background watchdog did not stop the turn'));
    }, 500)),
  ]);
  assert.equal(event.turnId, 'turn-background-watchdog');
  assert.equal(fixture.proc.state, 'Stopped');
  assert.equal(cleaned, true);
  await fixture.proc.kill();
});

test('accepted thread followed by profile validation failure enters containment', async () => {
  const fixture = makeProcess({
    handlers: {
      'thread/start': async ({ model }) => ({
        ...threadResult('codex-thread', model),
        activePermissionProfile: {
          id: 'unexpected-profile',
          extends: null,
        },
      }),
    },
  });
  const containment = [];
  const closes = [];
  fixture.proc.on('containment-failed', (event) => containment.push(event));
  fixture.proc.on('close', (event) => closes.push(event));

  await assert.rejects(
    fixture.start(),
    (error) => error.code === 'CODEX_THREAD_POLICY_MISMATCH',
  );
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(containment.length, 1);
  await fixture.proc.kill();
  assert.equal(
    closes.length,
    0,
    'containment ownership must not be released through generic close',
  );
});

test('fresh thread policy requires every exact field and rejects every omission', async (t) => {
  const cases = [
    ['model provider', (result, missing) => {
      if (missing) delete result.modelProvider;
      else result.modelProvider = 'other-provider';
    }],
    ['approval policy', (result, missing) => {
      if (missing) delete result.approvalPolicy;
      else result.approvalPolicy = 'on-request';
    }],
    ['approvals reviewer', (result, missing) => {
      if (missing) delete result.approvalsReviewer;
      else result.approvalsReviewer = 'auto_review';
    }],
    ['sandbox', (result, missing) => {
      if (missing) delete result.sandbox;
      else result.sandbox = { type: 'readOnly' };
    }],
    ['permission profile', (result, missing) => {
      if (missing) delete result.activePermissionProfile;
      else result.activePermissionProfile.id = 'other-profile';
    }],
    ['permission profile parent', (result, missing) => {
      if (missing) delete result.activePermissionProfile.extends;
      else result.activePermissionProfile.extends = 'parent-profile';
    }],
  ];
  for (const [label, mutate] of cases) {
    for (const missing of [false, true]) {
      await t.test(`${label} ${missing ? 'missing' : 'mismatch'}`, async () => {
        const fixture = makeProcess({
          handlers: {
            'thread/start': async ({ model }) => {
              const result = threadResult('codex-thread', model);
              mutate(result, missing);
              return result;
            },
          },
        });
        await assert.rejects(
          fixture.start(),
          (error) => error.code === 'CODEX_THREAD_POLICY_MISMATCH',
        );
        assert.equal(fixture.proc.state, 'ContainmentFailed');
      });
    }
  }
});

test('resume accepts an old dynamic pair while settings updates retain exact static attestation', async () => {
  const resume = makeProcess({
    existingSessionId: 'thread-existing',
    handlers: {
      'thread/resume': async ({ threadId }) => {
        const result = threadResult(threadId, 'retired-model');
        result.reasoningEffort = 'medium';
        return result;
      },
    },
  });
  await resume.start();
  assert.deepEqual(resume.proc.observedThreadSettings, {
    model: 'retired-model',
    effort: 'medium',
  });
  await resume.proc.kill();

  const settings = makeProcess();
  await settings.start();
  await settings.client.notify('thread/settings/updated', {
    threadId: 'codex-thread',
    threadSettings: {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      modelProvider: 'openai',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite' },
      activePermissionProfile: {
        id: 'polygram-session',
        extends: 'unexpected-parent',
      },
    },
  });
  assert.equal(settings.proc.state, 'ContainmentFailed');
  assert.equal(settings.proc.containmentReason, 'thread-settings-drift');
});

test('settings updates fail closed when collaboration mode disagrees with the outer pair', async () => {
  const settings = makeProcess();
  await settings.start();
  await settings.client.notify('thread/settings/updated', {
    threadId: 'codex-thread',
    threadSettings: {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      modelProvider: 'openai',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      collaborationMode: {
        mode: 'plan',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
      },
      sandboxPolicy: { type: 'workspaceWrite' },
      activePermissionProfile: {
        id: 'polygram-session',
        extends: null,
      },
    },
  });

  assert.equal(settings.proc.state, 'ContainmentFailed');
  assert.equal(settings.proc.containmentReason, 'thread-settings-drift');
});

test('containment remains manager-visible after kill and never emits generic close', async () => {
  const fixture = makeProcess();
  const closes = [];
  fixture.proc.on('close', (...args) => closes.push(args));
  await fixture.start();
  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'foreign-thread',
    turnId: 'foreign-turn',
    itemId: 'foreign-item',
    delta: 'foreign',
  });

  await fixture.proc.kill();

  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(fixture.proc.closed, false);
  assert.deepEqual(closes, []);
});

test('cross-thread notification is never delivered and faults the owned generation', async () => {
  const fixture = makeProcess();
  const chunks = [];
  fixture.proc.on('stream-chunk', (chunk) => chunks.push(chunk));
  await fixture.start();

  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'foreign-thread',
    turnId: 'foreign-turn',
    itemId: 'foreign-item',
    delta: 'secret from another chat',
  });

  assert.deepEqual(chunks, []);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(fixture.proc.containmentReason, 'cross-thread-notification');
  await fixture.proc.kill();
});

test('containment is checkpointed before lifecycle emit and closes transport after notification unwind', async () => {
  const order = [];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'containment-entered') {
        order.push(['checkpoint', checkpoint]);
      }
    },
  });
  fixture.proc.on('containment-failed', (event) => {
    order.push(['event', event]);
  });
  await fixture.start();

  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'foreign-thread',
    turnId: 'foreign-turn',
    itemId: 'foreign-item',
    delta: 'must never be persisted',
  });

  assert.deepEqual(order.map(([kind]) => kind), ['checkpoint', 'event']);
  assert.equal(JSON.stringify(order).includes('must never be persisted'), false);
  assert.equal(fixture.proc.closed, false);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.client.closeCount, 1);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
});

test('kill from BackgroundWorking performs exact cleanup before ordinary close', async () => {
  let cleaned = false;
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        setImmediate(() => startTurnAndComplete(client, {
          turnId: 'turn-kill-background',
          text: 'background ready',
        }));
        return {
          turn: {
            id: 'turn-kill-background',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
      'thread/backgroundTerminals/list': async () => (
        cleaned
          ? { count: 0, nextCursor: null }
          : { count: 1, nextCursor: null }
      ),
      'thread/backgroundTerminals/clean': async () => {
        cleaned = true;
        return {};
      },
    },
  });
  await fixture.start();
  await fixture.proc.send('start background work');
  assert.equal(fixture.proc.state, 'BackgroundWorking');

  await fixture.proc.kill('evict');

  assert.equal(cleaned, true);
  assert.equal(fixture.proc.state, 'Closed');
  assert.equal(fixture.proc.closed, true);
});

test('queued next turn does not start while background cleanup owns the thread', async () => {
  let cleaned = false;
  let starts = 0;
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        starts += 1;
        const turnId = `turn-background-race-${starts}`;
        setImmediate(() => startTurnAndComplete(client, {
          turnId,
          text: `reply-${starts}`,
        }));
        return {
          turn: { id: turnId, status: 'inProgress', items: [], error: null },
        };
      },
      'thread/backgroundTerminals/list': async () => (
        starts === 1 && !cleaned
          ? { count: 1, nextCursor: null }
          : { count: 0, nextCursor: null }
      ),
      'thread/backgroundTerminals/clean': async () => {
        cleaned = true;
        return {};
      },
    },
  });
  await fixture.start();
  await fixture.proc.send('first');
  assert.equal(fixture.proc.state, 'BackgroundWorking');

  const second = fixture.proc.send('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  const settled = new Promise((resolve) => {
    fixture.proc.once('codex-settled', resolve);
  });
  await fixture.client.notify('thread/status/changed', {
    threadId: 'codex-thread',
    status: { type: 'idle' },
  });
  await settled;
  assert.equal((await second).text, 'reply-2');
  assert.equal(starts, 2);
  await fixture.proc.kill();
});

test('recognized interrupt race waits for a later exact natural terminal', async () => {
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-natural-race',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-natural-race',
            status: 'completed',
            items: [],
            error: null,
          },
        }));
        throw rpcError('no active turn to interrupt');
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('finishes during stop');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-natural-race', status: 'inProgress' },
  });

  assert.equal(await fixture.proc.interrupt(), true);
  assert.equal((await send).error, null);
  assert.equal(fixture.proc.state, 'Stopped');
  await fixture.proc.kill();
});

test('post-terminal background probe failure contains and never returns Idle', async () => {
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        setImmediate(() => startTurnAndComplete(client, {
          turnId: 'turn-probe-fail',
          text: 'partial',
        }));
        return {
          turn: {
            id: 'turn-probe-fail',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
      'thread/backgroundTerminals/list': async () => {
        throw rpcError('terminal list unavailable', 'CODEX_RPC_TIMEOUT');
      },
    },
  });
  await fixture.start();

  await assert.rejects(fixture.proc.send('probe failure'));

  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.notEqual(fixture.proc.state, 'Idle');
});

test('steer write-checkpoint failure is durability-blocked and never queueable', async () => {
  let failSteerWrite = false;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (
        failSteerWrite
        && checkpoint.method === 'turn/steer'
        && checkpoint.kind === 'request-write-attempted'
      ) {
        throw new Error('steer checkpoint unavailable');
      }
    },
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-steer-durability',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
    },
  });
  await fixture.start();
  const send = fixture.proc.send('active');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-steer-durability', status: 'inProgress' },
  });
  failSteerWrite = true;

  await assert.rejects(
    fixture.proc.steerTurn('must not queue'),
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  assert.equal(fixture.proc.state, 'DurabilityBlocked');
  await fixture.client.notify('turn/completed', {
    threadId: 'codex-thread',
    turn: {
      id: 'turn-steer-durability',
      status: 'completed',
      items: [],
      error: null,
    },
  });
  await assert.rejects(
    send,
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  assert.equal(fixture.proc.state, 'DurabilityBlocked');
  await assert.rejects(
    fixture.proc.send('must remain fenced'),
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  await fixture.proc.kill();
});

test('notification fence reaches checkpoints and item state mutates only after durability', async () => {
  let fenceCalls = 0;
  let rejectItem = false;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'item-completed') {
        assert.equal(typeof checkpoint.assertActive, 'function');
        checkpoint.assertActive();
        if (rejectItem) throw new Error('item checkpoint rejected');
      }
    },
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-fenced-item',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
    },
  });
  await fixture.start();
  fixture.proc.send('active').catch(() => {});
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-fenced-item', status: 'inProgress' },
  }, {
    assertActive() { fenceCalls += 1; },
  });
  const ownedPending = fixture.proc.current;
  rejectItem = true;

  await assert.rejects(fixture.client.notify('item/completed', {
    threadId: 'codex-thread',
    turnId: 'turn-fenced-item',
    item: {
      id: 'item-fenced',
      type: 'agentMessage',
      text: 'not durable',
    },
  }, {
    assertActive() { fenceCalls += 1; },
  }));

  assert.equal(ownedPending.completedItemText.size, 0);
  assert.ok(fenceCalls >= 2);
});

test('bounded text state fails content-free and onFirstStream fires once', async () => {
  const containment = [];
  let firstStreams = 0;
  const fixture = makeProcess({
    processOptions: { maxTurnTextBytes: 8 },
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'containment-entered') containment.push(checkpoint);
    },
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-text-cap',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
    },
  });
  await fixture.start();
  fixture.proc.send('active', {
    context: { onFirstStream() { firstStreams += 1; } },
  }).catch(() => {});
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-text-cap', status: 'inProgress' },
  });
  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'codex-thread',
    turnId: 'turn-text-cap',
    itemId: 'item-text',
    delta: '1234',
  });
  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'codex-thread',
    turnId: 'turn-text-cap',
    itemId: 'item-text',
    delta: '5678',
  });
  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'codex-thread',
    turnId: 'turn-text-cap',
    itemId: 'item-text',
    delta: 'SECRET',
  });

  assert.equal(firstStreams, 1);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(JSON.stringify(containment).includes('SECRET'), false);
});

test('stream deltas use incremental bounds and bounded durability milestones', async () => {
  const checkpoints = [];
  const chunks = [];
  const fixture = makeProcess({
    processOptions: {
      maxTurnTextBytes: 64,
      streamCheckpointBytes: 8,
    },
    checkpointSink: async (checkpoint) => checkpoints.push(checkpoint),
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-stream-batches',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
    },
  });
  fixture.proc.on('stream-chunk', (chunk) => chunks.push(chunk));
  await fixture.start();
  const resultPromise = fixture.proc.send('active');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-stream-batches', status: 'inProgress' },
  });
  for (let index = 0; index < 20; index += 1) {
    await fixture.client.notify('item/agentMessage/delta', {
      threadId: 'codex-thread',
      turnId: 'turn-stream-batches',
      itemId: 'item-stream-batches',
      delta: 'x',
    });
  }
  await fixture.client.notify('item/completed', {
    threadId: 'codex-thread',
    turnId: 'turn-stream-batches',
    item: {
      id: 'item-stream-batches',
      type: 'agentMessage',
      text: 'x'.repeat(20),
    },
  });
  await fixture.client.notify('turn/completed', {
    threadId: 'codex-thread',
    turn: {
      id: 'turn-stream-batches',
      status: 'completed',
      items: [],
      error: null,
    },
  });

  const result = await resultPromise;
  const deltaCheckpoints = checkpoints.filter(
    ({ kind }) => kind === 'item-delta-observed',
  );
  assert.equal(result.text, 'x'.repeat(20));
  assert.equal(chunks.at(-1), 'x'.repeat(20));
  assert.equal(deltaCheckpoints.length, 3);
  assert.deepEqual(
    deltaCheckpoints.map(({ batchedDeltaBytes }) => batchedDeltaBytes),
    [1, 8, 8],
  );
});

test('mutation checkpoints share one stable attemptId', async () => {
  const checkpoints = [];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => checkpoints.push(checkpoint),
  });
  await fixture.start();
  const threadMutation = checkpoints.filter(({ method }) => method === 'thread/start');

  assert.deepEqual(
    threadMutation.map(({ kind }) => kind),
    [
      'request-prepared',
      'request-write-attempted',
      'request-response-observed',
    ],
  );
  assert.equal(new Set(threadMutation.map(({ attemptId }) => attemptId)).size, 1);
  assert.match(threadMutation[0].attemptId, /^[0-9a-f-]{36}$/);
  await fixture.proc.kill();
});

test('human wait flags do not emit a partial lifecycle contract before U9', async () => {
  const lifecycle = [];
  const fixture = makeProcess();
  fixture.proc.on('codex-lifecycle', (event) => lifecycle.push(event));
  await fixture.start();

  await fixture.client.notify('thread/status/changed', {
    threadId: 'codex-thread',
    status: {
      type: 'active',
      activeFlags: ['waitingOnUserInput'],
    },
  });

  assert.equal(lifecycle.some(({ kind }) => kind === 'human-wait'), false);
  await fixture.proc.kill();
});

test('thread status waits for its durability checkpoint before changing control state', async () => {
  const checkpointEntered = deferred();
  const releaseCheckpoint = deferred();
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'thread-status-changed') {
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      }
    },
  });
  await fixture.start();

  const notification = fixture.client.notify('thread/status/changed', {
    threadId: 'codex-thread',
    status: { type: 'active', activeFlags: [] },
  });
  await checkpointEntered.promise;

  assert.equal(fixture.proc.threadStatusType, null);
  assert.equal(fixture.proc.state, 'Idle');
  releaseCheckpoint.resolve();
  await notification;
  assert.equal(fixture.proc.threadStatusType, 'active');
  assert.equal(fixture.proc.state, 'BackgroundWorking');
  await fixture.proc.interrupt();
  await fixture.proc.kill();
});

test('thread status checkpoint failure contains without applying the mutation', async () => {
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'thread-status-changed') {
        throw new Error('status durability unavailable');
      }
    },
  });
  await fixture.start();

  await assert.rejects(
    fixture.client.notify('thread/status/changed', {
      threadId: 'codex-thread',
      status: { type: 'active', activeFlags: [] },
    }),
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );

  assert.equal(fixture.proc.threadStatusType, null);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
});

test('sync queue drain defers rejection until interrupt durably cancels each waiter', async () => {
  const order = [];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'queued-send-cancelled') {
        order.push(`checkpoint:${checkpoint.source}`);
      }
    },
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-drain-active',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-drain-active',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
    },
  });
  await fixture.start();
  const active = fixture.proc.send('active');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-drain-active', status: 'inProgress' },
  });
  const waiting = fixture.proc.send('waiting', {
    context: { sourceMsgId: 'waiting-source' },
  }).catch((error) => {
    order.push(`rejected:${error.code}`);
    throw error;
  });

  assert.equal(fixture.proc.drainQueue('INTERRUPTED'), 1);
  assert.deepEqual(order, []);
  const waitingRejected = assert.rejects(
    waiting,
    (error) => error.code === 'INTERRUPTED',
  );
  await fixture.proc.interrupt();
  await waitingRejected;
  assert.deepEqual(order, [
    'checkpoint:waiting-source',
    'rejected:INTERRUPTED',
  ]);
  await active;
  await fixture.proc.kill();
});

test('same-thread foreign turn item faults instead of being treated as harmless stale traffic', async () => {
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-owned',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
    },
  });
  await fixture.start();
  fixture.proc.send('owned').catch(() => {});
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-owned', status: 'inProgress' },
  });

  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'codex-thread',
    turnId: 'turn-foreign',
    itemId: 'foreign-item',
    delta: 'foreign',
  });

  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(fixture.proc.containmentReason, 'foreign-turn-notification');
});

test('stop during a prepared turn start durably cancels without dispatching the turn', async () => {
  const prepared = deferred();
  const releasePrepared = deferred();
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (
        checkpoint.kind === 'request-prepared'
        && checkpoint.method === 'turn/start'
      ) {
        prepared.resolve();
        await releasePrepared.promise;
      }
    },
  });
  await fixture.start();
  const send = fixture.proc.send('cancel before dispatch');
  await prepared.promise;

  assert.equal(await fixture.proc.interrupt(), true);
  await assert.rejects(send, (error) => error.code === 'INTERRUPTED');
  releasePrepared.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    fixture.client.requests.some(({ method }) => method === 'turn/start'),
    false,
  );
  assert.equal(fixture.proc.state, 'Stopped');
  await fixture.proc.kill();
});

test('stop cleanup failure contains the generation instead of releasing ownership', async () => {
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-cleanup-failure',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-cleanup-failure',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
      'thread/backgroundTerminals/clean': async () => {
        throw rpcError('cleanup unavailable');
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('active');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-cleanup-failure', status: 'inProgress' },
  });

  await assert.rejects(fixture.proc.interrupt());
  assert.equal((await send).error, 'interrupted');
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(fixture.proc.containmentReason, 'stop-cleanup-failed');
  await fixture.proc.kill();
});

test('late notifications after containment cannot mutate or emit turn output', async () => {
  const chunks = [];
  const fixture = makeProcess();
  fixture.proc.on('stream-chunk', (chunk) => chunks.push(chunk));
  await fixture.start();
  await fixture.client.notify('error', {
    threadId: 'foreign-thread',
    turnId: 'foreign-turn',
    message: 'fault',
  });

  await fixture.client.notify('item/agentMessage/delta', {
    threadId: 'codex-thread',
    turnId: 'late-turn',
    itemId: 'late-item',
    delta: 'late secret',
  });

  assert.deepEqual(chunks, []);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(fixture.proc.lastTerminal, null);
});

test('startup continuation cannot leave containment after a gated thread response', async () => {
  const entered = deferred();
  const release = deferred();
  const events = [];
  const fixture = makeProcess({
    handlers: {
      'thread/start': async ({ model }) => {
        entered.resolve();
        await release.promise;
        return threadResult('codex-thread', model);
      },
    },
  });
  fixture.proc.on('init', () => events.push('init'));
  fixture.proc.on('idle', () => events.push('idle'));
  const start = fixture.start();
  await entered.promise;
  await fixture.client.fault();
  release.resolve();

  await assert.rejects(start);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.deepEqual(events, []);
});

test('startupReleaseSafe requires a pre-write failure and verified terminal close', async () => {
  const safe = makeProcess({
    handlers: {
      start: async () => {
        throw rpcError('spawn failed', 'CODEX_PROCESS_ERROR');
      },
    },
  });
  await assert.rejects(safe.start());
  assert.equal(safe.proc.startupReleaseSafe, true);
  assert.equal(safe.proc.closed, true);
  assert.equal(safe.proc.state, 'Closed');
  assert.equal(safe.client.closeCount, 1);

  const unverified = makeProcess({
    handlers: {
      start: async () => {
        throw rpcError('spawn failed', 'CODEX_PROCESS_ERROR');
      },
      close: async () => {
        throw rpcError('close unverified', 'CODEX_PROCESS_CLEANUP_UNVERIFIED');
      },
    },
  });
  await assert.rejects(unverified.start());
  assert.equal(unverified.proc.startupReleaseSafe, false);
  assert.equal(unverified.proc.state, 'ContainmentFailed');

  const committed = makeProcess({
    handlers: {
      'thread/start': async () => {
        throw rpcError('definitive server rejection');
      },
    },
  });
  await assert.rejects(committed.start());
  assert.equal(committed.proc.stateChangingWriteCommitted, true);
  assert.equal(committed.proc.startupReleaseSafe, false);
  assert.equal(committed.proc.state, 'ContainmentFailed');
});

test('startup not-sent durability failures block without claiming ambiguous containment', async (t) => {
  for (const method of ['thread/start', 'thread/resume']) {
    for (const failedKind of ['request-prepared', 'request-write-attempted']) {
      await t.test(`${method} ${failedKind}`, async () => {
        const lifecycle = [];
        const fixture = makeProcess({
          existingSessionId: method === 'thread/resume'
            ? 'thread-existing'
            : null,
          checkpointSink: async (checkpoint) => {
            if (
              checkpoint.kind === failedKind
              && checkpoint.method === method
            ) {
              throw new Error('startup durability unavailable');
            }
          },
        });
        fixture.proc.on('codex-lifecycle', (event) => {
          lifecycle.push(event.kind);
        });

        await assert.rejects(
          fixture.start(),
          (error) => (
            error.code === 'CODEX_DURABILITY_FAILED'
            || error.cause?.code === 'CODEX_DURABILITY_FAILED'
          ),
        );

        assert.equal(fixture.proc.state, 'DurabilityBlocked');
        assert.equal(fixture.proc.stateChangingWriteCommitted, false);
        assert.equal(lifecycle.includes('containment-failed'), false);
        assert.equal(lifecycle.includes('durability-blocked'), true);
      });
    }
  }
});

test('post-terminal probe continuation cannot emit output after containment', async () => {
  const probeEntered = deferred();
  const releaseProbe = deferred();
  const results = [];
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        setImmediate(() => startTurnAndComplete(client, {
          turnId: 'turn-probe-fenced',
          text: 'must stay fenced',
        }));
        return {
          turn: {
            id: 'turn-probe-fenced',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
      'thread/backgroundTerminals/list': async () => {
        probeEntered.resolve();
        await releaseProbe.promise;
        return { count: 0, nextCursor: null };
      },
    },
  });
  fixture.proc.on('result', (result) => results.push(result));
  await fixture.start();
  const send = fixture.proc.send('probe race');
  await probeEntered.promise;
  await fixture.client.fault();
  releaseProbe.resolve();

  await assert.rejects(send);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.deepEqual(results, []);
});

test('stop cannot publish Stopped after a gated clean faults', async () => {
  const cleanEntered = deferred();
  const releaseClean = deferred();
  const settled = [];
  const fixture = makeProcess({
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-stop-fenced',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-stop-fenced',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
      'thread/backgroundTerminals/clean': async () => {
        cleanEntered.resolve();
        await releaseClean.promise;
        return {};
      },
    },
  });
  fixture.proc.on('codex-settled', (event) => settled.push(event.kind));
  await fixture.start();
  fixture.proc.send('active').catch(() => {});
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-stop-fenced', status: 'inProgress' },
  });
  const stop = fixture.proc.interrupt();
  await cleanEntered.promise;
  await fixture.client.fault();
  releaseClean.resolve();

  await assert.rejects(stop);
  assert.equal(fixture.proc.state, 'ContainmentFailed');
  assert.equal(settled.includes('stopped'), false);
});

test('stop waits for an in-progress turn-start write checkpoint disposition', async () => {
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let cleanCalls = 0;
  let startCalls = 0;
  const checkpoints = [];
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      checkpoints.push(checkpoint);
      if (
        checkpoint.kind === 'request-write-attempted'
        && checkpoint.method === 'turn/start'
      ) {
        writeEntered.resolve();
        await releaseWrite.promise;
      }
    },
    handlers: {
      'turn/start': async (_params, client) => {
        startCalls += 1;
        await client.notify('turn/started', {
          threadId: 'codex-thread',
          turn: { id: 'turn-write-race', status: 'inProgress' },
        });
        return {
          turn: {
            id: 'turn-write-race',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-write-race',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
      'thread/backgroundTerminals/clean': async () => {
        cleanCalls += 1;
        return {};
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('cancel during write checkpoint');
  await writeEntered.promise;
  let stopSettled = false;
  const stop = fixture.proc.interrupt().finally(() => {
    stopSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopSettled, false);
  assert.equal(cleanCalls, 0);
  releaseWrite.resolve();
  assert.equal(await stop, true);
  assert.equal((await send).error, 'interrupted');
  assert.equal(startCalls, 1);
  assert.equal(
    checkpoints.some(({ kind }) => kind === 'active-start-cancelled'),
    false,
  );
  assert.equal(cleanCalls, 1);
  await fixture.proc.kill();
});

test('stop waits for an in-progress steer write checkpoint before cleanup', async () => {
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let cleanCalls = 0;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (
        checkpoint.kind === 'request-write-attempted'
        && checkpoint.method === 'turn/steer'
      ) {
        writeEntered.resolve();
        await releaseWrite.promise;
      }
    },
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-steer-write-race',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
      'turn/interrupt': async (_params, client) => {
        setImmediate(() => client.notify('turn/completed', {
          threadId: 'codex-thread',
          turn: {
            id: 'turn-steer-write-race',
            status: 'interrupted',
            items: [],
            error: null,
          },
        }));
        return {};
      },
      'thread/backgroundTerminals/clean': async () => {
        cleanCalls += 1;
        return {};
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('active');
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-steer-write-race', status: 'inProgress' },
  });
  const steer = fixture.proc.steerTurn('write race');
  await writeEntered.promise;
  let stopSettled = false;
  const stop = fixture.proc.interrupt().finally(() => {
    stopSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopSettled, false);
  assert.equal(cleanCalls, 0);
  releaseWrite.resolve();
  const steerResult = await steer;
  assert.equal(steerResult.outcome, 'accepted');
  assert.equal(steerResult.turnId, 'turn-steer-write-race');
  assert.equal(steerResult.generationId, fixture.proc.generationId);
  assert.match(steerResult.attemptId, /^[0-9a-f-]{36}$/);
  assert.match(steerResult.targetAttemptId, /^[0-9a-f-]{36}$/);
  assert.equal(Object.isFrozen(steerResult), true);
  assert.equal(await stop, true);
  assert.equal((await send).error, 'interrupted');
  assert.equal(cleanCalls, 1);
  await fixture.proc.kill();
});

test('started-first steering waits for response match and durable turn acceptance', async () => {
  const acceptedEntered = deferred();
  const releaseAccepted = deferred();
  let steerCalls = 0;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'turn-accepted') {
        acceptedEntered.resolve();
        await releaseAccepted.promise;
      }
    },
    handlers: {
      'turn/start': async (_params, client) => {
        await client.notify('turn/started', {
          threadId: 'codex-thread',
          turn: { id: 'turn-started-first', status: 'inProgress' },
        });
        return {
          turn: {
            id: 'turn-started-first',
            status: 'inProgress',
            items: [],
            error: null,
          },
        };
      },
      'turn/steer': async ({ expectedTurnId }) => {
        steerCalls += 1;
        return { turnId: expectedTurnId };
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('started first');
  await acceptedEntered.promise;
  const steer = fixture.proc.steerTurn('must wait');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(steerCalls, 0);

  releaseAccepted.resolve();
  const steerResult = await steer;
  assert.equal(steerResult.outcome, 'accepted');
  assert.equal(steerResult.turnId, 'turn-started-first');
  assert.equal(steerResult.generationId, fixture.proc.generationId);
  assert.match(steerResult.attemptId, /^[0-9a-f-]{36}$/);
  assert.match(steerResult.targetAttemptId, /^[0-9a-f-]{36}$/);
  assert.equal(Object.isFrozen(steerResult), true);
  await startTurnAndComplete(fixture.client, {
    turnId: 'turn-started-first',
    text: 'done',
  });
  await send;
  await fixture.proc.kill();
});

test('stop quiesces before waiting for background cleanup and reuses one proof', async () => {
  let cleaned = false;
  let cleanCalls = 0;
  let starts = 0;
  const cleanEntered = deferred();
  const releaseClean = deferred();
  const fixture = makeProcess({
    handlers: {
      'turn/start': async (_params, client) => {
        starts += 1;
        const turnId = `turn-bg-quiesce-${starts}`;
        setImmediate(() => startTurnAndComplete(client, {
          turnId,
          text: 'background',
        }));
        return {
          turn: { id: turnId, status: 'inProgress', items: [], error: null },
        };
      },
      'thread/backgroundTerminals/list': async () => (
        cleaned
          ? { count: 0, nextCursor: null }
          : { count: 1, nextCursor: null }
      ),
      'thread/backgroundTerminals/clean': async () => {
        cleanCalls += 1;
        cleanEntered.resolve();
        await releaseClean.promise;
        cleaned = true;
        return {};
      },
    },
  });
  await fixture.start();
  await fixture.proc.send('first');
  const queued = fixture.proc.send('must be drained');
  await fixture.client.notify('thread/status/changed', {
    threadId: 'codex-thread',
    status: { type: 'idle' },
  });
  await cleanEntered.promise;
  const stop = fixture.proc.interrupt();
  assert.equal(fixture.proc.state, 'Quiescing');
  releaseClean.resolve();

  await assert.rejects(queued, (error) => error.code === 'INTERRUPTED');
  assert.equal(await stop, true);
  assert.equal(cleanCalls, 1);
  assert.equal(starts, 1);
  assert.equal(fixture.proc.state, 'Stopped');
  await fixture.proc.kill();
});

test('queued cancellation checkpoint failure rejects once and retains recovery fence', async () => {
  let waiterRejections = 0;
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (checkpoint.kind === 'queued-send-cancelled') {
        throw new Error('cancellation durability unavailable');
      }
    },
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-cancel-durability',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
    },
  });
  await fixture.start();
  fixture.proc.send('active').catch(() => {});
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-cancel-durability', status: 'inProgress' },
  });
  const waiting = fixture.proc.send('waiting').catch((error) => {
    waiterRejections += 1;
    throw error;
  });
  const waitingRejected = assert.rejects(
    waiting,
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  fixture.proc.drainQueue('INTERRUPTED');

  await assert.rejects(fixture.proc.interrupt());
  await waitingRejected;
  assert.equal(waiterRejections, 1);
  assert.equal(fixture.proc.state, 'DurabilityBlocked');
  assert.equal(fixture.proc.pendingCancellations.length, 1);
  await fixture.proc.kill();
});

test('active start cancellation checkpoint failure enters DurabilityBlocked', async () => {
  const prepared = deferred();
  const releasePrepared = deferred();
  const fixture = makeProcess({
    checkpointSink: async (checkpoint) => {
      if (
        checkpoint.kind === 'request-prepared'
        && checkpoint.method === 'turn/start'
      ) {
        prepared.resolve();
        await releasePrepared.promise;
      }
      if (checkpoint.kind === 'active-start-cancelled') {
        throw new Error('active cancellation durability unavailable');
      }
    },
  });
  await fixture.start();
  const send = fixture.proc.send('active cancellation durability');
  const sendRejected = assert.rejects(
    send,
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  await prepared.promise;

  await assert.rejects(fixture.proc.interrupt());
  await sendRejected;
  assert.equal(fixture.proc.state, 'DurabilityBlocked');
  releasePrepared.resolve();
  await fixture.proc.kill();
});

test('steer input and queue are bounded and probe shares the activation deadline', async () => {
  const steerGate = deferred();
  let probeTimeoutMs = null;
  const fixture = makeProcess({
    processOptions: {
      maxSteerTextBytes: 4,
      maxPendingSteers: 1,
      turnTimeoutMs: 1_000,
    },
    handlers: {
      'turn/start': async () => ({
        turn: {
          id: 'turn-steer-bounds',
          status: 'inProgress',
          items: [],
          error: null,
        },
      }),
      'turn/steer': async ({ expectedTurnId }) => {
        await steerGate.promise;
        return { turnId: expectedTurnId };
      },
      'thread/backgroundTerminals/list': async (_params, _client, record) => {
        probeTimeoutMs = record.options.timeoutMs;
        return { count: 0, nextCursor: null };
      },
    },
  });
  await fixture.start();
  const send = fixture.proc.send('active', { maxTurnMs: 1_000 });
  await fixture.client.notify('turn/started', {
    threadId: 'codex-thread',
    turn: { id: 'turn-steer-bounds', status: 'inProgress' },
  });

  assert.deepEqual(
    await fixture.proc.steerTurn('12345'),
    { outcome: 'unavailable', reason: 'input-too-large' },
  );
  const first = fixture.proc.steerTurn('1234');
  await assert.rejects(
    fixture.proc.steerTurn('next'),
    (error) => error.code === 'CODEX_STEER_QUEUE_OVERFLOW',
  );
  steerGate.resolve();
  await first;
  await fixture.client.notify('turn/completed', {
    threadId: 'codex-thread',
    turn: {
      id: 'turn-steer-bounds',
      status: 'completed',
      items: [],
      error: null,
    },
  });
  await send;
  assert.equal(Number.isSafeInteger(probeTimeoutMs), true);
  assert.ok(probeTimeoutMs > 0 && probeTimeoutMs <= 1_000);
  await fixture.proc.kill();
});

test('real U2 client checkpoints containment before closing on response durability failure', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the pinned app-server client is not supported on Windows');
    return;
  }
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'orchestra-u3-u2-ordering-')),
  );
  const cwd = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  const config = 'model = "gpt-5.6-sol"\n';
  const expectedConfigSha256 = createHash('sha256')
    .update(config)
    .digest('hex');
  const configPath = path.join(codexHome, 'config.toml');
  writeFileSync(configPath, config, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  writeFileSync(
    path.join(cwd, '.fake-codex-app-server.json'),
    '{}\n',
  );
  const binary = path.join(cwd, 'fake-codex-direct.mjs');
  writeFileSync(
    binary,
    readFileSync(REAL_CLIENT_FIXTURE, 'utf8')
      .replace(/^#!.*\n/, `#!${process.execPath}\n`),
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);

  let client;
  t.after(async () => {
    await Promise.allSettled([client?.close()]);
    rmSync(root, { recursive: true, force: true });
  });

  const order = [];
  const writableRootSha256 = createHash('sha256')
    .update(cwd)
    .digest('hex');
  const expectedThreadPolicy = Object.freeze({
    model: 'gpt-5.6-sol',
    effort: 'medium',
    modelProvider: 'openai',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: Object.freeze({
      type: 'workspaceWrite',
      networkAccess: false,
      writableRootCount: 1,
      writableRootSha256: Object.freeze([writableRootSha256]),
    }),
    permissionProfile: Object.freeze({
      id: 'polygram-session',
      extends: null,
    }),
  });
  const proc = new CodexProcess({
    sessionKey: 'chat:real-u2',
    chatId: 'real-u2',
    threadId: null,
    label: 'real-u2-ordering',
    cwd,
    expectedThreadPolicy,
    hostIdentity: 'host-test',
    bootSessionIdentity: 'boot-test',
    logger: SILENT,
    checkpointSink: async (checkpoint) => {
      order.push(`checkpoint:${checkpoint.kind}`);
      if (
        checkpoint.kind === 'request-response-observed'
        && checkpoint.method === 'thread/start'
      ) {
        throw new Error('thread acceptance durability unavailable');
      }
    },
    clientFactory(callbacks) {
      client = new CodexAppServerClient({
        binary,
        cwd,
        codexHome,
        env: {
          HOME: '/controlled/home',
          TMPDIR: cwd,
          LANG: 'en_US.UTF-8',
          LC_ALL: 'C',
        },
        expectedConfigSha256,
        requestTimeoutMs: 500,
        sinkTimeoutMs: 500,
        closeGraceMs: 100,
        closeKillMs: 200,
        attestBinaryFn: async (attestedBinary) => ({
          path: attestedBinary,
          sha256: protocolSchema.binarySha256,
          version: protocolSchema.cliVersion,
        }),
        attestCodexHomeFn: (home, expectedHash) => (
          attestPinnedCodexHome(home, expectedHash, { temporaryRoots: [] })
        ),
        ...callbacks,
      });
      const close = client.close.bind(client);
      let closeObserved = false;
      client.close = () => {
        if (!closeObserved) {
          closeObserved = true;
          order.push('client-close-start');
        }
        return close();
      };
      return client;
    },
  });
  proc.on('codex-lifecycle', ({ kind }) => {
    if (kind === 'containment-failed') order.push('containment-event');
  });

  await assert.rejects(
    proc.start({
      model: 'gpt-5.6-sol',
      effort: 'medium',
    }),
    (error) => error.code === 'CODEX_RPC_CHECKPOINT_FAILED',
  );
  await client.waitForFault();

  const responseCheckpoint = order.indexOf(
    'checkpoint:request-response-observed',
  );
  const containmentCheckpoint = order.indexOf(
    'checkpoint:containment-entered',
  );
  const containmentEvent = order.indexOf('containment-event');
  const closeStart = order.indexOf('client-close-start');
  assert.ok(responseCheckpoint >= 0, `missing response checkpoint: ${order}`);
  assert.ok(
    containmentCheckpoint > responseCheckpoint,
    `containment was not checkpointed after the failed response: ${order}`,
  );
  assert.ok(
    containmentEvent > containmentCheckpoint,
    `containment event preceded durability: ${order}`,
  );
  assert.ok(
    closeStart > containmentEvent,
    `U2 closed before U3 made containment visible: ${order}`,
  );
});
