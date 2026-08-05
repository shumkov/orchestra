'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ProcessManager } = require('../lib/process/process-manager');
const { Process, UnsupportedOperationError } = require('../lib/process/process');

// ── Mock Process ─────────────────────────────────────────────────────

class MockProcess extends Process {
  constructor(opts, mockOpts = {}) {
    super(opts);
    this.backend = mockOpts.backend || 'mock';
    this._cost = mockOpts.cost ?? 1;
    this._startSpy = [];
    this._killSpy = [];
    this._sendSpy = [];
    this._sendResult = mockOpts.sendResult ?? { text: 'mock reply', sessionId: null, cost: 0, duration: 0, error: null, metrics: {} };
    this._failStart = mockOpts.failStart;
    this._supports = new Set(mockOpts.supports || ['interrupt', 'setModel', 'applyFlagSettings', 'resetSession']);
  }
  get cost() { return this._cost; }
  async start(opts) {
    this._startSpy.push(opts);
    if (this._failStart) throw this._failStart;
  }
  async send(prompt, opts) {
    this.inFlight = true;
    this._sendSpy.push({ prompt, opts });
    this.inFlight = false;
    return this._sendResult;
  }
  async kill(reason) {
    this._killSpy.push(reason);
    this.closed = true;
    this.emit('close', { reason });
  }
  async interrupt() {
    if (!this._supports.has('interrupt')) throw new UnsupportedOperationError('interrupt', this.backend);
    return true;
  }
  async steerTurn(text, opts) {
    if (!this._supports.has('steerTurn')) throw new UnsupportedOperationError('steerTurn', this.backend);
    this._steerTurnSpy ??= [];
    this._steerTurnSpy.push({ text, opts });
    return { outcome: 'accepted', turnId: 'turn-mock' };
  }
  async setModel(model) {
    if (!this._supports.has('setModel')) throw new UnsupportedOperationError('setModel', this.backend);
    return true;
  }
  async applyFlagSettings(s) {
    if (!this._supports.has('applyFlagSettings')) throw new UnsupportedOperationError('applyFlagSettings', this.backend);
    return true;
  }
  async resetSession(opts) {
    if (!this._supports.has('resetSession')) throw new UnsupportedOperationError('resetSession', this.backend);
    return { closed: true, drainedPendings: 0 };
  }
  drainQueue(code) {
    const n = this.pendingQueue.length;
    this.pendingQueue.length = 0;
    return n;
  }
  injectUserMessage(opts) {
    return this.inFlight;
  }
  emitInit() { this.emit('init', { sessionId: 'sess-1' }); }
  emitClose() { this.emit('close', { reason: 'test' }); }
  emitResult(payload) { this.emit('result', payload); }
}

function mockFactory(opts = {}) {
  return (sessionKey, ctx) => new MockProcess({ sessionKey, chatId: ctx?.chatId, threadId: ctx?.threadId }, opts);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ProcessManager — construction', () => {
  test('requires processFactory', () => {
    assert.throws(() => new ProcessManager({}), /processFactory/);
  });
  test('default budget = 10', () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    assert.equal(pm.budget, 10);
  });
});

describe('ProcessManager — introspection', () => {
  let pm;
  beforeEach(() => { pm = new ProcessManager({ processFactory: mockFactory() }); });

  test('has/get/keys/size on empty pm', () => {
    assert.equal(pm.has('sk'), false);
    assert.equal(pm.get('sk'), null);
    assert.deepEqual(pm.keys(), []);
    assert.equal(pm.size, 0);
  });

  test('after getOrSpawn', async () => {
    await pm.getOrSpawn('sk', { chatId: 1 });
    assert.equal(pm.has('sk'), true);
    assert.ok(pm.get('sk'));
    assert.deepEqual(pm.keys(), ['sk']);
    assert.equal(pm.size, 1);
  });
});

describe('ProcessManager — getOrSpawn', () => {
  test('factory called once per fresh sessionKey', async () => {
    let calls = 0;
    const pm = new ProcessManager({
      processFactory: (sk, ctx) => { calls++; return new MockProcess({ sessionKey: sk }); },
    });
    await pm.getOrSpawn('sk1');
    await pm.getOrSpawn('sk1');  // cache hit
    assert.equal(calls, 1);
  });

  test('returns same instance on cache hit', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const p1 = await pm.getOrSpawn('sk');
    const p2 = await pm.getOrSpawn('sk');
    assert.equal(p1, p2);
  });

  test('calls start() with spawn context', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk', { chatId: 100, model: 'sonnet' });
    const p = pm.get('sk');
    assert.deepEqual(p._startSpy[0], { chatId: 100, model: 'sonnet' });
  });

  test('start() failure does NOT add to procs map', async () => {
    const failFactory = (sk, ctx) => new MockProcess({ sessionKey: sk }, { failStart: new Error('boom') });
    const pm = new ProcessManager({ processFactory: failFactory });
    await assert.rejects(() => pm.getOrSpawn('sk'), /boom/);
    assert.equal(pm.has('sk'), false);
  });
});

describe('ProcessManager — getOrSpawn concurrent spawn (production 2026-05-16)', () => {
  // Production bug, shumorobot 2026-05-16 09:24: Ivan sent three
  // messages ~2s apart on a freshly-spawned tmux session. getOrSpawn
  // registers the proc in this.procs BEFORE awaiting start(); a
  // second message arriving during the ~11s spawn got the
  // still-spawning proc and called send() on it — pasting a turn
  // into a TUI that was not ready. The paste was silently dropped,
  // and the turn returned empty → "No response generated. Please
  // try again." The JSONL recorded only the first message's turn.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('second getOrSpawn during an in-flight spawn waits for start() to complete', async () => {
    let releaseStart;
    const startGate = new Promise((r) => { releaseStart = r; });
    let startCompleted = false;

    class SlowStartProc extends MockProcess {
      async start(opts) {
        this._startSpy.push(opts);
        await startGate;
        startCompleted = true;
      }
    }
    const pm = new ProcessManager({
      processFactory: (sk) => new SlowStartProc({ sessionKey: sk }),
    });

    const call1 = pm.getOrSpawn('sk');   // triggers the spawn
    const call2 = pm.getOrSpawn('sk');   // arrives DURING the spawn

    let call2Resolved = false;
    call2.then(() => { call2Resolved = true; }, () => {});

    // Let microtasks + timers settle. On the buggy code call2
    // returns `existing` immediately; on the fix it awaits start().
    await sleep(20);
    assert.equal(call2Resolved, false,
      'getOrSpawn during an in-flight spawn must NOT resolve before start() completes');

    releaseStart();
    const [p1, p2] = await Promise.all([call1, call2]);
    assert.equal(p1, p2, 'both callers receive the same proc');
    assert.equal(startCompleted, true,
      'start() must have completed before getOrSpawn returned the proc');
  });

  test('start() is called exactly once under concurrent getOrSpawn', async () => {
    let releaseStart;
    const startGate = new Promise((r) => { releaseStart = r; });
    let startCalls = 0;

    class SlowStartProc extends MockProcess {
      async start(opts) {
        startCalls += 1;
        this._startSpy.push(opts);
        await startGate;
      }
    }
    let factoryCalls = 0;
    const pm = new ProcessManager({
      processFactory: (sk) => { factoryCalls += 1; return new SlowStartProc({ sessionKey: sk }); },
    });

    const calls = [
      pm.getOrSpawn('sk'),
      pm.getOrSpawn('sk'),
      pm.getOrSpawn('sk'),
    ];
    await sleep(20);
    releaseStart();
    await Promise.all(calls);

    assert.equal(factoryCalls, 1, 'factory called once for the same sessionKey');
    assert.equal(startCalls, 1, 'start() called once for the same sessionKey');
  });
});

describe('ProcessManager — weighted LRU eviction', () => {
  test('SDK cost=1, default budget=10 → 10 fit', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    assert.equal(pm.size, 10);
    assert.equal(pm.totalCost, 10);
  });

  test('11th SDK Process triggers eviction', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    // 11th — should evict oldest (sk0)
    await pm.getOrSpawn('sk10');
    assert.equal(pm.size, 10);
    assert.equal(pm.has('sk0'), false);
    assert.equal(pm.has('sk10'), true);
  });

  test('tmux cost=3 → 3 fit, 4th evicts', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 3 }) });
    for (let i = 0; i < 3; i++) await pm.getOrSpawn('sk' + i);
    assert.equal(pm.totalCost, 9);
    await pm.getOrSpawn('sk3');   // would push to 12 > 10
    assert.equal(pm.size, 3);
    assert.equal(pm.has('sk0'), false);
  });

  test('mixed: 7 SDK + 1 tmux = 10 (full)', async () => {
    let n = 0;
    const pm = new ProcessManager({
      processFactory: (sk, ctx) => {
        const cost = n++ < 7 ? 1 : 3;
        return new MockProcess({ sessionKey: sk }, { cost });
      },
    });
    for (let i = 0; i < 8; i++) await pm.getOrSpawn('sk' + i);
    assert.equal(pm.totalCost, 7 * 1 + 1 * 3);
    assert.equal(pm.size, 8);
  });

  test('inFlight processes are NOT evicted', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    // Mark sk0 inFlight
    pm.get('sk0').inFlight = true;
    // sk1 should evict (next oldest, not inFlight)
    await pm.getOrSpawn('sk10');
    assert.equal(pm.has('sk0'), true);
    assert.equal(pm.has('sk1'), false);
  });

  test('all-inFlight pm parks new spawn until slot frees', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), lruWaitMs: 200 });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    for (const p of pm.procs.values()) p.inFlight = true;
    const spawnP = pm.getOrSpawn('skNew');
    // Free a slot
    setTimeout(() => { pm.get('sk0').inFlight = false; pm._maybeSignalLruWaiter(); }, 30);
    await spawnP;
    assert.equal(pm.has('skNew'), true);
  });

  test('idle cache-hit lifecycle gate cleanup wakes a concurrent spawn waiter', async () => {
    const pm = new ProcessManager({
      processFactory: mockFactory({ cost: 1 }),
      budget: 1,
      lruWaitMs: 100,
    });
    const first = await pm.getOrSpawn('first');
    const cacheHit = pm.getOrSpawn('first');
    const second = pm.getOrSpawn('second');
    assert.equal(await cacheHit, first);
    await second;
    assert.equal(pm.has('first'), false);
    assert.equal(pm.has('second'), true);
  });

  test('noWaitForCapacity rejects immediately instead of parking behind in-flight work', async () => {
    const pm = new ProcessManager({
      processFactory: mockFactory({ cost: 1 }),
      budget: 1,
    });
    const active = await pm.getOrSpawn('active');
    active.inFlight = true;
    pm._awaitLruSlot = () => {
      throw new Error('no-wait admission must not park');
    };

    await assert.rejects(
      pm.getOrSpawn('recovery', { noWaitForCapacity: true }),
      (error) => error.code === 'PROCESS_ADMISSION_UNAVAILABLE',
    );
    assert.equal(pm.has('recovery'), false);
    assert.equal(pm.get('active'), active);
  });

  test('noWaitForCapacity rejects rather than soft-overflowing a pinned process', async () => {
    const pm = new ProcessManager({
      processFactory: mockFactory({ cost: 1 }),
      budget: 1,
    });
    const pinned = await pm.getOrSpawn('pinned');
    pinned.hasActiveBackgroundWork = () => true;

    await assert.rejects(
      pm.getOrSpawn('recovery', { noWaitForCapacity: true }),
      (error) => error.code === 'PROCESS_ADMISSION_UNAVAILABLE',
    );
    assert.equal(pm.has('recovery'), false);
    assert.equal(pm.get('pinned'), pinned);
    assert.equal(pm.totalCost, 1);
  });
});

describe('ProcessManager — eviction-pin for live background work (Policy C)', () => {
  // A Process reports active detached background work (the cli `_bgWorkSince` signal).
  const pin = (p) => { p.hasActiveBackgroundWork = () => true; };

  test('_evictLRU skips a pinned session and evicts the next-oldest UNpinned one', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    pin(pm.get('sk0'));                       // oldest — but holds a live background job
    await pm.getOrSpawn('sk10');              // budget full → must evict
    assert.equal(pm.has('sk0'), true, 'pinned oldest survives');
    assert.equal(pm.has('sk1'), false, 'next-oldest unpinned evicted instead');
    assert.equal(pm.has('sk10'), true);
    assert.equal(pm.size, 10, 'still at budget — evicted, not overflowed');
  });

  test('the UNpinned session is evicted even when the pinned one is OLDER', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), budget: 2 });
    await pm.getOrSpawn('old');
    await pm.getOrSpawn('young');
    pin(pm.get('old'));
    await pm.getOrSpawn('new');
    assert.equal(pm.has('old'), true, 'older pinned survives');
    assert.equal(pm.has('young'), false, 'younger unpinned evicted');
    assert.equal(pm.has('new'), true);
  });

  test('Policy C: all free slots pinned → spawns OVER budget, emits lru-overflow-pinned, no job killed', async () => {
    const events = [];
    const pm = new ProcessManager({
      processFactory: mockFactory({ cost: 1 }), budget: 2,
      db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    });
    await pm.getOrSpawn('bg0'); await pm.getOrSpawn('bg1');
    pin(pm.get('bg0')); pin(pm.get('bg1'));   // every free slot holds a live job
    await pm.getOrSpawn('fresh');             // can't evict a job → soft overflow
    assert.equal(pm.has('bg0'), true);
    assert.equal(pm.has('bg1'), true, 'no background job killed');
    assert.equal(pm.has('fresh'), true, 'the new chat is not blocked');
    assert.equal(pm.size, 3);
    assert.equal(pm.totalCost, 3, 'spawned over the budget of 2 (soft overflow)');
    const ov = events.find((e) => e.kind === 'lru-overflow-pinned');
    assert.ok(ov, 'lru-overflow-pinned emitted');
    assert.deepEqual(ov.detail.pinned.sort(), ['bg0', 'bg1'], 'names the pinned sessions so the operator can /reset one');
  });

  test('park-split: all blockers inFlight (NO pin) → parks (times out), does NOT overflow', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), budget: 2, lruWaitMs: 80 });
    await pm.getOrSpawn('sk0'); await pm.getOrSpawn('sk1');
    pm.get('sk0').inFlight = true; pm.get('sk1').inFlight = true;   // transient blockers, no bg work
    await assert.rejects(pm.getOrSpawn('sk2'), /lru wait timed out/);
    assert.equal(pm.size, 2, 'parked for a slot — did NOT overflow the budget');
  });

  test('end-to-end: over budget with one pinned + one unpinned evicts the unpinned, keeps the background job', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), budget: 2 });
    await pm.getOrSpawn('job');                // the long background job (older)
    await pm.getOrSpawn('idle');               // a plain idle chat (younger)
    pin(pm.get('job'));
    await pm.getOrSpawn('new');
    assert.equal(pm.has('job'), true, 'background-job session survives eviction');
    assert.equal(pm.has('idle'), false, 'idle session evicted instead');
    assert.equal(pm.size, 2, 'evicted (not overflowed) — a free unpinned slot existed');
  });
});

describe('ProcessManager — delivery-work eviction pin', () => {
  test('pending delivery work is not evicted and settlement wakes a parked waiter', async () => {
    const pm = new ProcessManager({
      processFactory: mockFactory({ cost: 1 }),
      budget: 1,
      lruWaitMs: 200,
    });
    const pinned = await pm.getOrSpawn('workflow');
    let pending = true;
    pinned.hasPendingDeliveryWork = () => pending;

    assert.equal(pm._evictLRU(), false);
    assert.deepEqual(pm._pinnedSessionKeys(), ['workflow']);

    let woke = false;
    const waiter = pm._awaitLruSlot().then(() => { woke = true; });
    pending = false;
    pinned.emit('delivery-work-settled');
    await waiter;
    assert.equal(woke, true);
  });
});

describe('ProcessManager — kill / killChat / shutdown', () => {
  test('clean retirement captures an active session before an unrelated spawn gate settles', async () => {
    const spawnEntered = deferred();
    const releaseSpawn = deferred();
    class SlowStartProcess extends MockProcess {
      async start(opts) {
        this._startSpy.push(opts);
        spawnEntered.resolve();
        await releaseSpawn.promise;
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => (
        sessionKey === 'slow'
          ? new SlowStartProcess({ sessionKey })
          : new MockProcess({ sessionKey })
      ),
    });
    const active = await pm.getOrSpawn('active');
    const slowSpawn = pm.getOrSpawn('slow');
    await spawnEntered.promise;

    const retirement = pm.retireForCleanRestart({
      getDeliveryEvidence: async () => ({
        outputAttempted: false,
        pending: 0,
        fenced: true,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(
      active._killSpy,
      ['clean-restart'],
      'an unrelated unresolved spawn must not delay active-session retirement',
    );

    releaseSpawn.resolve();
    await Promise.allSettled([slowSpawn, retirement]);
    assert.deepEqual(active._killSpy, ['clean-restart']);
  });

  test('clean retirement closes every public lifecycle-gate entry after the fence', async () => {
    const retirementEntered = deferred();
    const releaseRetirement = deferred();
    class HoldingProcess extends MockProcess {
      async retireForCleanRestart(options) {
        retirementEntered.resolve();
        await releaseRetirement.promise;
        return super.retireForCleanRestart(options);
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey, ctx) => new HoldingProcess({
        sessionKey,
        chatId: ctx?.chatId,
      }),
    });
    await pm.getOrSpawn('active', { chatId: 'active' });
    const expectedProcess = pm.get('active');
    const retirement = pm.retireForCleanRestart({
      getDeliveryEvidence: async () => ({
        outputAttempted: false,
        pending: 0,
        fenced: true,
      }),
    });
    await retirementEntered.promise;

    await assert.rejects(pm.getOrSpawn('new'), /shutdown/);
    await assert.rejects(pm.kill('active'), /shutdown/);
    await assert.rejects(
      pm.retireExpectedProcess('active', expectedProcess),
      /shutdown/,
    );
    await assert.rejects(pm.getModelSettingsStatus('active'), /shutdown/);
    await assert.rejects(
      pm.selectModelSettings('active', { model: 'm', effort: 'e' }),
      /shutdown/,
    );
    await assert.rejects(
      pm.replaceRuntime('active', { runtime: 'claude', spawnProfileId: 'new' }),
      /shutdown/,
    );
    await assert.rejects(pm.resetSession('active'));
    const killChatResults = await pm.killChat('active');
    assert.equal(killChatResults.length, 1);
    assert.equal(killChatResults[0].status, 'rejected');
    assert.equal(pm._lifecycleGates.has('active'), false);

    releaseRetirement.resolve();
    await retirement;
  });

  test('clean retirement fence rejects public interrupt without reaching the process', async () => {
    const retirementEntered = deferred();
    const releaseRetirement = deferred();
    class HoldingProcess extends MockProcess {
      async retireForCleanRestart(options) {
        retirementEntered.resolve();
        await releaseRetirement.promise;
        return super.retireForCleanRestart(options);
      }

      async interrupt() {
        this.interruptCount = (this.interruptCount ?? 0) + 1;
        return true;
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new HoldingProcess({ sessionKey }),
    });
    const proc = await pm.getOrSpawn('active');
    const retirement = pm.retireForCleanRestart({
      getDeliveryEvidence: async () => ({
        outputAttempted: false,
        pending: 0,
        fenced: true,
      }),
    });
    await retirementEntered.promise;

    const [interruptResult] = await Promise.allSettled([pm.interrupt('active')]);
    releaseRetirement.resolve();
    await retirement;

    assert.equal(interruptResult.status, 'rejected');
    assert.match(interruptResult.reason.message, /shutdown/);
    assert.equal(proc.interruptCount ?? 0, 0);
  });

  test('clean retirement retires a process published by an admitted gate that rejects', async () => {
    const startEntered = deferred();
    const releaseStart = deferred();
    const startError = new Error('admitted start failed');
    class RejectingStartProcess extends MockProcess {
      async start(opts) {
        this._startSpy.push(opts);
        startEntered.resolve();
        await releaseStart.promise;
        throw startError;
      }

      async retireForCleanRestart() {
        this._killSpy.push('clean-restart');
        this.closed = true;
        return { sourceMsgId: null, eligible: false, reason: 'no-active-turn' };
      }
    }
    const proc = new RejectingStartProcess({ sessionKey: 'same-session' });
    const pm = new ProcessManager({ processFactory: () => proc });
    const start = pm.getOrSpawn('same-session');
    await startEntered.promise;

    const retirement = pm.retireForCleanRestart({
      getDeliveryEvidence: async () => ({
        outputAttempted: false,
        pending: 0,
        fenced: true,
      }),
    });
    releaseStart.resolve();

    await assert.rejects(start, /admitted start failed/);
    await assert.rejects(retirement, /admitted start failed/);
    assert.deepEqual(proc._killSpy, ['clean-restart']);
    assert.equal(pm._cleanRetirementCandidates.has('same-session'), false);
  });

  test('failed clean retirement retains an admitted rejecting start for fallback shutdown', async () => {
    const startEntered = deferred();
    const releaseStart = deferred();
    class RejectingStartProcess extends MockProcess {
      async start(opts) {
        this._startSpy.push(opts);
        startEntered.resolve();
        await releaseStart.promise;
        throw new Error('admitted start failed');
      }

      async retireForCleanRestart() {
        this._killSpy.push('clean-restart');
        throw Object.assign(new Error('clean retirement failed'), {
          code: 'CLEAN_RESTART_RETIREMENT_FAILED',
        });
      }
    }
    const proc = new RejectingStartProcess({ sessionKey: 'same-session' });
    const pm = new ProcessManager({ processFactory: () => proc });
    const start = pm.getOrSpawn('same-session');
    await startEntered.promise;

    const retirement = pm.retireForCleanRestart({
      getDeliveryEvidence: async () => ({
        outputAttempted: false,
        pending: 0,
        fenced: true,
      }),
    });
    releaseStart.resolve();

    await assert.rejects(start, /admitted start failed/);
    await assert.rejects(retirement, /admitted start failed/);
    assert.equal(proc.closed, false);
    assert.equal(pm.get('same-session'), proc);

    await pm.shutdown();

    assert.deepEqual(proc._killSpy, ['clean-restart', 'shutdown']);
    assert.equal(proc.closed, true);
    assert.equal(pm.has('same-session'), false);
    assert.equal(pm._cleanRetirementCandidates.has('same-session'), false);
  });

  test('retireForCleanRestart fences, strictly retires every process, and returns per-session snapshots', async () => {
    const calls = [];
    class RetiringProcess extends MockProcess {
      constructor(opts, { backend, snapshot }) {
        super(opts, { backend });
        this.snapshot = snapshot;
      }
      async retireForCleanRestart({ getDeliveryEvidence }) {
        calls.push(`retire:${this.sessionKey}`);
        const sourceMsgId = this.snapshot.sourceMsgId ?? null;
        const deliveryEvidence = await getDeliveryEvidence(this.sessionKey, sourceMsgId);
        this.closed = true;
        return { ...this.snapshot, deliveryEvidence };
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new RetiringProcess(
        { sessionKey },
        sessionKey === 'cli'
          ? {
            backend: 'cli',
            snapshot: {
              sessionKey,
              sourceMsgId: 42,
              eligible: true,
              reason: 'eligible',
            },
          }
          : {
            backend: 'sdk',
            snapshot: {
              sessionKey,
              sourceMsgId: 99,
              eligible: true,
              reason: 'eligible',
            },
          },
      ),
    });
    await pm.getOrSpawn('cli');
    await pm.getOrSpawn('sdk');

    const snapshots = await pm.retireForCleanRestart({
      getDeliveryEvidence: async (sessionKey, sourceMsgId) => {
        calls.push(`evidence:${sessionKey}:${sourceMsgId ?? 'null'}`);
        return { safe: sessionKey === 'cli' };
      },
    });

    assert.equal(pm.size, 0);
    assert.deepEqual(calls.sort(), [
      'evidence:cli:42',
      'evidence:sdk:null',
      'retire:cli',
      'retire:sdk',
    ]);
    assert.deepEqual(snapshots, [
      {
        sessionKey: 'cli',
        sourceMsgId: 42,
        eligible: true,
        reason: 'eligible',
      },
      {
        sessionKey: 'sdk',
        sourceMsgId: null,
        eligible: false,
        reason: 'unsupported-backend',
      },
    ]);
  });

  test('retireForCleanRestart propagates strict retirement failure and returns no snapshots', async () => {
    class FailedRetirementProcess extends MockProcess {
      async retireForCleanRestart() {
        throw Object.assign(new Error('bridge close uncertain'), {
          code: 'CLEAN_RESTART_RETIREMENT_FAILED',
        });
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new FailedRetirementProcess({ sessionKey }),
    });
    await pm.getOrSpawn('cli');

    await assert.rejects(
      pm.retireForCleanRestart({
        getDeliveryEvidence: async () => ({
          outputAttempted: false,
          pending: 0,
          fenced: true,
        }),
      }),
      (error) => error.code === 'CLEAN_RESTART_RETIREMENT_FAILED',
    );
  });

  test('retireForCleanRestart still retires every process after an admitted lifecycle failure', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const first = await pm.getOrSpawn('first');
    const second = await pm.getOrSpawn('second');
    pm._lifecycleGates.set('failed-gate', Promise.reject(new Error('admitted failed')));

    await assert.rejects(
      pm.retireForCleanRestart({
        getDeliveryEvidence: async () => ({
          outputAttempted: false,
          pending: 0,
          fenced: true,
        }),
      }),
      /admitted failed/,
    );

    assert.deepEqual(first._killSpy, ['clean-restart']);
    assert.deepEqual(second._killSpy, ['clean-restart']);
    assert.equal(pm.size, 0);
  });

  test('retireForCleanRestart rejects when an unsupported process kill does not confirm closure', async () => {
    class UnconfirmedProcess extends MockProcess {
      async kill(reason) {
        this._killSpy.push(reason);
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new UnconfirmedProcess({ sessionKey }),
    });
    const proc = await pm.getOrSpawn('sdk');

    await assert.rejects(
      pm.retireForCleanRestart({
        getDeliveryEvidence: async () => ({
          outputAttempted: false,
          pending: 0,
          fenced: true,
        }),
      }),
      (error) => error.code === 'CLEAN_RESTART_RETIREMENT_FAILED',
    );
    assert.deepEqual(proc._killSpy, ['clean-restart']);
    assert.equal(pm.has('sdk'), true);
  });

  test('fallback shutdown kills an unclosed process after clean retirement fails', async () => {
    class FailedRetirementProcess extends MockProcess {
      async retireForCleanRestart() {
        this._killSpy.push('clean-restart');
        throw Object.assign(new Error('clean retirement failed'), {
          code: 'CLEAN_RESTART_RETIREMENT_FAILED',
        });
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new FailedRetirementProcess({ sessionKey }),
    });
    const proc = await pm.getOrSpawn('sdk');

    await assert.rejects(
      pm.retireForCleanRestart({
        getDeliveryEvidence: async () => ({
          outputAttempted: false,
          pending: 0,
          fenced: true,
        }),
      }),
      (error) => error.code === 'CLEAN_RESTART_RETIREMENT_FAILED',
    );
    assert.equal(proc.closed, false);
    assert.equal(pm.get('sdk'), proc);

    await pm.shutdown();

    assert.deepEqual(proc._killSpy, ['clean-restart', 'shutdown']);
    assert.equal(proc.closed, true);
    assert.equal(pm.has('sdk'), false);
  });

  test('kill removes from map + calls Process.kill', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk', { chatId: 100 });
    const p = pm.get('sk');
    await pm.kill('sk', 'test');
    assert.equal(pm.has('sk'), false);
    assert.deepEqual(p._killSpy, ['test']);
  });

  test('Claude onClose remains observable during explicit kill', async () => {
    const closes = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: {
        onClose: (sessionKey, payload) => closes.push([sessionKey, payload]),
      },
    });
    await pm.getOrSpawn('sk');

    await pm.kill('sk', 'explicit');

    assert.deepEqual(closes, [['sk', { reason: 'explicit' }]]);
  });

  test('reports a spontaneous provider close exactly once', async () => {
    const terminations = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: {
        onAbnormalTermination: (sessionKey, evidence, proc) => {
          terminations.push({ sessionKey, evidence, proc });
        },
      },
    });
    const proc = await pm.getOrSpawn('sk');

    proc.closed = true;
    proc.emit('close', 137);
    proc.emit('close', 137);

    assert.equal(terminations.length, 1);
    assert.equal(terminations[0].sessionKey, 'sk');
    assert.equal(terminations[0].proc, proc);
    assert.deepEqual(terminations[0].evidence, {
      event: 'close',
      backend: 'mock',
      generationId: null,
      exitCode: 137,
    });
    assert.equal(Object.isFrozen(terminations[0].evidence), true);
  });

  test('intentional provider closes do not report abnormal termination', async () => {
    const terminations = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: {
        onAbnormalTermination: (...args) => terminations.push(args),
      },
    });
    await pm.getOrSpawn('killed');
    await pm.kill('killed', 'explicit');
    await pm.getOrSpawn('shutdown');
    await pm.shutdown();

    assert.deepEqual(terminations, []);
  });

  test('reports a Channels bridge loss before controlled cleanup closes it', async () => {
    const terminations = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: {
        onAbnormalTermination: (_sessionKey, evidence) => {
          terminations.push(evidence);
        },
      },
      logger: { warn() {}, error() {} },
    });
    const proc = await pm.getOrSpawn('sk');

    proc.emit('bridge-disconnected');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(terminations.length, 1);
    assert.equal(terminations[0].event, 'bridge-disconnected');
    assert.equal(terminations[0].exitCode, null);
  });

  test('Claude onClose remains observable during LRU eviction', async () => {
    const closes = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      budget: 1,
      callbacks: {
        onClose: (sessionKey, payload) => closes.push([sessionKey, payload]),
      },
    });
    const evicted = await pm.getOrSpawn('old');
    evicted.lastUsedTs = 1;

    await pm.getOrSpawn('new');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(closes, [['old', { reason: 'evict' }]]);
  });

  test('killChat kills all processes for chat', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('100:main', { chatId: 100 });
    await pm.getOrSpawn('100:t5', { chatId: 100, threadId: 5 });
    await pm.getOrSpawn('200:main', { chatId: 200 });
    await pm.killChat(100);
    assert.equal(pm.has('100:main'), false);
    assert.equal(pm.has('100:t5'), false);
    assert.equal(pm.has('200:main'), true);
  });

  test('shutdown closes all + rejects future getOrSpawn', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk1');
    await pm.getOrSpawn('sk2');
    await pm.shutdown();
    assert.equal(pm.size, 0);
    await assert.rejects(() => pm.getOrSpawn('sk3'), /shutdown/);
  });

  test('public kill synchronously fences same-tick state-changing dispatch', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const proc = await pm.getOrSpawn('sk');
    const killing = pm.kill('sk', 'same-tick-kill');

    await assert.rejects(
      pm.send('sk', 'must not reach proc'),
      (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
    );
    assert.equal(pm.injectUserMessage('sk', { content: 'x' }), false);
    assert.equal(pm.steer('sk', 'x'), false);
    assert.equal(proc._sendSpy.length, 0);
    assert.equal(await killing, true);
    assert.equal(pm._retirementIntents.has('sk'), false);
  });

  test('overlapping kill intents remain fenced until every queued kill settles', async () => {
    const gate = deferred();
    class SlowKillProcess extends MockProcess {
      async kill(reason) {
        this._killSpy.push(reason);
        await gate.promise;
        this.closed = true;
        this.emit('close', { reason });
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new SlowKillProcess({ sessionKey }),
    });
    await pm.getOrSpawn('sk');
    const first = pm.kill('sk', 'first');
    const second = pm.kill('sk', 'second');
    assert.equal(pm._retirementIntents.get('sk'), 2);
    await assert.rejects(
      pm.send('sk', 'still fenced'),
      (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
    );
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(pm._retirementIntents.has('sk'), false);
  });

  test('resetSession synchronously fences same-tick sends to the old process', async () => {
    const gate = deferred();
    class SlowResetProcess extends MockProcess {
      async resetSession() {
        await gate.promise;
        this.closed = true;
        return { closed: true, drainedPendings: 2 };
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new SlowResetProcess({ sessionKey }),
    });
    const proc = await pm.getOrSpawn('sk');
    const resetting = pm.resetSession('sk');

    await assert.rejects(
      pm.send('sk', 'must not reach old proc'),
      (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
    );
    assert.equal(proc._sendSpy.length, 0);
    gate.resolve();
    assert.deepEqual(
      await resetting,
      { closed: true, drainedPendings: 2 },
    );
    assert.equal(pm.has('sk'), false);
    assert.equal(pm._retirementIntents.has('sk'), false);
  });
});

describe('ProcessManager — expected-process send precondition', () => {
  test('rejects a replaced entry before the old process can accept input', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const expectedProcess = await pm.getOrSpawn('sk');
    const replacement = new MockProcess({ sessionKey: 'sk' });
    pm.procs.set('sk', replacement);

    await assert.rejects(
      pm.send('sk', 'must not reach replacement', { expectedProcess }),
      (error) => error.code === 'PROCESS_PRECONDITION_FAILED',
    );
    assert.deepEqual(expectedProcess._sendSpy, []);
    assert.deepEqual(replacement._sendSpy, []);
  });

  test('rejects an expected entry that is already closed', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const expectedProcess = await pm.getOrSpawn('sk');
    expectedProcess.closed = true;

    await assert.rejects(
      pm.send('sk', 'must not reach closed process', { expectedProcess }),
      (error) => error.code === 'PROCESS_PRECONDITION_FAILED',
    );
    assert.deepEqual(expectedProcess._sendSpy, []);
  });

  test('sends through the exact open entry without leaking expectedProcess', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const expectedProcess = await pm.getOrSpawn('sk');

    const result = await pm.send('sk', 'safe input', {
      expectedProcess,
      sourceMsgId: 42,
    });

    assert.equal(result.text, 'mock reply');
    assert.deepEqual(expectedProcess._sendSpy, [{
      prompt: 'safe input',
      opts: { sourceMsgId: 42 },
    }]);
  });
});

describe('ProcessManager — exact-process guarded retirement', () => {
  test('retires and removes the exact current process', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const expectedProcess = await pm.getOrSpawn('sk');

    assert.equal(
      await pm.retireExpectedProcess('sk', expectedProcess, 'attestation-rejected'),
      true,
    );
    assert.deepEqual(expectedProcess._killSpy, ['attestation-rejected']);
    assert.equal(expectedProcess.closed, true);
    assert.equal(pm.get('sk'), null);
  });

  test('refuses a replacement without killing or removing either process', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const expectedProcess = await pm.getOrSpawn('sk');
    const replacement = new MockProcess({ sessionKey: 'sk' });
    pm.procs.set('sk', replacement);

    await assert.rejects(
      pm.retireExpectedProcess('sk', expectedProcess, 'attestation-rejected'),
      (error) => error.code === 'PROCESS_PRECONDITION_FAILED',
    );
    assert.deepEqual(expectedProcess._killSpy, []);
    assert.deepEqual(replacement._killSpy, []);
    assert.equal(pm.get('sk'), replacement);
  });

  test('fails loud and preserves the entry when exact retirement cannot complete', async () => {
    class FailedRetirementProcess extends MockProcess {
      async kill(reason) {
        this._killSpy.push(reason);
        throw new Error('retirement failed');
      }
    }
    const pm = new ProcessManager({
      processFactory: (sessionKey) => new FailedRetirementProcess({ sessionKey }),
    });
    const expectedProcess = await pm.getOrSpawn('sk');

    await assert.rejects(
      pm.retireExpectedProcess('sk', expectedProcess, 'attestation-rejected'),
      /retirement failed/,
    );
    assert.equal(pm.get('sk'), expectedProcess);
    assert.equal(expectedProcess.closed, false);
  });
});

describe('ProcessManager — optional method delegation', () => {
  test('interrupt returns true when supported', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ supports: ['interrupt'] }) });
    await pm.getOrSpawn('sk');
    assert.equal(await pm.interrupt('sk'), true);
  });

  test('interrupt returns false when not supported (no throw)', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ supports: [] }) });
    await pm.getOrSpawn('sk');
    assert.equal(await pm.interrupt('sk'), false);
  });

  test('setModel + applyFlagSettings return true when supported', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk');
    assert.equal(await pm.setModel('sk', 'opus'), true);
    assert.equal(await pm.applyFlagSettings('sk', { effortLevel: 'high' }), true);
  });

  test('steerTurn delegates asynchronously and preserves the discriminated result', async () => {
    const pm = new ProcessManager({
      processFactory: mockFactory({ supports: ['steerTurn'] }),
    });
    await pm.getOrSpawn('sk');
    assert.deepEqual(
      await pm.steerTurn('sk', 'follow up', { context: { sourceMsgId: 'm2' } }),
      { outcome: 'accepted', turnId: 'turn-mock' },
    );
    assert.deepEqual(pm.get('sk')._steerTurnSpy, [{
      text: 'follow up',
      opts: { context: { sourceMsgId: 'm2' } },
    }]);
    assert.deepEqual(
      await pm.steerTurn('missing', 'follow up'),
      { outcome: 'unavailable', reason: 'missing-or-closed' },
    );
  });

  test('resetSession unsupported → fallback drainQueue + kill', async () => {
    const closes = [];
    const pm = new ProcessManager({
      processFactory: mockFactory({ supports: [] }),
      callbacks: {
        onClose: (sessionKey, payload) => closes.push([sessionKey, payload]),
      },
    });
    await pm.getOrSpawn('sk');
    const res = await pm.resetSession('sk');
    assert.equal(res.closed, true);
    assert.equal(pm.has('sk'), false);
    assert.deepEqual(closes, [['sk', { reason: 'reset' }]]);
  });
});

describe('ProcessManager — hot-path methods never throw (R1-F1)', () => {
  test('drainQueue returns 0 for unknown sessionKey', () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    assert.equal(pm.drainQueue('unknown'), 0);
  });

  test('injectUserMessage returns false for closed process', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk');
    pm.get('sk').closed = true;
    assert.equal(pm.injectUserMessage('sk', { content: 'x' }), false);
  });

  test('steer returns false when no in-flight', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk');
    assert.equal(pm.steer('sk', 'x'), false);
  });
});

describe('ProcessManager — callback forwarding', () => {
  test('onInit gets sessionKey + event payload + process', async () => {
    const calls = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: { onInit: (sk, payload, proc) => calls.push({ sk, payload, label: proc.label }) },
    });
    await pm.getOrSpawn('sk1', { chatId: 100 });
    pm.get('sk1').emitInit();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sk, 'sk1');
    assert.deepEqual(calls[0].payload, { sessionId: 'sess-1' });
  });

  test('onResult forwarded', async () => {
    const calls = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: { onResult: (sk, r) => calls.push({ sk, r }) },
    });
    await pm.getOrSpawn('sk1');
    pm.get('sk1').emitResult({ text: 'ok' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].r, { text: 'ok' });
  });

  test('callback throwing does not crash event emission', async () => {
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: { onInit: () => { throw new Error('bad cb'); } },
      logger: { error: () => {} },
    });
    await pm.getOrSpawn('sk1');
    // Should not throw
    pm.get('sk1').emitInit();
  });
});

// ── Codex runtime identity + daemon-wide ownership ──────────────────

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class RuntimeProcess extends MockProcess {
  constructor(opts, {
    runtime = 'claude',
    spawnProfileId = null,
    generationId = null,
    interruptGate = null,
    failInterrupt = null,
    failKill = null,
    closeOnKill = true,
    settleOnInterrupt = true,
    settlementOverrides = {},
    containOnInterrupt = false,
    containOnKill = false,
    killGate = null,
  } = {}) {
    super(opts, { backend: runtime === 'codex' ? 'codex' : 'mock' });
    this.runtime = runtime;
    this.spawnProfileId = spawnProfileId;
    this.generationId = generationId;
    this.hostIdentity = 'host-a';
    this.bootSessionIdentity = 'boot-new';
    this.state = runtime === 'codex' ? 'Idle' : undefined;
    this.interruptGate = interruptGate;
    this.failInterrupt = failInterrupt;
    this.failKill = failKill;
    this.closeOnKill = closeOnKill;
    this.settleOnInterrupt = settleOnInterrupt;
    this.settlementOverrides = settlementOverrides;
    this.containOnInterrupt = containOnInterrupt;
    this.containOnKill = containOnKill;
    this.killGate = killGate;
    this.selectedModelSettings = null;
  }

  async selectModelSettings(settings) {
    const nextTurn = Object.freeze({ ...settings });
    if (this.state === 'ContainmentFailed') {
      return {
        outcome: 'unavailable',
        reason: 'containment',
        nextTurn,
      };
    }
    if (this.state === 'Quiescing' || this.state === 'Stopped') {
      return {
        outcome: 'unavailable',
        reason: 'quiescing',
        nextTurn,
      };
    }
    this.selectedModelSettings = nextTurn;
    return {
      outcome: 'updated-live',
      threadId: 'thread-runtime',
      generationId: this.generationId,
      currentTurn: null,
      nextTurn,
    };
  }

  interrupt() {
    if (this._runtimeInterruptPromise) return this._runtimeInterruptPromise;
    this._runtimeInterruptPromise = this._interruptRuntime();
    return this._runtimeInterruptPromise;
  }

  async _interruptRuntime() {
    this.interruptCount = (this.interruptCount ?? 0) + 1;
    this.state = 'Quiescing';
    if (this.interruptGate) await this.interruptGate.promise;
    if (this.failInterrupt) throw this.failInterrupt;
    if (this.runtime === 'codex') {
      this.state = 'Stopped';
      if (this.settleOnInterrupt) {
        this.emit('codex-settled', {
          kind: 'stopped',
          generationId: this.generationId,
          hostIdentity: this.hostIdentity,
          bootSessionIdentity: this.bootSessionIdentity,
          trackedTerminalCleanupAccepted: true,
          freshRegistryObservedEmpty: true,
          ...this.settlementOverrides,
        });
      }
      if (this.containOnInterrupt) {
        this.state = 'ContainmentFailed';
        this.emit('containment-failed', {
          kind: 'containment-failed',
          generationId: this.generationId,
        });
      }
    }
    return true;
  }

  async kill(reason) {
    this._killSpy.push(reason);
    if (this.killGate) await this.killGate.promise;
    if (this.failKill) throw this.failKill;
    if (this.closeOnKill) {
      this.closed = true;
      this.state = 'Closed';
      this.emit('close', { reason, generationId: this.generationId });
      if (this.containOnKill) {
        this.emit('containment-failed', {
          kind: 'containment-failed',
          generationId: this.generationId,
        });
      }
    }
  }
}

function runtimeManager({
  processOptions = {},
  processFactory,
  recovery = { status: 'clear' },
  callbacks = {},
  budget = 10,
  codexRetirementVerifier,
  codexRetirementTimeoutMs,
} = {}) {
  const constructions = [];
  const factory = processFactory ?? ((sessionKey, ctx = {}) => {
    const runtime = ctx.runtime == null ? 'claude' : ctx.runtime;
    const proc = new RuntimeProcess({ sessionKey }, {
      runtime,
      spawnProfileId: ctx.spawnProfileId ?? null,
      generationId: `generation-${constructions.length + 1}`,
      ...processOptions,
    });
    if (ctx.useSpawnOptions) {
      proc.spawnOptions = Object.freeze({ trusted: true });
    }
    constructions.push({ sessionKey, ctx, proc });
    return proc;
  });
  const managerOptions = {
    processFactory: factory,
    callbacks,
    budget,
    codexHostIdentity: 'host-a',
    codexBootSessionIdentity: 'boot-new',
    codexRetirementVerifier,
    codexRetirementTimeoutMs,
  };
  if (recovery !== null) managerOptions.codexRecoveryState = recovery;
  const pm = new ProcessManager(managerOptions);
  return { pm, constructions };
}

function containmentCleanupDetail(proc, overrides = {}) {
  return Object.freeze({
    kind: 'containment-cleanup-committed',
    backend: 'codex',
    generationId: proc.generationId,
    hostIdentity: proc.hostIdentity,
    bootSessionIdentity: proc.bootSessionIdentity,
    containmentReason: 'test-containment',
    ...overrides,
  });
}

describe('ProcessManager — runtime identity and strict replacement', () => {
  test('strict Codex recovery never reuses an unattested warm generation', async () => {
    const { pm } = runtimeManager();
    await pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });

    await assert.rejects(
      pm.getOrSpawn('chat', {
        runtime: 'codex',
        spawnProfileId: 'profile',
        existingSessionId: 'thread-interrupted',
        expectedInterruptedTurnId: 'turn-interrupted',
        resumePolicy: 'require-interrupted-turn',
      }),
      (error) => error.code === 'CODEX_STRICT_RESUME_MISMATCH',
    );
  });

  test('malformed Codex recovery controls never reuse a warm generation', async () => {
    const { pm, constructions } = runtimeManager();
    await pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });

    for (const recoveryContext of [
      { resumePolicy: 'require-interupted-turn' },
      { expectedInterruptedTurnId: 'turn-without-policy' },
    ]) {
      await assert.rejects(
        pm.getOrSpawn('chat', {
          runtime: 'codex',
          spawnProfileId: 'profile',
          ...recoveryContext,
        }),
        (error) => error.code === 'CODEX_STRICT_RESUME_INVALID',
      );
    }
    assert.equal(constructions.length, 1);
  });

  test('omitted/null runtime is legacy Claude; explicit unknown fails before cache/factory', async () => {
    const { pm, constructions } = runtimeManager();
    const proc = await pm.getOrSpawn('chat', {});
    assert.equal(await pm.getOrSpawn('chat', { runtime: null }), proc);
    const secretRuntime = 'codxe-secret-tenant-name';
    await assert.rejects(
      pm.getOrSpawn('chat', { runtime: secretRuntime }),
      (error) => (
        error.code === 'RUNTIME_UNKNOWN'
        && error.message === 'Unknown agent runtime'
        && !error.message.includes(secretRuntime)
      ),
    );
    assert.equal(constructions.length, 1);
    assert.equal(proc.closed, false);
  });

  test('runtime + opaque spawnProfileId is the warm identity; exact reuses and mismatch strictly replaces', async () => {
    const { pm, constructions } = runtimeManager();
    const original = await pm.getOrSpawn('chat', {
      runtime: 'claude',
      spawnProfileId: 'claude-profile-a',
    });
    assert.equal(await pm.getOrSpawn('chat', {
      runtime: 'claude',
      spawnProfileId: 'claude-profile-a',
    }), original);

    const replacement = await pm.getOrSpawn('chat', {
      runtime: 'claude',
      spawnProfileId: 'claude-profile-b',
    });
    assert.notEqual(replacement, original);
    assert.equal(original.closed, true);
    assert.deepEqual(original._killSpy, ['runtime-switch']);
    assert.equal(constructions.length, 2);
  });

  test('a process starts from its trusted spawnOptions instead of the raw spawn context', async () => {
    const { pm } = runtimeManager();
    const proc = await pm.getOrSpawn('chat', {
      runtime: 'claude',
      useSpawnOptions: true,
      attacker: 'raw',
    });
    assert.deepEqual(proc._startSpy, [{ trusted: true }]);
  });

  test('strict replacement rejects every active/pinned/containment shape without killing', async (t) => {
    const blockers = [
      ['inFlight', (proc) => { proc.inFlight = true; }],
      ['background', (proc) => { proc.hasActiveBackgroundWork = () => true; }],
      ['question', (proc) => { proc.hasOpenQuestions = () => true; }],
      ['delivery', (proc) => { proc.hasPendingDeliveryWork = () => true; }],
      ['containment', (proc) => { proc.state = 'ContainmentFailed'; }],
    ];
    for (const [name, block] of blockers) {
      await t.test(name, async () => {
        const { pm, constructions } = runtimeManager();
        const original = await pm.getOrSpawn('chat', {
          runtime: 'claude',
          spawnProfileId: 'old',
        });
        block(original);
        await assert.rejects(
          pm.getOrSpawn('chat', {
            runtime: 'codex',
            spawnProfileId: 'new',
          }),
          (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
        );
        assert.equal(pm.get('chat'), original);
        assert.deepEqual(original._killSpy, []);
        assert.equal(constructions.length, 1);
      });
    }
  });

  test('strict teardown failure retains the old process and installs nothing', async () => {
    const { pm, constructions } = runtimeManager({
      processOptions: { failKill: new Error('transport close failed') },
    });
    const original = await pm.getOrSpawn('chat', {
      runtime: 'claude',
      spawnProfileId: 'old',
    });
    await assert.rejects(
      pm.getOrSpawn('chat', {
        runtime: 'claude',
        spawnProfileId: 'new',
      }),
      (error) => (
        error.code === 'RUNTIME_SWITCH_EVICTION_FAILED'
        && error.cause?.message === 'transport close failed'
      ),
    );
    assert.equal(pm.get('chat'), original);
    assert.equal(constructions.length, 1, 'replacement factory was never called');
  });

  test('concurrent requests for one replacement share its single-flight promise', async () => {
    const gate = deferred();
    const { pm, constructions } = runtimeManager({
      processOptions: { interruptGate: gate },
    });
    await pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'old',
    });
    const context = { runtime: 'codex', spawnProfileId: 'new' };
    const first = pm.getOrSpawn('chat', context);
    const second = pm.getOrSpawn('chat', context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(constructions.length, 1, 'no replacement before strict retirement');
    gate.resolve();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one, two);
    assert.equal(constructions.length, 2);
    assert.equal(
      constructions[0].proc.interruptCount,
      1,
      'strict retirement interrupts the old generation exactly once',
    );
  });

  test('a synchronous start throw follows the protected cleanup path', async () => {
    let calls = 0;
    const pm = new ProcessManager({
      processFactory: (sessionKey) => {
        calls += 1;
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'claude',
          generationId: `generation-${calls}`,
        });
        proc.start = () => { throw new Error('sync start failure'); };
        return proc;
      },
    });
    await assert.rejects(
      pm.getOrSpawn('chat', { runtime: 'claude' }),
      /sync start failure/,
    );
    assert.equal(pm.has('chat'), false);
    assert.equal(pm._starting.has('chat'), false);
  });

  test('public replaceRuntime is serialized behind an in-progress start', async () => {
    const gate = deferred();
    const constructed = [];
    const pm = new ProcessManager({
      processFactory: (sessionKey, ctx) => {
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'claude',
          spawnProfileId: ctx.spawnProfileId,
          generationId: `generation-${constructed.length + 1}`,
        });
        if (constructed.length === 0) {
          proc.start = async () => gate.promise;
        }
        constructed.push(proc);
        return proc;
      },
    });
    const initial = pm.getOrSpawn('chat', {
      runtime: 'claude',
      spawnProfileId: 'old',
    });
    const replacement = pm.replaceRuntime('chat', {
      runtime: 'claude',
      spawnProfileId: 'new',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(constructed.length, 1);
    assert.deepEqual(constructed[0]._killSpy, []);
    gate.resolve();
    await initial;
    const current = await replacement;
    assert.equal(constructed.length, 2);
    assert.equal(current, constructed[1]);
  });

  test('post-wait competitor is reused only for the exact runtime/profile identity', async (t) => {
    for (const exact of [true, false]) {
      await t.test(exact ? 'exact competitor' : 'mismatched competitor', async () => {
        const created = [];
        const pm = new ProcessManager({
          budget: 2,
          lruWaitMs: 500,
          processFactory: (sessionKey, ctx) => {
            const proc = new RuntimeProcess({ sessionKey }, {
              runtime: 'claude',
              spawnProfileId: ctx.spawnProfileId ?? null,
              generationId: `generation-${created.length + 1}`,
            });
            created.push(proc);
            return proc;
          },
        });
        const first = await pm.getOrSpawn('blocker-1', { runtime: 'claude' });
        const second = await pm.getOrSpawn('blocker-2', { runtime: 'claude' });
        first.inFlight = true;
        second.inFlight = true;
        const spawn = pm.getOrSpawn('target', {
          runtime: 'claude',
          spawnProfileId: 'wanted',
        });
        await new Promise((resolve) => setImmediate(resolve));
        const provisional = created[2];
        const competitor = new RuntimeProcess({ sessionKey: 'target' }, {
          runtime: 'claude',
          spawnProfileId: exact ? 'wanted' : 'other',
          generationId: 'competitor-generation',
        });
        pm.procs.set('target', competitor);
        pm.procs.delete('blocker-1');
        pm.procs.delete('blocker-2');
        pm._maybeSignalLruWaiter();

        const result = await spawn;
        assert.equal(provisional._startSpy.length, 0);
        assert.deepEqual(provisional._killSpy, []);
        if (exact) {
          assert.equal(result, competitor);
          assert.deepEqual(competitor._killSpy, []);
        } else {
          assert.notEqual(result, competitor);
          assert.deepEqual(competitor._killSpy, ['runtime-switch']);
          assert.equal(result.spawnProfileId, 'wanted');
        }
      });
    }
  });

  test('shutdown waits for a session start gate, then retires the final published snapshot', async () => {
    const gate = deferred();
    let proc;
    const pm = new ProcessManager({
      processFactory: (sessionKey) => {
        proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'claude',
          generationId: 'starting-generation',
        });
        proc.start = async () => gate.promise;
        return proc;
      },
    });
    const spawn = pm.getOrSpawn('chat', { runtime: 'claude' });
    await new Promise((resolve) => setImmediate(resolve));
    const shutdown = pm.shutdown();
    let shutdownDone = false;
    shutdown.then(() => { shutdownDone = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownDone, false);
    gate.resolve();
    await assert.rejects(spawn, /shutdown/);
    await shutdown;
    assert.deepEqual(proc._killSpy, ['shutdown']);
    assert.equal(pm.size, 0);
  });
});

describe('ProcessManager — Codex daemon-wide lease and recovery', () => {
  test('read-only model settings status classifies recovery, reservations, and runtime without spawning', async () => {
    const clear = runtimeManager();
    assert.deepEqual(
      await clear.pm.getModelSettingsStatus('not-loaded'),
      { outcome: 'not-loaded' },
    );
    assert.equal(clear.constructions.length, 0);

    await clear.pm.getOrSpawn('claude', { runtime: 'claude' });
    assert.deepEqual(
      await clear.pm.getModelSettingsStatus('claude'),
      { outcome: 'unavailable', reason: 'wrong-runtime' },
    );

    const reserved = runtimeManager().pm;
    reserved._reserveCodexLease('codex-a');
    assert.deepEqual(
      await reserved.getModelSettingsStatus('codex-a'),
      { outcome: 'unavailable', reason: 'stale-generation' },
    );
    assert.deepEqual(
      await reserved.getModelSettingsStatus('codex-b'),
      { outcome: 'daemon-busy' },
    );

    const notReady = runtimeManager({ recovery: null }).pm;
    assert.deepEqual(
      await notReady.getModelSettingsStatus('codex-a'),
      { outcome: 'unavailable', reason: 'stale-generation' },
    );

    const quarantined = runtimeManager({
      recovery: {
        status: 'quarantined',
        hostIdentity: 'host-a',
        bootSessionIdentity: 'boot-new',
        generationId: 'quarantined-generation',
      },
    }).pm;
    assert.deepEqual(
      await quarantined.getModelSettingsStatus('codex-a'),
      { outcome: 'unavailable', reason: 'containment' },
    );

    const quarantinedOwner = runtimeManager().pm;
    await quarantinedOwner.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    quarantinedOwner._codexLease.quarantined = true;
    assert.deepEqual(
      await quarantinedOwner.getModelSettingsStatus('codex-b'),
      { outcome: 'unavailable', reason: 'containment' },
    );
  });

  test('read-only model settings status and selection share unsafe lifecycle classification', async (t) => {
    const settings = { model: 'gpt-5.6-sol', effort: 'xhigh' };
    for (const [state, reason] of [
      ['ContainmentFailed', 'containment'],
      ['FailedAmbiguous', 'containment'],
      ['DurabilityBlocked', 'containment'],
      ['Quiescing', 'quiescing'],
      ['Stopped', 'quiescing'],
    ]) {
      await t.test(state, async () => {
        const { pm } = runtimeManager();
        const proc = await pm.getOrSpawn('codex-a', {
          runtime: 'codex',
          spawnProfileId: 'profile',
        });
        let selectionCalls = 0;
        proc.selectModelSettings = async () => {
          selectionCalls += 1;
          throw new Error('unsafe lifecycle reached mutation');
        };
        proc.state = state;

        assert.deepEqual(
          await pm.getModelSettingsStatus('codex-a'),
          { outcome: 'unavailable', reason },
        );
        assert.deepEqual(
          await pm.selectModelSettings('codex-a', settings),
          { outcome: 'unavailable', reason, nextTurn: settings },
        );
        assert.equal(selectionCalls, 0);
      });
    }

    await t.test('stale generation', async () => {
      const { pm } = runtimeManager();
      const proc = await pm.getOrSpawn('codex-a', {
        runtime: 'codex',
        spawnProfileId: 'profile',
      });
      let selectionCalls = 0;
      proc.selectModelSettings = async () => {
        selectionCalls += 1;
        throw new Error('stale generation reached mutation');
      };
      proc.generationId = 'generation-replaced';

      assert.deepEqual(
        await pm.getModelSettingsStatus('codex-a'),
        { outcome: 'unavailable', reason: 'stale-generation' },
      );
      assert.deepEqual(
        await pm.selectModelSettings('codex-a', settings),
        {
          outcome: 'unavailable',
          reason: 'stale-generation',
          nextTurn: settings,
        },
      );
      assert.equal(selectionCalls, 0);
    });
  });

  test('read-only model settings status reports StartingTurn active/admitting and desired settings', async () => {
    const { pm } = runtimeManager();
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    const admitting = { model: 'gpt-5.6-sol', effort: 'high' };
    const active = { model: 'gpt-5.6-sol', effort: 'xhigh' };
    const desired = { model: 'gpt-5.6-terra', effort: 'medium' };
    const observed = { model: 'gpt-5.6-sol', effort: 'high' };
    proc.state = 'StartingTurn';
    proc.providerSessionId = 'thread-status';
    proc.admittingTurnSettings = admitting;
    proc.activeTurnSettings = null;
    proc.desiredSettings = desired;
    proc.observedThreadSettings = observed;
    proc.selectModelSettings = async () => {
      throw new Error('read-only status reached mutation');
    };

    const admittingStatus = await pm.getModelSettingsStatus('codex-a');
    assert.deepEqual(admittingStatus, {
      outcome: 'loaded',
      threadId: 'thread-status',
      generationId: proc.generationId,
      currentTurn: admitting,
      nextTurn: desired,
      observedThread: observed,
    });
    assert.notEqual(admittingStatus.currentTurn, admitting);
    assert.notEqual(admittingStatus.nextTurn, desired);
    assert.notEqual(admittingStatus.observedThread, observed);

    proc.activeTurnSettings = active;
    assert.deepEqual(
      await pm.getModelSettingsStatus('codex-a'),
      {
        outcome: 'loaded',
        threadId: 'thread-status',
        generationId: proc.generationId,
        currentTurn: active,
        nextTurn: desired,
        observedThread: observed,
      },
    );
  });

  test('model settings distinguish live, not-loaded, daemon-busy, wrong-runtime, and containment', async () => {
    const settings = { model: 'gpt-5.6-sol', effort: 'xhigh' };
    const { pm } = runtimeManager();

    assert.deepEqual(
      await pm.selectModelSettings('not-loaded', settings),
      {
        outcome: 'not-loaded',
        nextTurn: settings,
      },
    );
    const live = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    assert.deepEqual(
      await pm.selectModelSettings('codex-a', settings),
      {
        outcome: 'updated-live',
        threadId: 'thread-runtime',
        generationId: live.generationId,
        currentTurn: null,
        nextTurn: settings,
      },
    );
    assert.equal(pm.get('codex-a'), live);
    assert.deepEqual(live.selectedModelSettings, settings);
    assert.deepEqual(
      await pm.selectModelSettings('codex-b', settings),
      {
        outcome: 'daemon-busy',
        nextTurn: settings,
      },
    );
    live.state = 'ContainmentFailed';
    assert.deepEqual(
      await pm.selectModelSettings('codex-a', settings),
      {
        outcome: 'unavailable',
        reason: 'containment',
        nextTurn: settings,
      },
    );

    const claudeManager = runtimeManager().pm;
    await claudeManager.getOrSpawn('claude', { runtime: 'claude' });
    assert.deepEqual(
      await claudeManager.selectModelSettings('claude', settings),
      {
        outcome: 'unavailable',
        reason: 'wrong-runtime',
        nextTurn: settings,
      },
    );

    const quarantined = runtimeManager({
      recovery: {
        status: 'quarantined',
        hostIdentity: 'host-a',
        bootSessionIdentity: 'boot-new',
        generationId: 'quarantined-generation',
      },
    }).pm;
    assert.deepEqual(
      await quarantined.selectModelSettings('codex-a', settings),
      {
        outcome: 'unavailable',
        reason: 'containment',
        nextTurn: settings,
      },
    );
  });

  test('model selection serializes behind a simultaneous spawn and classifies the published generation', async () => {
    const { pm } = runtimeManager();
    const settings = { model: 'gpt-5.6-sol', effort: 'xhigh' };

    const spawning = pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    const selecting = pm.selectModelSettings('codex-a', settings);
    const proc = await spawning;

    assert.deepEqual(await selecting, {
      outcome: 'updated-live',
      threadId: 'thread-runtime',
      generationId: proc.generationId,
      currentTurn: null,
      nextTurn: settings,
    });
    assert.equal(pm.get('codex-a'), proc);
    assert.deepEqual(proc.selectedModelSettings, settings);
  });

  test('warm getOrSpawn reconciles its requested model settings before returning the generation', async () => {
    const { pm } = runtimeManager();
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
      modelSettings: {
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    });
    const selected = {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    };

    const reused = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
      modelSettings: selected,
    });

    assert.equal(reused, proc);
    assert.deepEqual(proc.selectedModelSettings, selected);
  });

  test('warm getOrSpawn fails closed when its model settings are not accepted', async () => {
    const { pm } = runtimeManager();
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    proc.selectModelSettings = async (settings) => ({
      outcome: 'unavailable',
      reason: 'quiescing',
      nextTurn: settings,
    });

    await assert.rejects(
      pm.getOrSpawn('codex-a', {
        runtime: 'codex',
        spawnProfileId: 'profile',
        modelSettings: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
        },
      }),
      (error) => error.code === 'CODEX_MODEL_SETTINGS_NOT_APPLIED',
    );
    assert.equal(pm.get('codex-a'), proc);
  });

  test('cross-session model selection reports daemon-busy while spawn holds a pre-start reservation', async () => {
    const settings = { model: 'gpt-5.6-sol', effort: 'xhigh' };
    const { pm } = runtimeManager({
      budget: 1,
      processFactory: (sessionKey, ctx = {}) => new RuntimeProcess(
        { sessionKey },
        {
          runtime: ctx.runtime ?? 'claude',
          spawnProfileId: ctx.spawnProfileId ?? null,
          generationId: `generation-${sessionKey}`,
        },
      ),
    });
    pm.lruWaitMs = 500;
    const blocker = await pm.getOrSpawn('blocker', { runtime: 'claude' });
    blocker.inFlight = true;

    const spawning = pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const reservedSessionKey = pm._codexLease?.sessionKey;
    const classification = await pm.selectModelSettings('codex-b', settings);

    blocker.inFlight = false;
    pm._maybeSignalLruWaiter();
    const owner = await spawning;

    assert.deepEqual(classification, {
      outcome: 'daemon-busy',
      nextTurn: settings,
    });
    assert.equal(reservedSessionKey, 'codex-a');
    assert.equal(pm.get('codex-a'), owner);
  });

  test('cross-session model selection reports daemon-busy while replacement transfers its reservation', async () => {
    const settings = { model: 'gpt-5.6-sol', effort: 'xhigh' };
    let construction = 0;
    const { pm } = runtimeManager({
      budget: 1,
      processFactory: (sessionKey, ctx) => {
        construction += 1;
        const proc = new RuntimeProcess(
          { sessionKey },
          {
            runtime: 'codex',
            spawnProfileId: ctx.spawnProfileId,
            generationId: `generation-${construction}`,
          },
        );
        proc._cost = construction === 1 ? 1 : 2;
        return proc;
      },
    });
    pm.lruWaitMs = 500;
    await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile-a',
    });
    const originalLease = pm._codexLease;

    const replacing = pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile-b',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const transferredLease = pm._codexLease;
    const reservedSessionKey = transferredLease?.sessionKey;
    const classification = await pm.selectModelSettings('codex-b', settings);

    pm.budget = 2;
    pm._maybeSignalLruWaiter();
    const replacement = await replacing;

    assert.equal(transferredLease, originalLease);
    assert.deepEqual(classification, {
      outcome: 'daemon-busy',
      nextTurn: settings,
    });
    assert.equal(reservedSessionKey, 'codex-a');
    assert.equal(pm.get('codex-a'), replacement);
    assert.equal(pm._codexLease, originalLease);
  });

  test('recovery defaults not-ready and blocks Codex only', async () => {
    const { pm, constructions } = runtimeManager({ recovery: null });
    await pm.getOrSpawn('claude-chat', { runtime: 'claude' });
    await assert.rejects(
      pm.getOrSpawn('codex-chat', {
        runtime: 'codex',
        spawnProfileId: 'profile',
      }),
      (error) => error.code === 'CODEX_RECOVERY_NOT_READY',
    );
    assert.equal(constructions.length, 1);
  });

  test('one lease spans sessions/workspaces and rejects before factory without owner metadata', async () => {
    const { pm, constructions } = runtimeManager();
    await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'workspace-a',
    });
    await assert.rejects(
      pm.getOrSpawn('codex-b', {
        runtime: 'codex',
        spawnProfileId: 'workspace-b',
      }),
      (error) => (
        error.code === 'CODEX_DAEMON_GENERATION_BUSY'
        && !Object.hasOwn(error, 'sessionKey')
        && !Object.hasOwn(error, 'generationId')
        && !Object.hasOwn(error, 'owner')
      ),
    );
    assert.equal(constructions.length, 1);
  });

  test('a synchronous Codex start throw retains ownership and blocks another construction', async () => {
    let constructions = 0;
    let failedProc;
    const pm = new ProcessManager({
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      processFactory: (sessionKey, ctx) => {
        constructions += 1;
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'codex',
          spawnProfileId: ctx.spawnProfileId,
          generationId: `generation-${constructions}`,
        });
        failedProc = proc;
        proc.start = () => { throw new Error('sync codex start failure'); };
        return proc;
      },
    });
    await assert.rejects(
      pm.getOrSpawn('codex-a', {
        runtime: 'codex',
        spawnProfileId: 'profile-a',
      }),
      /sync codex start failure/,
    );
    await assert.rejects(
      pm.getOrSpawn('codex-b', {
        runtime: 'codex',
        spawnProfileId: 'profile-b',
      }),
      (error) => error.code === 'CODEX_DAEMON_GENERATION_BUSY',
    );
    assert.equal(constructions, 1);
    assert.equal(pm.get('codex-a'), failedProc);
  });

  test('unsafe async and containment start rejections retain the exact process fence', async (t) => {
    for (const mode of ['async', 'containment']) {
      await t.test(mode, async () => {
        let failedProc;
        const pm = new ProcessManager({
          codexRecoveryState: { status: 'clear' },
          codexHostIdentity: 'host-a',
          codexBootSessionIdentity: 'boot-new',
          processFactory: (sessionKey, ctx) => {
            failedProc = new RuntimeProcess({ sessionKey }, {
              runtime: 'codex',
              spawnProfileId: ctx.spawnProfileId,
              generationId: `${mode}-generation`,
            });
            failedProc.start = async () => {
              if (mode === 'containment') {
                failedProc.state = 'ContainmentFailed';
                failedProc.emit('containment-failed', {
                  kind: 'containment-failed',
                  generationId: failedProc.generationId,
                });
              }
              throw new Error(`${mode} start failure`);
            };
            return failedProc;
          },
        });
        await assert.rejects(
          pm.getOrSpawn('codex', {
            runtime: 'codex',
            spawnProfileId: 'profile',
          }),
          new RegExp(`${mode} start failure`),
        );
        assert.equal(pm.get('codex'), failedProc);
        assert.equal(pm._codexLease.proc, failedProc);
      });
    }
  });

  test('a factory identity mismatch releases the unbound reservation safely', async () => {
    let mismatched = true;
    const pm = new ProcessManager({
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      processFactory: (sessionKey, ctx) => new RuntimeProcess(
        { sessionKey },
        {
          runtime: mismatched ? 'claude' : 'codex',
          spawnProfileId: ctx.spawnProfileId,
          generationId: mismatched ? null : 'valid-generation',
        },
      ),
    });
    await assert.rejects(
      pm.getOrSpawn('codex-a', {
        runtime: 'codex',
        spawnProfileId: 'profile-a',
      }),
      (error) => error.code === 'RUNTIME_FACTORY_MISMATCH',
    );
    mismatched = false;
    await pm.getOrSpawn('codex-b', {
      runtime: 'codex',
      spawnProfileId: 'profile-b',
    });
    assert.equal(pm.has('codex-b'), true);
  });

  test('Codex factory must provide the exact spawnProfileId and manager never synthesizes it', async () => {
    let exact = false;
    const pm = new ProcessManager({
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      processFactory: (sessionKey) => new RuntimeProcess(
        { sessionKey },
        {
          runtime: 'codex',
          spawnProfileId: exact ? 'expected-profile' : null,
          generationId: exact ? 'exact-generation' : 'missing-profile-generation',
        },
      ),
    });
    await assert.rejects(
      pm.getOrSpawn('missing', {
        runtime: 'codex',
        spawnProfileId: 'expected-profile',
      }),
      (error) => error.code === 'RUNTIME_FACTORY_MISMATCH',
    );
    exact = true;
    await pm.getOrSpawn('exact', {
      runtime: 'codex',
      spawnProfileId: 'expected-profile',
    });
    assert.equal(pm.has('exact'), true);
  });

  test('throwing post-reservation cost/setup releases a definitely-unstarted Codex reservation', async () => {
    let first = true;
    let failedProc;
    const pm = new ProcessManager({
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      processFactory: (sessionKey, ctx) => {
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'codex',
          spawnProfileId: ctx.spawnProfileId,
          generationId: first ? 'bad-cost-generation' : 'good-generation',
        });
        if (first) {
          failedProc = proc;
          Object.defineProperty(proc, 'cost', {
            configurable: true,
            get() { throw new Error('cost getter failed'); },
          });
          first = false;
        }
        return proc;
      },
    });
    await assert.rejects(
      pm.getOrSpawn('bad', {
        runtime: 'codex',
        spawnProfileId: 'bad-profile',
      }),
      /cost getter failed/,
    );
    assert.equal(pm._codexLease, null);
    assert.equal(pm.has('bad'), false);
    assert.deepEqual(failedProc._killSpy, []);
    await pm.getOrSpawn('good', {
      runtime: 'codex',
      spawnProfileId: 'good-profile',
    });
    assert.equal(pm.has('good'), true);
  });

  test('containment and generic or inexact close retain the exact map and lease', async (t) => {
    for (const mode of ['containment', 'generic-close', 'copied-cleanup']) {
      await t.test(mode, async () => {
        const { pm, constructions } = runtimeManager();
        const proc = await pm.getOrSpawn('codex-a', {
          runtime: 'codex',
          spawnProfileId: 'workspace-a',
        });
        if (mode === 'containment') {
          proc.state = 'ContainmentFailed';
          proc.emit('containment-failed', {
            kind: 'containment-failed',
            generationId: proc.generationId,
          });
        } else {
          const detail = mode === 'copied-cleanup'
            ? containmentCleanupDetail(proc)
            : { generationId: proc.generationId };
          if (mode === 'copied-cleanup') {
            proc.containmentCleanupCommitted = containmentCleanupDetail(proc);
          }
          proc.closed = true;
          proc.emit('close', 1, detail);
        }
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(
          pm.getOrSpawn('codex-b', {
            runtime: 'codex',
            spawnProfileId: 'workspace-b',
          }),
          (error) => error.code === 'CODEX_DAEMON_GENERATION_BUSY',
        );
        assert.equal(constructions.length, 1);
        assert.equal(pm.get('codex-a'), proc);
        assert.equal(pm._codexLease?.proc, proc);
      });
    }
  });

  test('exact cleanup close releases only after the in-flight start settles', async () => {
    const cleanupEmitted = deferred();
    const releaseStart = deferred();
    let construction = 0;
    let failedProc;
    const pm = new ProcessManager({
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      processFactory: (sessionKey, ctx) => {
        construction += 1;
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'codex',
          spawnProfileId: ctx.spawnProfileId,
          generationId: `generation-${construction}`,
        });
        if (construction === 1) {
          failedProc = proc;
          proc.start = async () => {
            proc.state = 'ContainmentFailed';
            proc.emit('containment-failed', {
              kind: 'containment-failed',
              generationId: proc.generationId,
            });
            const detail = containmentCleanupDetail(proc);
            proc.containmentCleanupCommitted = detail;
            proc.closed = true;
            proc.state = 'Closed';
            proc.emit('close', 1, detail);
            cleanupEmitted.resolve();
            await releaseStart.promise;
            throw new Error('accepted startup failed after cleanup');
          };
        }
        return proc;
      },
    });

    const starting = pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'workspace-a',
    });
    await cleanupEmitted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pm.get('codex-a'), failedProc);
    assert.equal(pm._codexLease?.proc, failedProc);

    releaseStart.resolve();
    await assert.rejects(starting, /accepted startup failed after cleanup/);
    const replacement = await pm.getOrSpawn('codex-b', {
      runtime: 'codex',
      spawnProfileId: 'workspace-b',
    });

    assert.equal(pm.get('codex-a'), null);
    assert.equal(pm.get('codex-b'), replacement);
    assert.equal(pm._codexLease?.proc, replacement);
    assert.equal(construction, 2);
  });

  test('late exact cleanup close cannot release a replacement map entry or lease', async () => {
    const { pm } = runtimeManager();
    const old = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'workspace-a',
    });
    const replacement = new RuntimeProcess({ sessionKey: 'codex-a' }, {
      runtime: 'codex',
      spawnProfileId: 'workspace-b',
      generationId: 'replacement-generation',
    });
    pm.procs.set('codex-a', replacement);
    const replacementLease = {
      kind: 'generation',
      proc: replacement,
      sessionKey: 'codex-a',
      generationId: replacement.generationId,
      hostIdentity: replacement.hostIdentity,
      bootSessionIdentity: replacement.bootSessionIdentity,
      quarantined: false,
    };
    pm._codexLease = replacementLease;

    const detail = containmentCleanupDetail(old);
    old.containmentCleanupCommitted = detail;
    old.closed = true;
    old.state = 'Closed';
    old.emit('close', 1, detail);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(pm.get('codex-a'), replacement);
    assert.equal(pm._codexLease, replacementLease);
  });

  test('healthy strict retirement requires the exact settlement event and closed transport', async (t) => {
    await t.test('missing settlement', async () => {
      const { pm } = runtimeManager({
        processOptions: { settleOnInterrupt: false },
      });
      const original = await pm.getOrSpawn('chat', {
        runtime: 'codex',
        spawnProfileId: 'old',
      });
      await assert.rejects(
        pm.getOrSpawn('chat', {
          runtime: 'claude',
          spawnProfileId: 'new',
        }),
        (error) => error.code === 'RUNTIME_SWITCH_EVICTION_FAILED',
      );
      assert.equal(pm.get('chat'), original);
    });

    await t.test('transport not closed', async () => {
      const { pm } = runtimeManager({
        processOptions: { closeOnKill: false },
      });
      const original = await pm.getOrSpawn('chat', {
        runtime: 'codex',
        spawnProfileId: 'old',
      });
      await assert.rejects(
        pm.getOrSpawn('chat', {
          runtime: 'claude',
          spawnProfileId: 'new',
        }),
        (error) => error.code === 'RUNTIME_SWITCH_EVICTION_FAILED',
      );
      assert.equal(pm.get('chat'), original);
    });

    for (const [name, processOptions] of [
      ['wrong generation', {
        settlementOverrides: { generationId: 'stale-generation' },
      }],
      ['wrong host', {
        settlementOverrides: { hostIdentity: 'other-host' },
      }],
      ['wrong boot', {
        settlementOverrides: { bootSessionIdentity: 'other-boot' },
      }],
      ['cleanup not accepted', {
        settlementOverrides: { trackedTerminalCleanupAccepted: false },
      }],
      ['registry not empty', {
        settlementOverrides: { freshRegistryObservedEmpty: false },
      }],
      ['quarantine races settlement', { containOnInterrupt: true }],
    ]) {
      await t.test(name, async () => {
        const { pm } = runtimeManager({ processOptions });
        const original = await pm.getOrSpawn('chat', {
          runtime: 'codex',
          spawnProfileId: 'old',
        });
        await assert.rejects(
          pm.getOrSpawn('chat', {
            runtime: 'claude',
            spawnProfileId: 'new',
          }),
          (error) => error.code === 'RUNTIME_SWITCH_EVICTION_FAILED',
        );
        assert.equal(pm.get('chat'), original);
      });
    }
  });

  test('same-session Codex profile transfer is atomic and blocks outside contenders', async () => {
    const gate = deferred();
    const { pm, constructions } = runtimeManager({
      processOptions: { interruptGate: gate },
    });
    await pm.getOrSpawn('owner', {
      runtime: 'codex',
      spawnProfileId: 'old',
    });
    const replacement = pm.getOrSpawn('owner', {
      runtime: 'codex',
      spawnProfileId: 'new',
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      pm.getOrSpawn('contender', {
        runtime: 'codex',
        spawnProfileId: 'other',
      }),
      (error) => error.code === 'CODEX_DAEMON_GENERATION_BUSY',
    );
    assert.equal(constructions.length, 1);
    gate.resolve();
    await replacement;
    assert.equal(constructions.length, 2);
  });

  test('explicit recovery restore keeps legacy quarantine fenced across boot changes', async (t) => {
    const held = {
      status: 'quarantined',
      hostIdentity: 'host-a',
      bootSessionIdentity: 'boot-old',
      generationId: 'persisted-generation',
    };
    for (const [name, recovery] of [
      ['same host, new boot', held],
      ['same boot', { ...held, bootSessionIdentity: 'boot-new' }],
      ['relocated host', { ...held, hostIdentity: 'host-b' }],
    ]) {
      await t.test(name, async () => {
        const { pm } = runtimeManager({ recovery });
        await assert.rejects(
          pm.getOrSpawn('codex', {
            runtime: 'codex',
            spawnProfileId: 'profile',
          }),
          (error) => error.code === 'CODEX_DAEMON_GENERATION_BUSY',
        );
      });
    }
    await t.test('explicit clear after external settlement', async () => {
      const { pm } = runtimeManager({ recovery: { status: 'clear' } });
      await pm.getOrSpawn('codex', {
        runtime: 'codex',
        spawnProfileId: 'profile',
      });
      assert.equal(pm.has('codex'), true);
    });
  });

  test('Codex is pinned out of LRU eviction and soft-overflow selection', async () => {
    const { pm } = runtimeManager({ budget: 1 });
    const codex = await pm.getOrSpawn('codex', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    await pm.getOrSpawn('claude', { runtime: 'claude' });
    assert.equal(pm.get('codex'), codex);
    assert.equal(pm.has('claude'), true);
  });

  test('Codex lease stays unbound while LRU waits and releases after definitely-unstarted timeout', async () => {
    const provisional = [];
    const pm = new ProcessManager({
      budget: 1,
      lruWaitMs: 30,
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      logger: { warn() {}, error() {} },
      processFactory: (sessionKey, ctx) => {
        const runtime = ctx.runtime ?? 'claude';
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime,
          spawnProfileId: ctx.spawnProfileId ?? null,
          generationId: `generation-${provisional.length + 1}`,
        });
        provisional.push(proc);
        return proc;
      },
    });
    const blocker = await pm.getOrSpawn('blocker', { runtime: 'claude' });
    blocker.inFlight = true;
    const spawn = pm.getOrSpawn('codex', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pm._codexLease.kind, 'reservation');
    assert.equal(pm._codexLease.proc, null);
    assert.equal(provisional[1]._startSpy.length, 0);
    await assert.rejects(spawn, /lru wait timed out/);
    assert.equal(pm._codexLease, null);
    assert.deepEqual(provisional[1]._killSpy, []);
  });

  test('shutdown releases an unbound waiting reservation and never kills the never-started Codex object', async () => {
    const provisional = [];
    const pm = new ProcessManager({
      budget: 1,
      lruWaitMs: 5_000,
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      processFactory: (sessionKey, ctx) => {
        const runtime = ctx.runtime ?? 'claude';
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime,
          spawnProfileId: ctx.spawnProfileId ?? null,
          generationId: `generation-${provisional.length + 1}`,
        });
        provisional.push(proc);
        return proc;
      },
    });
    const blocker = await pm.getOrSpawn('blocker', { runtime: 'claude' });
    blocker.inFlight = true;
    const spawn = pm.getOrSpawn('codex', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const shutdown = pm.shutdown();
    await assert.rejects(spawn, /shutdown/);
    await shutdown;
    assert.equal(pm._codexLease, null);
    assert.equal(provisional[1]._startSpy.length, 0);
    assert.deepEqual(provisional[1]._killSpy, []);
  });
});

describe('ProcessManager — Codex retirement and callback fences', () => {
  test('clean restart retires one exact interrupted Codex turn into an eligible snapshot', async () => {
    const verifierCalls = [];
    const { pm } = runtimeManager({
      processOptions: {
        settlementOverrides: {
          terminalStatus: 'interrupted',
          turnId: 'turn-clean-restart',
        },
      },
      codexRetirementVerifier: async (input) => {
        verifierCalls.push(input);
        return Object.freeze({
          committed: true,
          disposition: 'stop-cancelled',
          sessionKey: input.sessionKey,
          generationId: input.generationId,
          attemptId: 'attempt-clean-restart',
          providerSessionId: 'thread-clean-restart',
          providerTurnId: 'turn-clean-restart',
          sourceMsgId: 44,
        });
      },
    });
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile-clean-restart',
    });
    proc.captureCleanRestartCandidate = () => Object.freeze({
      runtime: 'codex',
      namespace: 'codex:app-server',
      sessionKey: 'codex-a',
      generationId: proc.generationId,
      attemptId: 'attempt-clean-restart',
      providerSessionId: 'thread-clean-restart',
      providerTurnId: 'turn-clean-restart',
      sourceMsgId: 44,
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      spawnProfileId: 'profile-clean-restart',
    });
    const evidenceCalls = [];

    const snapshots = await pm.retireForCleanRestart({
      getDeliveryEvidence: async (sessionKey, sourceMsgId) => {
        evidenceCalls.push([sessionKey, sourceMsgId]);
        return Object.freeze({
          outputAttempted: false,
          pending: 0,
          fenced: true,
        });
      },
    });

    assert.deepEqual(evidenceCalls, [['codex-a', 44]]);
    assert.equal(verifierCalls.length, 1);
    assert.deepEqual(snapshots, [{
      runtime: 'codex',
      namespace: 'codex:app-server',
      sessionKey: 'codex-a',
      sourceMsgId: 44,
      providerSessionId: 'thread-clean-restart',
      providerTurnId: 'turn-clean-restart',
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      spawnProfileId: 'profile-clean-restart',
      eligible: true,
      reason: 'eligible',
    }]);
  });

  test('clean restart rejects every inexact Codex retirement or delivery proof', async (t) => {
    const cases = [
      ['output already attempted', { evidence: { outputAttempted: true } }],
      ['delivery still pending', { evidence: { pending: 1 } }],
      ['delivery not fenced', { evidence: { fenced: false } }],
      ['wrong disposition', { retirement: { disposition: 'completed' } }],
      ['wrong session', { retirement: { sessionKey: 'codex-other' } }],
      ['wrong generation', { retirement: { generationId: 'generation-other' } }],
      ['wrong attempt', { retirement: { attemptId: 'attempt-other' } }],
      ['wrong provider session', { retirement: { providerSessionId: 'thread-other' } }],
      ['wrong provider turn', { retirement: { providerTurnId: 'turn-other' } }],
      ['wrong source message', { retirement: { sourceMsgId: 45 } }],
      ['wrong terminal status', { settlement: { terminalStatus: 'completed' } }],
      ['wrong settled turn', { settlement: { turnId: 'turn-other' } }],
    ];

    for (const [name, overrides] of cases) {
      await t.test(name, async () => {
        const { pm } = runtimeManager({
          processOptions: {
            settlementOverrides: {
              terminalStatus: 'interrupted',
              turnId: 'turn-clean-restart',
              ...overrides.settlement,
            },
          },
          codexRetirementVerifier: async (input) => Object.freeze({
            committed: true,
            disposition: 'stop-cancelled',
            sessionKey: input.sessionKey,
            generationId: input.generationId,
            attemptId: 'attempt-clean-restart',
            providerSessionId: 'thread-clean-restart',
            providerTurnId: 'turn-clean-restart',
            sourceMsgId: 44,
            ...overrides.retirement,
          }),
        });
        const proc = await pm.getOrSpawn('codex-a', {
          runtime: 'codex',
          spawnProfileId: 'profile-clean-restart',
        });
        proc.captureCleanRestartCandidate = () => Object.freeze({
          runtime: 'codex',
          namespace: 'codex:app-server',
          sessionKey: 'codex-a',
          generationId: proc.generationId,
          attemptId: 'attempt-clean-restart',
          providerSessionId: 'thread-clean-restart',
          providerTurnId: 'turn-clean-restart',
          sourceMsgId: 44,
          cwd: '/workspace',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          spawnProfileId: 'profile-clean-restart',
        });

        const [snapshot] = await pm.retireForCleanRestart({
          getDeliveryEvidence: async () => Object.freeze({
            outputAttempted: false,
            pending: 0,
            fenced: true,
            ...overrides.evidence,
          }),
        });

        assert.equal(snapshot.eligible, false);
        assert.equal(proc.closed, true);
        assert.equal(pm.size, 0);
      });
    }
  });

  test('clean restart retires Codex even when delivery evidence fails', async () => {
    const { pm } = runtimeManager({
      codexRetirementVerifier: async (input) => Object.freeze({
        committed: true,
        disposition: 'stop-cancelled',
        sessionKey: input.sessionKey,
        generationId: input.generationId,
        attemptId: 'attempt-evidence-failure',
        providerSessionId: 'thread-evidence-failure',
        providerTurnId: 'turn-evidence-failure',
        sourceMsgId: 45,
      }),
      processOptions: {
        settlementOverrides: {
          terminalStatus: 'interrupted',
          turnId: 'turn-evidence-failure',
        },
      },
    });
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'profile-evidence-failure',
    });
    proc.captureCleanRestartCandidate = () => Object.freeze({
      runtime: 'codex',
      namespace: 'codex:app-server',
      sessionKey: 'codex-a',
      generationId: proc.generationId,
      attemptId: 'attempt-evidence-failure',
      providerSessionId: 'thread-evidence-failure',
      providerTurnId: 'turn-evidence-failure',
      sourceMsgId: 45,
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      spawnProfileId: 'profile-evidence-failure',
    });

    await assert.rejects(
      pm.retireForCleanRestart({
        getDeliveryEvidence: async () => { throw new Error('evidence unavailable'); },
      }),
      /evidence unavailable/,
    );

    assert.equal(proc.interruptCount, 1);
    assert.deepEqual(proc._killSpy, ['clean-restart']);
    assert.equal(proc.closed, true);
    assert.equal(pm.size, 0);
  });

  test('Codex retirement keeps the daemon lease fenced until its durable consumer verifies disposal', async () => {
    const retirement = deferred();
    const calls = [];
    const { pm } = runtimeManager({
      codexRetirementVerifier: async (input) => {
        calls.push(input);
        return retirement.promise;
      },
    });
    const first = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'one',
    });

    let interrupted = false;
    const stop = pm.interrupt('codex-a').then((value) => {
      interrupted = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(first.state, 'Closed');
    assert.equal(interrupted, false);
    assert.equal(pm.has('codex-a'), true);
    assert.equal(pm._codexLease?.generationId, first.generationId);
    await assert.rejects(
      pm.getOrSpawn('codex-b', {
        runtime: 'codex',
        spawnProfileId: 'two',
      }),
      (error) => error.code === 'CODEX_DAEMON_GENERATION_BUSY',
    );
    assert.equal(calls.length, 1);
    const [{ signal, ...verificationInput }] = calls;
    assert.deepEqual(verificationInput, {
      sessionKey: 'codex-a',
      generationId: first.generationId,
      reason: 'interrupt',
      terminalStatus: null,
      turnId: null,
    });
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, false);

    retirement.resolve({ committed: true, disposition: 'stop-cancelled' });
    assert.equal(await stop, true);
    assert.equal(pm.has('codex-a'), false);
    assert.equal(pm._codexLease, null);
    await pm.getOrSpawn('codex-b', {
      runtime: 'codex',
      spawnProfileId: 'two',
    });
  });

  test('a never-resolving retirement verifier times out with the exact generation still fenced', async () => {
    let verifierSignal = null;
    const { pm, constructions } = runtimeManager({
      codexRetirementVerifier: ({ signal }) => {
        verifierSignal = signal;
        return new Promise(() => {});
      },
      codexRetirementTimeoutMs: 20,
    });
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'one',
    });
    const lease = pm._codexLease;

    await assert.rejects(
      pm.kill('codex-a', 'verifier-timeout'),
      (error) => (
        error instanceof Error
        && error.code === 'CODEX_RETIREMENT_VERIFICATION_FAILED'
      ),
    );

    assert.equal(proc.closed, true);
    assert.equal(pm.get('codex-a'), proc);
    assert.equal(pm._codexLease, lease);
    assert.equal(lease.proc, proc);
    assert.equal(lease.generationId, proc.generationId);
    assert.equal(lease.quarantined, true);
    assert.equal(verifierSignal?.aborted, true);
    assert.equal(pm._retiring.has(proc), true);

    const cleanupCommitted = containmentCleanupDetail(proc);
    proc.containmentCleanupCommitted = cleanupCommitted;
    proc.emit('close', 1, cleanupCommitted);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(pm._retiring.has(proc), true);
    assert.equal(pm.get('codex-a'), proc);
    assert.equal(pm._codexLease, lease);
    await assert.rejects(
      pm.send('codex-a', 'must remain fenced'),
      (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
    );
    assert.deepEqual(proc._sendSpy, []);
    await assert.rejects(
      pm.getOrSpawn('codex-a', {
        runtime: 'claude',
        spawnProfileId: 'claude-profile',
      }),
      (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
    );
    assert.equal(pm.get('codex-a'), proc);
    assert.equal(pm._codexLease, lease);
    assert.equal(constructions.length, 1);
  });

  test('a rejected retirement verifier returns a typed error without releasing or reviving ownership', async () => {
    const checkpointError = new Error('retirement checkpoint unavailable');
    const { pm } = runtimeManager({
      codexRetirementVerifier: async () => {
        throw checkpointError;
      },
      codexRetirementTimeoutMs: 100,
    });
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'one',
    });
    const lease = pm._codexLease;

    await assert.rejects(
      pm.interrupt('codex-a'),
      (error) => (
        error.code === 'CODEX_RETIREMENT_VERIFICATION_FAILED'
        && error.cause === checkpointError
      ),
    );

    assert.equal(pm.get('codex-a'), proc);
    assert.equal(pm._codexLease, lease);
    assert.equal(lease.proc, proc);
    assert.equal(lease.quarantined, true);
  });

  test('expected-process retirement distinguishes durable verifier and containment failures', async (t) => {
    await t.test('durable verifier failure retains the exact retiring fence', async () => {
      const checkpointError = new Error('retirement checkpoint unavailable');
      const { pm, constructions } = runtimeManager({
        codexRetirementVerifier: async () => {
          throw checkpointError;
        },
        codexRetirementTimeoutMs: 100,
      });
      const proc = await pm.getOrSpawn('codex-a', {
        runtime: 'codex',
        spawnProfileId: 'one',
      });
      const lease = pm._codexLease;

      await assert.rejects(
        pm.retireExpectedProcess(
          'codex-a',
          proc,
          'expected-process-verification',
        ),
        (error) => (
          error.code === 'CODEX_RETIREMENT_VERIFICATION_FAILED'
          && error.cause === checkpointError
        ),
      );

      assert.equal(pm._retiring.has(proc), true);
      assert.equal(pm.get('codex-a'), proc);
      assert.equal(pm._codexLease, lease);
      await assert.rejects(
        pm.getOrSpawn('codex-a', {
          runtime: 'claude',
          spawnProfileId: 'replacement',
        }),
        (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
      );
      assert.equal(pm.get('codex-a'), proc);
      assert.equal(pm._codexLease, lease);
      assert.equal(constructions.length, 1);
    });

    await t.test('containment failure permits later exact cleanup', async () => {
      const { pm } = runtimeManager({
        processOptions: { containOnKill: true },
      });
      const proc = await pm.getOrSpawn('codex-a', {
        runtime: 'codex',
        spawnProfileId: 'one',
      });

      await assert.rejects(
        pm.retireExpectedProcess(
          'codex-a',
          proc,
          'expected-process-containment',
        ),
        (error) => error.code === 'CODEX_RETIREMENT_UNVERIFIED',
      );
      assert.equal(pm._retiring.has(proc), false);
      assert.equal(pm.get('codex-a'), proc);
      assert.equal(pm._codexLease?.proc, proc);

      const cleanupCommitted = containmentCleanupDetail(proc);
      proc.containmentCleanupCommitted = cleanupCommitted;
      proc.emit('close', 1, cleanupCommitted);
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(pm.get('codex-a'), null);
      assert.equal(pm._codexLease, null);
    });
  });

  test('shutdown fails within the retirement bound and retains the exact Codex fence', async () => {
    const { pm } = runtimeManager({
      codexRetirementVerifier: () => new Promise(() => {}),
      codexRetirementTimeoutMs: 20,
    });
    const proc = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'one',
    });
    const lease = pm._codexLease;
    const startedAt = Date.now();

    await assert.rejects(
      pm.shutdown(),
      (error) => error.code === 'CODEX_RETIREMENT_VERIFICATION_FAILED',
    );

    assert.ok(
      Date.now() - startedAt < 500,
      'shutdown must fail on the configured verifier deadline',
    );
    assert.equal(pm.get('codex-a'), proc);
    assert.equal(pm._codexLease, lease);
    assert.equal(lease.proc, proc);
    assert.equal(lease.quarantined, true);
  });

  test('kill performs healthy Codex settlement and close before map/lease release', async () => {
    const { pm } = runtimeManager();
    const first = await pm.getOrSpawn('codex-a', {
      runtime: 'codex',
      spawnProfileId: 'one',
    });
    await pm.kill('codex-a', 'reset');
    assert.equal(first.state, 'Closed');
    assert.equal(pm.has('codex-a'), false);
    await pm.getOrSpawn('codex-b', {
      runtime: 'codex',
      spawnProfileId: 'two',
    });
    assert.equal(pm.has('codex-b'), true);
  });

  test('public Codex interrupt retires the stopped generation so a follow-up turn can resume', async () => {
    const { pm, constructions } = runtimeManager();
    const context = {
      runtime: 'codex',
      spawnProfileId: 'one',
    };
    const first = await pm.getOrSpawn('chat', context);

    assert.equal(await pm.interrupt('chat'), true);
    assert.equal(first.state, 'Closed');
    assert.equal(pm.has('chat'), false);
    assert.equal(pm._codexLease, null);

    const resumed = await pm.getOrSpawn('chat', context);
    assert.notEqual(resumed, first);
    assert.equal(constructions.length, 2);
  });

  test('late external callbacks are fenced by object + generation while internal close cleanup remains live', async () => {
    const calls = [];
    const { pm } = runtimeManager({
      callbacks: {
        onResult: (sessionKey, payload) => calls.push([sessionKey, payload]),
      },
    });
    const old = await pm.getOrSpawn('chat', {
      runtime: 'claude',
      spawnProfileId: 'old',
    });
    const current = await pm.getOrSpawn('chat', {
      runtime: 'claude',
      spawnProfileId: 'new',
    });
    old.emitResult({ text: 'late' });
    old.emitClose();
    current.emitResult({ text: 'current' });
    assert.deepEqual(calls, [['chat', { text: 'current' }]]);
    assert.equal(pm.get('chat'), current, 'stale close cannot remove current process');

    current.generationId = 'mutated-generation';
    current.emitResult({ text: 'wrong generation' });
    assert.equal(calls.length, 1);
  });

  test('state-changing dispatch is fenced during replacement; interrupt and drain remain available', async () => {
    const gate = deferred();
    const { pm } = runtimeManager({
      processOptions: { interruptGate: gate },
    });
    const old = await pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'old',
    });
    old.pendingQueue.push({ reject() {} });
    const replacement = pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'new',
    });
    await new Promise((resolve) => setImmediate(resolve));

    for (const call of [
      () => pm.send('chat', 'message'),
      () => pm.steerTurn('chat', 'steer'),
      () => pm.setModel('chat', 'model'),
      () => pm.applyFlagSettings('chat', {}),
      () => pm.setPermissionMode('chat', 'default'),
      () => pm.resetSession('chat'),
    ]) {
      await assert.rejects(
        call(),
        (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
      );
    }
    assert.equal(pm.injectUserMessage('chat', { content: 'x' }), false);
    assert.equal(pm.steer('chat', 'x'), false);
    assert.equal(pm.answerQuestion('chat', 'tool', {}), false);
    assert.equal(pm.drainQueue('chat', 'TEST'), 1);
    const interrupt = pm.interrupt('chat');
    gate.resolve();
    assert.equal(await interrupt, true);
    await replacement;
    assert.equal(old.interruptCount, 1, 'interrupt remains idempotent');
  });

  test('shutdown-in-progress fences state-changing dispatch but keeps interrupt/drain available', async () => {
    const gate = deferred();
    const { pm } = runtimeManager({
      processOptions: { interruptGate: gate },
    });
    const proc = await pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'profile',
    });
    proc.pendingQueue.push({ reject() {} });
    const shutdown = pm.shutdown();
    await new Promise((resolve) => setImmediate(resolve));

    for (const call of [
      () => pm.send('chat', 'message'),
      () => pm.steerTurn('chat', 'steer'),
      () => pm.setModel('chat', 'model'),
      () => pm.applyFlagSettings('chat', {}),
      () => pm.setPermissionMode('chat', 'default'),
      () => pm.resetSession('chat'),
    ]) {
      await assert.rejects(
        call(),
        (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
      );
    }
    assert.equal(pm.injectUserMessage('chat', { content: 'x' }), false);
    assert.equal(pm.steer('chat', 'x'), false);
    assert.equal(pm.answerQuestion('chat', 'tool', {}), false);
    assert.equal(pm.drainQueue('chat', 'TEST'), 1);
    const interrupt = pm.interrupt('chat');
    gate.resolve();
    assert.equal(await interrupt, true);
    await shutdown;
  });

  test('internal competitor replacement fences dispatch through the retiring process identity', async () => {
    const killGate = deferred();
    const created = [];
    const pm = new ProcessManager({
      budget: 2,
      lruWaitMs: 500,
      processFactory: (sessionKey, ctx) => {
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'claude',
          spawnProfileId: ctx.spawnProfileId ?? null,
          generationId: `generation-${created.length + 1}`,
        });
        created.push(proc);
        return proc;
      },
    });
    const first = await pm.getOrSpawn('blocker-1', { runtime: 'claude' });
    const second = await pm.getOrSpawn('blocker-2', { runtime: 'claude' });
    first.inFlight = true;
    second.inFlight = true;
    const spawn = pm.getOrSpawn('target', {
      runtime: 'claude',
      spawnProfileId: 'wanted',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const competitor = new RuntimeProcess({ sessionKey: 'target' }, {
      runtime: 'claude',
      spawnProfileId: 'other',
      generationId: 'competitor-generation',
      killGate,
    });
    pm.procs.set('target', competitor);
    pm.procs.delete('blocker-1');
    pm.procs.delete('blocker-2');
    pm._maybeSignalLruWaiter();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pm._replacing.has('target'), false);
    assert.equal(pm._retiring.has(competitor), true);

    await assert.rejects(
      pm.send('target', 'must not reach retiring proc'),
      (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
    );
    await assert.rejects(
      pm.steerTurn('target', 'must not steer retiring proc'),
      (error) => error.code === 'RUNTIME_SWITCH_IN_FLIGHT',
    );
    assert.equal(pm.injectUserMessage('target', { content: 'x' }), false);
    assert.equal(pm.steer('target', 'x'), false);
    assert.equal(pm.answerQuestion('target', 'tool', {}), false);

    killGate.resolve();
    const replacement = await spawn;
    assert.notEqual(replacement, competitor);
    assert.equal(replacement.spawnProfileId, 'wanted');
  });

  test('Codex start rejection releases only with the narrow startupReleaseSafe + closed contract', async () => {
    let construction = 0;
    const terminations = [];
    const pm = new ProcessManager({
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      callbacks: {
        onAbnormalTermination: (...args) => terminations.push(args),
      },
      processFactory: (sessionKey, ctx) => {
        construction += 1;
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'codex',
          spawnProfileId: ctx.spawnProfileId,
          generationId: `generation-${construction}`,
        });
        if (construction === 1) {
          proc.start = () => {
            proc.startupReleaseSafe = true;
            proc.closed = true;
            proc.state = 'Closed';
            proc.emit('close', 1, {
              backend: 'codex',
              generationId: proc.generationId,
              reason: null,
            });
            throw new Error('safe startup rejection');
          };
        }
        return proc;
      },
    });
    await assert.rejects(
      pm.getOrSpawn('first', {
        runtime: 'codex',
        spawnProfileId: 'first-profile',
      }),
      /safe startup rejection/,
    );
    assert.equal(pm.get('first'), null);
    assert.equal(pm._codexLease, null);
    assert.deepEqual(terminations, []);
    await pm.getOrSpawn('second', {
      runtime: 'codex',
      spawnProfileId: 'second-profile',
    });
    assert.equal(construction, 2);
  });

  test('Codex ambiguous startup close reports abnormal termination', async () => {
    const terminations = [];
    const pm = new ProcessManager({
      codexRecoveryState: { status: 'clear' },
      codexHostIdentity: 'host-a',
      codexBootSessionIdentity: 'boot-new',
      callbacks: {
        onAbnormalTermination: (_sessionKey, evidence) => {
          terminations.push(evidence);
        },
      },
      processFactory: (sessionKey, ctx) => {
        const proc = new RuntimeProcess({ sessionKey }, {
          runtime: 'codex',
          spawnProfileId: ctx.spawnProfileId,
          generationId: 'generation-unsafe',
        });
        proc.start = () => {
          proc.closed = true;
          proc.state = 'ContainmentFailed';
          proc.emit('close', 1, {
            backend: 'codex',
            generationId: proc.generationId,
            reason: 'startup-close-unverified',
          });
          throw new Error('unsafe startup rejection');
        };
        return proc;
      },
    });

    await assert.rejects(
      pm.getOrSpawn('unsafe', {
        runtime: 'codex',
        spawnProfileId: 'profile-unsafe',
      }),
      /unsafe startup rejection/,
    );
    assert.equal(terminations.length, 1);
    assert.equal(terminations[0].event, 'close');
  });

  test('concurrent replacement and kill serialize without double-retiring or reviving a closed generation', async () => {
    const gate = deferred();
    const { pm, constructions } = runtimeManager({
      processOptions: { interruptGate: gate },
    });
    const old = await pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'old',
    });
    const replacement = pm.getOrSpawn('chat', {
      runtime: 'codex',
      spawnProfileId: 'new',
    });
    const kill = pm.kill('chat', 'concurrent-kill');
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolve();
    const replacementProc = await replacement;
    assert.equal(await kill, true);
    assert.equal(old.interruptCount, 1);
    assert.equal(replacementProc.interruptCount, 1);
    assert.equal(pm.has('chat'), false);
    assert.equal(pm._codexLease, null);
    assert.equal(constructions.length, 2);
  });

  test('failed retirement keeps a closed contained process and lease fenced', async (t) => {
    for (const operation of ['kill', 'replacement']) {
      await t.test(operation, async () => {
        const { pm, constructions } = runtimeManager({
          processOptions: { containOnKill: true },
        });
        const original = await pm.getOrSpawn('chat', {
          runtime: 'codex',
          spawnProfileId: 'profile',
        });
        const retirement = operation === 'kill'
          ? pm.kill('chat', 'test-close-race')
          : pm.getOrSpawn('chat', {
              runtime: 'claude',
              spawnProfileId: 'replacement',
            });
        await assert.rejects(
          retirement,
          (error) => (
            error.code === (
              operation === 'kill'
                ? 'CODEX_RETIREMENT_UNVERIFIED'
                : 'RUNTIME_SWITCH_EVICTION_FAILED'
            )
          ),
        );
        assert.equal(pm.get('chat'), original);
        assert.equal(pm._codexLease?.proc, original);
        assert.equal(pm._codexLease?.quarantined, true);
        assert.equal(
          constructions.length,
          1,
          'a replacement is never constructed before exact cleanup release',
        );
      });
    }
  });
});
