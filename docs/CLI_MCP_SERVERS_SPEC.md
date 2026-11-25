# CLI backend: configured MCP servers next to the bridge

Status: draft for review.

## Problem

The CLI backend (`lib/process/cli-process.js`, `_spawnTmuxClaude`) always starts
`claude` with `--strict-mcp-config` and one `--mcp-config` file that holds only the
channels bridge. Strict mode is required: it keeps the user's and project's MCP servers
out of bot sessions, and the bridge must be the only `channels` server. As a side
effect, there is no way to give a chat or a topic any other MCP server:

- MCP servers registered with `claude mcp add` (user, project or local scope), a repo's
  `.mcp.json` and plugin servers are all ignored under strict mode.
- An agent file's frontmatter `mcpServers` is ignored for a main-thread `--agent`
  (verified with Claude CLI 2.1.322, with and without strict mode).
- The consumer's agent-bundle `settings.json` `mcpServers` only reaches the SDK backend.

Concrete case: UMI's instagram role (Shumabit bot, marketing forum topic 1306) needs the
Canva MCP. The CLI already has Canva's OAuth stored. A contained test on the production
host proved the target behaviour: the pinned CLI with `--strict-mcp-config` and an
`--mcp-config` holding `{"canva":{"type":"http","url":"https://mcp.canva.com/mcp"}}`
connected Canva (source `dynamic`, 46 tools), and a read-only `search-designs` returned
real designs. The stored OAuth entry (`canva|<hash>` in `~/.claude/.credentials.json`)
was reused; no new entry was created and no login was needed.

## Chosen approach

`CliProcess` reads an `mcpServers` object from the resolved chat config, with the same
precedence it already uses for `agent`, `cwd` and `isolateUserConfig`: the topic's value
when the topic sets one, otherwise the chat's. It validates the entries and writes the
valid ones into the existing 0600 mcp-config file next to the bridge. The flags do not
change: still `--strict-mcp-config`, still one `--mcp-config <file>` as the last flag.

```jsonc
// consumer config (polygram: config.json → chats[<id>] or chats[<id>].topics[<thread>])
"mcpServers": {
  "canva": { "type": "http", "url": "https://mcp.canva.com/mcp" }
}
```

Written file:

```json
{ "mcpServers": {
    "polygram-bridge": { "command": "node", "args": ["…/channels-bridge.mjs"], "env": { … } },
    "canva": { "type": "http", "url": "https://mcp.canva.com/mcp" }
} }
```

### Precedence: topic replaces chat

A topic that sets `mcpServers` replaces the chat's whole set; it does not merge per
server name. Reasons:

- It matches every other topic-over-chat key in this backend (`agent`, `cwd`,
  `isolateUserConfig`) and polygram's SDK backend, where `composeSdkOptions` copies
  `topicConfig.mcpServers` over `chatConfig.mcpServers` as a whole value. One rule for
  both backends.
- It gives a topic a way to drop a chat-wide server (`"mcpServers": {}`), which per-name
  merging would need a special `null` value for.

Rejected: per-name merge (topic adds to chat). Not needed for the use case, differs from
the SDK backend, and needs extra removal semantics.

### Validation

Validation runs at spawn, in a small pure function (`lib/process/cli-mcp-servers.js`,
`resolveConfiguredMcpServers({ value, reservedName })` → `{ servers, skipped }`), so it can
be unit-tested without tmux.

- `mcpServers` absent or `null`: no extra servers (today's behaviour, byte-identical
  file).
- `mcpServers` not a plain object (array, string, number): ignore it entirely, one
  warning.
- Per entry:
  - The name must match `^[A-Za-z0-9_-]{1,64}$` (Claude's MCP server name rule; the
    name becomes the `mcp__<name>__` tool prefix).
  - The name must not equal `bridgeServerName`. The bridge entry is always written last
    over any configured entry, so a collision can never replace the bridge even if this
    check regressed.
  - The value must be a plain object with either `type: "http"` or `type: "sse"` and a
    string `url` that parses as an `https:` or `http:` URL, or a stdio server: optional
    `type: "stdio"`, a non-empty string `command`, optional string array `args`,
    optional object `env` of strings.
  - Unknown extra fields (`headers`, `oauth`, `timeout`) are passed through unchanged:
    Claude owns that schema, and orchestra only checks enough to keep a typo from
    reaching the CLI.
- An invalid entry is skipped, not fatal. The session still starts with the bridge and
  the remaining valid servers.

Rejected: failing the spawn on any invalid entry. One bad optional server would take the
whole topic offline; the bridge, which carries every reply, must not depend on it.

### Logging and secrets

Server definitions may carry secrets (`headers.Authorization`, `env` tokens).

- Values are written only to the existing mcp-config file (mode 0600, re-chmodded,
  removed on teardown with the socket). The file path is in argv; contents never are.
- One `cli-mcp-servers` event per spawn with names and types only:
  `{ servers: [{ name, type }], skipped: [{ name, reason }] }`. `reason` is a fixed code
  (`invalid-name`, `reserved-name`, `invalid-definition`, `not-an-object`), never the
  value. Nothing is emitted when no servers are configured.
- A skipped entry also logs one `logger.warn` line with the name and reason code.
- A test asserts that a secret placed in `headers` and `env` appears in neither the
  event, the warn line nor argv.

### When a change takes effect

MCP servers are fixed when `claude` starts. A configured change reaches a session on its
next spawn:

- `/new` (fresh conversation), `/reload` (same conversation, `--resume`), an idle
  eviction or a crash respawn all start a new `claude` with the current config.
- A warm process keeps its spawn-time servers. `mcpServers` is not added to the
  spawn-identity fields: a respawn with `--resume` and a different server set is a
  valid continuation (the conversation keeps working; tools just appear or disappear),
  so there is no reason to drop the stored session.
- Consumer note (polygram): the daemon reads `config.json` only at boot, so an edit to
  the file takes effect after a daemon restart; boot also sweeps orphaned tmux sessions,
  so every CLI session respawns with the new config on its next message.

### Failure modes

| Failure | Behaviour |
| --- | --- |
| Invalid entry | Skipped, warn + event; session starts with the rest. |
| Server unreachable, slow, or OAuth expired / needs login | Claude CLI marks that server failed or `needs-auth` and starts anyway; its tools are absent. The bridge is unaffected. The role's skill already tells the agent to say "Canva is not connected" when the tools are missing. Verified before release (see Verification). |
| Slow HTTP server at startup | Claude connects MCP servers concurrently; the startup gate waits only for the bridge's ready signal. Verified with an unreachable URL before release. |
| Name collision with the bridge | Skipped as `reserved-name`; bridge written last regardless. |
| Re-login needed | Out of scope for the bot: an operator runs `claude mcp` / `/mcp` interactively as the bot user. Bot sessions never start an OAuth flow (no browser). |

### Security

- Config is operator-owned (`config.json`, 0600, root/bot user). Members cannot set it;
  polygram's `/config` commands do not expose `mcpServers`.
- A server is scoped to the chat or topic that names it. In the UMI deployment it is
  set only on topic 1306 of the Shumabit bot; the UMI Assistant bot has its own chats and
  gets nothing.
- Strict mode stays on, so nothing else leaks in.

## Interface

- New module `lib/process/cli-mcp-servers.js`: `resolveConfiguredMcpServers({ value, reservedName })`.
- `CliProcess._spawnTmuxClaude`: resolve `topicConfig?.mcpServers !== undefined ?
  topicConfig.mcpServers : opts.chatConfig?.mcpServers`, call the resolver, build
  `{ mcpServers: { ...servers, [bridgeServerName]: bridge } }`, emit the event.
- No new constructor option, no argv change. `README.md` documents the config key.

## Tests (TDD, `tests/cli-mcp-servers.test.js` and `tests/cli-process.test.js`)

Resolver:
- absent/null → `{}`; non-object → `{}` + `not-an-object`.
- valid http, sse and stdio entries pass through, extra fields kept.
- bad name, reserved name, missing url/command, non-http(s) URL, non-string args → each
  skipped with its code, others kept.

Spawn (existing fake tmux runner pattern):
- No `mcpServers`: the written file equals today's (bridge only). Guards against a
  silent behaviour change for every other consumer and chat.
- Chat `mcpServers`: file holds bridge + canva; argv unchanged; `--mcp-config` still last.
- Topic `mcpServers` replaces chat's; topic `{}` yields bridge only.
- Configured entry named like the bridge: the bridge definition in the file is the real
  bridge, and the event lists it as skipped.
- Secrets in `headers`/`env` absent from argv, the event and logger output; file mode
  0600.

## Verification before release (on the production host, contained)

1. Pinned CLI in a private tmux socket and temp dir, with `--strict-mcp-config`,
   `--dangerously-load-development-channels` and an mcp-config holding a stub channel
   server plus canva: the TUI reaches its prompt, `/mcp` shows canva connected.
2. Same with an unreachable `https://127.0.0.1:9/mcp` server: the TUI still reaches its
   prompt within the normal startup time; the server is listed as failed.

After deploy: the instagram topic's fresh session lists `mcp__canva__*` tools and a
read-only `search-designs` succeeds; another Shumabit topic's session shows no canva
tools.

## Out of scope

- Per-name merging, `null` removal, agent-level MCP for the CLI backend.
- The tmux (non-channels) backend's `isolateUserConfig` path.
- Water: unaffected unless its config sets `mcpServers`.
