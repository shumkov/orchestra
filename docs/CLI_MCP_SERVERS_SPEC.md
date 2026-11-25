# CLI backend: configured MCP servers next to the bridge

Status: reviewed (two spec reviewers, 25 Nov 2026), review fixes folded in.

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
- A consumer's agent-bundle `settings.json` `mcpServers` only reaches the SDK backend.

Concrete case: UMI's instagram role (Shumabit bot, marketing forum topic 1306) needs the
Canva MCP. The CLI already has Canva's OAuth stored. A contained test on the production
host proved the target behaviour: the pinned CLI with `--strict-mcp-config` and an
`--mcp-config` holding `{"canva":{"type":"http","url":"https://mcp.canva.com/mcp"}}`
connected Canva (source `dynamic`, 46 tools), and a read-only `search-designs` returned
real designs, reusing the stored OAuth entry.

## Chosen approach

`CliProcess` reads an `mcpServers` object from the resolved chat config, with the same
topic-over-chat precedence it uses for `agent`, `cwd` and `isolateUserConfig`. It
validates the entries strictly and writes the valid ones into the existing 0600
mcp-config file next to the bridge. For every configured server it also denies that
server's OAuth tools. Otherwise the argv is unchanged: still `--strict-mcp-config`, still
one `--mcp-config <file>` as the last flag.

```jsonc
// consumer config (polygram: config.json → chats[<id>] or chats[<id>].topics[<thread>])
"mcpServers": {
  "canva": { "type": "http", "url": "https://mcp.canva.com/mcp" }
}
```

Written file (the bridge key is first in insertion order, so Claude starts it first, and
it is assigned again last, so a configured entry can never replace it):

```json
{ "mcpServers": {
    "polygram-bridge": { "command": "node", "args": ["…/channels-bridge.mjs"], "env": { … } },
    "canva": { "type": "http", "url": "https://mcp.canva.com/mcp" }
} }
```

Built as `{ [bridge]: def, ...servers, [bridge]: def }`.

### OAuth reuse rule

The CLI stores MCP OAuth under `mcpOAuth["<name>|<sha256(JSON{type,url,headers})>[0:16]"]`
in `~/.claude/.credentials.json`. A configured server reuses an existing login only if the
**name, type, exact URL (no added or dropped trailing slash) and headers** equal the
`claude mcp add` registration. Verified on the VPS: `canva` and a probe named
`canva-probe` with the same URL got the same hash suffix but separate entries; the probe
had no token. Anything else means a new, unauthenticated entry.

### Precedence: topic replaces chat

When a topic sets `mcpServers` (non-null), it replaces the chat's whole set; it does not
merge per server name. `null` or absent at topic level inherits the chat's. A topic's
`{}` drops the chat's servers. A legacy string topic config (a bare name) inherits the
chat's.

- Same rule as `agent`, `cwd` and `isolateUserConfig` in this backend.
- Rejected: per-name merge. Not needed for the use case, and it would need a removal
  marker.

### Validation (strict)

A small pure module `lib/process/cli-mcp-servers.js`,
`resolveConfiguredMcpServers({ value, reservedName })` → `{ servers, skipped }`, unit-tested
without tmux.

- `value` absent or `null`: no extra servers. The written file is byte-identical to
  today's.
- `value` not a plain object: no extra servers, one skip with reason `not-an-object`.
- Per entry, all must hold or the entry is skipped:
  - name matches `^[A-Za-z0-9_-]{1,64}$` (`invalid-name`) and is not the bridge name
    (`reserved-name`);
  - value is a plain object with only known fields for its type (`invalid-definition`
    otherwise):
    - `http` / `sse`: `type` (required), `url` (required, `https:` or `http:` URL),
      `headers` (object of strings), `oauth` (object), `timeout` (finite number > 0);
    - `stdio`: `type: "stdio"` (optional), `command` (non-empty string), `args` (array of
      strings), `env` (object of strings), `timeout` (finite number > 0).
- A skipped entry never stops the session: it starts with the bridge and the valid rest.

**Settled on the pinned CLI (2.1.322, VPS, 25 Nov 2026):** a file with one valid server
and three bad entries (`{"type":"http"}` without a url, `{"foo":1}`, a bare number)
started normally: the bad entries were dropped silently, Canva connected with all 46
tools. So the CLI does not reject the whole file over a bad entry, but it also gives no
signal. Orchestra validates before writing so a typo is visible in its event and logs,
and so a future CLI that is stricter cannot take the bridge down.

### Denying OAuth tools

When an HTTP server has no usable token, the interactive CLI (the CLI backend runs the
TUI) exposes `mcp__<name>__authenticate` and `mcp__<name>__complete_authentication`. Under
`bypassPermissions` a role could start an OAuth flow from a group chat. Verified on
2.1.322: a `canva-probe` server without a token showed both tools in the TUI (not in
`-p`).

For every configured server, `CliProcess` adds
`--disallowedTools mcp__<n>__authenticate,mcp__<n>__complete_authentication,…` (one
comma-joined argument, placed before `--settings`). Verified on 2.1.322 under
`--permission-mode bypassPermissions --dangerously-skip-permissions`: with the flag, both
tools are gone (ToolSearch finds nothing) and the probe left no credential entry. A
re-login is an operator action: Ivan runs `claude` → `/mcp` interactively as the bot user
in the working directory where the server is registered (`/home/shumabit/shumabit-claude`
for Canva).

### Logging and secrets

Server definitions may carry secrets (`headers.Authorization`, `env` tokens).

- Values are written only to the mcp-config file (mode 0600, re-chmodded, removed on
  teardown). The file path is in argv; contents never are.
- One `cli-mcp-servers` event per spawn through `_logEvent`, with names and types only:
  `{ servers: [{ name, type }], skipped: [{ name, reason }] }`. Not emitted when nothing
  is configured. `reason` is a fixed code, never a value.
- A skipped entry also logs one `logger.warn` line with the name and the code.
- Boot cleanup: `sweepStaleMcpConfigs({ sessionPrefix, dir })` removes
  `<prefix>-<hex32>-mcp.json` files whose `<prefix>-<hex32>.sock` is missing or refuses a
  connection (its daemon is gone). A file whose socket accepts belongs to a live session,
  possibly another bot's daemon under the same Linux user and prefix, and stays. The
  consumer calls it at boot next to the tmux orphan sweep. Today 11 such files sit in the
  VPS's `/tmp`, each holding a bridge socket secret.

### When a change takes effect

MCP servers are fixed when `claude` starts.

- `/new` (fresh conversation), `/reload` (same conversation, `--resume`), an idle eviction,
  a crash respawn or a daemon restart start a new `claude` with the current config.
- A warm process keeps its spawn-time servers. `mcpServers` is not a spawn-identity field:
  a respawn with `--resume` and a different server set continues the same conversation.
- The consumer decides when its config changes (polygram: at boot only; see its spec).

### Failure modes (measured on 2.1.322 where marked)

| Failure | Behaviour |
| --- | --- |
| Invalid entry | Skipped by Orchestra, warn + event; session starts with the rest. The CLI would also drop it silently (measured). |
| Server needs OAuth | Status `needs-auth`, no tools; its OAuth tools are denied (measured). The role says the tool is not connected. |
| Server unreachable (`https://10.255.255.1/mcp`, packets dropped) | TUI reached its prompt in about 1 s with the server still pending; it then showed as `failed` (measured). In `-p` mode the first turn waited for the 30 s MCP connect timeout (33.5 s vs 17 s), which does not apply to the TUI the CLI backend runs. |
| Name collision with the bridge | Skipped as `reserved-name`; bridge assigned last regardless. |

### Security and limits

- Config is operator-owned (`config.json`, 0600). polygram's `/config` does not expose
  `mcpServers`.
- A server is scoped to the chat or topic that names it. Isolation is config-only: all
  bots of a host may run as one Linux user and share `~/.claude/.credentials.json`.
- Strict mode stays on, so nothing else leaks in.
- Content a server returns (Canva designs, comments, assets) is data, not instructions;
  consumers say so in the skills that use it.
- No approval gate is added on any server's write tools. For Canva, Ivan granted the
  instagram role full use of UMI-owned Canva items (25 Nov 2026); per-design rules stay in
  the `umi-canva` skill.

## Interface

- New `lib/process/cli-mcp-servers.js`: `resolveConfiguredMcpServers`,
  `buildMcpConfig({ bridgeName, bridgeDef, servers })`, `authToolDenyList(servers)`,
  `sweepStaleMcpConfigs({ sessionPrefix, dir, logger })`.
- `index.js` exports `sweepStaleMcpConfigs` (next to `orphanSweep`).
- `CliProcess._spawnTmuxClaude`: topic resolution moves above the mcp-config write; the
  file is built with `buildMcpConfig`; `--disallowedTools` added when servers exist; the
  event is emitted.
- `README.md` documents the config key.

## Tests (TDD)

`tests/cli-mcp-servers.test.js`:
- absent/null → `{}`; non-object → `{}` + `not-an-object`;
- valid http (with headers, oauth, timeout), sse and stdio pass through;
- bad name, reserved name, missing url/command, `ftp:` URL, unknown field, non-string
  header, non-array args → each skipped with its code, others kept;
- `buildMcpConfig`: bridge first in key order, bridge definition wins over a same-named
  entry;
- deny list: two tools per server, comma-joined;
- sweep: removes a file with no socket and one whose socket refuses; keeps one whose socket
  accepts; ignores unrelated names.

`tests/cli-process.test.js` (existing fake tmux pattern):
- no `mcpServers`: the file holds only the bridge and argv has no `--disallowedTools`
  (guards every other consumer);
- chat `mcpServers`: file holds bridge + canva; `--disallowedTools` present;
  `--mcp-config` still last;
- topic replaces chat; topic `{}` → bridge only; topic without the key, topic `null` and a
  legacy string topic inherit the chat's;
- secrets in `headers`/`env` absent from argv, events and logger output; file mode 0600.

## Verification

Done before implementation (VPS, pinned 2.1.322, temp dirs, private tmux socket, artifacts
removed): the three measurements above (bad entries, needs-auth probe with and without
the deny flag, unreachable server timing).

After deploy (polygram rollout): the instagram topic's respawned session (a `/reload` or a
normal message, which resumes) lists `mcp__canva__*` and a read-only `search-designs`
works; the `cli-mcp-servers` events show canva only for topic 1306, none for `cmo`
(chat-level General) or other topics.

## Out of scope

- Per-name merging, agent-level MCP for the CLI backend.
- The tmux and Codex backends (the key does nothing there).
- Water: unaffected unless its config sets `mcpServers`.
