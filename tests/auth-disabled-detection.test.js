'use strict';

/**
 * AUTH_DISABLED detection (docs/AUTH_DISABLED_DETECTION_SPEC.md).
 *
 * Production bug: when Anthropic disables Claude subscription access for an
 * account, the `claude` CLI renders a fixed notice INSIDE the TUI instead of
 * exiting or surfacing an HTTP error orchestra's tmux wrapper can see — no
 * reply-tool call, no Stop hook. Pre-fix, the turn just hangs until the
 * 10-minute idle ceiling fires TURN_TIMEOUT, giving both consumer bots a
 * generic "went quiet" error with no indication of the real cause.
 *
 * These tests drive `_pollMidTurnDialogs()` directly against a manually-set
 * `pendingTurns` entry, mirroring `resume-dialog-fix.test.js`'s B2-midturn
 * test — no fake-bridge harness needed since the watchdog is a pure
 * capture-then-react method.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('../index');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

// Anthropic's fixed product string (verified against code.claude.com/docs/en/errors
// and anthropics/claude-code issues #63886, #62722, #68212).
const AUTH_DISABLED_NOTICE =
  'Your organization has disabled Claude subscription access for Claude Code · ' +
  'Use an Anthropic API key instead, or ask your admin to enable access';

function makeProc({ paneText, sent = [], events = [] } = {}) {
  const proc = new CliProcess({
    sessionKey: 's', chatId: '1',
    tmuxRunner: {
      spawn: async () => {},
      sendControl: async (_n, key) => { sent.push(key); },
      killSession: async () => {},
      captureWide: async () => paneText,
    },
    botName: 'b', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
  });
  proc.tmuxSession = 'orchestra-test-auth-disabled';
  return proc;
}

function addPendingTurn(proc, turnId = 't-1') {
  const record = { resolved: null, rejected: null };
  proc.pendingTurns.set(turnId, {
    resolve: (v) => { record.resolved = v; },
    reject: (e) => { record.rejected = e; },
    replies: [],
  });
  return record;
}

test('AUTH_DISABLED: single poll does not reject — debounce requires two consecutive matches', async () => {
  const proc = makeProc({ paneText: AUTH_DISABLED_NOTICE });
  const record = addPendingTurn(proc);

  await proc._pollMidTurnDialogs();

  assert.equal(record.rejected, null, 'a single matching poll must not reject the turn');
  assert.equal(proc.pendingTurns.size, 1, 'turn must still be pending after one poll');
});

test('AUTH_DISABLED: two consecutive matching polls reject with err.code AUTH_DISABLED', async () => {
  const sent = [];
  const events = [];
  const proc = makeProc({ paneText: AUTH_DISABLED_NOTICE, sent, events });
  const record = addPendingTurn(proc);
  const idleP = new Promise((resolve) => proc.once('idle', () => resolve(true)));

  await proc._pollMidTurnDialogs();
  assert.equal(record.rejected, null, 'first poll only arms detection');

  await proc._pollMidTurnDialogs();

  assert.ok(record.rejected, 'second consecutive matching poll must reject the pending turn');
  assert.equal(record.rejected.code, 'AUTH_DISABLED');
  assert.equal(proc.pendingTurns.size, 0, 'pendingTurns must be drained');
  assert.equal(await Promise.race([idleP, Promise.resolve(false)]), true,
    "'idle' must be emitted so a wired HeartbeatReactor stops cycling");
  assert.ok(events.some(e => e.kind === 'cli-auth-disabled-detected'),
    'telemetry must be logged via _logEvent');
});

test('AUTH_DISABLED: debounce resets on an intervening non-matching poll', async () => {
  const frames = [AUTH_DISABLED_NOTICE, 'nothing to see here, still thinking…', AUTH_DISABLED_NOTICE];
  let i = 0;
  const proc = makeProc({ paneText: '' });
  proc.runner.captureWide = async () => frames[Math.min(i++, frames.length - 1)];
  const record = addPendingTurn(proc);

  await proc._pollMidTurnDialogs();   // match #1 — arms
  await proc._pollMidTurnDialogs();   // no match — must disarm, not just skip
  await proc._pollMidTurnDialogs();   // match #2 — only the FIRST of a new pair

  assert.equal(record.rejected, null,
    'a non-matching poll between two matches must reset the debounce, not accumulate toward it');
  assert.equal(proc.pendingTurns.size, 1);
});

test('AUTH_DISABLED: does not false-positive on a legitimate reply mentioning API keys', async () => {
  const LEGIT_REPLY =
    'Sure — you can use an Anthropic API key instead of your Claude subscription ' +
    'for that automation script. Just set ANTHROPIC_API_KEY in your shell profile.';
  const proc = makeProc({ paneText: LEGIT_REPLY });
  const record = addPendingTurn(proc);

  await proc._pollMidTurnDialogs();
  await proc._pollMidTurnDialogs();
  await proc._pollMidTurnDialogs();

  assert.equal(record.rejected, null, 'mentioning API keys in a normal reply must never trigger AUTH_DISABLED');
  assert.equal(proc.pendingTurns.size, 1);
});

test('AUTH_DISABLED: bounded to the pane tail — a notice pushed out of the last 40 lines is not detected', async () => {
  const filler = Array.from({ length: 45 }, (_, n) => `line ${n}: unrelated tool output`);
  const paneText = [AUTH_DISABLED_NOTICE, ...filler].join('\n');
  const proc = makeProc({ paneText });
  const record = addPendingTurn(proc);

  await proc._pollMidTurnDialogs();
  await proc._pollMidTurnDialogs();

  assert.equal(record.rejected, null,
    'a notice scrolled beyond the last ~40 lines must not be detected — otherwise a legitimate ' +
    'quote of this string would stay "live" for the rest of the session');
  assert.equal(proc.pendingTurns.size, 1);
});

test('AUTH_DISABLED: drains ALL pending turns, not just one', async () => {
  const proc = makeProc({ paneText: AUTH_DISABLED_NOTICE });
  const recordA = addPendingTurn(proc, 't-a');
  const recordB = addPendingTurn(proc, 't-b');

  await proc._pollMidTurnDialogs();
  await proc._pollMidTurnDialogs();

  assert.equal(recordA.rejected.code, 'AUTH_DISABLED');
  assert.equal(recordB.rejected.code, 'AUTH_DISABLED');
  assert.equal(proc.pendingTurns.size, 0);
});

test('AUTH_DISABLED: resets inFlight and does not send dismissal keystrokes or fire other mid-turn telemetry', async () => {
  const sent = [];
  const events = [];
  const proc = makeProc({ paneText: AUTH_DISABLED_NOTICE, sent, events });
  addPendingTurn(proc);
  proc.inFlight = true;

  await proc._pollMidTurnDialogs();
  await proc._pollMidTurnDialogs();

  assert.equal(proc.inFlight, false, 'inFlight must be reset — mirrors _doKill/resetSession/_handleBridgeDisconnected');
  assert.deepEqual(sent, [], 'no dismissal keystrokes should be sent for a terminal auth failure');
  assert.ok(!events.some(e => e.kind === 'cli-mid-turn-unknown-prompt'),
    'the same poll must not also fire the unknown-prompt heuristic once AUTH_DISABLED is confirmed');
  assert.ok(!events.some(e => e.kind === 'cli-mid-turn-dialog-detected'),
    'the same poll must not also fire the MID_TURN_PROMPTS catalog once AUTH_DISABLED is confirmed');
});

test('AUTH_DISABLED: drains matching pendingQueue entries too, and skips ones already covered by pendingTurns', async () => {
  const proc = makeProc({ paneText: AUTH_DISABLED_NOTICE });
  const record = addPendingTurn(proc, 't-1');
  // Mirrors send()'s own bookkeeping: every pendingTurns entry has a matching
  // pendingQueue row pushed at send()-time (cli-process.js send()), plus queue
  // rows can exist from callers other than this.send (resetSession's own
  // comment) — simulate one of each.
  let queueOnlyRejected = null;
  proc.pendingQueue.push({ turnId: 't-1', context: {} });               // covered by pendingTurns — must NOT double-reject
  proc.pendingQueue.push({
    turnId: 'queue-only', context: {},
    reject: (e) => { queueOnlyRejected = e; },
  });

  await proc._pollMidTurnDialogs();
  await proc._pollMidTurnDialogs();

  assert.equal(record.rejected.code, 'AUTH_DISABLED');
  assert.ok(queueOnlyRejected, 'a pendingQueue-only entry (no matching pendingTurns row) must still be rejected');
  assert.equal(queueOnlyRejected.code, 'AUTH_DISABLED');
  assert.equal(proc.pendingQueue.length, 0, 'pendingQueue must be fully drained');
});

test('AUTH_DISABLED: a turn that arms then resolves normally must not poison the NEXT unrelated turn (stale-arm regression)', async () => {
  // Turn A's reply happens to quote the exact notice text once (e.g. the user
  // asked Claude to explain this error), then Turn A resolves normally via
  // Stop — pendingTurns empties BEFORE a confirming second poll ever runs.
  const proc = makeProc({ paneText: AUTH_DISABLED_NOTICE });
  addPendingTurn(proc, 't-a');

  await proc._pollMidTurnDialogs();   // arms — turn A still pending
  proc.pendingTurns.clear();          // simulate turn A resolving via Stop before the next poll
  await proc._pollMidTurnDialogs();   // pendingTurns.size === 0 → must reset the arm, not just skip

  // A fresh, unrelated turn B starts. If the old notice text is still within
  // the last 40 lines of the pane (plausible — nothing scrolled it away),
  // its FIRST poll must only arm, never falsely "confirm" against turn A's
  // stale arm.
  const recordB = addPendingTurn(proc, 't-b');
  await proc._pollMidTurnDialogs();

  assert.equal(recordB.rejected, null,
    "turn B's first poll must not be rejected — the stale arm from turn A's resolved turn must not carry over");
  assert.equal(proc.pendingTurns.size, 1);
});
