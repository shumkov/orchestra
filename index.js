// @shumkov/orchestra — transport-agnostic Claude Code and Codex sessions.
// Spawn, steer, supervise, observe turns, and recover.
// Extracted from polygram after water proved the copy (see docs/EXTRACTION.md).
//
// The engine is parameterized by the consumer (toolDispatcher, displayHint,
// maxOutboundFileBytes, claudeBin, tmuxRunner) so it knows nothing about the chat
// transport. Consumers keep their own transport / persistence / gate / delivery.

'use strict';

const { Process, UnsupportedOperationError } = require('./lib/process/process');
const { ProcessManager, CALLBACK_TO_EVENT } = require('./lib/process/process-manager');
const { CliProcess } = require('./lib/process/cli-process');
const { CodexProcess } = require('./lib/process/codex-process');
const {
  assertCodexSpawnProfile,
  CodexPreflightError,
  createCodexSpawnProfile,
  preflightCodexRuntime,
  reattestCodexStaticPolicy,
} = require('./lib/codex/preflight');
const {
  attestPinnedCodexHome,
  buildCodexAppServerEnv,
  CodexAppServerClient,
  CodexAppServerError,
  protocolSchema: codexProtocolSchema,
} = require('./lib/codex/app-server-client');
const sdkProcess = require('./lib/process/sdk-process');
const { SdkProcess, extractAssistantText, sumUsage, makeInputController } = sdkProcess;
const { createProcessFactory, pickBackend } = require('./lib/process/factory');
const { ChannelsBridgeServer } = require('./lib/process/channels-bridge-server');
const bridgeProtocol = require('./lib/process/channels-bridge-protocol');
const hookSettings = require('./lib/process/hook-settings');
const hookEventTail = require('./lib/process/hook-event-tail');
const startupGate = require('./lib/tmux/startup-gate');
const attachmentBase = require('./lib/process/attachment-base');

const { createTmuxRunner } = require('./lib/tmux/tmux-runner');
const orphanSweep = require('./lib/tmux/orphan-sweep');
const logTail = require('./lib/tmux/log-tail');
const pollScheduler = require('./lib/tmux/poll-scheduler');

const claudeBin = require('./lib/claude-bin');
const processGuard = require('./lib/process-guard');
const { createAsyncLock } = require('./lib/async-lock');
const contextUsage = require('./lib/context-usage');
const compactionWarn = require('./lib/compaction-warn');
const canonicalJson = require('./lib/canonical-json');
const questionsStore = require('./lib/questions/store');
const approvalsStore = require('./lib/approvals/store');

module.exports = {
  // pool + driver
  Process, UnsupportedOperationError, ProcessManager, CALLBACK_TO_EVENT, CliProcess, CodexProcess, CodexAppServerClient, CodexAppServerError, CodexPreflightError, SdkProcess, extractAssistantText, sumUsage, makeInputController, createProcessFactory, pickBackend, preflightCodexRuntime, reattestCodexStaticPolicy, createCodexSpawnProfile, assertCodexSpawnProfile, attestPinnedCodexHome, buildCodexAppServerEnv, codexProtocolSchema,
  // channels bridge (MCP injection protocol)
  ChannelsBridgeServer, bridgeProtocol,
  // tmux lifecycle
  createTmuxRunner, orphanSweep, pollScheduler, logTail, startupGate,
  // claude binary pin+vendor
  claudeBin,
  // observability
  hookSettings, hookEventTail,
  // process safety
  processGuard, createAsyncLock,
  // claude context management
  contextUsage, compactionWarn,
  // ask / approval lifecycle stores
  questionsStore, approvalsStore, canonicalJson,
  // attachment staging-dir validation
  attachmentBase,
};
