# Deterministic local stub tools

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
