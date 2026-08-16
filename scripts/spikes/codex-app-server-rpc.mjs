import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const RPC_TIMEOUT_MS = 20_000;
const MAX_SERVER_LINE_BYTES = 1024 * 1024;
const MAX_RETAINED_NOTIFICATIONS = 512;
const MAX_NOTIFICATION_TEXT_BYTES = 64 * 1024;
const SAFE_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*$/;
const STATE_CHANGING_REQUEST_METHODS = new Set([
  'command/exec',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/backgroundTerminals/clean',
  'thread/settings/update',
]);
const ALLOWED_REQUEST_METHODS = new Set([
  'initialize',
  'config/read',
  'configRequirements/read',
  'permissionProfile/list',
  'account/read',
  'model/list',
  'command/exec',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/clean',
]);
const ALLOWED_NOTIFICATION_METHODS = new Set(['initialized']);
const ALLOWED_SERVER_NOTIFICATION_METHODS = new Set([
  'error',
  'thread/started',
  'thread/status/changed',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/settings/updated',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'hook/started',
  'hook/completed',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'warning',
  'deprecationNotice',
  'configWarning',
  'remoteControl/status/changed',
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
]);
const RETAINED_SERVER_NOTIFICATION_METHODS = new Set([
  'error',
  'thread/settings/updated',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/commandExecution/outputDelta',
]);
const RECOGNIZED_RPC_MESSAGES = new Map([
  ['thread/resume', new Set(['thread not found'])],
  ['turn/steer', new Set(['no active turn to steer'])],
  ['turn/interrupt', new Set(['no active turn to interrupt'])],
]);

export function isCharacterizationRequestAllowed(
  method,
  characterizeExperimentalSettings = false,
) {
  return (
    ALLOWED_REQUEST_METHODS.has(method)
    || (
      characterizeExperimentalSettings
      && method === 'thread/settings/update'
    )
  );
}

function assertExactParameterKeys(method, params, required, optional = []) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${method} requires object parameters`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(`${method} received unexpected parameter: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(params, key)) {
      throw new Error(`${method} requires ${key}`);
    }
  }
}

function assertNoRequestOverrides(method, params) {
  const forbiddenByMethod = {
    'thread/start': ['sandbox', 'config', 'permissions', 'permissionProfile'],
    'thread/resume': ['sandbox', 'config', 'permissions', 'permissionProfile'],
    'turn/start': ['sandboxPolicy', 'permissions', 'permissionProfile'],
    'turn/steer': ['permissions', 'permissionProfile'],
    'command/exec': ['sandboxPolicy', 'env', 'permissions', 'permissionProfile'],
  };
  for (const key of forbiddenByMethod[method] ?? []) {
    if (Object.hasOwn(params ?? {}, key)) {
      throw new Error(`${method} must not send ${key}`);
    }
  }
  if (method === 'thread/backgroundTerminals/list') {
    assertExactParameterKeys(method, params, ['threadId'], ['cursor', 'limit']);
  }
  if (method === 'thread/backgroundTerminals/clean') {
    assertExactParameterKeys(method, params, ['threadId']);
  }
  if (method === 'thread/settings/update') {
    assertExactParameterKeys(method, params, ['threadId', 'model', 'effort']);
  }
  if (method === 'model/list') {
    assertExactParameterKeys(method, params, [], [
      'cursor',
      'includeHidden',
      'limit',
    ]);
  }
}

function boundedString(value, label, maxBytes = 512) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`app-server ${label} exceeded the size limit`);
  }
  return value;
}

function requiredBoundedString(value, label, maxBytes = 512) {
  const bounded = boundedString(value, label, maxBytes);
  if (bounded === undefined || bounded.length === 0) {
    throw new Error(`app-server ${label} is required`);
  }
  return bounded;
}

function projectSettingsProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('app-server thread settings omitted permission profile');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'extends'
    || keys[1] !== 'id'
    || !Object.hasOwn(value, 'extends')
  ) {
    throw new Error('app-server thread settings permission profile is malformed');
  }
  const profile = {
    id: requiredBoundedString(value.id, 'permission profile id'),
    extends: value.extends === null
      ? null
      : boundedString(value.extends, 'permission profile parent'),
  };
  if (profile.id !== 'polygram-session' || profile.extends !== null) {
    throw new Error('app-server thread settings permission profile drifted');
  }
  return profile;
}

function projectSettingsSandbox(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('app-server thread settings omitted sandbox policy');
  }
  if (
    !Array.isArray(value.writableRoots)
    || value.writableRoots.length > 64
    || typeof value.networkAccess !== 'boolean'
    || typeof value.excludeSlashTmp !== 'boolean'
    || typeof value.excludeTmpdirEnvVar !== 'boolean'
  ) {
    throw new Error('app-server thread settings sandbox policy is malformed');
  }
  const roots = value.writableRoots.map((root) => (
    boundedString(root, 'sandbox writable root', 4096)
  ));
  if (
    value.type !== 'workspaceWrite'
    || value.networkAccess !== false
    || value.excludeSlashTmp !== true
    || value.excludeTmpdirEnvVar !== true
    || roots.length !== 0
  ) {
    throw new Error('app-server thread settings sandbox policy drifted');
  }
  return {
    type: requiredBoundedString(value.type, 'sandbox type'),
    networkAccess: value.networkAccess,
    excludeSlashTmp: value.excludeSlashTmp,
    excludeTmpdirEnvVar: value.excludeTmpdirEnvVar,
    writableRootCount: roots.length,
    writableRootSha256: roots
      .map((root) => createHash('sha256').update(root).digest('hex'))
      .sort(),
  };
}

function projectNotification(message) {
  const source = message.params ?? {};
  const params = {};
  const threadId = boundedString(source.threadId, 'notification thread id');
  const turnId = boundedString(source.turnId, 'notification turn id');
  if (threadId !== undefined) params.threadId = threadId;
  if (turnId !== undefined) params.turnId = turnId;

  if (message.method === 'thread/settings/updated') {
    const settings = source.threadSettings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('app-server thread settings are malformed');
    }
    if (Object.hasOwn(settings, 'runtimeWorkspaceRoots')) {
      throw new Error(
        'app-server thread settings unexpectedly included runtime workspace roots',
      );
    }
    const model = boundedString(
      settings.model,
      'thread settings model',
    );
    const effort = boundedString(
      settings.effort,
      'thread settings effort',
    );
    const modelProvider = boundedString(
      settings.modelProvider,
      'thread settings model provider',
    );
    const approvalPolicy = boundedString(
      settings.approvalPolicy,
      'thread settings approval policy',
    );
    const approvalsReviewer = boundedString(
      settings.approvalsReviewer,
      'thread settings approvals reviewer',
    );
    if (
      modelProvider !== 'openai'
      || approvalPolicy !== 'never'
      || approvalsReviewer !== 'user'
    ) {
      throw new Error('app-server thread settings static policy drifted');
    }
    params.threadSettings = {
      model,
      effort,
      modelProvider,
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy: projectSettingsSandbox(settings.sandboxPolicy),
      activePermissionProfile: projectSettingsProfile(
        settings.activePermissionProfile,
      ),
    };
  }

  if (message.method === 'error') {
    if (typeof source.willRetry !== 'boolean') {
      throw new Error('app-server error notification omitted retry ownership');
    }
    params.willRetry = source.willRetry;
    params.error = { present: source.error != null };
  }

  if (
    message.method === 'turn/started'
    || message.method === 'turn/completed'
  ) {
    const turn = source.turn ?? {};
    params.turn = {
      id: boundedString(turn.id, 'turn id'),
      status: boundedString(turn.status, 'turn status'),
    };
    if (message.method === 'turn/completed') {
      params.turn.error = turn.error == null ? null : { present: true };
      params.turn.items = Array.isArray(turn.items)
        ? turn.items.map((item) => ({
            id: boundedString(item?.id, 'turn item id'),
            type: boundedString(item?.type, 'turn item type'),
          }))
        : [];
    }
  }

  if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = source.item ?? {};
    params.item = {
      id: boundedString(item.id, 'item id'),
      type: boundedString(item.type, 'item type'),
    };
    const clientId = boundedString(item.clientId, 'item client id');
    if (clientId !== undefined) params.item.clientId = clientId;
    if (item.type === 'commandExecution') {
      params.item.command = boundedString(
        item.command,
        'command metadata',
        4 * 1024,
      );
    }
    if (item.type === 'agentMessage') {
      params.item.text = boundedString(
        item.text,
        'agent message',
        MAX_NOTIFICATION_TEXT_BYTES,
      );
    }
  }

  return { method: message.method, params };
}

function mutationDeliveryError(pending) {
  const code = pending.writeAttempted
    ? 'CODEX_RPC_OUTCOME_UNKNOWN'
    : 'CODEX_RPC_NOT_SENT';
  const message = pending.writeAttempted
    ? `app-server ${pending.method} outcome is unknown after transport loss`
    : `app-server ${pending.method} was not sent`;
  const error = new Error(message);
  error.code = code;
  return error;
}

export class AppServerConnection {
  constructor(options, env) {
    const beforeRequestWrite = options.beforeRequestWrite ?? null;
    const onRetainedNotification = options.onRetainedNotification ?? null;
    const characterizeExperimentalSettings = (
      options.characterizeExperimentalSettings === true
    );
    const retainTurnStarted = options.retainTurnStarted === true;
    if (
      beforeRequestWrite !== null
      && typeof beforeRequestWrite !== 'function'
    ) {
      throw new Error('beforeRequestWrite must be a function');
    }
    if (
      onRetainedNotification !== null
      && typeof onRetainedNotification !== 'function'
    ) {
      throw new Error('onRetainedNotification must be a function');
    }
    const args = ['app-server', '--strict-config', '--stdio'];
    const command = options.launcher || options.binary;
    const commandArgs = options.launcher ? [options.binary, ...args] : args;
    this.child = spawn(command, commandArgs, {
      cwd: options.workspace,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
    this.unexpectedServerRequests = [];
    this.stderrSeen = false;
    this.protocolError = null;
    this.closed = false;
    this.closing = false;
    this.beforeRequestWrite = beforeRequestWrite;
    this.onRetainedNotification = onRetainedNotification;
    this.characterizeExperimentalSettings = characterizeExperimentalSettings;
    this.retainTurnStarted = retainTurnStarted;
    // Decoded per chunk rather than per line: a line-oriented reader applies
    // its size bound only once a newline arrives, so an undelimited payload
    // could grow the buffer without limit before any check ran.
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stdoutBuffer = '';
    this.outputClosed = new Promise((resolvePromise) => {
      this.child.stdout.once('end', () => {
        this.stdoutBuffer += this.stdoutDecoder.end();
        resolvePromise();
        if (!this.closing && !this.closed) {
          this.#failProtocol(new Error('app-server output closed'));
        }
      });
    });
    this.child.stdout.on('data', (chunk) => this.#onStdoutData(chunk));
    this.child.stderr.on('data', () => {
      this.stderrSeen = true;
    });
    this.child.stdin.on('error', (error) => {
      if (this.closing) this.#rejectDuringClose(error);
      else this.#failProtocol(error);
    });
    this.child.on('error', (error) => {
      if (this.closing) this.#rejectDuringClose(error);
      else this.#failProtocol(error);
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      const error = new Error(`app-server exited (${code ?? signal ?? 'unknown'})`);
      if (this.closing) this.#rejectDuringClose(error);
      else this.#failProtocol(error);
    });
  }

  #send(message, pending = null) {
    if (this.protocolError) throw this.protocolError;
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('app-server stdin is not writable');
    }
    const line = `${JSON.stringify(message)}\n`;
    if (pending) {
      this.beforeRequestWrite?.({ method: pending.method });
      pending.writeAttempted = true;
    }
    this.child.stdin.write(line);
  }

  #failProtocol(error) {
    const mutationFailure = this.#rejectAll(error);
    if (!this.protocolError) this.protocolError = mutationFailure ?? error;
    if (!this.closed) {
      this.child.stdin.end();
      this.#signalOwnedTree('SIGTERM');
    }
  }

  #rejectDuringClose(error) {
    const mutationFailure = this.#rejectAll(error);
    if (mutationFailure && !this.protocolError) {
      this.protocolError = mutationFailure;
    }
  }

  #signalOwnedTree(signal) {
    if (process.platform !== 'win32' && this.child.pid) {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch (error) {
        if (error.code === 'ESRCH') return;
      }
    }
    this.child.kill(signal);
  }

  #onStdoutData(chunk) {
    if (this.closed || this.protocolError) return;
    this.stdoutBuffer += typeof chunk === 'string'
      ? chunk
      : this.stdoutDecoder.write(chunk);
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.#handleLine(line);
      if (this.protocolError) return;
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_SERVER_LINE_BYTES) {
      this.stdoutBuffer = '';
      this.#failProtocol(
        new Error('app-server partial line exceeded the size limit'),
      );
    }
  }

  #handleLine(line) {
    if (Buffer.byteLength(line) > MAX_SERVER_LINE_BYTES) {
      this.#failProtocol(new Error('app-server line exceeded the size limit'));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#failProtocol(new Error('app-server emitted malformed JSON'));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#failProtocol(new Error('app-server emitted a malformed message'));
      return;
    }
    const hasId = Object.hasOwn(message, 'id');
    const hasMethod = Object.hasOwn(message, 'method');
    const hasError = Object.hasOwn(message, 'error');
    const hasResult = Object.hasOwn(message, 'result');
    if (
      hasMethod
      && (
        typeof message.method !== 'string'
        || !SAFE_METHOD_PATTERN.test(message.method)
      )
    ) {
      this.#failProtocol(new Error('app-server emitted a malformed method'));
      return;
    }
    if (hasId && hasMethod) {
      if (hasError || hasResult) {
        this.#failProtocol(new Error('app-server emitted an ambiguous server request'));
        return;
      }
      this.unexpectedServerRequests.push('denied');
      const error = new Error('app-server sent an unexpected server request');
      try {
        this.#send({
          id: message.id,
          error: { code: -32601, message: 'U1a checker denies unexpected server requests' },
        });
      } catch {
        // The protocol failure below remains the authoritative outcome.
      }
      this.#failProtocol(error);
      return;
    }
    if (hasId) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.#failProtocol(new Error('app-server returned an unexpected response id'));
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (hasError === hasResult) {
        const error = new Error(`app-server ${pending.method} returned a malformed response`);
        const requestError = this.#requestFailure(pending, error);
        pending.reject(requestError);
        if (
          requestError.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
          && !this.protocolError
        ) {
          this.protocolError = requestError;
        }
        this.#failProtocol(error);
      } else if (hasError) {
        const error = new Error(`app-server ${pending.method} failed`);
        if (
          Number.isSafeInteger(message.error?.code)
        ) {
          error.rpcCode = message.error.code;
        }
        const recognizedMessages = RECOGNIZED_RPC_MESSAGES.get(pending.method);
        if (
          recognizedMessages?.has(message.error?.message)
        ) {
          error.rpcMessage = message.error.message;
        }
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!hasMethod || hasError || hasResult) {
      this.#failProtocol(new Error('app-server emitted a malformed notification'));
      return;
    }
    if (!ALLOWED_SERVER_NOTIFICATION_METHODS.has(message.method)) {
      this.#failProtocol(new Error('app-server sent an unexpected server notification'));
      return;
    }
    if (
      !RETAINED_SERVER_NOTIFICATION_METHODS.has(message.method)
      && !(this.retainTurnStarted && message.method === 'turn/started')
    ) return;
    let projected;
    try {
      projected = projectNotification(message);
    } catch (error) {
      this.#failProtocol(error);
      return;
    }
    if (this.notifications.length >= MAX_RETAINED_NOTIFICATIONS) {
      this.#failProtocol(new Error('app-server notification limit exceeded'));
      return;
    }
    this.notifications.push(projected);
    this.onRetainedNotification?.(projected);
    for (const waiter of [...this.notificationWaiters]) {
      if (!waiter.predicate(projected)) continue;
      clearTimeout(waiter.timeout);
      this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
      waiter.resolve(projected);
    }
  }

  #requestFailure(pending, error) {
    return pending.mutating ? mutationDeliveryError(pending) : error;
  }

  #rejectAll(error) {
    let mutationFailure = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      const requestError = this.#requestFailure(pending, error);
      if (
        requestError.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
        && mutationFailure === null
      ) {
        mutationFailure = requestError;
      }
      pending.reject(requestError);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.notificationWaiters = [];
    return mutationFailure;
  }

  notify(method, params = {}) {
    if (!ALLOWED_NOTIFICATION_METHODS.has(method)) {
      throw new Error(`app-server notification method is not allowlisted: ${method}`);
    }
    this.#send({ method, params });
  }

  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (!isCharacterizationRequestAllowed(
      method,
      this.characterizeExperimentalSettings,
    )) {
      throw new Error(`app-server request method is not allowlisted: ${method}`);
    }
    assertNoRequestOverrides(method, params);
    if (this.protocolError) return Promise.reject(this.protocolError);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, reject) => {
      const pending = {
        method,
        mutating: STATE_CHANGING_REQUEST_METHODS.has(method),
        writeAttempted: false,
        resolve: resolvePromise,
        reject,
        timeout: null,
      };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const timeoutError = new Error(`app-server ${method} timed out`);
        const requestError = this.#requestFailure(pending, timeoutError);
        reject(requestError);
        if (requestError.code === 'CODEX_RPC_OUTCOME_UNKNOWN') {
          if (!this.protocolError) this.protocolError = requestError;
          this.#failProtocol(timeoutError);
        }
      }, timeoutMs);
      pending.timeout = timeout;
      this.pending.set(id, pending);
      const message = { id, method };
      if (params !== undefined) message.params = params;
      try {
        this.#send(message, pending);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        const requestError = this.#requestFailure(pending, error);
        reject(requestError);
        if (requestError.code === 'CODEX_RPC_OUTCOME_UNKNOWN') {
          if (!this.protocolError) this.protocolError = requestError;
          this.#failProtocol(error);
        }
      }
    });
  }

  waitForNotification(predicate, timeoutMs = 750) {
    if (this.protocolError) return Promise.reject(this.protocolError);
    const existing = this.notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timeout: setTimeout(() => {
          this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
          resolvePromise(null);
        }, timeoutMs),
      };
      this.notificationWaiters.push(waiter);
    });
  }

  assertProtocolHealthy() {
    if (this.protocolError) throw this.protocolError;
  }

  async close() {
    this.closing = true;
    if (!this.closed) {
      this.child.stdin.end();
      this.#signalOwnedTree('SIGTERM');
      await Promise.race([
        new Promise((resolvePromise) => this.child.once('exit', resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
      ]);
    }
    if (
      !this.closed
      && this.child.exitCode === null
      && this.child.signalCode === null
    ) {
      this.#signalOwnedTree('SIGKILL');
      await Promise.race([
        new Promise((resolvePromise) => this.child.once('exit', resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
      ]);
    }
    await Promise.race([
      this.outputClosed,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
    ]);
  }
}
