'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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

test('tool acknowledgement without an opaque attempt id is rejected', () => {
  const parsed = parseDaemonToBridgeMessage({
    kind: 'tool_ack',
    tool_call_id: 'tool-1',
    ok: false,
    error: 'transport failed',
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /attempt_id/);
});
