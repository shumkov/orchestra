// Offline real-binary checks for the exact standalone companion boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CodexAppServerClient, attestPinnedCodexBinary, attestPinnedCodexHome } = require('../../lib/codex/app-server-client');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
assert(args.includes('--binary') && args.includes('--helper'));
const root = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-companion-probe-'));
fs.chmodSync(root, 0o700);
const binary = path.join(root, 'codex');
const helper = path.join(root, 'codex-code-mode-host');
const shadow = path.join(root, 'codex-resources');
const home = path.join(root, 'codex-home');
const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
fs.mkdirSync(home, { mode: 0o700 });
const config = 'model = "gpt-6-astra"\n';
fs.writeFileSync(path.join(home, 'config.toml'), config, { mode: 0o600 });
const { createHash } = await import('node:crypto');
const configHash = createHash('sha256').update(config).digest('hex');
fs.copyFileSync(option('--binary'), binary); fs.chmodSync(binary, 0o700);
let client;
const report = { platform: process.platform, arch: process.arch, paidCalls: 0, checks: {} };
try {
  await assert.rejects(attestPinnedCodexBinary(binary), { code: 'CODEX_BINARY_MISMATCH' });
  report.checks.missingHelperRejected = true;
  fs.copyFileSync(option('--helper'), helper); fs.chmodSync(helper, 0o700);
  await attestPinnedCodexBinary(binary);
  report.checks.exactHelperAccepted = true;
  let binaryReady;
  const ready = new Promise(resolve => { binaryReady = resolve; });
  let spawned = false;
  client = new CodexAppServerClient({ binary, codexHome: home, cwd: workspace,
    expectedConfigSha256: configHash,
    onFault: async () => {},
    attestBinaryFn: async (...params) => { const result = await attestPinnedCodexBinary(...params); binaryReady(); return result; },
    attestCodexHomeFn: async () => { await ready; fs.mkdirSync(shadow); return attestPinnedCodexHome(home, configHash); },
    spawnFn: () => { spawned = true; throw new Error('companion drift reached spawn'); },
  });
  await assert.rejects(client.start(), { code: 'CODEX_BINARY_MISMATCH' });
  assert.equal(spawned, false);
  report.checks.parallelAttestationDriftBlocksSpawn = true;
  report.outcome = 'passed';
} finally {
  if (client) await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
