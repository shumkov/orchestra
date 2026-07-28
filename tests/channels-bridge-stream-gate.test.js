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
