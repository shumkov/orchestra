# orchestra — extraction design

`@shumkov/orchestra` is the transport-agnostic **Claude-Code-CLI session engine**,
extracted from polygram after water proved the copied code works
(water `docs/SHARED-LIB.md`, proof `scripts/spikes/prove-session-engine.mjs`). Both
polygram (Telegram) and water (WhatsApp) depend on it; the transport / persistence /
gate layers stay in each consumer.

## What moves in (the engine)

From polygram@0.17.11 / water's proven copies:

- `process/process.js` — abstract Process base
- `process/process-manager.js` — weighted LRU pool, spawn/evict/pin, lazy respawn
- `process/cli-process.js` — the tmux'd claude CLI driver (**2 app-couplings removed**, below)
- `process/factory.js` — backend selection (cli; sdk is the consumer's escape hatch)
- `process/channels-bridge.mjs` / `channels-bridge-server.js` / `channels-bridge-protocol.js`
  — the MCP channels injection protocol
- `process/hook-settings.js` / `hook-event-tail.js` / `hook-append.js` — turn observability
- `process/attachment-base.js` — NEW: `DEFAULT_ATTACHMENT_BASE` + path validators (was in
  the consumer's tool-dispatcher; the staging-dir concept is engine-level)
- `tmux/*` — tmux lifecycle
- `claude-bin.js` — pin + vendor the claude binary
- `process-guard.js`, `async-lock.js`
- `context-usage.js`, `compaction-warn.js`, `canonical-json.js`
- `questions/store.js`, `approvals/store.js` — the ask/approval lifecycle stores

## Consumer-provided (injected) — the app boundary

The engine is parameterized by the consumer at construction, so it knows nothing about
Telegram or WhatsApp:

- `toolDispatcher(call) => {ok, error?, message_id?}` — delivers reply/edit/react on the
  consumer's transport (already injected in polygram/water today).
- `displayHint: string | (chatId, threadId, config) => string` — surface-rendering rules
  appended to the system prompt (**new option**, replacing cli-process's hard
  `require('../delivery/display-hint')`). A resolver is called once per spawn, so the hint
  can vary per chat/topic.
  **Contract for a hint that can change** (e.g. a per-chat rich-text toggle): the hint is
  spawn-time state, so a change reaches a warm session only by respawning it. The consumer
  must put the identical resolved string on the spawn context as `spawnContext.displayHint`.
  That string is what `getOrSpawn` compares against the warm proc to detect the change, and
  it is what the respawn is constructed with — the resolver is only the fallback for a
  context that carries no hint. Two independent sources is the failure mode to avoid: if a
  consumer's context string and its resolver disagree by one character, every message looks
  like drift and the session respawns forever.
- `maxOutboundFileBytes: number` — outbound file cap (**new option**, replacing
  `require('../attachments').resolveFileCaps`).
- `claudeBin`, `botName`, `tmuxRunner`, `logger`, `db` (telemetry) — as today.

## The 2 cli-process modifications (the only divergence from the verbatim copy)

1. `WATER_DISPLAY_HINT` import → constructor option `displayHint` (default `''`).
2. `resolveFileCaps()` import → constructor option `maxOutboundFileBytes`
   (default 100 MB).

Both are recorded in cli-process's provenance header as the extraction-time API design.
Everything else is byte-identical to the proven copy.

## Public API (`index.js`)

```js
const {
  ProcessManager, CliProcess, createProcessFactory,   // the pool + driver
  createTmuxRunner, orphanSweep,                        // tmux lifecycle
  claudeBin,                                            // { ensureVendoredClaudeBin, ... }
  ChannelsBridgeServer, bridgeProtocol,                 // the channels bridge
  hookSettings, hookEventTail,                          // observability
  DEFAULT_ATTACHMENT_BASE, validateAttachmentPath,      // staging-dir validation
} = require('@shumkov/orchestra');
```

## Consumer wiring after extraction

water/polygram replace their copied `lib/process/*`, `lib/tmux/*`, `lib/claude-bin.js`,
`lib/process-guard.js`, `lib/async-lock.js`, `lib/context-usage.js`,
`lib/compaction-warn.js`, `lib/canonical-json.js`, `lib/questions/store.js`,
`lib/approvals/store.js` with `require('@shumkov/orchestra')`, and pass `displayHint` +
`maxOutboundFileBytes` into the factory/CliProcess. Their transport, gate, dispatcher,
delivery, and ops layers are unchanged.

## Rollout

1. **water first** (this repo → depend on orchestra), re-run unit tests + the
   real-claude E2E to prove parity. water is not yet in production, so this is low-risk.
2. **polygram** is a **production revenue system** — its migration to orchestra gets its
   OWN spec + review + Ivan's merge (SHARED-LIB.md). Not done implicitly here.

## Provenance

Files retain their `// provenance: polygram@0.17.11 <path> (git 746bca6)` headers; the
extraction only relocates them and applies the 2 documented cli-process options. Keep
orchestra diff-clean against the pinned polygram so upstream fixes are cheap to pull.
