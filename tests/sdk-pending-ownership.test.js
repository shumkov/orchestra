'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SdkProcess, makeInputController } = require('../lib/process/sdk-process');
const { makeFakeQuery } = require('./_helpers/fake-query');

const tick = () => new Promise(resolve => setImmediate(resolve));
const assistant = (text, fields = {}) => ({ type: 'assistant', parent_tool_use_id: null,
  message: { id: 'synthetic-' + text, content: [{ type: 'text', text }] }, ...fields });
const result = (text, fields = {}) => ({ type: 'result', subtype: 'success',
  is_error: false, result: text, session_id: 'synthetic-session', ...fields });
async function fixture(t, options = {}) {
  const fake = makeFakeQuery({ echoUserUuids: false });
  const proc = new SdkProcess({ sessionKey: 'synthetic-ownership', label: 'synthetic',
    spawnFn: () => fake.query, logger: { error() {}, warn() {} },
    queryCloseTimeoutMs: 5, ...options });
  await proc.start({});
  t.after(() => proc.kill('test-complete'));
  const streams = [], autonomous = [];
  proc.on('stream-chunk', text => streams.push(text));
  proc.on('autonomous-assistant-message', msg => autonomous.push(msg.message.content[0].text));
  function send(text, opts) {
    const p = proc.send(text, { timeoutMs: 1000, maxTurnMs: 1500, ...opts });
    p.catch(() => {});
    return p;
  }
  return { proc, fake, send, streams, autonomous };
}

test('normal sends enter SDK one at a time and resolve their own source', async t => {
  const { proc, fake, send } = await fixture(t);
  const a = send('USER-A', { context: { sourceMsgId: 1 } });
  const b = send('USER-B', { context: { sourceMsgId: 2 } });
  await tick();
  assert.equal(fake.pushedMessages.length, 1, 'waiting prompt must not coalesce with active input');
  const id = fake.pushedMessages[0].uuid;
  assert.match(id, /^[a-f0-9-]{36}$/);
  await proc._handleEvent(result('REPLY-A', { user_message_uuid: id }));
  assert.equal((await a).text, 'REPLY-A');
  await tick();
  assert.equal(fake.pushedMessages[1].message.content, 'USER-B');
  assert.notEqual(fake.pushedMessages[1].uuid, id);
  await proc._handleEvent(result('REPLY-B', { user_message_uuid: fake.pushedMessages[1].uuid }));
  assert.equal((await b).text, 'REPLY-B');
});

for (const origin of [{ kind: 'peer', from: 'synthetic-agent' }, { kind: 'task-notification', runId: 'synthetic-run' }]) {
  test(`${origin.kind} report is delivered without consuming a waiting user`, async t => {
    const { proc, fake, send, streams, autonomous } = await fixture(t);
    const p = send('USER');
    await tick();
    await proc._handleEvent(assistant('REPORT'));
    await proc._handleEvent(result('REPORT', { origin, num_turns: origin.kind === 'peer' ? 1 : 0 }));
    assert.equal(proc.pendingQueue.length, 1);
    assert.deepEqual(streams, []);
    assert.deepEqual(autonomous, ['REPORT']);
    await proc._handleEvent(result('USER-REPLY', { user_message_uuid: fake.pushedMessages[0].uuid }));
    assert.equal((await p).text, 'USER-REPLY');
  });
}

test('first echo binds subsequent unannotated assistant blocks and result', async t => {
  const { proc, fake, send, streams, autonomous } = await fixture(t);
  const p = send('USER'); await tick();
  await proc._handleEvent(assistant('FIRST', { user_message_uuid: fake.pushedMessages[0].uuid }));
  await proc._handleEvent(assistant('SECOND'));
  await proc._handleEvent(result('DONE'));
  assert.equal((await p).text, 'DONE');
  assert.deepEqual(streams, ['FIRST', 'FIRST\n\nSECOND']);
  assert.deepEqual(autonomous, []);
});

test('conflicting UUID invalidates an earlier binding before unannotated frames', async t => {
  const { proc, fake, send, streams, autonomous } = await fixture(t);
  send('USER'); await tick();
  await proc._handleEvent(assistant('OWNED', { user_message_uuid: fake.pushedMessages[0].uuid }));
  await proc._handleEvent(assistant('FOREIGN', { user_message_uuid: 'foreign' }));
  await proc._handleEvent(assistant('FOREIGN-CONTINUED'));
  await proc._handleEvent(result('FOREIGN-DONE'));
  assert.equal(proc.pendingQueue.length, 1);
  assert.deepEqual(streams, ['OWNED']);
  assert.deepEqual(autonomous, ['FOREIGN', 'FOREIGN-CONTINUED']);
});

test('child partials cannot bind user ownership or signal user thinking', async t => {
  const { proc, fake, send } = await fixture(t);
  send('USER'); await tick(); let thinking = 0;
  proc.on('thinking', () => thinking++);
  await proc._handleEvent({ type: 'stream_event', parent_tool_use_id: 'child',
    user_message_uuid: fake.pushedMessages[0].uuid,
    event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
  await proc._handleEvent(result('UNATTRIBUTED'));
  assert.equal(thinking, 0);
  assert.equal(proc.pendingQueue.length, 1);
});

for (const subtype of ['success', 'error_during_execution']) {
  test(`metadata-free ${subtype} cannot complete an unbound user`, async t => {
    const { proc, send } = await fixture(t);
    send('USER');
    await proc._handleEvent(result('UNATTRIBUTED', { subtype }));
    assert.equal(proc.pendingQueue.length, 1);
  });
}

test('intentional steering and injection retain priorities and own folded UUIDs', async t => {
  const { proc, fake, send, streams } = await fixture(t);
  const p = send('USER'); send('WAITING'); await tick();
  assert.equal(proc.steer('STEER'), true);
  assert.equal(proc.injectUserMessage({ content: 'INJECT', priority: 'next', shouldQuery: true }), true);
  await tick();
  assert.deepEqual(fake.pushedMessages.map(m => m.message.content), ['USER', 'STEER', 'INJECT']);
  assert.equal(fake.pushedMessages[1].priority, 'now');
  assert.equal(fake.pushedMessages[1].shouldQuery, false);
  assert.equal(fake.pushedMessages[2].priority, 'next');
  const ids = fake.pushedMessages.map(m => m.uuid);
  await proc._handleEvent(assistant('FOLDED', { user_message_uuids: ['foreign', ids[2]], origin: { kind: 'peer' } }));
  await proc._handleEvent(result('FOLDED', { user_message_uuids: ids, origin: { kind: 'peer' } }));
  assert.equal((await p).text, 'FOLDED');
  assert.deepEqual(streams, ['FOLDED']);
});

test('fire-and-forget output never completes the active user request', async t => {
  const { proc, fake, send, autonomous } = await fixture(t);
  send('USER'); await tick(); proc.fireUserMessage('/compact'); await tick();
  const id = fake.pushedMessages[1].uuid;
  await proc._handleEvent(assistant('COMMAND', { user_message_uuid: id }));
  await proc._handleEvent(result('COMMAND', { user_message_uuid: id }));
  assert.equal(proc.pendingQueue.length, 1);
  assert.deepEqual(autonomous, ['COMMAND']);
});

test('overflow rejects the waiting user without leaking its prompt to SDK', async t => {
  const { proc, fake, send } = await fixture(t, { queueCap: 2 });
  const a = send('A'), b = send('B'), c = send('C'); await tick();
  assert.equal((await b.catch(e => e)).code, 'QUEUE_OVERFLOW');
  assert.deepEqual(fake.pushedMessages.map(m => m.message.content), ['A']);
  await proc._handleEvent(result('A', { user_message_uuid: fake.pushedMessages[0].uuid }));
  await a; await tick();
  assert.deepEqual(fake.pushedMessages.map(m => m.message.content), ['A', 'C']);
  await proc._handleEvent(result('C', { user_message_uuid: fake.pushedMessages[1].uuid })); await c;
});

test('drain removes buffered normal input before the SDK can execute it', async t => {
  const fake = makeFakeQuery({ echoUserUuids: false });
  const input = makeInputController();
  const { proc, send } = await fixture(t, { spawnFn: () => ({ query: fake.query, inputController: input }) });
  const a = send('CANCELLED');
  proc.drainQueue();
  assert.equal((await a.catch(e => e)).code, 'INTERRUPTED');
  assert.equal(input.size, 0, 'cancelled buffered input must be withdrawn');
  const b = send('NEW');
  assert.equal(input.size, 1);
  const msg = (await input.iter.next()).value;
  assert.equal(msg.message.content, 'NEW');
  await proc._handleEvent(result('NEW', { user_message_uuid: msg.uuid })); await b;
});

test('drain waits for a consumed physical turn and suppresses its late user text', async t => {
  const { proc, fake, send, autonomous, streams } = await fixture(t);
  const old = send('OLD'); await tick(); const id = fake.pushedMessages[0].uuid;
  proc.drainQueue(); await old.catch(() => {});
  const next = send('NEXT'); await tick();
  assert.equal(fake.pushedMessages.length, 1);
  await proc._handleEvent(assistant('LATE', { user_message_uuid: id }));
  await proc._handleEvent(assistant('LATE-CONTINUED'));
  await proc._handleEvent(result('OLD', { user_message_uuid: id })); await tick();
  assert.deepEqual(autonomous, []); assert.deepEqual(streams, []);
  assert.equal(fake.pushedMessages[1].message.content, 'NEXT');
  await proc._handleEvent(result('NEXT', { user_message_uuid: fake.pushedMessages[1].uuid })); await next;
});

for (const receiptKind of ['empty', 'survivor', 'absent']) {
  test(`interrupt ${receiptKind} receipt releases only proven safe successor input`, async t => {
    const { proc, fake, send } = await fixture(t);
    const old = send('OLD'); await tick(); const id = fake.pushedMessages[0].uuid;
    fake.query.interrupt = async () => receiptKind === 'absent' ? undefined : { still_queued: receiptKind === 'survivor' ? [id, 'internal'] : [] };
    proc.drainQueue(); await old.catch(() => {});
    const next = send('NEXT');
    await proc.interrupt(); await tick();
    assert.equal(fake.pushedMessages.length, receiptKind === 'empty' ? 2 : 1);
    if (receiptKind !== 'empty') {
      await proc._handleEvent(result('OLD', { user_message_uuid: id })); await tick();
    }
    assert.equal(fake.pushedMessages.length, 2);
    await proc._handleEvent(result('NEXT', { user_message_uuid: fake.pushedMessages[1].uuid })); await next;
  });
}

test('timeout waits for interrupt acknowledgement before activating successor timers', async t => {
  const { proc, fake, send, autonomous } = await fixture(t);
  let acknowledge; fake.query.interrupt = () => new Promise(r => { acknowledge = r; });
  const old = send('OLD', { timeoutMs: 15 });
  let activations = 0;
  const next = send('NEXT', { context: { onActivate() { activations++; } } });
  await old.catch(() => {}); await tick();
  const id = fake.pushedMessages[0].uuid;
  assert.equal(fake.pushedMessages.length, 1); assert.equal(activations, 0);
  acknowledge({ still_queued: [] }); await tick();
  assert.equal(activations, 1); assert.equal(fake.pushedMessages.length, 2);
  await proc._handleEvent(assistant('LATE', { user_message_uuid: id }));
  await proc._handleEvent(result('LATE', { user_message_uuid: id }));
  assert.deepEqual(autonomous, []); assert.equal(proc.pendingQueue.length, 1);
  await proc._handleEvent(result('NEXT', { user_message_uuid: fake.pushedMessages[1].uuid })); await next;
});

test('dropping buffered active input rejects only that send and releases its physical barrier', async t => {
  const input = makeInputController({ queueCap: 1 });
  const fake = makeFakeQuery({ echoUserUuids: false });
  const { proc, send } = await fixture(t, { spawnFn: () => ({ query: fake.query, inputController: input }) });
  const first = send('DROPPED');
  proc.fireUserMessage('STANDALONE');
  assert.equal((await first.catch(e => e)).code, 'QUEUE_OVERFLOW');
  await input.iter.next();
  const next = send('NEXT');
  assert.equal(input.size, 1, 'unsubmitted successor must not be blocked by dropped input');
  const msg = (await input.iter.next()).value;
  assert.equal(msg.message.content, 'NEXT');
  await proc._handleEvent(result('NEXT', { user_message_uuid: msg.uuid })); await next;
});

test('injection input overflow cannot reject an unrelated waiting normal send', async t => {
  const { proc, fake, send } = await fixture(t);
  send('ACTIVE'); const waiting = send('WAITING'); await tick();
  proc.injectUserMessage({ content: 'INJECT' }); await tick();
  proc._handleQueueDrop(fake.pushedMessages[1]);
  assert.equal(proc.pendingQueue.length, 2);
  await proc._handleEvent(result('ACTIVE', { user_message_uuid: fake.pushedMessages[0].uuid })); await tick();
  await proc._handleEvent(result('WAITING', { user_message_uuid: fake.pushedMessages[2].uuid }));
  assert.equal((await waiting).text, 'WAITING');
});

test('failed input push settles that user and leaves the session reusable', async t => {
  const { proc, fake, send } = await fixture(t);
  const push = proc.inputController.push;
  proc.inputController.push = () => { throw new Error('synthetic transport failure'); };
  const failure = await send('FAILED').catch(e => e);
  assert.equal(failure.message, 'synthetic transport failure');
  proc.inputController.push = push;
  const next = send('NEXT'); await tick();
  await proc._handleEvent(result('NEXT', { user_message_uuid: fake.pushedMessages[0].uuid }));
  assert.equal((await next).text, 'NEXT');
});

test('transient retry changes attempt identity without submitting waiting normal input', async t => {
  const { proc, fake, send, autonomous } = await fixture(t);
  const first = send('RETRY', { timeoutMs: 5000, maxTurnMs: 6000 }); send('WAITING'); await tick();
  const id = fake.pushedMessages[0].uuid;
  await proc._handleEvent(result('', { subtype: 'error_during_execution', error: 'HTTP 503 unavailable', user_message_uuid: id }));
  await new Promise(resolve => setTimeout(resolve, 2550));
  assert.deepEqual(fake.pushedMessages.map(m => m.message.content), ['RETRY', 'RETRY']);
  const retried = fake.pushedMessages[1].uuid;
  assert.notEqual(retried, id);
  await proc._handleEvent(assistant('STALE', { user_message_uuid: id }));
  await proc._handleEvent(result('STALE', { user_message_uuid: id }));
  assert.deepEqual(autonomous, []); assert.equal(proc.pendingQueue.length, 2);
  await proc._handleEvent(result('RECOVERED', { user_message_uuid: retried }));
  assert.equal((await first).text, 'RECOVERED');
});

test('current user UUID in a consumed batch wins over a retired sibling UUID', async t => {
  const { proc, fake, send, streams } = await fixture(t);
  const old = send('OLD'); await tick(); const retired = fake.pushedMessages[0].uuid;
  await proc.interrupt(); proc.drainQueue(); await old.catch(() => {});
  const current = send('CURRENT'); await tick(); const id = fake.pushedMessages[1].uuid;
  await proc._handleEvent(assistant('CURRENT', { user_message_uuids: [retired, id] }));
  assert.deepEqual(streams, ['CURRENT']);
  await proc._handleEvent(result('CURRENT', { user_message_uuids: [retired, id] }));
  assert.equal((await current).text, 'CURRENT');
});

test('retired first-frame echo still retires its physical turn on an unannotated result', async t => {
  const { proc, fake, send } = await fixture(t);
  const old = send('OLD'); await tick(); const id = fake.pushedMessages[0].uuid;
  proc.drainQueue(); await old.catch(() => {});
  send('NEXT');
  await proc._handleEvent(assistant('OLD', { user_message_uuid: id }));
  await proc._handleEvent(result('OLD'));
  await tick();
  assert.equal(fake.pushedMessages.length, 2);
});

test('terminal result before interrupt receipt cannot resurrect a finished survivor', async t => {
  const { proc, fake, send } = await fixture(t);
  const old = send('OLD'); await tick(); const id = fake.pushedMessages[0].uuid;
  proc.drainQueue(); await old.catch(() => {});
  send('NEXT');
  let acknowledge; fake.query.interrupt = () => new Promise(r => { acknowledge = r; });
  const interrupt = proc.interrupt();
  await proc._handleEvent(result('OLD', { user_message_uuid: id }));
  acknowledge({ still_queued: [id] }); await interrupt; await tick();
  assert.equal(fake.pushedMessages.length, 2);
});

test('cancelled owned continuation is suppressed even without a repeated UUID', async t => {
  const { proc, fake, send, autonomous } = await fixture(t);
  const old = send('OLD'); await tick();
  await proc._handleEvent(assistant('FIRST', { user_message_uuid: fake.pushedMessages[0].uuid }));
  proc.drainQueue(); await old.catch(() => {});
  await proc.interrupt();
  await proc._handleEvent(assistant('LATE-CONTINUATION'));
  assert.deepEqual(autonomous, []);
});

test('foreign origin invalidates a user binding before its unannotated continuation', async t => {
  const { proc, fake, send, streams, autonomous } = await fixture(t);
  send('USER'); await tick();
  await proc._handleEvent(assistant('OWNED', { user_message_uuid: fake.pushedMessages[0].uuid }));
  await proc._handleEvent(assistant('REPORT', { origin: { kind: 'peer' } }));
  await proc._handleEvent(assistant('REPORT-CONTINUED'));
  assert.deepEqual(streams, ['OWNED']);
  assert.deepEqual(autonomous, ['REPORT', 'REPORT-CONTINUED']);
});

test('onActivate drain cannot submit the user prompt after rejecting it', async t => {
  const { proc, fake, send } = await fixture(t);
  const p = send('CANCELLED', { context: { onActivate() { proc.drainQueue(); } } });
  assert.equal((await p.catch(e => e)).code, 'INTERRUPTED'); await tick();
  assert.deepEqual(fake.pushedMessages, []);
});

for (const candidate of [false, true]) {
  test(`${candidate ? 'candidate' : 'legacy'} report sequence preserves each queued user owner`, async t => {
    const { proc, fake, send, autonomous } = await fixture(t);
    const source = () => proc.pendingQueue.map(p => p.context.sourceMsgId);
    const owned = async (id, turns) => {
      const uuid = fake.pushedMessages[id - 1].uuid;
      const fields = { user_message_uuid: uuid, user_message_uuids: [uuid] };
      await proc._handleEvent(assistant(`REPLY-${id}`, fields));
      await proc._handleEvent(result(`REPLY-${id}`, { ...fields, num_turns: turns }));
    };
    const first = send('USER-1', { context: { sourceMsgId: 1 } });
    await tick();
    await owned(1, 4);
    assert.equal((await first).text, 'REPLY-1');
    const second = send('USER-2', { context: { sourceMsgId: 2 } });
    const third = send('USER-3', { context: { sourceMsgId: 3 } });
    await tick();
    assert.equal(fake.pushedMessages.length, 2);
    const notification = task => proc._handleEvent({ type: 'system', subtype: 'task_notification',
      task_id: `task-${task}`, status: 'completed', ...(candidate ? { run_id: `run-${task}` } : {}) });
    if (candidate) await notification(1);
    const peer = { kind: 'peer', from: 'task-1', senderTaskId: 'task-1', handback: true };
    await proc._handleEvent(assistant('AGENT-1-REPORT'));
    await proc._handleEvent(result('AGENT-1-REPORT', { origin: peer, num_turns: 1 }));
    assert.deepEqual(source(), [2, 3]);
    assert.deepEqual(autonomous, ['AGENT-1-REPORT']);
    if (candidate) {
      await proc._handleEvent(result('', { origin: { kind: 'task-notification',
        producer: 'session-task', runId: 'run-1' }, num_turns: 0 }));
      assert.deepEqual(source(), [2, 3]);
    } else await notification(1);
    await notification(2);
    assert.equal(fake.pushedMessages.length, 2, 'waiting normal prompt must remain outside SDK');
    await owned(2, 2);
    assert.equal((await second).text, 'REPLY-2');
    await tick();
    assert.deepEqual(source(), [3]);
    if (!candidate) {
      await proc._handleEvent(assistant('AGENT-2-REPORT'));
      await proc._handleEvent(result('AGENT-2-REPORT', {
        origin: { kind: 'task-notification' }, num_turns: 1 }));
      assert.deepEqual(source(), [3]);
      assert.deepEqual(autonomous, ['AGENT-1-REPORT', 'AGENT-2-REPORT']);
    }
    await owned(3, 1);
    assert.equal((await third).text, 'REPLY-3');
    assert.deepEqual(source(), []);
  });
}
