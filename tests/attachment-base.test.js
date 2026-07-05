'use strict';

// Regression: buildAllowedRoots must use the RAW sessionKey so its root byte-matches
// the per-session staging dir cli-process creates (path.join(base, String(sessionKey))).
// Sanitizing the key here (but not there) diverged the allowlist from the real dir for
// keys with chars outside [\w.-] — e.g. WhatsApp JIDs '…@g.us' or Telegram 'chat:topic'
// — so validateAttachmentPath's realpath(root) missed and every reply(files) was rejected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAllowedRoots, validateAttachmentPath } = require('../index').attachmentBase;

for (const sessionKey of ['120363419377779909@g.us', 'chat:topic', 'u@d.net', 'plain-123']) {
  test(`allowlist root byte-matches the raw staging dir for sessionKey ${sessionKey}`, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-attach-'));
    // cli-process creates the staging dir from the RAW key:
    const stagingDir = path.join(base, String(sessionKey));
    fs.mkdirSync(stagingDir, { recursive: true });
    const staged = path.join(stagingDir, 'track.flac');
    fs.writeFileSync(staged, 'x');

    const roots = buildAllowedRoots({ sessionKey, base });
    const verdict = validateAttachmentPath(staged, roots);
    assert.equal(verdict.ok, true, `a file staged under the raw dir must validate (got: ${verdict.error})`);

    fs.rmSync(base, { recursive: true, force: true });
  });
}
