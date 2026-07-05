// provenance: extracted from polygram/water channels-tool-dispatcher.js (git 746bca6).
// The staging-dir base + attachment-path validators are engine-level (they bound where
// a Claude session may read files from for outbound sends), independent of transport.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Per-session staging dir for agent file sends. Consumers may override the base.
const DEFAULT_ATTACHMENT_BASE = path.join(os.tmpdir(), 'orchestra-attachments');

function isPathUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateAttachmentPath(filePath, allowedRoots) {
  if (typeof filePath !== 'string' || filePath.length === 0) return { ok: false, error: 'empty path' };
  let real;
  try { real = fs.realpathSync(filePath); } catch (e) { return { ok: false, error: `not found: ${e.code || e.message}` }; }
  const allowed = allowedRoots.some((root) => {
    try { return isPathUnder(real, fs.realpathSync(root)); } catch { return false; }
  });
  if (!allowed) return { ok: false, error: 'path outside the allowed staging/cwd roots' };
  return { ok: true, real };
}

function buildAllowedRoots({ sessionKey, sessionCwd = null, extraRoots = [], base = DEFAULT_ATTACHMENT_BASE }) {
  // RAW sessionKey — must byte-match the per-session staging dir cli-process creates
  // (path.join(base, String(sessionKey))). Sanitizing here (but not there) diverges the
  // allowlist from the real dir for keys with chars outside [\w.-] (e.g. WhatsApp JIDs
  // '…@g.us'), so realpath(root) misses and every reply(files) is rejected.
  const roots = [path.join(base, String(sessionKey))];
  if (sessionCwd) roots.push(sessionCwd);
  for (const r of extraRoots) if (r) roots.push(r);
  return roots;
}

module.exports = { DEFAULT_ATTACHMENT_BASE, isPathUnder, validateAttachmentPath, buildAllowedRoots };
