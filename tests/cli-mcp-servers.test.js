'use strict';

// Configured MCP servers for the CLI backend. A chat or topic may give its
// Claude session MCP servers next to the channels bridge. These tests pin the
// rules that keep that safe: a bad entry never reaches claude and never takes
// the session down, the bridge can never be replaced, bot sessions can never
// start an OAuth flow, and leftover config files (which hold secrets) are
// removed only when their session is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  resolveConfiguredMcpServers,
  buildMcpConfig,
  authToolDenyList,
  sweepStaleMcpConfigs,
} = require('../lib/process/cli-mcp-servers');

const BRIDGE = 'polygram-bridge';
const CANVA = { type: 'http', url: 'https://mcp.canva.com/mcp' };

function resolve(value) {
  return resolveConfiguredMcpServers({ value, reservedName: BRIDGE });
}

test('no configured servers leaves the session exactly as before', () => {
  assert.deepEqual(resolve(undefined), { servers: {}, skipped: [] });
  assert.deepEqual(resolve(null), { servers: {}, skipped: [] });
  assert.deepEqual(resolve({}), { servers: {}, skipped: [] });
});

test('a non-object mcpServers value is ignored as a whole, visibly', () => {
  for (const value of [[CANVA], 'canva', 5, true]) {
    assert.deepEqual(resolve(value), {
      servers: {},
      skipped: [{ name: null, reason: 'not-an-object' }],
    });
  }
});

test('valid http, sse and stdio servers pass through unchanged', () => {
  const value = {
    canva: { ...CANVA, headers: { 'X-Team': 'umi' }, oauth: { clientId: 'x' }, timeout: 30000 },
    events: { type: 'sse', url: 'http://127.0.0.1:9000/sse' },
    local: { command: 'node', args: ['server.js'], env: { MODE: 'ro' } },
    typed: { type: 'stdio', command: '/usr/bin/tool' },
  };
  const { servers, skipped } = resolve(value);
  assert.deepEqual(servers, value);
  assert.deepEqual(skipped, []);
});

test('each invalid entry is skipped with its reason while the rest still load', () => {
  const value = {
    canva: CANVA,
    'bad name': CANVA,
    [BRIDGE]: CANVA,
    nourl: { type: 'http' },
    ftp: { type: 'http', url: 'ftp://example.com/mcp' },
    garbage: { type: 'http', url: 'not a url' },
    typo: { type: 'http', url: CANVA.url, header: { a: 'b' } },
    badheader: { type: 'http', url: CANVA.url, headers: { a: 1 } },
    badtimeout: { type: 'http', url: CANVA.url, timeout: -1 },
    nocommand: { type: 'stdio' },
    numcommand: { command: 123 },
    badargs: { command: 'node', args: 'server.js' },
    badenv: { command: 'node', env: { TOKEN: 42 } },
    urlstdio: { command: 'node', url: CANVA.url },
    unknowntype: { type: 'websocket', url: 'https://x.example/mcp' },
    notobject: 5,
    array: [CANVA],
  };
  const { servers, skipped } = resolve(value);
  assert.deepEqual(servers, { canva: CANVA });
  const reasons = Object.fromEntries(skipped.map(s => [s.name, s.reason]));
  assert.deepEqual(reasons, {
    'bad name': 'invalid-name',
    [BRIDGE]: 'reserved-name',
    nourl: 'invalid-definition',
    ftp: 'invalid-definition',
    garbage: 'invalid-definition',
    typo: 'invalid-definition',
    badheader: 'invalid-definition',
    badtimeout: 'invalid-definition',
    nocommand: 'invalid-definition',
    numcommand: 'invalid-definition',
    badargs: 'invalid-definition',
    badenv: 'invalid-definition',
    urlstdio: 'invalid-definition',
    unknowntype: 'invalid-definition',
    notobject: 'invalid-definition',
    array: 'invalid-definition',
  });
});

test('skip records never carry the server definition (it may hold secrets)', () => {
  const secret = 'Bearer sk-secret-123';
  const { skipped } = resolve({
    leaky: { type: 'http', url: CANVA.url, headers: { Authorization: secret }, extra: secret },
  });
  assert.equal(skipped.length, 1);
  assert.ok(!JSON.stringify(skipped).includes(secret));
});

test('a name longer than 64 characters is rejected, and reported cut to 64', () => {
  const long = 'a'.repeat(5000);
  assert.deepEqual(resolve({ [long]: CANVA }).skipped, [{ name: 'a'.repeat(64), reason: 'invalid-name' }]);
  assert.deepEqual(Object.keys(resolve({ ['a'.repeat(64)]: CANVA }).servers), ['a'.repeat(64)]);
});

// The name becomes the mcp__<name>__ tool prefix and is joined with commas
// into --disallowedTools, so separators must never pass.
test('names with a comma, dot, slash or space are rejected', () => {
  for (const name of ['a,b', 'a.b', 'a/b', 'a b', '']) {
    assert.deepEqual(resolve({ [name]: CANVA }), {
      servers: {},
      skipped: [{ name, reason: 'invalid-name' }],
    }, JSON.stringify(name));
  }
});

// JSON.parse makes "__proto__" an own key; assigning it to a plain object
// would set the prototype instead and drop the entry without a trace.
test('a server named __proto__ is rejected visibly, not silently dropped', () => {
  const value = JSON.parse('{"__proto__":{"type":"http","url":"https://x.example/mcp"},"canva":'
    + JSON.stringify(CANVA) + '}');
  const { servers, skipped } = resolve(value);
  assert.deepEqual(Object.keys(servers), ['canva']);
  assert.equal(Object.getPrototypeOf(servers), Object.prototype);
  assert.deepEqual(skipped, [{ name: '__proto__', reason: 'invalid-name' }]);
});

test('an oauth value that is not an object is rejected', () => {
  for (const oauth of ['client-id', 5, ['x'], null]) {
    assert.deepEqual(
      resolve({ canva: { ...CANVA, oauth } }).skipped,
      [{ name: 'canva', reason: 'invalid-definition' }],
      JSON.stringify(oauth),
    );
  }
});

test('the bridge starts first and cannot be replaced by a configured entry', () => {
  const bridgeDef = { command: 'node', args: ['bridge.mjs'], env: { S: '1' } };
  // buildMcpConfig must not trust its input to be pre-validated.
  const config = buildMcpConfig({
    bridgeName: BRIDGE,
    bridgeDef,
    servers: { canva: CANVA, [BRIDGE]: { type: 'http', url: 'https://evil.example/mcp' } },
  });
  assert.deepEqual(Object.keys(config.mcpServers), [BRIDGE, 'canva']);
  assert.deepEqual(config.mcpServers[BRIDGE], bridgeDef);
});

test('with no servers the config holds only the bridge', () => {
  const bridgeDef = { command: 'node', args: ['bridge.mjs'] };
  assert.deepEqual(
    buildMcpConfig({ bridgeName: BRIDGE, bridgeDef, servers: {} }),
    { mcpServers: { [BRIDGE]: bridgeDef } },
  );
});

test('every configured server has its OAuth tools denied', () => {
  assert.equal(authToolDenyList({}), null);
  assert.equal(
    authToolDenyList({ canva: CANVA, 'my_srv-2': CANVA }),
    [
      'mcp__canva__authenticate',
      'mcp__canva__complete_authentication',
      'mcp__my_srv-2__authenticate',
      'mcp__my_srv-2__complete_authentication',
    ].join(','),
  );
});

// ─── stale mcp-config sweep ──────────────────────────────────────────

function tmpDir(t) {
  // A short base: unix socket paths are capped near 104 bytes on macOS, and a
  // per-user TMPDIR there is already ~50.
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'ms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hex = (c) => c.repeat(32);
const HOUR_AGO = (Date.now() - 60 * 60 * 1000) / 1000;

test('sweep removes old config files whose session is gone and keeps live ones', async (t) => {
  const dir = tmpDir(t);
  const write = (name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '{}', { mode: 0o600 });
    fs.utimesSync(p, HOUR_AGO, HOUR_AGO);
  };

  // Dead: no socket at all.
  write(`polygram-${hex('a')}-mcp.json`);
  // Dead: socket file left behind by a killed daemon (nothing listens).
  write(`polygram-${hex('b')}-mcp.json`);
  fs.writeFileSync(path.join(dir, `polygram-${hex('b')}.sock`), '');
  // Live: a listening socket (possibly another bot's daemon).
  write(`polygram-${hex('c')}-mcp.json`);
  const liveSock = path.join(dir, `polygram-${hex('c')}.sock`);
  const live = net.createServer(s => s.end());
  await new Promise(r => live.listen(liveSock, r));
  t.after(() => live.close());
  // Unrelated: other prefix, wrong shape.
  write(`water-${hex('d')}-mcp.json`);
  write('polygram-notes-mcp.json');

  const result = await sweepStaleMcpConfigs({
    sessionPrefix: 'polygram', dir, logger: { warn() {}, log() {} },
  });

  const left = fs.readdirSync(dir).filter(f => f.endsWith('-mcp.json')).sort();
  assert.deepEqual(left, [
    'polygram-notes-mcp.json',
    `polygram-${hex('c')}-mcp.json`,
    `water-${hex('d')}-mcp.json`,
  ].sort());
  assert.equal(result.removed.length, 2);
});

// Both bots share /tmp and the prefix, and a release restarts both: one
// daemon's boot sweep runs while the other's sessions are cold-starting. A
// young file is never probed, because connecting to a session that is still
// starting can disturb its bridge handshake.
test('sweep leaves young config files alone and never connects to their sockets', async (t) => {
  const dir = tmpDir(t);
  // Young, no socket: could be a session between writing its config and listening.
  fs.writeFileSync(path.join(dir, `polygram-${hex('e')}-mcp.json`), '{}', { mode: 0o600 });
  // Young, with a listening socket that never sends hello (a starting session).
  fs.writeFileSync(path.join(dir, `polygram-${hex('f')}-mcp.json`), '{}', { mode: 0o600 });
  let connections = 0;
  const starting = net.createServer(() => { connections++; });
  await new Promise(r => starting.listen(path.join(dir, `polygram-${hex('f')}.sock`), r));
  t.after(() => starting.close());

  const result = await sweepStaleMcpConfigs({
    sessionPrefix: 'polygram', dir, logger: { warn() {}, log() {} },
  });
  await new Promise(r => setTimeout(r, 30));

  assert.deepEqual(result.removed, []);
  assert.equal(connections, 0, 'a starting session must not be probed');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('-mcp.json')).length, 2);
});

test('the minimum age is 15 minutes by default and can be set', async (t) => {
  const dir = tmpDir(t);
  const p = path.join(dir, `polygram-${hex('a')}-mcp.json`);
  fs.writeFileSync(p, '{}', { mode: 0o600 });
  const tenMinAgo = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(p, tenMinAgo, tenMinAgo);
  const quiet = { warn() {}, log() {} };

  assert.deepEqual((await sweepStaleMcpConfigs({ sessionPrefix: 'polygram', dir, logger: quiet })).removed, []);
  assert.deepEqual(
    (await sweepStaleMcpConfigs({ sessionPrefix: 'polygram', dir, logger: quiet, minAgeMs: 5 * 60 * 1000 })).removed,
    [`polygram-${hex('a')}-mcp.json`],
  );
});

test('sweep tolerates a missing directory', async () => {
  const result = await sweepStaleMcpConfigs({
    sessionPrefix: 'polygram',
    dir: path.join(os.tmpdir(), 'does-not-exist-' + process.pid),
    logger: { warn() {}, log() {} },
  });
  assert.deepEqual(result.removed, []);
});

test('sweep requires a session prefix so it cannot match every file', async () => {
  await assert.rejects(() => sweepStaleMcpConfigs({ dir: os.tmpdir() }), /sessionPrefix/);
});
