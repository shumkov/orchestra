'use strict';

/**
 * Display-hint drift joins model/effort drift as a reason to reload a warm cli
 * proc. The hint is baked into the system prompt at spawn time, so a consumer
 * that flips a per-chat rendering toggle (polygram's rich text) can only make it
 * take effect by respawning — the same idle-gated kill('config-reload') +
 * --resume path model/effort already use.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('../index');
const { ProcessManager } = require('../lib/process/process-manager');
const { Process } = require('../lib/process/process');

const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => '',
};
const fakeDispatcher = async () => ({ ok: true });
const quietLogger = { warn: () => {}, error: () => {}, log: () => {} };

function cliProc({ displayHint = '', model = 'opus', effort = 'high' } = {}) {
  const p = new CliProcess({
    sessionKey: 'sk',
    chatId: '42',
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    claudeBin: '/usr/bin/echo',
    toolDispatcher: fakeDispatcher,
    displayHint,
    logger: quietLogger,
  });
  // start() records the spawn-time model/effort; construct-only tests do it by hand.
  p.model = model;
  p.effort = effort;
  return p;
}

describe('CliProcess.wouldReloadFor — display-hint drift', () => {
  test('hint drift while idle → reload', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    assert.equal(
      p.wouldReloadFor({ model: 'opus', effort: 'high', displayHint: 'HINT B' }),
      true,
    );
  });

  test('hint drift mid-turn → no reload (fold into the running turn)', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    p.inFlight = true;
    assert.equal(
      p.wouldReloadFor({ model: 'opus', effort: 'high', displayHint: 'HINT B' }),
      false,
    );
  });

  test('hint drift on a closed proc → no reload', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    p.closed = true;
    assert.equal(
      p.wouldReloadFor({ model: 'opus', effort: 'high', displayHint: 'HINT B' }),
      false,
    );
  });

  test('same hint → warm proc is reused', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    assert.equal(
      p.wouldReloadFor({ model: 'opus', effort: 'high', displayHint: 'HINT A' }),
      false,
    );
  });

  test('spawnContext without displayHint (older consumer) never trips on the hint', () => {
    // A consumer on an older build sends no displayHint at all. undefined must
    // not read as "drifted to empty" — that would respawn every session on
    // every message.
    const p = cliProc({ displayHint: 'HINT A' });
    assert.equal(p.wouldReloadFor({ model: 'opus', effort: 'high' }), false);
    assert.equal(
      p.wouldReloadFor({ model: 'opus', effort: 'high', displayHint: null }),
      false,
    );
  });

  test('model/effort drift still reloads, and does so independently of the hint', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    assert.equal(
      p.wouldReloadFor({ model: 'sonnet', effort: 'high', displayHint: 'HINT A' }),
      true,
    );
    assert.equal(
      p.wouldReloadFor({ model: 'opus', effort: 'low', displayHint: 'HINT A' }),
      true,
    );
  });
});

describe('CliProcess.reloadReasonsFor — soak telemetry', () => {
  test('names the drifted dimension', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    assert.deepEqual(
      p.reloadReasonsFor({ model: 'opus', effort: 'high', displayHint: 'HINT B' }),
      ['display-hint'],
    );
    assert.deepEqual(
      p.reloadReasonsFor({ model: 'sonnet', effort: 'high', displayHint: 'HINT A' }),
      ['model'],
    );
  });

  test('lists every drifted dimension at once', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    assert.deepEqual(
      p.reloadReasonsFor({ model: 'sonnet', effort: 'low', displayHint: 'HINT B' }),
      ['model', 'effort', 'display-hint'],
    );
  });

  test('no drift / not idle → empty', () => {
    const p = cliProc({ displayHint: 'HINT A' });
    assert.deepEqual(
      p.reloadReasonsFor({ model: 'opus', effort: 'high', displayHint: 'HINT A' }),
      [],
    );
    p.inFlight = true;
    assert.deepEqual(
      p.reloadReasonsFor({ model: 'opus', effort: 'high', displayHint: 'HINT B' }),
      [],
    );
  });
});

// ── Full path: getOrSpawn kills the stale proc and the respawn carries the new
//    hint, because the factory re-resolves the consumer's hint per spawn. ──

class HintProcess extends Process {
  constructor(opts) {
    super(opts);
    this.backend = 'mock';
    this.displayHint = opts.displayHint ?? '';
    this.killReasons = [];
  }
  get cost() { return 1; }
  async start(opts) {
    this.model = this._resolveModel(opts);
    this.effort = this._resolveEffort(opts);
  }
  async send() { return { text: '', sessionId: null, cost: 0, duration: 0, error: null, metrics: {} }; }
  async kill(reason) {
    this.killReasons.push(reason);
    this.closed = true;
    this.emit('close', { reason });
  }
  drainQueue() { return 0; }
}
// Borrow the real drift logic — the point of this test is the manager path, not
// a second implementation of the comparison.
for (const m of ['wouldReloadFor', 'reloadReasonsFor', '_resolveModel', '_resolveEffort']) {
  HintProcess.prototype[m] = CliProcess.prototype[m];
}

function hintManager() {
  const events = [];
  const spawns = [];
  // Mirrors factory.js: the consumer registers a resolver, and it is called
  // fresh on every spawn with the current config — so a hint that changed while
  // the old proc was warm lands on the new one without anyone passing it along.
  const state = { hint: 'HINT A' };
  const pm = new ProcessManager({
    processFactory: (sessionKey, ctx) => {
      const p = new HintProcess({
        sessionKey,
        chatId: ctx?.chatId,
        displayHint: state.hint,
      });
      spawns.push(p);
      return p;
    },
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    logger: quietLogger,
  });
  return { pm, events, spawns, state };
}

describe('ProcessManager.getOrSpawn — display-hint drift respawns through the factory', () => {
  test('stale hint → kill(config-reload) + fresh proc resolved with the new hint', async () => {
    const { pm, events, spawns, state } = hintManager();
    const ctx = { chatId: '42', model: 'opus', effort: 'high', displayHint: 'HINT A' };
    const first = await pm.getOrSpawn('sk', ctx);
    assert.equal(first.displayHint, 'HINT A');

    // The chat toggles rich text: the consumer's resolver now yields HINT B, and
    // the next message's spawn context carries it.
    state.hint = 'HINT B';
    const second = await pm.getOrSpawn('sk', { ...ctx, displayHint: 'HINT B' });

    assert.notEqual(second, first, 'a fresh proc must replace the stale one');
    assert.deepEqual(first.killReasons, ['config-reload'],
      'kill reason must stay config-reload — it is what preserves the session id for --resume');
    assert.equal(second.displayHint, 'HINT B',
      'the respawn must pick the hint up from the factory resolver');
    assert.equal(spawns.length, 2);

    const reload = events.find(e => e.kind === 'cli-config-reload');
    assert.ok(reload, 'reload must be logged');
    assert.equal(reload.detail.reason, 'display-hint',
      'soak needs to tell a toggle-driven reload from a /model one');
  });

  test('unchanged hint → the warm proc is reused', async () => {
    const { pm, spawns } = hintManager();
    const ctx = { chatId: '42', model: 'opus', effort: 'high', displayHint: 'HINT A' };
    const first = await pm.getOrSpawn('sk', ctx);
    const second = await pm.getOrSpawn('sk', { ...ctx });
    assert.equal(second, first);
    assert.equal(spawns.length, 1);
    assert.deepEqual(first.killReasons, []);
  });

  test('model drift keeps logging reason:model', async () => {
    const { pm, events } = hintManager();
    const ctx = { chatId: '42', model: 'opus', effort: 'high', displayHint: 'HINT A' };
    await pm.getOrSpawn('sk', ctx);
    await pm.getOrSpawn('sk', { ...ctx, model: 'sonnet' });
    const reload = events.find(e => e.kind === 'cli-config-reload');
    assert.equal(reload.detail.reason, 'model');
  });
});
