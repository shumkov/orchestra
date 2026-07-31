// provenance: polygram@0.17.11 lib/process-manager.js (git 746bca6) — verbatim: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * ProcessManager — generic collection of `Process` instances.
 *
 * Holds Map<sessionKey, Process>. Doesn't know or care which concrete
 * Process subclass it's holding. SdkProcess + TmuxProcess both
 * implement the same `lib/process/process.js` interface.
 *
 * Per-session dispatch (send, kill, interrupt, etc.) just delegates
 * to the Process. Collection logic (LRU eviction, killChat, shutdown)
 * lives here.
 *
 * Weighted LRU per Phase 0 F-spike-2: tmux backend is ~10× SDK pm's
 * RSS (545MB vs 50MB). We evict to keep Σ Process.cost ≤ budget
 * rather than count ≤ cap. Default: SDK cost=1, tmux cost=3,
 * budget=10 → "10 SDK | 3 tmux | mixed in between."
 *
 * Lifecycle callbacks (onInit, onClose, onStreamChunk, etc.) get wired
 * to each Process's EventEmitter at spawn. Process emits, pm forwards
 * to operator's callback.
 *
 * Phase 1 only (this file): SDK-only factory; ProcessManager behaviour
 * matches the current `lib/sdk/process-manager.js` API exactly. After
 * Phase 1 lands and tests pass, the old per-bot pm class is deleted.
 *
 * See `docs/0.10.0-process-manager-abstraction-plan.md` for the full
 * design.
 */

'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_BUDGET = 10;        // total Σ cost (SDK cost=1, tmux cost=3)
const DEFAULT_LRU_WAIT_MS = 300_000;
const DEFAULT_CODEX_RETIREMENT_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_ID_BYTES = 512;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

class ProcessManagerError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'ProcessManagerError';
    this.code = code;
  }
}

function managerError(message, code, options) {
  return new ProcessManagerError(message, code, options);
}

/**
 * Identify a display hint in telemetry without storing it. The hint is a
 * multi-KB system-prompt block and the events table has no retention, so only
 * a fingerprint may be logged — enough to tell a real toggle (two reloads, two
 * different fingerprints) from a treadmill (the same pair, over and over).
 */
function hintFingerprint(hint) {
  return createHash('sha256')
    .update(typeof hint === 'string' ? hint : '')
    .digest('hex')
    .slice(0, 8);
}

function findCodexRetirementVerificationError(error) {
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current.code === 'CODEX_RETIREMENT_VERIFICATION_FAILED') {
      return current;
    }
    current = current.cause;
  }
  return null;
}

function isOpaqueId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_RUNTIME_ID_BYTES
    && !CONTROL_CHAR_RE.test(value)
  );
}

function snapshotModelSettings(settings) {
  if (settings == null) return null;
  return Object.freeze({
    model: settings.model,
    effort: settings.effort,
  });
}

function requireModelSettings(settings, label) {
  if (
    !settings
    || typeof settings !== 'object'
    || Array.isArray(settings)
    || Object.keys(settings).some((key) => !['model', 'effort'].includes(key))
    || !isOpaqueId(settings.model)
    || !isOpaqueId(settings.effort)
  ) {
    throw new TypeError(
      `ProcessManager: ${label} requires model and effort`,
    );
  }
  return Object.freeze({
    model: settings.model,
    effort: settings.effort,
  });
}

// callback name → event name
const CALLBACK_TO_EVENT = {
  onInit:                       'init',
  onClose:                      'close',
  onResult:                     'result',
  onStreamChunk:                'stream-chunk',
  onToolUse:                    'tool-use',
  onAssistantMessageStart:      'assistant-message-start',
  onAutonomousAssistantMessage: 'autonomous-assistant-message',
  onCompactBoundary:            'compact-boundary',
  // 0.12.0-rc.13: per-chat compaction warning. CliProcess emits
  // 'compaction-warn' {kind:'proactive'|'reactive', pct?} when (proactive)
  // context crosses the chat's threshold at turn-end, or (reactive) claude is
  // auto-compacting now. The callback posts a chat message proposing /compact
  // — opt-in per chat. See docs/0.12.0-file-send.md / lib/compaction-warn.js.
  onCompactionWarn:             'compaction-warn',
  // 0.12.0 background-work visibility (Use 3). CliProcess emits 'bg-work-status'
  // {state:'running'|'cleared', count?} when a detached background shell is first
  // observed running idle past its turn, and again when it clears. The callback
  // posts/edits a "⏳ working in background" status message so a long job reads as
  // working, not stuck. See docs/0.12.0-background-work-lifecycle-plan.md.
  onBgWorkStatus:               'bg-work-status',
  // 0.16 busy-aware ceiling: CliProcess emits 'turn-extended' the FIRST time a
  // turn passes the 30-min checkpoint while still provably working. The callback
  // posts a one-time "⏳ still working — /stop to cancel" message so a long turn
  // reads as alive (not the old false "stream interrupted"). See
  // docs/0.16-turn-ceiling-busy-aware-spec.md.
  onTurnExtended:               'turn-extended',
  // 0.12 interactive questions: CliProcess emits 'question-asked'
  // {sessionKey, chatId, threadId, turnId, toolCallId, questions} when claude calls
  // the `ask` tool. The callback (polygram) renders the Telegram inline keyboard;
  // the user's tap/typed answer routes back via pm.answerQuestion → writeQuestionAnswer.
  onQuestionAsked:              'question-asked',
  // 0.12.0 question-progress-resume: CliProcess emits 'question-resumed' (no payload) when a
  // blocking `ask` resolves with a real answer and the turn resumes working. The callback
  // re-arms the per-turn reactor (it cleared during the wait, no hooks re-lit it). See
  // docs/0.12.0-question-resume-progress-spec.md.
  onQuestionResumed:            'question-resumed',
  // 0.13 D2: CliProcess emits 'input-dropped' {turnId, msgId, chatId, source}
  // when a ledgered input was confirmed dropped (never seen/acked by cycle-end
  // + confirm window, contract observed). polygram redelivers ONCE via the D4
  // tail (lib/handlers/drop-redeliver.js).
  onInputDropped:               'input-dropped',
  onQueueDrop:                  'queue-drop',
  onThinking:                   'thinking',
  // Tmux backend: TUI shows in-pane approval prompt. SDK backend
  // uses canUseTool callback directly (no event). Polygram wires
  // onApprovalRequired to route tmux prompts through the SAME
  // approval card UI used by SDK's canUseTool flow.
  onApprovalRequired:           'approval-required',
  // 0.13 P4: the tmux-era rows (onExtraTurnReply/-Started, onAutosteerResolution/
  // -MatchMiss) were removed — zero emitters on any backend since the 0.12 tmux
  // deletion; the 'autosteer-resolution' audit trail returns as D2 ledger events.
  // 0.13 D3: 'turn-start' (UserPromptSubmit; payload {hasPending, anchorMsgId})
  // and 'idle' get polygram-side consumers — the session feedback controller's
  // start/stop edges for cycles with no pending turn. ('idle' is ALSO wired
  // internally for LRU waiters in _wireCallbacks — both fire.)
  onTurnStart:                  'turn-start',
  onIdle:                       'idle',
  // R8: tmux backend autosteer paste failure. TmuxProcess.injectUserMessage
  // fires `inject-fail` when its fire-and-forget paste rejects. Before
  // this was wired the event had no consumer — a failed autosteer was
  // silent until the stale-turn sweep caught it turnTimeoutMs later.
  // The handler logs the failure and clears the ✍ on the failed msgId.
  onInjectFail:                 'inject-fail',
  // 0.10.0: tmux backend turn-phase predicate (observer-only Commit 1
  // of the patience-model unification — see docs/0.10.0-tmux-patience-
  // model-solution.md). TmuxProcess emits `phase-change` on every
  // TurnPhase transition; polygram persists it as `turn-phase-change`
  // in the events DB so the soak can verify the predicate's
  // trajectory against real workloads before Commits 2-3 start
  // consuming turn.phase for control flow. SDK backend never emits
  // this — predicate is tmux-specific.
  onPhaseChange:                'phase-change',
  // 0.10.0 H1: tmux backend hook-based turn observability. TmuxProcess
  // tails a per-session ndjson that claude appends to via
  // `--settings`-injected command hooks (PreToolUse/PostToolUse/
  // UserPromptSubmit/Stop/SubagentStop/Notification). Each event is
  // forwarded here so polygram persists it as `hook-event` in the
  // events DB for the H1 soak. OBSERVER-ONLY — no control flow
  // consumes the events yet (mirrors Commit 1 of the patience-model
  // unification). SDK backend never emits — hooks are tmux-specific.
  // See docs/0.10.0-tmux-hook-observability.md.
  onHookEvent:                  'hook-event',
  // 0.10.0 rc.42 (review-driven #1): tmux backend turn-timeout event.
  // Mirrors sdk-process.js's `_logEvent('turn-timeout', ...)` so both
  // backends emit the same diagnostic. Payload distinguishes
  // `idle-ceiling` vs `hard-backstop` (the H3 racers) so operators can
  // tell a wedged-silent subagent from a runaway tool loop.
  onTurnTimeout:                'turn-timeout',
  // 0.10.0 rc.42 (review-driven #8): tmux backend hook-tail
  // degradation event. The hook ndjson is load-bearing for H3 idle
  // heartbeats; a persistently broken tail silently resurrects
  // msg-884-class kills. Emitting the event surfaces the degradation
  // in the events DB so it's visible in forensics, not just
  // logger.warn.
  onHookTailError:              'hook-tail-error',
  // 0.10.0 rc.42 (review-driven #15): tmux backend stop-hook-resolved
  // event. Fires when a turn settled via the H4 Stop-hook synth path
  // instead of the canonical JSONL `result` (i.e. JSONL was broken or
  // stuck and Stop rescued the turn). The synth's `via: 'stop-hook'`
  // field was previously dead — only the tests read it. Persisting
  // the event lets the soak count how often H4 actually fires its
  // rescue contract.
  onStopHookResolved:           'stop-hook-resolved',
  // 0.10.0 rc.43: claude TUI's "This session is N old…" interactive
  // menu auto-dismissed by `_waitForReady`. Surfacing the event so
  // soak can count how often aged-session resumes hit this path.
  onSessionAgePromptDismissed:  'session-age-prompt-dismissed',
  // 0.12 CliProcess observability — typed hook events from cli-process.js
  // _handleHookEvent. Each gets its own callback so polygram can persist
  // structured rows to the events DB for soak-time aggregate queries.
  //   - hook-lag-sample: Phase 1.8 — per-event lag_ms (target: median<2s, p99<5s)
  //   - tool-result:     Phase 1.3 — PostToolUse durationMs per tool
  //   - subagent-start / subagent-done: Phase 1.3 — typed subagent lifecycle
  //     (we DO get tool-use='Agent' via onToolUse, but agent_type + durationMs
  //      only fire on these typed events). SDK backend never emits — hooks
  //     are CliProcess-specific (and were tmux-specific in 0.10–0.11).
  onHookLagSample:              'hook-lag-sample',
  onToolResult:                 'tool-result',
  onSubagentStart:              'subagent-start',
  onSubagentDone:               'subagent-done',
};

class ProcessManager {
  /**
   * @param {object} opts
   * @param {(sessionKey: string, ctx: object) => Process} opts.processFactory
   *   — required. Returns a Process instance (not yet started).
   * @param {number} [opts.budget=10] — weighted LRU budget
   * @param {object} [opts.db] — used for _logEvent (matches today's pm)
   * @param {object} [opts.logger=console]
   * @param {object} [opts.callbacks={}] — keys: onInit, onClose, ...
   * @param {number} [opts.lruWaitMs] — how long getOrSpawn parks
   *   when all entries are in-flight
   * @param {(input: object) => Promise<{committed: true}>}
   *   [opts.codexRetirementVerifier] — consumer durability handshake.
   * @param {number} [opts.codexRetirementTimeoutMs=30000]
   *   — absolute deadline for the optional durability handshake.
   */
  constructor({
    processFactory,
    budget = DEFAULT_BUDGET,
    db,
    logger = console,
    callbacks = {},
    lruWaitMs = DEFAULT_LRU_WAIT_MS,
    codexRecoveryState,
    codexHostIdentity = null,
    codexBootSessionIdentity = null,
    codexRetirementVerifier = null,
    codexRetirementTimeoutMs = DEFAULT_CODEX_RETIREMENT_TIMEOUT_MS,
  } = {}) {
    if (typeof processFactory !== 'function') {
      throw new TypeError('ProcessManager: processFactory function required');
    }
    this.processFactory = processFactory;
    this.budget = budget;
    this.db = db;
    this.logger = logger;
    this.callbacks = { ...callbacks };
    this.lruWaitMs = lruWaitMs;
    this.procs = new Map();           // sessionKey → Process
    this._lruWaiters = [];            // [{ resolve, reject, timer }]
    this._shuttingDown = false;
    // sessionKey → in-flight start() Promise. Lets a concurrent
    // getOrSpawn for the same key await the spawn instead of
    // returning a proc whose start() hasn't resolved (see getOrSpawn).
    this._starting = new Map();
    // sessionKey → { identityKey, promise }. Runtime/profile replacement is
    // single-flight so concurrent messages cannot install two generations.
    this._replacing = new Map();
    this._lifecycleGates = new Map();
    this._retirementIntents = new Map();
    this._retiring = new WeakSet();
    this._procIdentities = new WeakMap();

    // Native Codex beta ownership. Recovery is deliberately not ready by
    // default: the consumer must first restore the persisted daemon-wide
    // record, even when that record says no generation was live.
    this.codexHostIdentity = codexHostIdentity;
    this.codexBootSessionIdentity = codexBootSessionIdentity;
    if (
      codexRetirementVerifier != null
      && typeof codexRetirementVerifier !== 'function'
    ) {
      throw new TypeError(
        'ProcessManager: codexRetirementVerifier function required',
      );
    }
    this.codexRetirementVerifier = codexRetirementVerifier;
    if (
      !Number.isSafeInteger(codexRetirementTimeoutMs)
      || codexRetirementTimeoutMs < 1
    ) {
      throw new TypeError(
        'ProcessManager: codexRetirementTimeoutMs positive integer required',
      );
    }
    this.codexRetirementTimeoutMs = codexRetirementTimeoutMs;
    this._codexRecoveryReady = false;
    this._codexLease = null;
    if (codexRecoveryState !== undefined) {
      this.restoreCodexRecoveryState(codexRecoveryState);
    }
  }

  // ─── Introspection ───────────────────────────────────────────────

  has(sessionKey) { return this.procs.has(sessionKey); }
  get(sessionKey) { return this.procs.get(sessionKey) || null; }
  keys() { return [...this.procs.keys()]; }
  get size() { return this.procs.size; }

  /**
   * Current total cost across all live processes.
   */
  get totalCost() {
    let sum = 0;
    for (const p of this.procs.values()) {
      if (!p.closed) sum += p.cost;
    }
    return sum;
  }

  /**
   * Restore the persisted native-Codex ownership record before accepting any
   * Codex spawn. A quarantined record remains fenced until the caller has
   * durably settled recovery and explicitly restores a clear record.
   *
   * @param {{status: 'clear'}|{
   *   status: 'quarantined',
   *   hostIdentity: string,
   *   bootSessionIdentity: string,
   *   generationId: string
   * }} state
   */
  restoreCodexRecoveryState(state) {
    if (this._codexLease || this._hasLiveCodexProcess()) {
      throw managerError(
        'Codex recovery state cannot change while ownership is live',
        'CODEX_RECOVERY_ALREADY_ACTIVE',
      );
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('ProcessManager: codexRecoveryState object required');
    }
    if (state.status === 'clear') {
      this._codexLease = null;
      this._codexRecoveryReady = true;
      return;
    }
    if (
      state.status !== 'quarantined'
      || !isOpaqueId(state.hostIdentity)
      || !isOpaqueId(state.bootSessionIdentity)
      || !isOpaqueId(state.generationId)
    ) {
      throw new TypeError(
        'ProcessManager: invalid quarantined codexRecoveryState',
      );
    }
    this._codexRecoveryReady = true;
    this._codexLease = {
      kind: 'recovered-quarantine',
      generationId: state.generationId,
      quarantined: true,
    };
  }

  _hasLiveCodexProcess() {
    for (const proc of this.procs.values()) {
      if (this._isCodex(proc)) return true;
    }
    return false;
  }

  _desiredIdentity(spawnContext) {
    const requested = spawnContext?.runtime;
    const runtime = requested == null ? 'claude' : requested;
    if (runtime !== 'claude' && runtime !== 'codex') {
      throw managerError(
        'Unknown agent runtime',
        'RUNTIME_UNKNOWN',
      );
    }
    const spawnProfileId = spawnContext?.spawnProfileId ?? null;
    if (
      spawnProfileId != null
      && !isOpaqueId(spawnProfileId)
    ) {
      throw managerError(
        'Runtime spawnProfileId must be a bounded opaque identifier',
        'RUNTIME_PROFILE_INVALID',
      );
    }
    if (runtime === 'codex' && spawnProfileId == null) {
      throw managerError(
        'Codex runtime requires a spawnProfileId',
        'RUNTIME_PROFILE_INVALID',
      );
    }
    return {
      runtime,
      spawnProfileId,
      key: `${runtime}\0${spawnProfileId ?? ''}`,
    };
  }

  _identityFor(proc) {
    const recorded = this._procIdentities.get(proc);
    if (recorded) return recorded;
    const runtime = this._isCodex(proc) ? 'codex' : 'claude';
    const spawnProfileId = proc.spawnProfileId ?? null;
    return {
      runtime,
      spawnProfileId,
      key: `${runtime}\0${spawnProfileId ?? ''}`,
    };
  }

  _isCodex(proc) {
    return proc?.runtime === 'codex' || proc?.backend === 'codex';
  }

  _assertCodexResumeControls(spawnContext) {
    const policy = spawnContext?.resumePolicy;
    const expectedTurnId = spawnContext?.expectedInterruptedTurnId;
    if (
      (policy != null && policy !== 'require-interrupted-turn')
      || (policy !== 'require-interrupted-turn' && expectedTurnId != null)
    ) {
      throw managerError(
        'Invalid Codex strict resume controls',
        'CODEX_STRICT_RESUME_INVALID',
      );
    }
    if (policy !== 'require-interrupted-turn') return;
    const expectedSessionId = spawnContext.existingSessionId ?? null;
    if (!isOpaqueId(expectedSessionId) || !isOpaqueId(expectedTurnId)) {
      throw managerError(
        'Invalid Codex strict resume identity',
        'CODEX_STRICT_RESUME_INVALID',
      );
    }
  }

  _assertStrictResumeReuse(proc, spawnContext) {
    if (spawnContext?.resumePolicy !== 'require-interrupted-turn') return;
    const expectedSessionId = spawnContext.existingSessionId ?? null;
    const expectedTurnId = spawnContext.expectedInterruptedTurnId ?? null;
    const attestation = proc?.resumeAttestation;
    if (
      attestation?.resumed !== true
      || attestation.freshFallback !== false
      || attestation.idle !== true
      || attestation.sessionId !== expectedSessionId
      || attestation.interruptedTurnId !== expectedTurnId
    ) {
      throw managerError(
        'Warm Codex generation does not match strict resume identity',
        'CODEX_STRICT_RESUME_MISMATCH',
      );
    }
  }

  _isStateMutationFenced(sessionKey) {
    const proc = this.procs.get(sessionKey);
    return Boolean(
      this._shuttingDown
      || this._replacing.has(sessionKey)
      || (this._retirementIntents.get(sessionKey) ?? 0) > 0
      || (proc && this._retiring.has(proc)),
    );
  }

  _stateMutationFenceError() {
    return managerError(
      'Runtime replacement is in progress',
      'RUNTIME_SWITCH_IN_FLIGHT',
    );
  }

  _throwIfShuttingDown() {
    if (this._shuttingDown) throw new Error('shutdown');
  }

  _withLifecycleGate(sessionKey, operation) {
    const prior = this._lifecycleGates.get(sessionKey);
    const run = Promise.resolve(prior)
      .catch(() => {})
      .then(operation);
    this._lifecycleGates.set(sessionKey, run);
    run.finally(() => {
      if (this._lifecycleGates.get(sessionKey) === run) {
        this._lifecycleGates.delete(sessionKey);
        this._maybeSignalLruWaiter();
      }
    }).catch(() => {});
    return run;
  }

  _withRetirementIntent(sessionKey, operation) {
    const count = (this._retirementIntents.get(sessionKey) ?? 0) + 1;
    this._retirementIntents.set(sessionKey, count);
    let run;
    try {
      run = this._withLifecycleGate(sessionKey, operation);
    } catch (error) {
      this._releaseRetirementIntent(sessionKey);
      return Promise.reject(error);
    }
    run.finally(() => {
      this._releaseRetirementIntent(sessionKey);
    }).catch(() => {});
    return run;
  }

  _releaseRetirementIntent(sessionKey) {
    const remaining = (this._retirementIntents.get(sessionKey) ?? 1) - 1;
    if (remaining <= 0) {
      this._retirementIntents.delete(sessionKey);
    } else {
      this._retirementIntents.set(sessionKey, remaining);
    }
  }

  // ─── Spawn + LRU ─────────────────────────────────────────────────

  /**
   * Returns the Process for sessionKey, spawning if absent.
   * Evicts other processes (oldest non-in-flight first) to make room
   * when adding a new Process would exceed budget.
   *
   * @param {string} sessionKey
   * @param {object} spawnContext — passed through to processFactory + start()
   */
  getOrSpawn(sessionKey, spawnContext) {
    if (this._shuttingDown) return Promise.reject(new Error('shutdown'));
    let desired;
    try {
      desired = this._desiredIdentity(spawnContext);
      if (desired.runtime === 'codex') {
        this._assertCodexResumeControls(spawnContext);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const replacement = this._replacing.get(sessionKey);
    if (replacement) {
      if (replacement.identityKey !== desired.key) {
        return Promise.reject(managerError(
          'A different runtime replacement is already in progress',
          'RUNTIME_SWITCH_IN_FLIGHT',
        ));
      }
      return replacement.promise;
    }
    const existing = this.procs.get(sessionKey);
    if (existing && this._retiring.has(existing)) {
      return Promise.reject(this._stateMutationFenceError());
    }
    if (
      existing
      && !existing.closed
      && this._identityFor(existing).key !== desired.key
    ) {
      return this.replaceRuntime(sessionKey, spawnContext, desired);
    }
    return this._withLifecycleGate(sessionKey, () => (
      this._getOrSpawnLocked(sessionKey, spawnContext, desired)
    ));
  }

  async _getOrSpawnLocked(sessionKey, spawnContext, desired) {
    this._throwIfShuttingDown();
    const existing = this.procs.get(sessionKey);
    if (existing && this._retiring.has(existing)) {
      throw this._stateMutationFenceError();
    }
    if (existing && !existing.closed) {
      // getOrSpawn registers the proc in this.procs BEFORE awaiting
      // start(). A concurrent getOrSpawn for the same key (a second
      // Telegram message landing during the ~11s tmux spawn) would
      // otherwise get this still-spawning proc and call send() on it
      // — pasting a turn into a TUI that is not ready, which silently
      // drops the paste and returns an empty turn (shumorobot
      // production 2026-05-16: msg 2 of a 3-message burst returned
      // "No response generated"). Await the in-flight spawn so every
      // caller receives a proc whose start() has fully resolved.
      if (this._identityFor(existing).key !== desired.key) {
        return this._replaceRuntimeLocked(sessionKey, spawnContext, desired);
      }
      if (this._isCodex(existing)) {
        this._assertStrictResumeReuse(existing, spawnContext);
      }
      // Reload-on-drift (cli): a warm cli proc can't hot-swap model/effort or
      // its display hint (all spawn-time). If the resolved config has drifted
      // and the proc is idle, kill it (preserves session_id) and fall through to
      // a cold respawn → --resume keeps the conversation, the new
      // --model/--effort/hint takes effect. In-flight cli procs and SDK procs
      // (no wouldReloadFor — they apply model live) are reused unchanged.
      if (this._isCodex(existing) && existing.state === 'Stopped') {
        await this._killLocked(sessionKey, 'stopped-generation');
        this._throwIfShuttingDown();
      } else if (
        typeof existing.wouldReloadFor === 'function'
        && existing.wouldReloadFor(spawnContext)
      ) {
        // Which dimension(s) drifted — soak reads this to tell a per-chat
        // rendering toggle from a /model or /effort change. A hint reload also
        // carries both fingerprints (never the hint itself), so a session that
        // respawns on every message is distinguishable from one that toggled.
        const reasons = typeof existing.reloadReasonsFor === 'function'
          ? existing.reloadReasonsFor(spawnContext)
          : null;
        this._logEvent('cli-config-reload', {
          sessionKey,
          from_model: existing.model,
          from_effort: existing.effort,
          reason: reasons ? reasons.join(',') : null,
          ...(reasons?.includes('display-hint') && {
            from_hint_hash: hintFingerprint(existing.displayHint),
            to_hint_hash: hintFingerprint(spawnContext?.displayHint),
          }),
        });
        await this._killLocked(sessionKey, 'config-reload');
        this._throwIfShuttingDown();
        // fall through to the cold-spawn path below — respawns with --resume
      } else {
        if (
          this._isCodex(existing)
          && spawnContext?.modelSettings != null
        ) {
          const nextTurn = requireModelSettings(
            spawnContext.modelSettings,
            'Codex spawnContext.modelSettings',
          );
          const result = await existing.selectModelSettings(nextTurn);
          if (
            result?.outcome !== 'updated-live'
            || result.generationId !== existing.generationId
            || result.nextTurn?.model !== nextTurn.model
            || result.nextTurn?.effort !== nextTurn.effort
          ) {
            throw managerError(
              'Warm Codex generation did not accept the selected model settings',
              'CODEX_MODEL_SETTINGS_NOT_APPLIED',
            );
          }
        }
        return existing;
      }
    }

    this._throwIfShuttingDown();
    return this._spawnFresh(sessionKey, spawnContext, desired);
  }

  async _spawnFresh(
    sessionKey,
    spawnContext,
    desired,
    { leaseAlreadyReserved = false } = {},
  ) {
    let leaseReservation = null;
    let startAttempted = false;
    if (desired.runtime === 'codex') {
      leaseReservation = leaseAlreadyReserved
        ? this._codexLease
        : this._reserveCodexLease(sessionKey);
    }
    const releaseDefinitelyUnstartedReservation = () => {
      if (
        desired.runtime === 'codex'
        && this._codexLease === leaseReservation
        && leaseReservation?.sessionKey === sessionKey
        && !startAttempted
      ) {
        this._codexLease = null;
      }
    };

    // Provisional new-process cost — ask the factory but don't start yet.
    let newProc;
    try {
      newProc = this.processFactory(sessionKey, spawnContext);
    } catch (error) {
      releaseDefinitelyUnstartedReservation();
      throw error;
    }
    try {
      const actualRuntime = this._isCodex(newProc) ? 'codex' : 'claude';
      if (
        actualRuntime !== desired.runtime
        || (
          desired.runtime === 'codex'
            ? newProc.spawnProfileId !== desired.spawnProfileId
            : (
              newProc.spawnProfileId != null
              && newProc.spawnProfileId !== desired.spawnProfileId
            )
        )
      ) {
        throw managerError(
          'Process factory returned a different runtime/profile identity',
          'RUNTIME_FACTORY_MISMATCH',
        );
      }
      this._procIdentities.set(newProc, desired);
      if (newProc.runtime == null) newProc.runtime = desired.runtime;
      if (
        desired.runtime !== 'codex'
        && newProc.spawnProfileId == null
        && desired.spawnProfileId != null
      ) {
        newProc.spawnProfileId = desired.spawnProfileId;
      }
    } catch (error) {
      releaseDefinitelyUnstartedReservation();
      throw error;
    }

    try {
      const newCost = newProc.cost;
      while (this.totalCost + newCost > this.budget) {
        const evicted = this._evictLRU();   // skips inFlight + background-job-pinned
        if (evicted) continue;
        if (spawnContext?.noWaitForCapacity === true) {
          throw managerError(
            `process capacity is not immediately available for sessionKey ${sessionKey}`,
            'PROCESS_ADMISSION_UNAVAILABLE',
          );
        }
        // _evictLRU freed nothing. Policy C — split by WHY:
        if (this._hasPinnedSession()) {
          // A DURABLE blocker (live background job) holds a slot. Don't park on it (could be
          // ~an hour) and don't kill it. The budget caps RSS, not correctness — so treat it as
          // SOFT: spawn over budget + warn; the operator reclaims by /reset-ing a chat.
          const pinned = this._pinnedSessionKeys();
          this._logEvent('lru-overflow-pinned', {
            active: this.procs.size,
            totalCost: this.totalCost,
            budget: this.budget,
            newCost,
            pinned,
          });
          this.logger.warn?.(
            `[pm] budget ${this.budget} exceeded (~${this.totalCost + newCost}): all free slots hold ` +
            `live background jobs [${pinned.join(', ')}]. Spawning over limit — /reset one of those ` +
            `chats to reclaim memory.`,
          );
          break;   // soft overflow — spawn anyway
        }
        // No pin — the blockers are all in-flight TURNS (transient, finish in seconds). Keep the
        // existing behavior: park briefly for a slot rather than needlessly overflow.
        await this._awaitLruSlot();
        this._throwIfShuttingDown();
        // Loop again — budget may have freed up.
      }

      this._throwIfShuttingDown();
      // A concurrent lifecycle source may have registered a process while we
      // were parked. The provisional object is definitely unstarted here.
      const competitor = this.procs.get(sessionKey);
      if (competitor && !competitor.closed) {
        releaseDefinitelyUnstartedReservation();
        if (this._identityFor(competitor).key === desired.key) {
          if (this._isCodex(competitor)) {
            this._assertStrictResumeReuse(competitor, spawnContext);
          }
          return competitor;
        }
        return this._replaceRuntimeLocked(
          sessionKey,
          spawnContext,
          desired,
        );
      }
      this._throwIfShuttingDown();
    } catch (error) {
      releaseDefinitelyUnstartedReservation();
      throw error;
    }

    let startP;
    try {
      if (desired.runtime === 'codex') {
        this._bindCodexLease(leaseReservation, sessionKey, newProc);
      }
      this._wireCallbacks(newProc);
      this.procs.set(sessionKey, newProc);
      newProc.lastUsedTs = Date.now();
      // Publish the in-flight start() Promise so concurrent getOrSpawn
      // callers (above) can await it instead of racing the spawn.
      // Enter through a promise boundary so a subclass that throws
      // synchronously from start() follows the same map/lease cleanup path as
      // an asynchronous rejection.
      startP = Promise.resolve().then(() => {
        startAttempted = true;
        return newProc.start(newProc.spawnOptions ?? spawnContext);
      });
      this._starting.set(sessionKey, startP);
    } catch (error) {
      if (this.procs.get(sessionKey) === newProc) {
        this.procs.delete(sessionKey);
      }
      releaseDefinitelyUnstartedReservation();
      throw error;
    }
    try {
      await startP;
    } catch (err) {
      const startupReleaseSafe = (
        desired.runtime === 'codex'
        && newProc.startupReleaseSafe === true
        && newProc.closed === true
        && this._codexLeaseMatches(newProc)
      );
      if (startupReleaseSafe) {
        if (this.procs.get(sessionKey) === newProc) {
          this.procs.delete(sessionKey);
        }
        this._codexLease = null;
        this._maybeSignalLruWaiter();
      } else if (desired.runtime === 'codex') {
        // A rejected Codex start remains the exact inspectable ownership
        // fence unless startup proves no child or session mutation escaped.
        this.procs.set(sessionKey, newProc);
      } else if (desired.runtime !== 'codex') {
        if (this.procs.get(sessionKey) === newProc) {
          this.procs.delete(sessionKey);
        }
        this._maybeSignalLruWaiter();
      }
      throw err;
    } finally {
      this._starting.delete(sessionKey);
    }
    this._throwIfShuttingDown();
    return newProc;
  }

  _reserveCodexLease(sessionKey) {
    if (!this._codexRecoveryReady) {
      throw managerError(
        'Codex ownership recovery has not been restored',
        'CODEX_RECOVERY_NOT_READY',
      );
    }
    if (this._codexLease) {
      throw managerError(
        'Native Codex generation is already active',
        'CODEX_DAEMON_GENERATION_BUSY',
      );
    }
    const reservation = {
      kind: 'reservation',
      proc: null,
      sessionKey,
      generationId: null,
      healthyStopped: false,
      transportClosed: false,
      terminalStatus: null,
      turnId: null,
      quarantined: false,
    };
    this._codexLease = reservation;
    return reservation;
  }

  _bindCodexLease(lease, sessionKey, proc) {
    if (
      !lease
      || this._codexLease !== lease
      || lease.proc
      || lease.sessionKey !== sessionKey
    ) {
      throw managerError(
        'Native Codex generation ownership is already reserved',
        'CODEX_DAEMON_GENERATION_BUSY',
      );
    }
    if (!isOpaqueId(proc.generationId)) {
      throw managerError(
        'Codex process did not expose a bounded generationId',
        'CODEX_GENERATION_INVALID',
      );
    }
    if (
      !isOpaqueId(this.codexHostIdentity)
      || !isOpaqueId(this.codexBootSessionIdentity)
      || proc.hostIdentity !== this.codexHostIdentity
      || proc.bootSessionIdentity !== this.codexBootSessionIdentity
    ) {
      throw managerError(
        'Codex process host/boot identity does not match manager ownership',
        'CODEX_GENERATION_INVALID',
      );
    }
    lease.kind = 'generation';
    lease.proc = proc;
    lease.sessionKey = sessionKey;
    lease.generationId = proc.generationId;
    lease.hostIdentity = this.codexHostIdentity;
    lease.bootSessionIdentity = this.codexBootSessionIdentity;
    lease.healthyStopped = false;
    lease.transportClosed = false;
    lease.terminalStatus = null;
    lease.turnId = null;
  }

  _codexLeaseMatches(proc, generationId = proc?.generationId) {
    return Boolean(
      this._codexLease
      && this._codexLease.proc === proc
      && this._codexLease.generationId === generationId
      && proc?.generationId === generationId
    );
  }

  _strictSwitchBlocked(proc) {
    if (
      proc.inFlight
      || proc.hasActiveBackgroundWork?.()
      || proc.hasOpenQuestions?.()
      || proc.hasPendingDeliveryWork?.()
    ) return true;
    return new Set([
      'RecoveryConflict',
      'ContainmentFailed',
      'FailedAmbiguous',
      'DurabilityBlocked',
      'StartingTurn',
      'Active',
      'Settling',
      'BackgroundWorking',
      'BackgroundSettling',
      'Quiescing',
    ]).has(proc.state);
  }

  replaceRuntime(sessionKey, spawnContext, desiredIdentity = null) {
    if (this._shuttingDown) return Promise.reject(new Error('shutdown'));
    let desired;
    try {
      desired = desiredIdentity ?? this._desiredIdentity(spawnContext);
    } catch (error) {
      return Promise.reject(error);
    }
    const active = this._replacing.get(sessionKey);
    if (active) {
      if (active.identityKey === desired.key) return active.promise;
      return Promise.reject(managerError(
        'A different runtime replacement is already in progress',
        'RUNTIME_SWITCH_IN_FLIGHT',
      ));
    }
    const operation = this._withLifecycleGate(sessionKey, () => {
      this._throwIfShuttingDown();
      return this._replaceRuntimeLocked(sessionKey, spawnContext, desired);
    });
    const entry = { identityKey: desired.key, promise: operation };
    this._replacing.set(sessionKey, entry);
    operation.finally(() => {
      if (this._replacing.get(sessionKey) === entry) {
        this._replacing.delete(sessionKey);
      }
    }).catch(() => {});
    return operation;
  }

  async _replaceRuntimeLocked(sessionKey, spawnContext, desired) {
    this._throwIfShuttingDown();
    const old = this.procs.get(sessionKey);
    if (!old || old.closed) {
      return this._spawnFresh(sessionKey, spawnContext, desired);
    }
    if (this._identityFor(old).key === desired.key) return old;
    if (this._strictSwitchBlocked(old)) {
      throw managerError(
        'Runtime/profile switch is blocked by live session work',
        'RUNTIME_SWITCH_IN_FLIGHT',
      );
    }

    const oldIsCodex = this._isCodex(old);
    let reservation = null;
    let transferredLease = false;
    if (desired.runtime === 'codex') {
      if (oldIsCodex && this._codexLeaseMatches(old)) {
        reservation = this._codexLease;
        transferredLease = true;
      } else {
        reservation = this._reserveCodexLease(sessionKey);
      }
    }

    try {
      await this._strictRetire(old, 'runtime-switch');
    } catch (cause) {
      const verificationFailed = Boolean(
        findCodexRetirementVerificationError(cause),
      );
      const retainExactFence = Boolean(
        oldIsCodex
        && this._codexLeaseMatches(old),
      );
      if (!verificationFailed) this._retiring.delete(old);
      if (retainExactFence) {
        if (!this.procs.has(sessionKey)) this.procs.set(sessionKey, old);
      } else {
        if (
          reservation
          && !transferredLease
          && this._codexLease === reservation
        ) {
          this._codexLease = null;
        }
        if (old.closed && this.procs.get(sessionKey) === old) {
          this.procs.delete(sessionKey);
        } else if (!old.closed && !this.procs.has(sessionKey)) {
          this.procs.set(sessionKey, old);
        }
      }
      throw managerError(
        'Existing runtime could not be safely retired',
        'RUNTIME_SWITCH_EVICTION_FAILED',
        { cause },
      );
    }

    if (this.procs.get(sessionKey) === old) this.procs.delete(sessionKey);
    this._retiring.delete(old);
    if (oldIsCodex) {
      if (!this._codexLeaseMatches(old)) {
        // A stale lifecycle event or ownership change cannot release the
        // daemon-wide fence.
        if (!this.procs.has(sessionKey)) this.procs.set(sessionKey, old);
        throw managerError(
          'Codex generation ownership changed during retirement',
          'RUNTIME_SWITCH_EVICTION_FAILED',
        );
      }
      if (desired.runtime === 'codex') {
        const lease = this._codexLease;
        lease.kind = 'reservation';
        lease.proc = null;
        lease.sessionKey = sessionKey;
        lease.generationId = null;
        lease.healthyStopped = false;
        lease.transportClosed = false;
        lease.terminalStatus = null;
        lease.turnId = null;
        reservation = lease;
      } else {
        this._codexLease = null;
      }
    }
    this._maybeSignalLruWaiter();

    try {
      this._throwIfShuttingDown();
      return await this._spawnFresh(
        sessionKey,
        spawnContext,
        desired,
        { leaseAlreadyReserved: desired.runtime === 'codex' },
      );
    } catch (error) {
      // Factory/pre-construction failure has no generation to fence. Once the
      // lease is bound to a process, _spawnFresh intentionally retains it.
      if (
        desired.runtime === 'codex'
        && this._codexLease === reservation
        && reservation?.kind === 'reservation'
      ) {
        this._codexLease = null;
      }
      throw error;
    }
  }

  async _strictRetire(proc, reason) {
    this._retiring.add(proc);
    if (this._isCodex(proc)) {
      if (!this._codexLeaseMatches(proc)) {
        throw managerError(
          'Codex generation does not own the daemon lease',
          'CODEX_DAEMON_GENERATION_BUSY',
        );
      }
      await proc.interrupt();
      if (
        proc.state !== 'Stopped'
        || !this._codexLeaseMatches(proc)
        || !this._codexLease.healthyStopped
        || this._codexLease.quarantined
      ) {
        throw managerError(
          'Codex generation did not prove exact healthy settlement',
          'CODEX_RETIREMENT_UNVERIFIED',
        );
      }
      await proc.kill(reason);
      if (
        !proc.closed
        || !this._codexLeaseMatches(proc)
        || !this._codexLease.transportClosed
        || this._codexLease.quarantined
      ) {
        throw managerError(
          'Codex transport did not prove closed after settlement',
          'CODEX_RETIREMENT_UNVERIFIED',
        );
      }
      if (this.codexRetirementVerifier) {
        return this._verifyCodexRetirement(proc, reason);
      }
      return null;
    }
    await proc.kill(reason);
    if (!proc.closed) {
      throw managerError(
        'Runtime transport did not close',
        'RUNTIME_RETIREMENT_UNVERIFIED',
      );
    }
  }

  async _verifyCodexRetirement(proc, reason) {
    let timer = null;
    const abortController = new AbortController();
    try {
      const verification = await Promise.race([
        Promise.resolve().then(() => this.codexRetirementVerifier({
          sessionKey: proc.sessionKey,
          generationId: proc.generationId,
          reason,
          terminalStatus: this._codexLease.terminalStatus ?? null,
          turnId: this._codexLease.turnId ?? null,
          signal: abortController.signal,
        })),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const timeoutError = managerError(
              'Codex consumer retirement verification timed out',
              'CODEX_RETIREMENT_VERIFICATION_FAILED',
            );
            reject(timeoutError);
            abortController.abort(timeoutError);
          }, this.codexRetirementTimeoutMs);
        }),
      ]);
      if (verification?.committed !== true) {
        throw managerError(
          'Codex consumer did not commit exact durable retirement',
          'CODEX_RETIREMENT_VERIFICATION_FAILED',
        );
      }
      return verification;
    } catch (cause) {
      if (this._codexLeaseMatches(proc)) {
        this._codexLease.quarantined = true;
      }
      if (!abortController.signal.aborted) abortController.abort(cause);
      if (findCodexRetirementVerificationError(cause)) throw cause;
      throw managerError(
        'Codex consumer retirement verification failed',
        'CODEX_RETIREMENT_VERIFICATION_FAILED',
        { cause },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _evictLRU() {
    let oldest = null;
    let oldestKey = null;
    let pinnedSkipped = 0;
    for (const [k, p] of this.procs.entries()) {
      if (p.inFlight) continue;
      if (this._lifecycleGates.has(k)) continue;
      // Native Codex beta generations are daemon-wide ownership fences. They
      // are retired only through the acknowledged strict path, never from the
      // synchronous best-effort LRU path.
      if (this._isCodex(p)) { pinnedSkipped++; continue; }
      // PIN: a session with a live detached background job is NOT evictable — killing it
      // would silently drop the job (and its report-back wakeup). Skip like inFlight.
      if (p.hasActiveBackgroundWork()) { pinnedSkipped++; continue; }
      // PIN (0.13 D1, S9): a session blocked on an open interactive question is
      // NOT evictable — the keyboard is live and claude is blocked on the ask;
      // killing it silently strands both. Skip like inFlight.
      if (typeof p.hasOpenQuestions === 'function' && p.hasOpenQuestions()) { pinnedSkipped++; continue; }
      if (typeof p.hasPendingDeliveryWork === 'function' && p.hasPendingDeliveryWork()) {
        pinnedSkipped++;
        continue;
      }
      if (!oldest || (p.lastUsedTs || 0) < (oldest.lastUsedTs || 0)) {
        oldest = p;
        oldestKey = k;
      }
    }
    if (!oldest) {
      this._logEvent('lru-full', {
        active: this.procs.size,
        totalCost: this.totalCost,
        budget: this.budget,
        pinnedSkipped,
      });
      return false;
    }
    this._logEvent('evict', {
      session_key: oldestKey,
      cost: oldest.cost,
      backend: oldest.backend,
      pinnedSkipped,
    });
    this._retiring.add(oldest);
    this.procs.delete(oldestKey);
    this._withLifecycleGate(oldestKey, async () => {
      try { await oldest.kill('evict'); } catch {}
      finally { this._retiring.delete(oldest); }
    }).catch(() => {});
    return true;
  }

  /**
   * A DURABLE eviction blocker: a non-inFlight session holding a slot because it has a live
   * background job (vs an inFlight TURN, which is transient and frees in seconds). Used to
   * split park-vs-overflow when _evictLRU can free nothing.
   */
  _hasPinnedSession() {
    for (const p of this.procs.values()) {
      if (this._isCodex(p)) return true;
      if (!p.inFlight && p.hasActiveBackgroundWork()) return true;
      if (typeof p.hasPendingDeliveryWork === 'function' && p.hasPendingDeliveryWork()) return true;
      // 0.16 (MF-B): an extended busy-aware-ceiling turn is a DURABLE blocker —
      // it can hold its slot up to the hard backstop (90min), not "seconds" like
      // a normal in-flight turn. Treat it as a pin so getOrSpawn SOFT-overflows
      // (spawn over budget + warn) instead of park-then-reject, which would deny
      // service to other chats for the full 5-min LRU wait.
      if (p.inFlight && typeof p.hasExtendedTurn === 'function' && p.hasExtendedTurn()) return true;
    }
    return false;
  }

  _pinnedSessionKeys() {
    const keys = [];
    for (const [k, p] of this.procs.entries()) {
      if (this._isCodex(p)) keys.push(k);
      else if (!p.inFlight && p.hasActiveBackgroundWork()) keys.push(k);
      else if (typeof p.hasPendingDeliveryWork === 'function' && p.hasPendingDeliveryWork()) keys.push(k);
      else if (p.inFlight && typeof p.hasExtendedTurn === 'function' && p.hasExtendedTurn()) keys.push(k);
    }
    return keys;
  }

  async _awaitLruSlot() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._lruWaiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this._lruWaiters.splice(idx, 1);
        this._logEvent('lru-wait-timeout', { wait_ms: this.lruWaitMs });
        reject(new Error(`lru wait timed out after ${this.lruWaitMs}ms`));
      }, this.lruWaitMs);
      this._lruWaiters.push({ resolve, reject, timer });
      this._logEvent('lru-wait', {
        active: this.procs.size,
        totalCost: this.totalCost,
        budget: this.budget,
      });
    });
  }

  _maybeSignalLruWaiter() {
    const w = this._lruWaiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(); }
  }

  // ─── Per-session dispatch ────────────────────────────────────────

  async send(sessionKey, prompt, opts) {
    if (this._isStateMutationFenced(sessionKey)) {
      throw this._stateMutationFenceError();
    }
    const proc = this.procs.get(sessionKey);
    if (!proc) throw new Error(`no process for sessionKey ${sessionKey}`);
    proc.lastUsedTs = Date.now();
    const hasExpectedProcess = (
      opts != null
      && typeof opts === 'object'
      && Object.prototype.hasOwnProperty.call(opts, 'expectedProcess')
    );
    if (hasExpectedProcess) {
      if (this.procs.get(sessionKey) !== opts.expectedProcess || proc.closed) {
        throw managerError(
          `process precondition failed for sessionKey ${sessionKey}`,
          'PROCESS_PRECONDITION_FAILED',
        );
      }
      const { expectedProcess: _expectedProcess, ...sendOpts } = opts;
      return proc.send(prompt, sendOpts);
    }
    return proc.send(prompt, opts);
  }

  kill(sessionKey, reason = 'kill') {
    return this._withRetirementIntent(sessionKey, () => (
      this._killLocked(sessionKey, reason)
    ));
  }

  retireExpectedProcess(
    sessionKey,
    expectedProcess,
    reason = 'expected-process-retirement',
  ) {
    if (this.procs.get(sessionKey) !== expectedProcess) {
      return Promise.reject(managerError(
        `process precondition failed for sessionKey ${sessionKey}`,
        'PROCESS_PRECONDITION_FAILED',
      ));
    }
    return this._withRetirementIntent(sessionKey, async () => {
      if (this.procs.get(sessionKey) !== expectedProcess) {
        throw managerError(
          `process precondition failed for sessionKey ${sessionKey}`,
          'PROCESS_PRECONDITION_FAILED',
        );
      }
      try {
        await this._strictRetire(expectedProcess, reason);
      } catch (error) {
        if (!findCodexRetirementVerificationError(error)) {
          this._retiring.delete(expectedProcess);
        }
        throw error;
      }
      if (this.procs.get(sessionKey) === expectedProcess) {
        this.procs.delete(sessionKey);
      }
      this._retiring.delete(expectedProcess);
      if (this._codexLeaseMatches(expectedProcess)) this._codexLease = null;
      this._maybeSignalLruWaiter();
      return true;
    });
  }

  async _killLocked(sessionKey, reason = 'kill') {
    const proc = this.procs.get(sessionKey);
    if (!proc) return false;
    if (this._isCodex(proc)) {
      try {
        await this._strictRetire(proc, reason);
      } catch (error) {
        const verificationFailed = Boolean(
          findCodexRetirementVerificationError(error),
        );
        if (!verificationFailed) this._retiring.delete(proc);
        if (this._codexLeaseMatches(proc)) {
          if (!this.procs.has(sessionKey)) this.procs.set(sessionKey, proc);
          throw error;
        }
        if (proc.closed && this.procs.get(sessionKey) === proc) {
          this.procs.delete(sessionKey);
        } else if (!proc.closed && !this.procs.has(sessionKey)) {
          this.procs.set(sessionKey, proc);
        }
        throw error;
      }
      if (this.procs.get(sessionKey) === proc) this.procs.delete(sessionKey);
      this._retiring.delete(proc);
      if (this._codexLeaseMatches(proc)) this._codexLease = null;
      this._maybeSignalLruWaiter();
      return true;
    }
    // Preserve Claude's established best-effort teardown semantics.
    this._retiring.add(proc);
    this.procs.delete(sessionKey);
    try { await proc.kill(reason); } catch {}
    finally { this._retiring.delete(proc); }
    this._maybeSignalLruWaiter();
    return true;
  }

  async killChat(chatId) {
    const targets = [];
    const idStr = String(chatId);
    for (const [sk, p] of this.procs.entries()) {
      if (p.chatId === idStr) targets.push([sk, p]);
    }
    return Promise.allSettled(
      targets.map(([sk]) => this.kill(sk, 'killChat')),
    );
  }

  async shutdown() {
    this._shuttingDown = true;
    // Reject parked lru waiters.
    for (const w of this._lruWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('shutdown'));
    }
    this._lruWaiters.length = 0;

    // First let already-admitted start/replacement/kill operations settle.
    // New lifecycle operations are rejected by _shuttingDown.
    const admittedResults = await Promise.allSettled(
      [...this._lifecycleGates.values()],
    );
    // Snapshot only after those gates finish: a start may have published a
    // process just before observing shutdown.
    const targets = [...this.procs.entries()]
      .filter(([, proc]) => !this._retiring.has(proc))
      .map(([sessionKey]) => sessionKey);
    const retirementResults = await Promise.allSettled(targets.map((sessionKey) => (
      this._withLifecycleGate(sessionKey, () => (
        this._killLocked(sessionKey, 'shutdown')
      ))
    )));
    for (const result of [...admittedResults, ...retirementResults]) {
      if (result.status !== 'rejected') continue;
      const retirementError = findCodexRetirementVerificationError(
        result.reason,
      );
      if (retirementError) throw retirementError;
    }
  }

  async retireForCleanRestart({ getDeliveryEvidence } = {}) {
    if (typeof getDeliveryEvidence !== 'function') {
      throw new TypeError(
        'ProcessManager.retireForCleanRestart: getDeliveryEvidence function required',
      );
    }
    this._shuttingDown = true;
    for (const w of this._lruWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('shutdown'));
    }
    this._lruWaiters.length = 0;

    const admittedResults = await Promise.allSettled(
      [...this._lifecycleGates.values()],
    );
    const targets = [...this.procs.entries()]
      .filter(([, proc]) => !this._retiring.has(proc));
    for (const [, proc] of targets) this._retiring.add(proc);

    let settled;
    try {
      settled = await Promise.allSettled(targets.map(async ([sessionKey, proc]) => {
        let snapshot;
        if (this._isCodex(proc)) {
          const candidate = typeof proc.captureCleanRestartCandidate === 'function'
            ? proc.captureCleanRestartCandidate()
            : null;
          let deliveryEvidence = null;
          let deliveryEvidenceError = null;
          try {
            deliveryEvidence = await getDeliveryEvidence(
              sessionKey,
              candidate?.sourceMsgId ?? null,
            );
          } catch (error) {
            deliveryEvidenceError = error;
          }
          const retirement = await this._strictRetire(proc, 'clean-restart');
          const settledTerminalStatus = this._codexLease?.terminalStatus ?? null;
          const settledTurnId = this._codexLease?.turnId ?? null;
          const deliverySafe = Boolean(
            deliveryEvidence?.fenced === true
            && deliveryEvidence.pending === 0
            && deliveryEvidence.outputAttempted === false
          );
          const exactRetirement = Boolean(
            candidate
            && retirement?.committed === true
            && retirement.disposition === 'stop-cancelled'
            && retirement.sessionKey === candidate.sessionKey
            && retirement.generationId === candidate.generationId
            && retirement.attemptId === candidate.attemptId
            && retirement.providerSessionId === candidate.providerSessionId
            && retirement.providerTurnId === candidate.providerTurnId
            && retirement.sourceMsgId != null
            && String(retirement.sourceMsgId) === String(candidate.sourceMsgId)
            && settledTerminalStatus === 'interrupted'
            && settledTurnId === candidate.providerTurnId
          );
          if (this._codexLeaseMatches(proc)) this._codexLease = null;
          const eligible = deliverySafe && exactRetirement;
          let reason = 'output-evidence';
          if (deliverySafe) reason = 'retirement-binding-mismatch';
          if (deliveryEvidenceError) reason = 'delivery-evidence-failed';
          snapshot = candidate ? {
            runtime: 'codex',
            namespace: 'codex:app-server',
            sourceMsgId: candidate.sourceMsgId,
            providerSessionId: candidate.providerSessionId,
            providerTurnId: candidate.providerTurnId,
            cwd: candidate.cwd,
            model: candidate.model,
            effort: candidate.effort,
            spawnProfileId: candidate.spawnProfileId,
            eligible,
            reason: eligible ? 'eligible' : reason,
          } : {
            sourceMsgId: null,
            eligible: false,
            reason: 'no-active-turn',
          };
          if (deliveryEvidenceError) throw deliveryEvidenceError;
        } else {
          snapshot = await proc.retireForCleanRestart({
            getDeliveryEvidence: (_reportedSessionKey, sourceMsgId) => (
              getDeliveryEvidence(
                sessionKey,
                proc.backend === 'cli' ? sourceMsgId : null,
              )
            ),
          });
        }
        const supported = proc.backend === 'cli' || this._isCodex(proc);
        const eligible = supported && snapshot?.eligible === true;
        return Object.freeze({
          sessionKey,
          ...(this._isCodex(proc) && snapshot.runtime ? {
            runtime: snapshot.runtime,
            namespace: snapshot.namespace,
            providerSessionId: snapshot.providerSessionId,
            providerTurnId: snapshot.providerTurnId,
            cwd: snapshot.cwd,
            model: snapshot.model,
            effort: snapshot.effort,
            spawnProfileId: snapshot.spawnProfileId,
          } : {}),
          sourceMsgId: supported
            ? (snapshot?.sourceMsgId ?? null)
            : null,
          eligible,
          reason: supported
            ? (snapshot?.reason || 'retirement-uncertain')
            : 'unsupported-backend',
        });
      }));
    } finally {
      for (const [sessionKey, proc] of targets) {
        if (proc.closed && this.procs.get(sessionKey) === proc) {
          this.procs.delete(sessionKey);
        }
        this._retiring.delete(proc);
      }
      this._maybeSignalLruWaiter();
    }
    const failure = [
      ...admittedResults,
      ...settled,
    ].find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const results = settled.map(result => result.value);
    return Object.freeze(results);
  }

  // ─── Optional async — feature-detect at call site if needed ──────

  /**
   * Shared dispatch for the five optional async methods. Returns the
   * Process method's value on success, `unsupportedDefault` when the
   * Process is missing/closed OR throws UNSUPPORTED_OPERATION /
   * NOT_IMPLEMENTED_YET. Other errors propagate.
   */
  async _invokeOptional(sessionKey, methodName, args, unsupportedDefault) {
    const p = this.procs.get(sessionKey);
    if (!p || p.closed) return unsupportedDefault;
    try { return await p[methodName](...args); }
    catch (err) {
      if (err && (err.code === 'UNSUPPORTED_OPERATION' || err.code === 'NOT_IMPLEMENTED_YET')) {
        return unsupportedDefault;
      }
      throw err;
    }
  }

  async interrupt(sessionKey) {
    const proc = this.procs.get(sessionKey);
    if (!proc || proc.closed) return false;
    if (
      !this._isCodex(proc)
      || this._isStateMutationFenced(sessionKey)
    ) {
      return this._invokeOptional(sessionKey, 'interrupt', [], false);
    }
    return this._withRetirementIntent(sessionKey, async () => {
      if (this.procs.get(sessionKey) !== proc || proc.closed) return false;
      const interrupted = await proc.interrupt();
      if (!interrupted) return false;
      await this._killLocked(sessionKey, 'interrupt');
      return true;
    });
  }

  async steerTurn(sessionKey, text, opts) {
    if (this._isStateMutationFenced(sessionKey)) {
      throw this._stateMutationFenceError();
    }
    return this._invokeOptional(
      sessionKey,
      'steerTurn',
      [text, opts],
      { outcome: 'unavailable', reason: 'missing-or-closed' },
    );
  }

  async setModel(sessionKey, model) {
    if (this._isStateMutationFenced(sessionKey)) {
      throw this._stateMutationFenceError();
    }
    return this._invokeOptional(sessionKey, 'setModel', [model], false);
  }

  _classifyModelSettingsTarget(sessionKey) {
    if (this._isStateMutationFenced(sessionKey)) {
      return { outcome: 'unavailable', reason: 'quiescing' };
    }
    const selected = this.procs.get(sessionKey);
    if (!selected || selected.closed) {
      if (!this._codexRecoveryReady) {
        return { outcome: 'unavailable', reason: 'stale-generation' };
      }
      if (this._codexLease?.quarantined) {
        return { outcome: 'unavailable', reason: 'containment' };
      }
      if (
        this._codexLease
        && this._codexLease.sessionKey
        && this._codexLease.sessionKey !== sessionKey
      ) {
        return { outcome: 'daemon-busy' };
      }
      if (this._codexLease) {
        return { outcome: 'unavailable', reason: 'stale-generation' };
      }
      return { outcome: 'not-loaded' };
    }
    if (!this._isCodex(selected)) {
      return { outcome: 'unavailable', reason: 'wrong-runtime' };
    }
    const generationId = selected.generationId;
    const current = this.procs.get(sessionKey);
    if (
      current !== selected
      || current.closed
      || current.generationId !== generationId
      || !this._codexLeaseMatches(current, generationId)
    ) {
      return { outcome: 'unavailable', reason: 'stale-generation' };
    }
    if (
      this._codexLease.quarantined
      || [
        'ContainmentFailed',
        'FailedAmbiguous',
        'DurabilityBlocked',
      ].includes(current.state)
    ) {
      return { outcome: 'unavailable', reason: 'containment' };
    }
    if (
      current.settingsAdmissionClosed
      || ['Quiescing', 'Stopped'].includes(current.state)
    ) {
      return { outcome: 'unavailable', reason: 'quiescing' };
    }
    if (current.state === 'Closed' || current.state === 'RecoveryConflict') {
      return { outcome: 'unavailable', reason: 'stale-generation' };
    }
    return { outcome: 'loaded', proc: current };
  }

  /**
   * Return a lifecycle-consistent settings snapshot without spawning a process
   * or invoking a backend mutation.
   */
  getModelSettingsStatus(sessionKey) {
    return this._withLifecycleGate(sessionKey, () => {
      const classification = this._classifyModelSettingsTarget(sessionKey);
      if (classification.outcome !== 'loaded') return classification;
      const { proc } = classification;
      const currentSettings = (
        proc.activeTurnSettings
        ?? proc.admittingTurnSettings
        ?? null
      );
      return {
        outcome: 'loaded',
        threadId: proc.providerSessionId ?? null,
        generationId: proc.generationId,
        currentTurn: snapshotModelSettings(currentSettings),
        nextTurn: snapshotModelSettings(proc.desiredSettings),
        observedThread: snapshotModelSettings(proc.observedThreadSettings),
      };
    });
  }

  async selectModelSettings(sessionKey, settings) {
    const nextTurn = requireModelSettings(
      settings,
      'selectModelSettings',
    );
    return this._withLifecycleGate(sessionKey, async () => {
      const classification = this._classifyModelSettingsTarget(sessionKey);
      if (classification.outcome !== 'loaded') {
        return { ...classification, nextTurn };
      }
      return classification.proc.selectModelSettings(nextTurn);
    });
  }

  /**
   * Review F#10: return the backend name for a live process so callers
   * (slash-commands) can word their UX accurately. Returns null if no
   * live process exists.
   */
  getBackend(sessionKey) {
    const p = this.procs.get(sessionKey);
    return (p && !p.closed) ? p.backend : null;
  }

  async applyFlagSettings(sessionKey, settings) {
    if (this._isStateMutationFenced(sessionKey)) {
      throw this._stateMutationFenceError();
    }
    return this._invokeOptional(sessionKey, 'applyFlagSettings', [settings], false);
  }

  async setPermissionMode(sessionKey, mode) {
    if (this._isStateMutationFenced(sessionKey)) {
      throw this._stateMutationFenceError();
    }
    return this._invokeOptional(sessionKey, 'setPermissionMode', [mode], false);
  }

  resetSession(sessionKey, opts) {
    if (this._isStateMutationFenced(sessionKey)) {
      return Promise.reject(this._stateMutationFenceError());
    }
    return this._withRetirementIntent(sessionKey, () => (
      this._resetSessionLocked(sessionKey, opts)
    ));
  }

  async _resetSessionLocked(sessionKey, opts) {
    const p = this.procs.get(sessionKey);
    // No active process for this key — return no-op. Matches the
    // pre-0.10.0 SDK pm semantic (`closed: false` = "we did not close
    // anything"). Caller can distinguish "session was already gone"
    // from "we just closed an active session."
    if (!p) return { closed: false, drainedPendings: 0 };
    try {
      const result = await p.resetSession(opts);
      // The Process's resetSession closes itself; remove from Map
      // and signal LRU.
      if (this.procs.get(sessionKey) === p) {
        this.procs.delete(sessionKey);
      }
      this._maybeSignalLruWaiter();
      return result;
    } catch (err) {
      if (err.code === 'UNSUPPORTED_OPERATION' || err.code === 'NOT_IMPLEMENTED_YET') {
        const drained = p.drainQueue('RESET_SESSION');
        await this._killLocked(sessionKey, 'reset');
        return { closed: true, drainedPendings: drained };
      }
      throw err;
    }
  }

  async getContextUsage(sessionKey) {
    return this._invokeOptional(sessionKey, 'getContextUsage', [], null);
  }

  // ─── Optional sync hot-path — never throws (R1-F1) ───────────────

  drainQueue(sessionKey, code = 'INTERRUPTED') {
    const p = this.procs.get(sessionKey);
    if (!p) return 0;
    return p.drainQueue(code);
  }

  injectUserMessage(sessionKey, opts) {
    if (this._isStateMutationFenced(sessionKey)) return false;
    const p = this.procs.get(sessionKey);
    if (!p || p.closed) return false;
    return p.injectUserMessage(opts);
  }

  // 0.12 interactive questions: hand an answer back to a blocking `ask` tool call.
  // Returns false if the session is gone (claude is dead → nothing to answer).
  answerQuestion(sessionKey, toolCallId, result) {
    if (this._isStateMutationFenced(sessionKey)) return false;
    const p = this.procs.get(sessionKey);
    if (!p || p.closed || typeof p.writeQuestionAnswer !== 'function') return false;
    return p.writeQuestionAnswer(toolCallId, result);
  }

  steer(sessionKey, text, opts) {
    if (this._isStateMutationFenced(sessionKey)) return false;
    const p = this.procs.get(sessionKey);
    if (!p || p.closed) return false;
    return p.steer(text, opts);
  }

  // ─── Internal helpers ────────────────────────────────────────────

  /**
   * For each callback in this.callbacks, register a listener on the
   * Process that forwards the event payload to the callback. Wire
   * the standard event names; Process subclasses are free to emit
   * additional events that pm doesn't forward.
   *
   * Also subscribes to 'idle' (Process became inFlight=false) and
   * 'close' (Process closed itself) so the pm can signal parked
   * LRU waiters + remove from the Map.
   */
  _wireCallbacks(proc) {
    const capturedGeneration = proc.generationId ?? null;
    const hasCapturedGeneration = () => (
      capturedGeneration == null
      || proc.generationId === capturedGeneration
    );
    const isCurrentGeneration = () => (
      this.procs.get(proc.sessionKey) === proc
      && !this._retiring.has(proc)
      && hasCapturedGeneration()
    );
    for (const [cbName, eventName] of Object.entries(CALLBACK_TO_EVENT)) {
      const fn = this.callbacks[cbName];
      if (typeof fn !== 'function') continue;
      proc.on(eventName, (...args) => {
        const isRetirementClose = (
          eventName === 'close'
          && this._retiring.has(proc)
          && hasCapturedGeneration()
        );
        if (!isCurrentGeneration() && !isRetirementClose) {
          this._logEvent('stale-process-callback', {
            callback: cbName,
            backend: proc.backend,
          });
          return;
        }
        try { fn(proc.sessionKey, ...args, proc); }
        catch (err) {
          this.logger.error?.(`[pm:${proc.label}] callback ${cbName} threw: ${err.message}`);
        }
      });
    }
    // Generic 'error' channel — log + forward via onError if provided.
    proc.on('error', (err) => {
      this.logger.error?.(`[pm:${proc.label}] process error: ${err.message}`);
      if (
        isCurrentGeneration()
        && typeof this.callbacks.onError === 'function'
      ) {
        try { this.callbacks.onError(proc.sessionKey, err, proc); }
        catch (e) { this.logger.error?.(`[pm:${proc.label}] onError threw: ${e.message}`); }
      }
    });
    // 'idle': a turn completed and pendingQueue is empty. Signal any
    // parked LRU waiter that a non-in-flight slot is available.
    proc.on('idle', () => this._maybeSignalLruWaiter());
    proc.on('delivery-work-settled', () => this._maybeSignalLruWaiter());
    if (this._isCodex(proc)) {
      proc.on('codex-settled', (payload) => {
        if (
          payload?.kind === 'stopped'
          && payload.generationId === capturedGeneration
          && payload.hostIdentity === this._codexLease?.hostIdentity
          && payload.bootSessionIdentity
            === this._codexLease?.bootSessionIdentity
          && payload.trackedTerminalCleanupAccepted === true
          && payload.freshRegistryObservedEmpty === true
          && this._codexLeaseMatches(proc, capturedGeneration)
          && !this._codexLease.quarantined
        ) {
          this._codexLease.healthyStopped = true;
          this._codexLease.terminalStatus = payload.terminalStatus ?? null;
          this._codexLease.turnId = payload.turnId ?? null;
        }
      });
      proc.on('containment-failed', (payload) => {
        if (
          payload?.generationId === capturedGeneration
          && this._codexLeaseMatches(proc, capturedGeneration)
        ) {
          this._codexLease.quarantined = true;
        }
      });
    }
    // 'close': process closed itself (iteration loop exited or
    // _closeQuery returned). Remove from the Map + signal LRU.
    proc.on('close', (...args) => {
      if (!this._isCodex(proc)) {
        if (
          !this._retiring.has(proc)
          && this.procs.get(proc.sessionKey) === proc
        ) {
          this.procs.delete(proc.sessionKey);
        }
        this._maybeSignalLruWaiter();
        return;
      }
      if (this._codexLeaseMatches(proc, capturedGeneration)) {
        // A generic close is only a transport fact. It never releases the
        // ownership fence by itself.
        this._codexLease.transportClosed = true;
      }
      const detail = args[1];
      const cleanupCommitted = proc.containmentCleanupCommitted;
      const exactCleanupClose = Boolean(
        detail
        && detail === cleanupCommitted
        && Object.isFrozen(detail)
        && detail.kind === 'containment-cleanup-committed'
        && detail.backend === 'codex'
        && detail.generationId === capturedGeneration
        && detail.hostIdentity === this.codexHostIdentity
        && detail.bootSessionIdentity === this.codexBootSessionIdentity
      );
      if (!exactCleanupClose) {
        this._maybeSignalLruWaiter();
        return;
      }
      const start = this._starting.get(proc.sessionKey) ?? null;
      const lease = this._codexLease;
      this._withLifecycleGate(proc.sessionKey, async () => {
        if (start) await Promise.resolve(start).catch(() => {});
        if (
          this._starting.has(proc.sessionKey)
          || this._retiring.has(proc)
          || this.procs.get(proc.sessionKey) !== proc
          || proc.generationId !== capturedGeneration
          || proc.containmentCleanupCommitted !== detail
          || proc.closed !== true
          || proc.state !== 'Closed'
          || this._codexLease !== lease
          || !this._codexLeaseMatches(proc, capturedGeneration)
        ) return;
        this.procs.delete(proc.sessionKey);
        this._codexLease = null;
        this._maybeSignalLruWaiter();
      }).catch((error) => {
        this.logger.error?.(
          `[pm:${proc.label}] Codex containment cleanup release failed: ${error.message}`,
        );
      });
    });
    // P0 #3: channels backend emits 'bridge-disconnected' when its socket to
    // the spawned bridge dies (claude crash, bridge crash, EOF). The disconnect
    // handler in CliProcess already drained pendingTurns; here we kill
    // the dead Process so it leaves the Map and frees its LRU slot. Next
    // user-msg on the same sessionKey triggers a fresh getOrSpawn — which
    // calls Process.start with the persisted claudeSessionId, recovering the
    // conversation via `claude --resume`.
    //
    // We don't re-spawn proactively: an idle disconnected session shouldn't
    // burn LRU budget. Lazy respawn on next message is the right shape.
    proc.on('bridge-disconnected', () => {
      this.logger.warn?.(`[pm:${proc.label}] channels bridge disconnected — killing dead instance for lazy respawn`);
      // Serialize with start/replacement/kill. Re-check object identity after
      // the gate so a late disconnect from an old generation cannot kill its
      // replacement.
      this._withLifecycleGate(proc.sessionKey, async () => {
        if (this.procs.get(proc.sessionKey) !== proc) return;
        await this._killLocked(proc.sessionKey, 'bridge-disconnected');
      }).catch(err => {
        this.logger.warn?.(`[pm:${proc.label}] kill on bridge-disconnect failed: ${err.message}`);
      });
    });
  }

  _logEvent(kind, detail) {
    try {
      this.db?.logEvent?.(kind, detail || {});
    } catch (err) {
      this.logger.error?.(`[pm] logEvent ${kind} failed: ${err.message}`);
    }
  }
}

module.exports = {
  ProcessManager,
  ProcessManagerError,
  DEFAULT_BUDGET,
  CALLBACK_TO_EVENT,
};
