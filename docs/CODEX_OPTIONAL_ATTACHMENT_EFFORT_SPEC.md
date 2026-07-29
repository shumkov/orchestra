# Optional Codex attachment effort

Status: reviewed implementation specification accompanying this change

Baseline: `origin/main` at
`f4224778a6c2c932ff1f171a867ba97bd66ab16a`

## Problem

Pinned `codex-cli 0.145.0` accepted `thread/start` and returned the required
thread, model, provider, and static policy fields, but omitted the optional
top-level `reasoningEffort`. `CodexAppServerClient` preserved that valid shape.
`CodexProcess` then passed the attachment response to `dynamicSettings`, which
requires both model and effort, and raised:

```text
Codex thread omitted its dynamic settings
```

The response had already been observed for a state-changing request, so the
startup failure correctly entered `ContainmentFailed`. `ProcessManager`
correctly converted that event into a daemon-wide Codex quarantine. No
`turn/start` was written.

The live direct checker did not catch the mismatch because
`characterizeThreadProfile` normalized a missing effort to `null` but did not
make the attachment dynamic shape part of the named-profile gate.

## Source-of-truth findings

A content-free local regeneration with exact `codex-cli 0.145.0` produced the
four deterministic Darwin hashes already recorded in
`tests/fixtures/codex-app-server-0.145.0/manifest.json`:

- stable `ClientRequest.json`:
  `cc9f6e191a032bdfdc96d768f4ddaba4ced75408017af3ac0dbcc4d00c1faaa8`;
- stable legacy protocol:
  `b6ec47c51bef8a6857dd9435f9919a43ba6616a5a9e3ab25087451cbc93d9f06`;
- experimental `ClientRequest.json`:
  `03e30c97136d6618273e3e9197d8621bad9ac6cfd733c0cfe09dc8754ee6ac5c`;
- experimental legacy protocol:
  `1f66700d1cc3de4a5004e5614a6098878b405c7e7c5f8c9be97fc900d0ad6c68`.

In both stable and experimental v2 schemas:

- `ThreadStartResponse.required` and `ThreadResumeResponse.required` include
  `model` but not `reasoningEffort`;
- both responses expose `reasoningEffort` as nullable when present; and
- `ThreadSettings.effort` is also schema-optional and nullable.

The current app-server projection independently encodes the same response
contract: it always projects `model` and projects `reasoningEffort` only when
non-null. This projection is already correct and must not synthesize a value.

Orchestra deliberately has a stricter product contract for
`thread/settings/updated`: a delivered settings notification must contain a
complete model/effort pair. That stricter notification contract remains.

## Root cause

The valid response first becomes invalid at the process validation boundary:

1. `CodexAppServerClient.projectRpcResult` requires the attachment model and
   conditionally projects `reasoningEffort`.
2. `CodexProcess._validateThreadResult` sends that projection to
   `_validateAndObserveThreadPolicy` as an attachment.
3. `_validateAndObserveThreadPolicy` validates the exact static policy, then
   calls the globally strict `dynamicSettings`.
4. `dynamicSettings` calls `modelSettings`, which requires a non-empty effort.
5. The optional response field is therefore reclassified as mandatory.
6. Because the attachment mutation response was already observed,
   `CodexProcess._start` contains the generation and the manager quarantines
   the daemon.

The bug is not in the generated schema, the client projection, static policy
attestation, containment, or quarantine behavior.

## Required invariants

1. Only a `thread/start` or `thread/resume` response may omit effort.
2. An attachment response must still contain a bounded non-empty model.
3. A present attachment effort must still be a bounded non-empty string.
4. Exact provider, approval, reviewer, sandbox, permission-profile, and runtime
   workspace-root policy checks are unchanged and run before dynamic
   reconciliation.
5. `thread/settings/updated` continues to require a complete model/effort pair,
   including when it arrives while attachment is in progress.
6. Every production `turn/start` continues to carry the complete,
   catalog-validated model and effort selected for that admission.
7. A missing attachment effort is unknown. It must not be replaced with the
   selected effort, a catalog default, or a prior thread value.
8. Attachment model and any present attachment effort must each be a non-empty
   string of at most 512 UTF-8 bytes. Only a `null` or omitted attachment
   effort represents absence.
9. A complete observed, admitting, active, or last-accepted pair always takes
   precedence over a provisional attachment model. An incoming complete
   notification must exactly match one of those complete candidates.
10. A provisional model may authorize a first complete observation by exact
    model only while no complete candidate exists and before the first turn
    admission begins.
11. The broad `AttachingThread` state must not grant first-observation
    authority after the attachment response has been validated.
12. Existing containment and response-observed non-retry behavior remains
    unchanged.

## Chosen correction

Keep the current complete-pair contract and add a narrow shared production
attachment-response parser:

```text
attachment response -> required model + optional effort
settings notification -> required model + required effort
turn admission       -> required model + required effort
```

The shared parser is a small pure production module used directly by both
`CodexProcess` and the real checker. It validates:

- a required non-empty model of at most 512 UTF-8 bytes;
- an optional effort where `null` and omission both mean absent; and
- when effort is present, a non-empty string of at most 512 UTF-8 bytes.

It returns a discriminated partial-or-complete value without substituting an
effort. The complete notification and turn paths remain strict. The checker
must not carry a duplicate approximation of this parser.

`CodexProcess` will retain two distinct internal concepts:

- `observedThreadSettings`: a complete provider-observed model/effort pair, as
  today; and
- a provisional attachment model used only when the attachment response
  omitted effort.

It will also retain `lastAcceptedTurnSettings`, or an equivalently durable
complete post-admission candidate. This is set only after `turn/start` has
been accepted and its `turn-accepted` checkpoint has succeeded. It is not
cleared when the active turn finishes. The attachment provisional is
irrevocably retired when the first turn admission captures
`admittingTurnSettings`, regardless of that RPC's outcome.

No provisional value is exposed as a complete observed pair. In particular,
`observedThreadSettings` remains `null` while the model-only attachment is the
only provider evidence. The model and effort written to `thread-initialized`
remain the local desired selection; that checkpoint does not turn them into
provider-observed settings.

Attachment reconciliation follows this table:

| Earlier evidence | Attachment response | Result |
|---|---|---|
| none | model + effort | retain the complete pair |
| none | model only | retain only the provisional attachment model |
| complete notification | same model, no effort | retain the notification pair; do not downgrade it |
| complete notification | same complete pair | retain the complete pair |
| complete notification | conflicting model or present effort | fail closed |

Every complete settings notification is reconciled in this deterministic
order:

1. Validate its full static policy and complete bounded model/effort pair.
2. Collect the complete `observedThreadSettings`, `admittingTurnSettings`,
   `activeTurnSettings`, and `lastAcceptedTurnSettings` candidates. If any
   exist, accept only an exact pair match against at least one candidate.
   Ignore the provisional model and attachment lifecycle state in this branch.
3. Otherwise, if an eligible provisional attachment model exists, accept it
   as the first complete observation only when the notification model exactly
   matches it. The notification's required bounded effort completes the pair.
4. Otherwise, allow a genuine pre-response first observation only when the
   process is attaching and the attachment response has not yet been
   validated. This permission is keyed by explicit response-validation state,
   not merely `state === 'AttachingThread'`.
5. Fail with `CODEX_THREAD_SETTINGS_MISMATCH` in every other case.

Once that notification is accepted, the provisional observation is discarded.
The first turn admission also discards it permanently. The persistent
last-accepted pair prevents provisional authority from reappearing after
`admittingTurnSettings` and `activeTurnSettings` are cleared. This keeps
per-turn overrides safe across attachment, admission, active execution, and
turn completion.

The attachment response path gets the optional parser explicitly. The
notification path does not infer this permission from the broad
`AttachingThread` state, because a notification can arrive before the response
and must remain complete.

### Notification-before-response ordering

The app-server client delivers a notification sink before resolving a later
response line. A complete `thread/settings/updated` can therefore populate
`observedThreadSettings` while `CodexProcess` is still awaiting
`thread/start`. When the subsequent response omits effort, validation compares
the response's known model to the complete notification and retains the
notification pair. It must not overwrite the complete pair with a partial
shape.

The reverse ordering is also bounded: a later complete notification may
upgrade a provisional attachment model under the conditions above.

A notification delivered after the attachment response but while the
`thread-initialized` checkpoint is delayed is not a pre-response observation.
It follows the same complete-candidates-first order. This closes the interval
where `state` remains `AttachingThread` after the response has already been
validated.

## Real checker correction

The real checker will report two separately named kinds of evidence:

1. Raw schema evidence pins the generated v2 shape for both
   `ThreadStartResponse` and
   `ThreadResumeResponse`: model required, `reasoningEffort` optional and
   nullable.
2. Production attachment-validation evidence passes each live fresh and
   resume response through the exact shared parser used by `CodexProcess`.
   Model and present effort must satisfy the production 512 UTF-8 byte bound.
   Effort is classified as `omitted`, `null`, or `present`; only the first two
   are absence, and a present value must pass the shared validator.
3. `evaluateNamedProfileGate` requires both fresh and resume production
   validation booleans. Raw schema success without production validation is
   insufficient and yields `STOP`.
4. Retain only booleans and presence classes in the U1a report. Do not emit
   thread identifiers, model/effort values, or new raw response data.

The gate accepts a `null` or omitted effort because the pinned schema permits
both. Using the production parser is essential: the former checker could
correctly describe the upstream shape while the production process still
rejected it.

## Implementation surface

Expected implementation files:

- `lib/codex/thread-attachment-settings.js`: shared bounded production parser;
- `lib/process/codex-process.js`: attachment-only parsing and bounded
  reconciliation, explicit response-validation state, and the persistent
  last-accepted candidate;
- `tests/codex-process.test.js`: production-shape and ordering regressions;
- `scripts/spikes/codex-app-server-real.mjs`: generated-schema/runtime
  assertions and gate evidence;
- `tests/codex-app-server-spike.test.js`: checker regressions; and
- `docs/codex-app-server-compatibility.md`: the corrected attachment contract
  and gate output.

No change is expected in `lib/codex/app-server-client.js`,
`lib/codex/protocol-schema.json`, the factory, preflight, manager, supervisor,
or package runtime.

## Exact TDD plan

Add the focused tests before implementation and run them with the installed
Node 24.4.0 runtime.

### Process regression

In `tests/codex-process.test.js`, add:

```text
Codex attachment accepts schema-optional effort without containment
```

Run it for both `thread/start` and `thread/resume`. Each fake attachment result
retains the required model and exact static policy but deletes
`reasoningEffort`.

Before the fix, both cases must fail with
`Codex thread omitted its dynamic settings`, enter `ContainmentFailed`, and
show that no `turn/start` occurred. After the fix, both must reach the expected
idle/recovery state without a containment event.

The model-only cases must also assert that `observedThreadSettings` remains
`null`. Their `thread-initialized` checkpoint may contain the locally selected
model and effort, but the test must not treat that checkpoint as observed
provider evidence.

### Shared production validator

Add table-driven unit coverage for the shared parser:

- required model at exactly 512 UTF-8 bytes is accepted;
- model at 513 UTF-8 bytes is rejected;
- a multibyte model whose JavaScript length is at most 512 but whose UTF-8
  encoding exceeds 512 bytes is rejected;
- omitted and `null` effort are accepted as absent;
- present effort at exactly 512 UTF-8 bytes is accepted; and
- empty, non-string, 513-byte, and multibyte-over-512 effort values are
  rejected.

The checker test must import this same production parser rather than restating
these conditions.

### Ordering and fail-closed regressions

Add:

```text
Codex attachment preserves a complete settings notification observed before an effort-omitting response
Codex attachment-only effort omission does not relax complete settings notifications
Codex attachment candidate precedence survives delayed thread initialization
Codex partial resume permits a complete first-turn override
Codex accepted turn settings retire provisional attachment authority
```

The first sends a complete matching notification before returning an
effort-omitting attachment response and asserts that the complete observed pair
survives. Independent fixtures must also prove these negative paths:

- a notification-before-response that omits effort enters containment as a
  protocol error;
- notification `{model: M, effort: E1}` followed by an attachment response for
  another model fails with `CODEX_THREAD_SETTINGS_MISMATCH`; and
- notification `{model: M, effort: E1}` followed by an attachment response
  `{model: M, reasoningEffort: E2}` fails with
  `CODEX_THREAD_SETTINGS_MISMATCH`.

The second case prevents the attachment-only optionality from becoming an
effort wildcard when the response actually supplied conflicting evidence.

The second starts from an effort-omitting response, then proves:

- a complete matching notification can establish the first complete
  observation;
- a model-only attachment for `A` followed, with no other complete candidate,
  by a complete exact-static notification for model `B` enters containment
  with `CODEX_THREAD_SETTINGS_MISMATCH`;
- a notification omitting effort still enters containment;
- a notification conflicting with an admitting/active complete pair enters
  containment; and
- a later selected turn still sends its exact model and effort.

The delayed-initialization regression holds the `thread-initialized`
checkpoint after the attachment response has been validated while the process
still reports `AttachingThread`. In independent fresh fixtures, it proves:

- a complete candidate is checked before the provisional model or any
  pre-response rule;
- provisional model `A` plus admitting candidate `A/xhigh` rejects `A/high`
  and accepts exactly `A/xhigh`;
- the same reject/accept pair holds with an active `A/xhigh` candidate; and
- without a complete candidate, provisional `A` may establish only a complete
  observation whose model is exactly `A`.

Conflict and acceptance cases use separate fixtures because containment is a
terminal state. No test attempts a positive assertion after causing
containment in the same process.

The resume override regression returns old model `A` with omitted effort from
`thread/resume`, selects a complete new pair `B/xhigh` for the first turn, and
delivers a matching settings notification during admission or active
execution. The turn must complete without containment. This proves that the
complete admitting/active candidate wins even though the provisional
attachment model is stale.

The provisional-lifetime regression starts from model-only attachment `A`,
accepts and completes an `A/xhigh` turn without any settings notification, and
then delivers late settings evidence. In separate fixtures, exact `A/xhigh`
is accepted while `A/high` enters containment. The assertions must show that
the persistent last-accepted pair remains authoritative after the admitting
and active fields are cleared and that the provisional model never regains
effort-wildcard authority.

### Static-policy regression

Extend the named-profile attachment table with an effort-omitting response
whose static policy is drifted. It must still fail with
`CODEX_THREAD_POLICY_MISMATCH` before any turn is dispatched.

### Checker regressions

In `tests/codex-app-server-spike.test.js`, add:

```text
Codex U1a pins optional attachment effort while requiring the model
Codex U1a live responses pass the production attachment validator
Codex U1a separates raw schema evidence from production attachment evidence
```

The schema test must reject a required `reasoningEffort`, a missing required
model, and a non-nullable or missing effort property. Runtime characterization
must accept omitted/null effort, accept bounded non-empty strings, and reject
empty, non-string, or over-512-byte model/present-effort values through the
shared production parser. Include a multibyte over-limit case to prove the
bound is UTF-8 bytes rather than JavaScript code units.

The gate test must go red until both fresh and resume production-validation
evidence are required. A fixture with valid raw schema evidence but either
production-validation boolean missing or false must `STOP`.

### Malformed attachment containment

Use a fresh process fixture for every malformed response because attachment
containment is terminal. Cover empty, non-string, 513-byte, and multibyte
over-512 model values, plus present effort values with the same invalid
classes. Each case must prove:

- the accepted attachment response enters containment with a protocol error;
- no `turn/start` is written; and
- `null` and omitted effort remain the only accepted omission cases.

Suggested focused command:

```sh
/Users/ivanshumkov/.nvm/versions/node/v24.4.0/bin/node \
  --test \
  --test-name-pattern='schema-optional (attachment )?effort|production attachment validator|named-profile attachment accepts production omitted and null effort|attachment preserves|notification before|settings notifications enforce|attachment-only effort|candidate precedence|first-turn override|retire provisional|malformed attachment|named-profile attachment rejects|raw schema evidence' \
  tests/codex-process.test.js tests/codex-app-server-spike.test.js
```

Record the initial failures, implement one correction, rerun the same command
to green, then run the complete affected files and one full Node 24.4.0 suite.

## Failure and security cases

- Missing, empty, non-string, or over-512-byte UTF-8 model: protocol error and
  containment after an observed attachment response.
- Present empty, non-string, or over-512-byte UTF-8 effort: protocol error and
  containment. Only `null` or omission is absent.
- Any static policy omission or mismatch: unchanged exact-policy failure.
- Notification missing effort: protocol error even during attachment.
- Notification static drift: unchanged containment.
- Notification/response model conflict: containment.
- Present response effort conflicting with an already observed complete
  notification: containment.
- Notification conflicting with an observed, admitting, active, or
  last-accepted complete pair: containment; provisional evidence cannot
  override it.
- Notification after the attachment response but before `thread-initialized`
  completes: complete-candidate and provisional rules apply; the
  pre-response exception is unavailable.
- Notification after the first turn admission: provisional evidence has been
  retired permanently.
- No matching complete candidate and no matching provisional attachment model:
  containment.
- Response checkpoint uncertainty: unchanged non-replay and quarantine.
- No new raw response, model, effort, thread, credential, or policy data is
  persisted by the checker.

## Alternatives rejected

### Substitute the selected effort

The selected effort is local intent for a later turn, not attachment evidence.
Substitution would lie about a resumed thread and could hide a provider
mismatch.

### Substitute the catalog default

The catalog default may differ from the selected per-turn effort and from a
resumed thread's retained value. It is not response evidence.

### Make `modelSettings` globally optional

This would weaken constructor, selection, turn admission, and notification
validation. The omission belongs only to attachment responses.

### Synthesize effort in the app-server projection

The client currently reflects the pinned generated schema exactly. Inventing a
field at the transport boundary would erase the distinction between absent and
observed state.

### Ignore attachment dynamic settings

The required model and any present effort remain useful consistency evidence,
especially when a notification arrives before the response.

### Keep raw schema-only checker evidence

Schema evidence proves what Codex may emit, not what Orchestra accepts. It
would reproduce the production blind spot. Fresh and resume live results must
also pass the shared production parser used by `CodexProcess`.

### Add a second checker-only parser

A duplicate implementation could drift from the process boundary and allow
the gate to continue while production fails. The one bounded parser is shared
instead.

### Require Codex to return effort

That contradicts the pinned schema and the verified production response. It
would preserve the outage rather than correct Orchestra.

## Release, recanary, and quarantine

Implementation and release are separate work:

1. Land only after focused red-to-green evidence, the complete affected tests,
   one full Node 24.4.0 suite, and independent correctness/security/simplicity
   review.
2. Keep any version bump and release metadata in the normal separate release
   commit. Publish only through the repository release workflow.
3. Run the strengthened direct Linux checker with exact pinned Codex,
   content-free inputs, and the existing operational containment gates before
   recanary.
4. Recanary one attachment first and require: response observed, attachment
   initialized without containment, no daemon quarantine, and the first
   `turn/start` written with the exact selected model/effort pair.
5. Preserve the current quarantine record from the failed canary. Do not
   force-clear it and do not retry Codex on the same boot.
6. Retry only after the production host has genuinely rebooted and the
   persisted recovery record is restored on the same host with a different
   boot-session identity. A daemon restart, process restart, or package
   reinstall is not sufficient.

The quarantine is a correct consequence of an accepted state-changing
attachment followed by local validation failure. This fix changes validation
of future schema-valid attachments; it does not retroactively prove the
contained generation safe.
