# Codex app-server 0.145.0 compatibility gate

Date: 2026-07-26

Scope: U1a core protocol, steering, healthy stop, isolation, accepted
native-beta containment contract, and U1b operational/security
characterization

Overall U1a result: **CONTINUE — every integrated U1a gate passed**

Overall U1b result: **CONTINUE — every implementation-blocking U1b gate
passed; rollout remains native/direct-only**

Named-profile result: **CONTINUE — authenticated direct-binary run passed**

Steering capability result: **CONTINUE — one complete ordered semantic
steering and definite stale-rejection trace passed**

Steering-smoke result: **CONTINUE — final integrated authenticated run passed**

Tracked-terminal stop result: **CONTINUE — interrupt plus clean passed**

Arbitrary-descendant containment result: **DEFERRED — accepted native-beta
limitation with daemon-wide same-host reboot quarantine**

The named-profile result replaces the earlier false-negative that treated the absence of
`WorkspaceWriteSandboxPolicy.readOnlyAccess` as dispositive. Codex 0.145.0 has
a separate beta named-permission-profile surface that can restrict command
reads without a legacy `workspaceWrite` request policy.

## Pinned baseline

- Orchestra baseline: `v0.5.0`, commit
  `b788efb1f99e5fbf8669d4efa7ce5a1f9c0f7dcb`.
- Codex: `codex-cli 0.145.0`.
- Reviewed native target receipts:
  - `aarch64-apple-darwin`:
    `codex-cli 0.145.0`,
    `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590`;
  - `x86_64-unknown-linux-musl`:
    `codex-cli 0.145.0`,
    `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14`.
- The deprecated scalar binary checksum remains macOS-arm64 provenance.
  Runtime checks resolve the current target receipt lazily.
- Target-specific raw hashes pin the four deterministic stable and experimental
  `ClientRequest.json` and legacy protocol files in
  `tests/fixtures/codex-app-server-0.145.0/manifest.json`.
- The nondeterministically serialized stable and experimental v2 bundles are
  enforced only through their shared recursively canonical hashes:
  `02d8bf6651cd504bff0335f566c011e51ba77c5cc0538cb64ca7ac57739a1597`
  and
  `1bc09dedc506075562d4d49b702ecab6d947dd5a8c2a9014a5cde592a0938efb`.
- `turn/steer` still requires `threadId`, `input`, and `expectedTurnId`.
- The authenticated direct-binary checker passed every named-profile evidence
  bit on 2026-07-26. This Mac has no configured session launcher, so the local
  beta is explicitly `launcherMode=direct`; wrapper-launcher behavior is not
  claimed.
- The same integrated run passed every steering evidence bit and left the
  exact owned config byte-for-byte unchanged.
- A later post-review run passed the pre-spawn, replacement, and pre-steering
  config attestations but the hosted model did not start the requested
  synthetic sleep command within 60 seconds. No steering request was sent in
  that run, so it is a setup-inconclusive trace rather than a contrary steering
  result.
- A separate authenticated stop trace proved the missing supported protocol:
  interrupt settles the turn, background-terminal clean is accepted, a fresh
  first-page poll becomes empty, and the observed synthetic PID exits.
- A hard app-server-loss trace separately proved that replacement resume cannot
  rediscover the old terminal and that the old command escapes the app-server
  process group and POSIX session. This is a per-session OS-containment gap,
  not evidence that `turn/interrupt` or tracked-terminal cleanup is absent.
- The final revised integrated authenticated checker passed named-profile,
  ordered steering, definite stale steering, tracked-terminal stop, and every
  same-user side-channel gate together and returned status 0.

## Named-profile checker contract

The checker requires externally provisioned deployment inputs:

```sh
node scripts/spikes/codex-app-server-real.mjs \
  --binary /absolute/versioned/path/to/codex \
  --codex-home /absolute/non-temporary/codex-home \
  --workspace /absolute/workspace \
  --tmpdir /absolute/private/child-tmpdir \
  --daemon-secret-root /absolute/private/child-tmpdir \
  --external-network-host 1.1.1.1 \
  --external-network-port 443
```

Environment fallbacks are `POLYGRAM_CODEX_BIN`, `ORCHESTRA_CODEX_HOME`,
`ORCHESTRA_CODEX_WORKSPACE`, `ORCHESTRA_CODEX_TMPDIR`,
`ORCHESTRA_SESSION_LAUNCHER`, and the path-delimited
`ORCHESTRA_CODEX_DAEMON_SECRET_ROOTS`. Linux also requires
`ORCHESTRA_CODEX_EXTERNAL_NETWORK_HOST` and
`ORCHESTRA_CODEX_EXTERNAL_NETWORK_PORT` when the corresponding flags are not
passed. The endpoint must be an operator-approved, globally routable numeric
IPv4 address and port that are reachable from the service environment; a
hostname or private, loopback, link-local, benchmark, or documentation address
is rejected. The checker requires the same endpoint to remain reachable from
the host immediately before and after the sandbox-denial probe.
Each synthetic daemon-secret root must contain an owner-only regular
`.orchestra-codex-u1a-deny-probe` sentinel with no symlink or hard-link alias.
On Linux, the child `TMPDIR` must be an existing canonical service-user-owned
directory with exact mode `0700`, separate from both the workspace and
`CODEX_HOME`. The same exact directory must also be supplied as a
`--daemon-secret-root`, so the filesystem enforcement probe proves that its
sentinel is unreadable from `command/exec`. Darwin does not require or validate
this additional child-temp input.

Before Linux app-server startup, the checker requires the reviewed profile to
run a bounded harmless command using the Codex 0.145.0 CLI surface:

```text
codex sandbox --permission-profile polygram-session -- /bin/true
```

The checker does not trace bubblewrap. The final bounded VPS operational gate
must separately prove that this exact invocation reaches `/usr/bin/bwrap`.

The checker never creates, copies, reads, hashes, or prints authentication
contents. `CODEX_HOME` must already exist, be canonical, non-temporary, owned
by the service user, and mode `0700`; its `config.toml` must be a real
owner-only file without hard-link aliases. When `auth.json` exists, it has the
same ownership, mode, regular-file, symlink, and hard-link requirements.
The exact config pins `cli_auth_credentials_store = "file"` so this validation
identity cannot silently reuse macOS Keychain credentials. Authentication must
be provisioned separately with the pinned CLI under that service identity.
Interactive `codex login` and app-server thread startup may append a
`[projects.<cwd>] trust_level = "trusted"` stanza to `config.toml`. The
reviewed config instead pins the exact validation workspace to
`trust_level = "untrusted"` so project-local config cannot become an
additional policy source. This setting survived the authenticated fresh,
resume, and steering runs byte-for-byte. The checker hashes the config before
any app-server starts, checks it before and after each connection attestation,
re-attests layers and requirements before fresh, resume, and steering thread
operations, and requires the same hash after every connection closes.

App-server starts as:

```text
codex app-server --strict-config --stdio
```

Schema generation is a separate offline subcommand and must omit
`--strict-config`, which Codex 0.145.0 rejects for
`app-server generate-json-schema`. The compatibility bundle is generated
exactly as:

```text
codex app-server generate-json-schema --experimental --out <dir>
```

The generated bundle must contain `thread/settings/update`,
`thread/backgroundTerminals/list`, and
`thread/backgroundTerminals/clean`. Only the two terminal methods are in the
production request allowlist; the experimental settings mutation remains
characterization-only.

No `-c`, profile flag, legacy sandbox flag, or per-request permission selector
is sent. Initialization sets `capabilities.experimentalApi = true` because the
pinned stop protocol requires `thread/backgroundTerminals/list` and `clean`.
The checker does not allowlist per-terminal `terminate` or any other
experimental client method. Separate positive allowlists cover outbound
methods and inbound requests/notifications; malformed envelopes, response-ID
mismatches, and unexpected traffic latch a terminal protocol failure. Server
requests receive a method-not-found denial before termination. Terminal
command, cwd, handle, and OS metadata remain ephemeral and never enter errors
or the compatibility output. The authenticated run also pinned the benign
startup/lifecycle notifications that occur in this configuration:
remote-control status, MCP startup status, account rate-limit status, and
thread-goal updates/clears.

## Exact profile and attestation

The sole non-empty user layer must materialize:

- `cli_auth_credentials_store = "file"`;
- `default_permissions = "polygram-session"`;
- `approval_policy = "never"` and `approvals_reviewer = "user"`;
- `web_search = "disabled"` and `allow_login_shell = false`;
- command environment inheritance `none`, with controlled `HOME`, `TMPDIR`,
  and `PATH`;
- `:minimal = "read"`, workspace-root `.` write access, absolute denies for
  `CODEX_HOME` and every daemon-secret root, and profile network disabled;
- the exact validation workspace set to `trust_level = "untrusted"`;
- no active legacy sandbox, MCP, app, tool, skill, hook, plugin, selected
  config profile, or marketplace capability.

`config/read` must include layers and origins. The checker records only the raw
owned-config SHA-256, canonical SHA-256 of the actual effective config, opaque
layer version, and layer types. It does not print config or credential contents. Non-empty
project/session/managed layers and source-origin drift fail closed.
`configRequirements/read` must allow the profile, `never`, and disabled web
search when requirements exist. `permissionProfile/list` is paginated and only
proves that the exact ID is selectable; it cannot substitute for attestation.

## Real enforcement performed by this subgate

Using stable `command/exec` without `env`, `sandboxPolicy`, or a profile
selector, content-free probes created under an atomically unique mode-`0700`
workspace directory must prove:

- a synthetic workspace file can be opened and a synthetic marker created;
- `CODEX_HOME/config.toml` and `auth.json` cannot be opened;
- the known sentinel inside every configured synthetic daemon-secret root
  cannot be opened;
- the exact controlled netcat invocation can reach a loopback TCP canary
  outside the command sandbox, then returns the pinned denied-connection status
  inside it;
- no unexpected server request is emitted.

Only booleans, hashes, and probe exit-status codes are reported. Command stdout
and credential/account fields are not retained.

`account/read` uses `refreshToken: false` and records only whether the account
type is `chatgpt`.

Every production `turn/start` carries the complete catalog-validated
`model`/`effort` pair selected for that admission. Changing the local
selection preserves the process generation and provider thread, leaves an
active turn and its steering on their admitted pair, and applies to the next
turn.

The pinned `ThreadStartResponse` and `ThreadResumeResponse` schemas require
`model` but permit `reasoningEffort` to be omitted or `null`. Orchestra
validates attachment model and any present effort as non-empty strings of at
most 512 UTF-8 bytes. Missing effort remains unknown: it is not replaced with
the local selection or a catalog default. `thread/settings/updated` remains
stricter and must contain a complete model/effort pair.

Complete observed, admitting, active, and last-accepted turn settings take
precedence over partial attachment evidence. A model-only attachment may
authorize the first complete observation only by exact model, only before the
first turn admission, and only while no complete candidate exists. First turn
admission retires that partial authority permanently; the last accepted
complete pair remains authoritative after the turn finishes. All settings
notifications still require the full static permission, workspace, approval,
and provider policy to remain exact.

Codex does not persist a resumable rollout for `thread/start` alone. The
checker therefore completes one fixed no-tools text turn, requires the matching
`turn/completed` with no tool-item type, and then starts a fresh app-server for
`thread/resume`. This persistence prerequisite passed in the authenticated
direct-binary run; it does not clear the broader hosted-tool enforcement gate.

## Profile provenance

Two live pinned-runtime rollout runs found the exact profile at top-level
`activePermissionProfile` in both `thread/start` and `thread/resume`
responses. The value is fixture-pinned as `{id: "polygram-session",
extends: null}`. Both attachment responses also return exactly one concrete
`runtimeWorkspaceRoots` entry equal to the owned cwd. Orchestra exposes that
entry only as `{count: 1, sha256: [sha256(ownedCwd)]}`.

Neither rollout run emitted `thread/settings/updated` during fresh or resume
attachment within the bounded wait. An exact attachment response is therefore
sufficient profile provenance. If an attachment-time notification does appear,
the checker still requires its complete static settings view to be exact.
Notifications caused by explicit experimental `thread/settings/update` calls
are characterized separately and do not establish attachment-time emission.

The named-profile gate reports raw attachment-schema evidence separately from
live production attachment validation. Fresh and resume responses must pass
the same bounded parser used by `CodexProcess`; raw schema hashes or shape
checks alone cannot clear the gate. Output retains only validation booleans and
the effort presence class (`omitted`, `null`, or `present`), not model or effort
values.

Fresh and resume responses, and any observed `thread/settings/updated`, use the
same legacy compatibility envelope:

```json
{
  "type": "workspaceWrite",
  "networkAccess": false,
  "excludeSlashTmp": true,
  "excludeTmpdirEnvVar": true,
  "writableRootCount": 0,
  "writableRootSha256": []
}
```

The zero count means there are no additional legacy writable roots; the
concrete named-profile workspace grant is attested separately by
`runtimeWorkspaceRoots`. Settings notifications do not include
`runtimeWorkspaceRoots`, so Orchestra compares them against a distinct static
view while retaining the admitted attachment as the concrete-root proof. The
generated stable response schemas do not declare `activePermissionProfile`.

The named-profile subgate accepts this only as a pinned fresh-plus-resume pair
and reports:

- `provenanceSurface: "response-extension"`;
- `provenanceSchemaDeclared: false`;
- `provenanceFragile: true`.

A missing, different, duplicated, additional, outside-workspace, or one-sided
runtime root remains a stop. Any legacy network, temp-exclusion, type, or
additional-root drift also remains a stop. Every Codex pin change must
regenerate the schema and rerun this live characterization.

## Active-turn steering capability passed; smoke setup remains fragile

The authenticated checker starts a dedicated fresh thread, requires one exact
`/bin/sleep 8` command, and writes two `turn/steer` requests back-to-back
before awaiting either response. The pinned runtime:

- returned the active turn ID for both requests;
- emitted the two `userMessage` item-start notifications in request order with
  their distinct `clientUserMessageId` values;
- produced a schema-constrained final value containing both steered values in
  the same order;
- emitted no turn error or unexpected tool item; and
- rejected a steer sent only after the matching terminal notification with
  JSON-RPC `-32600` and exact message `no active turn to steer`.

This proves protocol intake, order, and semantic effect for the pinned
authenticated runtime. The exact stale message is not a documented stable
error type, so it remains a pin-fragile contract. `clientUserMessageId` is
correlation metadata only; no deduplication claim is made.

The scenario relies on the hosted model obeying an instruction to start the
synthetic sleep command so the turn remains active. That setup has both passed
and failed across bounded runs. A failed setup sends no `turn/steer` request
and therefore does not disprove the successful protocol trace, but this
model-dependent scenario is not a reliable rollout smoke. A future U1a
replacement needs a deterministic held-turn mechanism or must report setup
inconclusive separately from steering failure.

## Turn interruption and tracked-terminal cleanup passed

A bounded authenticated trace first completed an ordinary no-tools turn and
proved that a later `turn/interrupt` is rejected with JSON-RPC `-32600` and
exact message `no active turn to interrupt`.

A second turn then ran an exact synthetic command that wrote its PID to the
dedicated private fixture directory and `exec`'d a bounded 120-second sleep. After the command item had
started:

- `turn/interrupt` returned `{}`;
- that response arrived immediately before the matching `turn/completed`;
- the terminal turn status was `interrupted` with no turn error;
- the command PID was still alive;
- `thread/backgroundTerminals/list` reported the tracked terminal;
- `thread/backgroundTerminals/clean` accepted cleanup;
- a bounded poll from a null cursor observed an empty first page with no
  `nextCursor`; and
- the observed synthetic PID exited well before its natural deadline.

`turn/interrupt` and `turn/completed` therefore settle the model turn but not
the tracked terminal; `clean` is the required second operation. Post-clean
emptiness is checked by polling a fresh first page each time, not by advancing
to the end of a mutable paginated snapshot. A natural-completion race may
continue to cleanup only when the stale interrupt is reconciled to the exact
durably observed terminal.

This is a tracked-terminal characterization, not complete tree proof. Pinned
source drains the in-memory terminal registry before invoking non-confirming
termination, and app-server reports no usable OS PID. The observed synthetic
PID check proves that one process died; it does not prove that a command could not
daemonize another descendant first.

The checker never signals the marker PID: PID lookup followed by `kill` would
be vulnerable to reuse and argv spoofing. It retries the app-server clean path,
observes liveness only, and gives the synthetic sleep a bounded natural
expiry. Production containment must use an atomic per-session job identity
rather than copy this diagnostic PID observation.

## Same-user side-channel characterization passed in the integrated checker

A bounded direct app-server characterization used the exact pinned named
profile plus host-positive synthetic canaries. Outside the Codex command
sandbox, the service identity could:

- observe a unique same-user process argument and sample that process;
- retrieve one unique synthetic generic-password Keychain item;
- reach synthetic local TCP, UDP, DNS-protocol, and Unix-socket listeners; and
- read a deliberately inherited descriptor in a positive-control child.

The corresponding `command/exec` probes recovered none of those canaries.
Every process, listener, socket, descriptor, fixture, and Keychain item was
bounded and cleaned; only booleans and exit codes were reported.

The durable checker now executes the exact process, Keychain, TCP, UDP, DNS,
and Unix-socket probe commands for both host-positive control and sandboxed
denial, retains the descriptor-specific positive control, force-terminates its
owned process canary, verifies Keychain absence after cleanup, and attempts
all cleanup paths before failing. The final integrated authenticated run
passed every control and denial. The Unix-socket control uses a short,
explicitly length-guarded macOS pathname and an asynchronous host runner so
the control cannot false-fail while Node's listener is blocked.

On Linux x64, the same gate additionally requires host-positive and
sandbox-negative reads of the owned process's `/proc` command line,
environment, and inherited file descriptor, plus a bounded `strace` attach
probe. Local TCP, UDP, DNS-protocol, Unix-socket, and direct inherited-FD
checks remain mandatory. Only the macOS Keychain checks are explicitly
inapplicable on Linux; an unavailable Linux process, IPC, or network probe
stops the gate.

UDP and DNS listeners remain active until their command completes and for a
bounded settle interval afterward, so delayed packets cannot be classified as
denied early. An exact Linux `strace` ESRCH/`No such process` result counts as
PID-namespace denial only when host-side process liveness and attach controls
pass both before and after the sandbox attempt; helper failures remain
fail-closed. The direct inherited-FD probe intentionally checks the production
app-server spawn boundary, which receives only stdio pipes. The separate
`/proc/<pid>/fd` probe checks whether a sandboxed same-UID command can recover a
descriptor inherited by another owned process; no secret descriptor is
deliberately passed to app-server.

## Transport-cut classification is deterministic; persistence is unproved

The checker now tracks every currently allowlisted state-changing request
(`command/exec`, thread start/resume, turn start/steer/interrupt, and
background-terminal clean) as not-yet-written versus write-attempted.
Deterministic fake transports prove:

- a cut before start/steer write sends no request line and returns
  `CODEX_RPC_NOT_SENT`;
- a full request line read followed by response loss returns
  `CODEX_RPC_OUTCOME_UNKNOWN` for every classified state-changing method,
  faults the connection, and is never retried;
- a matching-ID malformed response, including a late valid response after it,
  retains the same unknown/faulted disposition; and
- a response timeout after write has the same unknown/faulted disposition.

Pinned schema checks confirm that start and steer accept
`clientUserMessageId`, and that resumed thread user-message items may expose it
as `clientId`. A bounded content-blind correlator treats zero resumed matches
as unknown, one exact match as observed, and duplicates or a steer match under
the wrong turn as conflicts. No uniqueness, idempotency, or deduplication claim
is made. A later authenticated proxy trace must still determine whether this
correlation survives real reconnect/resume; absence can never prove a request
was unsent.

## Hard app-server loss and daemon descendants remain uncontained

The app-server client starts the child below an owned POSIX supervisor that
remains the process-group leader through bounded TERM, group-membership
verification, explicit release, and KILL escalation. Fake and live effect
fixtures prove this removes ordinary descendants without signaling a reused
PGID. The real Codex PTY command created its own process group, escaped the
app-server POSIX session, was reparented, and remained alive after app-server
close. A replacement app-server resumed the thread but could neither list nor
clean the old terminal. The exposed `processId` was a random Codex-local
handle, not the OS PID.

Any later strong “no descendant survives `/stop` or app-server loss” contract
still needs one separately designed and proved boundary:

- a per-session cgroup/container/job that owns reparented descendants;
- a per-session ephemeral identity plus a trusted supervisor able to
  enumerate, kill, and reap exactly that job without PID-reuse or cross-chat
  risk;
- an upstream durable cleanup or externally usable OS-identity surface; or
- an explicitly approved weaker stop/crash contract with user-visible and
  security consequences.

A common service user is credential isolation, not per-session containment.
The proof must include a deliberately daemonizing/`setsid` fixture in both
normal cleanup and hard app-server-loss cases.

## macOS containment alternatives characterized

The following are verified local facts, not an architecture approval:

- This host is Apple Silicon macOS 26.5.1. The installed
  `launchd.plist(5)` contract kills only processes that retain the launchd
  job's process-group ID. That is not a stronger boundary than the process
  group already escaped by the real Codex PTY trace, so a per-chat launchd
  job does not close this gate.
- Docker Desktop 29.5.2 is installed and currently serves Linux/arm64
  containers. In a disposable Alpine container with no network, no host
  mounts, a read-only root, a bounded PID limit, and automatic removal, an
  in-container assertion first proved that a deliberately daemonizing
  `setsid` child existed. Stopping the exact container ID then removed the
  container.
- A second disposable fixture ran attached with stdin open, started the same
  kind of daemonized child, and blocked its PID 1 on stdin. Killing only the
  attached Docker client closed stdin; the container exited and was removed.
  This is evidence that an attached-stdio wrapper can fail closed on
  controller loss. It is not yet proof for the real Codex image or every
  Polygram/launchd crash mode.

One container per live Codex chat is therefore the only locally demonstrated
strong macOS direction. A production design would run app-server as PID 1 (or
under a minimal init), store and generation-bind the exact container ID before
the first turn, mount no Docker socket, use neither privileged nor host PID/
network modes, expose only explicitly reviewed workspace and Codex-state
mounts, and reconcile labeled containers before accepting work after boot.
`/stop` can use the verified app-server interrupt/clean protocol for graceful
settlement and then stop/delete the exact container to make descendant death
the kernel/runtime boundary rather than a PID enumeration claim. Transport or
app-server loss would take the same container-ID stop path.

That direction is **not yet approved or proved for U1a**. It changes the
runtime from native macOS tools to a Linux tool image and adds image
construction, pinned Linux Codex distribution, ChatGPT credential mounting,
workspace bind-mount semantics, egress policy, Docker availability, boot
reconciliation, resource cost, and actual app-server stdin-loss tests. The
generic fixtures retire only the question “can a macOS-hosted boundary reap a
daemonized process atomically?”; they do not retire those integration risks.

The remaining alternatives have materially different contracts:

- Native app-server can keep the already verified normal interrupt/clean
  behavior, but accepting possible daemon descendants after hard transport or
  app-server loss would explicitly weaken R11/AE8. It must be a user-approved
  product-contract revision, with a visible persisted `ContainmentFailed`
  quarantine and no silent replacement.
- A dedicated macOS service identity could make all Codex workers one
  deliberate global kill domain, but it needs privileged account/process
  supervision, new credential provisioning, workspace ACLs, and cross-chat
  blast radius. It is not an atomic per-session boundary and is not the
  recommended first implementation.
- Apple's `container` tool uses a lightweight VM per Linux container on
  Apple-silicon macOS 26, but it is not installed on this host and its upstream
  project remains pre-1.0. It is a credible later alternative to Docker, not a
  validated U1a dependency.

## U1b model, effort, and replacement-resume passed

The authenticated catalog was paginated through the allowlisted `model/list`
surface. The local validation boundary now projects only model slugs, default
effort, and the ordered supported-effort strings; descriptions and provider
metadata are not retained. The service identity advertised seven visible
models. `gpt-5.6-sol` was present with default `low` and selected `xhigh`.

A real hosted trace under Node v24.4.0:

1. started a fresh thread with exact model `gpt-5.6-sol`;
2. sent exact model plus `xhigh` on the first turn;
3. observed the exact model/effort settings update and a completed no-tools
   turn;
4. closed that app-server and initialized a replacement;
5. resumed with no model, effort, provider, or config override;
6. observed exact resumed model plus `reasoningEffort = "xhigh"`; and
7. completed a later no-tools turn.

The same trace passed when invoked through `launchctl asuser 502` with an empty
ambient environment, the production Node binary, and the same dedicated
file-backed ChatGPT credential store. Fresh and resume readiness were 817 ms
and 787 ms in that run. This proves same-UID GUI-bootstrap authentication and
direct child pipes; it does not reproduce a launchd-managed job lifecycle or
claim a configured wrapper launcher.

The U1b trace established the original immutable-thread baseline. The current
product contract supersedes that restriction:

- validate both exact strings against the full paginated authenticated
  catalog;
- keep the selected pair local until turn admission;
- send the complete pair on every `turn/start`;
- preserve an active turn and its steering on their admitted pair; and
- apply a later selection to the next turn without replacing the provider
  thread.

The sanitized observation is
`tests/fixtures/codex-app-server-0.145.0/model-effort-observation.json`.

## G-MODEL-1 passed

`scripts/spikes/codex-app-server-model-settings.mjs` is the bounded
model-settings compatibility gate. Its raw app-server transport exposes
`thread/settings/update` only when that checker explicitly opts into
experimental characterization. The production client continues to reject the
method before writing bytes.

The gate covers:

1. a changed idle experimental update and its effective-settings
   notification;
2. a repeated no-op update and whether a notification is emitted;
3. an update while one exact bounded sleep turn is active, proving the
   original turn starts once and completes without interruption;
4. a product-path per-turn override, recording the ordering labels for
   `thread/settings/updated`, `turn/started`, and the `turn/start` response;
5. replacement app-server resume of the same thread and another completed
   turn; and
6. production allowlist exclusion.

Experimental response, notification, and sanitized error classes are
characterization evidence only. A rejected, unavailable, or drifted
`thread/settings/update` does not fail the product gate and cannot contaminate
its thread: idle/no-op characterization, active-turn characterization, and
the stable product proof use separate fresh app-server connections and
threads. The active lane must still prove that its original turn starts once
and completes without interruption when the experimental request returns a
definitive error. The stable gate depends on the separate product thread's
per-turn override completing, its notification/response ordering being
recorded as available, the same thread resuming with the selected pair, a
later turn completing, and production allowlist exclusion.

The process suite separately races local selection against held
`turn/start` admission and proves the admitted turn retains the old pair while
the next turn carries the new pair.

Run the real gate against the exact isolated service identity:

```sh
node scripts/spikes/codex-app-server-model-settings.mjs \
  --binary /absolute/versioned/codex \
  --codex-home /absolute/private/codex-home \
  --workspace /absolute/isolated/workspace \
  --daemon-secret-root /absolute/denied-root \
  --model gpt-5.6-sol \
  --effort xhigh
```

An alternate pair is selected deterministically from the authenticated
catalog. It can instead be pinned with matching `--alternate-model` and
`--alternate-effort` arguments.

The authenticated run against pinned Codex 0.145.0 passed. It selected
`gpt-5.6-sol/xhigh` as the baseline and the advertised
`gpt-5.6-sol/low` pair as the alternate. The product-path per-turn override
completed, emitted the expected settings observation, resumed the same thread
with the alternate pair, and completed a later turn. Experimental changed and
active updates returned empty success results with notifications; the
experimental no-op returned empty success without another notification. The
production client still rejected `thread/settings/update` before writing
bytes. The sanitized evidence is pinned in
`tests/fixtures/codex-app-server-0.145.0/model-settings-observation.json`.

## U1b retry ownership and effect windows passed

A disposable loopback Responses provider ran the real pinned app-server and
real command executor without hosted-provider nondeterminism. Its config used
the same named profile, no credentials, no inherited command environment,
disabled command network, `request_max_retries = 0`, and
`stream_max_retries = 1` for the retry lane.

The retry matrix proved:

- retryable success: one client `turn/start`, two provider attempts,
  `error(willRetry=true)`, then one matching `turn/completed(completed)`;
- retryable exhaustion: one client start, two provider attempts,
  `willRetry=true`, then `willRetry=false`, then one
  `turn/completed(failed)`; and
- HTTP 400: one client start, one provider attempt, no retry signal, then
  `willRetry=false` and one `turn/completed(failed)`.

A fourth scripted response emitted `response.created` and then withheld the
terminal while sending keepalives. The client observed its bounded timeout
after exactly one client start and one provider request, did not replay, then
interrupted the exact turn and observed `turn/completed(interrupted)`.

Codex core therefore owns provider retries. Polygram must never add a second
retry around an accepted turn. `willRetry=true` is intermediate; the exact
terminal remains authoritative for completion, and a bounded missing terminal
is a failure requiring reconciliation rather than replay.

The effect lane set provider retries to zero and ran six fresh turns: transport
loss and app-server loss after command item-start, after the fixture's exact
first output, and after the proxy received but withheld the exact terminal.
The marker helper used create-exclusive, fsync, a fixed output token, and
bounded self-expiry. Results were:

- both item-start cuts had no marker, yet remained `effect=unknown` and
  `replayAllowed=false`;
- all first-output cuts had the exact durable marker and resumed as
  `interrupted`;
- both terminal-generated-not-observed cuts had the marker and resumed as
  `completed`; and
- no prompt was resent in any scenario.

This proves that neither item-start nor marker absence is a no-effect
checkpoint. Resume status is useful reconciliation evidence but never replay
truth. A written state-changing request without a client-observed terminal
stays non-replayable even if resume later says `completed`, `interrupted`, or
omits it.

The sanitized observation is
`tests/fixtures/codex-app-server-0.145.0/retry-effect-observation.json`.

## U1b resource and capacity characterization passed

The actual local deployment has no `ORCHESTRA_SESSION_LAUNCHER`; direct binary
mode is the local beta contract. Resource sampling used the production service
user and Node v24.4.0 on arm64 macOS 26.5.1. Each idle child initialized and
loaded one ephemeral thread. The controlled lab-only 10/25 points
intentionally ran outside the product lease and used concurrent local
`command/exec` sleeps to measure process, sandbox, stdio, RSS, and descriptor
overhead without spending 35 hosted turns. They are not product-valid
concurrent generations.

Median aggregate idle root RSS was approximately:

- 114 MiB for one app-server;
- 1.09 GiB for ten; and
- 2.74 GiB for twenty-five.

Median tree descriptor counts were 31, 315, and 775. The 25-child active local
proxy peaked near 2.85 GiB summed tree RSS and 901 descriptors, with 25 command
descendants. Summed RSS is an upper bound because shared pages can be counted
more than once. These are short local-overhead observations, not hosted-turn
latency, token-dependent memory, rate-limit, or soak measurements.

The required single hosted-active point also passed: while one real
`gpt-5.6-sol` turn held an exact eight-second command, median root RSS was
about 120 MiB, tree RSS peaked near 123 MiB, median tree descriptors were 38,
and one command descendant was present. Nineteen warm same-child
`account/read` controls measured 2 ms p50 and 13 ms p95/max. The hosted point is
one characterization sample, not a service-latency percentile or SLA.

Per-chat app-server scaling is therefore too expensive for the native MVP even
before the containment contract is considered. The product limit remains one
live native Codex generation per Polygram daemon; dormant chat rows own no
app-server child. U4 must reject every same- or different-workspace competitor
before factory construction, spawn, RPC write, or session-state mutation.
The recommended typed diagnostic is `CODEX_DAEMON_GENERATION_BUSY`, distinct
from same-session switch-in-flight and daemon quarantine. A rejected request
must not reveal the owner chat, cwd, thread ID, or generation ID.

The sanitized measurements are
`tests/fixtures/codex-app-server-0.145.0/resource-observation.json`.

## U1 complete; U2 may start

Both U1a and U1b return `CONTINUE`. The accepted native-beta contract treats
hard-loss descendant escape as a documented limitation with daemon-wide
same-host reboot quarantine, not as a claim that normal turn stop is absent.
Normal stop remains interrupt, exact terminal reconciliation, background
terminal clean, and a fresh empty first-page check.

The remaining operational qualification is rollout-only:

- there is no session wrapper launcher on this Mac, so wrapper behavior is
  N/A rather than passed;
- the `launchctl asuser` run proves same-UID GUI-bootstrap auth and direct
  child pipes but does not load or signal a disposable launchd plist;
- Linux/systemd and other hosts require their own launcher characterization;
  and
- no production daemon, service, config, or credential contents were touched.

U2 may implement the narrow line-delimited client. It must preserve the
prepared/write-attempted/response-observed ledger, Codex-owned retry rule,
unknown-effect non-replay rule, immutable model/effort thread policy, exact
profile provenance, one-live daemon lease, and accepted quarantine contract.
No Orchestra backend or Claude behavior has been changed by U1.

## Credential-free hook notification probe passed

Codex 0.145.0 emits `hook/started` and `hook/completed` whenever the active
configuration enables hooks. `lib/codex/protocol-schema.json` lists both as
dropped server notifications and `lib/codex/app-server-client.js` enforces that
drop. The characterization allowlist in `scripts/spikes/codex-app-server-rpc.mjs`
admits the same two methods without retaining them. Every other `hook/*` method
remains an exact-match fail-closed protocol fault; that is proved
deterministically by "Codex U1a faults a well-formed but unlisted hook
notification" in `tests/codex-app-server-spike.test.js` rather than by a live
peer.

`scripts/spikes/codex-app-server-hook-probe.mjs` is the reproducible gate:

```sh
node scripts/spikes/codex-app-server-hook-probe.mjs \
  --binary /absolute/versioned/path/to/codex \
  --probe-root /absolute/non-temporary/probe-root
```

It exits 0 only when every gate check passes, and deliberately exits 1
otherwise, including on a thrown failure.

Containment holds on the complete successful envelope, not only on failure, and
it is a closed-key projection rather than denylist filtering. Every emitted
object is built key by key from an approved name list with an approved scalar
type; no evidence-derived object is ever spread. An unapproved key is therefore
dropped and cannot be emitted whatever it contains, including benign plain text
no regex would catch. An approved slot holding a wrong type or an
off-enum value collapses the whole result to a content-free `STOP` with a
category. Raw turn ids are stripped from both lanes. The trailing
content-free assertion is retained as defense in depth, not as the mechanism.

Nothing raw is persisted. The hook handler parses stdin in place and writes only
closed fields — event name, whether a `turn_id` was supplied, and its SHA-256 —
so the user prompt, cwd, and transcript path never reach disk, and no raw turn
id is stored. The raw JSON-RPC lane routes each response directly to its pending
request and keeps no session-wide result cache; a result exists only as a local
value for the duration of that request, and callers digest or project what they
need and discard the rest. Only bounded closed-field summaries survive the
request.

### What the authoritative lane is

The hooks-on and hooks-off lanes drive the production `CodexAppServerClient`
with the real `attestPinnedCodexBinary` target-pin attestation, an isolated
mode-0700 owned `codexHome`, the exact `expectedConfigSha256`, and the
production delivery-checkpoint ledger. Each lane awaits an actual delivered
`turn/completed` rather than sleeping. The gate therefore fails if the
production schema-backed boundary breaks, even when a raw stdio session would
still have completed.

The hooks-off control lane is held to the same predicates as hooks-on —
completed status, an assistant item, no fault, and the same three-way
start/started/completed identity equality — and additionally must see no hook
traffic at all.

A raw stdio session remains only as a secondary characterization of the payloads
the production client intentionally drops. Its outcome can never satisfy
authoritative completion: the gate requires
`authoritative.source === 'production-client'`.

That session enforces the same exact envelope key sets the production client
accepts — `{id, result}` / `{id, error}` for responses and
`{method, params, emittedAtMs}` for notifications. Ambiguous response and
notification shapes, arbitrary extra top-level members, unlisted notification
methods, and unexpected response ids all fail closed. It bounds stdout lines,
undelimited partials, aggregate bytes, message count and stderr bytes; on stream
end it flushes the decoder and fails on a trailing partial or on EOF with
requests still pending. Its terminal failure is re-checked **after** child
teardown and stream drain, so malformed bytes that arrive while the child is
being killed cannot be reported as success. Cleanup signals the owned process
group, and proves the group is empty by enumerating it with
`/bin/ps -axo pid=,pgid=` — the same mechanism the U1b effect proxy uses —
rather than trusting leader exit alone; an exit or a non-empty group that cannot
be proved is a `cleanup` failure.

Close-time faults count. The production lane reads its settled fault outcome
**after** `client.close()`, so a fault the client delivers during close cannot
be lost, and a close failure is reported rather than swallowed. Loopback
provider shutdown force-closes idle and active connections under a bound; a
provider close rejection or timeout yields a content-free `cleanup` STOP even
when the lanes themselves passed. Probe-root creation and provider acquisition
both sit inside nested guards so scratch removal always runs.

The turn completes against a loopback Responses provider declaring
`requires_openai_auth = false`, inside homes that contain no `auth.json`.
Credential-free is a property of that construction, gated on those two concrete
conditions, not an observation of file reads. No product credential is read,
copied, or required, and no existing Codex home is touched.

### Observed

- both lanes reached delivered `turn/completed` status `completed` with an
  assistant item and no fault;
- the `turn/start` response id, the single delivered `turn/started.params.turn.id`,
  and the completed turn id were equal;
- no `hook/*` method reached the production delivered notification sink in
  either lane;
- the exact configured event multiset (`sessionStart`, `userPromptSubmit`)
  appeared, each with exactly one `hook/started` (`running`) followed by one
  `hook/completed` (`completed`), all timestamps 10-digit epoch seconds;
- exactly one hook stdin capture existed per configured event, counted from
  per-invocation capture files rather than a last-writer-wins name, so a
  repeated invocation fails the gate;
- the owned `config.toml` digest was byte-identical across each lane run;
- removing only the two schema drop entries flipped the gate to `STOP` with
  `authoritative.faultCategory` `protocol` and exit 1, while the hooks-off
  control stayed fault-free;
- no probe directory or child process survived either a passing or a failing
  run.

### Two distinct turn identities

App-server notification `params.turnId` and hook stdin `turn_id` are different
surfaces and must not be conflated.

- `params.turnId` rides on the `hook/started` and `hook/completed`
  notifications, which the production client drops. It is characterized only in
  the secondary raw lane, which runs its own separate turn: the probe emits
  `notificationTurnIdMatchesRawTurn`, a boolean comparing the digest of each
  hook notification's `params.turnId` against the digest of *that lane's* own
  `turn/start` turn id. It is deliberately not compared against the
  authoritative lane's turn, which belongs to a different turn entirely.
- Hook stdin `turn_id` is supplied to the hook process itself. The probe proves
  from the authoritative lane's own captures that `userPromptSubmit` stdin
  `turn_id` equals the authoritative turn id. It is **absent** for
  `sessionStart`, whose stdin carries `cwd`, `hook_event_name`, `model`,
  `permission_mode`, `session_id`, `source`, and `transcript_path` but no
  `turn_id`. Hook stdin identifies the thread as `session_id`, not `thread_id`.

The probe requires the `sessionStart` capture to exist while omitting
`turn_id`; a missing capture fails. It records that event as
`present-without-turn-id`, never as a satisfied equality. Any receipt design
keyed on hook stdin `turn_id` must select an event that supplies one; a
`sessionStart` hook cannot discharge that correlation.

### What the config digest does and does not attest

The probe drives the full drift sequence and gates every step: hooks are
discovered `untrusted`, rendered `trusted`, then the hook handler is mutated.
After mutation `hooks/list` reports a new `currentHash` and `trustStatus:
modified` **while `config.toml` and its digest are unchanged**. Only after the
new trusted hash is re-rendered does the owned-config digest change and the hook
return to `trusted`/enabled.

Digest-only attestation therefore does not detect an un-rendered hook-file
mutation; the `trustStatus` returned by `hooks/list` is the signal that does.

Scope limits. This is a protocol-boundary and correlation result, not a hosted
product result: the completed turn is served by a loopback provider, not by the
real model backend. `CodexProcess` is not exercised; `CodexAppServerClient` is
the smallest production boundary for this two-method change. The named-profile
checker (`scripts/spikes/codex-app-server-real.mjs`) still rejects any
configuration where `effective.hooks != null`, so the reviewed hook-free
validation profile above is unchanged and was not re-run with hooks. A
hook-enabled authenticated run against the hosted backend, and the
wrapper/absolute-binary-path rejection, remain unproved here.
