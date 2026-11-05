'use strict';

/**
 * A Claude CLI turn whose model request fails (after the CLI's own retries)
 * must end promptly with a typed error instead of staying pending until the
 * turn ceiling.
 *
 * Production shape (VPS shumabit, claude 2.1.283 behind CLIProxy with every
 * Claude credential expired): the prompt is picked up (UserPromptSubmit), the
 * CLI retries for ~3 minutes, then writes a synthetic assistant entry
 * (`isApiErrorMessage: true`, `error: "server_error"`) and fires the
 * StopFailure hook — never Stop. Before this fix StopFailure was not
 * registered, nothing observed the failure, later messages were autosteered
 * into the dead turn, and the user heard nothing until the 30-minute
 * checkpoint gave up.
 *
 * Every payload below is fed through the real hook parser
 * (normalizeHookEvent) with the field names the pinned CLI writes, verified
 * against a real claude 2.1.283 run pointed at a local HTTP-500 stub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess, hookSettings, hookEventTail, CALLBACK_TO_EVENT } = require('../index');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GATEWAY_ERROR_TEXT = 'API Error: 500 upstream unavailable. This is a server-side issue, '
  + 'usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:8318).';

function makeProc(opts = {}) {
  const events = [];
  const written = [];
  const proc = new CliProcess({
    sessionKey: 'sess-api-err',
    chatId: '12345',
    tmuxRunner: {
      sendControl: async () => {},
      killSession: async () => {},
      captureWide: async () => '',
    },
    botName: 'testbot',
    claudeBin: '/usr/bin/false',
    toolDispatcher: opts.toolDispatcher || (async () => ({ ok: true, message_id: 1 })),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    stopGraceMs: 40,
    turnQuietMs: 30,
    activityQuietMs: 120,
    turnTimeoutMs: 60_000,
    turnAbsoluteMs: 60_000,
    interruptGraceMs: opts.interruptGraceMs ?? 5_000,
    ...(opts.dropConfirmMs != null && { dropConfirmMs: opts.dropConfirmMs }),
  });
  proc.bridgeReady = true;
  proc.bridgeServer = { writeMessage: (obj) => { written.push(obj); } };
  proc.tmuxSession = 'orchestra-testbot-channels-apierr';
  return { proc, events, written };
}

function startTurn(proc, written, msgId = 1) {
  const before = written.length;
  const sendP = proc.send('do the thing', { context: { sourceMsgId: msgId } });
  const settled = sendP.then(
    (result) => ({ outcome: 'resolved', result }),
    (err) => ({ outcome: 'rejected', err }),
  );
  const userMsg = written.slice(before).find((w) => w.kind === 'user_msg');
  assert.ok(userMsg, 'send() wrote a user_msg');
  return { settled, turnId: userMsg.turn_id };
}

// Raw hook payloads as claude 2.1.283 writes them to the ndjson.
function hook(raw) {
  return hookEventTail.normalizeHookEvent({
    session_id: 'claude-sid',
    transcript_path: '/tmp/claude-sid.jsonl',
    cwd: '/tmp',
    permission_mode: 'bypassPermissions',
    polygram_received_at_ms: Date.now(),
    ...raw,
  });
}

function upsRaw(turnIds, promptId, msgId = '1') {
  const prompt = [].concat(turnIds).map((id) => (
    `<channel source="orchestra-bridge" chat_id="12345" user="u" msg_id="${msgId}" turn_id="${id}">hello</channel>`
  )).join('\n');
  return { hook_event_name: 'UserPromptSubmit', prompt, prompt_id: promptId };
}

function stopFailureRaw(promptId, error = 'server_error', extra = {}) {
  return {
    hook_event_name: 'StopFailure',
    prompt_id: promptId,
    error,
    last_assistant_message: GATEWAY_ERROR_TEXT,
    ...extra,
  };
}

async function within(settled, ms) {
  return Promise.race([settled, sleep(ms).then(() => ({ outcome: 'still-pending' }))]);
}

test('a turn whose model request ends in a synthetic isApiErrorMessage server_error is not left silent until the ceiling', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);

  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));

  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected',
    'the failed turn must end now — pre-fix it stayed pending until the 30-minute checkpoint');
  assert.equal(s.err.code, 'CLAUDE_API_ERROR');
  assert.equal(s.err.apiError, 'server_error', 'the CLI error class reaches the consumer');
  assert.doesNotMatch(s.err.message, /127\.0\.0\.1|gateway|upstream/,
    'the rendered provider/gateway text must not ride along in the error message');
  assert.equal(proc.pendingTurns.size, 0, 'the turn is no longer counted as in flight');
  assert.equal(proc.inFlight, false, 'a follow-up must start a fresh turn, not autosteer into the dead one');
  await proc.kill('test');
});

test('the per-session hook settings register StopFailure so the CLI fires it', () => {
  const settings = hookSettings.buildHookSettings({ ndjsonPath: '/tmp/x.ndjson', helperPath: '/tmp/h.js' });
  assert.deepEqual(settings.hooks.StopFailure, settings.hooks.Stop,
    'without a registered StopFailure hook the CLI never reports an API-error turn end');
  assert.equal(hookEventTail.normalizeHookEvent({ hook_event_name: 'StopFailure' }).type, 'StopFailure');
});


test('a follow-up folded into the failing turn shares its prompt_id — the turn still fails', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._handleHookEvent(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu1', prompt_id: 'prompt-1' }));
  proc._handleHookEvent(hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu1', prompt_id: 'prompt-1' }));
  assert.equal(proc.injectUserMessage({ content: 'and also this', msgId: 2, source: 'autosteer' }), true);
  const folded = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
  proc._handleHookEvent(hook(upsRaw(folded, 'prompt-1', '2')));   // the fold's repeat UPS
  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));

  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected');
  assert.equal(s.err.code, 'CLAUDE_API_ERROR');
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));   // a duplicated line
  assert.equal(apiErrors.length, 0,
    'the folded follow-up was part of the failed turn — its one error reply covers it, no second notice');
  await proc.kill('test');
});

test('a failure of a different query leaves a pending turn alone (exact prompt_id attribution)', async () => {
  const { proc, events, written } = makeProc();
  const { settled } = startTurn(proc, written);
  // claude is busy with its own wakeup cycle; our message is queued behind it.
  proc._handleHookEvent(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'scheduled wakeup', prompt_id: 'wake-1' }));
  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));
  proc._handleHookEvent(hook(stopFailureRaw('wake-1')));

  const s = await within(settled, 120);
  assert.equal(s.outcome, 'still-pending', 'the queued user turn never ran — its own query decides it');
  assert.equal(proc.pendingTurns.size, 1);
  assert.equal(apiErrors.length, 1, 'the failed wakeup is reported to the consumer');
  assert.equal(apiErrors[0].anchorMsgId, null, 'no user message was waiting on the wakeup');
  assert.ok(events.some((e) => e.kind === 'cli-stop-failure-unattributed'));
  await proc.kill('test');
});

test('overnight shape: a follow-up autosteered into the dead turn runs as its own cycle and its failure names that message once', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1', '1')));
  // While the CLI retries, the user sends a follow-up; polygram autosteers it.
  assert.equal(proc.injectUserMessage({ content: 'hello?', msgId: 2, source: 'autosteer' }), true);
  const followUp = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));
  // None of these may carry last_assistant_message (the rendered gateway
  // error) toward the chat — with nothing pending, the workflow-completion and
  // autonomous paths would post it as the bot's answer.
  const leaks = [];
  for (const name of ['stop-hook', 'hook-event', 'autonomous-assistant-message']) {
    proc.on(name, () => leaks.push(name));
  }

  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected', 'the first message is answered with the error first');
  assert.equal(proc.inFlight, false);

  // claude now runs the queued follow-up as a new query, which fails too.
  proc._handleHookEvent(hook(upsRaw(followUp, 'prompt-2', '2')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));   // a duplicated line
  assert.equal(apiErrors.length, 1, 'one failed cycle, one notice');
  assert.equal(apiErrors[0].anchorMsgId, '2', 'the notice names the follow-up the user is waiting on');
  assert.equal(apiErrors[0].apiError, 'server_error');
  assert.deepEqual(leaks, [], 'the provider error text never takes the Stop or wakeup delivery paths');
  await proc.kill('test');
});

test('a follow-up cycle that already answered its message does not later claim it went unanswered', async () => {
  for (const viaConsumedIds of [false, true]) {
    const { proc, written } = makeProc();
    const first = startTurn(proc, written, 1);
    proc._handleHookEvent(hook(upsRaw(first.turnId, 'prompt-1', '1')));
    assert.equal(proc.injectUserMessage({ content: 'hello?', msgId: 2, source: 'autosteer' }), true);
    const followUp = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
    proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
    assert.equal((await within(first.settled, 200)).outcome, 'rejected');

    const apiErrors = [];
    proc.on('api-error', (p) => apiErrors.push(p));
    proc._handleHookEvent(hook(upsRaw(followUp, 'prompt-2', '2')));
    // The API recovers briefly: the follow-up is answered, then a closing
    // request of the same cycle fails.
    proc._recordReplyForPendingTurn('looking…', followUp, true);   // interim: still waiting
    if (viaConsumedIds) proc._recordConsumedReplyDelivery([followUp], 'here is your answer', false);
    else proc._recordReplyForPendingTurn('here is your answer', followUp);
    proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));

    assert.equal(apiErrors.length, 1, 'the consumer still learns the cycle ended (visuals stop)');
    assert.equal(apiErrors[0].anchorMsgId, null,
      `the follow-up already has its answer — no "couldn't finish" under it (${viaConsumedIds ? 'consumed ids' : 'bound reply'})`);
    await proc.kill('test');
  }
});

test('a /stop grace does not swallow the failure of a turn started after the C-c', async () => {
  const { proc, written } = makeProc({ interruptGraceMs: 5_000 });
  const first = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(first.turnId, 'prompt-1', '1')));
  await proc.interrupt();
  proc._recordReplyForPendingTurn('stopped', first.turnId);
  proc._finalizeTurn(first.turnId);                      // claude acked the stop inside the grace
  assert.equal((await within(first.settled, 100)).outcome, 'resolved');

  const next = startTurn(proc, written, 2);              // the user's redirect
  proc._handleHookEvent(hook(upsRaw(next.turnId, 'prompt-2', '2')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2', 'invalid_request')));   // fails fast, no retries
  const s = await within(next.settled, 200);
  assert.equal(s.outcome, 'rejected', 'the new turn is not the interrupt’s; it must not wait for the ceiling');
  assert.equal(s.err.code, 'CLAUDE_API_ERROR');
  await proc.kill('test');
});

test('a late StopFailure for a turn that already timed out sends nothing more', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1', '1')));
  proc.pendingTurns.get(turnId)._fireTimeout('idle');
  const s = await within(settled, 100);
  assert.equal(s.err?.code, 'TURN_TIMEOUT');

  // The user's next message is already running fine in a new query.
  const next = startTurn(proc, written, 2);
  proc._handleHookEvent(hook(upsRaw(next.turnId, 'prompt-2', '2')));

  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  assert.equal(apiErrors.length, 0,
    'the user already got the timeout reply for that message — a second, contradictory one must not follow');
  assert.equal((await within(next.settled, 100)).outcome, 'still-pending',
    'a lagged failure of the OLD query must not fail the turn that is running fine (exact prompt_id, not "the seen pending")');
  await proc.kill('test');
});

test('hook lines out of order (the follow-up\'s UPS before the failed turn\'s StopFailure) still settle both correctly', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1', '1')));
  assert.equal(proc.injectUserMessage({ content: 'hello?', msgId: 2, source: 'autosteer' }), true);
  const followUp = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));

  proc._handleHookEvent(hook(upsRaw(followUp, 'prompt-2', '2')));   // written first
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  assert.equal((await within(settled, 200)).outcome, 'rejected', 'the first turn still fails on its own query');
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));
  assert.equal(apiErrors.length, 1);
  assert.equal(apiErrors[0].anchorMsgId, '2', 'the follow-up is still answered');
  await proc.kill('test');
});

test('a turn that already delivered its final answer resolves as answered, not as an error', async () => {
  const { proc, events, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._recordReplyForPendingTurn('here is your answer', turnId);
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));   // a closing request failed afterwards
  assert.equal(proc.pendingTurns.size, 0, 'the StopFailure itself settles the turn (no waiting on a quiet window)');
  assert.ok(events.some((e) => e.kind === 'cli-turn-api-error' && e.detail.delivered === true));

  const s = await within(settled, 200);
  assert.equal(s.outcome, 'resolved', 'the user has the answer — no "couldn’t finish" after it');
  assert.equal(s.result.alreadyDelivered, true);
  assert.doesNotMatch(s.result.text, /API Error|gateway/, 'the provider error text is never the answer');
  await proc.kill('test');
});

test('a turn with only an interim status reply still fails — its promise was never kept', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._recordReplyForPendingTurn('looking into it…', turnId, true);
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));

  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected');
  assert.equal(s.err.code, 'CLAUDE_API_ERROR');
  await proc.kill('test');
});

test('a sub-agent that fails releases its start (no SubagentStop comes) and never fails the parent turn', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  const done = [];
  proc.on('subagent-done', (p) => done.push(p));
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._handleHookEvent(hook({
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu-agent', prompt_id: 'prompt-1',
    tool_input: { subagent_type: 'general-purpose', prompt: 'x' },
  }));
  assert.equal(proc._pendingSubagentStarts.length, 1);
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1', 'server_error', {
    agent_id: 'af509a425654d6a9b', agent_type: 'general-purpose',
  })));
  assert.equal(proc.pendingTurns.size, 1, 'a sub-agent failure is not the parent turn ending');
  assert.equal(proc._pendingSubagentStarts.length, 0, 'the failed sub-agent no longer counts as in flight');
  assert.equal(done.length, 1);
  assert.equal(done[0].toolUseId, 'tu-agent');

  // The parent recovers and finishes; its Stop must not be deferred forever.
  proc._recordReplyForPendingTurn('done despite the sub-agent', turnId);
  proc._handleHookEvent(hook({ hook_event_name: 'Stop', prompt_id: 'prompt-1', last_assistant_message: 'done' }));
  const s = await within(settled, 400);
  assert.equal(s.outcome, 'resolved', 'the parent finalizes on its Stop');
  await proc.kill('test');
});

test('an org that disabled subscription access rejects with AUTH_DISABLED (operator-only handling kept)', async () => {
  const { proc, events, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1', 'oauth_org_not_allowed')));
  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected');
  assert.equal(s.err.code, 'AUTH_DISABLED',
    'same error as the pane detector, so the consumer notifies the operator and tells the chat nothing');
  assert.ok(events.some((e) => e.kind === 'cli-auth-disabled-detected' && e.detail.source === 'stop-failure'));
  await proc.kill('test');
});

test('a reply still being delivered defers the decision; the API error outranks a finalize queued meanwhile', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  const tracked = proc._beginReplyDeliveries([turnId]);   // e.g. a large upload past the bridge ack timeout
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  assert.equal(proc.pendingTurns.size, 1, 'no decision while the delivery is unsettled');
  proc._finalizeTurn(turnId);                              // something queues a finalize meanwhile
  proc._recordReplyForPendingTurn('looking into it…', turnId, true);   // the delivery was an interim status
  proc._finishReplyDeliveries(tracked);

  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected', 'the queued finalize must not turn the failed query into a silent success');
  assert.equal(s.err.code, 'CLAUDE_API_ERROR');
  await proc.kill('test');
});

test('a reply still being delivered that turns out to be the final answer resolves the turn as answered', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  const tracked = proc._beginReplyDeliveries([turnId]);
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  proc._recordReplyForPendingTurn('here is the answer', turnId);   // the in-flight delivery was the answer
  proc._finishReplyDeliveries(tracked);

  const s = await within(settled, 200);
  assert.equal(s.outcome, 'resolved', 'the user got the answer — no error after it');
  assert.equal(s.result.alreadyDelivered, true);
  await proc.kill('test');
});

test('a ceiling that fires while the reply is in flight does not replace the API error with "went quiet"', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  const tracked = proc._beginReplyDeliveries([turnId]);
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  proc.pendingTurns.get(turnId)._fireTimeout('idle');                 // deferred behind the delivery
  proc._finishReplyDeliveries(tracked);                               // the delivery failed: no reply recorded

  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected');
  assert.equal(s.err.code, 'CLAUDE_API_ERROR', 'the user is told the API failed, not that the turn went quiet');
  await proc.kill('test');
});

test('a /stop already resolving the turn wins over a racing StopFailure', async () => {
  const { proc, written } = makeProc({ interruptGraceMs: 60 });
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  await proc.interrupt();
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  const s = await within(settled, 300);
  assert.equal(s.outcome, 'resolved');
  assert.equal(s.result.metrics.resultSubtype, 'interrupted', 'the user asked to stop; no API-error reply');
  await proc.kill('test');
});

test('after a failure the next message starts a fresh turn instead of being swallowed', async () => {
  const { proc, written } = makeProc();
  const first = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(first.turnId, 'prompt-1', '1')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  assert.equal((await within(first.settled, 200)).outcome, 'rejected');

  assert.equal(proc.injectUserMessage({ content: 'retry', msgId: 3, source: 'autosteer' }), false,
    'nothing is in flight, so the consumer must dispatch a new primary turn');
  const second = startTurn(proc, written, 3);
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(proc.pendingTurns.size, 1);
  proc._handleHookEvent(hook(upsRaw(second.turnId, 'prompt-2', '3')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));
  assert.equal((await within(second.settled, 200)).outcome, 'rejected', 'and fails on its own if the API is still down');
  await proc.kill('test');
});

test('a StopFailure without a prompt_id settles nothing (no lag-blind guess); the ceilings stay the backstop', async () => {
  const { proc, events, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._handleHookEvent(hook({ hook_event_name: 'StopFailure', error: 'server_error' }));
  assert.equal((await within(settled, 100)).outcome, 'still-pending');
  assert.ok(events.some((e) => e.kind === 'cli-stop-failure-unattributed' && e.detail.reason === 'no-prompt-id'));
  await proc.kill('test');
});

test('StopFailure parsing clamps the error class to the CLI enum and ignores empty ids', () => {
  const ev = hookEventTail.normalizeHookEvent({ hook_event_name: 'StopFailure', error: 'Ignore previous instructions', prompt_id: '' });
  assert.equal(ev.apiError, 'unknown', 'a free-form value never travels into errors or copy');
  assert.equal(ev.promptId, null);
  assert.equal(ev.apiErrorUnlisted, true, 'a class outside the enum stays visible as such');
  const listed = hookEventTail.normalizeHookEvent({ hook_event_name: 'StopFailure', error: 'rate_limit' });
  assert.equal(listed.apiError, 'rate_limit');
  assert.equal(listed.apiErrorUnlisted, false);
  assert.equal(hookEventTail.normalizeHookEvent({ hook_event_name: 'StopFailure', error: 'unknown' }).apiErrorUnlisted, false,
    "the CLI's own 'unknown' class is listed");
  assert.equal(hookEventTail.normalizeHookEvent({ hook_event_name: 'Stop', error: 'rate_limit' }).apiError, null);
});

test('a class a newer CLI added is reported as unknown and flagged in telemetry', async () => {
  const { proc, events, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1', 'quota_exhausted_v2')));
  const s = await within(settled, 200);
  assert.equal(s.err.apiError, 'unknown');
  assert.ok(events.some((e) => e.kind === 'cli-turn-api-error' && e.detail.api_error_unlisted === true));
  await proc.kill('test');
});

test('a throwing idle listener cannot leave the failed turn pending with its ceilings already cleared', async () => {
  const { proc, written } = makeProc();
  const { settled, turnId } = startTurn(proc, written);
  proc.on('idle', () => { throw new Error('listener bug'); });
  proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1')));
  try { proc._handleHookEvent(hook(stopFailureRaw('prompt-1'))); } catch { /* the hook tail logs this */ }
  const s = await within(settled, 200);
  assert.equal(s.outcome, 'rejected', 'the user still gets the error reply');
  proc.removeAllListeners('idle');
  await proc.kill('test');
});

test("the next prompt's UserPromptSubmit written before this cycle's StopFailure does not steal its notice", async () => {
  const { proc, written } = makeProc();
  const first = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(first.turnId, 'prompt-1', '1')));
  assert.equal(proc.injectUserMessage({ content: 'two', msgId: 2, source: 'autosteer' }), true);
  const f2 = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
  assert.equal(proc.injectUserMessage({ content: 'three', msgId: 3, source: 'autosteer' }), true);
  const f3 = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  assert.equal((await within(first.settled, 200)).outcome, 'rejected');

  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));
  proc._handleHookEvent(hook(upsRaw(f2, 'prompt-2', '2')));
  proc._handleHookEvent(hook(upsRaw(f3, 'prompt-3', '3')));   // written before prompt-2's StopFailure
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-3')));
  assert.deepEqual(apiErrors.map((p) => p.anchorMsgId), ['2', '3'], 'each follow-up gets its own notice');
  await proc.kill('test');
});

// The overnight shape up to the follow-up's own cycle: turn-1 fails, and the
// follow-up autosteered into it runs afterwards as its own query 'prompt-2'.
async function followUpRunsAsOwnCycle(proc, written) {
  const first = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(first.turnId, 'prompt-1', '1')));
  assert.equal(proc.injectUserMessage({ content: 'hello?', msgId: 2, source: 'autosteer' }), true);
  const followUp = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
  proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
  assert.equal((await within(first.settled, 200)).outcome, 'rejected');
  proc._handleHookEvent(hook(upsRaw(followUp, 'prompt-2', '2')));
  return followUp;
}

test('a turn folded into the follow-up\'s cycle owns that cycle: once it is answered, a late failure sends no notice', async () => {
  const { proc, written } = makeProc();
  await followUpRunsAsOwnCycle(proc, written);
  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));

  // The user writes again; claude folds the new turn into the running cycle.
  const next = startTurn(proc, written, 3);
  proc._handleHookEvent(hook(upsRaw(next.turnId, 'prompt-2', '3')));
  proc._recordReplyForPendingTurn('here is your answer', next.turnId);
  proc._finalizeTurn(next.turnId);
  assert.equal((await within(next.settled, 200)).outcome, 'resolved');

  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));   // a closing request of that cycle fails
  assert.equal(apiErrors.length, 0,
    'the cycle was settled through the folded turn, which answered the user; an error under the follow-up would contradict that answer');
  await proc.kill('test');
});

test('a cycle that already ended with Stop sends no API-error notice for a later StopFailure under the same prompt', async () => {
  const { proc, written } = makeProc();
  await followUpRunsAsOwnCycle(proc, written);
  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));

  proc._handleHookEvent(hook({ hook_event_name: 'Stop', prompt_id: 'prompt-2', last_assistant_message: 'here you go' }));
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));
  assert.equal(apiErrors.length, 0, 'the cycle ended normally; its follow-up is not reported as failed');
  await proc.kill('test');
});

test('a follow-up claude never picks up after the turn rejects is still checked for a drop, not left unaccounted', async () => {
  for (const ending of ['api-error', 'timeout']) {
    const { proc, written } = makeProc({ dropConfirmMs: 30 });
    const { settled, turnId } = startTurn(proc, written, 1);
    proc._handleHookEvent(hook(upsRaw(turnId, 'prompt-1', '1')));
    assert.equal(proc.injectUserMessage({ content: 'hello?', msgId: 2, source: 'autosteer' }), true);
    // claude follows the consumed_turn_ids contract this session, so an input
    // it never acknowledged or picked up counts as dropped, not folded.
    proc._lastAckFieldAt = Date.now();
    const dropped = [];
    proc.on('input-dropped', (p) => dropped.push(p));

    if (ending === 'api-error') proc._handleHookEvent(hook(stopFailureRaw('prompt-1')));
    else proc.pendingTurns.get(turnId)._fireTimeout('idle');
    assert.equal((await within(settled, 100)).outcome, 'rejected', ending);

    await sleep(120);   // the confirm window passes with no pickup
    assert.equal(dropped.length, 1, `${ending}: the follow-up is handed back for one redelivery instead of being lost`);
    assert.equal(dropped[0].msgId, '2');
    await proc.kill('test');
  }
});

test('a follow-up the user cancelled with /stop is not answered when claude still runs it and that fails', async () => {
  const { proc, written } = makeProc({ interruptGraceMs: 30 });
  const first = startTurn(proc, written, 1);
  proc._handleHookEvent(hook(upsRaw(first.turnId, 'prompt-1', '1')));
  assert.equal(proc.injectUserMessage({ content: 'hello?', msgId: 2, source: 'autosteer' }), true);
  const followUp = written.filter((w) => w.kind === 'user_msg').pop().turn_id;
  await proc.interrupt();                                   // cancels the turn and its follow-up
  assert.equal((await within(first.settled, 200)).outcome, 'resolved');
  const apiErrors = [];
  proc.on('api-error', (p) => apiErrors.push(p));

  proc._handleHookEvent(hook(upsRaw(followUp, 'prompt-2', '2')));   // claude runs the queued input anyway
  proc._handleHookEvent(hook(stopFailureRaw('prompt-2')));
  assert.equal(apiErrors.length, 1, 'the consumer still learns the cycle ended (visuals stop)');
  assert.equal(apiErrors[0].anchorMsgId, null, 'the user cancelled that message; no "couldn\'t finish" under it');
  await proc.kill('test');
});

test('ProcessManager forwards a failed own-cycle to the consumer as onApiError', () => {
  assert.equal(CALLBACK_TO_EVENT.onApiError, 'api-error');
});
