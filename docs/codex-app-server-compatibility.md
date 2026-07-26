# Codex app-server 0.145.0 compatibility gate

Date: 2026-07-26

Scope: U1a only

Result: **STOP**

This report characterizes the pinned Codex app-server surface before any
Orchestra backend code is written. It deliberately stops at the first
architecture-blocking result. No Claude behavior, production configuration,
service, credential, or hosted session was changed.

## Baseline

- Orchestra branch baseline: tag `v0.5.0`, peeled commit
  `b788efb1f99e5fbf8669d4efa7ce5a1f9c0f7dcb`.
- Polygram declares `@shumkov/orchestra` `0.5.0`.
- Pinned executable:
  `/Users/ivanshumkov/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex`.
- Reported version: `codex-cli 0.145.0`.
- SHA-256:
  `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590`.
- The versioned executable and inspected path components are owned by root or
  the service user and are not group/world writable. They remain owner
  writable, so “pinned” means version-addressed plus hash-verified, not
  tamper-proof against code already running as that user.
- `~/.local/bin/codex` is not an acceptable pin because it traverses the mutable
  `standalone/current` symlink.

## Verified facts

The installed binary generated both stable and experimental JSON Schemas under
an empty dedicated `CODEX_HOME`, matching the intended isolated profile. Their
hashes and the narrow protocol observations are stored under
`tests/fixtures/codex-app-server-0.145.0/`.
The combined v2 bundle hashes canonicalize object-key order because the
generator emits definition keys nondeterministically; the semantic content is
stable across repeated runs.

1. `turn/steer` requires `threadId`, `input`, and `expectedTurnId`.
2. The installed schema describes `expectedTurnId` as a required active-turn
   precondition that fails when it does not match the active turn. This
   resolves the plan's request-shape unknown.
3. The 0.145.0 stable and experimental `workspaceWrite` sandbox policies expose
   writable roots, temporary-directory, and network controls. They do **not**
   expose `readOnlyAccess` or an equivalent readable-root restriction.
4. Current official app-server documentation describes a newer
   `workspaceWrite.readOnlyAccess` surface. That documentation does not change
   the installed 0.145.0 contract; the generated pinned schema is authoritative
   for this integration.
5. No `ORCHESTRA_SESSION_LAUNCHER` is configured in the current macOS shell or
   launchd service environment. The existing Orchestra launcher seam belongs
   to `CliProcess`'s Claude/tmux spawn and is not generic app-server process
   ownership.

Official references:

- [Codex app-server protocol](https://developers.openai.com/codex/app-server)
- [Codex authentication](https://developers.openai.com/codex/auth)

## Gate matrix

| U1a check | Result | Evidence / disposition |
|---|---|---|
| Exact pin, version, hash, and mode chain | Pass | Offline checker and fixture manifest |
| Generated stable and experimental schema | Pass | All six recorded schema hashes reproduce |
| Active-turn targeting field | Pass | `expectedTurnId` is required |
| Definite stale/not-active runtime rejection | Not run | Blocked behind the earlier credential-isolation stop |
| Fresh thread, resume, turn, two steers | Not run | Blocked behind the earlier stop |
| Interrupt and descendant teardown | Not run | Blocked behind the earlier stop |
| Direct stdio/exit behavior | Partial | Schema-generation subprocess passes; interactive app-server not run |
| Contract-equivalent `exec "$@"` wrapper | Partial | Version and schema generation pass through argv wrapper; signals/descendants not claimed |
| Actual configured launcher | Not applicable locally | No launcher is configured; Linux systemd proof remains a rollout gate |
| Dedicated POSIX process group | Not run | Must be implemented and proved after the stop is resolved |
| Transport cuts | Not run | Post-`stdin.write` outcomes must be treated as ambiguous |
| Model and effort catalog | Not run | Authenticated hosted call intentionally avoided after the stop |
| Credential-store read denial | **Fail** | Pinned schema cannot express restricted read access |
| Representative read/edit/test/Git tasks | Not run | Unsafe to proceed with the required credential-isolation profile absent |

## Why this is a stop

The first-milestone design requires the app-server to authenticate from a
dedicated `CODEX_HOME` while model-initiated commands cannot read that
credential store or unrelated daemon secrets. In 0.145.0, `workspaceWrite`
limits writes but leaves the readable filesystem unrestricted by the protocol
surface. `approvalPolicy: "never"` does not protect ordinary file reads.

Running a hosted turn cannot make the missing control safe. At best it would
demonstrate the known exposure. U1a therefore stops before U1b or the U2
protocol client, as required by the reviewed plan.

## Required decision

Choose one before resuming:

1. **Repin and rerun U1a.** Select a Codex CLI version whose generated stable
   schema includes restricted read access, regenerate fixtures, and rerun the
   complete U1a runtime matrix. This is the narrower and recommended path.
2. **Approve OS/profile isolation.** Design a separate service identity or
   external sandbox in which the app-server can authenticate but spawned agent
   commands cannot read its credential store. This is materially more
   operational work and needs its own reviewed spec amendment.

After either choice, the remaining mandatory proof includes definite stale
rejection, two ordered steers, resume, interrupt, descendant teardown, direct
and real Linux launcher transparency, conservative transport-cut
classification, empty MCP/profile behavior, and representative repository
tasks. Until that proof passes, no Codex backend should be added to Orchestra
or enabled in Polygram.

## Reproduction

The checker performs no login or hosted request:

```sh
node scripts/spikes/codex-app-server-real.mjs \
  --binary /absolute/versioned/path/to/codex
```

The expected stop returns exit status 2 so it cannot be mistaken for
implementation readiness. Tests should assert that status while parsing the
JSON evidence. An optional absolute `--launcher` runs the same version and
schema checks through the argv-based launcher contract, but that narrow check
is not evidence of signal or descendant transparency.
