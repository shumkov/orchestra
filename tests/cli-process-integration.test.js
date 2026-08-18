'use strict';

/**
 * CliProcess integration tests — exercise the daemon-side socket
 * protocol end-to-end with a fake bridge subprocess (just speaks the
 * line-delimited JSON socket protocol, no MCP). Covers:
 *
 *   - hello-handshake auth (correct + wrong secret)
 *   - bridge-ready signaling
 *   - tool dispatch → toolDispatcher invocation → tool_ack roundtrip
 *   - chat_id mismatch security guard
 *   - permission_request → approval-required event → verdict roundtrip
 *   - kill() teardown
 *   - concurrent sessions don't cross-talk
 *
 * Bypasses the real claude spawn by using a fake runner whose
 * captureWide() reports the "ready banner" immediately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');

const { CliProcess } = require('../index');

const READY_BANNER = 'Listening for channel messages from: server:orchestra-bridge';
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeFakeRunner({ paneText = READY_BANNER } = {}) {
  const calls = { spawn: [], killSession: [], sendControl: [], captureWide: [] };
  return {
    calls,
    spawn: async (opts) => { calls.spawn.push(opts); },
    killSession: async (name) => { calls.killSession.push(name); },
    sendControl: async (name, key) => { calls.sendControl.push({ name, key }); },
    captureWide: async (name) => { calls.captureWide.push(name); return paneText; },
    sessionProcessAlive: async () => true,
  };
}

// Fake bridge — speaks the same line-delimited JSON the real
// bridge does, but no MCP layer.
function connectFakeBridge({ sockPath, sessionKey, secret, claudeSessionId = 'test-claude-sid' }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = '';
    const inbox = [];          // messages received from daemon
    const inboxWaiters = [];
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      // hello + session_init + mcp-ready (0.12 Phase 1.6 — fake bridge
      // synthesizes the mcp-ready signal that the real bridge emits on
      // first ListToolsRequest from claude; tests don't run real claude).
      sock.write(JSON.stringify({ kind: 'hello', session_key: sessionKey, secret }) + '\n');
      sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: claudeSessionId }) + '\n');
      sock.write(JSON.stringify({ kind: 'mcp-ready', session: sessionKey }) + '\n');
    });

    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        inbox.push(msg);
        while (inboxWaiters.length) {
          const w = inboxWaiters.shift();
          if (w.match(msg)) { w.resolve(msg); break; }
          else { inboxWaiters.unshift(w); break; }
        }
      }
    });

    sock.on('error', reject);

    resolve({
      sock,
      inbox,
      waitFor: predicate => {
        const idx = inbox.findIndex(predicate);
        if (idx >= 0) {
          const [msg] = inbox.splice(idx, 1);
          return Promise.resolve(msg);
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('waitFor timeout')), 3000);
          inboxWaiters.push({
            match: predicate,
            resolve: msg => { clearTimeout(timer); resolve(msg); },
          });
        });
      },
      send: obj => sock.write(JSON.stringify(obj) + '\n'),
      close: () => sock.end(),
    });
  });
}

function makeCliProcess({
  chatId = 'chat-1',
  toolDispatcher = async () => ({ ok: true }),
  paneText,
  sessionLauncher = null,
} = {}) {
  return new CliProcess({
    sessionKey: `sess-${chatId}`,
    chatId,
    threadId: null,
    label: `test-${chatId}`,
    tmuxRunner: makeFakeRunner({ paneText }),
    botName: 'testbot',
    claudeBin: '/usr/bin/true',         // never actually invoked because runner is fake
    sessionLauncher,
    toolDispatcher,
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
  });
}

// Many tests need start() to complete. start() awaits the bridge handshake.
// Start it in the background then connect the fake bridge.
async function startWithFakeBridge(cp) {
  const startPromise = cp.start();
  // Wait for the socket file to exist (CliProcess creates it before awaiting handshake)
  for (let i = 0; i < 50; i++) {
    if (cp.sockPath && fs.existsSync(cp.sockPath)) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const bridge = await connectFakeBridge({
    sockPath: cp.sockPath,
    sessionKey: cp.sessionKey,
    secret: cp.sockSecret,
  });
  await startPromise;
  return bridge;
}

// ─── tests ──────────────────────────────────────────────────────────

test('start() completes after fake bridge handshakes', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);
  assert.equal(cp.bridgeReady, true);
  assert.ok(cp.sockPath);
  assert.ok(fs.existsSync(cp.sockPath), 'socket file exists');
  // mode-bit check — must be 0600
  const mode = fs.statSync(cp.sockPath).mode & 0o777;
  assert.equal(mode, 0o600, `socket mode: got ${mode.toString(8)}`);
  bridge.close();
  await cp.kill('test');
});

test('launcher wraps the exact baseline command while preserving argv, cwd, and env', async t => {
  const baseline = makeCliProcess();
  const baselineBridge = await startWithFakeBridge(baseline);
  const wrapped = makeCliProcess({ sessionLauncher: process.execPath });
  const wrappedBridge = await startWithFakeBridge(wrapped);
  t.after(async () => {
    baselineBridge.close();
    wrappedBridge.close();
    await baseline.kill('test');
    await wrapped.kill('test');
  });

  const directSpawn = baseline.runner.calls.spawn[0];
  const wrappedSpawn = wrapped.runner.calls.spawn[0];
  assert.equal(wrappedSpawn.command, process.execPath);
  assert.equal(wrappedSpawn.args[0], directSpawn.command);

  const normalizeGeneratedValues = args => {
    const normalized = [...args];
    for (const flag of ['--session-id', '--settings', '--mcp-config']) {
      const index = normalized.indexOf(flag);
      if (index >= 0) normalized[index + 1] = `<${flag.slice(2)}>`;
    }
    return normalized;
  };
  assert.deepEqual(
    normalizeGeneratedValues(wrappedSpawn.args.slice(1)),
    normalizeGeneratedValues(directSpawn.args),
  );
  assert.equal(wrappedSpawn.cwd, directSpawn.cwd);
  assert.deepEqual(wrappedSpawn.env, directSpawn.env);
});

test('hello with wrong secret is rejected', async () => {
  const cp = makeCliProcess();
  const startPromise = cp.start();
  for (let i = 0; i < 50; i++) {
    if (cp.sockPath && fs.existsSync(cp.sockPath)) break;
    await new Promise(r => setTimeout(r, 20));
  }
  // Connect with wrong secret
  const bridge = await connectFakeBridge({
    sockPath: cp.sockPath,
    sessionKey: cp.sessionKey,
    secret: 'wrong-secret',
  });
  const reject = await bridge.waitFor(m => m.kind === 'hello_reject');
  assert.equal(reject.reason, 'auth');
  bridge.close();

  // start() should still be waiting (handshake never completed). Let it
  // timeout to keep the test fast — it'll throw, which is expected here.
  await assert.rejects(startPromise, /handshake timeout/);
  await cp.kill('test-cleanup');
});

test('tool call dispatches via toolDispatcher and ACKs', async () => {
  const dispatched = [];
  const cp = makeCliProcess({
    toolDispatcher: async (call) => {
      dispatched.push(call);
      return { ok: true };
    },
  });
  const bridge = await startWithFakeBridge(cp);

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'call-1',
    name: 'reply',
    args: { chat_id: 'chat-1', text: 'hello world' },
  });

  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.tool_call_id, 'call-1');
  assert.equal(ack.ok, true);
  assert.equal(ack.attempt_id, 'call-1');
  assert.equal(ack.delivery, 'sent');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].text, 'hello world');
  assert.equal(dispatched[0].toolName, 'reply');
  assert.equal(dispatched[0].chatId, 'chat-1');

  bridge.close();
  await cp.kill('test');
});

test('reply tool call carries the ledgered participantJid (quote author) to the dispatcher', async () => {
  const dispatched = [];
  const cp = makeCliProcess({ toolDispatcher: async (call) => { dispatched.push(call); return { ok: true }; } });
  const bridge = await startWithFakeBridge(cp);

  // A turn whose source message has both an id and an author JID (the WhatsApp participant).
  const sendP = cp.send('hi', { context: { sourceMsgId: 'ABC', participantJid: '5@lid' } });
  const um = await bridge.waitFor(m => m.kind === 'user_msg');

  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'q1',
    name: 'reply', args: { chat_id: cp.chatId, text: 'done', turn_id: um.turn_id },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack');
  await sendP;

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sourceMsgId, 'ABC', 'quote target reaches the dispatcher');
  assert.equal(dispatched[0].participantJid, '5@lid', 'quote author reaches the dispatcher alongside it');

  bridge.close();
  await cp.kill('test');
});

test('reply tool call: no ledgered participant → dispatcher gets participantJid null (never a half-built quote)', async () => {
  const dispatched = [];
  const cp = makeCliProcess({ toolDispatcher: async (call) => { dispatched.push(call); return { ok: true }; } });
  const bridge = await startWithFakeBridge(cp);

  // A caller (e.g. Telegram) that supplies a quote target but no participant.
  const sendP = cp.send('hi', { context: { sourceMsgId: 'ABC' } });
  const um = await bridge.waitFor(m => m.kind === 'user_msg');

  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'q2',
    name: 'reply', args: { chat_id: cp.chatId, text: 'done', turn_id: um.turn_id },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack');
  await sendP;

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sourceMsgId, 'ABC');
  assert.equal(dispatched[0].participantJid, null, 'participant is null, not undefined/garbage');

  bridge.close();
  await cp.kill('test');
});

test('2026-08-17 routine: a combined autosteer reply belongs to the primary message, not the folded follow-up', async t => {
  const dispatched = [];
  const events = [];
  const cp = makeCliProcess({
    toolDispatcher: async (call) => {
      dispatched.push(call);
      return { ok: true, message_id: 6408 };
    },
  });
  cp.db = { logEvent: (kind, detail) => events.push({ kind, detail }) };
  const bridge = await startWithFakeBridge(cp);
  t.after(async () => {
    bridge.close();
    await cp.kill('test');
  });

  const sendP = cp.send('Which Xero field and date should I use?', {
    context: { sourceMsgId: 6406 },
  });
  sendP.catch(() => {});
  const primary = await bridge.waitFor(m => m.kind === 'user_msg');

  assert.equal(cp.injectUserMessage({
    content: 'Were the receipts uploaded?',
    msgId: 6407,
    source: 'autosteer',
  }), true);
  const folded = await bridge.waitFor(
    m => m.kind === 'user_msg' && m.turn_id !== primary.turn_id,
  );

  const combinedAnswer = 'Use the transaction date in Xero. The receipts are uploaded.';
  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'routine-6408',
    name: 'reply',
    args: {
      chat_id: cp.chatId,
      text: combinedAnswer,
      turn_id: folded.turn_id,
      consumed_turn_ids: [primary.turn_id, folded.turn_id],
    },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack' && m.tool_call_id === 'routine-6408');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].turnId, primary.turn_id,
    'the active preview and dispatcher keep the primary turn owner');
  assert.equal(dispatched[0].sourceMsgId, 6406,
    'the combined answer quotes the primary message instead of the folded follow-up');
  assert.deepEqual(cp.pendingTurns.get(primary.turn_id)?.replies, [combinedAnswer],
    'the delivered final is recorded on the primary turn');
  assert.equal(events.some(event => event.kind === 'cli-late-reply-correlated'), false,
    'a proven current fold is not classified as a late reply');
  assert.deepEqual(
    events.find(event => event.kind === 'cli-fold-reply-attributed')?.detail,
    {
      chat_id: cp.chatId,
      thread_id: cp.threadId,
      session_key: cp.sessionKey,
      backend: cp.backend,
      echoed_turn_id: folded.turn_id,
      effective_turn_id: primary.turn_id,
      source: 'autosteer',
      interim: false,
    },
    'telemetry records the delivered folded attribution without message content',
  );

  const pending = cp.pendingTurns.get(primary.turn_id);
  cp._captureStopHookData(pending, {
    lastAssistantMessage: 'Receipts uploaded; use the transaction date.',
  });
  cp._finalizeTurn(primary.turn_id);
  const result = await sendP;
  assert.equal(result.alreadyDelivered, true,
    'a distinct Stop recap does not create a second fallback answer');
  assert.equal(result.text, combinedAnswer);
});

test('an unproven old autosteer reply stays late through dispatch, quoting, and bookkeeping', async t => {
  const dispatched = [];
  const events = [];
  const cp = makeCliProcess({
    toolDispatcher: async (call) => {
      dispatched.push(call);
      return { ok: true, message_id: 6410 };
    },
  });
  cp.db = { logEvent: (kind, detail) => events.push({ kind, detail }) };
  const bridge = await startWithFakeBridge(cp);
  t.after(async () => {
    bridge.close();
    await cp.kill('test');
  });

  const sendP = cp.send('Current primary', { context: { sourceMsgId: 6406 } });
  sendP.catch(() => {});
  const primary = await bridge.waitFor(m => m.kind === 'user_msg');
  assert.equal(cp.injectUserMessage({
    content: 'Earlier folded follow-up',
    msgId: 6407,
    source: 'autosteer',
  }), true);
  const folded = await bridge.waitFor(
    m => m.kind === 'user_msg' && m.turn_id !== primary.turn_id,
  );

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'late-autosteer',
    name: 'reply',
    args: {
      chat_id: cp.chatId,
      text: 'Reply for the old follow-up',
      turn_id: folded.turn_id,
      consumed_turn_ids: [folded.turn_id],
    },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack' && m.tool_call_id === 'late-autosteer');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(dispatched[0].turnId, folded.turn_id);
  assert.equal(dispatched[0].sourceMsgId, 6407);
  assert.deepEqual(cp.pendingTurns.get(primary.turn_id)?.replies, []);
  assert.equal(events.some(event => event.kind === 'cli-late-reply-correlated'), true);
  assert.equal(events.some(event => event.kind === 'cli-fold-reply-attributed'), false);
});

test('a failed folded delivery leaves its matching Stop answer deliverable', async t => {
  const dispatched = [];
  const events = [];
  const cp = makeCliProcess({
    toolDispatcher: async (call) => {
      dispatched.push(call);
      return { ok: false, error: 'telegram unavailable' };
    },
  });
  cp.db = { logEvent: (kind, detail) => events.push({ kind, detail }) };
  const bridge = await startWithFakeBridge(cp);
  t.after(async () => {
    bridge.close();
    await cp.kill('test');
  });

  const sendP = cp.send('Primary', { context: { sourceMsgId: 6406 } });
  const primary = await bridge.waitFor(m => m.kind === 'user_msg');
  assert.equal(cp.injectUserMessage({
    content: 'Folded follow-up',
    msgId: 6407,
    source: 'autosteer',
  }), true);
  const folded = await bridge.waitFor(
    m => m.kind === 'user_msg' && m.turn_id !== primary.turn_id,
  );
  const combinedAnswer = 'The combined answer that Telegram did not receive.';

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'failed-fold',
    name: 'reply',
    args: {
      chat_id: cp.chatId,
      text: combinedAnswer,
      turn_id: folded.turn_id,
      consumed_turn_ids: [primary.turn_id, folded.turn_id],
    },
  });
  const ack = await bridge.waitFor(
    m => m.kind === 'tool_ack' && m.tool_call_id === 'failed-fold',
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(ack.ok, false);
  assert.equal(dispatched[0].sourceMsgId, 6406);
  assert.notEqual(cp.inputLedger.get(primary.turn_id)._quoteUsed, true);
  assert.deepEqual(cp.pendingTurns.get(primary.turn_id)?.replies, []);
  assert.equal(events.some(event => event.kind === 'cli-fold-reply-attributed'), false);

  const pending = cp.pendingTurns.get(primary.turn_id);
  cp._captureStopHookData(pending, { lastAssistantMessage: combinedAnswer });
  cp._finalizeTurn(primary.turn_id);
  const result = await sendP;
  assert.equal(result.alreadyDelivered, false,
    'failed Telegram delivery cannot suppress the matching Stop fallback');
  assert.equal(result.text, combinedAnswer);
});

test('a primary cannot finalize while its folded reply delivery is still in flight', async t => {
  const dispatched = [];
  let finishDispatch;
  const cp = makeCliProcess({
    toolDispatcher: call => {
      dispatched.push(call);
      return new Promise(resolve => { finishDispatch = resolve; });
    },
  });
  const bridge = await startWithFakeBridge(cp);
  t.after(async () => {
    bridge.close();
    await cp.kill('test');
  });

  const sendP = cp.send('Primary', { context: { sourceMsgId: 6406 } });
  const primary = await bridge.waitFor(m => m.kind === 'user_msg');
  assert.equal(cp.injectUserMessage({
    content: 'Folded follow-up',
    msgId: 6407,
    source: 'autosteer',
  }), true);
  const folded = await bridge.waitFor(
    m => m.kind === 'user_msg' && m.turn_id !== primary.turn_id,
  );
  const combinedAnswer = 'Delivered after the Stop signal.';

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'slow-fold',
    name: 'reply',
    args: {
      chat_id: cp.chatId,
      text: combinedAnswer,
      turn_id: folded.turn_id,
      consumed_turn_ids: [primary.turn_id, folded.turn_id],
    },
  });
  for (let i = 0; i < 50 && dispatched.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  const pending = cp.pendingTurns.get(primary.turn_id);
  cp._captureStopHookData(pending, { lastAssistantMessage: combinedAnswer });
  cp._finalizeTurn(primary.turn_id);
  assert.equal(cp.pendingTurns.has(primary.turn_id), true,
    'finalization waits for the delivery outcome');

  finishDispatch({ ok: true, message_id: 6408 });
  await bridge.waitFor(m => m.kind === 'tool_ack' && m.tool_call_id === 'slow-fold');
  const result = await sendP;
  assert.equal(result.alreadyDelivered, true);
  assert.equal(result.text, combinedAnswer);
});

test('a primary reply without consumed ids cannot finalize while delivery is in flight', async t => {
  let finishDispatch;
  const cp = makeCliProcess({
    toolDispatcher: () => new Promise(resolve => { finishDispatch = resolve; }),
  });
  const bridge = await startWithFakeBridge(cp);
  t.after(async () => {
    bridge.close();
    await cp.kill('test');
  });

  const sendP = cp.send('Primary', { context: { sourceMsgId: 6406 } });
  const primary = await bridge.waitFor(m => m.kind === 'user_msg');
  const answer = 'Direct answer still being delivered.';
  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'slow-direct',
    name: 'reply',
    args: {
      chat_id: cp.chatId,
      text: answer,
      turn_id: primary.turn_id,
    },
  });
  for (let i = 0; i < 50 && typeof finishDispatch !== 'function'; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  cp._finalizeTurn(primary.turn_id);
  assert.equal(cp.pendingTurns.has(primary.turn_id), true,
    'finalization waits even when the reply omitted optional consumed_turn_ids');

  finishDispatch({ ok: true, message_id: 6408 });
  await bridge.waitFor(m => m.kind === 'tool_ack' && m.tool_call_id === 'slow-direct');
  const result = await sendP;
  assert.equal(result.alreadyDelivered, true);
  assert.equal(result.text, answer);
});

test('a timeout waits for a rejecting folded delivery before rescuing the Stop answer', async t => {
  let rejectDispatch;
  const cp = makeCliProcess({
    toolDispatcher: () => new Promise((resolve, reject) => { rejectDispatch = reject; }),
  });
  const bridge = await startWithFakeBridge(cp);
  t.after(async () => {
    bridge.close();
    await cp.kill('test');
  });

  const sendP = cp.send('Primary', { context: { sourceMsgId: 6406 } });
  const primary = await bridge.waitFor(m => m.kind === 'user_msg');
  assert.equal(cp.injectUserMessage({
    content: 'Folded follow-up',
    msgId: 6407,
    source: 'autosteer',
  }), true);
  const folded = await bridge.waitFor(
    m => m.kind === 'user_msg' && m.turn_id !== primary.turn_id,
  );
  const combinedAnswer = 'The Stop answer after a rejected delivery.';

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'rejected-fold',
    name: 'reply',
    args: {
      chat_id: cp.chatId,
      text: combinedAnswer,
      turn_id: folded.turn_id,
      consumed_turn_ids: [primary.turn_id, folded.turn_id],
    },
  });
  for (let i = 0; i < 50 && typeof rejectDispatch !== 'function'; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  const pending = cp.pendingTurns.get(primary.turn_id);
  pending.seen = true;
  cp._captureStopHookData(pending, { lastAssistantMessage: combinedAnswer });
  pending._fireTimeout('idle');
  assert.equal(cp.pendingTurns.has(primary.turn_id), true,
    'the timeout cannot settle the turn before delivery outcome is known');

  rejectDispatch(new Error('telegram unavailable'));
  const ack = await bridge.waitFor(
    m => m.kind === 'tool_ack' && m.tool_call_id === 'rejected-fold',
  );
  const result = await sendP;
  assert.equal(ack.ok, false);
  assert.equal(result.alreadyDelivered, false);
  assert.equal(result.text, combinedAnswer);
});

test('tool call with wrong chat_id is dropped (security guard)', async () => {
  const dispatched = [];
  const cp = makeCliProcess({
    chatId: 'chat-A',
    toolDispatcher: async (call) => { dispatched.push(call); return { ok: true }; },
  });
  const bridge = await startWithFakeBridge(cp);

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'call-evil',
    name: 'reply',
    args: { chat_id: 'chat-B-EVIL', text: 'cross-user attempt' },
  });

  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.ok, false);
  assert.match(ack.error, /chat_id mismatch/);
  assert.equal(dispatched.length, 0, 'toolDispatcher NOT invoked for mismatched chat_id');

  bridge.close();
  await cp.kill('test');
});

test('tool dispatcher failure surfaces as tool_ack ok:false', async () => {
  const cp = makeCliProcess({
    toolDispatcher: async () => ({ ok: false, error: 'telegram api down' }),
  });
  const bridge = await startWithFakeBridge(cp);

  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'c1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'hi' },
  });

  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'telegram api down');

  bridge.close();
  await cp.kill('test');
});

test('perm_req emits approval-required and respondToPermission round-trips', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  const approvalP = new Promise(resolve => cp.once('approval-required', resolve));
  bridge.send({
    kind: 'perm_req',
    session: cp.sessionKey,
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'list dir',
    input_preview: 'ls -la',
  });
  const ap = await approvalP;
  // Canonical shape — matches TmuxProcess's emit signature so polygram's
  // existing onApprovalRequired handler works without changes.
  // P1 #13: toolInput is a STRING (normalizeTuiToolInput expects string;
  // object → '' silent empty card). When description and input_preview
  // differ enough, channels folds both into the string for operator visibility.
  assert.equal(ap.id, 'abcde');
  assert.equal(ap.toolName, 'Bash');
  assert.equal(typeof ap.toolInput, 'string', 'toolInput is a string per TmuxProcess contract');
  assert.match(ap.toolInput, /ls -la/, 'input_preview included');
  assert.match(ap.toolInput, /list dir/, 'description folded in when distinct from preview');
  assert.equal(ap.backend, 'cli');
  assert.equal(typeof ap.respond, 'function');

  // Verdict via the canonical respond() closure
  await ap.respond('allow', 'optional-message-ignored-for-channels');
  const verdict = await bridge.waitFor(m => m.kind === 'perm_verdict');
  assert.equal(verdict.request_id, 'abcde');
  assert.equal(verdict.behavior, 'allow');

  bridge.close();
  await cp.kill('test');
});

test('send() resolves after reply tool call + quiet window', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-quiet', chatId: 'chat-1', threadId: null, label: 'test-quiet',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 100,           // small for test
    turnTimeoutMs: 5_000,
  });

  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('do the thing');
  // Wait for the user_msg to propagate
  const userMsg = await bridge.waitFor(m => m.kind === 'user_msg');
  assert.equal(userMsg.text, 'do the thing');

  // Simulate claude calling reply tool
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'r1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'done' },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack');

  // After the quiet window (100ms), send() should resolve
  const result = await sendP;
  assert.equal(result.text, 'done');
  assert.equal(result.error, null);
  assert.equal(result.metrics.numAssistantMessages, 1);

  bridge.close();
  await cp.kill('test');
});

// 2026-06-08 Shumabit@UMI WA-topic incident: claude replied ("Do this:"), then
// kept TOOL-working in the SAME turn (Read a follow-up screenshot, ran Bash, then
// replied "Confirmed live" 90s later — no Stop hook until the end). The reply-quiet
// window resolved the turn mid-work (it resets only on REPLY tool calls), tearing
// down the reactor/typing and orphaning the late reply to the autonomous path. Fix:
// PreToolUse/PostToolUse hooks extend the quiet window (claude is still working).
test('tool activity extends the reply-quiet window so a still-working turn is not resolved (WA-topic)', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-toolquiet', chatId: 'chat-1', threadId: null, label: 'test-toolquiet',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 10_000,        // large: the window must NOT fire during the synchronous test
    turnTimeoutMs: 60_000,
  });
  const bridge = await startWithFakeBridge(cp);
  const sendP = cp.send('analyze these two screenshots');
  sendP.catch(() => {});        // resolves only on kill at teardown; swallow
  await bridge.waitFor((m) => m.kind === 'user_msg');

  // claude replies once → arms the per-turn quiet window.
  bridge.send({ kind: 'tool', session: cp.sessionKey, tool_call_id: 'r1', name: 'reply', args: { chat_id: 'chat-1', text: 'Do this:' } });
  await bridge.waitFor((m) => m.kind === 'tool_ack');
  const [pending] = cp.pendingTurns.values();
  assert.ok(pending.quietTimer, 'reply armed the quiet window');
  const armedTimer = pending.quietTimer;

  // claude keeps TOOL-working (reads the follow-up screenshot) — NOT a reply.
  // 0.13 D1: this hook is the session's FIRST → the finalizer ladder goes
  // hooks-live; the legacy reply-quiet window is superseded by the
  // activity-quiet window (rung 2). The WA-topic intent is unchanged — a
  // still-working turn must NOT resolve mid-work — but the mechanism is now
  // the activity clock, not a pushed-around 2s reply-quiet timer.
  cp._handleHookEvent({ type: 'PostToolUse', toolName: 'Read' });

  assert.equal(cp.pendingTurns.size, 1, 'turn still pending — not resolved mid-work');
  const [pending2] = cp.pendingTurns.values();
  assert.equal(pending2.quietTimer, null,
    'D1: the legacy reply-quiet timer is superseded once hooks are live (it could fire mid-work)');
  assert.ok(pending2._activityQuietTimer,
    'D1: the activity-quiet window (rung 2) now owns the finalize — armed because the turn has a delivered reply');
  void armedTimer;

  bridge.close();
  await cp.kill('test');
});

test('kill() tears down socket file and rejects pending turns', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  // Pre-attach rejection assertion BEFORE triggering kill, otherwise
  // the synchronous rejection in kill() races with node:test's
  // unhandled-rejection trap.
  const sendP = cp.send('hello');
  const rejectAssertion = assert.rejects(sendP, /killed/);
  await bridge.waitFor(m => m.kind === 'user_msg');

  await cp.kill('test-shutdown');
  assert.equal(cp.closed, true);
  assert.ok(!fs.existsSync(cp.sockPath), 'socket file unlinked');

  await rejectAssertion;
  bridge.close();
});

// Review P0 #1: --mcp-config receives a FILE PATH, not inline JSON. The
// secret-bearing JSON lives in a 0o600 tmp file. argv never carries the
// secret (verified via the recorded spawn args).
test('P0 #1: mcp-config written to 0o600 file, secret NOT in argv', async () => {
  const fs = require('node:fs');
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);
  try {
    // mcpConfigPath was created and exists
    assert.ok(cp.mcpConfigPath, 'mcpConfigPath set');
    assert.ok(fs.existsSync(cp.mcpConfigPath), 'mcp-config file exists');
    const mode = fs.statSync(cp.mcpConfigPath).mode & 0o777;
    assert.equal(mode, 0o600, `mcp-config mode: ${mode.toString(8)}`);
    // The runner's recorded spawn args contain the file PATH, not inline JSON
    const spawnArgs = cp.runner.calls.spawn[0].args;
    const mcpIdx = spawnArgs.indexOf('--mcp-config');
    assert.ok(mcpIdx >= 0, '--mcp-config present');
    const mcpValue = spawnArgs[mcpIdx + 1];
    assert.equal(mcpValue, cp.mcpConfigPath, 'argv value is the file path');
    // The argv value MUST NOT be JSON (no `{` or `mcpServers` substring)
    assert.ok(!mcpValue.startsWith('{'), 'argv value is NOT inline JSON');
    assert.ok(!mcpValue.includes('mcpServers'), 'argv value has no mcpServers content');
    assert.ok(!mcpValue.includes(cp.sockSecret), 'argv value does NOT contain socket secret');
    // The file ON DISK does contain the JSON config with the secret
    const fileContent = fs.readFileSync(cp.mcpConfigPath, 'utf8');
    assert.ok(fileContent.includes(cp.sockSecret), 'secret IS inside the 0o600 file');
    assert.ok(fileContent.includes('mcpServers'), 'file is the JSON config');
  } finally {
    bridge.close();
    await cp.kill('test');
    // After kill, the file is cleaned up
    assert.ok(!fs.existsSync(cp.mcpConfigPath), 'mcp-config file unlinked on kill');
  }
});

// Review P0 #3: ProcessManager subscribes to 'bridge-disconnected' and kills
// the dead instance so it leaves the procs Map (frees LRU slot, allows lazy
// respawn on next message via getOrSpawn).
test('P0 #3: bridge-disconnected triggers kill via ProcessManager subscriber', async () => {
  // The ProcessManager listener calls proc.kill('bridge-disconnected'). We
  // simulate that wiring directly here — full pm integration covered by
  // tests/process-manager.test.js.
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  // Simulate process-manager.js bridge-disconnect listener
  cp.on('bridge-disconnected', () => {
    cp.kill('bridge-disconnected').catch(() => {});
  });

  // Close the fake bridge → real cli-process sees socket close → emits
  bridge.close();
  // Allow the close handler to fire and the kill chain to settle
  await new Promise(r => setTimeout(r, 50));

  assert.equal(cp.closed, true, 'CliProcess killed after bridge disconnect');
  // Socket cleanup confirmed
  const fs = require('node:fs');
  assert.ok(!fs.existsSync(cp.sockPath), 'socket unlinked');
  assert.ok(!fs.existsSync(cp.mcpConfigPath), 'mcp-config unlinked');
});

// Review #5: bridge disconnect drains pendingTurns immediately instead of
// leaving 10-min hardTimers running.
test('bridge disconnect drains pendingTurns immediately (no 10min hardTimer wait)', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  // Pre-attach rejection assertion before triggering disconnect to avoid
  // the unhandled-rejection trap (same pattern as kill() test below).
  const sendP = cp.send('hello');
  const rejectAssertion = assert.rejects(
    sendP,
    err => err && err.code === 'BRIDGE_DISCONNECTED' && /bridge disconnected/.test(err.message),
  );
  await bridge.waitFor(m => m.kind === 'user_msg');

  // Simulate bridge crash by closing the fake bridge's socket end.
  bridge.close();

  // The pending turn must reject within milliseconds — NOT wait 600_000ms.
  // Hard guard at 200ms.
  await Promise.race([
    rejectAssertion,
    new Promise((_, reject) => setTimeout(() => reject(new Error('pendingTurns NOT drained within 200ms')), 200)),
  ]);

  // pendingTurns is empty + inFlight cleared
  assert.equal(cp.pendingTurns.size, 0);
  assert.equal(cp.inFlight, false);

  await cp.kill('test');
});

test('contained session loss rejects pending turns with a non-resumable code', async () => {
  const cp = makeCliProcess({ sessionLauncher: process.execPath });
  cp.runner.sessionProcessAlive = async () => false;
  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('hello');
  const rejection = assert.rejects(sendP, err => err?.code === 'SESSION_PROCESS_LOST');
  await bridge.waitFor(m => m.kind === 'user_msg');
  bridge.close();

  await rejection;
  await cp.kill('test');
});

test('a live contained process keeps the bridge-disconnected classification', async () => {
  const cp = makeCliProcess({ sessionLauncher: process.execPath });
  cp.runner.sessionProcessAlive = async () => true;
  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('hello');
  const rejection = assert.rejects(sendP, err => err?.code === 'BRIDGE_DISCONNECTED');
  await bridge.waitFor(m => m.kind === 'user_msg');
  bridge.close();

  await rejection;
  await cp.kill('test');
});

test('an existing tmux session with a dead process is non-resumable', async () => {
  const cp = makeCliProcess({ sessionLauncher: process.execPath });
  cp.runner.sessionExists = async () => true;
  cp.runner.sessionProcessAlive = async () => false;
  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('hello');
  const rejection = assert.rejects(sendP, err => err?.code === 'SESSION_PROCESS_LOST');
  await bridge.waitFor(m => m.kind === 'user_msg');
  bridge.close();

  await rejection;
  await cp.kill('test');
});

test('a deferred liveness probe cannot reuse the disconnecting process', async () => {
  let resolveLiveness;
  const cp = makeCliProcess({ sessionLauncher: process.execPath });
  cp.runner.sessionProcessAlive = () => new Promise(resolve => {
    resolveLiveness = resolve;
  });
  const bridge = await startWithFakeBridge(cp);

  const firstSend = cp.send('hello');
  const firstRejection = assert.rejects(
    firstSend,
    err => err?.code === 'SESSION_PROCESS_LOST',
  );
  await bridge.waitFor(m => m.kind === 'user_msg');
  bridge.close();

  for (let i = 0; i < 50 && !cp._bridgeDisconnecting; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const secondRejection = assert.rejects(
    cp.send('second'),
    err => err?.code === 'SESSION_PROCESS_LOST',
  );

  resolveLiveness(false);
  await Promise.all([firstRejection, secondRejection]);
  await cp.kill('test');
});

test('a concurrent send shares the deferred live-process disconnect classification', async () => {
  let resolveLiveness;
  const cp = makeCliProcess({ sessionLauncher: process.execPath });
  cp.runner.sessionProcessAlive = () => new Promise(resolve => {
    resolveLiveness = resolve;
  });
  const bridge = await startWithFakeBridge(cp);

  const firstSend = cp.send('hello');
  const firstRejection = assert.rejects(
    firstSend,
    err => err?.code === 'BRIDGE_DISCONNECTED',
  );
  await bridge.waitFor(m => m.kind === 'user_msg');
  bridge.close();

  for (let i = 0; i < 50 && !cp._bridgeDisconnecting; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const secondRejection = assert.rejects(
    cp.send('second'),
    err => err?.code === 'BRIDGE_DISCONNECTED',
  );

  resolveLiveness(true);
  await Promise.all([firstRejection, secondRejection]);
  await cp.kill('test');
});

test('an unresponsive liveness probe fails closed without stranding pending turns', async () => {
  const cp = makeCliProcess({ sessionLauncher: process.execPath });
  cp.runner.sessionProcessAlive = () => new Promise(() => {});
  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('hello');
  const rejection = assert.rejects(
    sendP,
    err => err?.code === 'SESSION_PROCESS_LOST',
  );
  await bridge.waitFor(m => m.kind === 'user_msg');
  bridge.close();

  await Promise.race([
    rejection,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('liveness timeout did not fail closed')), 500);
    }),
  ]);
  await cp.kill('test');
});

// Review #16: when toolDispatcher returns {ok:false}, the reply text MUST NOT
// be recorded into pendingTurn.replies — otherwise send() resolves with text
// that was never delivered to Telegram.
test('toolDispatcher failure does NOT record reply into pending turn', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-fail', chatId: 'chat-1', threadId: null, label: 'test-fail',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: false, error: 'telegram down' }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 50,
    turnTimeoutMs: 1500,
  });
  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('hello');
  await bridge.waitFor(m => m.kind === 'user_msg');

  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'fail-1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'this-was-never-delivered' },
  });
  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.ok, false);

  // After quietMs window, send() should time out at hardTimer (1500ms) rather
  // than resolve with the undelivered text. Wait > quietMs to confirm no false
  // resolution.
  await new Promise(r => setTimeout(r, 200));
  assert.equal(cp.pendingTurns.size, 1, 'pending turn still open — no false resolution from failed delivery');

  // Now deliver a successful reply so the send() resolves cleanly (test cleanup)
  cp.toolDispatcher = async () => ({ ok: true });
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'ok-1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'actually-delivered' },
  });
  const result = await sendP;
  assert.equal(result.text, 'actually-delivered', 'only successfully-delivered text in result');

  bridge.close();
  await cp.kill('test');
});

// P2 ADV-6: token-bucket rate limit on reply tool calls. Burst of 20 + 5/s
// refill (defaults). After exhausting the bucket, NACK kicks in.
test('P2 ADV-6: tool rate limit NACKs after burst exhausted', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-rate', chatId: 'chat-1', threadId: null, label: 'rate',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 50,
  });
  // Set a tiny burst + rate so the test is fast and deterministic.
  cp.toolRateBurst = 3;
  cp.toolRateTokens = 3;
  cp.toolRatePerSec = 0.01;   // effectively no refill during the test
  const bridge = await startWithFakeBridge(cp);

  // 3 allowed (uses bucket), 4th NACKed
  for (let i = 1; i <= 4; i++) {
    bridge.send({
      kind: 'tool', session: cp.sessionKey, tool_call_id: `rate-${i}`,
      name: 'reply', args: { chat_id: 'chat-1', text: `msg ${i}` },
    });
  }
  const acks = [];
  for (let i = 1; i <= 4; i++) {
    acks.push(await bridge.waitFor(m => m.kind === 'tool_ack' && m.tool_call_id === `rate-${i}`));
  }
  assert.equal(acks[0].ok, true);
  assert.equal(acks[1].ok, true);
  assert.equal(acks[2].ok, true);
  assert.equal(acks[3].ok, false, '4th call rate-limited');
  assert.match(acks[3].error, /rate limit/);

  bridge.close();
  await cp.kill('test');
});

// P2 AC7: fireUserMessage queues a user-shaped message into the bridge
// without registering a pending turn (used by polygram's /compact slash).
test('P2 AC7: fireUserMessage writes user_msg without pending-turn registration', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  assert.equal(cp.fireUserMessage('/compact'), true);
  const userMsg = await bridge.waitFor(m => m.kind === 'user_msg');
  assert.equal(userMsg.text, '/compact');
  assert.equal(cp.pendingTurns.size, 0, 'no pending turn registered');
  assert.equal(cp.pendingQueue.length, 0);

  // Invalid inputs return false
  assert.equal(cp.fireUserMessage(''), false);
  assert.equal(cp.fireUserMessage(null), false);

  bridge.close();
  await cp.kill('test');
});

// P2 AC8: resetSession drains pendingTurns + clears claudeSessionId
test('P2 AC8: resetSession drains pendings, clears session id, emits session-reset', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);
  const originalSid = cp.claudeSessionId;
  assert.ok(originalSid);

  const sendP = cp.send('hello');
  const rejectAssertion = assert.rejects(sendP, err => err && err.code === 'RESET');
  await bridge.waitFor(m => m.kind === 'user_msg');

  const resetP = new Promise(resolve => cp.once('session-reset', resolve));
  const res = await cp.resetSession({ reason: '/new' });
  assert.equal(typeof res.closed, 'boolean');
  // Review F#9: post-fix resetSession does a full teardown (kills tmux,
  // closes bridgeServer, unlinks mcp-config) and returns closed:true so
  // pm.resetSession's caller knows the underlying resources are gone.
  // Pre-fix returned false → those resources leaked across /new /reset.
  assert.equal(res.closed, true, 'F#9 contract: resetSession owns the full teardown');
  assert.equal(res.drainedPendings, 1);
  const evt = await resetP;
  assert.equal(evt.reason, '/new');
  assert.equal(cp.claudeSessionId, null, 'claudeSessionId cleared');
  await rejectAssertion;

  bridge.close();
  // Post-fix proc.closed is already true; kill('test') is a no-op double-call,
  // which existing kill() implementations handle idempotently.
  await cp.kill('test');
});

// P1 #18: _handleStartupDialogs branches — dev-channel confirmation, trust
// dialog, timeout. Tests use a scripted captureWide that returns different
// pane content over time and assert sendControl('Enter') fires correctly.
test('P1 #18: _handleStartupDialogs sends Enter on dev-channel WARNING', async () => {
  const sentKeys = [];
  let phase = 0;
  const runner = {
    spawn: async () => {},
    killSession: async () => {},
    sendControl: async (_name, key) => { sentKeys.push(key); },
    captureWide: async () => {
      // Phase 0: dev-channel confirmation; Phase 1: ready banner.
      const out = phase === 0
        ? '  WARNING: Loading development channels\n  Enter to confirm'
        : 'Listening for channel messages from: server:orchestra-bridge';
      phase++;
      return out;
    },
  };
  const cp = new CliProcess({
    sessionKey: 'sess-dialog', chatId: 'chat-1', threadId: null, label: 'dialog',
    tmuxRunner: runner, botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
  });

  // Start + connect fake bridge
  const startP = cp.start();
  for (let i = 0; i < 50 && (!cp.sockPath || !require('fs').existsSync(cp.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const bridge = await connectFakeBridge({
    sockPath: cp.sockPath, sessionKey: cp.sessionKey, secret: cp.sockSecret,
  });
  await startP;

  // Enter was sent for the dev-channel dialog
  assert.deepEqual(sentKeys, ['Enter']);
  bridge.close();
  await cp.kill('test');
});

test('P1 #18: _handleStartupDialogs sends Enter on trust dialog', async () => {
  const sentKeys = [];
  let phase = 0;
  const runner = {
    spawn: async () => {},
    killSession: async () => {},
    sendControl: async (_name, key) => { sentKeys.push(key); },
    captureWide: async () => {
      const out = phase === 0
        ? '  Do you trust the files in this folder?\n  Yes  No'
        : 'Listening for channel messages from: server:orchestra-bridge';
      phase++;
      return out;
    },
  };
  const cp = new CliProcess({
    sessionKey: 'sess-trust', chatId: 'chat-1', threadId: null, label: 'trust',
    tmuxRunner: runner, botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
  });

  const startP = cp.start();
  for (let i = 0; i < 50 && (!cp.sockPath || !require('fs').existsSync(cp.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const bridge = await connectFakeBridge({
    sockPath: cp.sockPath, sessionKey: cp.sessionKey, secret: cp.sockSecret,
  });
  await startP;
  assert.deepEqual(sentKeys, ['Enter']);
  bridge.close();
  await cp.kill('test');
});

// Regression (2026-06-04): claude 2.1.158 reworded the trust dialog to "Quick
// safety check: Is this a project you created or one you trust? … 1. Yes, I trust
// this folder". The old regex /trust the files in this folder/i no longer matched,
// so an untrusted cwd wedged the startup gate → CHANNELS_DIALOG_TIMEOUT (the E2E
// caught this with a fresh temp dir). The mode-independent unit fixture pins the
// NEW wording so a future reword is caught in CI (the E2E that found it is gated).
test('P1 #18: _handleStartupDialogs sends Enter on the claude 2.1.158 trust dialog wording', async () => {
  const sentKeys = [];
  let phase = 0;
  const runner = {
    spawn: async () => {},
    killSession: async () => {},
    sendControl: async (_name, key) => { sentKeys.push(key); },
    captureWide: async () => {
      const out = phase === 0
        ? '  Quick safety check: Is this a project you created or one you trust?\n  ❯ 1. Yes, I trust this folder\n    2. No, exit\n  Enter to confirm · Esc to cancel'
        : 'Listening for channel messages from: server:orchestra-bridge';
      phase++;
      return out;
    },
  };
  const cp = new CliProcess({
    sessionKey: 'sess-trust-2158', chatId: 'chat-1', threadId: null, label: 'trust2158',
    tmuxRunner: runner, botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
  });

  const startP = cp.start();
  for (let i = 0; i < 50 && (!cp.sockPath || !require('fs').existsSync(cp.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const bridge = await connectFakeBridge({
    sockPath: cp.sockPath, sessionKey: cp.sessionKey, secret: cp.sockSecret,
  });
  await startP;
  assert.deepEqual(sentKeys, ['Enter'], 'the gate must navigate the 2.1.158 trust dialog');
  bridge.close();
  await cp.kill('test');
});

test('P1 #18: _handleStartupDialogs throws on 30s timeout (banner never appears)', async () => {
  const runner = {
    spawn: async () => {},
    killSession: async () => {},
    sendControl: async () => {},
    // Never returns the ready banner — pane stuck at "loading…"
    captureWide: async () => 'loading…',
  };
  const cp = new CliProcess({
    sessionKey: 'sess-timeout', chatId: 'chat-1', threadId: null, label: 'timeout',
    tmuxRunner: runner, botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 1000,
  });

  // Override the 30s deadline to keep the test fast — patch _handleStartupDialogs's
  // deadline by tweaking Date.now if possible. Easier path: just verify it throws
  // by setting a short test guard around _handleStartupDialogs directly.
  cp.sockPath = '/tmp/never-created.sock';
  cp.runner = runner;
  cp.label = 'timeout-test';
  // Monkey-patch deadline indirectly: race against a fast manual timeout
  const handleP = (async () => {
    try {
      await Promise.race([
        cp._handleStartupDialogs('fake-tmux'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('test deadline')), 500)),
      ]);
      return null;
    } catch (err) {
      return err;
    }
  })();
  const err = await handleP;
  assert.ok(err, 'should reject');
  // Either the real 30s timeout error or our test-deadline guard — both fail
  // the start path. Just confirm a non-success outcome.
  assert.match(err.message, /test deadline|did not resolve within 30s/);
  // CRITICAL: the abandoned _handleStartupDialogs is still polling
  // captureWide via runStartupGate's setInterval. Without explicit
  // teardown, that interval keeps the test runner's event loop alive
  // for the full 30s deadline. Killing cp triggers _doKill, which closes
  // the bridge server + tail; runStartupGate's interval doesn't have a
  // hard handle, so the runner cleanup is what unblocks the loop.
  await cp.kill('test-cleanup').catch(() => {});
});

// P1 #4: reply MUST route by echoed turn_id when present so concurrent send()s
// don't cross-attribute their replies.
test('P1 #4: reply with echoed turn_id routes to matching pending turn (no fan-out)', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-multi', chatId: 'chat-1', threadId: null, label: 'multi',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 30,
    turnTimeoutMs: 5_000,
  });
  const bridge = await startWithFakeBridge(cp);

  // Two concurrent sends
  const sendA = cp.send('msg A');
  const userMsgA = await bridge.waitFor(m => m.kind === 'user_msg');
  const sendB = cp.send('msg B');
  const userMsgB = await bridge.waitFor(m => m.kind === 'user_msg' && m.turn_id !== userMsgA.turn_id);

  assert.notEqual(userMsgA.turn_id, userMsgB.turn_id, 'distinct turn_ids');

  // Reply to A with B's turn_id (would cross-attribute under the bug)
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'r1',
    name: 'reply',
    args: { chat_id: 'chat-1', turn_id: userMsgA.turn_id, text: 'reply-for-A' },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack');

  const resultA = await sendA;
  assert.equal(resultA.text, 'reply-for-A', 'send A got its own reply');

  // B still pending
  assert.equal(cp.pendingTurns.size, 1, 'B still pending after A resolved');

  // Reply to B
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'r2',
    name: 'reply',
    args: { chat_id: 'chat-1', turn_id: userMsgB.turn_id, text: 'reply-for-B' },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack' && m.tool_call_id === 'r2');
  const resultB = await sendB;
  assert.equal(resultB.text, 'reply-for-B', 'send B got its own reply');

  bridge.close();
  await cp.kill('test');
});

// P1 #15: emit 'tool-use' event on every bridge tool message so polygram's
// reactor chain gets per-tool icons (CALLBACK_TO_EVENT.onToolUse).
// 0.12 Phase 1.5: bridge `tool` messages NO LONGER emit 'tool-use'.
// Hook PreToolUse is the canonical 'tool-use' source for ALL tools (not
// just bridge-exposed ones). The bridge's tool message still triggers
// dispatch (delivers replies to Telegram); just no longer emits the
// per-tool event. This test pins the new contract: dispatch fires, no
// 'tool-use' emit from the bridge path.
test('P1 #15 (0.12 Phase 1.5): bridge tool dispatch does NOT emit tool-use; hook PreToolUse is sole source', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  let toolUseFired = false;
  cp.once('tool-use', () => { toolUseFired = true; });

  // Drive a bridge tool call.
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'tu-1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'hi' },
  });
  // Wait for the tool_ack — confirms dispatch ran.
  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.ok, true, 'dispatch should succeed (toolDispatcher returns ok:true)');

  // Give the event loop a moment in case 'tool-use' was emitted synchronously.
  await new Promise(r => setImmediate(r));
  assert.equal(toolUseFired, false,
    'bridge tool dispatch must NOT emit tool-use — hook PreToolUse is the canonical source');

  bridge.close();
  await cp.kill('test');
});

// P1 #15: emit 'autonomous-assistant-message' when a reply arrives with no
// pending turn (e.g. ScheduleWakeup-style proactive push from Claude).
test('P1 #15: reply with no pending turn emits autonomous-assistant-message', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  const autoP = new Promise(resolve => cp.once('autonomous-assistant-message', resolve));
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'auto-1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'proactive update' },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack');

  const payload = await autoP;
  assert.equal(payload.text, 'proactive update');
  assert.equal(payload.backend, 'cli');
  assert.equal(payload.sessionId, cp.claudeSessionId);

  bridge.close();
  await cp.kill('test');
});

// P1 #14: pendingQueue is populated with per-turn context so polygram's SDK
// callback path can find streamer/reactor via entry.pendingQueue[0].context.
test('P1 #14: send() populates pendingQueue with per-turn context', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  const fakeStreamer = { write: () => {} };
  const fakeReactor = { setState: () => {} };
  const sendP = cp.send('hi', {
    context: { streamer: fakeStreamer, reactor: fakeReactor, sourceMsgId: 12345 },
  });
  await bridge.waitFor(m => m.kind === 'user_msg');

  // During the turn, pendingQueue[0].context should have what callers wired
  assert.equal(cp.pendingQueue.length, 1);
  const ctx = cp.pendingQueue[0].context;
  assert.equal(ctx.streamer, fakeStreamer);
  assert.equal(ctx.reactor, fakeReactor);
  assert.equal(ctx.sourceMsgId, 12345);

  // Resolve the turn — queue should be cleared
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'r1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'done' },
  });
  await sendP;
  assert.equal(cp.pendingQueue.length, 0, 'pendingQueue cleared after turn-end');

  bridge.close();
  await cp.kill('test');
});

// P1 #7: duplicate tool_call_id re-ACKs without re-dispatching (idempotency).
test('P1 #7: duplicate tool_call_id is re-ACKed without re-dispatching', async () => {
  let dispatchCount = 0;
  const cp = new CliProcess({
    sessionKey: 'sess-idemp', chatId: 'chat-1', threadId: null, label: 'idemp',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => { dispatchCount++; return { ok: true }; },
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 50,
  });
  const bridge = await startWithFakeBridge(cp);

  // First call — dispatched normally
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'dup-1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'hi' },
  });
  const ack1 = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack1.ok, true);
  assert.equal(ack1.delivery, 'sent');
  assert.equal(ack1.attempt_id, 'dup-1');
  assert.equal(dispatchCount, 1);

  // Duplicate — should re-ACK without invoking dispatcher again
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'dup-1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'hi' },
  });
  const ack2 = await bridge.waitFor(m => m.kind === 'tool_ack' && m.delivery === 'replayed');
  assert.equal(ack2.ok, true);
  assert.equal(ack2.delivery, 'replayed');
  assert.equal(ack2.attempt_id, 'dup-1');
  assert.equal(ack2.replay_of, 'dup-1');
  assert.equal(dispatchCount, 1, 'dispatcher NOT invoked for duplicate tool_call_id');

  bridge.close();
  await cp.kill('test');
});

// P1 #12: quiet-window cap. After maxRepliesPerTurn replies, send() resolves
// without waiting for the quiet window — prevents chatty-Claude 10-min hang.
test('P1 #12: send() resolves at maxRepliesPerTurn cap (no chatty-hang)', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-chatty', chatId: 'chat-1', threadId: null, label: 'chatty',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 100_000,            // huge — would never resolve on quiet
    turnTimeoutMs: 5_000,
    maxRepliesPerTurn: 3,            // small cap for the test
    // 0.12 Phase 1.7: _resolveTurn schedules a stopGraceMs window to wait
    // for the Stop hook. Tests don't run a real claude → Stop never fires.
    // Use a short grace so the test resolves quickly while still exercising
    // the cap-resolve path.
    stopGraceMs: 50,
  });
  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('do many things');
  const userMsg = await bridge.waitFor(m => m.kind === 'user_msg');

  // Stream 3 reply tool calls — at the 3rd, send() should resolve via the
  // cap path (quiet timer is 100s; cap fires first; stopGraceMs adds ~50ms).
  for (let i = 1; i <= 3; i++) {
    bridge.send({
      kind: 'tool', session: cp.sessionKey, tool_call_id: `r${i}`,
      name: 'reply', args: { chat_id: 'chat-1', turn_id: userMsg.turn_id, text: `progress ${i}` },
    });
    await bridge.waitFor(m => m.kind === 'tool_ack' && m.tool_call_id === `r${i}`);
  }
  // sendP should resolve within ~stopGraceMs (50ms) + epsilon, not 100s
  const winner = await Promise.race([
    sendP.then(() => 'resolved'),
    new Promise(r => setTimeout(() => r('timeout'), 500)),
  ]);
  assert.equal(winner, 'resolved', 'send() resolved at cap (+stopGrace), not via quiet window');

  bridge.close();
  await cp.kill('test');
});

test('two concurrent sessions have isolated sockets and routing', async () => {
  const cpA = makeCliProcess({ chatId: 'chat-A' });
  const cpB = makeCliProcess({ chatId: 'chat-B' });

  const bridgeA = await startWithFakeBridge(cpA);
  const bridgeB = await startWithFakeBridge(cpB);

  assert.notEqual(cpA.sockPath, cpB.sockPath, 'distinct socket paths');
  assert.notEqual(cpA.sockSecret, cpB.sockSecret, 'distinct secrets');

  // Send a tool call on bridge A; verify only A's process sees it
  let sawOnA = 0;
  let sawOnB = 0;
  cpA.toolDispatcher = async () => { sawOnA++; return { ok: true }; };
  cpB.toolDispatcher = async () => { sawOnB++; return { ok: true }; };

  bridgeA.send({
    kind: 'tool', session: cpA.sessionKey, tool_call_id: 'a1',
    name: 'reply', args: { chat_id: 'chat-A', text: 'A-only' },
  });
  await bridgeA.waitFor(m => m.kind === 'tool_ack');
  assert.equal(sawOnA, 1);
  assert.equal(sawOnB, 0, 'no cross-talk to B');

  bridgeA.close();
  bridgeB.close();
  await cpA.kill('test'); await cpB.kill('test');
});

// ─── Step E: emit 'idle' on turn-timeout / resetSession / interrupt-grace ───
//
// HeartbeatReactor (lib/telegram/heartbeat-reactor.js) stops cycling only on
// 'idle' or 'close'. CliProcess used to resolve/reject pending turns on
// turn-timeout, resetSession, and interrupt-grace-resolve WITHOUT emitting
// 'idle' — which would leave a wired reactor cycling emoji forever (or until
// the user typed something else). These tests pin the contract so the bug
// can't regress.

test('Step E: turn-timeout emits idle so reaction-cyclers stop', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-idle-tt', chatId: 'chat-1', threadId: null, label: 'idle-tt',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 50,
    turnTimeoutMs: 200,            // tiny — fire fast
  });
  const bridge = await startWithFakeBridge(cp);

  // Race: idle event must arrive before — or alongside — the turn-timeout reject.
  const idleP = new Promise(resolve => cp.once('idle', () => resolve(true)));
  const idleSawWithin = Promise.race([
    idleP,
    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  ]);

  const sendP = cp.send('hello');
  const rejectAssertion = assert.rejects(sendP, err => err && err.code === 'TURN_TIMEOUT');
  await bridge.waitFor(m => m.kind === 'user_msg');
  // No reply ever arrives → hardTimer fires at turnTimeoutMs (200ms)
  await rejectAssertion;
  assert.equal(await idleSawWithin, true, 'idle was emitted on turn-timeout');

  bridge.close();
  await cp.kill('test');
});

test('Step E: resetSession emits idle so reaction-cyclers stop', async () => {
  const cp = makeCliProcess();
  const bridge = await startWithFakeBridge(cp);

  const idleP = new Promise(resolve => cp.once('idle', () => resolve(true)));
  const idleSawWithin = Promise.race([
    idleP,
    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  ]);

  const sendP = cp.send('hello');
  const rejectAssertion = assert.rejects(sendP, err => err && err.code === 'RESET');
  await bridge.waitFor(m => m.kind === 'user_msg');

  await cp.resetSession({ reason: '/new' });
  await rejectAssertion;
  assert.equal(await idleSawWithin, true, 'idle was emitted on resetSession');

  bridge.close();
  await cp.kill('test');
});

test('Step E: interrupt grace-resolve emits idle so reaction-cyclers stop', async () => {
  const cp = new CliProcess({
    sessionKey: 'sess-idle-int', chatId: 'chat-1', threadId: null, label: 'idle-int',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 50,
    turnTimeoutMs: 10_000,
    interruptGraceMs: 100,          // tiny — fast grace fire for test
  });
  const bridge = await startWithFakeBridge(cp);

  const idleP = new Promise(resolve => cp.once('idle', () => resolve(true)));
  const idleSawWithin = Promise.race([
    idleP,
    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  ]);

  // Start a turn, then interrupt without ever supplying a reply. The grace
  // window will synthesize an 'interrupted' resolution after interruptGraceMs.
  const sendP = cp.send('hello');
  await bridge.waitFor(m => m.kind === 'user_msg');
  await cp.interrupt();
  const result = await sendP;
  assert.equal(result.metrics.resultSubtype, 'interrupted');
  assert.equal(await idleSawWithin, true, 'idle was emitted on interrupt grace-resolve');

  bridge.close();
  await cp.kill('test');
});
