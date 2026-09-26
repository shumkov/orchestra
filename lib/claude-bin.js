// provenance: polygram@0.17.11 lib/claude-bin.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

// The channels backend consumes Claude Code's private TUI, hook, and session
// formats. Change this pin only after the real-CLI compatibility gate passes.
// It must equal the `claudeCodeVersion` of the exact Agent SDK version in
// package.json: that SDK's platform package supplies the vendored binary, and
// a unit test fails when the two drift apart. It stays a literal because
// consumers that omit optional dependencies have no SDK to derive it from.
const CLAUDE_CLI_PINNED_VERSION = '2.1.283';

/**
 * Resolve + verify the pinned claude CLI binary.
 *
 * Why this exists: the tmux + CLI backends read claude CLI internal
 * artefacts (TUI banner ASCII, READY hint strings, channel notification
 * registration timing, MCP-init order) — none a stable public contract.
 * polygram pins ONE version (`CLAUDE_CLI_PINNED_VERSION`) and must
 * spawn THAT binary, never whatever `claude` on $PATH happens to
 * resolve to.
 *
 * Before this module the tmux runner spawned the bare string
 * `claude`, resolved through $PATH. The claude CLI installs each
 * version as a standalone binary at
 *   ~/.local/share/claude/versions/<version>
 * and points ~/.local/bin/claude (a symlink) at the active one.
 * Its auto-updater re-points that symlink whenever a new version
 * lands — so a $PATH spawn silently drifts (shumorobot 2026-05-16:
 * CLI auto-updated 2.1.142 → 2.1.143 between deploys).
 *
 * Spawning the ABSOLUTE versioned path avoids the symlink-drift, but is
 * NOT immune to the updater: claude keeps only the ~3 newest versions
 * and PRUNES (deletes) the rest. Once the pin falls out of the top 3 the
 * pinned path is a dead file → every cli spawn exits in ~14ms (prod
 * outages 2026-06-21/22). So `verifyPinnedClaudeBin` (point-in-time check)
 * is not enough; `ensureVendoredClaudeBin` (below, 0.17) keeps a
 * polygram-owned copy the pruner can't touch.
 */

/**
 * Absolute path to the pinned claude binary.
 *
 * Resolution order:
 *   1. ORCHESTRA_CLAUDE_BIN env — explicit override (non-standard
 *      installs, CI, hosts where the layout differs).
 *   2. ~/.local/share/claude/versions/<version> — the standard
 *      claude-CLI install location.
 *
 * The returned path is NOT guaranteed to exist — callers verify
 * via verifyPinnedClaudeBin().
 *
 * @param {string} version — pinned version, e.g. '2.1.142'
 * @returns {string} absolute path
 */
function resolvePinnedClaudeBin(version) {
  const override = process.env.ORCHESTRA_CLAUDE_BIN;
  if (override) return override;
  return path.join(os.homedir(), '.local', 'share', 'claude', 'versions', version);
}

/**
 * Verify the pinned binary exists and is executable.
 *
 * @param {string} version — pinned version, e.g. '2.1.142'
 * @returns {{ ok: boolean, path: string, reason?: string }}
 *   ok=true → path is a spawnable binary.
 *   ok=false → reason carries an operator-actionable message.
 */
function verifyPinnedClaudeBin(version) {
  const binPath = resolvePinnedClaudeBin(version);
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return { ok: true, path: binPath };
  } catch (err) {
    const code = err && err.code ? err.code : (err && err.message) || 'unknown';
    return {
      ok: false,
      path: binPath,
      reason: `pinned claude CLI v${version} not found or not executable at `
        + `${binPath} (${code}). Install it with \`claude install ${version}\` `
        + 'or set ORCHESTRA_CLAUDE_BIN to the correct binary path.',
    };
  }
}

// ─── 0.17: vendored pinned binary (immune to claude's auto-pruner) ──────────
//
// claude's updater deletes all but the ~3 newest versions, so the pinned
// version eventually vanishes from ~/.local/share/claude/versions and every
// cli spawn dies. We can't fall forward (the cli backend reads version-specific
// TUI internals). Fix: polygram keeps its OWN copy of the exact pinned binary
// in a dir the pruner never touches, and spawns from there. Once vendored it
// never depends on the system copy or the network again.

/**
 * polygram-owned vendor dir for claude binaries. Under ~/.local/share/water
 * (XDG data) — claude's pruner only touches ~/.local/share/claude/versions, and
 * `npm i -g polygram` only replaces the package dir, so this survives both.
 * Override with ORCHESTRA_CLAUDE_VENDOR_DIR.
 */
function vendorDir() {
  return process.env.ORCHESTRA_CLAUDE_VENDOR_DIR
    || path.join(os.homedir(), '.local', 'share', 'orchestra', 'claude-bin');
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// `claude --version` prints e.g. "2.1.283 (Claude Code)".
function _reportedVersion(bin) {
  const out = execFileSync(bin, ['--version'], { timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.trim().split(/\s+/)[0];
}

// Atomic and validated: copy to a unique tmp in the same dir, chmod, check the
// copy, then rename over. The check matters because the fast path trusts any
// executable file in the vendor dir forever, and a source can be caught
// mid-write (`npm i -g` extracts in place while a service may be restarting).
function _atomicCopyExec(src, dst, version) {
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, 0o755);
    const srcSize = fs.statSync(src).size;
    const tmpSize = fs.statSync(tmp).size;
    if (srcSize !== tmpSize) {
      throw new Error(`copied ${tmpSize} of ${srcSize} bytes`);
    }
    let reported;
    try { reported = _reportedVersion(tmp); } catch (e) {
      throw new Error(`\`--version\` failed: ${e.message}`);
    }
    if (reported !== version) {
      throw new Error(`\`--version\` reported ${JSON.stringify(reported)}, expected ${version}`);
    }
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

// True on Linux hosts without glibc (e.g. Alpine). Same test the SDK uses.
function _hostPrefersMusl() {
  if (process.platform !== 'linux') return false;
  const report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

/**
 * Locate the claude binary shipped in the Agent SDK's per-platform optional
 * package, resolving it the way the SDK itself does. Resolution starts from
 * the SDK's own directory so a nested SDK copy finds its matching platform
 * package.
 *
 * @param {object} [opts]
 * @param {NodeRequire} [opts.requireFrom] — require used to find the SDK
 * @param {string} [opts.platform] [opts.arch] [opts.preferMusl]
 * @returns {{ ok: boolean, path?: string, claudeCodeVersion?: string, sdkVersion?: string, reason?: string }}
 */
function findSdkClaudeBin({
  requireFrom = require,
  platform = process.platform,
  arch = process.arch,
  preferMusl = _hostPrefersMusl(),
} = {}) {
  let sdkPkgPath;
  try {
    sdkPkgPath = path.join(path.dirname(requireFrom.resolve(SDK_PACKAGE)), 'package.json');
  } catch (e) {
    return { ok: false, reason: `${SDK_PACKAGE} not installed (${e.code || e.message})` };
  }
  let sdkPkg;
  try { sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf8')); } catch (e) {
    return { ok: false, reason: `cannot read ${sdkPkgPath}: ${e.message}` };
  }
  const suffixes = platform === 'linux'
    ? (preferMusl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`])
    : [`${platform}-${arch}`];
  const sdkRequire = createRequire(sdkPkgPath);
  for (const suffix of suffixes) {
    let bin;
    try { bin = sdkRequire.resolve(`${SDK_PACKAGE}-${suffix}/claude${platform === 'win32' ? '.exe' : ''}`); } catch { continue; }
    let platformPkg;
    try { platformPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), 'package.json'), 'utf8')); } catch { continue; }
    if (platformPkg.version !== sdkPkg.version) {
      return {
        ok: false,
        reason: `${SDK_PACKAGE}-${suffix}@${platformPkg.version} does not match ${SDK_PACKAGE}@${sdkPkg.version}`,
      };
    }
    return { ok: true, path: bin, claudeCodeVersion: sdkPkg.claudeCodeVersion, sdkVersion: sdkPkg.version };
  }
  return { ok: false, reason: `no ${SDK_PACKAGE} platform package for ${platform}/${arch}` };
}

// `claude --help` costs 0.5–1.5s, so it runs at most once per binary path.
const _helpTextCache = new Map();

/**
 * Whether a claude binary accepts a command-line flag, judged by its --help
 * output. Older binaries reject unknown options at startup, so a flag added in
 * a newer CLI must be feature-detected rather than assumed from the pin
 * (overrides and rollbacks can point at older binaries). Failures report false.
 *
 * @param {string} bin
 * @param {string} flag — e.g. '--system-prompt-snapshot'
 * @returns {boolean}
 */
function supportsClaudeFlag(bin, flag) {
  if (!_helpTextCache.has(bin)) {
    let help = '';
    try {
      help = execFileSync(bin, ['--help'], { timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {}
    _helpTextCache.set(bin, help);
  }
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?![\\w-])`, 'm').test(_helpTextCache.get(bin));
}

// Remove vendored binaries (and stale .tmp.*) that aren't the live version.
function _gcVendored(dir, keepVersion, logger) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === keepVersion) continue;
    // Never delete an in-flight copy: a CONCURRENT boot (multi-bot host shares
    // this dir) may be mid-copy into `<keepVersion>.tmp.<pid>.<ts>`; removing it
    // ENOENTs that boot's rename → it falls back to SDK. Skip all .tmp.* — a
    // genuinely orphaned tmp is cheap to leave (cleaned when its version is GC'd
    // by name, or harmless). Defense-in-depth: only GC version-shaped names so a
    // misconfigured vendor dir can't nuke unrelated files.
    if (name.includes('.tmp.')) continue;
    if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch (e) {
      logger?.warn?.(`[claude-bin] vendor GC: could not remove ${name}: ${e.message}`);
    }
  }
}

/**
 * Ensure a polygram-owned copy of the pinned claude binary exists and return
 * its path. Steady state is a single stat (fast). On a cold/pruned host it
 * obtains the binary once and caches it forever, trying in order: the Agent
 * SDK's platform package, the system install, then `claude install`.
 *
 * @param {string} version
 * @param {{ logger?: object, sdk?: object }} [opts] — `sdk` is passed to findSdkClaudeBin
 * @returns {{ ok: boolean, path: string, vendored?: boolean, reason?: string }}
 */
function ensureVendoredClaudeBin(version, { logger = console, sdk = {} } = {}) {
  // Explicit override wins, unchanged — non-standard installs / CI / tests.
  const override = process.env.ORCHESTRA_CLAUDE_BIN;
  if (override) {
    return isExecutable(override)
      ? { ok: true, path: override, vendored: false }
      : { ok: false, path: override, reason: `ORCHESTRA_CLAUDE_BIN=${override} not executable` };
  }

  const dir = vendorDir();
  const vendored = path.join(dir, version);

  // Fast path: already vendored.
  if (isExecutable(vendored)) {
    _gcVendored(dir, version, logger);
    return { ok: true, path: vendored, vendored: true };
  }

  // Need to obtain it. Ensure the dir exists.
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, path: vendored, reason: `cannot create vendor dir ${dir}: ${e.message}` };
  }

  const versionsDir = process.env.ORCHESTRA_CLAUDE_VERSIONS_DIR
    || path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
  const systemPath = path.join(versionsDir, version);

  // (0) copy from the Agent SDK's platform package when it bundles exactly
  // this version. Any mismatch or failed validation falls through.
  const fromSdk = findSdkClaudeBin(sdk);
  if (fromSdk.ok && fromSdk.claudeCodeVersion !== version) {
    logger?.log?.(`[claude-bin] Agent SDK ${fromSdk.sdkVersion} bundles claude v${fromSdk.claudeCodeVersion}, not v${version}; skipping it`);
  } else if (fromSdk.ok) {
    try {
      _atomicCopyExec(fromSdk.path, vendored, version);
      logger?.log?.(`[claude-bin] vendored claude v${version} ← Agent SDK ${fromSdk.sdkVersion} (${fromSdk.path}) → ${vendored}`);
      _gcVendored(dir, version, logger);
      return { ok: true, path: vendored, vendored: true };
    } catch (e) {
      logger?.warn?.(`[claude-bin] Agent SDK copy of claude v${version} rejected (${e.message}); trying ${systemPath}`);
    }
  } else {
    logger?.log?.(`[claude-bin] ${fromSdk.reason}; trying ${systemPath}`);
  }

  // (a) copy from the system install if present.
  if (isExecutable(systemPath)) {
    try {
      _atomicCopyExec(systemPath, vendored, version);
      logger?.log?.(`[claude-bin] vendored claude v${version} ← ${systemPath} → ${vendored}`);
    } catch (e) {
      return { ok: false, path: vendored, reason: `copy ${systemPath} → ${vendored} failed: ${e.message}` };
    }
  } else {
    // (b) try to install the exact version, then copy. If
    // ORCHESTRA_CLAUDE_INSTALL_BIN is set, use it VERBATIM (no fallback — an
    // explicit override that's wrong must fail loudly, not silently shell out to
    // a different claude). Otherwise prefer ~/.local/bin/claude, else PATH.
    let installerBin = process.env.ORCHESTRA_CLAUDE_INSTALL_BIN;
    if (!installerBin) {
      const localBin = path.join(os.homedir(), '.local', 'bin', 'claude');
      installerBin = isExecutable(localBin) ? localBin : 'claude';
    }
    logger?.warn?.(`[claude-bin] pinned claude v${version} absent from ${systemPath}; installing via ${installerBin}…`);
    try {
      // Synchronous: blocks boot until the install completes. Rare (deploys
      // pre-install the pin → the fast copy path above is the norm). On the VPS
      // polygram boots DETACHED in tmux (Type=oneshot start-sessions.sh), so
      // this block is NOT gated by systemd's TimeoutStartSec; on the Mac launchd
      // has no hard start-timeout. Timeout kept under the VPS unit's 120s anyway.
      execFileSync(installerBin, ['install', version], { timeout: 110_000, stdio: 'ignore' });
    } catch (e) {
      return {
        ok: false, path: vendored,
        reason: `claude v${version} not present and \`claude install ${version}\` failed (${e.message}). `
          + 'Install it manually or set ORCHESTRA_CLAUDE_BIN.',
      };
    }
    if (!isExecutable(systemPath)) {
      return { ok: false, path: vendored, reason: `claude install ${version} ran but ${systemPath} still missing` };
    }
    try {
      _atomicCopyExec(systemPath, vendored, version);
      logger?.log?.(`[claude-bin] installed + vendored claude v${version} → ${vendored}`);
    } catch (e) {
      return { ok: false, path: vendored, reason: `copy after install failed: ${e.message}` };
    }
  }

  _gcVendored(dir, version, logger);
  if (!isExecutable(vendored)) {
    return { ok: false, path: vendored, reason: `vendored copy ${vendored} is not executable after copy` };
  }
  return { ok: true, path: vendored, vendored: true };
}

/**
 * Check Claude CLI OAuth health from the credentials file — FREE (no API call,
 * no model spawn). The CLI stores its login in ~/.claude/.credentials.json under
 * `claudeAiOauth`, with two expiries: the short-lived `expiresAt` (access token,
 * which the CLI silently auto-refreshes) and `refreshTokenExpiresAt` (the HARD
 * limit — once the refresh token itself ages out, auto-refresh 401s and every
 * channels-backend turn wedges INVISIBLY: claude fires UserPromptSubmit then
 * dies with "OAuth access token has expired", which never reaches polygram's
 * classifier, so it degrades to a silent "⏱ went quiet"). We watch the
 * refresh-token expiry so the daemon can refuse turns with a clear message
 * instead of wedging.
 *
 * Pure + injectable (`home`/`now`) for tests.
 *
 * @param {{home?:string, now?:number, warnWithinMs?:number}} [opts]
 * @returns {{state:'healthy'|'expiring'|'expired'|'unknown', reason?:string,
 *   refreshTokenExpiresAt:?number, msLeft:?number, daysLeft:?number}}
 */
function checkClaudeAuthHealth({ home = os.homedir(), now = Date.now(), warnWithinMs = 3 * 86_400_000 } = {}) {
  const credPath = path.join(home, '.claude', '.credentials.json');
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch (err) {
    // Missing/unreadable → can't prove expiry. Report 'unknown' (caller logs it)
    // rather than 'expired', so a transient read error never hard-refuses traffic.
    return { state: 'unknown', reason: `credentials unreadable: ${err.code || err.message}`, refreshTokenExpiresAt: null, msLeft: null, daysLeft: null };
  }
  const exp = creds && creds.claudeAiOauth && creds.claudeAiOauth.refreshTokenExpiresAt;
  if (typeof exp !== 'number') {
    return { state: 'unknown', reason: 'no claudeAiOauth.refreshTokenExpiresAt', refreshTokenExpiresAt: null, msLeft: null, daysLeft: null };
  }
  const msLeft = exp - now;
  const daysLeft = Math.round((msLeft / 86_400_000) * 10) / 10;
  let state = 'healthy';
  if (msLeft <= 0) state = 'expired';
  else if (msLeft <= warnWithinMs) state = 'expiring';
  return { state, refreshTokenExpiresAt: exp, msLeft, daysLeft };
}

module.exports = {
  resolvePinnedClaudeBin,
  verifyPinnedClaudeBin,
  ensureVendoredClaudeBin,
  findSdkClaudeBin,
  supportsClaudeFlag,
  vendorDir,
  CLAUDE_CLI_PINNED_VERSION,
  checkClaudeAuthHealth,
};
