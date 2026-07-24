'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatToolAckResult,
  parseDaemonToBridgeMessage,
} = require('../lib/process/channels-bridge-protocol');

test('tool acknowledgements distinguish direct sends from causal replays', () => {
  const sent = parseDaemonToBridgeMessage({
    kind: 'tool_ack',
    tool_call_id: 'tool-1',
    ok: true,
    attempt_id: 'attempt-1',
    delivery: 'sent',
    message_id: 42,
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.msg.attempt_id, 'attempt-1');
  assert.equal(sent.msg.delivery, 'sent');

  const replay = parseDaemonToBridgeMessage({
    kind: 'tool_ack',
    tool_call_id: 'tool-2',
    ok: true,
    attempt_id: 'attempt-2',
    delivery: 'replayed',
    replay_of: 'attempt-1',
    message_id: 42,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.msg.delivery, 'replayed');
  assert.equal(replay.msg.replay_of, 'attempt-1');
});

test('0.4.2 tool acknowledgement remains wire-compatible without receipt metadata', () => {
  const parsed = parseDaemonToBridgeMessage({
    kind: 'tool_ack',
    tool_call_id: 'tool-1',
    ok: false,
    error: 'transport failed',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.msg.attempt_id, undefined);
});

test('tool result formatter preserves timeout identity for transcript correlation', () => {
  const error = new Error('daemon ack timeout');
  error.code = 'TOOL_ACK_TIMEOUT';
  const result = formatToolAckResult({
    error,
    toolCallId: 'timed-out-attempt',
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    error: 'daemon ack timeout',
    timeout: true,
    attempt_id: 'timed-out-attempt',
  });
});
