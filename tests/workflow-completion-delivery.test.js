'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliProcess } = require('../index');
const {
  MAX_WORKFLOW_TRANSCRIPT_BYTES,
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

function makeFailedWorkflowRows() {
  return makeWorkflowRows({
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
            input: { chat_id: 'chat-1', text: 'Final report.' },
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
              attempt_id: 'failed-attempt',
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

function makeLaggedWorkflowHarness(t) {
  const fixture = makeFailedWorkflowRows();
  const terminal = fixture.rows.pop();
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cp = makeCliProcess();
  cp.claudeSessionId = fixture.sessionId;
  const emitted = [];
  cp.on('autonomous-assistant-message', event => { emitted.push(event); });
  const stop = () => cp._handleHookEvent({
    type: 'Stop',
    sessionId: fixture.sessionId,
    transcriptPath,
    stopHookActive: false,
    lastAssistantMessage: fixture.finalText,
  });
  return { fixture, terminal, transcriptPath, cp, emitted, stop };
}

function onceWithTimeout(emitter, eventName, message, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    emitter.once(eventName, value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
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

test('production Workflow notification remains correlated across Stop system rows', async (t) => {
  const fixture = makeWorkflowRows();
  fixture.rows[2].parentUuid = 'turn-duration';
  fixture.rows.splice(2, 0,
    {
      type: 'system',
      subtype: 'stop_hook_summary',
      uuid: 'stop-hook-summary',
      parentUuid: 'workflow-launch',
      sessionId: fixture.sessionId,
      isSidechain: false,
    },
    {
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'turn-duration',
      parentUuid: 'stop-hook-summary',
      sessionId: fixture.sessionId,
      isSidechain: false,
    });

  const correlation = await correlateFixture(t, fixture);
  assert.equal(correlation.eligible, true);
  assert.equal(correlation.reason, 'eligible');
});

test('an accepted Workflow boundary digest detects a same-size rewrite', async (t) => {
  const fixture = makeWorkflowRows();
  const { dir, transcriptPath } = writeTranscript(fixture.rows);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const byteSize = fs.statSync(transcriptPath).size;
  const first = await correlateWorkflowCompletionSnapshot({
    transcriptPath,
    byteSize,
    sessionId: fixture.sessionId,
    finalText: fixture.finalText,
  });
  assert.equal(first.eligible, true);

  const transcript = fs.readFileSync(transcriptPath, 'utf8');
  const offset = transcript.lastIndexOf(fixture.finalText);
  assert.notEqual(offset, -1);
  const fd = fs.openSync(transcriptPath, 'r+');
  try {
    fs.writeSync(fd, 'X', offset, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const changed = await correlateWorkflowCompletionSnapshot({
    transcriptPath,
    byteSize,
    sessionId: fixture.sessionId,
    finalText: fixture.finalText,
    prefixByteSize: byteSize,
    prefixHash: first.snapshotHash,
  });

  assert.equal(changed.eligible, false);
  assert.equal(changed.reason, 'snapshot-prefix-changed');
});

test('Workflow fallback fails closed before reading an oversized transcript', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-workflow-large-'));
  const transcriptPath = path.join(dir, 'session.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const byteSize = MAX_WORKFLOW_TRANSCRIPT_BYTES + 1;
  fs.writeFileSync(transcriptPath, '');
  fs.truncateSync(transcriptPath, byteSize);

  const cp = makeCliProcess();
  assert.equal(cp._captureWorkflowCompletionSnapshot({
    transcriptPath,
    sessionId: 'session-1',
    lastAssistantMessage: 'Final report.',
  }), null);

  const correlation = await correlateWorkflowCompletionSnapshot({
    transcriptPath,
    byteSize,
    sessionId: 'session-1',
    finalText: 'Final report.',
  });
  assert.equal(correlation.eligible, false);
  assert.equal(correlation.reason, 'snapshot-too-large');
});

test('Stop-time transcript lag does not lose a failed Workflow reply fallback', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const delivered = onceWithTimeout(
    h.cp,
    'autonomous-assistant-message',
    'lagged Workflow terminal was not delivered',
  );
  h.stop();
  setTimeout(() => {
    fs.appendFileSync(h.transcriptPath, `${JSON.stringify(h.terminal)}\n`);
  }, 20);

  assert.deepEqual(await delivered, {
    text: h.fixture.finalText,
    sessionId: h.fixture.sessionId,
    backend: 'cli',
    alreadyDelivered: false,
  });
});

test('Stop-time settlement tolerates a split terminal append', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const terminalLine = `${JSON.stringify(h.terminal)}\n`;
  const splitAt = Math.floor(terminalLine.length / 2);
  const delivered = onceWithTimeout(
    h.cp,
    'autonomous-assistant-message',
    'split Workflow terminal was not delivered',
  );
  h.stop();
  setTimeout(() => fs.appendFileSync(h.transcriptPath, terminalLine.slice(0, splitAt)), 20);
  setTimeout(() => fs.appendFileSync(h.transcriptPath, terminalLine.slice(splitAt)), 50);

  assert.equal((await delivered).text, h.fixture.finalText);
});

test('Stop-time settlement rejects rewritten transcript prefixes', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const settled = onceWithTimeout(
    h.cp,
    'delivery-work-settled',
    'rewritten transcript decision did not settle',
  );
  h.stop();
  setTimeout(() => {
    const transcript = fs.readFileSync(h.transcriptPath, 'utf8');
    const offset = transcript.indexOf('Start research.');
    assert.notEqual(offset, -1);
    const fd = fs.openSync(h.transcriptPath, 'r+');
    try {
      fs.writeSync(fd, 'z', offset + 'Start researc'.length, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.appendFileSync(h.transcriptPath, `${JSON.stringify(h.terminal)}\n`);
  }, 20);

  await settled;
  assert.equal(h.emitted.length, 0);
});

test('Stop-time settlement rejects replaced and shrunken transcripts', async (t) => {
  for (const mutation of ['replace', 'shrink']) {
    await t.test(mutation, async (t) => {
      const h = makeLaggedWorkflowHarness(t);
      const settled = onceWithTimeout(
        h.cp,
        'delivery-work-settled',
        `${mutation} transcript decision did not settle`,
      );
      h.stop();
      setTimeout(() => {
        if (mutation === 'replace') {
          const original = fs.readFileSync(h.transcriptPath);
          fs.renameSync(h.transcriptPath, `${h.transcriptPath}.replaced`);
          fs.writeFileSync(
            h.transcriptPath,
            Buffer.concat([original, Buffer.from(`${JSON.stringify(h.terminal)}\n`)]),
          );
        } else {
          fs.truncateSync(
            h.transcriptPath,
            fs.statSync(h.transcriptPath).size - 1,
          );
        }
      }, 20);

      await settled;
      assert.equal(h.emitted.length, 0);
    });
  }
});

test('Stop-time settlement rejects replacement before its first transcript read', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const settled = onceWithTimeout(
    h.cp,
    'delivery-work-settled',
    'early-replacement transcript decision did not settle',
  );

  h.stop();
  const targetSize = fs.statSync(h.transcriptPath).size;
  const replacementRows = makeWorkflowRows({
    finalText: h.fixture.finalText,
  }).rows;
  let replacement = `${replacementRows.map(row => JSON.stringify(row)).join('\n')}\n`;
  assert.ok(Buffer.byteLength(replacement) < targetSize);
  replacement += `${' '.repeat(targetSize - Buffer.byteLength(replacement) - 1)}\n`;
  fs.renameSync(h.transcriptPath, `${h.transcriptPath}.replaced`);
  fs.writeFileSync(h.transcriptPath, replacement);

  await settled;
  assert.equal(h.emitted.length, 0);
});

test('Stop-time settlement rejects an in-place rewrite before its first transcript read', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const settled = onceWithTimeout(
    h.cp,
    'delivery-work-settled',
    'early-rewrite transcript decision did not settle',
  );

  h.stop();
  const transcript = fs.readFileSync(h.transcriptPath, 'utf8');
  const offset = transcript.indexOf('Start research.');
  assert.notEqual(offset, -1);
  const fd = fs.openSync(h.transcriptPath, 'r+');
  try {
    fs.writeSync(fd, 'z', offset + 'Start researc'.length, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  fs.appendFileSync(h.transcriptPath, `${JSON.stringify(h.terminal)}\n`);

  await settled;
  assert.equal(h.emitted.length, 0);
});

test('Stop-time settlement rejects a complete malformed append', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const settled = onceWithTimeout(
    h.cp,
    'delivery-work-settled',
    'malformed transcript decision did not settle',
  );
  h.stop();
  setTimeout(() => fs.appendFileSync(h.transcriptPath, '{"type":broken}\n'), 20);

  await settled;
  assert.equal(h.emitted.length, 0);
});

test('Stop-time settlement rejects a later user before the candidate terminal', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const laterUser = {
    type: 'user',
    uuid: 'later-user',
    parentUuid: h.fixture.rows.at(-1).uuid,
    sessionId: h.fixture.sessionId,
    isSidechain: false,
    promptSource: 'channel',
    origin: { kind: 'channel' },
    message: { role: 'user', content: 'A later user turn.' },
  };
  h.terminal.parentUuid = laterUser.uuid;
  const settled = onceWithTimeout(
    h.cp,
    'delivery-work-settled',
    'later-user transcript decision did not settle',
  );
  h.stop();
  setTimeout(() => {
    fs.appendFileSync(
      h.transcriptPath,
      `${JSON.stringify(laterUser)}\n${JSON.stringify(h.terminal)}\n`,
    );
  }, 20);

  await settled;
  assert.equal(h.emitted.length, 0);
});

test('Stop-time settlement permanently withdraws after intervening consumer work', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const settled = onceWithTimeout(
    h.cp,
    'delivery-work-settled',
    'intervening-work decision did not settle',
  );
  h.stop();
  setTimeout(() => {
    h.cp.pendingTurns.set('intervening-turn', {});
    h.cp._handleHookEvent({ type: 'UserPromptSubmit', prompt: '' });
    h.cp.pendingTurns.clear();
    fs.appendFileSync(h.transcriptPath, `${JSON.stringify(h.terminal)}\n`);
  }, 20);

  await settled;
  assert.equal(h.emitted.length, 0);
});

test('a repeated Stop after transcript settlement cannot duplicate fallback', async (t) => {
  const h = makeLaggedWorkflowHarness(t);
  const firstDelivery = onceWithTimeout(
    h.cp,
    'autonomous-assistant-message',
    'first fallback was not delivered',
  );
  h.stop();
  setTimeout(() => {
    fs.appendFileSync(h.transcriptPath, `${JSON.stringify(h.terminal)}\n`);
  }, 20);
  await firstDelivery;
  h.stop();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(h.emitted.length, 1);
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
    ['later mainline row', (fixture) => {
      const terminal = fixture.rows.at(-1);
      fixture.rows.push({
        type: 'user',
        uuid: 'later-user',
        parentUuid: terminal.uuid,
        sessionId: fixture.sessionId,
        isSidechain: false,
        message: { role: 'user', content: 'Later activity.' },
      });
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

test('duplicate and forward-referenced replay attempts fail closed', async (t) => {
  const input = { chat_id: 'chat-1', text: 'Delivered report.' };
  const toolUse = (id) => ({
    type: 'assistant',
    requestId: `${id}-request`,
    message: {
      id: `${id}-message`,
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'mcp__orchestra-bridge__reply', input }],
    },
  });
  const toolResult = (id, receipt) => ({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        is_error: receipt.ok === false,
        content: JSON.stringify(receipt),
      }],
    },
  });

  const duplicate = await correlateFixture(t, makeWorkflowRows({
    branch: [
      toolUse('reply-1'),
      toolResult('reply-1', { ok: false, timeout: true, attempt_id: 'duplicate-attempt' }),
      toolUse('reply-2'),
      toolResult('reply-2', { ok: false, timeout: true, attempt_id: 'duplicate-attempt' }),
      toolUse('reply-3'),
      toolResult('reply-3', {
        ok: true,
        delivery: 'replayed',
        attempt_id: 'replay-attempt',
        replay_of: 'duplicate-attempt',
      }),
    ],
  }));
  assert.equal(duplicate.eligible, false);
  assert.equal(duplicate.reason, 'delivery-attempt-ambiguous');

  const forwardReference = await correlateFixture(t, makeWorkflowRows({
    branch: [
      toolUse('reply-1'),
      toolResult('reply-1', {
        ok: true,
        delivery: 'replayed',
        attempt_id: 'replay-attempt',
        replay_of: 'later-attempt',
      }),
      toolUse('reply-2'),
      toolResult('reply-2', { ok: false, timeout: true, attempt_id: 'later-attempt' }),
    ],
  }));
  assert.equal(forwardReference.eligible, false);
  assert.equal(forwardReference.reason, 'delivery-replay-order-invalid');
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

test('disconnect, kill, and reset invalidate deferred Workflow delivery decisions', async (t) => {
  const teardowns = [
    ['disconnect', async (cp) => cp._handleBridgeDisconnected('test-disconnect')],
    ['kill', async (cp) => cp.kill('test-kill')],
    ['reset', async (cp) => cp.resetSession({ reason: 'test-reset' })],
  ];

  for (const [name, teardown] of teardowns) {
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
    await teardown(cp);
    cp._settleDeliveryAttempt(attempt, 'sent');
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(emitted, false, name);
    assert.equal(cp.hasPendingDeliveryWork(), false, name);
    assert.equal(cp._deliveryAttempts.size, 0, name);
    assert.equal(cp._activeWorkflowDecisions.size, 0, name);
  }
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
