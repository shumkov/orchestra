# Tracking issue draft — NOT PUBLISHED

## Publication and integration checkpoint — 2026-11-12

Ivan authorized publication and planned rollout. Tracking issue
[Polygram #133](https://github.com/shumkov/polygram/issues/133) is OPEN; the
published title and complete body were read back and verified against the prepared
body. The issue prerequisite and full matched matrix prerequisite are satisfied.
The bounded correction is accepted with the retained limits below. Codex owns
Orchestra 0.12.0; this worker must wait for its authoritative published base before
Claude release version selection, tags or main integration. No deployment is
performed here. The separately reviewed aligned pin/consumer preparation and both
24-hour soaks remain; strict focused traces stay INCONCLUSIVE and require no new
provider loop. Earlier authorization/pin-status statements below describe their
historical checkpoints and are superseded by this section.


Title: bump claude CLI v2.1.283 → v2.1.322

Upgrade Orchestra's exact Agent SDK 0.3.283 / Claude CLI 2.1.283 pair to the evaluated candidate SDK 0.3.322 / CLI 2.1.322 only after the compatibility procedure in Polygram's AGENTS.md passes. Registry metadata says SDK 0.3.322 bundles `claudeCodeVersion: 2.1.322`; both official GitHub releases are non-prereleases. CLI npm `latest` is .322 while its conservative `stable` dist-tag remains .311. The target is a candidate, not an approved pin.

Official release notes: https://github.com/anthropics/claude-code/releases/tag/v2.1.322 and https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.322. Review the full range after .283, particularly queue/fold/interrupt/paste, hook timing, task attribution/order, SDK result batching, MCP background tasks, permission defaults and strict resume/snapshot behavior.

- [ ] Publish this issue with Ivan's explicit go; record its real URL before pin movement.
- [x] Preserve and SHA-attest old Mac arm64 binary outside updater/vendor GC trees; attest exact candidate.
- [ ] Preserve Linux host rollback binaries before any VPS activation.
- [x] Independently review exact matched-pair version expectations without unexplained lifecycle normalization or new candidate waivers.
- [x] Run actual SDK .283/CLI .283 and SDK .322/CLI .322 checked matrix on one recorded gate commit; signed 6cceb3b, complete authoritative m-6cce-a 23/23 PASS.
- [x] Pass API-error and mailbox local stubs on both binaries with guarded native auth and eager tools for deterministic scripting; preserve default deferred-tool fixture failures and explain the boundary.
- [x] Accept the bounded ownership/cancellation correction on the full matched matrix, observed UUID-owned completions and peer/zero ownership preservation, retained-shape RED/GREEN and independent clean reviews; the coordinator explicitly accepts limited coverage. Strict focused traces remain INCONCLUSIVE without creating another release gate or provider loop; downstream delivery and every overlap schedule are unproven.
- [ ] Update Orchestra exact SDK and CLI pin together, test actual SDK .322 pair, obtain independent code review, and document full release-note delta and any adapter corrections.
- [ ] Release Orchestra only after publication approval.
- [ ] Review Polygram's separate exact Orchestra + SDK consumer update and verify persistence from authoritative state.
- [ ] Stage on shumorobot for at least 24h; no CLI claim from this SDK staging soak.
- [ ] Activate shared VPS install and vendor directory together only when authorized, then run 24h CLI soak while checking autosteer-match-miss, autonomous-wakeup-message and tool-only-completion.

## Coordinator acceptance and retained limits

The coordinator accepts this bounded ownership correction on the completed
23/23 matched matrix, all three distinct UUID-owned user completions observed on
both actual SDK/CLI pairs, observed peer/zero events preserving pending owners,
reviewed retained-shape RED 2 FAIL -> GREEN 2 PASS, the cancellation/drop
regressions, and independent clean code reviews. The former strict focused
oracle required unsupported standalone-report/notification-before-zero behavior
and its overlap holds were denied. Its INCONCLUSIVE verdicts remain unchanged;
those extra assumptions are not a release gate. No new live scheduling fixture,
provider query, or instrumentation loop is required or planned for this correction.
This accepts explicitly limited coverage; downstream delivery and every overlap
schedule remain unproven. Tracking-issue publication remains the explicit pre-pin
prerequisite, and pin/consumer reviews, release/activation authority, staging and
both 24-hour soaks remain. No runtime or package pin changes are made here.

## Final full unit/integration verification

Ran the complete package test command once on the final corrected runtime with
Node 24.4.0: `node --test --test-force-exit --test-concurrency=1 tests/*.test.js`.
All 34 test files completed: 1,579 tests, 1,560 PASS, 0 FAIL, 19 existing contract
capability-N/A skips (17 channels-protocol, 2 Codex-capability), 0 cancelled.
Duration 103.370 seconds, exit 0. Runtime SHA-256 remains
`c6f61a85acd139a0c524a7726dc5eead02be34480305bcd3fbdde32005c72184`.
HOME/CODEX_HOME/TMP/tmux/vendor/versions were private synthetic trees, with an
allowlisted credential-free environment and disabled installer/updater. The suite
uses fake processes/bridges and local fixtures; no paid queries were repeated.
No failures required code changes. This is unit/integration proof, not additional
provider, downstream delivery, persistence, activation or soak proof. Full log,
command, times and per-skip receipts:
`/tmp/orchestra-claude-upgrade-research-3agLJs/compatibility-acceptance-full-suite/`.



Related local design: `docs/CLAUDE_2_1_322_UPGRADE_SPEC.md`. This document is a local draft and does not satisfy the opened-tracking-issue requirement. Production pins, release, activation and both soak gates remain pending.


Historical verification receipt before the correction (not an opened issue): signed gate commit
`b796ec57a010edc092a9e03a287a00870dbb891d` full matrix FAILS: 14 PASS, one candidate
background MCP failure, eight not run after failure. Those eight later PASS as
supplemental filtered observations on the same commit, after short IDs fix two
definite fixture path lookups; this cannot be assembled into full acceptance.
Actual-new-SDK .322 core five checks PASS, while focused auto attribution fails
on both actual pairs. Actual-new-SDK background MCP completes task and marker
but notification precedes membership removal and two terminal results violate
the checked strict contract. Runtime pins remain unchanged. Private local report:
`/tmp/orchestra-claude-upgrade-provider-report.md`.

Current local verification receipt (still NOT an opened issue): signed matched gate
`6cceb3b3544f4efc74330c82f0557d7f1bfb31d6`, complete authoritative
`m-6cce-a`23/23PASS, exact old/newSDKload/runtimehash receipts retained. Runtime
correction has independent CLEAN reviews and RED/GREEN regressions; focused
provider fixture remains INCONCLUSIVE, with denied holds and downstream coverage
limitations explicit. Pins remain .283; no release/activation/soak occurred.
Current report: `/tmp/orchestra-claude-ownership-correction-report.md`.
