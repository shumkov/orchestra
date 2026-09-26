'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  CLAUDE_CLI_PINNED_VERSION,
  checkClaudeAuthHealth,
  resolvePinnedClaudeBin,
  verifyPinnedClaudeBin,
} = require('../index').claudeBin;

const ORIGINAL_OVERRIDE = process.env.ORCHESTRA_CLAUDE_BIN;

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.ORCHESTRA_CLAUDE_BIN;
  else process.env.ORCHESTRA_CLAUDE_BIN = ORIGINAL_OVERRIDE;
});

describe('claude-bin — resolvePinnedClaudeBin', () => {
  test('defaults to the compatibility-gated Claude Code 2.1.283 pin', () => {
    assert.equal(CLAUDE_CLI_PINNED_VERSION, '2.1.283');
  });

  // The pinned Agent SDK defines the CLI version: its platform package ships
  // the exact binary we vendor, and SDK-backed sessions run that same binary.
  // Bumping the SDK without moving the constant (or the reverse) must fail here
  // instead of silently running two different Claude versions.
  test('the pin equals the claudeCodeVersion bundled by the installed Agent SDK', () => {
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(sdkEntry), 'package.json'), 'utf8'));
    assert.equal(sdkPkg.claudeCodeVersion, CLAUDE_CLI_PINNED_VERSION);
    assert.equal(
      require('../package.json').optionalDependencies['@anthropic-ai/claude-agent-sdk'],
      sdkPkg.version,
      'package.json pins the installed SDK version exactly',
    );
  });

  test('resolves to the standard claude-CLI versions path', () => {
    delete process.env.ORCHESTRA_CLAUDE_BIN;
    assert.equal(
      resolvePinnedClaudeBin('2.1.142'),
      path.join(os.homedir(), '.local', 'share', 'claude', 'versions', '2.1.142'),
    );
  });

  test('the version string is part of the path (different versions → different paths)', () => {
    delete process.env.ORCHESTRA_CLAUDE_BIN;
    assert.notEqual(
      resolvePinnedClaudeBin('2.1.142'),
      resolvePinnedClaudeBin('2.1.143'),
    );
  });

  test('ORCHESTRA_CLAUDE_BIN env overrides the default path', () => {
    process.env.ORCHESTRA_CLAUDE_BIN = '/custom/claude';
    assert.equal(resolvePinnedClaudeBin('2.1.142'), '/custom/claude');
  });
});

describe('claude-bin — verifyPinnedClaudeBin', () => {
  test('ok=true for an existing executable file', () => {
    // node itself is a reliable executable to point at.
    process.env.ORCHESTRA_CLAUDE_BIN = process.execPath;
    const r = verifyPinnedClaudeBin('2.1.142');
    assert.equal(r.ok, true);
    assert.equal(r.path, process.execPath);
    assert.equal(r.reason, undefined);
  });

  test('ok=false with an actionable reason for a missing binary', () => {
    process.env.ORCHESTRA_CLAUDE_BIN = path.join(
      os.tmpdir(), `orchestra-claude-bin-missing-${Date.now()}`,
    );
    const r = verifyPinnedClaudeBin('2.1.142');
    assert.equal(r.ok, false);
    assert.match(r.reason, /pinned claude CLI v2\.1\.142 not found/);
    assert.match(r.reason, /claude install 2\.1\.142/);
    assert.match(r.reason, /ORCHESTRA_CLAUDE_BIN/);
  });

  test('ok=false for a non-executable file', () => {
    const tmp = path.join(os.tmpdir(), `orchestra-claude-bin-noexec-${Date.now()}`);
    fs.writeFileSync(tmp, 'not a binary', { mode: 0o600 });
    try {
      process.env.ORCHESTRA_CLAUDE_BIN = tmp;
      const r = verifyPinnedClaudeBin('2.1.142');
      assert.equal(r.ok, false);
      assert.match(r.reason, /not found or not executable/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

// 0.17: vendor the pinned binary so claude's auto-pruner can't delete it out
// from under the cli backend.
describe('claude-bin — ensureVendoredClaudeBin', () => {
  const { ensureVendoredClaudeBin } = require('../index').claudeBin;
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const VER = '2.1.173';
  const SAVE = ['ORCHESTRA_CLAUDE_BIN', 'ORCHESTRA_CLAUDE_VENDOR_DIR', 'ORCHESTRA_CLAUDE_VERSIONS_DIR', 'ORCHESTRA_CLAUDE_INSTALL_BIN'];
  let saved; let root;

  // A fake claude that answers `--version` the way the real one does, so the
  // pre-rename validation accepts it.
  const fakeExec = (p, ver = VER) => fs.writeFileSync(p, `#!/bin/sh\necho '${ver} (Claude Code)'\n`, { mode: 0o755 });

  function setup() {
    saved = {}; for (const k of SAVE) { saved[k] = process.env[k]; delete process.env[k]; }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-vendor-'));
    const vendorD = path.join(root, 'vendor');
    const versionsD = path.join(root, 'versions');
    fs.mkdirSync(vendorD, { recursive: true });
    fs.mkdirSync(versionsD, { recursive: true });
    process.env.ORCHESTRA_CLAUDE_VENDOR_DIR = vendorD;
    process.env.ORCHESTRA_CLAUDE_VERSIONS_DIR = versionsD;
    return { vendorD, versionsD };
  }
  function teardown() {
    for (const k of SAVE) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }

  test('already-vendored → returns the vendored path without re-copying', () => {
    const { vendorD } = setup();
    try {
      fakeExec(path.join(vendorD, VER));
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true);
      assert.equal(r.vendored, true);
      assert.equal(r.path, path.join(vendorD, VER));
    } finally { teardown(); }
  });

  test('missing vendor + present system version → copies into the vendor dir (executable)', () => {
    const { vendorD, versionsD } = setup();
    try {
      fakeExec(path.join(versionsD, VER));
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true);
      assert.equal(r.path, path.join(vendorD, VER));
      assert.ok(fs.existsSync(path.join(vendorD, VER)), 'binary copied');
      fs.accessSync(path.join(vendorD, VER), fs.constants.X_OK); // executable
    } finally { teardown(); }
  });

  test('GC removes stale vendored versions, keeps the live one', () => {
    const { vendorD, versionsD } = setup();
    try {
      fakeExec(path.join(vendorD, '2.1.150'));   // stale old vendored version
      fakeExec(path.join(versionsD, VER));        // system has the live version
      ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.ok(!fs.existsSync(path.join(vendorD, '2.1.150')), 'stale vendored version GC-removed');
      assert.ok(fs.existsSync(path.join(vendorD, VER)), 'live version kept');
    } finally { teardown(); }
  });

  // Copies now stay in a temp file while `--version` runs, so a process
  // killed mid-deploy can leave a ~250 MB temp copy behind. Fresh temp files
  // may belong to a concurrent boot and must survive; old ones are litter.
  test('GC removes temp copies older than 10 minutes and keeps fresh ones', () => {
    const { vendorD } = setup();
    try {
      fakeExec(path.join(vendorD, VER));
      const stale = path.join(vendorD, `${VER}.tmp.111.1`);
      const fresh = path.join(vendorD, `${VER}.tmp.222.2`);
      fs.writeFileSync(stale, 'x');
      fs.writeFileSync(fresh, 'x');
      const old = new Date(Date.now() - 11 * 60_000);
      fs.utimesSync(stale, old, old);
      ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.ok(!fs.existsSync(stale), 'stale temp copy removed');
      assert.ok(fs.existsSync(fresh), 'fresh temp copy (possible concurrent boot) kept');
    } finally { teardown(); }
  });

  test('system absent + installer SUCCEEDS → installs into versions dir, then vendors', () => {
    const { vendorD, versionsD } = setup();
    try {
      // fake installer: `<bin> install <ver>` drops an executable into the
      // versions dir (the env is inherited by execFileSync).
      const inst = path.join(root, 'fake-installer');
      fs.writeFileSync(inst,
        '#!/bin/sh\nmkdir -p "$ORCHESTRA_CLAUDE_VERSIONS_DIR"\n'
        + 'printf \'#!/bin/sh\\necho "%s (Claude Code)"\\n\' "$2" > "$ORCHESTRA_CLAUDE_VERSIONS_DIR/$2"\n'
        + 'chmod 755 "$ORCHESTRA_CLAUDE_VERSIONS_DIR/$2"\n', { mode: 0o755 });
      process.env.ORCHESTRA_CLAUDE_INSTALL_BIN = inst;
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true, r.reason);
      assert.ok(fs.existsSync(path.join(versionsD, VER)), 'installer wrote the system version');
      assert.ok(fs.existsSync(path.join(vendorD, VER)), 'then vendored from it');
      fs.accessSync(path.join(vendorD, VER), fs.constants.X_OK);
    } finally { teardown(); }
  });

  test('system absent + installer fails → ok=false with actionable reason, no throw', () => {
    setup();
    try {
      process.env.ORCHESTRA_CLAUDE_INSTALL_BIN = path.join(root, 'no-such-claude');
      let r;
      assert.doesNotThrow(() => { r = ensureVendoredClaudeBin(VER, { logger: quiet }); });
      assert.equal(r.ok, false);
      assert.match(r.reason, /install/i);
    } finally { teardown(); }
  });

  test('ORCHESTRA_CLAUDE_BIN override wins (executable) — skips vendoring', () => {
    setup();
    try {
      const ov = path.join(root, 'override-claude');
      fakeExec(ov);
      process.env.ORCHESTRA_CLAUDE_BIN = ov;
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true);
      assert.equal(r.path, ov);
      assert.equal(r.vendored, false);
    } finally { teardown(); }
  });
});

// The pinned Agent SDK ships the exact claude binary in a per-platform optional
// package. Vendoring from it removes the dependency on claude's auto-updater,
// which prunes all but the newest ~3 versions from its versions directory.
describe('claude-bin — vendoring from the Agent SDK platform package', () => {
  const { createRequire } = require('node:module');
  const { ensureVendoredClaudeBin, findSdkClaudeBin } = require('../index').claudeBin;
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const VER = '2.1.283';
  const SAVE = ['ORCHESTRA_CLAUDE_BIN', 'ORCHESTRA_CLAUDE_VENDOR_DIR', 'ORCHESTRA_CLAUDE_VERSIONS_DIR', 'ORCHESTRA_CLAUDE_INSTALL_BIN'];
  const PLATFORM = { platform: 'darwin', arch: 'arm64' };
  let saved; let root;

  const writeClaude = (p, { reports = VER, marker = '' } = {}) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `#!/bin/sh\n# ${marker}\necho '${reports} (Claude Code)'\n`, { mode: 0o755 });
  };

  // Lays out <root>/app/node_modules/@anthropic-ai/{claude-agent-sdk, claude-agent-sdk-<suffix>}
  // and returns a require bound inside that app, as npm would install it.
  function fakeSdk({
    sdkVersion = '0.3.283',
    claudeCodeVersion = VER,
    platforms = { 'darwin-arm64': {} },
  } = {}) {
    const app = path.join(root, 'app');
    const scope = path.join(app, 'node_modules', '@anthropic-ai');
    const sdkDir = path.join(scope, 'claude-agent-sdk');
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk', version: sdkVersion, claudeCodeVersion, main: 'sdk.js',
    }));
    fs.writeFileSync(path.join(sdkDir, 'sdk.js'), '');
    for (const [suffix, { version = sdkVersion, reports = claudeCodeVersion }] of Object.entries(platforms)) {
      const dir = path.join(scope, `claude-agent-sdk-${suffix}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: `@anthropic-ai/claude-agent-sdk-${suffix}`, version,
      }));
      writeClaude(path.join(dir, 'claude'), { reports, marker: `from-sdk-${suffix}` });
    }
    return createRequire(path.join(app, 'index.js'));
  }

  function setup() {
    saved = {}; for (const k of SAVE) { saved[k] = process.env[k]; delete process.env[k]; }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sdk-vendor-'));
    const vendorD = path.join(root, 'vendor');
    const versionsD = path.join(root, 'versions');
    fs.mkdirSync(vendorD, { recursive: true });
    fs.mkdirSync(versionsD, { recursive: true });
    process.env.ORCHESTRA_CLAUDE_VENDOR_DIR = vendorD;
    process.env.ORCHESTRA_CLAUDE_VERSIONS_DIR = versionsD;
    // Any `claude install` attempt in these tests is a bug: point it at a
    // missing binary so it fails loudly instead of touching the real host.
    process.env.ORCHESTRA_CLAUDE_INSTALL_BIN = path.join(root, 'no-installer');
    return { vendorD, versionsD };
  }
  function teardown() {
    for (const k of SAVE) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  const vendoredFrom = (vendorD) => fs.readFileSync(path.join(vendorD, VER), 'utf8');

  test('prefers the SDK platform binary over claude\'s auto-updater versions dir', () => {
    const { vendorD, versionsD } = setup();
    try {
      writeClaude(path.join(versionsD, VER), { marker: 'from-versions' });
      const sdkRequire = fakeSdk();
      const r = ensureVendoredClaudeBin(VER, { logger: quiet, sdk: { requireFrom: sdkRequire, ...PLATFORM } });
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.path, path.join(vendorD, VER));
      assert.match(vendoredFrom(vendorD), /from-sdk-darwin-arm64/);
      fs.accessSync(r.path, fs.constants.X_OK);
    } finally { teardown(); }
  });

  test('works with no versions-dir copy at all (auto-updater already pruned it)', () => {
    const { vendorD } = setup();
    try {
      const r = ensureVendoredClaudeBin(VER, { logger: quiet, sdk: { requireFrom: fakeSdk(), ...PLATFORM } });
      assert.equal(r.ok, true, r.reason);
      assert.match(vendoredFrom(vendorD), /from-sdk/);
    } finally { teardown(); }
  });

  test('an SDK bundling a different claude version is skipped, not vendored under the wrong name', () => {
    const { vendorD, versionsD } = setup();
    try {
      writeClaude(path.join(versionsD, VER), { marker: 'from-versions' });
      const sdkRequire = fakeSdk({ claudeCodeVersion: '2.1.999' });
      const r = ensureVendoredClaudeBin(VER, { logger: quiet, sdk: { requireFrom: sdkRequire, ...PLATFORM } });
      assert.equal(r.ok, true, r.reason);
      assert.match(vendoredFrom(vendorD), /from-versions/);
    } finally { teardown(); }
  });

  test('a platform package whose version differs from the SDK is skipped', () => {
    const { vendorD, versionsD } = setup();
    try {
      writeClaude(path.join(versionsD, VER), { marker: 'from-versions' });
      const sdkRequire = fakeSdk({ platforms: { 'darwin-arm64': { version: '0.3.282' } } });
      const r = ensureVendoredClaudeBin(VER, { logger: quiet, sdk: { requireFrom: sdkRequire, ...PLATFORM } });
      assert.equal(r.ok, true, r.reason);
      assert.match(vendoredFrom(vendorD), /from-versions/);
    } finally { teardown(); }
  });

  test('a missing SDK (optional deps omitted) falls through to the versions dir', () => {
    const { vendorD, versionsD } = setup();
    try {
      writeClaude(path.join(versionsD, VER), { marker: 'from-versions' });
      const emptyRequire = createRequire(path.join(root, 'empty-app', 'index.js'));
      const r = ensureVendoredClaudeBin(VER, { logger: quiet, sdk: { requireFrom: emptyRequire, ...PLATFORM } });
      assert.equal(r.ok, true, r.reason);
      assert.match(vendoredFrom(vendorD), /from-versions/);
    } finally { teardown(); }
  });

  // `npm i -g` extracts in place and the service restarts within seconds, so a
  // boot can see package.json before the binary is fully written. A copy that
  // doesn't report the requested version must never become the cached vendor
  // copy, because the fast path trusts any executable file it finds there.
  test('a source binary that does not report the requested version is never cached', () => {
    const { vendorD, versionsD } = setup();
    try {
      writeClaude(path.join(versionsD, VER), { marker: 'from-versions' });
      const sdkRequire = fakeSdk({ platforms: { 'darwin-arm64': { reports: 'garbage' } } });
      const r = ensureVendoredClaudeBin(VER, { logger: quiet, sdk: { requireFrom: sdkRequire, ...PLATFORM } });
      assert.equal(r.ok, true, r.reason);
      assert.match(vendoredFrom(vendorD), /from-versions/, 'fell through to the next valid source');
      assert.deepEqual(fs.readdirSync(vendorD), [VER], 'no temp file left behind');
    } finally { teardown(); }
  });

  test('when every source fails validation → ok=false and nothing is vendored', () => {
    const { vendorD, versionsD } = setup();
    try {
      writeClaude(path.join(versionsD, VER), { reports: '2.1.100' });
      const emptyRequire = createRequire(path.join(root, 'empty-app', 'index.js'));
      const r = ensureVendoredClaudeBin(VER, { logger: quiet, sdk: { requireFrom: emptyRequire, ...PLATFORM } });
      assert.equal(r.ok, false);
      assert.match(r.reason, /--version/);
      assert.deepEqual(fs.readdirSync(vendorD), []);
    } finally { teardown(); }
  });

  // Mirrors the SDK's own resolver: glibc first on a glibc Linux host, musl
  // first only where glibc is absent.
  test('linux: picks the glibc package on glibc hosts and the musl package on musl hosts', () => {
    setup();
    try {
      const sdkRequire = fakeSdk({ platforms: { 'linux-x64': {}, 'linux-x64-musl': {} } });
      const glibc = findSdkClaudeBin({ requireFrom: sdkRequire, platform: 'linux', arch: 'x64', preferMusl: false });
      const musl = findSdkClaudeBin({ requireFrom: sdkRequire, platform: 'linux', arch: 'x64', preferMusl: true });
      assert.equal(glibc.ok, true, glibc.reason);
      assert.match(glibc.path, /claude-agent-sdk-linux-x64[\\/]claude$/);
      assert.match(musl.path, /claude-agent-sdk-linux-x64-musl[\\/]claude$/);
      assert.equal(glibc.claudeCodeVersion, VER);
    } finally { teardown(); }
  });
});

// 2.1.220 rejects unknown options at startup, so a flag introduced by a newer
// CLI must only be passed to binaries that list it in --help.
describe('claude-bin — supportsClaudeFlag', () => {
  const { supportsClaudeFlag } = require('../index').claudeBin;
  let dir;
  const fakeHelp = (name, helpText) => {
    const p = path.join(dir, name);
    const counter = `${p}.calls`;
    fs.writeFileSync(p, `#!/bin/sh\necho x >> '${counter}'\ncat <<'EOF'\n${helpText}\nEOF\n`, { mode: 0o755 });
    return { bin: p, calls: () => fs.readFileSync(counter, 'utf8').trim().split('\n').length };
  };

  test('true when --help lists the flag, false when it does not', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-flag-'));
    try {
      const newer = fakeHelp('newer', '  --system-prompt-snapshot <on|off>   Record the system prompt');
      const older = fakeHelp('older', '  --append-system-prompt <prompt>');
      assert.equal(supportsClaudeFlag(newer.bin, '--system-prompt-snapshot'), true);
      assert.equal(supportsClaudeFlag(older.bin, '--system-prompt-snapshot'), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a flag that is only a prefix of a listed flag does not count', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-flag-'));
    try {
      const bin = fakeHelp('prefix', '  --system-prompt-snapshot-mode <x>');
      assert.equal(supportsClaudeFlag(bin.bin, '--system-prompt-snapshot'), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing or failing binary reports false instead of throwing', () => {
    assert.equal(supportsClaudeFlag(path.join(os.tmpdir(), `no-claude-${Date.now()}`), '--x'), false);
  });

  // Omitting a flag because --help failed silently changes behaviour (e.g.
  // resumed chats keep a stale recorded system prompt), so it must be visible.
  test('a failing --help is logged once, not on every check', () => {
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m) };
    const bin = path.join(os.tmpdir(), `no-claude-warn-${Date.now()}`);
    supportsClaudeFlag(bin, '--a', { logger });
    supportsClaudeFlag(bin, '--b', { logger });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /--help/);
  });

  test('runs --help once per binary (it takes ~1s, so spawns must not repeat it)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-flag-'));
    try {
      const bin = fakeHelp('cached', '  --system-prompt-snapshot <on|off>\n  --other');
      supportsClaudeFlag(bin.bin, '--system-prompt-snapshot');
      supportsClaudeFlag(bin.bin, '--other');
      supportsClaudeFlag(bin.bin, '--system-prompt-snapshot');
      assert.equal(bin.calls(), 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('claude-bin — checkClaudeAuthHealth (free credentials-file check)', () => {
  const DAY = 86_400_000;
  const NOW = 1_800_000_000_000; // fixed reference for deterministic daysLeft

  function withCreds(oauth) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-auth-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    if (oauth !== undefined) {
      fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: oauth }));
    }
    return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
  }

  test('healthy — refresh token well in the future', () => {
    const { home, cleanup } = withCreds({ refreshTokenExpiresAt: NOW + 28 * DAY });
    try {
      const r = checkClaudeAuthHealth({ home, now: NOW });
      assert.equal(r.state, 'healthy');
      assert.equal(r.daysLeft, 28);
    } finally { cleanup(); }
  });

  test('expiring — refresh token within the warn window (default 3d)', () => {
    const { home, cleanup } = withCreds({ refreshTokenExpiresAt: NOW + 2 * DAY });
    try {
      assert.equal(checkClaudeAuthHealth({ home, now: NOW }).state, 'expiring');
    } finally { cleanup(); }
  });

  test('expired — refresh token in the past (the incident: silent wedge trigger)', () => {
    const { home, cleanup } = withCreds({ refreshTokenExpiresAt: NOW - DAY });
    try {
      const r = checkClaudeAuthHealth({ home, now: NOW });
      assert.equal(r.state, 'expired');
      assert.ok(r.msLeft < 0);
    } finally { cleanup(); }
  });

  test('unknown — credentials file missing (never hard-refuse on a read error)', () => {
    const { home, cleanup } = withCreds(undefined); // no file written
    try {
      const r = checkClaudeAuthHealth({ home, now: NOW });
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /unreadable/);
    } finally { cleanup(); }
  });

  test('unknown — file present but no refreshTokenExpiresAt field', () => {
    const { home, cleanup } = withCreds({ accessToken: 'x', expiresAt: NOW + DAY });
    try {
      const r = checkClaudeAuthHealth({ home, now: NOW });
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /refreshTokenExpiresAt/);
    } finally { cleanup(); }
  });
});
