# Orchestra 0.12.1 Claude runtime compatibility release

The .322 SDK/CLI pair upgrades Claude while preserving one normal user request's
response ownership when auto-mode reports and queued requests overlap. Normal
sends serialize under the existing completion contract; UUID/origin ownership
prevents unrelated reports from consuming pending users. Intentional steering,
injection, autonomous report output and cancellation/drop semantics remain.

Tracking issue: https://github.com/shumkov/polygram/issues/133 (published and
complete title/body/state read back). SDK0.3.283 ->0.3.322 and bundled
claudeCodeVersion/CLI2.1.283 ->2.1.322 align exactly. Both official .322 releases
are non-prerelease. Research distinguished latest/next .322 from conservative
CLI stable .311; this release uses the tested .322 pair, without a channel claim.
Release-note changes relevant to compatibility include queued report batching,
notification/membership ordering, MCP background tasks and initialization hooks.

## Released Codex base and bounded source

Published0.12.0 base706dab133bb2c696d34a950d8bdd4eebc22f02f5 is integrated without
conflict or manual resolution. All21upstream non-package changed files match
that release byte-for-byte, including Codex0.167.2/trusted policy/runtime companion
and associated tests/fixtures. Both CI/release workflows remain unchanged.
Ownership fix0664a00, aligned pin commitf9ef1b8 and integration mergee086896 are
signed. SDK runtime source SHA256 remains
c6f61a85acd139a0c524a7726dc5eead02be34480305bcd3fbdde32005c72184.
No Codex pin/feature change is part of this patch. Fresh registry/main both at
0.12.0 justified selecting the next patch0.12.1; release publication follows PR,
CI, merged-main readback and the existing tag-triggered npm OIDC workflow only.

## Verification

- Accepted actual SDK.283/CLI.283 versus SDK.322/CLI.322 full checked matched
  matrix23/23 on signed source6cceb3b3544f4efc74330c82f0557d7f1bfb31d6.
  Manifest SHA25663bcf4e6f018bcbf689240a472328b73e1ee265af58a4cc7c3175d8320b8e817.
  Existing old-only opt-in waiver remains explicit; no candidate waiver added.
- Retained-shape ownership regression:2FAILbefore correction ->2PASSafter,
  with additional cancellation/drop/timeout/late-frame red/green evidence.
- Before integration: full corrected runtime1560PASS/19existing skips;
  installed-.322 focused425PASS/19existing skips. Installed candidate SDK entry,
  package and binary hashes match accepted matrix identities.
- After integration and patch metadata: complete36-file local unit/integration
  suite1633tests,1614PASS,0FAIL,19existing skips,0cancelled,105.608s,exit0 on
  Node24.4.0. Skips17channels-protocolN/A and2Codex-capabilityN/A, no SDK skip.
  Credential-free synthetic HOME/CODEX_HOME/TMP/tmux/vendor/versions, installer
  disabled; fake/local fixtures only, no new provider calls.
- Three independent design reviews and three final integration code reviews
  returned CLEAN; no unresolved findings. All21Codex changed files and workflows
  retain released bytes, so the unchanged SDK matrix source evidence is reused.

Strict focused provider traces remain INCONCLUSIVE. All three distinct UUID-owned
user completions were observed on both actual pairs, with observed peer/zero
terminals preserving pending users. Unsupported standalone-report/notification-
before-zero assumptions and denied overlap holds are explicitly limited coverage,
not another release gate. Downstream delivery and every overlap schedule remain
unproven. No trace was relabelled PASS; prior crossed-pair and runner-blocked
matrix failures remain separate immutable evidence. No new provider loop is needed.

## Publication and consumer boundary

The tracking issue stays open through the separate aligned Polygram dependency
update and both mandatory soaks. Offline Darwin-arm64 baseline/candidate binaries
remain outside updater/vendor GC, with verified versions/SHA/size; preserve the
Linux rollback binary similarly before VPS vendor GC. No deployment occurs here.
Coordinator owns at least24hSDKstaging on shumorobot followed by coordinated VPS
rollout and24hCLIsoak, observing autosteer-match-miss, autonomous-wakeup-message
and tool-only-completion. No test count replaces either soak.

The owned consumer branch has the reviewed installed-SDK metadata/shared-resolution
contract,3/3PASSon its current.283pair. Consumer merge/version/publication waits
for coordinator-supplied released Polygram0.46.0 base and then exact published
Orchestra0.12.1 + SDK0.3.322 artifact-backed dependency/lock review and checks.
No placeholder artifact or partial SDK-only consumer bump is accepted.
