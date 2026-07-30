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
const { createProcessFactory } = require('../lib/process/factory');
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

describe('CliProcess displayHint normalization', () => {
  // The comparison is `!==` against a string, so a non-string field is drift
  // that can never be resolved: a resolver returning null would leave the proc
  // holding null, and every context carrying '' would respawn it again.
  test('a non-string hint is stored as the empty string', () => {
    for (const hint of [null, undefined, 0, false]) {
      const p = new CliProcess({
        sessionKey: 'sk',
        chatId: '42',
        tmuxRunner: fakeRunner,
        botName: 'testbot',
        claudeBin: '/usr/bin/echo',
        toolDispatcher: fakeDispatcher,
        displayHint: hint,
        logger: quietLogger,
      });
      assert.equal(p.displayHint, '');
    }
  });

  test('a proc spawned from a null-returning resolver is not permanently drifted', () => {
    const p = cliProc({ displayHint: null });
    assert.equal(
      p.wouldReloadFor({ model: 'opus', effort: 'high', displayHint: '' }),
      false,
    );
  });
});

// ── Through the REAL factory: the hint the reload compared against is the hint
//    the respawn carries — no second source that can disagree. ──

const factoryDeps = {
  config: { chats: {} },
  tmuxRunner: fakeRunner,
  botName: 'testbot',
  toolDispatcher: fakeDispatcher,
  channelsClaudeBin: '/usr/bin/echo',
  logger: quietLogger,
  pmDefault: 'cli',
};

describe('createProcessFactory — the spawn context owns the hint', () => {
  test('a context hint is used verbatim, even when the resolver disagrees', () => {
    const factory = createProcessFactory({
      ...factoryDeps,
      displayHint: () => 'RESOLVER HINT',
    });
    const proc = factory('sk', { chatId: '42', displayHint: 'CONTEXT HINT' });
    assert.equal(proc.displayHint, 'CONTEXT HINT');
  });

  test('no context hint → the resolver still supplies it (older consumers)', () => {
    const seen = [];
    const factory = createProcessFactory({
      ...factoryDeps,
      displayHint: (chatId, threadId, config) => {
        seen.push({ chatId, threadId, hasConfig: config != null });
        return 'RESOLVER HINT';
      },
    });
    const proc = factory('sk', { chatId: '42', threadId: '7' });
    assert.equal(proc.displayHint, 'RESOLVER HINT');
    assert.deepEqual(seen, [{ chatId: '42', threadId: '7', hasConfig: true }]);
  });

  test('a static string hint still applies to every session', () => {
    const factory = createProcessFactory({ ...factoryDeps, displayHint: 'STATIC' });
    assert.equal(factory('sk', { chatId: '42' }).displayHint, 'STATIC');
  });

  test('a non-string context hint falls back to the resolver', () => {
    const factory = createProcessFactory({
      ...factoryDeps,
      displayHint: () => 'RESOLVER HINT',
    });
    assert.equal(
      factory('sk', { chatId: '42', displayHint: null }).displayHint,
      'RESOLVER HINT',
    );
  });
});

describe('ProcessManager + the real factory — a toggle respawns exactly once', () => {
  // The treadmill this guards: apply-path and detect-path reading different
  // sources. If the respawned proc got the resolver's string while the reload
  // compared against the context's, a one-character disagreement would respawn
  // the session on every message, forever.
  function realFactoryManager({ resolverHint }) {
    const events = [];
    const spawned = [];
    const killed = [];
    const factory = createProcessFactory({
      ...factoryDeps,
      displayHint: () => resolverHint,
    });
    const pm = new ProcessManager({
      processFactory: (sessionKey, ctx) => {
        const proc = factory(sessionKey, ctx);
        // The hint is fixed by construction; tmux spawn and teardown are not
        // what this test is about.
        proc.start = async () => {
          proc.model = proc._resolveModel(ctx);
          proc.effort = proc._resolveEffort(ctx);
        };
        proc.kill = async (reason) => {
          killed.push(reason);
          proc.closed = true;
          proc.emit('close', { reason });
        };
        spawned.push(proc);
        return proc;
      },
      db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
      logger: quietLogger,
    });
    return { pm, events, spawned, killed };
  }

  test('the respawn carries the context hint the reload compared against', async () => {
    const fleet = realFactoryManager({ resolverHint: 'RESOLVER DISAGREES' });
    const ctx = { chatId: '42', model: 'opus', effort: 'high', displayHint: 'HINT A' };
    await fleet.pm.getOrSpawn('sk', ctx);

    const toggled = { ...ctx, displayHint: 'HINT B' };
    const second = await fleet.pm.getOrSpawn('sk', toggled);
    assert.deepEqual(fleet.killed, ['config-reload']);
    assert.equal(second.displayHint, 'HINT B',
      'the resolver must not overwrite the hint the drift check just accepted');

    // The treadmill test: the same context again must reuse the warm proc.
    const third = await fleet.pm.getOrSpawn('sk', toggled);
    assert.equal(third, second, 'a settled toggle must not respawn again');
    assert.equal(fleet.spawned.length, 2, 'exactly two spawns for one toggle');
    assert.deepEqual(fleet.killed, ['config-reload']);
  });

  test('an unchanged chat never respawns, whatever the resolver would return', async () => {
    const fleet = realFactoryManager({ resolverHint: 'RESOLVER DISAGREES' });
    const ctx = { chatId: '42', model: 'opus', effort: 'high', displayHint: 'HINT A' };
    for (let i = 0; i < 5; i++) await fleet.pm.getOrSpawn('sk', ctx);
    assert.equal(fleet.spawned.length, 1);
    assert.deepEqual(fleet.killed, []);
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
  // Mirrors factory.js: the spawn context's hint wins, and the consumer's
  // resolver — called fresh per spawn with the current config — is the fallback
  // for a context that carries none.
  const state = { hint: 'HINT A' };
  const pm = new ProcessManager({
    processFactory: (sessionKey, ctx) => {
      const p = new HintProcess({
        sessionKey,
        chatId: ctx?.chatId,
        displayHint: typeof ctx?.displayHint === 'string' ? ctx.displayHint : state.hint,
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
    assert.equal(reload.detail.from_hint_hash, undefined,
      'hint fingerprints belong only to a hint reload');
    assert.equal(reload.detail.to_hint_hash, undefined);
  });

  test('a hint reload logs fingerprints, never hint bodies', async () => {
    // A treadmill (respawn per message) and a real toggle look identical in the
    // soak without something to compare across reloads. Fingerprints, because
    // the hint is a multi-KB system-prompt block and the events table has no
    // retention — the 4GB shumabit.db bloat is what unbounded detail costs.
    const { pm, events } = hintManager();
    const ctx = { chatId: '42', model: 'opus', effort: 'high', displayHint: 'HINT A' };
    await pm.getOrSpawn('sk', ctx);
    await pm.getOrSpawn('sk', { ...ctx, displayHint: 'HINT B' });

    const reload = events.find(e => e.kind === 'cli-config-reload');
    assert.equal(reload.detail.reason, 'display-hint');
    assert.match(reload.detail.from_hint_hash, /^[0-9a-f]{8}$/);
    assert.match(reload.detail.to_hint_hash, /^[0-9a-f]{8}$/);
    assert.notEqual(reload.detail.from_hint_hash, reload.detail.to_hint_hash);
    const serialized = JSON.stringify(reload.detail);
    assert.doesNotMatch(serialized, /HINT A|HINT B/, 'no hint body may be stored');
  });

  test('the same hint always fingerprints the same, so a treadmill is visible', async () => {
    const { pm, events } = hintManager();
    const ctx = { chatId: '42', model: 'opus', effort: 'high', displayHint: 'HINT A' };
    await pm.getOrSpawn('sk', ctx);
    await pm.getOrSpawn('sk', { ...ctx, displayHint: 'HINT B' });
    await pm.getOrSpawn('sk', { ...ctx, displayHint: 'HINT A' });

    const reloads = events.filter(e => e.kind === 'cli-config-reload');
    assert.equal(reloads.length, 2);
    assert.equal(reloads[0].detail.from_hint_hash, reloads[1].detail.to_hint_hash,
      'the same hint string must fingerprint identically across reloads');
  });
});
