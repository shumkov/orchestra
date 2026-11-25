'use strict';

// A session's bridge socket lives in a shared directory, so other local
// processes can connect to it (another daemon's boot sweep probing liveness,
// a stray client). Only the authenticated bridge may own the session's
// single bridge slot. If an unauthenticated connection took the slot, a
// session still starting up would treat that stranger's close as its own
// bridge dying and fail with BRIDGE_DISCONNECTED (reproduced when both bots
// restarted together).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { ChannelsBridgeServer } = require('../lib/process/channels-bridge-server');

const quiet = { warn() {}, error() {}, log() {} };

async function startServer(t) {
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'bs-'));
  const server = new ChannelsBridgeServer({
    sockPath: path.join(dir, 's.sock'),
    sessionKey: 'sess',
    sockSecret: 'secret-1',
    logger: quiet,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const events = { disconnected: 0, init: 0 };
  server.on('bridge-disconnected', () => { events.disconnected++; });
  server.on('session-init', () => { events.init++; });
  return { server, events };
}

function connect(server) {
  const sock = net.connect(server.sockPath);
  const lines = [];
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  sock.on('error', () => {});
  return { sock, lines, ready: new Promise(r => sock.once('connect', r)) };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function authenticate(server) {
  const bridge = connect(server);
  await bridge.ready;
  bridge.sock.write(JSON.stringify({ kind: 'hello', session_key: 'sess', secret: 'secret-1' }) + '\n');
  bridge.sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'sid' }) + '\n');
  await tick();
  return bridge;
}

test('a stranger that connects and leaves without hello is not reported as the bridge dying', async (t) => {
  const { server, events } = await startServer(t);
  const probe = connect(server);
  await probe.ready;
  probe.sock.destroy();
  await tick();
  assert.equal(events.disconnected, 0);

  const bridge = await authenticate(server);
  assert.deepEqual(bridge.lines[0], { kind: 'hello_ack' });
  assert.equal(events.init, 1);
  bridge.sock.destroy();
  await tick();
  assert.equal(events.disconnected, 1, 'the real bridge closing is still reported');
});

test('a stranger holding a connection open does not block the real bridge', async (t) => {
  const { server, events } = await startServer(t);
  const probe = connect(server);
  await probe.ready;
  await tick();

  const bridge = await authenticate(server);
  assert.deepEqual(bridge.lines[0], { kind: 'hello_ack' });
  assert.equal(events.init, 1);

  probe.sock.destroy();
  await tick();
  assert.equal(events.disconnected, 0, 'the stranger leaving is not the bridge leaving');
  assert.ok(server.writeMessage({ kind: 'ping' }), 'the bridge connection is still the live one');
});

test('once a bridge is authenticated, further connections are turned away', async (t) => {
  const { server, events } = await startServer(t);
  await authenticate(server);
  const extra = connect(server);
  await extra.ready;
  await tick();
  assert.deepEqual(extra.lines[0], { kind: 'hello_reject', reason: 'already-connected' });
  await tick();
  assert.equal(events.disconnected, 0);
});

test('close() also ends connections that never authenticated', async (t) => {
  const { server } = await startServer(t);
  const probe = connect(server);
  await probe.ready;
  const closed = new Promise(r => probe.sock.once('close', r));
  await server.close();
  await closed;
});
