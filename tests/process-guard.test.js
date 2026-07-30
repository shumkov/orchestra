'use strict';

const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CODEX_SUPERVISOR_GRACE_MS: APP_SERVER_SUPERVISOR_GRACE_MS,
} = require('../lib/codex/app-server-client');
const processGuard = require('..').processGuard;
const { claimPidFile } = processGuard;

test('process guard exports the Codex recovery capabilities', () => {
  assert.equal(
    processGuard.CLAIM_PID_FILE_THROWS_ON_SURVIVING_PREDECESSOR,
    true,
  );
  assert.equal(processGuard.CODEX_SUPERVISOR_GRACE_MS, 2_000);
  assert.equal(
    processGuard.CODEX_SUPERVISOR_GRACE_MS,
    APP_SERVER_SUPERVISOR_GRACE_MS,
  );
});

test('claimPidFile refuses ownership while the predecessor survives SIGKILL', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orchestra-process-guard-'));
  const pidPath = path.join(root, 'daemon.pid');
  const predecessorPid = 424_242;
  writeFileSync(pidPath, `${predecessorPid}\n`, { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const originalKill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => {
    assert.equal(pid, predecessorPid);
    if (signal !== 0) signals.push(signal);
    return true;
  };
  t.after(() => {
    process.kill = originalKill;
  });

  assert.throws(
    () => claimPidFile(pidPath, {
      logger: { log() {} },
      sigtermWaitMs: 1,
      sigkillWaitMs: 1,
    }),
    (error) => error.code === 'PROCESS_GUARD_PREDECESSOR_ALIVE',
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(readFileSync(pidPath, 'utf8'), `${predecessorPid}\n`);
});
