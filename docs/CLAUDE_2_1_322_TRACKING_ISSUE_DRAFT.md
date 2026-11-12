# Tracking issue draft — NOT PUBLISHED

Title: bump claude CLI v2.1.283 → v2.1.322

Upgrade Orchestra's exact Agent SDK 0.3.283 / Claude CLI 2.1.283 pair to the evaluated candidate SDK 0.3.322 / CLI 2.1.322 only after the compatibility procedure in Polygram's AGENTS.md passes. Registry metadata says SDK 0.3.322 bundles `claudeCodeVersion: 2.1.322`; both official GitHub releases are non-prereleases. CLI npm `latest` is .322 while its conservative `stable` dist-tag remains .311. The target is a candidate, not an approved pin.

Official release notes: https://github.com/anthropics/claude-code/releases/tag/v2.1.322 and https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.322. Review the full range after .283, particularly queue/fold/interrupt/paste, hook timing, task attribution/order, SDK result batching, MCP background tasks, permission defaults and strict resume/snapshot behavior.

- [ ] Publish this issue with Ivan's explicit go; record its real URL before pin movement.
- [ ] Preserve and SHA-attest old host binary outside all updater/vendor GC trees; attest exact candidate.
- [ ] Review new version expectations without unexplained lifecycle normalization or inherited waivers.
- [ ] Run old .283 and candidate .322 checked matrix on one immutable gate commit, holding SDK constant; accept complete authoritative evidence.
- [ ] Pass API-error local stub and mailbox stub gates on both binaries; explain blocked or changed behavior.
- [ ] Update Orchestra exact SDK and CLI pin together, test actual SDK .322 pair, obtain independent code review, and document full release-note delta and any adapter corrections.
- [ ] Release Orchestra only after publication approval.
- [ ] Review Polygram's separate exact Orchestra + SDK consumer update and verify persistence from authoritative state.
- [ ] Stage on shumorobot for at least 24h; no CLI claim from this SDK staging soak.
- [ ] Activate shared VPS install and vendor directory together only when authorized, then run 24h CLI soak while checking autosteer-match-miss, autonomous-wakeup-message and tool-only-completion.

Related local design: `docs/CLAUDE_2_1_322_UPGRADE_SPEC.md`. This document is a local draft and does not satisfy the opened-tracking-issue requirement. Production pins, release, activation and both soak gates remain pending.
