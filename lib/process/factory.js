// provenance: polygram@0.17.11 lib/process/factory.js (git 746bca6) — adapt: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Process factory — chooses + constructs the right Process subclass
 * per session, based on chat / topic / bot config.
 *
 * Backends (post-0.12):
 *   - 'sdk' → SdkProcess (long-lived SDK Query, per-token API billing)
 *   - 'cli' → CliProcess (claude TUI in tmux + Channels MCP bridge + hooks ndjson,
 *                          subscription billing; default production path)
 *
 * Config aliases (back-compat for existing chat configs):
 *   - 'channels' → 'cli' (0.11.0-channels driver folded into CliProcess)
 *   - 'tmux'     → 'cli' (0.10.0 tmux backend deleted in 0.12 Phase 4;
 *                          existing configs keep working via this alias)
 *
 * Backend selection precedence:
 *   topicConfig.pm > chatConfig.pm > config.bot.pm > 'sdk'
 *
 * Per-backend wiring requirements:
 *   cli — tmuxRunner + botName + toolDispatcher + claudeBin
 *
 * If a backend is configured but its wiring is missing, we log a loud
 * warning and fall back to SDK so the daemon stays up (R2-F7 — never
 * silent-fail config).
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §6.4
 * @see docs/0.11.0-channels-driver-plan.md
 * @see docs/0.12.0-cli-driver-plan.md
 */

'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');

// orchestra ships BOTH Claude-session backends. The SDK backend lives in
// ./sdk-process; @anthropic-ai/claude-agent-sdk is an OPTIONAL dependency that
// sdk-process lazy-requires only when a pm:'sdk' session actually starts — so
// requiring this factory (or the whole package) never loads the SDK, and cli-only
// consumers (water) can install with --omit=optional. A consumer may still inject a
// custom SdkProcess via createProcessFactory({ SdkProcess }); the default is ours.
const { SdkProcess: DefaultSdkProcess } = require('./sdk-process');
const { CliProcess } = require('./cli-process');
const { CodexProcess: DefaultCodexProcess } = require('./codex-process');
const {
  assertCodexSpawnProfile,
  reattestCodexStaticPolicy,
} = require('../codex/preflight');

const MAX_CODEX_ID_BYTES = 512;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const FORBIDDEN_CODEX_CONTEXT_FIELDS = new Set([
  'cwd',
  'model',
  'effort',
  'env',
  'sessionLauncher',
  'binary',
  'codexHome',
  'permissionProfileId',
  'approvalPolicy',
  'approvalsReviewer',
  'webSearch',
  'sandbox',
  'sandboxPolicy',
  'permissions',
  'config',
  'expectedStaticProfile',
]);

class CodexBackendNotConfiguredError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CodexBackendNotConfiguredError';
    this.code = 'CODEX_BACKEND_NOT_CONFIGURED';
  }
}

class RuntimeSelectionError extends Error {
  constructor(runtime) {
    const rendered = typeof runtime === 'string'
      ? runtime
      : `<${typeof runtime}>`;
    super(`Unknown agent runtime '${rendered}'`);
    this.name = 'RuntimeSelectionError';
    this.code = 'RUNTIME_UNKNOWN';
    this.runtime = rendered;
  }
}

function codexConfigurationError(message, options) {
  return new CodexBackendNotConfiguredError(
    `Codex backend is not configured: ${message}`,
    options,
  );
}

function isBoundedOpaqueId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_CODEX_ID_BYTES
    && !CONTROL_CHAR_RE.test(value)
  );
}

function isConstructor(value) {
  if (typeof value !== 'function') return false;
  try {
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function expectedStaticThreadPolicy(profile) {
  const config = profile.expectedConfig;
  const permissionProfiles = Array.isArray(config?.permissionProfiles)
    ? config.permissionProfiles
    : [];
  const selectedProfiles = permissionProfiles.filter(
    ({ id }) => id === profile.permissionProfileId,
  );
  if (
    config?.modelProvider !== 'openai'
    || config?.approvalPolicy !== 'never'
    || config?.approvalsReviewer !== 'user'
    || config?.defaultPermissions !== profile.permissionProfileId
    || selectedProfiles.length !== 1
    || selectedProfiles[0].networkEnabled !== false
  ) {
    throw codexConfigurationError(
      'resolved profile does not encode the required thread policy',
    );
  }
  return deepFreeze({
    modelProvider: 'openai',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      networkAccess: false,
      writableRootCount: 1,
      writableRootSha256: [
        createHash('sha256').update(profile.cwd).digest('hex'),
      ],
    },
    permissionProfile: {
      id: profile.permissionProfileId,
      extends: selectedProfiles[0].extends ?? null,
    },
  });
}

function resolveCodexProfile({
  resolver,
  sessionKey,
  ctx,
}) {
  if (typeof resolver !== 'function') {
    throw codexConfigurationError(
      'codexExpectedStaticProfile resolver is required',
    );
  }
  for (const key of FORBIDDEN_CODEX_CONTEXT_FIELDS) {
    if (Object.hasOwn(ctx ?? {}, key)) {
      throw codexConfigurationError(
        `raw Codex spawn context field '${key}' is forbidden`,
      );
    }
  }
  const resolverContext = Object.freeze({
    runtime: 'codex',
    spawnProfileId: ctx?.spawnProfileId,
  });
  let receipt;
  try {
    receipt = resolver(sessionKey, resolverContext);
  } catch (cause) {
    throw codexConfigurationError(
      'codexExpectedStaticProfile resolver failed',
      { cause },
    );
  }
  try {
    assertCodexSpawnProfile(receipt);
  } catch (cause) {
    throw codexConfigurationError(
      'codexExpectedStaticProfile must return a complete preflight receipt',
      { cause },
    );
  }
  if (
    !isBoundedOpaqueId(ctx?.spawnProfileId)
    || receipt.runtime !== 'codex'
    || receipt.spawnProfileId !== ctx.spawnProfileId
  ) {
    throw codexConfigurationError(
      'resolved Codex runtime/spawnProfileId does not match spawn context',
    );
  }
  const profile = receipt.expectedStaticProfile;
  if (
    typeof profile.cwd !== 'string'
    || profile.cwd.length === 0
    || profile.cwd.includes('\0')
    || !path.isAbsolute(profile.cwd)
    || path.normalize(profile.cwd) !== profile.cwd
  ) {
    throw codexConfigurationError(
      'resolved profile requires a normalized absolute cwd',
    );
  }
  for (const field of ['permissionProfileId', 'model', 'effort']) {
    if (!isBoundedOpaqueId(profile[field])) {
      throw codexConfigurationError(
        `resolved profile requires a bounded ${field}`,
      );
    }
  }
  return receipt;
}

function createCodexProcess({
  CodexProcess,
  sessionKey,
  ctx,
  receipt,
  clientFactory,
  checkpointSink,
  hostIdentity,
  bootSessionIdentity,
  logger,
  queueCap,
}) {
  const profile = receipt.expectedStaticProfile;
  const selectedSettings = ctx?.modelSettings;
  if (
    !selectedSettings
    || typeof selectedSettings !== 'object'
    || Array.isArray(selectedSettings)
    || JSON.stringify(Object.keys(selectedSettings).sort())
      !== JSON.stringify(['effort', 'model'])
    || !isBoundedOpaqueId(selectedSettings.model)
    || !isBoundedOpaqueId(selectedSettings.effort)
  ) {
    throw codexConfigurationError(
      'Codex modelSettings requires a bounded model and effort',
    );
  }
  const matchingModels = receipt.modelCatalog.filter(
    (entry) => entry?.model === selectedSettings.model,
  );
  if (
    matchingModels.length !== 1
    || !matchingModels[0].supportedReasoningEfforts
      .includes(selectedSettings.effort)
  ) {
    throw codexConfigurationError(
      'Codex modelSettings must match the authenticated catalog',
    );
  }
  const staticThreadPolicy = expectedStaticThreadPolicy(profile);
  if (!isConstructor(CodexProcess)) {
    throw codexConfigurationError('CodexProcess constructor is required');
  }
  if (typeof clientFactory !== 'function') {
    throw codexConfigurationError('codexClientFactory is required');
  }
  if (typeof checkpointSink !== 'function') {
    throw codexConfigurationError(
      'acknowledged codexCheckpointSink is required',
    );
  }
  if (!isBoundedOpaqueId(hostIdentity)) {
    throw codexConfigurationError('bounded codexHostIdentity is required');
  }
  if (!isBoundedOpaqueId(bootSessionIdentity)) {
    throw codexConfigurationError(
      'bounded codexBootSessionIdentity is required',
    );
  }

  const existingSessionId = ctx?.existingSessionId;
  if (existingSessionId != null && !isBoundedOpaqueId(existingSessionId)) {
    throw codexConfigurationError(
      'existingSessionId must be a bounded opaque identifier',
    );
  }
  const spawnOptions = Object.freeze({
    ...(existingSessionId == null ? {} : { existingSessionId }),
    model: selectedSettings.model,
    effort: selectedSettings.effort,
  });
  const boundClientFactory = ({ onNotification, onFault }) => clientFactory(
    Object.freeze({
      sessionKey,
      expectedStaticProfile: profile,
      onNotification,
      onFault,
    }),
  );
  const proc = new CodexProcess({
    sessionKey,
    chatId: ctx?.chatId ?? null,
    threadId: ctx?.threadId ?? null,
    label: ctx?.label || sessionKey,
    cwd: profile.cwd,
    clientFactory: boundClientFactory,
    staticPolicyAttestor: (client) => (
      reattestCodexStaticPolicy(profile, client)
    ),
    checkpointSink,
    hostIdentity,
    bootSessionIdentity,
    expectedStaticPolicy: staticThreadPolicy,
    modelCatalog: receipt.modelCatalog,
    queueCap,
    logger,
  });
  proc.runtime = 'codex';
  proc.spawnProfileId = receipt.spawnProfileId;
  proc.spawnOptions = spawnOptions;
  return proc;
}

// Aliases — config values that map to a different canonical backend.
// Each alias emits ONE deprecation warn per-bot-process lifetime
// (tracked in `_warnedAliases` below). Avoids per-spawn log flooding
// on multi-chat deploys.
const ALIASES = new Map([
  ['channels', 'cli'],
  ['tmux',     'cli'],   // 0.12 Phase 4: tmux backend deleted; existing configs alias to cli
]);

const _warnedAliases = new Set();
function _maybeWarnAlias(alias, canonical, logger) {
  if (_warnedAliases.has(alias)) return;
  _warnedAliases.add(alias);
  logger.warn?.(
    `[factory] pm:'${alias}' is deprecated and now aliases to pm:'${canonical}'. ` +
    `Update chat config to silence this warning. ` +
    `See docs/0.12.0-cli-driver-plan.md §"Open questions resolved here" / Q5.`,
  );
}

// 0.12 Phase 4.5.3 (R12 mitigation): chats migrating from pm:'tmux' (the
// 0.10 backend with implicit pane-scrape approval gating) to pm:'cli'
// silently lose approvals unless the operator explicitly sets
// permissionMode. Warn ONCE per (botName, chatId, threadId) tuple so
// the migration trade-off is deliberate, not a surprise regression.
// Fires at pickBackend time (factory.js is the choke point for backend
// resolution).
const _warnedR12Chats = new Set();
function _maybeWarnR12Migration({ rawPm, canonical, chatId, threadId, chatCfg, topicCfg, logger }) {
  if (rawPm !== 'tmux' || canonical !== 'cli') return;
  // Resolved permissionMode honors the same precedence cli-process.js
  // uses: topic > chat > opt-default. Check both topic and chat config
  // here; we don't know opt-default (set inside CliProcess.start), but
  // its default is 'bypassPermissions' so absence = bypass.
  const explicitMode = topicCfg?.permissionMode || chatCfg?.permissionMode;
  if (explicitMode && explicitMode !== 'bypassPermissions') return;
  const key = `${chatId}:${threadId ?? ''}`;
  if (_warnedR12Chats.has(key)) return;
  _warnedR12Chats.add(key);
  logger.warn?.(
    `[factory] R12 migration warning: chat=${chatId}${threadId ? ` thread=${threadId}` : ''} ` +
    `was configured as pm:'tmux' and now aliases to pm:'cli'. The 0.10 tmux backend gated ` +
    `Bash/Edit/etc tool calls via pane-scrape approval cards; the 0.12 CliProcess defaults to ` +
    `permissionMode:'bypassPermissions' (no approvals). To preserve approval gating on this ` +
    `chat, set permissionMode: 'default' (or 'acceptEdits' / 'plan') in chat or topic config. ` +
    `See docs/0.12.0-cli-driver-plan.md §"Security posture" + R12.`,
  );
}

/**
 * @param {object} opts
 * @param {object} opts.config            — runtime config object
 * @param {Function} opts.spawnFn          — buildSdkOptions (SDK backend only)
 * @param {object} [opts.db]               — for SdkProcess._logEvent + clearSessionId
 * @param {object} [opts.logger]
 * @param {number} [opts.queueCap]
 * @param {number} [opts.queryCloseTimeoutMs]
 * @param {object} [opts.tmuxRunner]       — required when ANY chat routes to 'cli'
 * @param {string} [opts.botName]          — required when ANY chat routes to 'cli'
 * @param {Function} [opts.toolDispatcher] — required when ANY chat routes to 'cli'.
 *   async ({sessionKey, chatId, threadId, toolName, text, files}) => {ok, error?}.
 *   Called when Claude's reply (or react/edit_message) tool fires inside a
 *   CliProcess. Polygram supplies the actual Telegram-send wiring.
 * @param {string} [opts.channelsClaudeBin] — absolute path to pinned claude binary;
 *   required when ANY chat routes to 'cli'. (Name kept for back-compat with
 *   existing wiring; can be renamed to `claudeBin` in a future refactor.)
 * @param {string|null} [opts.sessionLauncher] — optional absolute executable
 *   wrapper that receives the pinned Claude binary as its first argument. Defaults to
 *   ORCHESTRA_SESSION_LAUNCHER when configured by the consumer.
 * @param {string|Function} [opts.displayHint] — surface-rendering hint prepended to
 *   the CliProcess system prompt. Accepts EITHER a static string (applied to every
 *   session) OR a resolver `(chatId, threadId, config) => string` invoked once per
 *   spawn, just before the CliProcess is constructed. The resolver receives the
 *   spawning chat/topic and the factory's config so the consumer can implement its
 *   own per-chat/topic precedence (e.g. a per-chat rich-text toggle) without the
 *   engine knowing anything about the consumer's config shape. The resolved string
 *   is what reaches CliProcess. Only the 'cli' backend uses this; the 'sdk' backend
 *   gets its per-chat hint via spawnFn instead.
 * @param {Function} [opts.codexClientFactory] — trusted Codex app-server client
 *   factory. Required only when spawnContext.runtime is exactly 'codex'.
 * @param {Function} [opts.codexCheckpointSink] — acknowledged durability sink.
 * @param {string} [opts.codexHostIdentity] — stable host identity.
 * @param {string} [opts.codexBootSessionIdentity] — stable host-boot identity.
 * @param {Function} [opts.codexExpectedStaticProfile] — trusted resolver
 *   `(sessionKey, identity) => receipt`, where `receipt` is the complete frozen
 *   value returned by `createCodexSpawnProfile`. Only runtime and spawn-profile
 *   identity reach the resolver; raw policy/launcher/environment context is rejected.
 * @returns {Function} processFactory(sessionKey, ctx) → Process
 */
function createProcessFactory({
  config,
  spawnFn,
  db = null,
  logger = console,
  queueCap,
  queryCloseTimeoutMs,
  tmuxRunner = null,
  botName = null,
  toolDispatcher = null,
  channelsClaudeBin = null,
  sessionLauncher = process.env.ORCHESTRA_SESSION_LAUNCHER || null,
  displayHint = '',                             // orchestra: consumer surface-rendering hint
  maxOutboundFileBytes = 100 * 1024 * 1024,     // orchestra: consumer outbound file cap
  // orchestra identity — forwarded to every CliProcess so the engine is neutral.
  sessionPrefix = 'orchestra',
  bridgeServerName = 'orchestra-bridge',
  appDataDir,
  attachmentBase,
  productName = 'orchestra',
  surfaceName = 'the chat',
  pmDefault = 'cli',                            // default backend when a chat has no pm
  SdkProcess = DefaultSdkProcess,               // orchestra ships this; consumer may override
  CodexProcess = DefaultCodexProcess,
  codexClientFactory = null,
  codexCheckpointSink = null,
  codexHostIdentity = null,
  codexBootSessionIdentity = null,
  codexExpectedStaticProfile = null,
} = {}) {
  // spawnFn (buildSdkOptions) is only used by the deferred SDK backend; water v1 is
  // cli-only, so it is optional here (a missing SDK wiring surfaces as the SdkProcess
  // constructor's clear "not available" error, not a factory-construction failure).

  return function processFactory(sessionKey, ctx) {
    const chatId = ctx?.chatId ?? null;
    const threadId = ctx?.threadId ?? null;
    const label = ctx?.label || sessionKey;

    if (
      ctx?.runtime != null
      && ctx.runtime !== 'claude'
      && ctx.runtime !== 'codex'
    ) {
      throw new RuntimeSelectionError(ctx.runtime);
    }
    if (ctx?.runtime === 'codex') {
      const receipt = resolveCodexProfile({
        resolver: codexExpectedStaticProfile,
        sessionKey,
        ctx,
      });
      return createCodexProcess({
        CodexProcess,
        sessionKey,
        ctx,
        receipt,
        clientFactory: codexClientFactory,
        checkpointSink: codexCheckpointSink,
        hostIdentity: codexHostIdentity,
        bootSessionIdentity: codexBootSessionIdentity,
        logger,
        queueCap,
      });
    }

    const choice = pickBackend({ config, chatId, threadId, logger, pmDefault });

    if (choice === 'cli') {
      const missing = [];
      if (!tmuxRunner) missing.push('tmuxRunner');
      if (!botName) missing.push('botName');
      if (typeof toolDispatcher !== 'function') missing.push('toolDispatcher');
      if (!channelsClaudeBin) missing.push('channelsClaudeBin');
      if (missing.length) {
        logger.warn?.(
          `[${label}] config requests pm:'cli' but ${missing.join(', ')} not wired; ` +
          `falling back to SdkProcess. Pass these to createProcessFactory.`,
        );
      } else {
        // displayHint may be a static string (same hint for every session) or a
        // resolver called per spawn with the current chat/topic and config, so the
        // consumer can vary the hint per chat (e.g. a per-chat rich-text toggle).
        // The string form is passed through unchanged.
        const resolvedDisplayHint = typeof displayHint === 'function'
          ? displayHint(chatId, threadId, config)
          : displayHint;
        return new CliProcess({
          sessionKey, chatId, threadId, label,
          tmuxRunner,
          botName,
          claudeBin: channelsClaudeBin,
          sessionLauncher,
          toolDispatcher,
          displayHint: resolvedDisplayHint,
          maxOutboundFileBytes,
          sessionPrefix, bridgeServerName, appDataDir, attachmentBase, productName, surfaceName,
          logger,
          db,                  // Parity P1: telemetry parity with sdk/tmux
        });
      }
    }

    return new SdkProcess({
      sessionKey, chatId, threadId, label,
      spawnFn,
      db,
      logger,
      queueCap,
      queryCloseTimeoutMs,
    });
  };
}

/**
 * Per-chat / per-topic backend choice.
 *
 * Honors topicConfig.pm / chatConfig.pm / config.bot.pm. Resolves aliases
 * (e.g., 'channels' → 'cli') and emits a once-per-process deprecation warn.
 *
 * Review AC3: unknown `pm` values (typos like `'channel'` singular) used to
 * silently fall through to 'sdk' with no warning — violates R2-F7 "never
 * silent-fail config". Now logs a warn and falls back to the default.
 */
const CANONICAL_BACKENDS = new Set(['sdk', 'cli']);

function pickBackend({ config, chatId, threadId, logger = console, pmDefault = 'cli' } = {}) {
  if (!chatId) return pmDefault;
  const chatCfg = config?.chats?.[chatId];
  const topicCfg = threadId && chatCfg?.topics?.[threadId];
  const raw = topicCfg?.pm || chatCfg?.pm || config?.bot?.pm || pmDefault;

  // Resolve alias (e.g., 'channels' → 'cli'). Warns once per process per
  // alias kind, NOT per spawn — multi-chat deploys shouldn't flood logs.
  let picked = raw;
  if (ALIASES.has(raw)) {
    picked = ALIASES.get(raw);
    _maybeWarnAlias(raw, picked, logger);
    // R12 — per-chat migration warning when pm:'tmux' aliases to 'cli'
    // without an explicit non-bypass permissionMode override.
    _maybeWarnR12Migration({
      rawPm: raw,
      canonical: picked,
      chatId, threadId,
      chatCfg, topicCfg,
      logger,
    });
  }

  if (!CANONICAL_BACKENDS.has(picked)) {
    logger.warn?.(
      `[factory] unknown pm value '${raw}' for chat=${chatId} thread=${threadId ?? ''}; ` +
      `falling back to 'sdk'. Valid: ${[...CANONICAL_BACKENDS].join(', ')} ` +
      `(aliases: ${[...ALIASES.keys()].join(', ')}).`,
    );
    return 'sdk';
  }
  return picked;
}

// _resetAliasWarnings — test-only helper. Resets the once-per-process warn
// tracking so unit tests can verify alias-warn + R12-migration-warn behavior
// across multiple pickBackend() invocations within a single test run.
function _resetAliasWarnings() {
  _warnedAliases.clear();
  _warnedR12Chats.clear();
}

module.exports = {
  createProcessFactory,
  pickBackend,
  _resetAliasWarnings,
  ALIASES,
  CANONICAL_BACKENDS,
  CodexBackendNotConfiguredError,
  RuntimeSelectionError,
};
