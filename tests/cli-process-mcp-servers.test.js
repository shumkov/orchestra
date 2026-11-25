'use strict';

// CliProcess wiring of configured MCP servers (chat/topic `mcpServers`).
// What matters to the people using the bots:
//   - a chat that configures nothing gets exactly today's session (bridge only);
//   - a topic gets the servers its config names and no others, so one role's
//     tools do not appear in another role's topic;
//   - the bridge, which carries every reply, is never displaced;
//   - secrets in a server definition never reach argv or logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');

const { CliProcess } = require('../index');

const CANVA = { type: 'http', url: 'https://mcp.canva.com/mcp' };
const FIGMA = { type: 'http', url: 'https://mcp.figma.com/mcp' };

async function captureSpawn(startOpts) {
  const out = { args: [], mcpConfig: null, mcpMode: null, events: [], logs: [] };
  const runner = {
    spawn: async (opts) => {
      out.args.push(...opts.args);
      const p = opts.args[opts.args.indexOf('--mcp-config') + 1];
      out.mcpConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
      out.mcpMode = fs.statSync(p).mode & 0o777;
    },
    killSession: async () => {},
    sendControl: async () => {},
    captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
  };
  const record = (level) => (...a) => out.logs.push(`${level}: ${a.join(' ')}`);
  const p = new CliProcess({
    sessionKey: 'sess-mcp',
    chatId: '1', threadId: startOpts.threadId ?? null, label: 'mcp-test',
    tmuxRunner: runner, botName: 'b',
    toolDispatcher: async () => ({ ok: true }),
    claudeBin: '/usr/bin/echo',
    logger: { warn: record('warn'), error: record('error'), log: record('log') },
    db: { logEvent: (kind, detail) => out.events.push({ kind, detail }) },
    handshakeTimeoutMs: 2000,
  });
  const startP = p.start(startOpts);
  for (let i = 0; i < 50 && (!p.sockPath || !fs.existsSync(p.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const sock = net.connect(p.sockPath);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
  sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
  await startP;
  sock.end();
  await p.kill('test');
  return out;
}

const serverNames = (out) => Object.keys(out.mcpConfig.mcpServers);
const mcpEvents = (out) => out.events.filter(e => e.kind === 'cli-mcp-servers');
const denyArg = (out) => {
  const i = out.args.indexOf('--disallowedTools');
  return i < 0 ? null : out.args[i + 1];
};

test('a chat with no mcpServers gets the bridge only, no deny flag, no event', async () => {
  const out = await captureSpawn({ chatConfig: { agent: 'a' } });
  assert.deepEqual(serverNames(out), ['orchestra-bridge']);
  assert.equal(denyArg(out), null);
  assert.deepEqual(mcpEvents(out), []);
  assert.ok(out.args.includes('--strict-mcp-config'));
});

test('chat-level servers are mounted next to the bridge with their OAuth tools denied', async () => {
  const out = await captureSpawn({ chatConfig: { mcpServers: { canva: CANVA } } });
  assert.deepEqual(serverNames(out), ['orchestra-bridge', 'canva']);
  assert.deepEqual(out.mcpConfig.mcpServers.canva, CANVA);
  assert.equal(denyArg(out), 'mcp__canva__authenticate,mcp__canva__complete_authentication');
  const ev = mcpEvents(out);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].detail.servers, [{ name: 'canva', type: 'http' }]);
  assert.deepEqual(ev[0].detail.skipped, []);
  assert.equal(out.mcpMode, 0o600);
});

test('--mcp-config stays the last flag and the deny list sits before it', async () => {
  const out = await captureSpawn({ chatConfig: { mcpServers: { canva: CANVA } } });
  const mcpIdx = out.args.indexOf('--mcp-config');
  assert.equal(mcpIdx, out.args.length - 2);
  for (let i = mcpIdx + 2; i < out.args.length; i++) {
    assert.ok(!out.args[i].startsWith('--'), `flag ${out.args[i]} after --mcp-config`);
  }
  const denyIdx = out.args.indexOf('--disallowedTools');
  assert.ok(denyIdx >= 0 && denyIdx < mcpIdx);
  assert.ok(!out.args[denyIdx + 2].startsWith('mcp__'), 'deny list is one argument');
});

test('a topic with its own mcpServers replaces the chat set', async () => {
  const out = await captureSpawn({
    threadId: '1306',
    chatConfig: {
      mcpServers: { figma: FIGMA },
      topics: { 1306: { mcpServers: { canva: CANVA } } },
    },
  });
  assert.deepEqual(serverNames(out), ['orchestra-bridge', 'canva']);
});

test('a topic with an empty mcpServers drops the chat set', async () => {
  const out = await captureSpawn({
    threadId: '7',
    chatConfig: { mcpServers: { figma: FIGMA }, topics: { 7: { mcpServers: {} } } },
  });
  assert.deepEqual(serverNames(out), ['orchestra-bridge']);
  assert.equal(denyArg(out), null);
});

test('topics without the key, with null, or in legacy string form inherit the chat set', async () => {
  for (const topic of [{ agent: 'x' }, { mcpServers: null }, 'Legacy name']) {
    const out = await captureSpawn({
      threadId: '9',
      chatConfig: { mcpServers: { figma: FIGMA }, topics: { 9: topic } },
    });
    assert.deepEqual(serverNames(out), ['orchestra-bridge', 'figma'], JSON.stringify(topic));
  }
});

test('another topic of the same chat does not get a topic-scoped server', async () => {
  const out = await captureSpawn({
    threadId: '2',
    chatConfig: { topics: { 1306: { mcpServers: { canva: CANVA } }, 2: {} } },
  });
  assert.deepEqual(serverNames(out), ['orchestra-bridge']);
});

test('invalid entries are skipped visibly and the session still starts', async () => {
  const out = await captureSpawn({
    chatConfig: {
      mcpServers: {
        canva: CANVA,
        'orchestra-bridge': { type: 'http', url: 'https://evil.example/mcp' },
        broken: { type: 'http' },
      },
    },
  });
  assert.deepEqual(serverNames(out), ['orchestra-bridge', 'canva']);
  assert.equal(out.mcpConfig.mcpServers['orchestra-bridge'].command, 'node');
  const [ev] = mcpEvents(out);
  assert.deepEqual(ev.detail.skipped, [
    { name: 'orchestra-bridge', reason: 'reserved-name' },
    { name: 'broken', reason: 'invalid-definition' },
  ]);
  assert.equal(out.logs.filter(l => l.startsWith('warn:') && /mcp server/i.test(l)).length, 2);
});

test('secrets in a server definition never reach argv, events or logs', async () => {
  const secret = 'sk-very-secret-value';
  const out = await captureSpawn({
    chatConfig: {
      mcpServers: {
        api: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: `Bearer ${secret}` } },
        tool: { command: 'node', args: ['t.js'], env: { TOKEN: secret } },
        bad: { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: secret }, extra: 1 },
      },
    },
  });
  assert.ok(!out.args.join(' ').includes(secret), 'argv');
  assert.ok(!JSON.stringify(out.events).includes(secret), 'events');
  assert.ok(!out.logs.join('\n').includes(secret), 'logs');
  // The file itself (0600) does carry them: that is where claude reads them.
  assert.equal(out.mcpConfig.mcpServers.api.headers.Authorization, `Bearer ${secret}`);
  assert.equal(out.mcpMode, 0o600);
});
