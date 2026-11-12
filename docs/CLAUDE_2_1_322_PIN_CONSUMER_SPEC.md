# Aligned Claude .322 pins and consumer handoff

## Current release integration — 2026-11-12

Published Codex Orchestra0.12.0 base706dab133bb2c696d34a950d8bdd4eebc22f02f5
is integrated by signed merge e086896 without conflicts or manual source changes.
All21upstream non-package changed files match that released base byte-for-byte;
accepted Claude SDK runtime SHA remains unchanged. Prepared aligned pin commit
f9ef1b8 follows bounded fix0664a00. Fresh main/npm showed0.12.0, so patch0.12.1
is selected for the reviewed correction and Claude SDK0.3.322/CLI2.1.322 pair.
The Orchestra publication hold has ended; PR/CI/OIDC release and exact registry
artifact verification are authorized and in progress. No deployment is performed.
Polygram consumer merge/version/publication remains held until coordinator supplies
its released0.46.0 base, then requires actual0.12.1 consumer artifact validation.
The accepted matrix23/23, existing runtime/focused receipts and strict focused
INCONCLUSIVE limits remain unchanged; no provider repeat or new gate is needed.
The coordinator owns staging and both mandatory24hsoaks. Earlier integration-hold
statements below are historical and superseded by this checkpoint.


Status: implemented local pin preparation, independently reviewed CLEAN;
release version/tag/main integration held for published Codex base.
Tracking issue [Polygram #133](https://github.com/shumkov/polygram/issues/133)
is OPEN, complete body verified by authoritative readback. The full matched
matrix m-6cce-a passed 23/23 on signed gate 6cceb3b. Correction signed commit
0664a00dea8b1b4fd1f8c3ff803683171b2c69d8 has the exact tested runtime. No new
provider calls or changes to accepted coverage are needed. Codex independently
reserves Orchestra 0.12.0; no Claude release version, tag or integration is chosen.

## Research and chosen change

Official SDK release v0.3.322 and CLI release v2.1.322 are non-prerelease releases;
SDK package metadata fixes claudeCodeVersion to 2.1.322. These are the pair already
validated, not an unverified new latest. The npm latest/next tags observed at
research time point to .322 while CLI stable points to .311; no channel switch.
SDK .322 requires Node >=18.14.0, Anthropic SDK >=0.93.0, MCP SDK ^1.29.0 and
Zod ^4.0.0. Orchestra Node >=22 and current dependencies satisfy these constraints.
Evidence: official registry package metadata retained with the candidate SDK,
release links in CLAUDE_2_1_322_UPGRADE_SPEC.md, and actual per-side loaded SDK
identity proofs in the matched matrix. No extra peer upgrades are necessary.

lib/claude-bin.js owns the CLI constant. Its resolver/vendors accept explicit
versions and tests use disposable vendor/versions trees. tests/claude-bin.test.js
asserts both exact CLI pin and installed SDK metadata equality. package.json
optionalDependencies owns the SDK pin; lockfile v3 currently repeats it in the
root dependency/optional maps, SDK node and eight platform nodes. npm must
regenerate lock metadata from the exact official .322 package, including all
platforms, with lifecycle scripts disabled. Inspect and reject unrelated drift.
Do not hand-invent integrity values or update Anthropic SDK, MCP, Zod or Codex.

Move only SDK exact 0.3.283 -> 0.3.322 and CLI exact 2.1.283 -> 2.1.322, the pin
assertion and npm-generated corresponding lock metadata. Keep Orchestra package
version 0.11.3 as unreleased branch metadata until coordinator provides published
Codex base/version and coordinates subsequent release integration. Do not publish
this branch with that old version. Use npm install --ignore-scripts --save-optional
--save-exact @anthropic-ai/claude-agent-sdk@0.3.322 only in this owned worktree.
No installer, user settings, authentication or production tree is touched.

## Separately reviewable Polygram update

The owned related child is /Users/ivanshumkov/orca/workspaces/polygram/claude-322-gates.
Its package.json dependencies pin Orchestra 0.11.3 and SDK 0.3.283. The contract in
tests/orchestra-dependency-contract.test.js currently requires the exact installed
Orchestra version, matching declared SDK pins and lock entries, no nested SDK
lock entry, and existing Codex capabilities. It does not yet verify actual SDK
metadata or shared physical module resolution. Extend that existing contract now
without moving consumer dependencies: read the root-installed SDK package via
its resolved entry, require its version to equal the exact declared SDK version
and its claudeCodeVersion to equal installed Orchestra
claudeBin.CLAUDE_CLI_PINNED_VERSION, and compare realpath of root SDK entry with
createRequire(require.resolve('@shumkov/orchestra')).resolve(sdk). This generic
alignment check passes for the currently shipped .283 pair and later verifies
.322 when its actual artifact is consumed; it does not fabricate a .322 install. A consumer-only SDK bump while retaining Orchestra 0.11.3 is
an inconsistent shipped pair and is rejected. A file: tarball masquerading as a
registry release or invented integrity is also rejected. The alternative of
waiting to prepare everything wastes safe independent work; prepare Orchestra's
reviewed pin now, retain this concrete consumer change plan, and defer applying
both consumer dependencies until the real subsequent Claude Orchestra artifact
exists. No fake placeholder goes into executable package metadata.

After coordinator supplies the published Codex base and coordinates the Claude
release, the separate consumer change updates package.json SDK to exactly
0.3.322 AND Orchestra to that actual published Claude release version, updates
REQUIRED_ORCHESTRA_VERSION in the contract test, and npm-regenerates package-lock
with --ignore-scripts. Inspect exact registry URL/integrity and all SDK platform
versions, ensure a single hoisted .322 SDK and preserve Codex capabilities. Do
not choose that release number here. Review the actual dependency/lock consumer diff separately, requiring installed
SDK version 0.3.322, CLI metadata 2.1.322 and shared physical SDK resolution,
and run orchestra-dependency-contract plus directly affected consumer SDK tests
in the owned child before integration. The generic installed-identity consumer test and plan can be reviewed now;
final artifact-backed dependency diff review/test remains a concrete dependency.

## Verification and failure modes

Retain old and candidate offline binaries/version/SHA outside updater/vendor GC.
The current child matrix's old SDK resolution and historical artifacts must not
be mutated by the consumer update before preserving its .283 tree with hashes.
This pin install changes only Orchestra's own node_modules; the matched matrix
old SDK tree in the Polygram child remains untouched. Compare installed candidate
entry/package/binary SHA to the already accepted .322 source and preserved binary.
Run claude-bin, SDK process manager, ownership, generic-manager/process-contract
and workflow completion tests under credential-free isolated HOME/CODEX_HOME,
TMP, tmux, vendor and versions, disabled installer/updater. The full corrected
runtime suite already passed 1560/19 existing skips before the metadata change;
new focused tests verify the installed .322 pair and pin/lock coherence. Report
all skips; no paid matrix repeat for this pin-only change. Independent code review
must inspect lock scope, metadata alignment, isolation and retained limitations.

Authorization covers publication and planned activation, but this worker holds
version/tag/main integration until published Codex base and does not deploy.
After exact release/consumer validation: at least 24h SDK staging on shumorobot,
then coordinated VPS deployment and 24h CLI soak, preserving host-specific Linux
rollback binary before VPS vendor GC. Watch autosteer-match-miss,
autonomous-wakeup-message and tool-only-completion per Polygram AGENTS.md.
Neither local tests nor matrix replace these soaks. Strict focused traces remain
INCONCLUSIVE; actual downstream delivery and every overlap schedule are unproven.

Design review correction: compatibility review identified that the old consumer
contract checked lock/declarations only. The amendment above adds actual installed
metadata/resolution readback to the existing alignment test, without changing
product behavior, introducing another provider gate or inventing an artifact.

## Local completion receipt

Issue133 exact title/body/state readback verified. Signed bounded runtime fix:
0664a00dea8b1b4fd1f8c3ff803683171b2c69d8 (valid signature). The four pin files
are prepared locally; package version is deliberately unchanged and no release
is published. npm regenerated only root and nine SDK-family package entries;
it also removed the old redundant root dependencies entry for Anthropic SDK,
whose optional exact0.128.0 and installed lock node are unchanged. Installed
.322 SDK entry/package/binary hashes match the accepted matched-pair identities.
The Polygram child's old SDK tree remains unchanged. Three independent design
and code reviewers returned CLEAN after the actual-installed-identity amendment.

After pin install: six focused local test files, 444 tests /425 PASS /0 FAIL /
19 existing capability-N/A skips /0 cancelled, exit0,10.892s. Consumer identity
contract:3PASS/0FAIL/0SKIP on the current .283 dependencies, not a future .322
artifact proof. Full runtime suite already passed before the metadata-only pin
change; no provider matrix was repeated. Exact private logs, installed hashes,
review receipts and invocation environments are retained under
/tmp/orchestra-claude-upgrade-research-3agLJs (publication-pin-review-receipts.md,
pin-installed-source-attestation.json, pin-sdk-focused.json and
pin-consumer-current-pair-contract.json). The concrete remaining dependency is
the actual subsequent Claude Orchestra release after Codex publication, then
separately reviewed exact consumer dependency/lock changes and mandatory soaks.

## Published-base integration and patch release amendment

Coordinator supplied published Orchestra 0.12.0 main/tag base
706dab133bb2c696d34a950d8bdd4eebc22f02f5 (release434e230, PR70). Fresh origin
fetch, authoritative main API and npm versions/latest readback all agree at
0.12.0, with no0.12.1 published. Choose0.12.1: this is the bounded SDK response
ownership correction and aligned runtime upgrade, without public interface change.
It preserves the already released Codex0.167.2/trusted-policy/runtime-companion
features. The release hold ends for Orchestra only; Polygram Codex0.46.0 is still
in CI and the child consumer merge/version/publication remains held for that
actual published base. No deployment; coordinator owns both required soaks.

Preserve the current reviewed pin/doc preparation with a signed logical commit,
then merge the exact published base into this owned feature branch using a signed
merge, without rewriting either history or discarding uncommitted work. Upstream
changes touch Codex implementations/tests/fixtures, factory trusted policy and
package root versions only; no upstream SDK-process runtime change. Expected
package merge is old version0.11.3 -> published0.12.0 while retaining new exact
SDK/CLI .322. Resolve only actual conflicts, compare every Codex code/pin/feature
file byte-for-byte to the released base, and independently review real integration
deltas. Keep the accepted SDK runtime SHA unchanged; no paid/provider loop.
Alternative cherry-pick onto a fresh branch would duplicate already preserved
reviewed history and is unnecessary; direct main edits bypass the PR gate.

After integration, record the patch version0.12.1 in package.json and both lock
root versions, signed as its own release commit. Update current status docs to
supersede the earlier published-base hold; do not relabel strict INCONCLUSIVE or
failed matrix evidence. Run the full local unit/integration suite once on the
combined final tree under the established credential-free synthetic environment,
including new released Codex tests, and keep existing matrix/focused evidence
where exact source inputs remain unchanged. Independent final code review checks
source equality, metadata and retained evidence before push/PR. Publish a normal
PR against main with concise bounded evidence/limitations, await CI, merge only
that reviewed head, read back exact merged main commit, create/push a signed tag
v0.12.1 on that main commit, and use existing Release workflow OIDC publication
only. Do not use local npm publish or change release workflows.

Verify GitHub workflow success, authoritative tag/main/release, npm registry
version/integrity, fetch the exact published tarball read-only and compare EVERY
published package file to the merged source. Verify installed metadata/binary
source in an isolated package extraction without real inference. If CI/release
fails, classify and correct only the actual cause before another mutation; do
not duplicate ambiguous publication. The tracking issue stays open for consumer
integration and both24hsoaks. Prepare/sign child installed-identity/test/status
work and concrete dependency update with actual0.12.1 artifact when available,
but do not integrate Polygram main/version/release before coordinator supplies
released0.46.0 base; no parent branch edits or deployment.
