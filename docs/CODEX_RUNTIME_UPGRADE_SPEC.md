# Codex runtime upgrade: 0.145.0 to 0.167.2

Status: implementation and amendments independently reviewed; crash-gate scope corrected by coordinator, bounded provider verification authorized, production unactivated. Detailed evidence: [upgrade report](CODEX_RUNTIME_UPGRADE_REPORT.md). Base: c195f2f96373c8c2cb6a86f5b6fa8ef70ae98431.
No Claude CLI/Agent SDK pins, package release versions, production configuration,
service state, publication, or existing parent worktrees may change.

## Problem and research

Ivan requested a runtime upgrade after trusted/proxy enablement. Orchestra currently
pins exact 0.145.0 target binaries and experimental v2 schema. Preserve the public
source interface, limited policy, trusted policy, provider selection, native ChatGPT
auth admission, model/effort catalog, hooks, durable event delivery, steer and resume.

Verified 2026-11-12: the official changelog and OpenAI release API identify
rust-v0.167.2 (non-prerelease, published 2026-11-11) as latest stable:
- https://learn.chatgpt.com/docs/changelog (Codex CLI 0.167.2)
- https://api.github.com/repos/openai/codex/releases/latest
- https://github.com/openai/codex/releases/tag/rust-v0.167.2
- https://developers.openai.com/codex/app-server

Downloaded official exact-tag source and Darwin ARM64 / Linux x64 musl releases
under /tmp/codex-runtime-upgrade-research; generated stable and experimental schemas
from the candidate under an empty isolated CODEX_HOME. Preserved the old Darwin
binary outside updater/vendor GC at ~/.local/share/orchestra-runtime-evidence/
codex-0.145.0/codex-aarch64-apple-darwin with the existing matching SHA-256.
Release notes for all stable versions in the delta and relevant exact-tag source
are reviewed before implementation; release evidence is summarized in the report.

Relevant upstream changes include permission restoration on resume, provider
validation, thread shutdown/start races, environment-scoped hooks, and command-hook
async metadata. Local source inspection covered compatibility docs, protocol schema,
preflight, factory, app-server client, CodexProcess, their immediate tests, Polygram
runtime profile and the minimal Shumabit spec. Candidate source:
codex-rs/app-server-protocol/src/protocol/v2/{thread,plugin,permissions}.rs and
codex-rs/protocol/src/permissions.rs.

## Decision and alternatives

Choose latest stable 0.167.2 subject to all gates below. Keeping 0.145.0 has the
strongest old evidence but does not fulfill the requested upgrade. The smallest
stable successor (0.146.0, verified from official release inventory) reduces the delta but omits
later permission/resume/provider fixes and still needs fresh binary/schema/live
attestation; prefer it only if a concrete incompatible candidate behavior prevents
preserving the agreed contract. Do not silently downgrade or relax policy.

Retain stdio app-server rather than switching SDK, exec, WebSocket RPC transport,
or a remote agent host. Those alternatives alter lifecycle and ownership without
helping this bounded runtime upgrade. Provider WebSocket transport remains the
existing supports_websockets=true configuration, independently of stdio RPC.

## Interface and data flow

Public constructors, receipts, factory selection, checkpoint sinks and process
state machine remain source-compatible. Update protocol-schema.json exact CLI
version, both target binary SHA-256 values and experimental v2 canonical digest.
Add a new versioned fixture/manifest with raw and canonical schema attestations;
keep the 0.145.0 observations historical and never relabel them as new evidence.
Use a dedicated candidate gate rather than transplanting old live observations.
The historical U1a checker must clearly identify its baseline when the active pin
has changed; its old fixture-unit tests remain historical tests.

Candidate schemas preserve required turn/steer fields and legacy sandbox variants.
Start/resume still expose experimental activePermissionProfile and
runtimeWorkspaceRoots; validate exact profile, owned root, model/provider, approval,
and sandbox through the production parser, for both fresh and persisted resume.
New thread metadata is not permission authority and is not exposed to consumers.
No new client methods, tools, server requests, or wildcard notification acceptance.
Any newly emitted notification requires source-backed explicit classification.
Candidate raw fresh/resume emits thread/readState/changed (source documented in
app-server README). It carries unread-state UI bookkeeping, not turn/checkpoint
ownership: add this exact method to dropped notifications with regression tests;
no wildcard acceptance or source payload exposure.
Authenticated startup also emits account/updated (account_processor.rs,
current_account_updated_notification); drop only this exact auth-mode/plan summary,
without forwarding account data. Explicit account/read remains the auth admission
authority, and unknown account notifications still fault.

Candidate PlanType adds promax, self_serve_business_prolite, ent26,
enterprise_cbp_automation, edu_plus, edu_pro, sci and sci_plus. Accept only
these exact schema enum additions; retain ChatGPT-only admission and omit email
and plan from the public account projection. Unknown values remain protocol errors.

HookMetadata now flattens a handler union. A command entry has handlerType=command,
command and async=false; environmentId must be present and null for our local owned
hooks. Extend the exact hook metadata verifier only for these observed/pinned
fields, require async strictly false, reject missing/non-null environmentId,
missing/true/nonboolean async, foreign handlers, and all unknown fields. Keep the
existing descriptor/receipt interface unchanged. Reconfirm the live raw shape
before editing; use a symptom-named failing fixture test before the fix.

Trusted filesystem remains exactly {glob_scan_max_depth:null, ':root':'write'}
(digest ce41c7bdb7f357798e0ce66850e28f87de7a8544bb13ce2cc029985aa41d852a),
with network enabled/web live; limited policy stays network/web disabled and
workspaceWrite with exact legacy exclusions/roots. A candidate shape change is a
stop requiring a reviewed spec amendment, not an extra accepted hash or stripped
unknown fields. Native memories remain disabled; shell inherits none, login false,
trusted actual service HOME/explicit PATH; limited mode retains its existing synthetic
command HOME and controlled PATH. CLIProxy remains optional, loopback Responses, private
bearer, requires_openai_auth=true, supports_websockets=true, no native fallback.

## Verification and failure handling

1. Offline: verify downloaded bytes, version, repeat schema generation, stable and
experimental canonical hashes and production-method parameter compatibility. Keep
Darwin and Linux evidence separate; compute Linux binary attestation locally and
run it/schema generation only on an isolated non-production Linux environment if
available. Never claim Linux execution from a downloaded-byte digest.
2. Deterministic credential-free fixtures: production client against real candidate
and bounded loopback Responses provider; exact config/layers/requirements/profile,
trusted and limited fresh attachment, completed turn/event delivery, authoritative
JSONL persistence, fresh-process resume, ordered steering/stale steer, interruption
and background-terminal cleanup. Limited mode must also enforce successful synthetic workspace access and denied
CODEX_HOME/daemon-secret reads and denied network; serialized policy is insufficient.
Use held fixture responses for deterministic
active-turn windows; keep all synthetic commands bounded. Prove old synthetic
rollout can resume under candidate, retaining an untouched old copy.
At least one candidate fixture must traverse production preflight -> spawn receipt
-> factory/CodexProcess -> acknowledged on-disk checkpoint sink, with authoritative
checkpoint readback; a no-op client sink cannot establish this integration layer.
Credential-free fixture-only providers may set requires_openai_auth=false; that
exception never clears production native ChatGPT-auth admission, which is proved
separately using the exact native/CLIProxy policy.
3. Hooks: run existing hooks-on/off production-client gate against candidate; raw
inventory characterization before exact verifier update, red/green fixture tests,
negative metadata tests, trusted inventory and content-free event dropping.
4. Actual providers: use only private existing auth, isolated persistent test homes
and synthetic workspaces. Do not print tokens or account identifiers. Planned
calls: one native Astra tools/skills/shared-memory turn; one fresh-process native
resume/steer turn; one CLIProxy Astra tools turn plus fresh-process resume turn if
accessible. Retain exact requested model and catalog effort; count inference
requests, distinguish logical turns and transport attempts, record ambiguous
outcomes and stop that lane without a blind retry. Inspect provider WebSocket/HTTP
behavior from safe transport metadata; a fixture is not real-provider evidence.
Skill-body consumption and shared memory use synthetic files only, no business data.
Require a nonce present only in a discovered harmless skill body, and fresh-session
recall of a synthetic fact through AGENTS instructions without naming its memory
file or repeating the fact in the prompt. Native transport attempts can be opaque:
report their count as unknown, separately from observed logical turns/tool rounds.
Each provider scenario has a 120-second deadline and bounded process cleanup;
missing native held-turn setup is explicitly inconclusive, not a steering failure.
5. Run focused production-client/preflight/factory/process/hook suites and full
Orchestra tests. The consumer gate is required: create a related
Polygram child through Orca based on 960b0be3b191f5a336bab8d5d6577d411c548a3a,
notify coordinator of its path, build/install a local unpublished package only in
that child, and run candidate profile-builder/preflight plus admission/revocation/catalog/event tests. No parent
writes or release version bump. Finish independent diff reviews, resolve must-fixes.

Credential access failure, unsupported runtime policy/provenance, new protocol
traffic without a safe explicit interpretation, or ambiguous inference stops the
relevant lane with concrete evidence. Keep failures and unproven layers visible.
Local tests are not activation, VPS deployment, or live bot parity proof. Retain
uncommitted reviewable changes and a final report with attestations, checks/skips,
red/green evidence, actual call counts, review decisions and release prerequisites.

## Approved instruction-source amendment

Exact candidate core/src/agents_md.rs:64 skips project instructions whenever
active_project.is_untrusted(). Version 0.150.0 introduced this security behavior.
Polygram deliberately writes trust_level="untrusted" to prevent project config and
thread/start from mutating owned config. Exact candidate app-server
src/request_processors/thread_processor.rs:1480 onward automatically persists
trusted project state when trust is absent and effective permissions allow writes.
Coordinator authorized the narrow dedicated-home symlink adaptation on 2026-11-12.
Retain explicit untrusted; do not downgrade to preserve the old loading mechanism.
Nested project AGENTS.md files are skipped by this runtime under untrusted; the
approved scope restores the canonical workspace root only, with no recursive merge.

Existing ownership flow: runtime-profile provisionRuntimeFiles canonicalizes the
workspace and dedicated owner-only non-temporary home, enforces root separation,
then provisionBaseConfig validates the exact owned config including its one
workspace trust stanza. A differing workspace already produces config drift;
hook preparation also owns home/workspace artifacts. Retain these authoritative
checks rather than creating another home registry or router.

Before provisionRuntimeFiles or any other provisioning mutation:
- Reject the actual user global Codex home (process user's ~/.codex), plus any
CODEX_HOME equal to the service HOME's .codex; only the dedicated Polygram home.
After exact owned config ownership validation, prepare the root instruction reference:
- If workspace/AGENTS.md exists, require a canonical regular owner-controlled file
(no symlink, group/other writes, or hard-link alias) and safe parent chain. Create
CODEX_HOME/AGENTS.md with exclusive symlink creation only if absent; otherwise
require it already be a symlink resolving directly to exactly that file. Never
replace a regular file, retarget a link, or follow a foreign/dangling alias.
- If the canonical root is absent, allow the existing limited generic workspace
without instructions, but trusted mode requires the canonical root. No home
AGENTS.md may exist in the absent-root case. Reject CODEX_HOME/AGENTS.override.md
whether regular, symlink or dangling. Do not create or change workspace files.
- Keep a private profile binding in the builder's existing ownership mechanism,
without adding public Orchestra receipt fields, content hashes or snapshots.
Re-attest path/type/target/override state after awaited characterization, after
preflight, on cached receipt use, client construction and shared live admission.
Root content edits remain live canonical edits and do not invalidate the profile;
replacing/retargeting the link, introducing an override, deleting/introducing the root, or
reusing the dedicated home for another workspace rejects new admissions.
- Reuse the existing builder reattest seam and controller assertEntryCurrent seam.
No per-chat home routing, recursive instruction merger, copied content, or new
persistent binding file. Exact owned config remains the persisted home/workspace
ownership authority and symlink target is the instruction binding readback.

Tests must reproduce canonical-root absence/foreign-target/override/workspace-reuse
failures before the fix; verify no existing path gets overwritten, global home is
refused before writes, normal canonical content edits survive re-attestation,
async preflight link drift and warm live admission drift are refused. Actual fresh
root marker, discovered skill-only nonce and unprompted synthetic memory recall
remain acceptance gates. All filesystem writes use isolated test homes/workspaces.

## Independent review receipts

Three built-in read-only reviewers completed before runtime edits: protocol and
feasibility; validation and provider evidence; scope, simplicity and security.
Must-fixes folded above: mandatory Polygram candidate boundary, distinct limited
HOME policy, production factory/process/persisted-checkpoint integration, exact
skill-only nonce and unprompted synthetic recall, provider count/deadline semantics,
fixture-only auth exception, and candidate limited filesystem/network enforcement.
The coordinator approved the narrow instruction-source adaptation. Protocol reviewer confirmed
candidate codex-home/src/instructions/mod.rs:42-76 loads CODEX_HOME/AGENTS.md before
project instructions and independently of project trust, while repository skill
host roots have no equivalent trust guard. Recommended narrow alternative:
retain explicit untrusted and symlink only the dedicated CODEX_HOME/AGENTS.md to
the canonical workspace AGENTS.md, require AGENTS.override.md absent, never copy
or translate instructions, and verify fresh root/skill/memory consumption. This
changes root instruction sourcing only within the approved canonical-root scope.

## Initial characterization (not production integration proof)

Candidate Darwin SHA-256:
97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0.
Downloaded Linux musl SHA-256 (not executed):
a9672d0fa0dd8fcf8cad136fa0d056b914bc046f5ac3d78f4a5cf390655af56b.
Darwin generated stable v2 canonical SHA-256:
3acaab0f5788b486250d8e32f75ae5e98198c63090a500c04182df52f0c8f137.
Darwin generated experimental v2 canonical SHA-256:
ca9811bd8310c9576f2acc1c37ba132afeef49c0cdbc3e02908b64ad12126163.
Raw bounded synthetic loopback characterization passed trusted filesystem shape,
start, completed turn, JSONL readback and fresh-process resume at
/private/tmp/polygram-trusted-resume-20o8NR/observation.json. This bypasses the
production parser/preflight and uses synthetic auth, so does not clear them.
At this initial characterization stage: one synthetic loopback logical turn and zero
actual provider calls. Later provider accounting is in the report.
Related Polygram child created through Orca at
/Users/ivanshumkov/orca/workspaces/polygram/codex-runtime-compat,
base HEAD 960b0be3b191f5a336bab8d5d6577d411c548a3a. Subsequent consumer
implementation and verification are recorded in the report.

Amendment re-review: protocol/feasibility and security/scope reviewers accepted
the design after moving the dedicated-home guard before all provisioning writes.
Both reviewers required that ordering; the scope reviewer also added the
absent-root to root-created drift regression. These corrections are incorporated.

## Companion executable amendment (approved and independently reviewed)

The first native Astra turn reached inference, emitted its intended calibration
commentary, and was contained on a protocol fault before tool completion. It is
not a successful provider gate and must not be blindly retried. Loopback tool
reproduction then exposed a separate concrete distribution requirement: 0.167.2
code mode needs `codex-code-mode-host`, shipped as a separate official release
asset; the single CLI archive omits it. An initial output-only fixture was
insufficient because the model can return text after a failed tool invocation.
The strengthened gate must assert the synthetic tool marker exists.

Exact-tag source: install-context/src/lib.rs:175-205 resolves the code host from
packaged resources first, then beside the executable; core/src/thread_manager.rs
selects the host-backed runtime. The code host creates its own process group;
kill-on-drop is useful evidence but does not by itself establish containment.
Required validation includes successful tool output and cleanup with the companion,
plus SIGKILL of the app-server itself while a bounded synthetic tool is active.
Observe the code-host PID/group and actual nested command PID; verify both exit
independently of the supervisor-group proof, and report survivors as blockers.

Proposed narrow implementation: retain public runtime/profile/receipt interfaces,
but treat the code host as another exact pinned executable of the selected target
inside the existing binary attestation/start boundary. Validate its canonical
path chain, owner/mode/nlink/executable status and exact hash using the existing
rules. Resolve only the upstream documented plain standalone sibling layout for
this bounded release; reject competing codex-resources or package-metadata layouts
rather than accepting a different helper silently. Bind the companion fingerprint and helper-selection layout privately, recheck
after initial attestation/spawn and before state-changing request writes because
upstream launches it lazily. Test missing/tampered companion, replacement after
startup, and late resource/package-metadata shadow introduction. Record both target companion
hashes in the pin manifest. Do not disable code mode, choose alternate tools, add
RPC methods, weaken filesystem policy, or accept arbitrary helper paths.

Alternatives: disable code mode and force direct tools (changes native model/tool
behavior and can fail closed for CodeModeOnly models); use an earlier stable candidate (legitimate fallback if evidenced compatible, but
requires its own artifact/schema/provider gates and does not yet solve this issue);
accept helper presence without exact attestation (weakens executable identity).
If supported helper selection or cleanup cannot be proved within this boundary,
stop before release/activation and report the specific blocker.

Official companion downloaded-byte SHA-256 values:
Darwin ARM64 45acdb759c3ac0a6b30a5107329b364b7ac1579f2cdf270997f03bc8d6365ef6;
Linux x64 musl 007c62795a7215c27ee85486ecb95e714b33118a2d18c6d7b09b0d9793c72ff4.
Linux remains byte-attested only. A paid retry requires coordinator permission
because the prior live action failed; the corrective retry will be bounded to
one fresh two-turn native lane after the deterministic tool/cleanup gate passes.

Companion amendment review: protocol and scope/security reviewers accepted the
narrow approach with the lazy-spawn fingerprint/layout fence and explicit
SIGKILL/host/nested-command cleanup checks above. Native live fault diagnosis
remains separate from the verified missing-helper distribution requirement.

Coordinator approval: exact official companion dependency and ONE corrective
native diagnostic lane (at most two turns) are authorized after deterministic
helper/tool/SIGKILL cleanup gates. No production installation is authorized.
Deployment and rollback must preserve both exact-target standalone artifacts:
`codex` and sibling `codex-code-mode-host`, immutable and owned under the same
secure versioned directory; include Darwin ARM64 and Linux x64 musl hashes above.
Do not install only the CLI archive or mix helper versions. Keep the old 0.145
runtime directory and its source/package/config backups outside updater GC;
rollback selects those preserved artifacts rather than overwriting candidate files.
Before any production step, Linux execution/schema/helper/cleanup proof and the
existing deploy/admission checks remain mandatory. The helper selection contract
currently excludes npm/package/resource layouts; activation must use the reviewed
plain standalone sibling layout.


## Bounded crash comparison and current hold

The stricter companion SIGKILL gate failed on Darwin: the host exits but a nested
foreground sleep survives. Equivalent bounded direct foreground command crashes
on preserved 0.145.0 and candidate 0.167.2 show the same orphan beyond eight
seconds, using the production Node supervisor and no session launcher. This is
evidence of an existing hard-loss limitation, not a demonstrated candidate
regression. The existing compatibility document explicitly accepts arbitrary
descendant hard-loss limits with same-host reboot quarantine. A blanket new
descendant guarantee exceeds that accepted baseline and requires explicit
alignment; it must not be silently introduced or silently waived.

Production Linux source/read-only inspection finds systemd scope membership and
resource limits, but no exact owned-unit stop acknowledgment or app-server-death
trigger. Scope collection does not kill an active orphan. No isolated Linux
execution has been performed. A new owned-scope lifecycle might be narrower than
a general supervisor, but it changes ownership/lifecycle and is outside the
current implementation without reviewed alignment. Exact 0.145/0.146 source already
enables code-mode hosting; the smallest stable successor has no evidenced cure.

Keep 0.167.2 unactivated and both remaining paid lanes held while reporting these
comparisons. Prefer finishing the candidate under the existing accepted boundary
if explicitly aligned; no blind retry or containment expansion. The report records
exact identities, cleanup readback, native-attempt accounting, tests, limitations
and release prerequisites.


## Accepted containment boundary after comparison

Coordinator explicitly aligned the upgrade gate to the existing native-beta
hard-loss/quarantine contract. This corrects the newly introduced blanket
arbitrary-descendant guarantee; it does not turn the failed SIGKILL cleanup
observations into passes. Preserve both logs and limitation. Normal interrupt,
exact terminal reconciliation, background clean and fresh empty-page checks,
durable hard-loss quarantine, and no silent replacement/admission remain required.
No new containment subsystem or downgrade is justified by the shared result.

The one corrective fresh native lane (at most two logical turns) and first
independent CLIProxy lane are released under existing paid authorization. Stop a
lane after another unexplained or ambiguous result; no blind retry. After provider
diagnosis, pursue disposable non-production Linux validation without production
scope/service changes, shared host lifecycle changes, or paid cloud provisioning.


## Native diagnostic notification amendment

The one corrective native lane stopped after one incomplete logical turn with
CODEX_PROTOCOL_ERROR and no retry. Its content-free tail ends with an unknown
notification carrying exactly threadId, turnId and metadata. Among all generated
ServerNotification variants, only turn/moderationMetadata has that property set
(in both old and candidate schemas). The trace deliberately masked unknown method
names, so this is source/schema-backed attribution by shape, not captured exact
wire-method proof. The host now ran a tool call/output, so the earlier missing
companion does not explain this separate protocol omission.

Exact candidate protocol/common.rs declares experimental turn/moderationMetadata;
v2/model.rs defines its opaque JSON metadata. core/session/turn.rs forwards the
provider event to session/mod.rs, and app-server/bespoke_event_handling.rs forwards
it directly as this notification. It is observational provider metadata, does not
request authority, and is distinct from errors, terminal status or guardian
assessment. The existing protocol subset omitted it even though the old schema
also contains it.

Narrow correction: classify only this exact notification as dropped, preserving
existing envelope checks and privacy; do not expose opaque metadata, add methods,
accept wildcard siblings, or bypass actual error/terminal handling. Add the exact
observed parameter shape to a pending-RPC fixture; prove rejection before the pin
change and healthy completion with zero delivered payload afterward. Add a sibling
unknown turn notification negative. Alternative: opt out at initialization, which
changes startup negotiation without benefiting this static exact-drop policy;
delivering opaque metadata adds unnecessary public surface. Native corrective
authorization is exhausted by its stopped lane; no automatic repeat. The first
independent CLIProxy lane remains unused and can run after this deterministic fix.

Improve content-free tracing with closed source-backed method/key/item-type sets;
unknown names and key names remain redacted (retaining counts/types). Add only the
new exact source-backed method to the existing recognizer for this fix. Never
record arbitrary item-type/key strings or metadata/prompt values.


## Native correction validation authorization and result

After reviewing the exact-drop fix and red/green evidence, coordinator authorized
one further fresh native lane, at most two turns. It completed both turns with
actual Astra tools, canonical root instruction marker, discovered skill-body
nonce, unprompted synthetic memory, authoritative JSONL, fresh-process resume,
semantic steer and durable event correlation. The now-allowlisted trace captured
exact turn/moderationMetadata with keys only, confirming method identity without
metadata values. Independent first CLIProxy lane also completed both turns.
Provider transport attempt counts remain unknown. No production activation.


## Linux translated execution evidence boundary

A task-owned local cua/Lima VM and private Docker engine supplied ARM64 Linux
with the already-installed RosettaLinux translator. Exact pinned Linux x64 CLI
and companion passed production attestation, raw/canonical schema regeneration
(matches Darwin), and the real consumer fixture with helper tools, fresh resume,
steer, durable events and normal interrupt/terminal/clean/fresh-empty receipts.
Node22.23.5 x64 ran without target overrides or injected attestors. No Linux
external inference or production launcher changes. This is translated execution,
not native x64 CPU/seccomp/sandbox or systemd scope cleanup proof. Preserve that
limitation for release/activation; no blanket descendant guarantee is added.
