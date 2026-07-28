'use strict';

/**
 * The `stream` bridge tool — live-preview snapshots of the answer an agent is
 * still composing.
 *
 * The contract these tests pin, in one sentence: a snapshot is cosmetic, so it
 * must reach the right turn's preview or reach nothing at all, and it must
 * never touch delivery, turn resolution, or the reply rate limit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CliProcess } = require('../index');
const { createProcessFactory } = require('../lib/process/factory');
const { ToolCallMessageSchema } = require('../lib/process/channels-bridge-protocol');

const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => '',
};
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeProc({ chatId = '111', capabilities = { stream: true }, dispatcher, appDataDir } = {}) {
  const events = [];
  const acks = [];
  const chunks = [];
  const p = new CliProcess({
    sessionKey: 'sess-stream',
    chatId,
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    claudeBin: '/usr/bin/echo',
    toolDispatcher: dispatcher || (async () => ({ ok: true, message_id: 9 })),
    toolDispatcherCapabilities: capabilities,
    ...(appDataDir ? { appDataDir } : {}),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
  });
  p._writeToBridge = (obj) => { acks.push(obj); return true; };
  p.on('stream-chunk', (t) => chunks.push(t));
  return { p, events, acks, chunks };
}

/** Register a turn the way send() does, minus the socket. */
function addTurn(p, turnId, { withTimer = false } = {}) {
  p.pendingQueue.push({ turnId, context: {} });
  const pending = { replies: [], _idleCeilingMs: 60_000 };
  if (withTimer) {
    pending._fireTimeout = () => { pending._firedTimeout = true; };
    pending.hardTimer = setTimeout(() => {}, 60_000);
    pending.hardTimer.unref?.();
  }
  p.pendingTurns.set(turnId, pending);
  return pending;
}

const streamCall = (turnId, text, { chatId = '111', id = 'tc-1' } = {}) => ({
  kind: 'tool', session: 'sess-stream', tool_call_id: id, name: 'stream',
  args: { chat_id: chatId, turn_id: turnId, text },
});

// ─── protocol ──────────────────────────────────────────────────────

test('protocol accepts a stream tool message', () => {
  const parsed = ToolCallMessageSchema.safeParse(
    streamCall('t-1', 'half an answer'),
  );
  assert.equal(parsed.success, true);
});

test('protocol still rejects an unknown tool name', () => {
  const parsed = ToolCallMessageSchema.safeParse({
    ...streamCall('t-1', 'x'), name: 'streamm',
  });
  assert.equal(parsed.success, false);
});

// ─── env gate ──────────────────────────────────────────────────────

test('env gate: the var is always WRITTEN, so an ambient value cannot leak in', () => {
  // Omitting the var would let an ORCHESTRA_STREAM_TOOL=1 inherited from
  // anywhere up the daemon → tmux → claude → MCP-child chain switch the tool on
  // for a consumer that never opted in. Omission is not a decision; '' is.
  const { p: on } = makeProc({ capabilities: { stream: true } });
  const { p: off } = makeProc({ capabilities: null });
  assert.equal(on._bridgeEnv().ORCHESTRA_STREAM_TOOL, '1');
  assert.equal('ORCHESTRA_STREAM_TOOL' in off._bridgeEnv(), true,
    'the var must be present-and-empty, not absent');
  assert.equal(off._bridgeEnv().ORCHESTRA_STREAM_TOOL, '');
});

test('env gate: {stream:false} is not opting in', () => {
  const { p } = makeProc({ capabilities: { stream: false } });
  assert.equal(p.streamToolEnabled, false);
  assert.equal(p._bridgeEnv().ORCHESTRA_STREAM_TOOL, '');
});

test('daemon-side gate: a stream call is refused when the consumer never opted in', async () => {
  // Defense in depth. The bridge decides what to REGISTER from its environment,
  // which is not entirely ours to control; the daemon decides what to HONOR.
  const { p, acks, chunks, events } = makeProc({ capabilities: null });
  addTurn(p, 't-1');
  await p._dispatchToolCall(streamCall('t-1', 'text from a bridge we did not enable'));
  assert.deepEqual(chunks, [],
    'never emit stream-chunk at a consumer with nothing wired to receive it');
  assert.equal(acks[0].ok, false);
  assert.match(acks[0].error, /not enabled/);
  assert.equal(events.filter(e => e.kind === 'stream-tool-not-enabled').length, 1);
});

test('bridge registers the stream tool + accepts the call ONLY under the env gate', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'process', 'channels-bridge.mjs'), 'utf8',
  );
  assert.match(src, /const STREAM_TOOL_ENABLED = process\.env\.ORCHESTRA_STREAM_TOOL === '1'/);
  // The tool entry is spread in conditionally, and the CallTool guard is built
  // from the same flag — a call to a tool that was never listed is rejected.
  assert.match(src, /\.\.\.\(STREAM_TOOL_ENABLED \? \[\{\s*\n\s*name: 'stream'/);
  assert.match(src, /STREAM_TOOL_ENABLED \? \['stream'\] : \[\]/);
});

test('prompt: the stream contract section is present only when gated on', async () => {
  // The section is built inside the --append-system-prompt block, so assert on
  // the built args rather than the source: what claude sees is what matters.
  const tmpBase = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'orchestra-stream-'));
  const promptOf = async (capabilities) => {
    const { p } = makeProc({ capabilities, appDataDir: tmpBase });
    let captured = null;
    p.runner = {
      ...fakeRunner,
      spawn: async ({ args }) => {
        const i = args.indexOf('--append-system-prompt');
        captured = args[i + 1];
      },
    };
    // The startup-dialog gate polls a real tmux pane; the prompt is already
    // built by the time spawn() is called.
    p._handleStartupDialogs = async () => {};
    p.sockPath = path.join(tmpBase, 'orchestra-test.sock');
    p.sockSecret = 's';
    p.claudeSessionId = 'cs-1';
    await p._spawnTmuxClaude({ tmuxName: 'n', opts: { cwd: tmpBase } });
    return captured;
  };
  try {
    const on = await promptOf({ stream: true });
    const off = await promptOf(null);
    assert.match(on, /### Showing your answer as you write it/);
    assert.match(on, /mcp__orchestra-bridge__stream/);
    assert.match(on, /NEVER end a turn on a stream call/);
    assert.doesNotMatch(off, /__stream/,
      'a consumer without the capability must not be coached toward the tool');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ─── guards ────────────────────────────────────────────────────────

test('guard: chat_id mismatch is rejected with no side effects', async () => {
  const { p, acks, chunks, events } = makeProc();
  addTurn(p, 't-1');
  await p._dispatchToolCall(streamCall('t-1', 'text', { chatId: '999' }));
  assert.deepEqual(chunks, []);
  assert.equal(acks[0].ok, false);
  assert.match(acks[0].error, /chat_id mismatch/);
  assert.equal(events.length, 0);
});

test('guard: empty / whitespace-only text is rejected', async () => {
  const { p, acks, chunks } = makeProc();
  addTurn(p, 't-1');
  await p._dispatchToolCall(streamCall('t-1', ''));
  await p._dispatchToolCall(streamCall('t-1', '   \n\t '));
  await p._dispatchToolCall({ ...streamCall('t-1', 'x'), args: { chat_id: '111', turn_id: 't-1' } });
  assert.deepEqual(chunks, [], 'a blank snapshot would wipe the preview for nothing');
  assert.equal(acks.length, 3);
  for (const a of acks) assert.equal(a.ok, false);
});

test('guard: a snapshot with no turn_id is rejected, never bound to the head', async () => {
  const { p, acks, chunks } = makeProc();
  addTurn(p, 't-1');
  await p._dispatchToolCall({
    kind: 'tool', session: 's', tool_call_id: 'tc', name: 'stream',
    args: { chat_id: '111', text: 'orphan text' },
  });
  assert.deepEqual(chunks, []);
  assert.equal(acks[0].ok, false);
  assert.match(acks[0].error, /turn_id/);
});

// ─── attribution ───────────────────────────────────────────────────

test('attribution: a matched head turn emits stream-chunk + stream-seen', async () => {
  const { p, acks, chunks, events } = makeProc();
  addTurn(p, 't-1');
  await p._dispatchToolCall(streamCall('t-1', 'the answer so far'));
  assert.deepEqual(chunks, ['the answer so far']);
  assert.equal(acks[0].ok, true);
  const seen = events.filter(e => e.kind === 'stream-seen');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].detail.turn_id, 't-1');
  assert.equal(seen[0].detail.len, 'the answer so far'.length);
  assert.equal(seen[0].detail.resumed, false);
});

test('attribution: stream-seen segments fresh spawns from resumed sessions', async () => {
  const { p, events } = makeProc();
  p._resumedSession = true;
  addTurn(p, 't-1');
  await p._dispatchToolCall(streamCall('t-1', 'text'));
  assert.equal(events.find(e => e.kind === 'stream-seen').detail.resumed, true);
});

test('attribution: an unknown turn_id is dropped, never routed to the head turn', async () => {
  const { p, acks, chunks, events } = makeProc();
  addTurn(p, 't-1');
  await p._dispatchToolCall(streamCall('t-foreign', 'text from a /compact cycle'));
  assert.deepEqual(chunks, [], 'a foreign cycle must never paint a user preview');
  assert.equal(acks[0].ok, true, 'dropped is not failed — the turn must not be disturbed');
  const un = events.filter(e => e.kind === 'stream-unattributed');
  assert.equal(un.length, 1);
  assert.equal(un[0].detail.reason, 'no-pending-turn');
});

test('attribution: a closed turn is dropped', async () => {
  const { p, chunks, events } = makeProc();
  addTurn(p, 't-1');
  p.pendingQueue.length = 0;
  p.pendingTurns.clear();
  await p._dispatchToolCall(streamCall('t-1', 'late snapshot'));
  assert.deepEqual(chunks, []);
  assert.equal(events.filter(e => e.kind === 'stream-unattributed').length, 1);
});

test('attribution: a queued (non-head) turn is dropped', async () => {
  // The consumer routes stream-chunk to the HEAD turn's preview, so a snapshot
  // belonging to a queued turn would land on the wrong bubble.
  const { p, chunks, events } = makeProc();
  addTurn(p, 't-head');
  addTurn(p, 't-queued');
  await p._dispatchToolCall(streamCall('t-queued', 'text'));
  assert.deepEqual(chunks, []);
  assert.equal(events.find(e => e.kind === 'stream-unattributed').detail.reason, 'not-head');
});

// ─── isolation from delivery + turn resolution ─────────────────────

test('stream never touches pending.replies or the delivery ledger', async () => {
  const { p } = makeProc();
  const pending = addTurn(p, 't-1');
  for (let i = 0; i < 5; i++) await p._dispatchToolCall(streamCall('t-1', `draft ${i}`));
  assert.deepEqual(pending.replies, [], 'a preview is not a delivery');
  assert.equal(p._deliveryAttempts.size, 0);
  assert.equal(p.recentContentHashes.size, 0);
  assert.equal(p.recentToolCallIds.size, 0);
  // Every _computeTurnDelivery branch keys on a landed `reply`; 5 snapshots
  // leave the turn exactly where it started — a zero-reply turn.
  const computed = p._computeTurnDelivery(pending, 't-1');
  assert.equal(computed.branch, 'zero-reply');
  assert.equal(computed.text, '');
  assert.equal(computed.alreadyDelivered, false);
});

test('stream calls do not consume the reply rate-limit budget', async () => {
  const { p } = makeProc();
  addTurn(p, 't-1');
  const before = p.toolRateTokens;
  for (let i = 0; i < 30; i++) await p._dispatchToolCall(streamCall('t-1', `draft ${i}`));
  assert.equal(p.toolRateTokens, before,
    'a snapshot burst must not starve the reply that ends the turn');
});

test('stream resets the idle ceiling but never cancels a stop-grace', async () => {
  const { p } = makeProc();
  const pending = addTurn(p, 't-1', { withTimer: true });
  const before = pending.hardTimer;
  // A turn already resolving: a trailing snapshot must not de-finalize it.
  pending._stopGracePending = true;
  pending._stopGraceTimer = setTimeout(() => {}, 60_000);
  pending._stopGraceTimer.unref?.();
  p._sawHookStream = true;

  await p._dispatchToolCall(streamCall('t-1', 'trailing draft'));

  assert.notEqual(pending.hardTimer, before, 'idle ceiling re-armed');
  assert.equal(pending._stopGracePending, true, 'stop-grace survives a stream call');
  assert.ok(pending._stopGraceTimer, 'stop-grace timer not cleared');
  clearTimeout(pending.hardTimer);
  clearTimeout(pending._stopGraceTimer);
});

// ─── cap ───────────────────────────────────────────────────────────

test('cap: snapshots past 200 per turn are dropped, with one event', async () => {
  const { p, chunks, events } = makeProc();
  addTurn(p, 't-1');
  for (let i = 0; i < 205; i++) await p._dispatchToolCall(streamCall('t-1', `draft ${i}`));
  assert.equal(chunks.length, 200);
  const capped = events.filter(e => e.kind === 'stream-cap-exceeded');
  assert.equal(capped.length, 1, 'one event per runaway, not per dropped call');
  assert.equal(capped[0].detail.cap, 200);
});

test('cap: the ack stays ok after the cap trips (a preview never fails a turn)', async () => {
  const { p, acks } = makeProc();
  addTurn(p, 't-1');
  for (let i = 0; i < 202; i++) await p._dispatchToolCall(streamCall('t-1', `d${i}`));
  assert.equal(acks.at(-1).ok, true);
});

test('cap: a flood of invented turn_ids cannot reset the live turn\'s count', async () => {
  // The escape this closes: when the count lived in a bounded map keyed by the
  // caller-supplied turn_id, a burst of invented ids evicted the live turn's
  // entry and the cap started over — indefinitely. `stream` skips the reply
  // token bucket, so this cap is the only bound there is.
  const { p, chunks, events } = makeProc();
  addTurn(p, 't-live');

  for (let i = 0; i < 200; i++) await p._dispatchToolCall(streamCall('t-live', `d${i}`));
  assert.equal(chunks.length, 200, 'the cap is reached');

  for (let i = 0; i < 64; i++) {
    await p._dispatchToolCall(streamCall(`forged-${i}`, 'evict the counter', { id: `tc-f${i}` }));
  }

  await p._dispatchToolCall(streamCall('t-live', 'past the cap again'));
  assert.equal(chunks.length, 200, 'the live turn is still capped');
  assert.equal(
    events.filter(e => e.kind === 'stream-cap-exceeded').length, 1,
    'still one cap event for the one runaway',
  );
});

test('cap state is held by the turn and dies with it', async () => {
  const { p, chunks } = makeProc();
  const entry = { turnId: 't-1', context: {} };
  p.pendingQueue.push(entry);
  p.pendingTurns.set('t-1', { replies: [] });
  for (let i = 0; i < 3; i++) await p._dispatchToolCall(streamCall('t-1', `d${i}`));
  assert.equal(entry._streamCalls, 3, 'the count rides the queue entry, not a side map');
  assert.equal(chunks.length, 3);
});

test('cap is per turn, not per process', async () => {
  const { p, chunks } = makeProc();
  addTurn(p, 't-1');
  for (let i = 0; i < 201; i++) await p._dispatchToolCall(streamCall('t-1', `d${i}`));
  p.pendingQueue.length = 0;
  p.pendingTurns.clear();
  addTurn(p, 't-2');
  await p._dispatchToolCall(streamCall('t-2', 'fresh turn draft'));
  assert.equal(chunks.at(-1), 'fresh turn draft');
});

// ─── factory wiring ────────────────────────────────────────────────

test('factory threads toolDispatcherCapabilities into CliProcess', () => {
  const build = (capabilities) => createProcessFactory({
    config: { bot: { pm: 'cli' } },
    tmuxRunner: fakeRunner,
    botName: 'b',
    toolDispatcher: async () => ({ ok: true }),
    toolDispatcherCapabilities: capabilities,
    channelsClaudeBin: '/usr/bin/echo',
    logger: quietLogger,
  })('k', { chatId: '5' });

  assert.equal(build({ stream: true }).streamToolEnabled, true);
  assert.equal(build(null).streamToolEnabled, false,
    'consumers that never pass capabilities are unaffected');
  assert.equal(
    build((chatId) => ({ stream: chatId === '5' })).streamToolEnabled, true,
    'a resolver lets the capability roll out per chat',
  );
  assert.equal(
    build((chatId) => ({ stream: chatId === 'other' })).streamToolEnabled, false,
  );
});
