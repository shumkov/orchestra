# Deterministic local stub tools

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


## Publication and integration checkpoint — 2026-11-12

Ivan authorized publication and planned rollout. Tracking issue
[Polygram #133](https://github.com/shumkov/polygram/issues/133) is OPEN; its complete
body was authoritatively read back and verified. The accepted matched matrix
remains 23/23 on signed gate 6cceb3b. Bounded runtime correction is signed commit
0664a00dea8b1b4fd1f8c3ff803683171b2c69d8, preserving its exact tested source.
Local SDK 0.3.322 / CLI 2.1.322 pins and generated lock metadata are now prepared
and independently reviewed CLEAN by compatibility, isolation and scope reviewers.
Installed candidate entry/package/binary hashes equal the accepted matrix pair.
Focused local checks: 425 PASS, 0 FAIL, 19 existing capability skips; full corrected
runtime suite before the pin metadata change: 1,560 PASS, 19 existing skips.
No new provider call was made. Strict focused traces remain INCONCLUSIVE within
the accepted limits and no extra provider loop is mandatory.

Codex owns Orchestra 0.12.0. Claude release version/tag/main integration waits
for its authoritative published base; this worker does not deploy. Orchestra's
package version remains 0.11.3 only as unreleased branch metadata, never a release
claim. Consumer dependencies remain the coherent .283 pair until the actual
subsequent Claude Orchestra artifact exists. The existing consumer contract now
also verifies installed SDK/CLI metadata and shared physical SDK resolution;
3/3 checks pass on that current .283 installation. Artifact-backed .322 consumer
update and independent diff review, Linux rollback preservation and both 24-hour
soaks remain. Earlier authorization/pin-status statements below describe their
historical checkpoints and are superseded by this section.


The guarded native-auth fixtures now reach Channels and loopback model requests
on both versions. fail and401 pass both. Flaky recovery passes old; candidate
returns the fixture's fallback "ok" with tools15/has_reply_tool=false, instead of
receiving the scripted reply tool, so the recovered-reply assertion fails. This
is a definite fixture-protocol mismatch, not proof of provider/adapter failure.
The original failed trace stays immutable. Actual real-provider CLI contract
observations pass candidate reply delivery without changing tool search.

Official docs explain the change: tool search is enabled behind a gateway by
default since2.1.304; before then it was disabled unless explicitly enabled.
ENABLE_TOOL_SEARCH=false loads all tools upfront. Sources:
https://code.claude.com/docs/en/mcp#tool-search-through-an-llm-gateway
https://code.claude.com/docs/en/env-vars.md . This matches old33 vs candidate15
tools and the missing reply tool, but must still be tested, not assumed.

Use a separate private controller derivative for LOCAL model stubs only, adding
one allowlisted environment constant ENABLE_TOOL_SEARCH=false. Do not change
checked drivers, runtime, full-matrix environment, OAuth/Channels controls or
oracles. Keep all credentials native inside owned synthetic HOME and exact
loopback endpoint; preserve default controller/failed receipts. Mailbox real mode
remains refused before auth read. Controller's explicit allowlist may include
existing fold/subagent, inject-count, interrupt-after and agent selectors for the
README-mandated local cases; unknown/duplicate/real options remain rejected.

This tests API-error/retry/queue/IPC plumbing with deterministic eager tool
registration. It does not establish default deferred-tool discovery compatibility;
that remains covered only by applicable unchanged real-provider cells. Implementing
a mock ToolSearch protocol was rejected as unnecessary fixture complexity. A
blanket runtime setting or feature-success override was rejected because that
would hide the default protocol behavior. No feature cache/flag enrollment is
forged, and no new proxy or metering infrastructure is introduced.

Validation is red-to-green against the concrete native-candidate-api-flaky-a
retained FAIL: repeat only after changed supported context, require actual local
requests to carry reply tool, recover after exactly scripted failures and deliver
one bridge reply with no StopFailure. Compare old the same way, then execute
README local cases and mailbox with their existing deadlines. If the different
tool setting does not restore the request contract, stop and investigate rather
than relaxing the oracle. All outcomes remain supplemental local fixtures;
no count replaces the mandatory full old/new acceptance matrix or either soak.


The candidate eager flaky observation now passes (eager-candidate-api-flaky-a):
actual streaming requests carry33tools with the reply tool, two scripted500s
recover to200, one bridge reply arrives, StopFailure absent. Same controller old
flaky passes. This is the retained red-to-green fixture proof; no checked-source
change or production tool setting was needed. The initial mailbox attempts in
the child failed before any model turn because its installed12.10.0SQLite native
binding was missing. npm rebuild better-sqlite3 in the child only restored its
own matching Node24/ABI137 binding, with in-memory SELECT1 proof and SHA recorded;
parent's different12.11.1 package was not copied or changed. Old mailbox then
passes7/7 under defaults; candidate default returns no ask, consistent with the
missing reply/IPC tool schema. Eager mailbox passes7/7 on both versions. The mandatory inject/followup, three-injection, subagent, interrupt and fold-mode checks also PASS both; original failures remain retained.
