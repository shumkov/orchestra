'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const path = require('node:path');

const spikeUrl = pathToFileURL(
  path.resolve(__dirname, '../scripts/spikes/codex-app-server-real.mjs'),
);

function schemaWithPolicies(policies) {
  return {
    definitions: {
      SandboxPolicy: {
        oneOf: policies,
      },
    },
  };
}

test('Codex U1a STOP cannot be cleared by an unrelated readOnlyAccess field', async () => {
  const {
    gateExitCode,
    hasRestrictedWorkspaceReadPolicy,
  } = await import(spikeUrl);
  const schema = schemaWithPolicies([
    {
      title: 'WorkspaceWriteSandboxPolicy',
      properties: { writableRoots: { type: 'array' } },
    },
    {
      title: 'OtherSandboxPolicy',
      properties: { readOnlyAccess: { type: 'object' } },
    },
  ]);

  const hasRestrictedReads = hasRestrictedWorkspaceReadPolicy(schema);
  assert.equal(hasRestrictedReads, false);
  assert.equal(gateExitCode(hasRestrictedReads), 2);
});

test('Codex U1a can continue only when workspaceWrite owns readOnlyAccess', async () => {
  const {
    gateExitCode,
    hasRestrictedWorkspaceReadPolicy,
  } = await import(spikeUrl);
  const schema = schemaWithPolicies([
    {
      title: 'WorkspaceWriteSandboxPolicy',
      properties: { readOnlyAccess: { type: 'object' } },
    },
  ]);

  const hasRestrictedReads = hasRestrictedWorkspaceReadPolicy(schema);
  assert.equal(hasRestrictedReads, true);
  assert.equal(gateExitCode(hasRestrictedReads), 0);
});

test('Codex U1a bounds a hung launcher subprocess', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX launcher contract');
    return;
  }
  const { runCommand } = await import(spikeUrl);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-codex-u1a-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const binaryPath = path.join(scratch, 'codex');
  const launcherPath = path.join(scratch, 'launcher');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(launcherPath, '#!/bin/sh\nexec sleep 5\n', { mode: 0o700 });
  chmodSync(binaryPath, 0o700);
  chmodSync(launcherPath, 0o700);

  const startedAt = Date.now();
  const result = runCommand(
    { binary: binaryPath, launcher: launcherPath },
    ['--version'],
    {},
    50,
  );

  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.ok(Date.now() - startedAt < 1_000);
});
