'use strict';

/**
 * The `stream` tool's env gate, proven against a REAL bridge subprocess.
 *
 * The thing that has to be true: a consumer that never opted in gets a bridge
 * with no `stream` tool, EVEN IF the daemon it runs under inherited
 * ORCHESTRA_STREAM_TOOL=1 from somewhere — an operator's shell, a co-tenant
 * daemon, a launchd plist. That env travels daemon → tmux → claude → MCP child,
 * and the bridge reads the ambient environment, so "we didn't set it" is not the
 * same as "it isn't set".
 *
 * A source-level assertion cannot show this. This test spawns the actual bridge
 * with a poisoned ambient environment, speaks MCP to it over stdio, and reads
 * back the tool list it really advertises.
 *
 * Run: node --test tests/channels-bridge-stream-gate.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { CliProcess } = require('../index');

const BRIDGE_PATH = require.resolve('../lib/process/channels-bridge.mjs');

const fakeRunner = {
  spawn: async () => {}, killSession: async () => {},
  sendControl: async () => {}, captureWide: async () => '',
};

/** The daemon-side env the bridge would really be launched with. */
function bridgeEnvFor(capabilities, sockPath) {
  const p = new CliProcess({
    sessionKey: 'sess-gate', chatId: '1',
    tmuxRunner: fakeRunner, botName: 'testbot', claudeBin: '/usr/bin/echo',
    toolDispatcher: async () => ({ ok: true }),
    toolDispatcherCapabilities: capabilities,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  p.sockPath = sockPath;
  p.sockSecret = 'secret';
  p.claudeSessionId = 'cs-1';
  return p._bridgeEnv();
}

/**
 * Boot a real bridge subprocess, speak MCP to it, and return the tool names it
 * advertises. `ambient` is merged in BENEATH the daemon's own env, exactly like
 * an inherited variable would be.
 */
async function toolNamesFromRealBridge({ capabilities, ambient = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-gate-'));
  const sockPath = path.join(tmp, 'bridge.sock');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);

  // The bridge exits on socket error, so the daemon end must exist first. It
  // needs no protocol here — the test only asks the MCP side what it registered.
  const server = net.createServer((conn) => { conn.on('data', () => {}); conn.on('error', () => {}); });
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env: {
      ...ambient,                                   // e.g. a poisoned ORCHESTRA_STREAM_TOOL
      PATH: process.env.PATH,
      HOME: home,                                   // keep the bridge's log files out of the real home
      ...bridgeEnvFor(capabilities, sockPath),      // the daemon's own env wins
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = msg.id != null && pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });
  child.stderr.on('data', () => {});   // bridge diagnostics; not under test

  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stream-gate-test', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await request(2, 'tools/list', {});
    return (listed.result?.tools || []).map((t) => t.name);
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a real bridge registers `stream` when the consumer opted in', async () => {
  const names = await toolNamesFromRealBridge({ capabilities: { stream: true } });
  assert.ok(names.includes('stream'), `expected stream in ${JSON.stringify(names)}`);
  assert.ok(names.includes('reply'), 'the baseline tools are unaffected');
});

test('a real bridge omits `stream` when the consumer did not opt in', async () => {
  const names = await toolNamesFromRealBridge({ capabilities: null });
  assert.deepEqual(names.filter((n) => n === 'stream'), []);
  assert.ok(names.includes('reply'), 'the baseline tools are unaffected');
});

test('an ambient ORCHESTRA_STREAM_TOOL=1 cannot enable the tool for a consumer that did not opt in', async () => {
  const names = await toolNamesFromRealBridge({
    capabilities: null,
    ambient: { ORCHESTRA_STREAM_TOOL: '1' },
  });
  assert.deepEqual(
    names.filter((n) => n === 'stream'), [],
    'an inherited env var must not opt a consumer in on its behalf',
  );
  assert.ok(names.includes('reply'));
});

test('an ambient value does not disturb a consumer that DID opt in', async () => {
  const names = await toolNamesFromRealBridge({
    capabilities: { stream: true },
    ambient: { ORCHESTRA_STREAM_TOOL: '' },
  });
  assert.ok(names.includes('stream'));
});

// ─── turn-id stamping ────────────────────────────────────────────────
//
// Live failure 2026-07-29: the first session that ever ADOPTED the stream
// contract omitted turn_id on every call (the schema marks it required;
// models drop it anyway) and the daemon refused each snapshot as
// unattributable — the user watched nothing while the model believed it was
// streaming. The bridge knows which turn it last delivered, so it stamps
// that id onto stream calls that arrive without one; the daemon still
// verifies the id against its live head turn, so a stale or foreign stamp
// is dropped there exactly like any other mismatch.
async function streamArgsSeenByDaemon({ userMsg, streamArgs }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stamp-'));
  const sockPath = path.join(tmp, 'bridge.sock');
  const seenTools = [];
  let daemonConn = null;
  const server = net.createServer((conn) => {
    daemonConn = conn;
    let sbuf = '';
    conn.on('data', (d) => {
      sbuf += d.toString();
      let nl;
      while ((nl = sbuf.indexOf('\n')) !== -1) {
        const line = sbuf.slice(0, nl); sbuf = sbuf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === 'hello') conn.write(`${JSON.stringify({ kind: 'hello_ack' })}\n`);
        if (msg.kind === 'tool') {
          seenTools.push(msg);
          conn.write(`${JSON.stringify({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: true })}\n`);
        }
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env: {
      PATH: process.env.PATH,
      HOME: home,                                   // keep the bridge's log files out of the real home
      ...bridgeEnvFor({ stream: true }, sockPath),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const waiter = msg.id != null && pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });
  child.stderr.on('data', () => {});
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stamp-test', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    // Wait for the bridge's socket handshake to complete.
    const deadline = Date.now() + 10_000;
    while (!daemonConn && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(daemonConn, 'bridge connected its socket');
    if (userMsg) daemonConn.write(`${JSON.stringify({ kind: 'user_msg', ...userMsg })}\n`);
    await new Promise((r) => setTimeout(r, 200));   // let the notification path settle
    await request(3, 'tools/call', { name: 'stream', arguments: streamArgs });
    return seenTools.filter((t) => t.name === 'stream');
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a stream call missing turn_id is stamped with the last delivered turn', async () => {
  const calls = await streamArgsSeenByDaemon({
    userMsg: { text: 'hi', chat_id: '42', turn_id: 'T-123' },
    streamArgs: { chat_id: '42', text: 'draft so far' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.turn_id, 'T-123', 'bridge stamped the last user turn id');
});

test('a stream call that DOES carry turn_id keeps its own', async () => {
  const calls = await streamArgsSeenByDaemon({
    userMsg: { text: 'hi', chat_id: '42', turn_id: 'T-123' },
    streamArgs: { chat_id: '42', turn_id: 'T-OWN', text: 'draft' },
  });
  assert.equal(calls[0].args.turn_id, 'T-OWN', 'an explicit id is never overwritten');
});

test('with no user turn seen, a missing turn_id stays missing (daemon refuses as before)', async () => {
  const calls = await streamArgsSeenByDaemon({
    userMsg: null,
    streamArgs: { chat_id: '42', text: 'draft' },
  });
  assert.equal(calls[0].args.turn_id, undefined, 'nothing to stamp with — no invented ids');
});
