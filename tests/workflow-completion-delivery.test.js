'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliProcess } = require('../index');
const {
  correlateWorkflowCompletionSnapshot,
  hashDeliveryArguments,
} = require('../lib/process/workflow-completion-correlation');

const quietLogger = { warn() {}, error() {}, log() {}, debug() {} };

function makeCliProcess() {
  return new CliProcess({
    sessionKey: 'chat-1:37',
    chatId: '-1003369922517',
    threadId: '37',
    label: 'workflow-delivery-test',
    tmuxRunner: {
      spawn: async () => {},
      killSession: async () => {},
      sendControl: async () => {},
      captureWide: async () => '',
    },
    botName: 'testbot',
    claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
}

function writeTranscript(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-workflow-'));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { dir, transcriptPath };
}

function makeWorkflowRows({
  finalText = 'Final report.',
  workflowName = 'Workflow',
  notificationOverrides = {},
  notificationText,
  branch = [],
  fragmented = false,
} = {}) {
  const sessionId = 'session-1';
  const toolUseId = 'workflow-tool-1';
  const rows = [
    {
      type: 'user',
      uuid: 'root-user',
      parentUuid: null,
      sessionId,
      isSidechain: false,
      message: { role: 'user', content: 'Start research.' },
    },
    {
      type: 'assistant',
      uuid: 'workflow-launch',
      parentUuid: 'root-user',
      sessionId,
      requestId: 'launch-request',
      isSidechain: false,
      message: {
        id: 'launch-message',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: toolUseId, name: workflowName, input: {} }],
      },
    },
    {
      type: 'user',
      uuid: 'workflow-notification',
      parentUuid: 'workflow-launch',
      sessionId,
      isSidechain: false,
      promptSource: 'system',
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: notificationText
          ?? `<task-notification><tool-use-id>${toolUseId}</tool-use-id></task-notification>`,
      },
      ...notificationOverrides,
    },
  ];
  let parentUuid = 'workflow-notification';
  for (let index = 0; index < branch.length; index++) {
    const row = {
      ...branch[index],
      uuid: `branch-${index}`,
      parentUuid,
      sessionId,
      isSidechain: false,
    };
    rows.push(row);
    parentUuid = row.uuid;
  }
  if (fragmented) {
    rows.push({
      type: 'assistant',
      uuid: 'final-thinking',
      parentUuid,
      sessionId,
      requestId: 'final-request',
      isSidechain: false,
      message: {
        id: 'final-message',
        stop_reason: null,
        content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Final' }],
      },
    });
    parentUuid = 'final-thinking';
    rows.push({
      type: 'assistant',
      uuid: 'final-text',
      parentUuid,
      sessionId,
      requestId: 'final-request',
      isSidechain: false,
      message: {
        id: 'final-message',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'report.' }],
      },
    });
  } else {
    rows.push({
      type: 'assistant',
      uuid: 'workflow-final',
      parentUuid,
      sessionId,
      requestId: 'final-request',
      isSidechain: false,
      message: {
        id: 'final-message',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: finalText }],
      },
    });
  }
  return { rows, sessionId, finalText: fragmented ? 'Final\n\nreport.' : finalText };
}

function makeTimeoutWorkflowRows({
  attemptId = 'slow-attempt',
  input = { chat_id: 'chat-1', text: 'Final report.' },
} = {}) {
  return makeWorkflowRows({
    finalText: input.text,
    branch: [
      {
        type: 'assistant',
        requestId: 'reply-request',
        message: {
          id: 'reply-message',
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'reply-tool',
            name: 'mcp__orchestra-bridge__reply',
            input,
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'reply-tool',
            is_error: true,
            content: JSON.stringify({
              ok: false,
              timeout: true,
              attempt_id: attemptId,
            }),
          }],
        },
      },
    ],
  });
}

async function correlateFixture(t, fixture, { partial = false } = {}) {
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (partial) fs.appendFileSync(transcriptPath, '{"partial":');
  return correlateWorkflowCompletionSnapshot({
    transcriptPath,
    byteSize: fs.statSync(transcriptPath).size,
    sessionId: fixture.sessionId,
    finalText: fixture.finalText,
  });
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('completed background Workflow with no pending turn delivers its final out of turn', async (t) => {
  const finalText = 'The cited research report is ready.';
  const sessionId = 'session-1';
  const workflowToolUseId = 'workflow-tool-1';
  const { dir, transcriptPath } = writeTranscript([
    {
      type: 'user',
      uuid: 'launch-user',
      parentUuid: '',
      sessionId,
      isSidechain: false,
      message: { role: 'user', content: 'Start the background research.' },
    },
    {
      type: 'assistant',
      uuid: 'launch-assistant',
      parentUuid: 'launch-user',
      sessionId,
      requestId: 'launch-request',
      isSidechain: false,
      message: {
        id: 'launch-message',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: workflowToolUseId, name: 'Workflow', input: {} }],
      },
    },
    {
      type: 'user',
      uuid: 'workflow-notification',
      parentUuid: 'launch-assistant',
      sessionId,
      isSidechain: false,
      promptSource: 'system',
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: `<task-notification><tool-use-id>${workflowToolUseId}</tool-use-id></task-notification>`,
      },
    },
    {
      type: 'assistant',
      uuid: 'workflow-final',
      parentUuid: 'workflow-notification',
      sessionId,
      requestId: 'final-request',
      isSidechain: false,
      message: {
        id: 'final-message',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: finalText }],
      },
    },
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cp = makeCliProcess();
  cp.claudeSessionId = sessionId;

  const delivered = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('autonomous Workflow final was not emitted')), 100);
    cp.once('autonomous-assistant-message', event => {
      clearTimeout(timer);
      resolve(event);
    });
  });

  cp._handleHookEvent({
    type: 'Stop',
    sessionId,
    transcriptPath,
    stopHookActive: false,
    lastAssistantMessage: finalText,
  });

  assert.deepEqual(await delivered, {
    text: finalText,
    sessionId,
    backend: 'cli',
    alreadyDelivered: false,
  });
});

test('Workflow qualification requires native provenance and the Workflow tool type', async (t) => {
  const wrongOrigin = await correlateFixture(t, makeWorkflowRows({
    notificationOverrides: { origin: { kind: 'user' } },
  }));
  assert.equal(wrongOrigin.eligible, false);
  assert.equal(wrongOrigin.reason, 'notification-provenance-invalid');

  const agent = await correlateFixture(t, makeWorkflowRows({ workflowName: 'Agent' }));
  assert.equal(agent.eligible, false);
  assert.equal(agent.reason, 'workflow-tool-match-invalid');

  const spoof = await correlateFixture(t, makeWorkflowRows({
    notificationOverrides: { promptSource: 'user', origin: undefined },
  }));
  assert.equal(spoof.eligible, false);
  assert.equal(spoof.reason, 'notification-provenance-invalid');
});

test('linear assistant fragments coalesce and partial JSONL fails closed', async (t) => {
  const fragmented = await correlateFixture(t, makeWorkflowRows({ fragmented: true }));
  assert.equal(fragmented.eligible, true);
  assert.equal(fragmented.deliveredFinal, false);

  const partial = await correlateFixture(t, makeWorkflowRows(), { partial: true });
  assert.equal(partial.eligible, false);
  assert.equal(partial.reason, 'partial-line');
});

test('ambiguous, forked, stale, and non-mainline transcript shapes fail closed', async (t) => {
  const cases = [
    ['broken parent', (fixture) => {
      fixture.rows.at(-1).parentUuid = 'missing-parent';
    }],
    ['forked ancestry', (fixture) => {
      fixture.rows.splice(-1, 0, {
        type: 'assistant',
        uuid: 'fork-sibling',
        parentUuid: 'workflow-notification',
        sessionId: fixture.sessionId,
        requestId: 'fork-request',
        isSidechain: false,
        message: {
          id: 'fork-message',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Sibling branch.' }],
        },
      });
    }],
    ['duplicate uuid', (fixture) => {
      fixture.rows.splice(-1, 0, {
        ...structuredClone(fixture.rows[1]),
        parentUuid: 'root-user',
      });
    }],
    ['sidechain terminal', (fixture) => {
      fixture.rows.at(-1).isSidechain = true;
    }],
    ['conflicting terminal session', (fixture) => {
      fixture.rows.at(-1).sessionId = 'other-session';
    }],
    ['terminal tool use', (fixture) => {
      fixture.rows.at(-1).message.content.push({
        type: 'tool_use',
        id: 'unexpected-tool',
        name: 'Read',
        input: {},
      });
    }],
    ['stale Workflow id', (fixture) => {
      fixture.rows[2].message.content =
        '<task-notification><tool-use-id>stale-id</tool-use-id></task-notification>';
    }],
    ['multiple Workflow matches', (fixture) => {
      fixture.rows[1].message.content.push(structuredClone(fixture.rows[1].message.content[0]));
    }],
    ['queue-operation echo', (fixture) => {
      fixture.rows[2].origin = { kind: 'queue-operation' };
    }],
    ['ordinary user-authored XML', (fixture) => {
      fixture.rows[2].origin = undefined;
      fixture.rows[2].promptSource = 'user';
    }],
    ['interleaved terminal fragments', (fixture) => {
      fixture.rows.splice(-1, 0, {
        type: 'assistant',
        uuid: 'interleaved-assistant',
        parentUuid: 'final-thinking',
        sessionId: fixture.sessionId,
        requestId: 'other-request',
        isSidechain: false,
        message: {
          id: 'other-message',
          stop_reason: null,
          content: [{ type: 'text', text: 'Interleaved.' }],
        },
      });
      fixture.rows.at(-1).parentUuid = 'interleaved-assistant';
    }],
    ['final mismatch', (fixture) => {
      fixture.finalText = 'A different final.';
    }],
  ];

  for (const [name, mutate] of cases) {
    const fixture = makeWorkflowRows({
      fragmented: name === 'interleaved terminal fragments',
    });
    mutate(fixture);
    const correlation = await correlateFixture(t, fixture);
    assert.equal(correlation.eligible, false, name);
  }
});

test('same-branch direct reply suppresses while an explicit failure remains eligible', async (t) => {
  const replyInput = { chat_id: 'chat-1', text: 'Delivered report.' };
  const direct = await correlateFixture(t, makeWorkflowRows({
    branch: [
      {
        type: 'assistant',
        requestId: 'reply-request',
        message: {
          id: 'reply-message',
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'reply-tool',
            name: 'mcp__orchestra-bridge__reply',
            input: replyInput,
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'reply-tool',
            content: JSON.stringify({
              ok: true,
              delivery: 'sent',
              attempt_id: 'attempt-1',
            }),
          }],
        },
      },
    ],
  }));
  assert.equal(direct.eligible, true);
  assert.equal(direct.deliveredFinal, true);

  const failed = await correlateFixture(t, makeWorkflowRows({
    branch: [
      {
        type: 'assistant',
        requestId: 'reply-request',
        message: {
          id: 'reply-message',
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'reply-tool',
            name: 'mcp__orchestra-bridge__reply',
            input: replyInput,
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'reply-tool',
            is_error: true,
            content: JSON.stringify({
              ok: false,
              error: 'transport failed',
              attempt_id: 'attempt-1',
            }),
          }],
        },
      },
    ],
  }));
  assert.equal(failed.eligible, true);
  assert.equal(failed.deliveredFinal, false);
});

test('only a causally linked same-branch replay proves delivery', async (t) => {
  const input = { chat_id: 'chat-1', text: 'Delivered report.' };
  const linked = await correlateFixture(t, makeWorkflowRows({
    branch: [
      {
        type: 'assistant',
        requestId: 'reply-1-request',
        message: {
          id: 'reply-1-message',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'reply-1', name: 'mcp__orchestra-bridge__reply', input }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'reply-1',
            is_error: true,
            content: JSON.stringify({
              ok: false,
              timeout: true,
              attempt_id: 'attempt-1',
            }),
          }],
        },
      },
      {
        type: 'assistant',
        requestId: 'reply-2-request',
        message: {
          id: 'reply-2-message',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'reply-2', name: 'mcp__orchestra-bridge__reply', input }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'reply-2',
            content: JSON.stringify({
              ok: true,
              delivery: 'replayed',
              attempt_id: 'attempt-2',
              replay_of: 'attempt-1',
            }),
          }],
        },
      },
    ],
  }));
  assert.equal(linked.eligible, true);
  assert.equal(linked.deliveredFinal, true);
  assert.deepEqual(linked.unresolvedAttempts, []);

  const unlinked = await correlateFixture(t, makeWorkflowRows({
    branch: [
      {
        type: 'assistant',
        requestId: 'reply-request',
        message: {
          id: 'reply-message',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'reply-2', name: 'mcp__orchestra-bridge__reply', input }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'reply-2',
            content: JSON.stringify({
              ok: true,
              delivery: 'replayed',
              attempt_id: 'attempt-2',
              replay_of: 'prior-branch-attempt',
            }),
          }],
        },
      },
    ],
  }));
  assert.equal(unlinked.eligible, true);
  assert.equal(unlinked.deliveredFinal, false);
});

test('interim replies and progressive edits expose only normalized equality hashes', async (t) => {
  const finalText = 'Final report.';
  const fixture = makeWorkflowRows({
    finalText,
    branch: [
      {
        type: 'assistant',
        requestId: 'edit-request',
        message: {
          id: 'edit-message',
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'edit-tool',
            name: 'mcp__orchestra-bridge__edit_message',
            input: { chat_id: 'chat-1', message_id: 4, text: ` \r\n${finalText}\r\n ` },
          }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'edit-tool',
            content: JSON.stringify({
              ok: true,
              delivery: 'sent',
              attempt_id: 'edit-attempt',
            }),
          }],
        },
      },
    ],
  });
  const correlation = await correlateFixture(t, fixture);
  assert.equal(correlation.eligible, true);
  assert.equal(correlation.deliveredFinal, false);
  assert.ok(correlation.visibleHashes.includes(correlation.finalHash));
  assert.equal(JSON.stringify(correlation).includes(finalText), false);
});

test('a pending consumer turn and stop-hook continuation never become autonomous', async (t) => {
  const fixture = makeWorkflowRows();
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cp = makeCliProcess();
  cp.claudeSessionId = fixture.sessionId;
  cp.pendingTurns.set('pending-turn', {
    seen: false,
    replies: [],
    reject() {},
  });
  let emitted = false;
  cp.on('autonomous-assistant-message', () => { emitted = true; });

  cp._handleHookEvent({
    type: 'Stop',
    sessionId: fixture.sessionId,
    transcriptPath,
    stopHookActive: false,
    lastAssistantMessage: fixture.finalText,
  });
  cp.pendingTurns.clear();
  cp._handleHookEvent({
    type: 'Stop',
    sessionId: fixture.sessionId,
    transcriptPath,
    stopHookActive: true,
    lastAssistantMessage: fixture.finalText,
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(emitted, false);
});

test('a synchronous stop-hook finalizer cannot reclassify its pending turn as autonomous', async (t) => {
  const fixture = makeWorkflowRows();
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cp = makeCliProcess();
  cp.claudeSessionId = fixture.sessionId;
  cp.pendingTurns.set('pending-turn', {
    seen: true,
    replies: [],
    reject() {},
  });
  cp.once('stop-hook', () => cp.pendingTurns.clear());
  let emitted = false;
  cp.on('autonomous-assistant-message', () => { emitted = true; });

  cp._handleHookEvent({
    type: 'Stop',
    sessionId: fixture.sessionId,
    transcriptPath,
    stopHookActive: false,
    lastAssistantMessage: fixture.finalText,
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(emitted, false);
});

test('a timed-out same-branch attempt waits for its exact live outcome', async (t) => {
  const input = { chat_id: 'chat-1', text: 'Final report.' };
  const fixture = makeTimeoutWorkflowRows({ input });
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cp = makeCliProcess();
  cp.claudeSessionId = fixture.sessionId;
  const attempt = cp._registerDeliveryAttempt(
    'slow-attempt',
    hashDeliveryArguments('reply', input),
  );
  const delivered = new Promise(resolve => cp.once('autonomous-assistant-message', resolve));

  cp._handleHookEvent({
    type: 'Stop',
    sessionId: fixture.sessionId,
    transcriptPath,
    stopHookActive: false,
    lastAssistantMessage: fixture.finalText,
  });
  await waitFor(() => cp.hasPendingDeliveryWork());
  cp._settleDeliveryAttempt(attempt, 'failed');
  assert.equal((await delivered).alreadyDelivered, false);
  await waitFor(() => !cp.hasPendingDeliveryWork());
});

test('a timed-out same-branch success suppresses, while missing restart state fails closed', async (t) => {
  const input = { chat_id: 'chat-1', text: 'Final report.' };
  const fixture = makeTimeoutWorkflowRows({ input });

  {
    const { dir, transcriptPath } = writeTranscript(fixture.rows);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cp = makeCliProcess();
    cp.claudeSessionId = fixture.sessionId;
    const attempt = cp._registerDeliveryAttempt(
      'slow-attempt',
      hashDeliveryArguments('reply', input),
    );
    let emitted = false;
    cp.on('autonomous-assistant-message', () => { emitted = true; });

    cp._handleHookEvent({
      type: 'Stop',
      sessionId: fixture.sessionId,
      transcriptPath,
      stopHookActive: false,
      lastAssistantMessage: fixture.finalText,
    });
    await waitFor(() => cp._activeWorkflowDecisions.size === 1);
    cp._settleDeliveryAttempt(attempt, 'sent');
    await waitFor(() => !cp.hasPendingDeliveryWork());
    assert.equal(emitted, false);
  }

  {
    const { dir, transcriptPath } = writeTranscript(fixture.rows);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cp = makeCliProcess();
    cp.claudeSessionId = fixture.sessionId;
    let emitted = false;
    cp.on('autonomous-assistant-message', () => { emitted = true; });
    const settled = new Promise(resolve => cp.once('delivery-work-settled', resolve));

    cp._handleHookEvent({
      type: 'Stop',
      sessionId: fixture.sessionId,
      transcriptPath,
      stopHookActive: false,
      lastAssistantMessage: fixture.finalText,
    });
    await settled;
    assert.equal(emitted, false);
    assert.equal(cp.hasPendingDeliveryWork(), false);
  }
});

test('a timeout cannot read an attempt with different immutable arguments', async (t) => {
  const fixture = makeTimeoutWorkflowRows();
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cp = makeCliProcess();
  cp.claudeSessionId = fixture.sessionId;
  const attempt = cp._registerDeliveryAttempt(
    'slow-attempt',
    hashDeliveryArguments('reply', {
      chat_id: 'chat-1',
      text: 'Different text.',
    }),
  );
  cp._settleDeliveryAttempt(attempt, 'sent');
  let emitted = false;
  cp.on('autonomous-assistant-message', () => { emitted = true; });
  const settled = new Promise(resolve => cp.once('delivery-work-settled', resolve));

  cp._handleHookEvent({
    type: 'Stop',
    sessionId: fixture.sessionId,
    transcriptPath,
    stopHookActive: false,
    lastAssistantMessage: fixture.finalText,
  });
  await settled;
  assert.equal(emitted, false);
});

test('teardown invalidates a deferred decision and late dispatcher settlement is inert', async (t) => {
  const input = { chat_id: 'chat-1', text: 'Final report.' };
  const fixture = makeTimeoutWorkflowRows({ input });
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cp = makeCliProcess();
  cp.claudeSessionId = fixture.sessionId;
  const attempt = cp._registerDeliveryAttempt(
    'slow-attempt',
    hashDeliveryArguments('reply', input),
  );
  let emitted = false;
  cp.on('autonomous-assistant-message', () => { emitted = true; });

  cp._handleHookEvent({
    type: 'Stop',
    sessionId: fixture.sessionId,
    transcriptPath,
    stopHookActive: false,
    lastAssistantMessage: fixture.finalText,
  });
  await waitFor(() => cp.hasPendingDeliveryWork());
  cp._invalidatePendingDeliveryWork();
  cp._settleDeliveryAttempt(attempt, 'sent');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(emitted, false);
  assert.equal(cp.hasPendingDeliveryWork(), false);
  assert.equal(cp._deliveryAttempts.size, 0);
});

test('the recent delivery ledger is bounded and stores no plaintext arguments', () => {
  const cp = makeCliProcess();
  const sentinel = 'private report text must not enter the ledger';
  for (let index = 0; index < 300; index++) {
    const entry = cp._registerDeliveryAttempt(
      `attempt-${index}`,
      hashDeliveryArguments('reply', {
        chat_id: cp.chatId,
        text: `${sentinel}-${index}`,
      }),
    );
    cp._settleDeliveryAttempt(entry, 'failed');
  }
  assert.ok(cp._deliveryAttempts.size <= 256);
  assert.ok(cp._deliveryAttemptOrder.length <= 256);
  assert.equal(JSON.stringify([...cp._deliveryAttempts.values()]).includes(sentinel), false);
});

test('completed and in-flight content retries carry causal replay receipts', async () => {
  const args = {
    chat_id: '-1003369922517',
    text: 'The cited report is ready.',
  };

  {
    const cp = makeCliProcess();
    const acknowledgements = [];
    let dispatchCount = 0;
    cp.toolDispatcher = async () => {
      dispatchCount++;
      return { ok: true, message_id: 41 };
    };
    cp._writeToBridge = message => {
      acknowledgements.push(message);
      return true;
    };

    await cp._dispatchToolCall({
      tool_call_id: 'direct-attempt',
      name: 'reply',
      args,
    });
    await cp._dispatchToolCall({
      tool_call_id: 'completed-retry',
      name: 'reply',
      args,
    });

    assert.equal(dispatchCount, 1);
    assert.equal(acknowledgements[0].delivery, 'sent');
    assert.equal(acknowledgements[1].delivery, 'replayed');
    assert.equal(acknowledgements[1].replay_of, 'direct-attempt');
  }

  {
    const cp = makeCliProcess();
    const acknowledgements = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let dispatchCount = 0;
    cp.toolDispatcher = async () => {
      dispatchCount++;
      return gate;
    };
    cp._writeToBridge = message => {
      acknowledgements.push(message);
      return true;
    };

    const direct = cp._dispatchToolCall({
      tool_call_id: 'inflight-source',
      name: 'reply',
      args,
    });
    await waitFor(() => cp._inFlightDispatches.size === 1);
    const retry = cp._dispatchToolCall({
      tool_call_id: 'inflight-retry',
      name: 'reply',
      args,
    });
    release({ ok: true, message_id: 42 });
    await Promise.all([direct, retry]);

    assert.equal(dispatchCount, 1);
    const replay = acknowledgements.find(message => message.tool_call_id === 'inflight-retry');
    assert.equal(replay.delivery, 'replayed');
    assert.equal(replay.replay_of, 'inflight-source');
  }
});

test('a validated delivery dispatch pins lifecycle until its direct receipt settles', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cp = makeCliProcess();
  cp.toolDispatcher = async () => gate;
  const acknowledgements = [];
  cp._writeToBridge = message => {
    acknowledgements.push(message);
    return true;
  };

  const dispatch = cp._dispatchToolCall({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'dispatch-attempt',
    name: 'edit_message',
    args: {
      chat_id: cp.chatId,
      message_id: 42,
      text: 'Updated report.',
    },
  });
  await waitFor(() => cp.hasPendingDeliveryWork());
  release({ ok: true, message_id: 42 });
  await dispatch;

  assert.equal(cp.hasPendingDeliveryWork(), false);
  assert.equal(acknowledgements.at(-1).attempt_id, 'dispatch-attempt');
  assert.equal(acknowledgements.at(-1).delivery, 'sent');
});
