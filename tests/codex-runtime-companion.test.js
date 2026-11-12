'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { attestRuntimeCompanion, assertRuntimeCompanion } = require('../lib/codex/runtime-companion');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.orchestra-companion-')));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin, { mode: 0o700 });
  const binary = path.join(bin, 'codex'); fs.writeFileSync(binary, 'synthetic-cli', { mode: 0o700 });
  const helper = path.join(bin, 'codex-code-mode-host');
  const bytes = '#!/bin/sh\nexit 0\n'; const hash = createHash('sha256').update(bytes).digest('hex');
  return { root, bin, binary, helper, hash, bytes, create: () => fs.writeFileSync(helper, bytes, { mode: 0o700 }) };
}
test('code mode cannot reach a missing, tampered, aliased or writable companion', async t => {
  for (const kind of ['missing', 'tampered', 'symlink', 'writable', 'hardlink']) await t.test(kind, async t => {
    const f = fixture(t); if (kind !== 'missing') f.create();
    if (kind === 'tampered') fs.appendFileSync(f.helper, 'changed');
    if (kind === 'symlink') { fs.renameSync(f.helper, f.helper + '-other'); fs.symlinkSync(f.helper + '-other', f.helper); }
    if (kind === 'writable') fs.chmodSync(f.helper, 0o777);
    if (kind === 'hardlink') fs.linkSync(f.helper, f.helper + '-other');
    await assert.rejects(attestRuntimeCompanion(f.binary, f.hash), { code: 'CODEX_BINARY_MISMATCH' });
  });
});
test('lazy code-mode launch rejects replacement and late resource/package shadow layouts', async t => {
  for (const kind of ['replace', 'resources', 'metadata']) await t.test(kind, async t => {
    const f = fixture(t); f.create(); const binding = await attestRuntimeCompanion(f.binary, f.hash);
    assert.doesNotThrow(() => assertRuntimeCompanion(binding));
    if (kind === 'replace') { fs.unlinkSync(f.helper); f.create(); }
    if (kind === 'resources') fs.mkdirSync(path.join(f.bin, 'codex-resources'));
    if (kind === 'metadata') fs.writeFileSync(path.join(f.root, 'codex-package.json'), '{}');
    assert.throws(() => assertRuntimeCompanion(binding), { code: 'CODEX_BINARY_MISMATCH' });
  });
});
test('helper attestation rejects an already shadowed selection path and preserves the exact immutable binding', async t => {
  const f = fixture(t); f.create(); fs.mkdirSync(path.join(f.bin, 'codex-resources'));
  await assert.rejects(attestRuntimeCompanion(f.binary, f.hash), { code: 'CODEX_BINARY_MISMATCH' });
  fs.rmdirSync(path.join(f.bin, 'codex-resources'));
  const binding = await attestRuntimeCompanion(f.binary, f.hash);
  assert.equal(binding.path, f.helper); assert.equal(binding.sha256, f.hash); assert(Object.isFrozen(binding));
  assert.doesNotThrow(() => assertRuntimeCompanion(binding));
});

test('unsupported resource and app bundle executable layouts cannot redirect helper selection', async t => {
  for (const kind of ['resources', 'bundle-empty', 'bundle-shadow']) await t.test(kind, async t => {
    const f = fixture(t);
    const dir = kind === 'resources' ? path.join(f.root, 'codex-resources') : path.join(f.root, 'CodexCLI.app/Contents/MacOS');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'codex-code-mode-host'), f.bytes, { mode: 0o700 });
    if (kind === 'bundle-shadow') { fs.writeFileSync(path.join(f.root, 'codex-package.json'), '{}'); fs.mkdirSync(path.join(f.root, 'codex-resources')); }
    await assert.rejects(attestRuntimeCompanion(path.join(dir, 'codex'), f.hash), { code: 'CODEX_BINARY_MISMATCH' });
  });
});
