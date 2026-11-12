# Claude runtime 2.1.322 upgrade preparation

Status: proposed candidate; the SDK and CLI pins MUST remain 0.3.283 / 2.1.283 until the tracking issue exists and the checked old/new matrix passes on one recorded gate commit. A draft issue is not an opened issue. No release, consumer update, activation, or soak is authorized here.

## Followup preparation status

Related Polygram child now exists at `/Users/ivanshumkov/orca/workspaces/polygram/claude-322-gates`, branch `claude-322-gates`, base `960b0be3b191f5a336bab8d5d6577d411c548a3a`, correctly parented to this Orchestra worktree through Orca. All work is uncommitted. The parent and its dependencies remain untouched.

The reviewed local amendment is the child's `docs/claude-322-fixture-preparation-spec.md`; candidate expectation provenance is in `docs/claude-322-discovery-dossier.md`. Both exact binaries now reach readiness with the smallest supported included local consent file. Both then explicitly reject Channels and exit BLOCKED (2) before the test prompt; downstream modes were not retried. No supported credential-free account/feature enrollment was found. Paid execution requires an explicit go and an authorized isolated account context.

The child adds optional absolute manifest selection with exact-content binding and a fail-closed discovery stage. Separate `claude-2.1.322-discovery.json` is provisional and only permits candidate-filtered, non-authoritative runs; it cannot accept artifacts. Old .283 expectations remain intact; .322 inherits no opt-in waiver. The accepted default manifest and all runtime pins remain unchanged. The initial-phase observations below are retained as history, superseded where noted by this status and `/tmp/orchestra-claude-upgrade-followup-report.md`.

The current provider request states invocation/deadline scope and uncertainty. No extra spending-cap, metering proxy, or whole-run timeout project is a mandatory gate; existing driver turn limits, timeouts and cost-estimate metadata remain intact. Mandatory issue, accepted matrix on one gate commit, aligned reviewed pins, consumer review and both 24h soaks are unchanged.

## Problem and scope

Orchestra 0.11.3 at `0b11bbcdd28f309c3f92baa1444fcaad0c0436eb` pins Agent SDK 0.3.283 and CLI 2.1.283. Polygram's CLI adapter consumes private session JSONL, hooks, queue records, readiness text, and prompt attribution. Prepare the next upgrade without inferring compatibility from release notes or unit tests. Preserve Codex and the separately committed trusted-proxy work unchanged.

Read-only consumer reference: `/Users/ivanshumkov/orca/workspaces/polygram/piddock`, observed HEAD `960b0be3b191f5a336bab8d5d6577d411c548a3a`. Its `AGENTS.md`, `scripts/spikes/README.md`, matrix runner, manifest, and local stub drivers govern the consumer gates. Do not edit this checkout or its dependencies.

## Candidate and official evidence

Registry and official GitHub release metadata checked 2026-11-12:

| Surface | Observed value |
| --- | --- |
| Agent SDK npm latest / next | 0.3.322 / 0.3.322 |
| SDK package `claudeCodeVersion` | **2.1.322** |
| CLI npm latest / next | 2.1.322 / 2.1.322 |
| CLI npm stable channel | 2.1.311 |
| GitHub latest CLI and SDK | v2.1.322 / v0.3.322; both `prerelease: false`, `draft: false`, published 2026-11-10 |

Select **0.3.322 / 2.1.322 for evaluation**, the latest official non-prerelease pair. This does not mean it passed compatibility, nor that the npm `stable` channel moved. If Ivan intends the conservative `stable` dist-tag specifically, 2.1.311 is a different candidate requiring its own exact matching SDK metadata, attestations, and matrix; never silently substitute it after a failure.

Sources: [SDK registry](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk), [CLI registry](https://registry.npmjs.org/@anthropic-ai%2fclaude-code), [SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.322), [CLI release](https://github.com/anthropics/claude-code/releases/tag/v2.1.322), [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [CLI changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

Review the full change range after .283, not just .322. Relevant changes include SDK result batching for queued subagent reports (.321), new task attribution fields and notification ordering (.292), enabled fork subagents (.302), opt-in MCP task support (.319), initialization/resume hook timing (.321), new session-write failure signals (.317), settings/permission defaults (.284/.302), plus CLI queue/interrupt/paste and hook execution fixes. These touch `lib/process/sdk-process.js` result-to-pending-turn matching, `lib/process/cli-process.js` hook/ledger/readiness handling, `lib/tmux/log-tail.js`, and Polygram's build-options and stream consumers. No undocumented lifecycle difference may be normalized away without source-bound evidence and independent review.

## Approach and alternatives

1. Preserve the host's old SDK-supplied executable outside updater, vendor GC, node_modules, and disposable test trees; record version, SHA-256, byte size and source. Download the exact candidate platform tarball from the official registry; verify its registry integrity and executable version/hash. No installer or updater runs.
2. Review this spec independently for compatibility, scope, and isolation. Then run checked local fixtures against both exact binaries through the unchanged Orchestra adapter, in separate synthetic homes and a private tmux socket directory. Put HOME beneath a dedicated mode-0700 user-data fixture root, outside temporary roots: the mailbox IPC correctly rejects a HOME under `/tmp` (including canonical aliases and `os.tmpdir()`). Keep TMPDIR and TMUX_TMPDIR separate from HOME. Use a minimal allowlisted environment and dummy auth; keep all inference at a loopback HTTP stub and enforce external network denial. On macOS, changing HOME does not isolate the login Keychain: enforce denial of `security` execution, Keychain file reads/writes and securityd access, and preflight these restrictions before launching either binary. Do not import real settings, login material, sessions, or cached account flags. If Channels cannot initialize under these constraints, report BLOCKED rather than borrowing real auth.
3. Record command, exit, adapter commit, driver hash, binary hash, and content-free verdict for each local check. Private logs and artifacts stay mode 0600 beneath mode-0700 directories. Never use daemon vendor paths. Do not run auth-expired, boot-replay, production boot smoke, or a broad matrix during this authorization scope.
4. Prepare the exact issue text and a bounded paid-gate request. Leave version files and lockfile unchanged. Only after the mandatory issue and accepted matrix may a separately reviewed Orchestra pin change, release, and separately reviewed aligned Polygram consumer update proceed.

Rejected alternatives: update npm pins first (violates the gate); run the old .220/.283 matrix against .322 (wrong manifest and attestation); copy .283 expectations to .322 as accepted truth (hides drift); use only local unit counts (does not test native lifecycle/model behavior); use live HOME or daemon vendor paths (auth and GC hazards); update Codex alongside this work (separate ownership).

## Gate ownership and data flow

At the initial read-only reference commit, the checked runner loaded `claude-2.1.283-matrix.json` at a fixed path without a manifest override. The followup child adds a reviewed optional selector; the accepted default stays unchanged. It currently compares **2.1.220 -> 2.1.283**, holding installed SDK **0.3.283** constant. It has no .322 expectations and must refuse unknown versions. An isolated related Polygram child checkout is needed before editing that matrix: old becomes .283, candidate .322, old expectations retained, .220 removed, and .322 expectations established from reviewed observations. Candidate-specific waived opt-in behavior must be established anew; do not inherit the .283 waiver. Pin edits wait until a full accepted run on one gate commit.

Every scheduled matrix cell currently needs real inference: CLI contract twice per side; Workflow direct and fallback; delayed MCP default and, unless independently justified otherwise, opt-in; SDK PostToolBatch, subagent, resume, compaction and tool-less drain; candidate Opus projection and system-prompt snapshot. The binary Workflow anchors are statically inspectable, but their enclosing Opus projection still makes real calls. Existing snapshot NOT-APPLICABLE and opt-in waiver policy remain exact, evidence-based exceptions, not blanket exemptions.

Additional no-provider gates: `cli-api-error-stub.mjs` fail + inject + followup, fail + three injections, flaky recovery, subagent error attribution, retry interruption, 401, and folded input; `mailbox-two-roles.mjs --model stub`. Fixture validation and SDK type/API comparison can run locally. None establishes complete old/new lifecycle equality. The unchanged installed SDK in the pre-pin matrix isolates CLI changes; after the accepted pin move, repeat applicable SDK gates with SDK 0.3.322 to verify the actual new pair.

## Failure modes and verification

- Any unexplained new session/hook/queue/task/Stop/reply/wrapper shape blocks pin movement. Add a concrete red-then-green regression before changing adapters.
- Fresh HOME may lack account feature enrollment; a local stub gate that cannot reach readiness is blocked, not a compatibility regression and not a pass.
- A local fixture can prove transport/parsing only. It cannot prove real model choices, native provider tasks, snapshots enabled for an account, persisted consumer state, or deployment.
- Matrix timeouts, failures, or ambiguous paid runs do not authorize automatic retries. Stop and send evidence plus a bounded rerun request.
- No provider credentials in reviewable files; no real conversations in any artifact. Read preserved binary evidence back after tests.
- Final independent review checks the actual diff and recorded outcomes. A documentation-only preparation has no runtime behavioral delta; regression TDD is unnecessary unless a concrete bug is found.

Remaining mandatory gates: open the issue after publication approval; reviewed .283/.322 matrix and full accepted run on one gate commit; aligned SDK/CLI Orchestra pin change with tests and independent review; authorized Orchestra release; separately reviewed exact Orchestra + SDK Polygram update; authorized staging and **at least 24h SDK staging soak**, then coordinated VPS activation and **24h CLI soak**. Watch `autosteer-match-miss`, `autonomous-wakeup-message`, and `tool-only-completion`. No local result waives either soak.

## Results and review receipts

Independent spec review receipts (built-in, one-shot, read-only): `spec_compatibility` CLEAN; `spec_scope` CLEAN; `spec_isolation` CLEAN after fixing non-temporary HOME and denying actual Keychain Mach services. The latter verified the correction against native lookup preflights, rather than trusting a daemon label. Compatibility review also singled out .321's queued-subagent empty results for explicit later investigation.

Research/evidence directory: `/tmp/orchestra-claude-upgrade-research-3agLJs` (mode 0700). Exact source and driver hashes are in `source-hashes.json`; commands and allowlisted fixture environments are in `local-check-results.json` and `focused-units-result.json`. Local harnesses are disposable evidence, not new checked gates or production implementation. No parent checkout was modified; the related child described above was created during followup.

| Verification reached | Actual result |
| --- | --- |
| Isolated focused Orchestra baseline tests | 250 passed; 0 failed/skipped, covering pin/vendoring, SDK process, CLI process, hooks, log tail and startup gate. Node 26.5.0; unchanged SDK 0.3.283. |
| Native SDK loopback SSE fixtures | Six PASS: successful one-turn reply and local-500 StopFailure for old pair, constant old SDK + candidate CLI, and candidate pair. No real inference. This is supplemental transport evidence, not the mandatory SDK matrix. |
| Sandbox preflight | External IP connect denied EPERM; loopback HTTP allowed; `security` execution and Keychain file access denied EPERM; SecurityServer/securityd.xpc/securityd.general lookups denied BOOTSTRAP_NOT_PRIVILEGED (1100). |
| Native version/help | Both exact versions attest; `--system-prompt-snapshot`, `--agent`, `--effort`, `--settings` still advertised. Flag existence proves no behavior. |
| Matrix planning functions only | Current checked manifest schedules 22 runs with two declared old-version opt-in waivers. Changing the in-memory pair to .283/.322 fails closed: no .322 expectations. No matrix driver or provider invoked. |
| Checked CLI API-error stub | BLOCKED, not PASS. With synthetic consent, .283 reaches readiness but Channels are unavailable, makes no `/v1/messages` call, then delivery disconnects. .322 stops at bypass consent when user settings are excluded. Remaining inject/followup, three-inject, flaky, subagent, interrupt, 401 and fold modes were not run after this prerequisite failed. |
| Checked mailbox stub | BLOCKED, not PASS. Initial attempts exposed Node ABI and IPC path-length setup errors; these were corrected locally with existing Node 24.4.0 and short non-temporary fixture HOME. .283 then starts both roles but disconnects before message delivery; .322 stops at the bypass-consent dialog. No parent native dependency rebuilt. |

Fixture corrections were recorded, not hidden: explicit CLAUDE_CONFIG_DIR originally put onboarding config at the wrong path; removing it fixed theme onboarding. Node 26 cannot load the parent's Node-24 better-sqlite3 binary, so mailbox uses the already installed Node 24. Long fixture paths exceed Polygram's 103-byte socket limit, so final mailbox homes use `/Users/ivanshumkov/.local/share/ocg/h-*`. The first supplemental SDK failure oracle wrongly assumed a non-success subtype: both versions emit `subtype: success, is_error: true`, fire StopFailure, then SDK iteration throws. The corrected supplemental probe asserts `is_error`, StopFailure and the SDK exception, and records the success subtype; initial results remain in the evidence directory. No candidate-only SDK transport difference was observed in these six simple probes.

The candidate consent result is consistent with the .314 release-note fix that settings excluded by `--setting-sources` no longer supply saved consent. Its bytes show consent migration to user `skipDangerousModePermissionPrompt`, and the stub driver explicitly excludes user settings. A clean fixture needs explicit synthetic consent in an included local/flag settings source; no adapter change or production consent migration is justified by this preparation. Missing feature enrollment is a separate blocker even after consent. Neither blocker was bypassed with real account caches or credentials.

Preserved old binary: `/Users/ivanshumkov/.local/share/orchestra-upgrade-preservation/claude-2.1.283-to-2.1.322-darwin-arm64/claude-2.1.283`; 225036032 bytes; SHA-256 `d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`; executable mode 0700; version `2.1.283 (Claude Code)`. Source was the parent's SDK platform package. Its neighboring `old-binary-attestation.json` and final `old-preservation-readback.json` independently record the same version/hash. This is a Mac arm64 preservation; Linux VPS rollback binaries still need preservation on those hosts before activation.

Candidate downloaded from `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.322` official npm tarball with registry SHA-512 integrity verified: 323702464 bytes; SHA-256 `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450`; version `2.1.322 (Claude Code)`; path `/tmp/orchestra-claude-upgrade-research-3agLJs/candidate/package/claude`. The temporary new SDK metadata also reads exactly 0.3.322 / 2.1.322. Neither executable was installed in a production vendor tree.

The six supplemental SDK checks call the public SDK directly. They do not exercise Orchestra's SdkProcess pending queue, queued subagent result batching, resume, compaction, provider task behavior or the full SDK matrix.

Outcome: preparation only. No runtime code or version pin changed, and no verified lifecycle correction is ready to integrate. All mandatory paid matrix, opened issue, release, consumer review, persistence, activation and both 24h soak gates remain open. The exact bounded next-call request is in `docs/CLAUDE_2_1_322_PROVIDER_GATE_REQUEST.md`; the final report is `/tmp/orchestra-claude-upgrade-report.md`.

Final independent diff/evidence review: `spec_isolation` CLEAN; `spec_compatibility` CLEAN after correcting assertion-versus-observation wording; `spec_scope` CLEAN after making the pending provisional-hypothesis bootstrap explicit before any discovery invocation. Reviewers examined the actual three-document diff and local evidence read-only. This initial review covered documents only. The followup adds independently reviewed gate-fixture source changes in the related child; production runtime remains unchanged and candidate compatibility remains unproven.
