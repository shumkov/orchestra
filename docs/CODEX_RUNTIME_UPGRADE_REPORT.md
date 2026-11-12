# Codex 0.167.2 local upgrade evidence

Status: reviewed local implementation; hard-loss gate scope explicitly reconciled
to the accepted native-beta/quarantine contract. Native and CLIProxy final validation lanes passed; translated Linux x64
attestation/schema/consumer/helper/normal-stop validation passed. No production activation,
publication, commits, package-version changes, or Claude/Agent SDK pin changes.

## Scope and decision

Orchestra base: `c195f2f96373c8c2cb6a86f5b6fa8ef70ae98431`, worker tree
`/Users/ivanshumkov/orca/workspaces/orchestra/codex-runtime-upgrade`.
Polygram consumer base: `960b0be3b191f5a336bab8d5d6577d411c548a3a`, owned Orca child
`/Users/ivanshumkov/orca/workspaces/polygram/codex-runtime-compat`.
Parent/trusted/shared-skills/infra worktrees were read only.

Official release verification on 2026-11-12 selected non-prerelease `rust-v0.167.2`
(published 2026-11-11). Read the complete stable release inventory between 0.145.0
and 0.167.2 (40 releases), exact candidate source and official app-server docs;
the protocol reviewer independently audited the delta. Evidence is retained in
`/tmp/codex-runtime-upgrade-research/{latest.json,delta-release-notes.md,codex-rust-v0.167.2}`.
Sources: [official release](https://github.com/openai/codex/releases/tag/rust-v0.167.2),
[release API](https://api.github.com/repos/openai/codex/releases/latest),
[app-server documentation](https://developers.openai.com/codex/app-server).

Keeping 0.145.0 retains established evidence but provides no upgrade. The smallest
stable successor 0.146.0 reduces the delta but still needs new schema/binary/provider
validation. Exact 0.145/0.146 source already enables `CodeModeHost` by default;
0.146 does not source-evidently avoid the companion or process-group issue. No
evidenced earlier stable candidate solves the observed shared crash limitation.
Prefer finishing 0.167.2 within the already accepted containment boundary, under
the coordinator-approved correction to the stricter new crash-gate scope. This is
not a passing crash cleanup result; do not downgrade solely from this observation.

## Reviewed changes and interfaces

The spec received three initial independent reviews, two instruction-amendment
reviews and two companion-amendment reviews. Final protocol and scope/security
reviews are CLEAN for the source changes; final protocol, scope/security and
validation report re-reviews are also CLEAN. Final provider gates and translated Linux checks passed. Native Linux
CPU/sandbox/launcher validation remains a release prerequisite. These verdicts do not approve release or activation.

Public constructors, profile/receipt shapes, allowed client methods and process
interfaces remain compatible. Exact new hook metadata is validated (`async:false`,
`environmentId:null`); eight official PlanType additions are accepted without
exposing account data. Only the exact UI/auth summary notifications
`thread/readState/changed`, `account/updated` and provider
`turn/moderationMetadata` are dropped; unknown methods and
unsupported hook metadata still fail closed; exact policy checks remain enforced.
Limited/trusted policies, native ChatGPT admission,
CLIProxy selection, model/effort catalogs, hook inventory, checkpoint delivery,
steer/resume and deployment admission/fingerprint fencing remain enforced.
Trusted filesystem serialization remains `glob_scan_max_depth:null`, digest
`ce41c7bdb7f357798e0ce66850e28f87de7a8544bb13ce2cc029985aa41d852a`.

Candidate explicit-untrusted project loading excludes project instructions as well
as project configuration. The approved adaptation binds only Polygram's dedicated
CODEX_HOME/AGENTS.md to the exact admitted workspace's canonical root AGENTS.md.
It never writes the user global Codex home, copies instructions, overwrites a
regular file, retargets an existing link, accepts foreign/dangling targets or
AGENTS.override.md, or reuses another workspace's binding. Existing owned-profile
identity/admission checks enforce the binding through cache and dispatch; canonical
content edits remain live shared-source edits. Nested project AGENTS are ignored
under this runtime's explicit-untrusted mode; this adaptation covers the canonical
Shumabit root, not a general nested-instruction loader.

The approved required companion is the exact-target official
`codex-code-mode-host`, in the plain standalone sibling layout only. Its secure
path/owner/mode/nlink/hash and selection layout are bound privately at existing
attestation boundaries and rechecked before spawn and state-changing writes,
including after awaited checkpoints. Competing resources/package/bundle layouts
are rejected. This adds no general executable supervisor or arbitrary helper path.

## Artifact attestations

All SHA-256 values below are exact official downloaded executable bytes. Preserved
old and candidate Darwin artifacts are outside updater/vendor GC under
`/Users/ivanshumkov/.local/share/orchestra-runtime-evidence/codex-<version>/`.

| Artifact | SHA-256 |
| --- | --- |
| 0.145.0 Darwin ARM64 CLI | `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590` |
| 0.145.0 Linux x64 musl CLI (base pin; not newly executed) | `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14` |
| 0.145.0 Darwin ARM64 companion | `c75e27ea296ede4025959e4f66772c283261f28d95b1f27be4d8ef07aabe9bce` |
| 0.167.2 Darwin ARM64 CLI | `97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0` |
| 0.167.2 Darwin ARM64 companion | `45acdb759c3ac0a6b30a5107329b364b7ac1579f2cdf270997f03bc8d6365ef6` |
| 0.167.2 Linux x64 musl CLI | `a9672d0fa0dd8fcf8cad136fa0d056b914bc046f5ac3d78f4a5cf390655af56b` |
| 0.167.2 Linux x64 musl companion | `007c62795a7215c27ee85486ecb95e714b33118a2d18c6d7b09b0d9793c72ff4` |

The base 0.145.0 experimental canonical schema pin was
`1bc09dedc506075562d4d49b702ecab6d947dd5a8c2a9014a5cde592a0938efb`.
Fresh candidate Darwin binary generation, stable then experimental v2:

| Schema | Stable | Experimental |
| --- | --- | --- |
| Repository canonical digest | `3acaab0f5788b486250d8e32f75ae5e98198c63090a500c04182df52f0c8f137` | `ca9811bd8310c9576f2acc1c37ba132afeef49c0cdbc3e02908b64ad12126163` |
| Raw ClientRequest JSON | `94074a415950787a25e09ae3b4d9de312cc264eb0f021633dfca921d300cd42a` | `2d629aaaceea335d7e58ab19ce5908c8dd75ca3f3a6161a5f015bf59aadd3295` |
| Raw protocol JSON | `021462a9bacd117f4cd40c256a4888619d059cec6a65b795198d521ba660e554` | `486c7c8daa5dc7f3ab2a1fb56de5316804caf7a4210fda1dc28d3f0f4e90cfe1` |

The regeneration probe caught an initial research canonicalization mistake:
Python ASCII escaping differs from the repository algorithm on newly present
Unicode. Corrected pins above use `lib/canonical-json.js`; raw byte hashes did not
change. `/tmp/codex-upgrade-schema-digest-red.log` and
`/tmp/codex-upgrade-schema-regeneration.log` preserve the mismatch and successful
independent regeneration/manifest comparison. Preflight fingerprint fixtures were
updated deliberately. Exact Linux x64 CLI/helper attestations and freshly generated
stable/experimental schemas also passed in the disposable Linux VM using RosettaLinux
x64 translation; both raw hashes and canonical digests match Darwin. Simulated
target-selection tests are separately labeled and are not execution evidence.

## Verification and red/green evidence

Final full runs after the notification correction: Orchestra 1,585/1,604 tests passed
(19 N/A skips: 17 channel capabilities and two Codex capability cases), zero failures;
Polygram full run before the final Orchestra-only notification change:
4,791/4,807 passed (16 existing opt-in Claude skips), zero failures. Logs:
`/tmp/orchestra-codex-upgrade-final3-full.log` and
`/tmp/polygram-codex-upgrade-final2-full.log`. Linux target-selection simulation
passed all 35 preflight tests; this is not Linux execution. After the exact
notification fix, all 249 client/preflight/upgrade tests and 321 consumer Codex/
dependency-contract tests passed. Both diffs pass
`git diff --check`. Historical Codex fixture tests: 116 pass.

Concrete failures were pinned before fixes: strict hook metadata, exact account
notification/plan additions, missing helper admission, helper-selection shadow
layouts, drift during awaited spawn attestation, canonical instruction ownership,
and original owned-profile retention through registered admission. Red/green logs:
`/tmp/codex-upgrade-{hooks,account,plan}-{red,green}.log`,
`/tmp/codex-companion-{real,prespawn}-{red,green}.log`,
`/tmp/codex-companion-shadow-red.log`, `/tmp/codex-companion-green.log`,
`/tmp/polygram-codex-instructions-{red,green}.log`,
`/tmp/polygram-instruction-admission-{red,green}.log`.

Meaningful real-binary deterministic checks (zero external inference):

- Production Polygram builder/preflight/factory/CodexProcess/checkpoint path with
  actual code-host tool execution and synthetic memory/skill read plus tool marker;
  two loopback turns, four HTTP requests, two rejected WebSocket attempts followed
  by HTTP fallback, 49 durable checkpoints. Fresh-process resume, ordered steer,
  stale-steer rejection and authoritative JSONL readback passed:
  `/tmp/codex-upgrade-tool-reviewed-fixture.log` (fixture-cgxO6L); final post-pin
  repetition `/tmp/codex-upgrade-tool-final-fixture.log` (fixture-fOyxqr) passed
  the same checks/counts.
- Real candidate hooks trust lifecycle: all 14 checks passed, credential free,
  `/tmp/codex-upgrade-real-hooks-final.log`.
- Real limited sandbox: workspace read/write allowed; actual protected-home
  config/auth/daemon-secret canary denied; external sandbox network blocked while
  host loopback control succeeded, `/tmp/codex-upgrade-limited.log`.
- Old 0.145 synthetic rollout preserved, candidate fresh-process resume and
  authoritative persisted readback passed, `/tmp/codex-upgrade-old-to-new.log`.
  This raw transport characterization is separate from the full consumer fixture.
- Final candidate normal interrupt fixture passed exact terminal reconciliation,
  background clean and fresh empty-page durable receipts:
  `/tmp/codex-upgrade-interrupt-fixture.log`. Two completed synthetic turns plus
  one intentionally interrupted turn, zero external inference.
- Helper attestation and delayed pre-spawn selection-shadow checks passed against
  the actual candidate, `/tmp/codex-companion-prespawn-green.log`.

Loopback skill/memory execution is deterministic tool proof, not proof that a live
model independently followed root instructions or consumed discovered skill bodies
and unprompted synthetic shared memory. Separate actual provider evidence below
now completes those gates.

## Actual provider results and paid-call accounting

| Lane | Logical turns attempted | Completed | Result |
| --- | --- | --- | --- |
| Original native Astra | 1 | 0 | stopped on unexplained protocol fault |
| First authorized corrective native | 1 | 0 | stopped on uniquely matched metadata notification |
| Further explicitly authorized native after deterministic fix | 2 | 2 | passed |
| First independent CLIProxy Astra | 2 | 2 | passed |
| Total | 6 | 4 | two stopped lanes retained separately |

Transport/inference request-attempt counts are unknown; these logical-turn counts
are not billable-request counts. No blind paid retries occurred. The coordinator
explicitly authorized each corrective lane after reviewing evidence.

Final native evidence: `/tmp/codex-upgrade-native-final-live.log`, private
`live-DbxsvM`, 53 durable checkpoints. Final CLIProxy evidence:
`/tmp/codex-upgrade-cliproxy-live.log`, private `live-F8Tlq0`, 55 checkpoints.
Both use actual `gpt-6-astra`/high through the production consumer builder/preflight/
factory/CodexProcess. Both passed canonical root instruction consumption, discovered
skill-body nonce, unprompted synthetic shared-memory fact, actual shell tool marker,
completed turns, authoritative JSONL readback, fresh-process resume, accepted and
semantically consumed steer, and correlated durable request/start/terminal/delta
checkpoints/events. Native final safe trace directly captured exact
`turn/moderationMetadata` with threadId/turnId/metadata key names and no values,
confirming the earlier source/schema-backed inference. Live bot parity is not claimed.

The original failed lane `/tmp/codex-upgrade-native-live.log` (live-DvhDQ7) remains
unexplained at exact-method level; the helper omission was separate. The stopped
first corrective lane `/tmp/codex-upgrade-native-corrective.log` (live-HBJWiT)
produced one tool call/output before the inferred metadata rejection, no final
completion. Their failed results are not relabeled as successes by later passes.
The reviewed exact-drop correction has pending-RPC red/green privacy and unknown-
sibling regression proof in `/tmp/codex-moderation-{red,green}.log`.

CLIProxy used the existing private loopback Responses provider through SSH forwarding;
ChatGPT auth remained mandatory. Read-only `/v1/models` advertised Astra. Actual
WebSocket versus HTTP-fallback selection was not independently captured for the
live lanes; configured supports_websockets=true alone is not transport proof.
The deterministic fixture explicitly proves rejected WebSocket/HTTP fallback.
No production service changes. Probe auth clones remove refresh-token authority,
enforce bounded access expiry, and verify original auth unchanged. Bearer/account/
token values are never printed.

## Crash comparison and Linux scope inspection

The original fixture-qaDACI ran Darwin ARM64 27.0.0, direct binary under Orchestra's
Node supervisor, with no sessionLauncher. Its app-server PID 347/group 346 was
SIGKILLed; helper PID 374/group 374 exited; nested `/bin/sleep` PID 375/group 375
survived beyond eight seconds. The original log omitted platform and precise fault
timing; it is supplemented by explicit audited reproduction below.

Audited fixture-X7a0kn: same OS/launcher, app 6356/group6355, helper6386/group6386,
nested6387/group6387. No client fault before injection at1794473540531; protocol
fault followed at1794473540595 (+64ms). At1794473548600 nested6387 remained PPID1;
only the positively identified fixture process was killed. This injected crash does
not diagnose the earlier live protocol fault. Evidence:
`/tmp/codex-upgrade-crash-audited.log`; final repeated probe also records
authoritative post-cleanup absence in `/tmp/codex-upgrade-crash-final.log`.

Equivalent bounded ordinary FOREGROUND `command/exec` crash comparison used
`/bin/sh -c 'echo $$ > foreground.pid; exec /bin/sleep 30'` under the same production
supervisor, no session launcher, Darwin ARM64 27.0.0, Node26.5.0. Supervisor source
SHA `afb5da3227c42d3160e6c149523a5a94aeedff046fb561619c19901fa5366c45`.

| Runtime | Supervisor PID | App PID/group | Nested PID/group | After app SIGKILL |
| --- | --- | --- | --- | --- |
| Preserved 0.145.0 | 4767 | 4772/4767 | 4774/4774 | survives >8s, PPID1 |
| Candidate 0.167.2 | 4958 | 4969/4958 | 4988/4988 | survives >8s, PPID1 |

Exact old/new CLI identities are the hashes above. Both owned fixture commands were
identity/group/name checked, killed, and absence read back. Full observations and
injection timestamps: `/tmp/codex-upgrade-crash-compare.log`, private
`crash-compare-jHl4Xk/report.json`. This proves a shared Darwin hard-loss limitation,
not a demonstrated candidate regression. Baseline compatibility docs explicitly
accept arbitrary-descendant hard-loss limits with daemon-wide same-host reboot
quarantine (existing document lines29 and728). Normal interrupt/terminal/background
cleanup remains mandatory. Requiring every arbitrary descendant to disappear after
hard loss exceeds that documented baseline. Coordinator explicitly corrected this
upgrade-gate scope; the crash-cleanup observations remain failed.

Read-only production Linux inspection found systemd255.4 on x86_64 and installed
launcher `/usr/local/libexec/claude-session-scope`, SHA
`c84655092a93df6857ec9008892801ab3f0a020aa5643e5d9932d227c0fef60e`.
The infra template execs `systemd-run --user --scope --collect --quiet
--no-ask-password --description=contained-claude-session --expand-environment=no
--slice=claude.slice` with OOM/resource limits and stripped bus/tmux environment.
Parent Polygram passes ORCHESTRA_SESSION_LAUNCHER into Codex. Existing client
attests the launcher, but obtains no exact owned-unit identity or stop receipt.

Nine contained scopes existed. Two sampled active scopes had KillMode=control-group,
KillSignal=15, SendSIGKILL=yes, TimeoutStop=90s, RuntimeMax=infinity,
StopWhenUnneeded=no, BindsTo/PartOf empty, CollectMode=inactive-or-failed. The outer
production service has a distinct system.slice cgroup. No scopes were created,
killed or reconfigured; no prompts, environment secrets or raw journals were read.

A scope remains active while any process remains; `--collect` unloads inactive
units. KillMode applies when stopping the owned scope, not as evidence that a dead
app-server triggers that stop. No trap/unit-name/lifecycle acknowledgment establishes
such a stop here. The existing narrow grep RSS/D-state reaper does not supply
arbitrary orphan cleanup. These conclusions follow the exact source plus official
[scope](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.scope.xml),
[systemd-run](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd-run.xml)
and [kill](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.kill.xml)
semantics. Linux Codex source uses parent-death signaling for its direct child;
that is not executed Linux or arbitrary-descendant cleanup proof.

Initially no isolated Linux environment was running (Docker socket unavailable,
Colima stopped, no Lima instances). The authorized disposable environment described
below was subsequently created; no production scope changed. Reusing an exact
owned scope's stop lifecycle could be smaller than a general descendant supervisor,
but requires new unit identity/ownership/stop acknowledgment and reviewed alignment;
it is not an already proven facility. No containment implementation was added.

## Files and remaining prerequisites

Orchestra changed files: `lib/codex/{app-server-client.js,protocol-schema.json}`,
new `runtime-companion.js`; updated app-server/hook/preflight fixtures/tests; new
companion and runtime-upgrade tests plus `tests/fixtures/codex-app-server-0.167.2/`;
new companion/schema probes, historical spike diagnostic, this report, the spec
and compatibility-document historical banner.
Polygram child changed files: `lib/codex/{runtime-profile.js,runtime-controller.js}`,
binary/dependency/profile/controller/integration tests, and new
`scripts/spikes/codex-runtime-upgrade.mjs`. Source package manifests/locks unchanged.
Its node_modules contains the private local same-version Orchestra build only;
no registry publication or parent dependency write occurred.

Remaining: native Linux x64 CPU/sandbox and actual session-launcher crash/stop
validation; live WebSocket selection remains unproven; final
integration/release review and separately authorized packaging/deployment/activation.
Deployment and rollback require both exact-target CLI and companion as immutable
siblings, plus preserved 0.145 artifacts/config/package backups outside updater GC.
Nothing in this report claims live bot parity, native Linux sandbox/production
launcher cleanup, or production activation proof.


## Gate correction and corrective native result

Coordinator explicitly reconciled the new blanket descendant cleanup gate to the
accepted native-beta hard-loss/quarantine boundary. The failed crash observations
remain failures and an honest limitation. Existing normal interrupt/exact terminal
reconciliation/background clean/fresh empty-page tests and durable quarantine/no
silent replacement or new admission remain mandatory and passed in the full suite.
Relevant named regressions include `interrupt waits for exact terminal, clean,
fresh empty page, and durable stop checkpoints`, `strict clean resume rejects any
non-empty background terminal page`, and post-spawn fault quarantine tests.

The authorized corrective native lane stopped after one incomplete logical turn:
`/tmp/codex-upgrade-native-corrective.log`, private `live-HBJWiT`. It recorded an
actual code-mode tool call and output in authoritative JSONL, but no tool-proof
file and no completed turn. No root/skill-body/memory success is claimed. The
trace ends with unknown notification keys threadId/turnId/metadata; among the
generated candidate ServerNotification variants only turn/moderationMetadata has
that property set (also in the old schema). Exact candidate source forwards this
opaque provider metadata independently of terminal/errors/guardian decisions.
The trace masked unknown method names, so method attribution remains inferred
from the unique schema/source shape, not directly captured exact wire identity.

A reviewed narrow fix drops only that exact notification, retains unknown-sibling
rejection and does not expose metadata or grant new authority. The pending-RPC
regression reproduced CODEX_PROTOCOL_ERROR before the fix in
`/tmp/codex-moderation-red.log`. Diagnostic key/item strings are now closed-set
masked as well. The authorization for that single corrective lane ended when it stopped;
that stopped lane was not blindly repeated. Coordinator
then explicitly authorized one further bounded lane after reviewing the fix; its
completed result and the independent CLIProxy result are recorded above.


## Disposable Linux execution

Used cua-sandboxes guidance with a dedicated task CUA_HOME, embedded runtime and
separate state directory. No user/global cua, Colima or Lima home/config/lifecycle
was changed. The local Linux VM was ARM64 Ubuntu, kernel6.8.0-117-generic, with a
private Docker engine. Sandbox name codex-runtime-0167; x64 test container
codex-linux-x64. Node image node:26-bookworm-slim resolved to digest
sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1.

QEMU8.2.2 in this owned guest executed the exact x64 Codex CLI and generated matching
schemas, but crashed Node22 and26 before JavaScript execution. This is a translator
environment failure, not a demonstrated Codex regression. Existing Apple
VZLinuxRosettaDirectoryShare availability was installed; the task VM alone was
restarted via Lima's documented Rosetta support (no host installation). Colima's
Mac Rosetta receipt heuristic initially refused it; direct Lima correctly exposed
the already available Linux translator. QEMU's x64 binfmt handler was disabled
only inside this disposable guest so Rosetta could handle the test processes.
See [official Lima multi-architecture guidance](https://lima-vm.io/docs/config/multi-arch/).

Node22.23.5 x64 was downloaded from official nodejs.org with its SHASUMS256 check:
archive SHA cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8.
Actual process.platform=linux/process.arch=x64, no target overrides or injected
attestors. Corrected fixture file ownership after Docker cp (foreign uid502 was
correctly rejected); CLI/helper are root-owned secure test paths with exact hash checks.
The production schema probe passes CLI/helper attestation and both raw/canonical
manifest comparisons: /tmp/codex-linux-schema-probe.log. Linux raw hashes are now
recorded deliberately in the versioned manifest.

The consumer fixture initially stopped at account/read before any turn. The slim
container lacked its OS CA bundle; after installing ca-certificates in this
disposable container, the same fixture passed without changing auth or production
code. The final fixture
passed actual helper execution/tool marker, exact production profile/preflight/
factory, ChatGPT admission, two completed loopback turns, fresh-process resume,
ordered and stale steer checks, correlated persisted events, and a third
intentionally interrupted turn with exact terminal/clean/fresh empty-page receipts.
Counts:3 logical synthetic turns attempted,2 completed,1 intentionally interrupted;
5 loopback HTTP requests,2 rejected WebSocket attempts,68 checkpoints,0 external
inference. /tmp/codex-linux-consumer-green.log, fixture-mJlArb.
Private durable evidence:
`/Users/ivanshumkov/.local/share/orchestra-runtime-evidence/linux-translated-4ibjnazn`,
retaining report/checkpoints/synthetic rollouts/tool marker, excluding auth files. The clone had refresh authority removed; original source credentials
were never written.

These are actual translated Linux x64 CLI/helper/protocol/consumer executions on
an ARM64 Linux kernel. They do not establish native x64 CPU/seccomp/sandbox behavior
or the production systemd launcher lifecycle, and no Linux live inference was
performed. No production scope/service or shared host lifecycle was changed.


Cleanup: both positively owned containers were removed, the task VM stopped,
process inventory read back zero remaining processes referencing its exact state
root, and that private task CUA_HOME was removed after preserving evidence.
The task SSH forward was closed. Evidence cleanup.json records this readback;
no shared VM/service or production scope was stopped.


## Exact modified source paths

Orchestra:

- `docs/CODEX_RUNTIME_UPGRADE_REPORT.md`
- `docs/CODEX_RUNTIME_UPGRADE_SPEC.md`
- `docs/codex-app-server-compatibility.md`
- `lib/codex/app-server-client.js`
- `lib/codex/protocol-schema.json`
- `lib/codex/runtime-companion.js`
- `scripts/spikes/codex-app-server-real.mjs`
- `scripts/spikes/codex-runtime-companion-probe.mjs`
- `scripts/spikes/codex-runtime-schema-probe.mjs`
- `tests/codex-app-server-client.test.js`
- `tests/codex-hook-composition.test.js`
- `tests/codex-preflight.test.js`
- `tests/codex-runtime-companion.test.js`
- `tests/codex-runtime-upgrade.test.js`
- `tests/fixtures/codex-app-server-0.167.2/experimental-compatibility.schema.json`
- `tests/fixtures/codex-app-server-0.167.2/manifest.json`
- `tests/fixtures/codex-app-server-0.167.2/stable-compatibility.schema.json`
- `tests/fixtures/fake-codex-app-server.mjs`

Polygram child:

- `lib/codex/runtime-controller.js`
- `lib/codex/runtime-profile.js`
- `scripts/spikes/codex-runtime-upgrade.mjs`
- `tests/codex-binary.test.js`
- `tests/codex-runtime-controller.test.js`
- `tests/codex-runtime-integration.test.js`
- `tests/codex-runtime-profile.test.js`
- `tests/orchestra-dependency-contract.test.js`
