# @shumkov/orchestra

The transport-agnostic **Claude Code CLI session engine**: spawn interactive `claude`
sessions, inject messages via the MCP channels bridge, observe turns, and recover —
independent of which chat network the messages came from.

Extracted from [polygram](https://github.com/shumkov/polygram) after
[water](https://github.com/shumkov/water) proved the copy works end-to-end against a
real Claude. Shared by polygram (Telegram) and water (WhatsApp); each keeps its own
transport, persistence, gate, and delivery.

See [`docs/EXTRACTION.md`](docs/EXTRACTION.md) for the API and the extraction design.

## Use

```js
const { createProcessFactory, createTmuxRunner, ProcessManager, claudeBin } = require('@shumkov/orchestra');
// inject your transport delivery (toolDispatcher), surface hint (displayHint),
// and file cap (maxOutboundFileBytes); the engine stays chat-network-agnostic.
```

## Licence

MIT.
