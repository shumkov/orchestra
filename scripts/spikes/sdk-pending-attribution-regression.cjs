// Provider-free regression for autonomous results arriving during a user request.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SdkProcess } = require('../../lib/process/sdk-process');
const { makeFakeQuery } = require('../../tests/_helpers/fake-query');

for (const report of [
  { subtype: 'success', is_error: false, num_turns: 1, result: 'synthetic agent report', origin: { kind: 'peer', from: 'synthetic-agent', senderTaskId: 'synthetic-agent', handback: true } },
  { subtype: 'success', is_error: false, num_turns: 0, result: '', origin: { kind: 'task-notification', producer: 'session-task', runId: 'synthetic-run' } },
]) {
  test(`${report.origin.kind} result must not complete an unrelated pending user prompt`, async () => {
    const fake = makeFakeQuery();
    const proc = new SdkProcess({
      sessionKey: 'synthetic-attribution-regression', label: 'synthetic',
      spawnFn: () => fake.query, logger: { error() {}, warn() {} }, queryCloseTimeoutMs: 100,
    });
    await proc.start({});
    const completion = proc.send('Reply SYNTHETIC-USER-ONLY', { context: { sourceMsgId: 3 } }).catch(() => null);
    try {
      await proc._handleEvent({ type: 'result', session_id: 'synthetic-session', ...report });
      assert.equal(proc.pendingQueue.length, 1, 'autonomous report must leave user pending intact');
    } finally {
      await proc.kill('reproducer-complete');
      await completion;
    }
  });
}
