# @shumkov/orchestra

The transport-agnostic **agent session engine** for Claude Code and the native
Codex app-server. It spawns provider sessions, injects or steers messages,
observes turns, supervises lifecycle, and recovers independently of which chat
network the messages came from.

Extracted from [polygram](https://github.com/shumkov/polygram) after
[water](https://github.com/shumkov/water) proved the copy works end-to-end against a
real Claude. Shared by polygram (Telegram) and water (WhatsApp); each keeps its own
transport, persistence, gate, and delivery.

See [`docs/EXTRACTION.md`](docs/EXTRACTION.md) for the API and the extraction design.

## Use

```js
const {
  CodexAppServerClient,
  CodexProcess,
  ProcessManager,
  createProcessFactory,
  createTmuxRunner,
  claudeBin,
} = require('@shumkov/orchestra');
// inject your transport delivery (toolDispatcher), surface hint (displayHint),
// and file cap (maxOutboundFileBytes); the engine stays chat-network-agnostic.
```

## MCP servers on the CLI backend

The CLI backend runs `claude` with `--strict-mcp-config`, so a session sees only the
channels bridge plus the servers its chat config names. Put Claude's own `mcpServers`
shape on the chat or on a topic:

```json
{ "mcpServers": { "canva": { "type": "http", "url": "https://mcp.canva.com/mcp" } } }
```

- A topic's non-null `mcpServers` replaces the chat's set; `{}` drops it.
- Entries are validated strictly (known fields per type); a bad entry is skipped with a
  `cli-mcp-servers` event and a warning, and the session still starts. The bridge name is
  reserved.
- An OAuth server reuses an existing `claude mcp add` login only with the same name, type,
  exact URL and headers. Each configured server's `authenticate` /
  `complete_authentication` tools are denied: an operator logs in interactively.
- Changes apply when `claude` next starts (a new session, a reload, a respawn).
- Call `sweepStaleMcpConfigs({ sessionPrefix })` at boot to remove mcp-config files left by
  dead sessions; they hold secrets.

Design: [`docs/CLI_MCP_SERVERS_SPEC.md`](docs/CLI_MCP_SERVERS_SPEC.md).

## Licence

MIT.
