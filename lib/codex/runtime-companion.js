'use strict';

const { createHash } = require('node:crypto');
const { createReadStream, lstatSync, realpathSync } = require('node:fs');
const path = require('node:path');

function mismatch() {
  return Object.assign(new Error('pinned Codex code-mode companion or selection layout changed'), {
    code: 'CODEX_BINARY_MISMATCH',
  });
}

function absent(file) {
  try { lstatSync(file); throw mismatch(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function fingerprint(binary) {
  const dir = path.dirname(binary);
  if (path.basename(dir) === 'codex-resources'
    || (path.basename(dir) === 'MacOS' && path.basename(path.dirname(dir)) === 'Contents'
      && path.basename(path.dirname(path.dirname(dir))) === 'CodexCLI.app')) throw mismatch();
  // Upstream prefers packaged resources over the standalone sibling. Only the
  // standalone layout is admitted, so later metadata cannot redirect execution.
  absent(path.join(dir, 'codex-resources'));
  absent(path.join(dir, 'codex-package.json'));
  if (path.basename(dir) === 'bin') {
    absent(path.join(path.dirname(dir), 'codex-package.json'));
    absent(path.join(path.dirname(dir), 'codex-resources'));
  }
  const helper = path.join(dir, 'codex-code-mode-host');
  if (realpathSync(helper) !== helper) throw mismatch();
  let component = path.parse(helper).root;
  for (const part of helper.slice(component.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    const stat = lstatSync(component);
    if (stat.isSymbolicLink() || ![0, process.getuid?.()].includes(stat.uid)
      || (stat.mode & 0o022) !== 0) throw mismatch();
  }
  const stat = lstatSync(helper, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o111n) === 0n) throw mismatch();
  return {
    path: helper,
    identity: ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink']
      .map(key => stat[key].toString()).join(':'),
  };
}

async function attestRuntimeCompanion(binary, sha256) {
  try {
    const before = fingerprint(binary);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(before.path)) hash.update(chunk);
    if (hash.digest('hex') !== sha256 || fingerprint(binary).identity !== before.identity) throw mismatch();
    return Object.freeze({ binary, path: before.path, sha256, identity: before.identity });
  } catch { throw mismatch(); }
}

function assertRuntimeCompanion(binding) {
  try {
    if (fingerprint(binding.binary).identity !== binding.identity) throw mismatch();
  } catch { throw mismatch(); }
}

module.exports = { attestRuntimeCompanion, assertRuntimeCompanion };
