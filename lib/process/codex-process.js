'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const { Process, UnsupportedOperationError } = require('./process');

const DEFAULT_QUEUE_CAP = 50;
const DEFAULT_TURN_START_TIMEOUT_MS = 20_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 20_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 20_000;
const DEFAULT_CLEANUP_POLL_MS = 100;
const DEFAULT_PROTOCOL_FAULT_THRESHOLD = 1;
const DEFAULT_MAX_TURN_TEXT_BYTES = 4 * 1024 * 1024;
const DEFAULT_STREAM_CHECKPOINT_BYTES = 64 * 1024;
const DEFAULT_MAX_TURN_ITEMS = 10_000;
const DEFAULT_MAX_TERMINAL_HISTORY = 1_024;
const DEFAULT_MAX_STEER_TEXT_BYTES = 256 * 1024;
const DEFAULT_MAX_PENDING_STEERS = 16;
const MAX_OPAQUE_ID_BYTES = 512;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const OPAQUE_ID_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

class CodexProcessError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'CodexProcessError';
    this.code = code;
  }
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`CodexProcess: ${label} (string) required`);
  }
  return value;
}

function optionalString(value, label) {
  if (value == null) return null;
  return nonEmptyString(value, label);
}

function boundedOpaqueId(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_OPAQUE_ID_BYTES
    || OPAQUE_ID_CONTROL_CHAR_RE.test(value)
  ) {
    throw new TypeError(`CodexProcess: bounded ${label} required`);
  }
  return value;
}

function processError(message, code, options) {
  return new CodexProcessError(message, code, options);
}

function modelSettings(model, effort, label = 'settings') {
  return Object.freeze({
    model: nonEmptyString(model, `${label}.model`),
    effort: nonEmptyString(effort, `${label}.effort`),
  });
}

function dynamicSettings(source) {
  return modelSettings(
    source?.model,
    source?.reasoningEffort ?? source?.effort,
    'thread settings',
  );
}

function staticThreadPolicy(source, { includeRuntimeWorkspaceRoots = false } = {}) {
  const policy = {
    modelProvider: source?.modelProvider,
    approvalPolicy: source?.approvalPolicy,
    approvalsReviewer: source?.approvalsReviewer,
    sandbox: source?.sandbox ?? source?.sandboxPolicy,
    permissionProfile: source?.activePermissionProfile,
  };
  if (includeRuntimeWorkspaceRoots) {
    policy.runtimeWorkspaceRoots = source?.runtimeWorkspaceRoots;
  }
  return policy;
}

function isDeepFrozen(value) {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
    return false;
  }
  return Object.values(value).every((entry) => (
    !entry
    || typeof entry !== 'object'
    || isDeepFrozen(entry)
  ));
}

function timeout(promise, timeoutMs, message, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(processError(message, code)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function delay(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}

class CodexProcess extends Process {
  get state() {
    return this._state;
  }

  set state(next) {
    if (
      this._state === 'ContainmentFailed'
      && next !== 'ContainmentFailed'
    ) return;
    if (
      this._state === 'DurabilityBlocked'
      && next !== 'DurabilityBlocked'
      && next !== 'ContainmentFailed'
    ) return;
    if (
      this._state === 'FailedAmbiguous'
      && ![
        'FailedAmbiguous',
        'DurabilityBlocked',
        'ContainmentFailed',
      ].includes(next)
    ) return;
    this._state = next;
  }

  constructor({
    sessionKey,
    chatId,
    threadId,
    label,
    cwd,
    clientFactory,
    staticPolicyAttestor = async () => {},
    checkpointSink,
    hostIdentity,
    bootSessionIdentity,
    generationIdFactory = randomUUID,
    clientUserMessageIdFactory = randomUUID,
    mutationAttemptIdFactory = randomUUID,
    expectedStaticPolicy,
    expectedThreadPolicy,
    modelCatalog,
    queueCap = DEFAULT_QUEUE_CAP,
    turnStartTimeoutMs = DEFAULT_TURN_START_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    interruptTimeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    cleanupPollMs = DEFAULT_CLEANUP_POLL_MS,
    protocolFaultThreshold = DEFAULT_PROTOCOL_FAULT_THRESHOLD,
    maxTurnTextBytes = DEFAULT_MAX_TURN_TEXT_BYTES,
    streamCheckpointBytes = DEFAULT_STREAM_CHECKPOINT_BYTES,
    maxTurnItems = DEFAULT_MAX_TURN_ITEMS,
    maxTerminalHistory = DEFAULT_MAX_TERMINAL_HISTORY,
    maxSteerTextBytes = DEFAULT_MAX_STEER_TEXT_BYTES,
    maxPendingSteers = DEFAULT_MAX_PENDING_STEERS,
    logger = console,
  } = {}) {
    super({ sessionKey, chatId, threadId, label });
    this.backend = 'codex';
    this.cwd = nonEmptyString(cwd, 'cwd');
    if (typeof clientFactory !== 'function') {
      throw new TypeError('CodexProcess: clientFactory required');
    }
    if (typeof checkpointSink !== 'function') {
      throw new TypeError('CodexProcess: checkpointSink required');
    }
    if (typeof staticPolicyAttestor !== 'function') {
      throw new TypeError(
        'CodexProcess: staticPolicyAttestor must be a function',
      );
    }
    if (typeof generationIdFactory !== 'function') {
      throw new TypeError('CodexProcess: generationIdFactory must be a function');
    }
    if (typeof clientUserMessageIdFactory !== 'function') {
      throw new TypeError(
        'CodexProcess: clientUserMessageIdFactory must be a function',
      );
    }
    if (typeof mutationAttemptIdFactory !== 'function') {
      throw new TypeError(
        'CodexProcess: mutationAttemptIdFactory must be a function',
      );
    }
    for (const [value, name] of [
      [queueCap, 'queueCap'],
      [turnStartTimeoutMs, 'turnStartTimeoutMs'],
      [turnTimeoutMs, 'turnTimeoutMs'],
      [interruptTimeoutMs, 'interruptTimeoutMs'],
      [cleanupTimeoutMs, 'cleanupTimeoutMs'],
      [cleanupPollMs, 'cleanupPollMs'],
      [protocolFaultThreshold, 'protocolFaultThreshold'],
      [maxTurnTextBytes, 'maxTurnTextBytes'],
      [streamCheckpointBytes, 'streamCheckpointBytes'],
      [maxTurnItems, 'maxTurnItems'],
      [maxTerminalHistory, 'maxTerminalHistory'],
      [maxSteerTextBytes, 'maxSteerTextBytes'],
      [maxPendingSteers, 'maxPendingSteers'],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`CodexProcess: ${name} must be a positive integer`);
      }
    }

    this.clientFactory = clientFactory;
    this.staticPolicyAttestor = staticPolicyAttestor;
    this.checkpointSink = checkpointSink;
    this.hostIdentity = nonEmptyString(hostIdentity, 'hostIdentity');
    this.bootSessionIdentity = nonEmptyString(
      bootSessionIdentity,
      'bootSessionIdentity',
    );
    this.generationId = boundedOpaqueId(
      generationIdFactory(),
      'generationId',
    );
    this.clientUserMessageIdFactory = clientUserMessageIdFactory;
    this.mutationAttemptIdFactory = mutationAttemptIdFactory;
    const legacyPolicy = expectedThreadPolicy;
    const resolvedStaticPolicy = expectedStaticPolicy ?? (
      legacyPolicy
        ? Object.freeze({
            modelProvider: legacyPolicy.modelProvider,
            approvalPolicy: legacyPolicy.approvalPolicy,
            approvalsReviewer: legacyPolicy.approvalsReviewer,
            sandbox: legacyPolicy.sandbox,
            permissionProfile: legacyPolicy.permissionProfile,
          })
        : null
    );
    if (!isDeepFrozen(resolvedStaticPolicy)) {
      throw new TypeError(
        'CodexProcess: expectedStaticPolicy must be deeply frozen',
      );
    }
    this.expectedStaticPolicy = resolvedStaticPolicy;
    const {
      runtimeWorkspaceRoots: _runtimeWorkspaceRoots,
      ...expectedSettingsPolicy
    } = resolvedStaticPolicy;
    this.expectedSettingsPolicy = Object.freeze(expectedSettingsPolicy);
    this.expectedPermissionProfileId = nonEmptyString(
      resolvedStaticPolicy.permissionProfile?.id,
      'expectedStaticPolicy.permissionProfile.id',
    );
    const resolvedCatalog = modelCatalog ?? (
      legacyPolicy?.model && legacyPolicy?.effort
        ? [{
            model: legacyPolicy.model,
            supportedReasoningEfforts: [legacyPolicy.effort],
          }]
        : null
    );
    if (!Array.isArray(resolvedCatalog) || resolvedCatalog.length === 0) {
      throw new TypeError('CodexProcess: modelCatalog required');
    }
    this.modelCatalog = Object.freeze(resolvedCatalog.map((entry) => {
      const model = nonEmptyString(entry?.model, 'modelCatalog.model');
      if (
        !Array.isArray(entry.supportedReasoningEfforts)
        || entry.supportedReasoningEfforts.length === 0
      ) {
        throw new TypeError(
          'CodexProcess: modelCatalog supportedReasoningEfforts required',
        );
      }
      return Object.freeze({
        model,
        supportedReasoningEfforts: Object.freeze(
          entry.supportedReasoningEfforts.map((effort) => (
            nonEmptyString(effort, 'modelCatalog.effort')
          )),
        ),
      });
    }));
    this.queueCap = queueCap;
    this.streamCheckpointBytes = streamCheckpointBytes;
    this.turnStartTimeoutMs = turnStartTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.cleanupPollMs = cleanupPollMs;
    this.protocolFaultThreshold = protocolFaultThreshold;
    this.maxTurnTextBytes = maxTurnTextBytes;
    this.maxTurnItems = maxTurnItems;
    this.maxTerminalHistory = maxTerminalHistory;
    this.maxSteerTextBytes = maxSteerTextBytes;
    this.maxPendingSteers = maxPendingSteers;
    this.logger = logger;

    this.state = 'Spawning';
    this.lifecycleEpoch = 0;
    this.providerSessionId = null;
    this.attachingThreadId = null;
    this.activeTurnId = null;
    this.lastTurnId = null;
    this.lastTerminal = null;
    this.threadStatusType = null;
    this.desiredSettings = null;
    this.observedThreadSettings = null;
    this.admittingTurnSettings = null;
    this.activeTurnSettings = null;
    this.settingsGate = Promise.resolve();
    this.settingsAdmissionClosed = false;
    this.client = null;
    this.current = null;
    this.steerChain = Promise.resolve();
    this.pendingSteerCount = 0;
    this.startPromise = null;
    this.killPromise = null;
    this.interruptPromise = null;
    this.backgroundSettlementPromise = null;
    this.backgroundWatchdog = null;
    this.backgroundWatchdogDeadlineAt = null;
    this.backgroundWatchdogPromise = null;
    this.backgroundCleanupProof = null;
    this.cancellationFlushPromise = null;
    this.pendingCancellations = [];
    this.cancellationSequence = 0;
    this.containmentClosePromise = null;
    this.closeEmitted = false;
    this.protocolFaultCount = 0;
    this.containmentReason = null;
    this.containmentError = null;
    this.startupReleaseSafe = false;
    this.stateChangingWriteCommitted = false;
    this.terminalTurnIds = new Set();
    this.terminalTurnOrder = [];
    this.lastUsedTs = Date.now();
  }

  get cost() {
    return 1;
  }

  _captureLifecycle() {
    return Object.freeze({ epoch: this.lifecycleEpoch });
  }

  _advanceLifecycle() {
    this.lifecycleEpoch += 1;
  }

  _assertLifecycle(fence) {
    if (
      fence?.epoch !== this.lifecycleEpoch
      || this.state === 'ContainmentFailed'
      || this.state === 'DurabilityBlocked'
      || this.state === 'FailedAmbiguous'
    ) {
      throw this._lifecycleFenceError();
    }
  }

  _lifecycleFenceError() {
    if (this.state === 'ContainmentFailed') {
      return processError(
        'Codex lifecycle was superseded by containment',
        'CODEX_CONTAINMENT_FAILED',
        { cause: this.containmentError },
      );
    }
    if (this.state === 'DurabilityBlocked') {
      return processError(
        'Codex lifecycle was superseded by a durability fence',
        'CODEX_DURABILITY_FAILED',
      );
    }
    return processError(
      'Codex lifecycle continuation was superseded',
      'CODEX_LIFECYCLE_SUPERSEDED',
    );
  }

  start(options = {}) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start(options);
    return this.startPromise;
  }

  async _start(options) {
    const lifecycle = this._captureLifecycle();
    const existingSessionId = optionalString(
      options.existingSessionId
        ?? options.providerSessionId
        ?? options.codexThreadId,
      'existingSessionId',
    );
    this.desiredSettings = this._validatedModelSettings({
      model: options.model ?? options.chatConfig?.model,
      effort: options.effort ?? options.chatConfig?.effort,
    });
    this.state = 'Initializing';
    const generationId = this.generationId;
    let threadAccepted = false;
    try {
      this.client = this.clientFactory({
        onNotification: (notification) => {
          if (generationId !== this.generationId) return undefined;
          return this._handleNotification(notification);
        },
        onFault: (outcome) => {
          if (generationId !== this.generationId) return undefined;
          return this._handleClientFault(outcome);
        },
      });
      if (
        !this.client
        || typeof this.client.start !== 'function'
        || typeof this.client.request !== 'function'
        || typeof this.client.close !== 'function'
        || typeof this.client.waitForFault !== 'function'
      ) {
        throw new TypeError(
          'CodexProcess: clientFactory returned an invalid client',
        );
      }
      await this.client.start();
      this._assertLifecycle(lifecycle);
      this.state = 'AttachingThread';
      this.attachingThreadId = existingSessionId;
      const result = await this._withSettingsGate(async () => (
        existingSessionId
          ? this._mutation('thread/resume', {
            threadId: existingSessionId,
          }, { source: null })
          : this._mutation('thread/start', {
            cwd: this.cwd,
            model: this.desiredSettings.model,
          }, { source: null })
      ));
      this._assertLifecycle(lifecycle);
      threadAccepted = true;
      if (typeof result?.thread?.id === 'string' && result.thread.id.length > 0) {
        this.providerSessionId = result.thread.id;
      }
      this._validateThreadResult(result, existingSessionId);
      if (
        this.attachingThreadId
        && result.thread.id !== this.attachingThreadId
      ) {
        throw processError(
          'Codex thread notifications disagreed with the attached thread',
          'CODEX_PROTOCOL_ERROR',
        );
      }
      this.attachingThreadId = null;
      this.claudeSessionId = this.providerSessionId;
      await this._checkpoint('thread-initialized', {
        threadId: this.providerSessionId,
        model: this.desiredSettings.model,
        effort: this.desiredSettings.effort,
        resumed: Boolean(existingSessionId),
      });
      this._assertLifecycle(lifecycle);
      const init = {
        type: 'system',
        subtype: 'init',
        session_id: this.providerSessionId,
        providerSessionId: this.providerSessionId,
        generationId: this.generationId,
        backend: this.backend,
      };
      this.emit('init', init);
      if (result.thread.status.type === 'active') {
        this.state = 'RecoveryConflict';
        this.emit('codex-lifecycle', this._lifecyclePayload(
          'recovery-conflict',
          { reason: 'resumed-thread-active' },
        ));
      } else {
        this.state = 'Idle';
        this.emit('idle');
      }
      return this;
    } catch (error) {
      const durability = this._durabilityFailure(error);
      if (
        !threadAccepted
        && !this.stateChangingWriteCommitted
        && durability?.deliveryState === 'not-sent'
      ) {
        this._blockDurability(durability);
        throw processError(
          'Codex startup durability failed before thread attachment',
          'CODEX_DURABILITY_FAILED',
          { cause: durability },
        );
      }
      if (
        threadAccepted
        || this.stateChangingWriteCommitted
        || this.state === 'ContainmentFailed'
        || this.state === 'DurabilityBlocked'
        || this.state === 'FailedAmbiguous'
        || error?.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
        || error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
        || error?.code === 'CODEX_DURABILITY_FAILED'
      ) {
        if (this.state !== 'ContainmentFailed') {
          await this._enterContainment(
            threadAccepted
              ? 'thread-accepted-before-startup-failure'
              : 'thread-attach-outcome-unknown',
            error,
          );
        }
        throw error;
      }
      try {
        await this._verifyStartupRelease();
      } catch (closeError) {
        await this._enterContainment(
          'startup-close-unverified',
          closeError,
        );
      }
      throw error;
    }
  }

  async _verifyStartupRelease() {
    if (!this.client) {
      this.startupReleaseSafe = true;
    } else {
      await this.client.close();
      const terminalOutcome = await this.client.waitForFault();
      const verifiedSafeFault = (
        terminalOutcome?.boundary === 'pre-spawn'
        && terminalOutcome?.containment === 'safe'
        && terminalOutcome?.cleanup === 'completed'
        && terminalOutcome?.mutationOutcomeUnknown !== true
      );
      if (terminalOutcome !== null && !verifiedSafeFault) {
        throw processError(
          'Codex startup client did not prove a safe terminal close',
          'CODEX_STARTUP_CLOSE_UNVERIFIED',
        );
      }
      this.startupReleaseSafe = true;
    }
    this.state = 'Closed';
    this.closed = true;
    this._emitClose(1);
  }

  _validateThreadResult(result, expectedThreadId) {
    if (!result?.thread?.id) {
      throw processError(
        'Codex thread response omitted the thread ID',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    if (expectedThreadId && result.thread.id !== expectedThreadId) {
      throw processError(
        'Codex resumed a different provider thread',
        'CODEX_PROTOCOL_ERROR',
      );
    }
    this._validateAndObserveThreadPolicy(result, {
      attaching: true,
      attachmentPolicy: true,
    });
  }

  _validateAndObserveThreadPolicy(
    source,
    { attaching = false, attachmentPolicy = false } = {},
  ) {
    const actualStaticPolicy = staticThreadPolicy(source, {
      includeRuntimeWorkspaceRoots: (
        attachmentPolicy
        && Object.hasOwn(this.expectedStaticPolicy, 'runtimeWorkspaceRoots')
      ),
    });
    const expectedStaticPolicy = attachmentPolicy
      ? this.expectedStaticPolicy
      : this.expectedSettingsPolicy;
    if (!isDeepStrictEqual(actualStaticPolicy, expectedStaticPolicy)) {
      throw processError(
        'Codex thread did not attest the exact trusted static policy',
        'CODEX_THREAD_POLICY_MISMATCH',
      );
    }
    let observed;
    try {
      observed = dynamicSettings(source);
    } catch (cause) {
      throw processError(
        'Codex thread omitted its dynamic settings',
        'CODEX_PROTOCOL_ERROR',
        { cause },
      );
    }
    const collaboration = source?.collaborationMode;
    if (
      collaboration != null
      && (
        collaboration.mode !== 'default'
        || collaboration.model !== observed.model
        || (
          collaboration.reasoningEffort != null
          && collaboration.reasoningEffort !== observed.effort
        )
      )
    ) {
      throw processError(
        'Codex collaboration settings disagreed with the observed turn settings',
        'CODEX_THREAD_POLICY_MISMATCH',
      );
    }
    const accepted = [
      this.observedThreadSettings,
      this.admittingTurnSettings,
      this.activeTurnSettings,
    ].filter(Boolean);
    if (
      !attaching
      && !accepted.some((candidate) => isDeepStrictEqual(candidate, observed))
    ) {
      throw processError(
        'Codex thread reported unexplained dynamic settings',
        'CODEX_THREAD_SETTINGS_MISMATCH',
      );
    }
    if (
      attaching
      && this.observedThreadSettings
      && !isDeepStrictEqual(this.observedThreadSettings, observed)
    ) {
      throw processError(
        'Codex thread attachment reported inconsistent dynamic settings',
        'CODEX_THREAD_SETTINGS_MISMATCH',
      );
    }
    this.observedThreadSettings = observed;
  }

  _validatedModelSettings(settings) {
    const selected = modelSettings(settings?.model, settings?.effort);
    const catalogEntry = this.modelCatalog.find(
      (entry) => entry.model === selected.model,
    );
    if (!catalogEntry) {
      throw processError(
        'Codex model is unavailable in the authenticated catalog',
        'CODEX_MODEL_UNAVAILABLE',
      );
    }
    if (!catalogEntry.supportedReasoningEfforts.includes(selected.effort)) {
      throw processError(
        'Codex reasoning effort is unavailable for the selected model',
        'CODEX_EFFORT_UNAVAILABLE',
      );
    }
    return selected;
  }

  _withSettingsGate(operation) {
    const run = this.settingsGate
      .catch(() => {})
      .then(operation);
    this.settingsGate = run.catch(() => {});
    return run;
  }

  _closeSettingsAdmission() {
    // Closing admission must be observable by a turn start that currently
    // holds the gate so interruption can cancel it before transport dispatch.
    this.settingsAdmissionClosed = true;
  }

  send(prompt, {
    timeoutMs = this.turnTimeoutMs,
    maxTurnMs = this.turnTimeoutMs,
    context = {},
  } = {}) {
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return Promise.reject(new TypeError('CodexProcess.send: prompt required'));
    }
    const safePrompt = prompt.replace(CONTROL_CHAR_RE, '');
    if (safePrompt.length !== prompt.length) {
      this.emit('prompt-sanitized', {
        stripped: prompt.length - safePrompt.length,
        source: 'send',
      });
      prompt = safePrompt;
    }
    if (prompt.length === 0) {
      return Promise.reject(new TypeError(
        'CodexProcess.send: prompt was empty after sanitization',
      ));
    }
    const unavailable = this._newWorkError();
    if (unavailable) return Promise.reject(unavailable);
    if (
      !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || !Number.isSafeInteger(maxTurnMs)
      || maxTurnMs < 1
    ) {
      return Promise.reject(new TypeError('CodexProcess.send: invalid timeout'));
    }

    this.lastUsedTs = Date.now();
    const pending = {
      prompt,
      context,
      timeoutMs: Math.min(timeoutMs, maxTurnMs),
      maxTurnMs,
      clientUserMessageId: nonEmptyString(
        this.clientUserMessageIdFactory(),
        'generated clientUserMessageId',
      ),
      attemptId: boundedOpaqueId(
        this.mutationAttemptIdFactory(),
        'mutation attemptId',
      ),
      turnId: null,
      responseSeen: false,
      startedSeen: false,
      startDeliveryState: 'preparing',
      startResponseOutcome: null,
      startCancellationRequested: false,
      startDisposition: makeDeferred(),
      terminal: null,
      terminalDeferred: makeDeferred(),
      turnReady: makeDeferred(),
      streamText: '',
      streamTextBytes: 0,
      uncheckpointedDeltaBytes: 0,
      deltaCheckpointObserved: false,
      lastStreamItemId: null,
      itemText: new Map(),
      completedItemText: new Map(),
      itemIds: new Set(),
      firstStreamFired: false,
      startedAt: null,
      deadlineAt: null,
      settled: false,
      cancelled: false,
      resolve: null,
      reject: null,
      promise: null,
    };
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    pending.promise.catch(() => {});
    this.pendingQueue.push(pending);

    const waitingCount = this.pendingQueue.length - (this.current ? 1 : 0);
    if (waitingCount > this.queueCap) {
      this.pendingQueue.pop();
      const error = processError(
        `Codex send queue is full (cap ${this.queueCap})`,
        'QUEUE_OVERFLOW',
      );
      error.context = context;
      pending.settled = true;
      pending.reject(error);
      this.emit('queue-drop', pending);
      return pending.promise;
    }
    this._pump();
    return pending.promise;
  }

  _pump() {
    if (
      this.current
      || this.closed
      || [
        'Quiescing',
        'Stopped',
        'ContainmentFailed',
        'FailedAmbiguous',
        'RecoveryConflict',
        'DurabilityBlocked',
        'Settling',
        'BackgroundWorking',
        'BackgroundSettling',
      ]
        .includes(this.state)
    ) return;
    const pending = this.pendingQueue[0];
    if (!pending) {
      this.inFlight = false;
      if (this.state !== 'BackgroundWorking') this.state = 'Idle';
      this.emit('idle');
      return;
    }
    this.current = pending;
    this.inFlight = true;
    pending.startedAt = Date.now();
    pending.deadlineAt = pending.startedAt + pending.maxTurnMs;
    this.state = 'StartingTurn';
    try {
      pending.context?.onActivate?.();
    } catch (error) {
      this.logger.error?.(`[${this.label}] onActivate: ${error.message}`);
    }
    void this._runTurn(pending);
  }

  async _runTurn(pending) {
    const lifecycle = this._captureLifecycle();
    try {
      const responseTurnId = await this._withSettingsGate(async () => {
        if (this.settingsAdmissionClosed || this.state === 'Quiescing') {
          throw processError(
            'Codex turn start was cancelled before admission',
            'CODEX_RPC_NOT_SENT',
          );
        }
        const admittedSettings = this.desiredSettings;
        pending.admittedSettings = admittedSettings;
        this.admittingTurnSettings = admittedSettings;
        const params = {
          threadId: this.providerSessionId,
          input: [{ type: 'text', text: pending.prompt }],
          clientUserMessageId: pending.clientUserMessageId,
          model: admittedSettings.model,
          effort: admittedSettings.effort,
        };
        try {
          try {
            await this.staticPolicyAttestor(this.client);
          } catch (cause) {
            const error = processError(
              'Codex static policy changed before turn dispatch',
              cause?.code ?? 'CODEX_STATIC_PROFILE_MISMATCH',
              { cause },
            );
            error.deliveryState = 'not-sent';
            throw error;
          }
          const assertTurnStartAdmission = () => {
            if (
              pending.startCancellationRequested
              || this.settingsAdmissionClosed
              || this.state === 'Quiescing'
            ) {
              if (pending.turnId) return;
              throw processError(
                'Codex turn start was cancelled before dispatch',
                'CODEX_RPC_NOT_SENT',
              );
            }
            this._assertLifecycle(lifecycle);
          };
          const result = await this._mutation('turn/start', params, {
            source: pending.context?.sourceMsgId ?? null,
            clientUserMessageId: pending.clientUserMessageId,
            attemptId: pending.attemptId,
            timeoutMs: this._remainingTurnBudget(pending),
            onDeliveryState: (deliveryState, outcome = null) => {
              pending.startDeliveryState = deliveryState;
              if (deliveryState === 'response-observed') {
                pending.startResponseOutcome = outcome;
              }
            },
            assertCanWrite: assertTurnStartAdmission,
            assertCanCommit: assertTurnStartAdmission,
          });
          this._assertLifecycle(lifecycle);
          const turnId = result?.turn?.id;
          if (!turnId) {
            throw await this._runtimeProtocolFault(
              'turn-start-response-missing-id',
              'Codex turn/start response omitted its turn ID',
            );
          }
          if (pending.turnId && pending.turnId !== turnId) {
            throw await this._runtimeProtocolFault(
              'turn-start-id-mismatch',
              'Codex turn/start response disagreed with turn/started',
            );
          }
          await this._checkpoint('turn-accepted', {
            ...this._turnDetail(pending),
            turnId,
            model: admittedSettings.model,
            effort: admittedSettings.effort,
          });
          this._assertLifecycle(lifecycle);
          this.activeTurnSettings = admittedSettings;
          return turnId;
        } finally {
          if (this.admittingTurnSettings === admittedSettings) {
            this.admittingTurnSettings = null;
          }
        }
      });
      this._assertLifecycle(lifecycle);
      pending.turnId = responseTurnId;
      pending.responseSeen = true;
      pending.startDeliveryState = 'accepted';
      this.activeTurnId = responseTurnId;
      this.lastTurnId = responseTurnId;
      pending.startDisposition.resolve({
        kind: 'accepted',
        turnId: responseTurnId,
      });
      if (pending.startedSeen) pending.turnReady.resolve(responseTurnId);
      await timeout(
        pending.turnReady.promise,
        Math.min(
          this.turnStartTimeoutMs,
          this._remainingTurnBudget(pending),
        ),
        'Codex turn/started notification was not observed',
        'CODEX_TURN_START_TIMEOUT',
      );
      this._assertLifecycle(lifecycle);
      if (this.state === 'StartingTurn') {
        this.state = 'Active';
      }

      const terminal = await timeout(
        pending.terminalDeferred.promise,
        Math.min(pending.timeoutMs, this._remainingTurnBudget(pending)),
        'Codex turn did not reach a terminal state',
        'CODEX_TURN_TIMEOUT',
      );
      this._assertLifecycle(lifecycle);
      if (pending.settled) return;
      try {
        await this._refreshBackgroundState(pending, lifecycle);
        this._assertLifecycle(lifecycle);
      } catch (error) {
        if (this.state !== 'ContainmentFailed') {
          await this._enterContainment(
            'background-probe-failed',
            error,
            pending,
          );
        }
        throw error;
      }
      this._assertLifecycle(lifecycle);
      this._resolveTurn(pending, terminal);
    } catch (error) {
      this._resolveStartDispositionFromError(pending, error);
      if (pending.settled) return;
      if (
        this.state === 'ContainmentFailed'
        || this.state === 'DurabilityBlocked'
        || this.state === 'FailedAmbiguous'
      ) {
        const durability = this._durabilityFailure(error);
        const rejection = (
          error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
          || durability
        )
          ? processError(
            'Codex durability checkpoint failed after dispatch',
            'CODEX_DURABILITY_FAILED',
            { cause: error },
          )
          : this._lifecycleFenceError();
        this._rejectPending(pending, rejection);
        return;
      }
      const normalized = await this._classifyTurnFailure(error, pending);
      this._rejectPending(pending, normalized);
    } finally {
      this._finishPending(pending);
    }
  }

  _remainingTurnBudget(pending) {
    const remaining = (pending.deadlineAt ?? Date.now()) - Date.now();
    if (remaining < 1) {
      throw processError(
        'Codex turn exceeded its activation deadline',
        'CODEX_TURN_TIMEOUT',
      );
    }
    return remaining;
  }

  _resolveStartDispositionFromError(pending, error) {
    if (pending.startDeliveryState === 'accepted') return;
    const durability = this._durabilityFailure(error);
    if (
      error?.code === 'CODEX_RPC_NOT_SENT'
      || durability?.deliveryState === 'not-sent'
    ) {
      pending.startDeliveryState = 'definitely-not-sent';
      pending.startDisposition.resolve({ kind: 'definitely-not-sent' });
      return;
    }
    if (
      error?.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
      || error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
      || durability?.deliveryState === 'ambiguous'
      || pending.startDeliveryState === 'write-attempted'
      || pending.startDeliveryState === 'response-observed'
    ) {
      pending.startDeliveryState = 'outcome-unknown';
      pending.startDisposition.resolve({ kind: 'outcome-unknown' });
      return;
    }
    pending.startDeliveryState = 'definitely-not-sent';
    pending.startDisposition.resolve({ kind: 'definitely-not-sent' });
  }

  async _classifyTurnFailure(error, pending) {
    const durability = this._durabilityFailure(error);
    if (durability?.deliveryState === 'not-sent') {
      this._blockDurability(durability, pending);
      return processError(
        'Codex durability checkpoint failed before dispatch',
        'CODEX_DURABILITY_FAILED',
        { cause: durability },
      );
    }
    if (pending.startCancellationRequested && error?.code === 'CODEX_RPC_NOT_SENT') {
      return processError('Codex turn start was interrupted', 'INTERRUPTED', {
        cause: error,
      });
    }
    if (error?.code === 'CODEX_RPC_NOT_SENT') return error;
    if (
      (
        error?.code === 'CODEX_TURN_TIMEOUT'
        || error?.code === 'CODEX_TURN_START_TIMEOUT'
      )
      && pending.responseSeen
    ) {
      try {
        await this.interrupt();
      } catch (interruptError) {
        if (this.state !== 'ContainmentFailed') {
          await this._enterContainment(
            'turn-timeout-cleanup-failed',
            interruptError,
            pending,
          );
        }
      }
      return error;
    }
    if (
      error?.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
      || error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
      || (
        error?.code === 'CODEX_RPC_ERROR'
        && pending.startResponseOutcome === 'error'
      )
      || (
        error?.code === 'CODEX_DURABILITY_FAILED'
        && error.deliveryState !== 'not-sent'
      )
    ) {
      const durability = error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
        || error?.code === 'CODEX_DURABILITY_FAILED';
      await this._enterFailedAmbiguous(
        durability ? 'durability-failed-after-dispatch' : 'turn-start-outcome-unknown',
        error,
        pending,
      );
      return durability
        ? processError(
          'Codex durability checkpoint failed after dispatch',
          'CODEX_DURABILITY_FAILED',
          { cause: error },
        )
        : error;
    }
    if (this.state === 'ContainmentFailed') return error;
    return error;
  }

  _resolveTurn(pending, terminal) {
    const status = terminal.status;
    const text = this._finalTurnText(pending);
    const duration = Math.max(0, Date.now() - pending.startedAt);
    const result = {
      runtime: 'codex',
      backend: 'codex',
      text,
      sessionId: this.providerSessionId,
      providerSessionId: this.providerSessionId,
      providerTurnId: pending.turnId,
      generationId: this.generationId,
      cost: 0,
      duration,
      error: status === 'completed' ? null : status,
      metrics: {
        inputTokens: null,
        outputTokens: null,
        cacheCreationTokens: null,
        cacheReadTokens: null,
        numAssistantMessages: pending.completedItemText.size,
        numToolUses: 0,
        resultSubtype: status === 'completed' ? 'success' : status,
      },
    };
    Object.defineProperty(result, 'attemptId', {
      value: boundedOpaqueId(pending.attemptId, 'mutation attemptId'),
      enumerable: true,
    });
    this.emit('result', {
      subtype: result.metrics.resultSubtype,
      session_id: this.providerSessionId,
      turn_id: pending.turnId,
      generation_id: this.generationId,
    }, pending);
    this._settlePending(pending, 'resolve', result);
  }

  _finalTurnText(pending) {
    const completed = [...pending.completedItemText.values()]
      .filter(Boolean)
      .join('\n\n');
    return completed || pending.streamText;
  }

  _finishPending(pending) {
    const index = this.pendingQueue.indexOf(pending);
    if (index !== -1) this.pendingQueue.splice(index, 1);
    if (this.current === pending) this.current = null;
    if (this.activeTurnId === pending.turnId) this.activeTurnId = null;
    if (this.activeTurnSettings === pending.admittedSettings) {
      this.activeTurnSettings = null;
    }
    const backgroundOwned = (
      this.state === 'BackgroundWorking'
      || this.state === 'BackgroundSettling'
    );
    if (!backgroundOwned) this.inFlight = false;
    if (
      !this.closed
      && ![
        'Quiescing',
        'Stopped',
        'ContainmentFailed',
        'RecoveryConflict',
        'DurabilityBlocked',
        'BackgroundWorking',
        'BackgroundSettling',
      ]
        .includes(this.state)
    ) {
      this.state = 'Idle';
      this._pump();
    }
  }

  steerTurn(text, { context = {} } = {}) {
    if (
      typeof text === 'string'
      && Buffer.byteLength(text) > this.maxSteerTextBytes
    ) {
      return Promise.resolve({
        outcome: 'unavailable',
        reason: 'input-too-large',
      });
    }
    if (this.pendingSteerCount >= this.maxPendingSteers) {
      return Promise.reject(processError(
        'Codex steer queue is full',
        'CODEX_STEER_QUEUE_OVERFLOW',
      ));
    }
    this.pendingSteerCount += 1;
    const operation = this.steerChain.then(
      () => this._steerTurn(text, context),
      () => this._steerTurn(text, context),
    );
    const tracked = operation.finally(() => {
      this.pendingSteerCount -= 1;
    });
    this.steerChain = tracked.catch(() => {});
    return tracked;
  }

  async _steerTurn(text, context) {
    const lifecycle = this._captureLifecycle();
    if (typeof text !== 'string' || text.length === 0) {
      return { outcome: 'unavailable', reason: 'empty-input' };
    }
    const unavailableReason = this._steerUnavailableReason();
    if (unavailableReason) {
      return { outcome: 'unavailable', reason: unavailableReason };
    }

    let turnId = this.activeTurnId;
    const pending = this.current;
    if (pending && this.state === 'StartingTurn') {
      try {
        turnId = await timeout(
          pending.turnReady.promise,
          Math.min(
            this.turnStartTimeoutMs,
            this._remainingTurnBudget(pending),
          ),
          'Codex turn ID was not observed before steering',
          'CODEX_TURN_START_TIMEOUT',
        );
        this._assertLifecycle(lifecycle);
      } catch (error) {
        if (this.state === 'ContainmentFailed') throw error;
        return { outcome: 'unavailable', reason: 'turn-start-pending' };
      }
    }
    if (!turnId || !this.current || this.current.terminal) {
      return {
        outcome: 'queueable-not-active',
        turnId: turnId ?? this.lastTurnId,
      };
    }

    const clientUserMessageId = nonEmptyString(
      this.clientUserMessageIdFactory(),
      'generated clientUserMessageId',
    );
    const attemptId = boundedOpaqueId(
      this.mutationAttemptIdFactory(),
      'mutation attemptId',
    );
    const targetAttemptId = boundedOpaqueId(
      pending.attemptId,
      'target mutation attemptId',
    );
    try {
      const result = await this._mutation('turn/steer', {
        threadId: this.providerSessionId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text }],
        clientUserMessageId,
      }, {
        source: context?.sourceMsgId ?? null,
        clientUserMessageId,
        turnId,
        attemptId,
        timeoutMs: this._remainingTurnBudget(pending),
        assertCanWrite: () => {
          const reason = this._steerUnavailableReason();
          if (reason) {
            throw processError(
              `Codex steering became unavailable: ${reason}`,
              'CODEX_RPC_NOT_SENT',
            );
          }
        },
      });
      this._assertLifecycle(lifecycle);
      if (result.turnId !== turnId) {
        throw await this._runtimeProtocolFault(
          'steer-turn-id-mismatch',
          'Codex turn/steer acknowledged a different turn',
        );
      }
      await this._checkpoint('turn-steer-accepted', {
        threadId: this.providerSessionId,
        turnId,
        source: context?.sourceMsgId ?? null,
        clientUserMessageId,
        attemptId,
      });
      this._assertLifecycle(lifecycle);
      return Object.freeze({
        outcome: 'accepted',
        turnId: boundedOpaqueId(turnId, 'turnId'),
        generationId: this.generationId,
        attemptId,
        targetAttemptId,
      });
    } catch (error) {
      const durabilityFailure = this._durabilityFailure(error);
      if (durabilityFailure?.deliveryState === 'not-sent') {
        this._blockDurability(durabilityFailure, this.current);
        throw processError(
          'Codex durability checkpoint failed before steering dispatch',
          'CODEX_DURABILITY_FAILED',
          { cause: durabilityFailure },
        );
      }
      if (
        error?.code === 'CODEX_RPC_ERROR'
        && error.rpcMessage === 'no active turn to steer'
      ) {
        return { outcome: 'queueable-not-active', turnId };
      }
      if (
        error?.code === 'CODEX_RPC_NOT_SENT'
        && !this._steerUnavailableReason()
      ) {
        return { outcome: 'queueable-not-active', turnId };
      }
      if (
        error?.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
        || error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
        || error?.code === 'CODEX_DURABILITY_FAILED'
        || error?.code === 'CODEX_RPC_ERROR'
      ) {
        const reason = error.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
          ? 'steer-outcome-unknown'
          : error.code === 'CODEX_RPC_ERROR'
            ? 'steer-rpc-error-unclassified'
            : 'durability-failed-after-dispatch';
        await this._enterFailedAmbiguous(
          reason,
          error,
        );
        if (
          error.code === 'CODEX_RPC_CHECKPOINT_FAILED'
          || error.code === 'CODEX_DURABILITY_FAILED'
        ) {
          throw processError(
            'Codex durability checkpoint failed after steering dispatch',
            'CODEX_DURABILITY_FAILED',
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  async interrupt() {
    if (this.interruptPromise) return this.interruptPromise;
    this.interruptPromise = this._interrupt();
    return this.interruptPromise;
  }

  async _interrupt(controlDeadlineOverride = null) {
    if (this.closed) return false;
    if (this.state === 'ContainmentFailed') {
      throw processError(
        'Codex generation is containment-failed',
        'CODEX_CONTAINMENT_FAILED',
      );
    }
    if (this.state === 'FailedAmbiguous') {
      throw processError(
        'Codex generation has an ambiguous mutation outcome',
        'CODEX_RPC_OUTCOME_UNKNOWN',
      );
    }
    if (this.state === 'RecoveryConflict') {
      return false;
    }
    this._closeSettingsAdmission();
    const priorState = this.state;
    this._clearBackgroundWatchdog();
    const backgroundSettlement = this.backgroundSettlementPromise;
    const pending = this.current;
    const controlDeadline = controlDeadlineOverride
      ?? pending?.deadlineAt
      ?? this.lastTerminal?.deadlineAt
      ?? (Date.now() + this.interruptTimeoutMs + this.cleanupTimeoutMs);
    let turnId = this.activeTurnId
      ?? pending?.turnId
      ?? (
        (
          priorState === 'BackgroundWorking'
          || priorState === 'BackgroundSettling'
        )
          ? this.lastTerminal?.turnId
          : null
      );
    this.state = 'Quiescing';
    const lifecycle = this._captureLifecycle();
    this._drainWaiting('INTERRUPTED');
    await this.steerChain;
    this._assertLifecycle(lifecycle);
    await this._flushPendingCancellations();
    this._assertLifecycle(lifecycle);
    if (backgroundSettlement) {
      await backgroundSettlement;
      this._assertLifecycle(lifecycle);
    }
    let interruptEventEmitted = false;
    if (pending && priorState === 'StartingTurn') {
      pending.startCancellationRequested = true;
      let disposition;
      if (
        pending.startDeliveryState === 'preparing'
        || pending.startDeliveryState === 'prepared'
      ) {
        disposition = { kind: 'definitely-not-sent' };
      } else if (
        pending.startDeliveryState === 'write-checkpointing'
        ||
        pending.startDeliveryState === 'write-attempted'
        || pending.startDeliveryState === 'response-observed'
      ) {
        try {
          disposition = await timeout(
            pending.startDisposition.promise,
            Math.max(
              1,
              Math.min(
                this.turnStartTimeoutMs,
                controlDeadline - Date.now(),
              ),
            ),
            'Codex turn start disposition was not observed before interruption',
            'CODEX_TURN_START_TIMEOUT',
          );
          this._assertLifecycle(lifecycle);
        } catch (error) {
          disposition = { kind: 'outcome-unknown', cause: error };
        }
      } else if (pending.startDeliveryState === 'accepted') {
        disposition = { kind: 'accepted', turnId: pending.turnId };
      } else {
        disposition = { kind: pending.startDeliveryState };
      }
      if (disposition.kind === 'accepted') {
        turnId = disposition.turnId ?? pending.turnId;
      } else if (disposition.kind === 'definitely-not-sent') {
        turnId = null;
        try {
          await this._checkpoint('active-start-cancelled', {
            ...this._turnDetail(pending),
            attemptId: pending.attemptId,
            deliveryState: 'definitely-not-sent',
          });
          this._assertLifecycle(lifecycle);
        } catch (error) {
          pending.cancelled = true;
          this._blockDurability(error);
          throw processError(
            'Codex active-start cancellation was not durable',
            'CODEX_DURABILITY_FAILED',
            { cause: error },
          );
        }
        const cancelled = processError(
          'Codex turn start was interrupted before dispatch',
          'INTERRUPTED',
        );
        pending.cancelled = true;
        this._rejectPending(pending, cancelled);
        this._finishPending(pending);
      } else {
        const error = disposition.cause ?? processError(
          'Codex turn start delivery outcome is unknown',
          'CODEX_RPC_OUTCOME_UNKNOWN',
        );
        await this._enterFailedAmbiguous(
          'interrupt-turn-start-outcome-unknown',
          error,
          pending,
        );
        throw error;
      }
    }

    try {
      const cleanupProof = this.backgroundCleanupProof;
      const reuseBackgroundCleanup = (
        cleanupProof?.turnId != null
        && cleanupProof.turnId === turnId
      );
      let terminal = pending?.terminal
        ?? (
          this.lastTerminal?.turnId === turnId
            ? this.lastTerminal
            : null
        );
      if (turnId && !terminal) {
        try {
          await this._mutation('turn/interrupt', {
            threadId: this.providerSessionId,
            turnId,
          }, {
            source: pending?.context?.sourceMsgId ?? null,
            turnId,
            timeoutMs: Math.max(1, controlDeadline - Date.now()),
          });
          this._assertLifecycle(lifecycle);
          this.emit('interrupt-applied', {
            backend: this.backend,
            generationId: this.generationId,
            turnId,
          });
          interruptEventEmitted = true;
        } catch (error) {
          const naturalRace = (
            error?.code === 'CODEX_RPC_ERROR'
            && error.rpcMessage === 'no active turn to interrupt'
          );
          if (!naturalRace) throw error;
        }
        terminal = pending?.terminal ?? await timeout(
          pending.terminalDeferred.promise,
          Math.max(
            1,
            Math.min(this.interruptTimeoutMs, controlDeadline - Date.now()),
          ),
          'Codex interrupted turn did not reach an exact terminal state',
          'CODEX_INTERRUPT_TIMEOUT',
        );
        this._assertLifecycle(lifecycle);
      }
      if (turnId) {
        if (!terminal || terminal.turnId !== turnId) {
          throw processError(
            'Codex interruption did not reconcile the exact turn',
            'CODEX_INTERRUPT_UNMATCHED',
          );
        }
        if (reuseBackgroundCleanup) {
          await this._checkpoint('stop-background-cleanup-reused', {
            threadId: this.providerSessionId,
            turnId,
            terminalStatus: cleanupProof.terminalStatus,
          });
        } else {
          await this._checkpoint('stop-terminal-reconciled', {
            threadId: this.providerSessionId,
            turnId,
            terminalStatus: terminal.status,
          });
        }
        this._assertLifecycle(lifecycle);
      }

      if (!reuseBackgroundCleanup) {
        await this._mutation('thread/backgroundTerminals/clean', {
          threadId: this.providerSessionId,
        }, {
          source: null,
          turnId,
          timeoutMs: Math.max(1, controlDeadline - Date.now()),
        });
        this._assertLifecycle(lifecycle);
        await this._checkpoint('stop-clean-accepted', {
          threadId: this.providerSessionId,
          turnId,
        });
        this._assertLifecycle(lifecycle);
        await this._waitForFreshEmptyRegistry(controlDeadline, lifecycle);
        this._assertLifecycle(lifecycle);
        await this._checkpoint('stop-empty-registry-observed', {
          threadId: this.providerSessionId,
          turnId,
        });
        this._assertLifecycle(lifecycle);
      }
      if (!interruptEventEmitted) {
        this.emit('interrupt-applied', {
          backend: this.backend,
          generationId: this.generationId,
          turnId,
        });
      }
      this.state = 'Stopped';
      this.inFlight = false;
      this.emit('codex-settled', this._lifecyclePayload('stopped', {
        turnId,
        terminalStatus: terminal?.status ?? null,
        trackedTerminalCleanupAccepted: true,
        freshRegistryObservedEmpty: true,
      }));
      return true;
    } catch (error) {
      if (
        this.state !== 'ContainmentFailed'
        && this.state !== 'DurabilityBlocked'
      ) {
        await this._enterContainment(
          error?.code === 'CODEX_DURABILITY_FAILED'
            || error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
            ? 'stop-checkpoint-failed'
            : 'stop-cleanup-failed',
          error,
        );
      }
      if (error?.code === 'CODEX_RPC_CHECKPOINT_FAILED') {
        throw processError(
          'Codex durability checkpoint failed during stop',
          'CODEX_DURABILITY_FAILED',
          { cause: error },
        );
      }
      throw error;
    }
  }

  async _waitForFreshEmptyRegistry(
    deadline = Date.now() + this.cleanupTimeoutMs,
    lifecycle = this._captureLifecycle(),
  ) {
    do {
      const page = await this.client.request(
        'thread/backgroundTerminals/list',
        { threadId: this.providerSessionId, limit: 100 },
        { timeoutMs: Math.max(1, deadline - Date.now()) },
      );
      this._assertLifecycle(lifecycle);
      if (page.count === 0 && page.nextCursor == null) return;
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.cleanupPollMs, deadline - Date.now()));
      this._assertLifecycle(lifecycle);
    } while (Date.now() < deadline);
    throw processError(
      'Codex background terminal registry did not become freshly empty',
      'CODEX_TERMINAL_CLEANUP_TIMEOUT',
    );
  }

  async _refreshBackgroundState(pending, lifecycle) {
    if (
      this.state === 'Quiescing'
      || this.state === 'ContainmentFailed'
      || this.state === 'FailedAmbiguous'
      || this.state === 'DurabilityBlocked'
    ) return;
    const page = await this.client.request(
      'thread/backgroundTerminals/list',
      { threadId: this.providerSessionId, limit: 100 },
      {
        timeoutMs: Math.max(1, this._remainingTurnBudget(pending)),
      },
    );
    this._assertLifecycle(lifecycle);
    if (page.count > 0 || page.nextCursor != null) {
      this.state = 'BackgroundWorking';
      this._armBackgroundWatchdog(pending.deadlineAt);
      if (this.threadStatusType === 'idle') {
        this._scheduleBackgroundSettlement();
      }
    }
  }

  async _mutation(method, params, detail) {
    const attemptId = boundedOpaqueId(
      detail.attemptId ?? this.mutationAttemptIdFactory(),
      'mutation attemptId',
    );
    const prepared = {
      method,
      attemptId,
      threadId: params.threadId ?? this.providerSessionId,
      turnId: detail.turnId ?? params.turnId ?? params.expectedTurnId ?? null,
      source: detail.source ?? null,
      clientUserMessageId: detail.clientUserMessageId ?? null,
    };
    try {
      await this._checkpoint('request-prepared', prepared);
    } catch (error) {
      const durability = processError(
        `Codex ${method} prepared checkpoint failed`,
        'CODEX_DURABILITY_FAILED',
        { cause: error },
      );
      durability.deliveryState = 'not-sent';
      throw durability;
    }
    detail.onDeliveryState?.('prepared');
    detail.assertCanWrite?.();
    return this.client.request(method, params, {
      timeoutMs: detail.timeoutMs,
      onWriteAttempted: async (transport) => {
        detail.assertCanWrite?.();
        detail.onDeliveryState?.('write-checkpointing');
        await this._transportCheckpoint(
          'request-write-attempted',
          prepared,
          transport,
          () => {
            this.stateChangingWriteCommitted = true;
            detail.onDeliveryState?.('write-attempted');
          },
          detail.assertCanCommit,
        );
      },
      onResponseObserved: async (transport) => {
        await this._transportCheckpoint(
          'request-response-observed',
          { ...prepared, outcome: transport.outcome },
          transport,
        );
        detail.onDeliveryState?.('response-observed', transport.outcome);
      },
    });
  }

  async _transportCheckpoint(
    kind,
    detail,
    transport,
    onCommitted = null,
    assertCanCommit = null,
  ) {
    transport.assertActive?.();
    const payload = this._checkpointPayload(kind, {
      ...detail,
      requestId: transport.id,
    });
    const properties = {
      signal: {
        value: transport.signal,
        enumerable: false,
      },
      assertActive: {
        value: transport.assertActive,
        enumerable: false,
      },
    };
    let writeCommitted = false;
    let commitRejection = null;
    const markWriteCommitted = () => {
      transport.assertActive?.();
      if (writeCommitted) return;
      try {
        assertCanCommit?.();
      } catch (error) {
        commitRejection = error;
        throw error;
      }
      transport.markWriteCommitted?.();
      writeCommitted = true;
      onCommitted?.();
    };
    if (kind === 'request-write-attempted') {
      properties.markWriteCommitted = {
        value: markWriteCommitted,
        enumerable: false,
      };
    }
    Object.defineProperties(payload, properties);
    try {
      await this.checkpointSink(payload);
    } catch (error) {
      if (error === commitRejection) throw error;
      const durability = processError(
        `Codex checkpoint ${kind} failed`,
        'CODEX_DURABILITY_FAILED',
        { cause: error },
      );
      durability.deliveryState = kind === 'request-write-attempted'
        ? writeCommitted ? 'ambiguous' : 'not-sent'
        : 'ambiguous';
      if (
        kind === 'request-response-observed'
        || (kind === 'request-write-attempted' && writeCommitted)
      ) {
        await this._enterFailedAmbiguous(
          kind === 'request-response-observed'
            ? 'response-checkpoint-failed-after-dispatch'
            : 'write-checkpoint-failed-after-commit',
          durability,
          this.current,
        );
      }
      throw durability;
    }
    if (kind === 'request-write-attempted') {
      markWriteCommitted();
    }
    transport.assertActive?.();
  }

  async _checkpoint(kind, detail = {}, fence = null) {
    fence?.assertActive?.();
    const payload = this._checkpointPayload(kind, detail);
    if (fence) {
      Object.defineProperties(payload, {
        signal: {
          value: fence.signal,
          enumerable: false,
        },
        assertActive: {
          value: fence.assertActive,
          enumerable: false,
        },
      });
    }
    try {
      await this.checkpointSink(payload);
    } catch (error) {
      const durability = processError(
        `Codex checkpoint ${kind} failed`,
        'CODEX_DURABILITY_FAILED',
        { cause: error },
      );
      durability.deliveryState = 'ambiguous';
      throw durability;
    }
    fence?.assertActive?.();
  }

  _checkpointPayload(kind, detail) {
    return {
      kind,
      generationId: this.generationId,
      threadId: detail.threadId ?? this.providerSessionId,
      turnId: detail.turnId ?? null,
      source: detail.source ?? null,
      clientUserMessageId: detail.clientUserMessageId ?? null,
      hostIdentity: this.hostIdentity,
      bootSessionIdentity: this.bootSessionIdentity,
      ...detail,
    };
  }

  async _handleNotification(notification) {
    const fence = {
      signal: notification?.signal,
      assertActive: notification?.assertActive,
    };
    fence.assertActive?.();
    try {
      return await this._handleNotificationWithFence(notification, fence);
    } catch (error) {
      const durability = this._durabilityFailure(error);
      if (
        durability
        && this.state !== 'ContainmentFailed'
        && this.state !== 'DurabilityBlocked'
      ) {
        await this._enterFailedAmbiguous(
          'notification-checkpoint-failed',
          durability,
        );
      }
      throw error;
    } finally {
      fence.assertActive?.();
    }
  }

  async _handleNotificationWithFence(notification, fence) {
    if (
      this.closed
      || this.state === 'Closed'
      || this.state === 'ContainmentFailed'
    ) return;
    const { method, params = {} } = notification ?? {};
    if (
      params.threadId
      && !this.providerSessionId
      && this.state === 'AttachingThread'
      && !this.attachingThreadId
    ) {
      this.attachingThreadId = params.threadId;
    }
    const ownedThreadId = this.providerSessionId ?? this.attachingThreadId;
    if (params.threadId && params.threadId !== ownedThreadId) {
      await this._notificationProtocolFault(
        'cross-thread-notification',
        'Codex emitted traffic for another provider thread',
        fence,
      );
      return;
    }
    if (method === 'thread/settings/updated') {
      try {
        this._validateAndObserveThreadPolicy(params.threadSettings, {
          attaching: this.state === 'AttachingThread',
        });
      } catch (error) {
        await this._enterContainment(
          'thread-settings-drift',
          error,
          null,
          fence,
        );
      }
      fence.assertActive?.();
      return;
    }
    if (method === 'thread/status/changed') {
      const statusType = params.status?.type ?? null;
      await this._checkpoint('thread-status-changed', {
        threadId: ownedThreadId,
        statusType,
      }, fence);
      fence.assertActive?.();
      this.threadStatusType = statusType;
      if (
        statusType === 'active'
        && !this.current
        && this.state === 'Idle'
      ) {
        this.state = 'BackgroundWorking';
      } else if (
        statusType === 'idle'
        && this.state === 'BackgroundWorking'
      ) {
        this._scheduleBackgroundSettlement();
      }
      fence.assertActive?.();
      return;
    }
    if (method === 'error') {
      const pending = await this._notificationPending(params.turnId, fence);
      if (!pending) return;
      await this._checkpoint('turn-error-observed', {
        ...this._turnDetail(pending),
        willRetry: params.willRetry,
      }, fence);
      if (!params.willRetry) {
        pending.providerError = 'provider-error';
      }
      fence.assertActive?.();
      return;
    }
    if (method === 'turn/started') {
      const pending = this.current;
      const turnId = params.turn?.id;
      if (!pending) {
        if (!this.terminalTurnIds.has(turnId)) {
          await this._notificationProtocolFault(
            'unexpected-turn-start',
            'Codex started a turn without an owned send',
            fence,
          );
        }
        return;
      }
      if (pending.turnId && pending.turnId !== turnId) {
        throw await this._notificationProtocolFault(
          'turn-start-id-mismatch',
          'Codex turn/started disagreed with the owned turn',
          fence,
        );
      }
      await this._checkpoint('turn-started', {
        ...this._turnDetail(pending),
        turnId,
      }, fence);
      pending.turnId = turnId;
      pending.startedSeen = true;
      this.activeTurnId = turnId;
      this.lastTurnId = turnId;
      if (pending.admittedSettings) {
        this.activeTurnSettings = pending.admittedSettings;
      }
      if (pending.responseSeen) pending.turnReady.resolve(turnId);
      fence.assertActive?.();
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const pending = await this._notificationPending(params.turnId, fence);
      if (!pending) return;
      if (!this._canTrackItem(pending, params.itemId)) {
        await this._notificationProtocolFault(
          'turn-item-limit-exceeded',
          'Codex turn exceeded its bounded item history',
          fence,
        );
        return;
      }
      const prior = pending.itemText.get(params.itemId) ?? '';
      const nextText = prior + params.delta;
      const deltaBytes = Buffer.byteLength(params.delta);
      const isNewItem = !pending.itemText.has(params.itemId);
      const separatorBytes = isNewItem && pending.itemText.size > 0 ? 2 : 0;
      const streamTextBytes = (
        pending.streamTextBytes
        + separatorBytes
        + deltaBytes
      );
      if (streamTextBytes > this.maxTurnTextBytes) {
        await this._notificationProtocolFault(
          'turn-text-limit-exceeded',
          'Codex turn exceeded its bounded text history',
          fence,
        );
        return;
      }
      const batchedDeltaBytes = (
        pending.uncheckpointedDeltaBytes
        + deltaBytes
      );
      if (
        !pending.deltaCheckpointObserved
        || batchedDeltaBytes >= this.streamCheckpointBytes
      ) {
        await this._checkpoint('item-delta-observed', {
          ...this._turnDetail(pending),
          itemId: params.itemId,
          deltaBytes,
          batchedDeltaBytes,
        }, fence);
        pending.deltaCheckpointObserved = true;
        pending.uncheckpointedDeltaBytes = 0;
      } else {
        pending.uncheckpointedDeltaBytes = batchedDeltaBytes;
      }
      let streamText;
      if (isNewItem) {
        streamText = pending.streamText
          + (pending.itemText.size > 0 ? '\n\n' : '')
          + params.delta;
      } else if (pending.lastStreamItemId === params.itemId) {
        streamText = pending.streamText + params.delta;
      } else {
        const nextItems = new Map(pending.itemText);
        nextItems.set(params.itemId, nextText);
        streamText = [...nextItems.values()].join('\n\n');
      }
      pending.itemIds.add(params.itemId);
      pending.itemText.set(params.itemId, nextText);
      pending.streamText = streamText;
      pending.streamTextBytes = streamTextBytes;
      if (isNewItem) pending.lastStreamItemId = params.itemId;
      this._fireFirstStream(pending);
      this.emit('stream-chunk', pending.streamText);
      fence.assertActive?.();
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const pending = await this._notificationPending(params.turnId, fence);
      if (!pending) return;
      const item = params.item;
      if (!item?.id || !this._canTrackItem(pending, item.id)) {
        await this._notificationProtocolFault(
          'turn-item-limit-exceeded',
          'Codex turn exceeded its bounded item history',
          fence,
        );
        return;
      }
      let authoritative = null;
      let authoritativeIsNew = false;
      if (
        method === 'item/completed'
        && item.type === 'agentMessage'
        && typeof item.text === 'string'
      ) {
        authoritativeIsNew = !pending.itemText.has(item.id);
        const nextItems = new Map(pending.itemText);
        nextItems.set(item.id, item.text);
        authoritative = [...nextItems.values()].join('\n\n');
        if (Buffer.byteLength(authoritative) > this.maxTurnTextBytes) {
          await this._notificationProtocolFault(
            'turn-text-limit-exceeded',
            'Codex turn exceeded its bounded text history',
            fence,
          );
          return;
        }
      }
      await this._checkpoint(
        method === 'item/started' ? 'item-started' : 'item-completed',
        {
          ...this._turnDetail(pending),
          itemId: item.id,
          itemType: item.type,
        },
        fence,
      );
      pending.itemIds.add(item.id);
      if (authoritative != null) {
        pending.completedItemText.set(item.id, item.text);
        pending.itemText.set(item.id, item.text);
        pending.streamTextBytes = Buffer.byteLength(authoritative);
        pending.uncheckpointedDeltaBytes = 0;
        if (authoritativeIsNew) pending.lastStreamItemId = item.id;
        if (authoritative !== pending.streamText) {
          pending.streamText = authoritative;
          this._fireFirstStream(pending);
          this.emit('stream-chunk', pending.streamText);
        }
      }
      fence.assertActive?.();
      return;
    }
    if (method === 'turn/completed') {
      const turnId = params.turn?.id;
      if (this.terminalTurnIds.has(turnId)) return;
      const pending = await this._notificationPending(turnId, fence);
      if (!pending) return;
      const status = params.turn.status;
      if (!['completed', 'interrupted', 'failed'].includes(status)) {
        throw await this._notificationProtocolFault(
          'invalid-turn-terminal',
          'Codex emitted a non-terminal turn/completed state',
          fence,
        );
      }
      const terminal = {
        turnId,
        status,
        deadlineAt: pending.deadlineAt,
      };
      await this._checkpoint('turn-terminal', {
        ...this._turnDetail(pending),
        terminalStatus: status,
      }, fence);
      pending.terminal = terminal;
      this.lastTerminal = terminal;
      this._rememberTerminal(turnId);
      if (
        this.state !== 'Quiescing'
        && this.state !== 'DurabilityBlocked'
      ) {
        this.state = 'Settling';
      }
      pending.terminalDeferred.resolve(terminal);
      fence.assertActive?.();
    }
  }

  async _notificationPending(turnId, fence) {
    const pending = this.current;
    if (!pending || !turnId || pending.turnId !== turnId) {
      if (turnId && this.terminalTurnIds.has(turnId)) {
        return null;
      }
      await this._notificationProtocolFault(
        'foreign-turn-notification',
        'Codex emitted an event for a turn not owned by this generation',
        fence,
      );
      return null;
    }
    return pending;
  }

  _canTrackItem(pending, itemId) {
    return (
      pending.itemIds.has(itemId)
      || pending.itemIds.size < this.maxTurnItems
    );
  }

  _fireFirstStream(pending) {
    if (pending.firstStreamFired) return;
    pending.firstStreamFired = true;
    try {
      pending.context?.onFirstStream?.();
    } catch (error) {
      this.logger.error?.(`[${this.label}] onFirstStream: ${error.message}`);
    }
  }

  _rememberTerminal(turnId) {
    this.terminalTurnIds.add(turnId);
    this.terminalTurnOrder.push(turnId);
    while (this.terminalTurnOrder.length > this.maxTerminalHistory) {
      this.terminalTurnIds.delete(this.terminalTurnOrder.shift());
    }
  }

  async _notificationProtocolFault(reason, message, fence) {
    const error = this._protocolFault(reason, message, false);
    if (this.protocolFaultCount >= this.protocolFaultThreshold) {
      await this._enterContainment(reason, error, null, fence);
    }
    return error;
  }

  async _runtimeProtocolFault(reason, message) {
    const error = this._protocolFault(reason, message, false);
    if (this.protocolFaultCount >= this.protocolFaultThreshold) {
      await this._enterContainment(reason, error);
    }
    return error;
  }

  async _handleClientFault(outcome) {
    if (this.closed) return;
    if (
      outcome?.boundary === 'post-spawn'
      || outcome?.containment === 'unverified'
    ) {
      await this._enterContainment(
        outcome?.errorCode === 'CODEX_RPC_OUTCOME_UNKNOWN'
          ? 'rpc-outcome-unknown'
          : 'app-server-fault',
        processError(
          'Codex app-server faulted after spawn',
          outcome?.errorCode ?? 'CODEX_PROCESS_EXITED',
        ),
      );
    }
  }

  async _settleNaturalBackgroundWork() {
    const lifecycle = this._captureLifecycle();
    const terminal = this.lastTerminal;
    const deadline = terminal?.deadlineAt ?? Date.now();
    try {
      this._assertLifecycle(lifecycle);
      if (!terminal) {
        throw processError(
          'Codex background work had no owned terminal turn',
          'CODEX_BACKGROUND_OWNERSHIP_UNKNOWN',
        );
      }
      await this._checkpoint('background-terminal-reconciled', {
        threadId: this.providerSessionId,
        turnId: terminal.turnId,
        terminalStatus: terminal.status,
      });
      this._assertLifecycle(lifecycle);
      await this._mutation('thread/backgroundTerminals/clean', {
        threadId: this.providerSessionId,
      }, {
        source: null,
        turnId: terminal.turnId,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      this._assertLifecycle(lifecycle);
      await this._checkpoint('background-clean-accepted', {
        threadId: this.providerSessionId,
        turnId: terminal.turnId,
      });
      this._assertLifecycle(lifecycle);
      await this._waitForFreshEmptyRegistry(deadline, lifecycle);
      this._assertLifecycle(lifecycle);
      await this._checkpoint('background-empty-registry-observed', {
        threadId: this.providerSessionId,
        turnId: terminal.turnId,
      });
      this._assertLifecycle(lifecycle);
      this.backgroundCleanupProof = Object.freeze({
        turnId: terminal.turnId,
        terminalStatus: terminal.status,
        deadlineAt: deadline,
      });
      this._clearBackgroundWatchdog();
      if (this.state === 'Quiescing') return this.backgroundCleanupProof;
      this.state = 'Idle';
      this.inFlight = false;
      this.emit('codex-settled', this._lifecyclePayload(
        'background-settled',
        {
          turnId: terminal.turnId,
          terminalStatus: terminal.status,
          trackedTerminalCleanupAccepted: true,
          freshRegistryObservedEmpty: true,
        },
      ));
      this.emit('idle');
      this._pump();
      return this.backgroundCleanupProof;
    } catch (error) {
      if (this.state !== 'ContainmentFailed') {
        await this._enterContainment(
          error?.code === 'CODEX_DURABILITY_FAILED'
            || error?.code === 'CODEX_RPC_CHECKPOINT_FAILED'
            ? 'background-checkpoint-failed'
            : 'background-cleanup-failed',
          error,
        );
      }
      throw error;
    }
  }

  _scheduleBackgroundSettlement() {
    if (this.backgroundSettlementPromise) return;
    this.state = 'BackgroundSettling';
    this.inFlight = true;
    this.backgroundSettlementPromise = Promise.resolve()
      .then(() => this._settleNaturalBackgroundWork())
      .finally(() => {
        this.backgroundSettlementPromise = null;
      });
    this.backgroundSettlementPromise.catch(() => {});
  }

  _armBackgroundWatchdog(deadlineAt) {
    if (!Number.isFinite(deadlineAt)) return;
    if (
      this.backgroundWatchdog
      && this.backgroundWatchdogDeadlineAt === deadlineAt
    ) return;
    this._clearBackgroundWatchdog();
    this.backgroundWatchdogDeadlineAt = deadlineAt;
    this.backgroundWatchdog = setTimeout(() => {
      this.backgroundWatchdog = null;
      this.backgroundWatchdogDeadlineAt = null;
      if (
        this.state !== 'BackgroundWorking'
        && this.state !== 'BackgroundSettling'
      ) return;
      if (!this.interruptPromise) {
        this.interruptPromise = this._interrupt(
          Date.now() + this.interruptTimeoutMs + this.cleanupTimeoutMs,
        );
      }
      this.backgroundWatchdogPromise = this.interruptPromise
        .catch(async (error) => {
          if (
            this.state !== 'ContainmentFailed'
            && this.state !== 'DurabilityBlocked'
          ) {
            await this._enterContainment(
              'background-deadline-stop-failed',
              error,
            );
          }
        })
        .finally(() => {
          this.backgroundWatchdogPromise = null;
        });
    }, Math.max(1, deadlineAt - Date.now()));
    this.backgroundWatchdog.unref?.();
  }

  _clearBackgroundWatchdog() {
    if (this.backgroundWatchdog) clearTimeout(this.backgroundWatchdog);
    this.backgroundWatchdog = null;
    this.backgroundWatchdogDeadlineAt = null;
  }

  _protocolFault(reason, message, enterContainment = true) {
    const error = processError(message, 'CODEX_PROTOCOL_ERROR');
    this.protocolFaultCount += 1;
    this.emit('protocol-security-fault', this._lifecyclePayload(
      'protocol-security-fault',
      { reason, count: this.protocolFaultCount },
    ));
    if (enterContainment && this.protocolFaultCount >= this.protocolFaultThreshold) {
      void this._enterContainment(reason, error);
    }
    return error;
  }

  async _enterFailedAmbiguous(reason, error, excludedPending = null) {
    if (
      this.state === 'ContainmentFailed'
      || this.state === 'FailedAmbiguous'
    ) return;
    this._advanceLifecycle();
    this.state = 'FailedAmbiguous';
    this.inFlight = false;
    try {
      await this._checkpoint('failed-ambiguous-entered', {
        reason,
        errorCode: error?.code ?? null,
        turnId: this.activeTurnId
          ?? this.current?.turnId
          ?? this.lastTurnId,
      });
    } catch (checkpointError) {
      this.containmentError = checkpointError;
    }
    this.emit('codex-lifecycle', this._lifecyclePayload(
      'failed-ambiguous',
      {
        reason,
        errorCode: error?.code ?? null,
      },
    ));
    await this._enterContainment(reason, error, excludedPending);
  }

  async _enterContainment(
    reason,
    error,
    excludedPending = null,
    fence = null,
  ) {
    this._closeSettingsAdmission();
    if (this.state === 'ContainmentFailed') return;
    this._clearBackgroundWatchdog();
    const ownedTurnId = this.activeTurnId
      ?? this.current?.turnId
      ?? this.lastTurnId;
    this._advanceLifecycle();
    this.state = 'ContainmentFailed';
    this.containmentReason = reason;
    this.containmentError = error;
    this.inFlight = false;
    try {
      await this._checkpoint('containment-entered', {
        reason,
        errorCode: error?.code ?? null,
        turnId: ownedTurnId ?? null,
      }, fence);
    } catch (checkpointError) {
      this.containmentError = checkpointError;
    }
    const containment = processError(
      `Codex generation containment failed: ${reason}`,
      'CODEX_CONTAINMENT_FAILED',
      { cause: error },
    );
    for (const pending of [...this.pendingQueue]) {
      if (pending !== excludedPending && !pending?.settled) {
        this._rejectPending(pending, containment);
      }
    }
    this.pendingQueue = excludedPending && this.pendingQueue.includes(excludedPending)
      ? [excludedPending]
      : [];
    if (this.current !== excludedPending) this.current = null;
    this.activeTurnId = null;
    this.admittingTurnSettings = null;
    this.activeTurnSettings = null;
    const payload = this._lifecyclePayload('containment-failed', {
      reason,
      errorCode: error?.code ?? null,
      turnId: ownedTurnId ?? null,
    });
    this.emit('containment-failed', payload);
    this.emit('codex-lifecycle', payload);
    this._scheduleContainedTransportClose();
  }

  _scheduleContainedTransportClose() {
    if (this.containmentClosePromise) return;
    setImmediate(() => {
      if (this.containmentClosePromise) return;
      this.containmentClosePromise = timeout(
        Promise.resolve().then(() => this.client?.close()),
        this.cleanupTimeoutMs,
        'Codex contained transport did not close in time',
        'CODEX_CONTAINMENT_CLOSE_TIMEOUT',
      ).catch((closeError) => {
        this.logger.error?.(
          `[${this.label}] Codex containment close: ${closeError.message}`,
        );
      });
    });
  }

  _durabilityFailure(error) {
    let current = error;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (current.code === 'CODEX_DURABILITY_FAILED') return current;
      current = current.cause;
    }
    return null;
  }

  _blockDurability(error, excludedPending = null) {
    this._clearBackgroundWatchdog();
    if (this.state !== 'DurabilityBlocked') this._advanceLifecycle();
    this.state = 'DurabilityBlocked';
    this.inFlight = false;
    const blocked = processError(
      'Codex durability is unavailable',
      'CODEX_DURABILITY_FAILED',
      { cause: error },
    );
    for (const pending of [...this.pendingQueue]) {
      if (pending !== excludedPending && !pending?.settled) {
        this._rejectPending(pending, blocked);
      }
    }
    this.pendingQueue = excludedPending && this.pendingQueue.includes(excludedPending)
      ? [excludedPending]
      : [];
    if (this.current !== excludedPending) this.current = null;
    this.admittingTurnSettings = null;
    this.activeTurnSettings = null;
    this.emit('codex-lifecycle', this._lifecyclePayload(
      'durability-blocked',
      { errorCode: error.code },
    ));
  }

  blockDurability(error) {
    if (this.state === 'ContainmentFailed') return true;
    this._blockDurability(error);
    return true;
  }

  _turnDetail(pending) {
    return {
      threadId: this.providerSessionId,
      turnId: pending.turnId,
      source: pending.context?.sourceMsgId ?? null,
      clientUserMessageId: pending.clientUserMessageId,
      attemptId: pending.attemptId,
    };
  }

  _lifecyclePayload(kind, detail = {}) {
    return {
      kind,
      generationId: this.generationId,
      threadId: this.providerSessionId,
      hostIdentity: this.hostIdentity,
      bootSessionIdentity: this.bootSessionIdentity,
      ...detail,
    };
  }

  _newWorkError() {
    if (this.closed || this.state === 'Closed') {
      return processError('Codex process is closed', 'CODEX_PROCESS_CLOSED');
    }
    if (this.state === 'ContainmentFailed') {
      return processError(
        'Codex generation is containment-failed',
        'CODEX_CONTAINMENT_FAILED',
      );
    }
    if (this.state === 'FailedAmbiguous') {
      return processError(
        'Codex generation has an ambiguous mutation outcome',
        'CODEX_RPC_OUTCOME_UNKNOWN',
      );
    }
    if (this.state === 'RecoveryConflict') {
      return processError(
        'Codex resumed thread is already active',
        'CODEX_RECOVERY_CONFLICT',
      );
    }
    if (this.state === 'Quiescing' || this.state === 'Stopped') {
      return processError(
        'Codex process is quiescing',
        'CODEX_PROCESS_QUIESCING',
      );
    }
    if (this.state === 'DurabilityBlocked') {
      return processError(
        'Codex durability is unavailable',
        'CODEX_DURABILITY_FAILED',
      );
    }
    if (this.state !== 'Idle' && this.state !== 'BackgroundWorking'
      && this.state !== 'BackgroundSettling'
      && this.state !== 'StartingTurn' && this.state !== 'Active'
      && this.state !== 'Settling') {
      return processError(
        'Codex process is not ready',
        'CODEX_PROCESS_NOT_READY',
      );
    }
    return null;
  }

  _steerUnavailableReason() {
    if (this.closed || this.state === 'Closed') return 'closed';
    if (this.state === 'ContainmentFailed') return 'containment-failed';
    if (this.state === 'FailedAmbiguous') return 'outcome-unknown';
    if (this.state === 'RecoveryConflict') return 'recovery-conflict';
    if (this.state === 'Quiescing' || this.state === 'Stopped') {
      return 'quiescing';
    }
    if (this.state === 'DurabilityBlocked') return 'durability-blocked';
    return null;
  }

  _settlePending(pending, action, value) {
    if (pending.settled) return false;
    pending.settled = true;
    if (action === 'resolve') pending.resolve(value);
    else pending.reject(value);
    return true;
  }

  _rejectPending(pending, error) {
    pending.turnReady.reject(error);
    pending.terminalDeferred.reject(error);
    this._settlePending(pending, 'reject', error);
  }

  _drainWaiting(code) {
    let count = 0;
    for (const pending of [...this.pendingQueue]) {
      if (pending === this.current) continue;
      this._reserveCancellation(pending, code);
      count += 1;
    }
    return count;
  }

  drainQueue(code = 'INTERRUPTED') {
    if (this.current) return this._drainWaiting(code);
    return this._drainAll(code);
  }

  _drainAll(code) {
    let count = 0;
    for (const pending of [...this.pendingQueue]) {
      this._reserveCancellation(pending, code);
      count += 1;
    }
    return count;
  }

  _reserveCancellation(pending, code) {
    const index = this.pendingQueue.indexOf(pending);
    if (index !== -1) this.pendingQueue.splice(index, 1);
    try {
      pending.cancelled = true;
      pending.cancellationCode = code;
    } catch {}
    if (!this.pendingCancellations.some(({ pending: owned }) => owned === pending)) {
      this.cancellationSequence += 1;
      this.pendingCancellations.push({
        pending,
        code,
        attemptId: pending?.attemptId
          ?? `${this.generationId}:cancel:${this.cancellationSequence}`,
      });
    }
  }

  async _flushPendingCancellations() {
    if (this.cancellationFlushPromise) return this.cancellationFlushPromise;
    this.cancellationFlushPromise = (async () => {
      while (this.pendingCancellations.length > 0) {
        const cancellation = this.pendingCancellations[0];
        const { pending } = cancellation;
        try {
          await this._checkpoint('queued-send-cancelled', {
            threadId: this.providerSessionId,
            turnId: pending.turnId ?? null,
            source: pending.context?.sourceMsgId ?? null,
            clientUserMessageId: pending.clientUserMessageId ?? null,
            attemptId: cancellation.attemptId,
            cancellationCode: cancellation.code,
          });
        } catch (error) {
          const durability = processError(
            'Codex queued cancellation was not durably recorded',
            'CODEX_DURABILITY_FAILED',
            { cause: error },
          );
          if (!cancellation.handlerSettled) {
            cancellation.handlerSettled = true;
            try {
              if (pending.turnReady) pending.turnReady.reject(durability);
              if (pending.terminalDeferred) {
                pending.terminalDeferred.reject(durability);
              }
              if (pending.settled === false) {
                this._settlePending(pending, 'reject', durability);
              } else if (typeof pending.reject === 'function') {
                pending.reject(durability);
              }
            } catch {}
          }
          this._blockDurability(error, this.current);
          throw durability;
        }
        this.pendingCancellations.shift();
        const error = processError(
          `drained:${cancellation.code}`,
          cancellation.code,
        );
        try {
          if (pending.turnReady) pending.turnReady.reject(error);
          if (pending.terminalDeferred) pending.terminalDeferred.reject(error);
          if (pending.settled === false) {
            this._settlePending(pending, 'reject', error);
          } else if (typeof pending.reject === 'function') {
            pending.reject(error);
          }
        } catch {}
        cancellation.handlerSettled = true;
      }
    })().finally(() => {
      this.cancellationFlushPromise = null;
    });
    return this.cancellationFlushPromise;
  }

  async selectModelSettings(settings) {
    const selected = this._validatedModelSettings(settings);
    return this._withSettingsGate(() => {
      let reason = null;
      if (this.settingsAdmissionClosed || [
        'Quiescing',
        'Stopped',
      ].includes(this.state)) {
        reason = 'quiescing';
      } else if ([
        'ContainmentFailed',
        'FailedAmbiguous',
        'DurabilityBlocked',
      ].includes(this.state)) {
        reason = 'containment';
      } else if (
        this.closed
        || this.state === 'Closed'
        || this.state === 'RecoveryConflict'
      ) {
        reason = 'stale-generation';
      }
      if (reason) {
        return {
          outcome: 'unavailable',
          reason,
          nextTurn: selected,
        };
      }
      this.desiredSettings = selected;
      return {
        outcome: 'updated-live',
        threadId: this.providerSessionId,
        generationId: this.generationId,
        currentTurn: this.activeTurnSettings ?? this.admittingTurnSettings,
        nextTurn: selected,
      };
    });
  }

  injectUserMessage() {
    return false;
  }

  steer() {
    return false;
  }

  fireUserMessage() {
    return false;
  }

  hasPendingDeliveryWork() {
    return Boolean(
      this.current
      || this.pendingQueue.length > 0
      || this.pendingCancellations.length > 0
      || this.cancellationFlushPromise
      || this.backgroundSettlementPromise
      || this.state === 'ContainmentFailed'
      || this.state === 'FailedAmbiguous'
      || this.state === 'DurabilityBlocked',
    );
  }

  hasActiveBackgroundWork() {
    return (
      this.state === 'BackgroundWorking'
      || this.state === 'BackgroundSettling'
    );
  }

  async getContextUsage() {
    throw new UnsupportedOperationError('getContextUsage', this.backend);
  }

  async resetSession() {
    throw new UnsupportedOperationError('resetSession', this.backend);
  }

  kill(reason = 'kill') {
    if (this.killPromise) return this.killPromise;
    this.killPromise = this._kill(reason);
    return this.killPromise;
  }

  async _kill(reason) {
    if (this.closed) return;
    this._closeSettingsAdmission();
    this._clearBackgroundWatchdog();
    const lifecycle = this._captureLifecycle();
    if (this.state === 'RecoveryConflict') {
      await this._enterContainment(
        'recovery-conflict-unresolved',
        processError(
          'Codex resumed thread ownership remained unresolved',
          'CODEX_RECOVERY_CONFLICT',
        ),
      );
    }
    if (this.state === 'ContainmentFailed') {
      this._scheduleContainedTransportClose();
      return;
    }
    if (this.state === 'DurabilityBlocked') {
      this._scheduleContainedTransportClose();
      return;
    }

    this._drainWaiting('KILLED');
    if (!this.current) this._drainAll('KILLED');
    await this._flushPendingCancellations();
    this._assertLifecycle(lifecycle);

    if (this.backgroundSettlementPromise) {
      await this.backgroundSettlementPromise;
      this._assertLifecycle(lifecycle);
    }
    if (
      this.current
      || this.state === 'BackgroundWorking'
      || this.state === 'Settling'
    ) {
      await this.interrupt();
      this._assertLifecycle(lifecycle);
    } else if (
      this.state !== 'Stopped'
      && this.state !== 'Idle'
    ) {
      await this.interrupt();
      this._assertLifecycle(lifecycle);
    }

    this.state = 'Closing';
    try {
      await this.client?.close();
    } catch (error) {
      await this._enterContainment('app-server-close-unverified', error);
    }
    if (
      this.state === 'ContainmentFailed'
      || this.state === 'DurabilityBlocked'
    ) {
      // The transport may be closed, but this object remains the ownership
      // fence until containment or durability recovery is proved.
      return;
    }
    this._assertLifecycle(lifecycle);
    this.closed = true;
    this.state = 'Closed';
    this._emitClose(0, reason);
  }

  _emitClose(code, reason = null) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close', code, {
      backend: this.backend,
      generationId: this.generationId,
      reason,
      containmentReason: this.containmentReason,
    });
  }
}

module.exports = {
  CodexProcess,
  CodexProcessError,
};
