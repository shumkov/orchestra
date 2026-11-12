# SDK pending attribution compatibility correction

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


Status: bounded correction accepted by the coordinator within the limits below.
Full matched matrix PASS 23/23; retained strict focused probes INCONCLUSIVE.
Pins remain SDK 0.3.283 / CLI 2.1.283; no publication or activation authorized.

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


## Evidence and current callers

The reviewed focused streaming-input fixture ran real SdkProcess in auto mode
with actual SDK/CLI .322 and the old actual SDK/CLI .283 pair, in isolated
existing-account contexts. Both combined three synthetic normal send prompts
into the first response, then routed autonomous report results to later user
pendings. Candidate additionally emitted the documented success empty result
with num_turns:0, consuming pending source 3. The first two task_started events
in the candidate trace are direct background local_agent depth1 tasks. Later
Bash task events are excluded by the corrected observer; do not rewrite the
original evidence artifact. No claim that .321 introduced prompt coalescing.

Private traces: /tmp/orchestra-claude-upgrade-research-3agLJs/new-sdk-pending-a-artifacts/new-sdk-pending-a
and old-sdk-pending-a-artifacts/old-sdk-pending-a. The new SDK changelog .321
explicitly describes queued auto-mode reports sharing a model call, with an
empty zero-turn result for all but the last report. Both SDK declarations
already expose coalesced prompt correlation. Official source:
https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md .

SdkProcess.send eagerly pushes every queued prompt; _handleEvent selects the
FIFO head for all streams and pops it on every result. A peer-origin nonempty
report and task-notification empty result therefore complete unrelated user
work. Injection/steering intentionally enter an active turn; normal send and
those APIs must be considered separately. Blindly ignoring only empty results
leaves coalescing, nonempty report completion, and streamed-text attribution
incorrect. The five normal SDK matrix cells do not cover this concurrency.

## Reviewed correction candidate

The public Process.send contract is one user turn, one completion; the explicit
inject/steer APIs perform intentional folds. Serialize only normal sends: retain
queued prompts in pendingQueue and submit a prompt only on activation. Queue cap
still drops the oldest waiting pending, whose prompt must never enter SDK input.
Activation, timer and onActivate behavior remain tied to the active head. Do not
change auto mode or SDK query lifetime.

Stamp each normal submission with crypto.randomUUID(). On retry use a fresh UUID
and retire the failed attempt's UUID. Echo correlation is supported by BOTH pinned
and candidate binaries: the provider-free native SDK loopback discovery
/tmp/orchestra-claude-upgrade-research-3agLJs/sdk-uuid-discovery-results.json
observed first assistant + result user_message_uuid and user_message_uuids on
.283/.283, .283/.322, .322/.322, one inference request each against loopback only.
SDK declarations describe first top-level assistant/partial-frame correlation,
then result correlation; a batched turn may list multiple consumed UUIDs.

Associate assistant/stream events with the active pending only when a supplied
UUID matches that pending's current submission or intentional active injection.
Bind to the pending AND physical submission attempt, keeping that binding for
subsequent unannotated frames until any top-level result. Explicit conflicting
UUIDs replace/invalidate the binding before partial/thinking early returns.
Exclude child partials as well as child assistant frames.
Matching current owned UUIDs take precedence over retired siblings in a consumed
list, so a legitimate current folded response still completes. Retain cancelled-attempt UUIDs until Query closes; their late frames and
subsequent unannotated frames are suppressed rather than delivered as autonomous
user replies. A genuinely unowned first frame, or a frame without a binding after
the prior result, is autonomous and uses the existing autonomous-assistant-message event even
while user work waits. Ignore child assistant frames for this binding. Never
stream unowned output through the head's streamer, reactor or usage counters.
An unannotated success cannot complete a pending unless its turn was already
bound by an assistant/partial echo. Explicit unmatched UUID or non-human origin
without a matching UUID is autonomous, including nonempty peer reports and empty
zero-turn results. Matching owned UUID takes precedence over peer origin when
an intentional user injection folds into a synthetic report turn. A bare error without echo or an existing bound turn cannot complete a user
pending: SDK documents singular UUID echo even for delivery failures (only the
plural list may be omitted). Terminal iterator failure still fails the session
and rejects pending work through the existing session-failure path. Unknown uncorrelated success fails closed
(wait for matching response or existing timeout), rather than guessing ownership.

Stamp steer/inject submissions too, associate them with the current active head
without submitting waiting normal sends; preserve priorities/shouldQuery and
bubble behavior. A fireUserMessage has its own unowned UUID and stays fire-and-
forget, never consuming an unrelated normal pending. Standalone steer/inject
remains autonomous. No public method signature or result shape changes.

Retry/drop/timeout/interrupt/drain requirements: a retry submits only its active
head; queue drops match input UUID rather than removing arbitrary waiting work;
input push failures settle the right pending and activate its successor. Timed
out/drained submission UUIDs cannot settle new work. Clear binding on retry
retirement, timeout, drain, reset and close. Timers and rejection codes stay unchanged. Track the physical submitted normal
attempt separately from the logical pending queue. After timeout, wait for the
existing Query.interrupt control acknowledgment before submitting the successor;
a matching terminal result may retire the attempt but does not bypass an in-flight
interrupt acknowledgment. Read the supported interrupt receipt: intersect
still_queued with submitted owned UUIDs and keep a survivor barrier until each
has a correlated terminal result or proven cancellation. Unknown internal UUIDs
are ignored. An acknowledgment with no receipt is insufficient to retire a
submitted attempt: wait for its terminal result. Never invoke undocumented
cancelAsyncMessage or cancel unrelated autonomous task notifications. A rejected interrupt fails waiting work through the
session failure path rather than blindly resubmitting into uncertain state.
Drain stays synchronous and does not invent an interrupt: it removes logical
work and buffered input. If its submitted input already reached SDK, future normal
sends wait for that physical result OR a caller interrupt receipt proving no owned UUID survives. Thus interrupt+drain remains reusable; drain alone lets existing SDK
work finish without coalescing a successor. An input removed before SDK consumed
it needs no physical-turn barrier. onActivate/timers begin only on submission. interrupt continues to signal Query.interrupt; drain rejects all
queued work while leaving the session reusable. Remove any not-yet-yielded
owned input by UUID on rejection/drain; preserve makeInputController.close()
semantics for unrelated callers. Do not submit rejected waiting
prompts later. Retain existing first-stream/onActivate and autonomous delivery
callbacks, including legitimate report text while another request is pending.

Alternatives rejected: only skip zero-turn results (nonempty reports still
misroute); only correlate eager submissions (one user request could still merge
with another); disable auto or discard reports (changes product behavior);
buffer every user stream until result (unnecessary latency with verified echoes).
Public streaming for supported .283/.322 remains live. Missing correlation is
explicitly inconclusive instead of silently attaching text to a different user.

## Background MCP gate amendment candidate

The crossed old-SDK/new-CLI experiment remains FAIL and immutable. SDK .319 added
MCP-task support in SDK sessions; its absence in .283 may explain the failedtask
but exact transport cause is not proven. Shipped validation needs matched SDK/CLI
pairs with imported SDK identity + exact CLI identity attested before launch.
No production lib/ consumer in either repository reads membership/task edge
ordering; production does consume SDK results and remains subject to the separate
ownership correction above.

Official pinned SDK .292 changelog explicitly changes finishing membership to
AFTER task_updated and task_notification. The .322 type states snapshot-vs-edge
ordering unspecified. Current documented actual matched .322 trace has exactly
two successful, non-error results, the second a task-notification turn with
origin.runId equal to the task run_id. Results are per turn, not per Query.
Sources: https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.322/CHANGELOG.md#03292
and https://code.claude.com/docs/en/agent-sdk/typescript#sdkbackgroundtaskschangedmessage .

Proposed exact manifest-bound .322/.322 policy: retain every tool/task count,
identity, timing, marker uniqueness and membership list/clear check; require
completed update < completed notification < empty membership < marker. Correlate
nonempty run_id across membership/start/update/notification and followup result
origin.runId, with matching session. Require exactly two successful non-error
results: initial turn, then correlated task-notification completion after marker.
Unknown/missing SDK/CLI identity cannot select this policy. Keep the old pair's
existing policy and raw-source regeneration, reject every failed/stopped task,
extra/missing result, wrong run/session, duplicate marker/clear/notification and
mutated raw bytes. This is a documented version-specific oracle, not a waiver.

A gate implementation needs independent review of exact per-side SDK resolution.
Prefer literal matched-pair execution using an explicit Node resolution hook that
redirects ONLY the SDK package to predownloaded, integrity-verified exact SDK
roots, leaving the checked gate source identical on both sides; attest imported
SDK and its claudeCodeVersion. Alternative: stage two identical source prefixes
with different SDKs and attest every source hash; more copying and stale-source
risk. Holding SDK .322 constant on both sides is simpler but adds a second axis
to the old baseline and should be supplemental rather than relabeled matched.
The amended complete accepted matrix must pass on one recorded gate commit.
No gate runtime change is made until its resolution mechanism is independently
reviewed and the coordinator receives the exact proposed amendment.

## Verification and scope boundary

Retain the existing explicit peer-result and task-notification-result RED spike.
Add deterministic RED cases for queued prompt coalescing/overflow leakage, stream
ownership and stale UUIDs after timeout/drain. GREEN must cover owned echoes,
nonempty peer reports, zero-turn reports, matching folded injection, independent
fire-and-forget output, retries, input drop/failure, queue limits, timeouts and
interrupt/drain reuse. Update fake events to model genuine SDK echo fields rather
than weakening the runtime to satisfy metadata-free success fixtures. Tests for
missing correlation must remain explicit and prove no false user completion.

After independent design reviews, implement only this bounded runtime correction,
obtain independent code reviews, then run the corrected focused real-SDK fixture
on both matched pairs and actual-new-SDK background lifecycle checks. Provider
runs keep existing deadlines/turn limits and isolated accounts. Preserve all
failed b796 evidence and do not repeat unaffected suites until full matrix is
required. All changes remain uncommitted for coordinator integration, except an
explicitly required recorded gate commit coordinated later. Publication, pins,
release, production activation and 24-hour soaks remain separate unmet gates.

## Implemented checkpoint (2026-11-12)

The bounded correction above is implemented without changing runtime pins or
public method signatures. Three independent final code reviews are CLEAN after
concrete cancellation/drop findings were reproduced RED then fixed. Retained
focused verification: 104 PASS/0 skipped ownership and SDK tests; process-contract
verification 65 PASS/19 capability-inapplicable skips; matched gate suite 89
PASS/0 skipped, followed only by affected observer tests (12 PASS/0 skipped).
Receipts and red/green logs live under
`/tmp/orchestra-claude-upgrade-research-3agLJs`.

The Polygram child records the actual-pair gate source at signed commit
`e1870e26220746c2503cec7d660538b1bd18b49e`, with exact per-side SDK identities and
Orchestra runtime SHA-256
`c6f61a85acd139a0c524a7726dc5eead02be34480305bcd3fbdde32005c72184`.
The implementation uses the reviewed SDK-only Node resolution hook and private
load receipts, independently rehashes the selected SDK and actual imported
Orchestra runtime after each child, and validates those receipts at acceptance.
The immutable b796 crossed-pair failure remains separate.

Corrected old-pair provider probe `own-old-d` completed with correct ownership of
all three user markers, two completed task notifications, a task-correlated peer
report while follow-ups remained unchanged, and no provider error. It is
INCONCLUSIVE: the second autonomous terminal report has task-notification origin
but no run ID, so it cannot satisfy the retained distinct-task report oracle.
Do not weaken that oracle or call this a PASS. Candidate proof and the complete
recorded matched matrix are pending at this checkpoint. No new runtime subsystem
or wider queue refactor is proposed to work around an observation limitation.

## Bounded retained-trace replay amendment

Independent final trace review found that auto permission denied the standalone
parent `sleep 30` and the follow-up hold in BOTH final traces; agent sleeps did
run. Therefore these calls prove observed stream ownership only, not the intended
30-second hold schedule. No unchanged paid retry or permission bypass is planned.
The strict focused oracle remains INCONCLUSIVE and the complete scheduled matrix
remains unchanged on e1870e2. UUID-owned results and per-turn SDK semantics do not
promise one separate autonomous terminal per agent or two completed notification
edges before every zero-turn result; those are stronger fixture observations.

Add only a provider-free regression replay in the existing ownership test file,
using sanitized minimal shapes from old-d and new-d. Replay first UUID-owned user
completion, queue user2/3, and preserve two separate sequences. Old: peer terminal ->
normal2 completion -> runless task-notification terminal -> normal3 completion.
Candidate: first completed notification -> peer/zero-turn terminals -> second
completed notification -> normal2/3 completions. Assert that autonomous text
remains delivered and each report terminal leaves its then-current pending
owners unchanged ([2,3] for the early peer/zero, [3] for the old late report),
only normal2 submits before its completion, and all3correct
markers complete their own request. Preserve origin/UUID/list/num_turns fields
and observed ordering; replace synthetic IDs/text with stable fixture placeholders
and dynamically supplied submitted UUIDs only. This is regression proof for the
observed ownership shapes, not provider scheduling/hold coverage or focused PASS.
Run against a separate temporary copy of the old runtime to retain RED without
overwriting dirty source, then run the corrected source GREEN. No production or
gate source changes and no new runtime behavior are in scope for this amendment.

The replay amendment and actual code received independent compatibility/scope
reviews. Findings corrected the separate old/new order and removed invented
assistant origin metadata; only terminal results carry observed origin. The two
final tests fail against a temporary unchanged original runtime (3 SDK inputs
instead of2), then pass against corrected source (2PASS/0skip). Logs:
`pending-retained-replay-reviewed-red.log` and `pending-retained-replay-reviewed-green.log`.
Both final reviewers CLEAN. This adds no runtime/gate behavior and does not change
INCONCLUSIVE provider receipts, hold-schedule or downstream proof limitations.

## Historical matched matrix checkpoint

The first actual-pair e1870e2 matrix is FAIL14PASS/1BLOCKED/8not-run. Candidate
background task, exact marker and independent raw/native/SDK/source checks pass;
the runner then incorrectly demands matching old evidence for the manifest's
explicitly waived old opt-in cell. A small reviewed comparison decision fixes
planning, execution and retained acceptance consistently without adding waivers
or weakening any per-cell oracle. Concrete RED true-versus-false plan assertion,
GREEN15focused checks/0skip and3final independent CLEAN reviews are retained.
Corrected signed gate commit6cceb3b3544f4efc74330c82f0557d7f1bfb31d6 records that
source; a new complete unfiltered matrix m-6cce-a is in flight. Old e187 and b796
failures remain immutable. No runtime or manifest identity changed for this fix.

Final readback: matched matrix m-6cce-a on signed6cceb3b completed23/23PASS,
0FAIL/0BLOCKED/0NOT-APPLICABLE at2026-11-12T11:52:23.130Z after854.631s.
All23SDKload receipts bind exact old/newSDKs and unchanged corrected runtimeSHA.
This closes the full scheduled matched matrix requirement. Under the coordinator
acceptance above, the bounded local correction is accepted; the strict focused
provider receipts remain INCONCLUSIVE; preserved raw traces and reviewed local
replay prove observed ownership shapes, not intended sleep scheduling/downstream
provider delivery. No unchanged retry or runtime expansion is proposed. Issue is
still unpublished; pins/consumer update/release/staging24h/CLI24h remain separate.
