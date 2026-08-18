# Folded reply attribution and duplicate fallback suppression

Status: independently reviewed; option 1 selected by the operator on
2026-08-18 and implemented pending release verification.

## Problem

On 2026-08-17 at 22:31 Asia/Bangkok, Shumabit@home topic `routine`
received a primary Telegram message (6406) followed by an autosteered message
(6407). Claude answered both in one rich `reply` tool call. The call echoed the
autosteer turn ID and named both the primary and autosteer IDs in
`consumed_turn_ids`.

The combined rich answer was sent as Telegram message 6408, quoting 6407.
Orchestra then classified that already-delivered reply as a late reply from an
older cycle instead of recording it on the active primary turn. The primary
therefore still had zero recorded replies. At Stop, its different
`last_assistant_message` was treated as an undelivered fallback and Polygram
sent message 6409 quoting 6406. The user saw two substantially overlapping
answers with reversed ownership.

The incident was not caused by Telegram rich-text rendering. Production runs
Polygram 0.38.0 with Orchestra 0.10.14, and the installed Polygram contains the
non-streamed rich-delivery path. Message 6408 rendered rich (13 blocks, 1,718
characters). Message 6409 came from the zero-reply fallback branch and its
content did not qualify for rich rendering, so it fell back to the plain
sender. Fixing attribution removes that accidental second message; the existing
non-streamed rich path remains the safety net for genuine zero-reply turns.

## Production evidence

Read-only SQLite queries against the user-authorized Shumabit@home production
chat found, over the 14 days ending 2026-08-17:

- 37 `cli-late-reply-correlated` events whose ledger source was `autosteer`
  (30 distinct echoed turn IDs).
- 12 distinct cases immediately followed by
  `cli-consumed-ack-fallback-rescued`; 13 resolved with zero recorded replies.
- In topic `routine`, 7 late-autosteer events covered 6 distinct turn IDs; 3
  distinct turns produced a zero-reply fallback rescue.
- The reported turn's event chain was:
  `autosteer` → both inputs `cli-input-acked` →
  `stream-preview-turn-mismatch` → rich 6408 →
  `cli-late-reply-correlated(source=autosteer)` →
  `cli-turn-resolved-by-stop(reply_count=0)` →
  `cli-consumed-ack-fallback-rescued` → plain 6409.

Content review of all 12 Shumabit@home rescue cases found that every rescued
Stop text was a shorter recap, translation, or subset of the already-delivered
channels reply. None contained the only copy of a final outcome. This corrects
the older fallback design's assumption that differing text necessarily means
new user-visible content: in current production, 12/12 differing texts in this
fold shape were duplicates.

The last two `routine` rescue cases before and including the report produced
the same structural outcome: an already-delivered channels reply followed by a
primary zero-reply fallback. This is a lifecycle classification defect, not a
message-specific content error.

## Operator decision

The user's literal report asks for the two existing messages to have their
anchors swapped. The recommended behavior below instead removes the accidental
second message and keeps one combined answer anchored to the primary. Product
and interaction review agree that this visible behavior change requires
explicit operator alignment before implementation.

There is one reliability trade-off. A successful `reply` call is final unless
it explicitly sets `interim:true`; that is the bridge's current hard contract.
In June 2026, Claude violated the contract once: it sent “Researching now…”
without `interim:true`, then left the real answer only in Stop. The existing
different-text rescue was added for that incident. Recording a proven folded
non-interim reply on the primary trusts the protocol again and would suppress
such an unmarked status if it recurred. Against that historical risk, the new
production review found 12/12 current rescues were duplicates, including the
reported case.

The operator selected option 1 from these product contracts:

1. Recommended: one combined answer anchored to the primary; a successful
   non-interim reply is authoritative final, while `interim:true` retains the
   produced-final rescue.
2. Conservative: preserve two outputs and explicitly map the Stop fallback to
   the folded source. This protects unmarked statuses but intentionally keeps
   the 12/12 observed duplicate shape and requires a cross-package source
   override.

Option 2 matches the screenshot's requested anchor swap, but assigns the Stop
transcript to the autosteer without protocol evidence. It makes model
transcript leakage part of normal steering semantics and adds a cross-layer
source override for result delivery. Those costs make it the conservative
reliability option, not the recommendation, but it remains a legitimate choice
at this gate.

The remainder of this spec describes option 1.

## Intended behavior

Polygram's autosteer contract is “merge into active”: a follow-up injected
while a primary turn is in flight is context absorbed by that primary turn.
The bridge contract explicitly supports one combined reply covering several
inputs through `consumed_turn_ids`, while `turn_id` can echo only one of them.

Therefore:

1. A combined reply proven to consume the active primary belongs to the active
   primary turn, even when Claude echoes a folded input's ID.
2. Its first Telegram bubble quotes the primary source message.
3. It is recorded as a delivered reply on the primary, so a different Stop
   transcript does not become a second fallback answer.
4. The folded input is still resolved through `consumed_turn_ids`; it does not
   receive a separate answer because it was merged rather than queued as a new
   turn.
5. A genuine later cycle for a non-folded autosteer remains independently
   attributable to that autosteer message.

For the reported incident, the intended visible result is one combined rich
answer quoting 6406. It is not two existing answers with their quotes swapped.
Preserving the second answer would elevate an accidental Stop fallback into a
first-class steering response even though it has no protocol identity proving
that ownership.

## Recommended option 1

### 1. Resolve one effective owner before dispatch

In `CliProcess`, resolve reply ownership once and reuse it for Telegram
dispatch and pending-turn bookkeeping. A reply that echoes a ledgered,
non-pending fold entry is remapped to a live pending turn only when all of the
following deterministic evidence is present:

- the echoed ledger entry source is a fold source (`autosteer` or
  `edit-fold`);
- `consumed_turn_ids` contains the echoed fold ID;
- `consumed_turn_ids` contains exactly one currently pending turn ID; and
- the chat ID has already passed the existing session chat guard.

The uniquely consumed pending turn is the effective owner. Every other shape
keeps current behavior, including the late-reply safeguard for an old ledgered
ID. The implementation must not infer folding merely from “one pending turn.”

### 2. Use the effective owner consistently

For a proven fold reply, use the effective pending owner for:

- dispatcher `turnId`, so the active stream preview accepts the final reply;
- `sourceMsgId` and `participantJid`, so the first bubble quotes/reacts to the
  primary source;
- the entry whose `_quoteUsed` flag is spent after successful delivery; and
- `_recordReplyForPendingTurn`, so the active primary records the delivered
  final or interim reply.

Keep the model-echoed ID for ledger acknowledgement, content deduplication, and
diagnostic fields. After successful dispatch and pending-turn recording, emit a
metadata-only `cli-fold-reply-attributed` event with the echoed fold ID,
effective pending ID, fold source, and whether the reply was interim. Thus the
event means a delivered attribution, not merely a pre-dispatch decision. Do not
log message content.

The attribution resolver should return explicit fields rather than mutate the
tool arguments. This preserves the wire receipt and makes it difficult for
dispatch attribution and bookkeeping attribution to drift apart again.

### 3. Let existing finalization suppress the accidental fallback

Once the combined final reply is recorded on the primary,
`_computeTurnDelivery` takes its existing final-reply/already-delivered branch.
The Stop hook's different `last_assistant_message` is not re-sent. No new
fallback heuristic is needed.

If the proven fold reply is `interim:true`, it remains interim on the primary;
the existing interim-final rescue rules continue to apply. This change must
not turn a status message into a final answer.

If the reply omitted `interim:true`, it is authoritative final under the
bridge contract even when Stop later contains different text. This deliberately
revises the older “different means new” fallback assumption for proven current
folds; the 12-case production classification above is the evidence. The hard
prompt and schema wording for `interim` remain in place, and the rollout watches
for missing-final reports.

### 4. Release through Orchestra, then consume in Polygram

The behavioral fix belongs in Orchestra because it owns the input ledger,
pending turns, reply-tool dispatch, and Stop finalization. After its focused and
full tests pass, release a new exact Orchestra version, update Polygram's exact
dependency, run Polygram's focused rich/non-streamed tests and full suite, then
roll out through the normal staged deploy path.

No database migration, Telegram API change, prompt change, or configuration
change is required.

## Alternatives rejected

### Trust the echoed `turn_id` unconditionally

Rejected. The bridge schema can express only one `turn_id`, while the existing
contract explicitly allows one reply to consume several inputs. Production
shows Claude can echo the fold ID for a combined reply.

### Prompt Claude to echo the primary ID

Rejected. This is deterministic routing and must not depend on model
compliance. It would also regress silently when model behavior changes.

### Route any ledgered fold ID to the sole pending turn

Rejected. This reopens the late-reply cross-attribution defect that the input
ledger was designed to close. Explicit `consumed_turn_ids` membership is the
proof that distinguishes a current fold from an old reply.

### Suppress every different Stop fallback after a consumed ack

Rejected. A prior production incident established that a short consuming
status can be followed by a distinct real final answer in the Stop transcript.
The current rescue protects that case. Recording a proven combined final reply
on its actual owner solves this incident without weakening the rescue for
correctly marked `interim:true` replies.

The narrower chosen rule is different: only a successfully delivered reply
that the protocol marks final is authoritative. `interim:true` continues to
rescue a distinct produced final. The remaining risk is a model contract
violation that omits `interim:true`; it is called out in the operator decision
rather than hidden behind a text-difference heuristic that produced 12/12
duplicates in the measured current population.

## Failure modes and boundaries

- Missing, empty, foreign, or ambiguous `consumed_turn_ids`: do not remap; keep
  current late/orphan behavior and telemetry.
- More than one consumed pending turn: do not guess an owner.
- A ledgered `primary` or `system` ID that is not pending: remains a late reply.
- A fold reply after the primary finalized and with no consumed live pending
  owner: remains independently attributed to the fold source.
- Dispatcher failure: do not spend the effective owner's quote, record the
  consuming text, or record a delivered reply; preserve existing retry and
  Stop-fallback behavior. Turn finalization waits while the consuming reply is
  in flight so neither a successful delivery nor a failed-delivery fallback is
  lost to the race.
- Multiple folded inputs in one reply: one uniquely consumed live primary may
  own the combined reply; all named folds are acknowledged normally.
- Interim fold reply: quote ownership is corrected, but finalization remains
  interim-aware.
- Non-interim fold reply followed by different Stop text: the reply is final by
  contract and Stop is suppressed. This removes the measured duplicates but
  no longer compensates for an omitted `interim:true` in this proven-fold
  shape; the operator decision explicitly accepts or rejects that trade-off.
- WhatsApp opaque source IDs: preserve the existing numeric-or-opaque
  conversion and participant binding by selecting an entry, not coercing IDs
  differently.
- A model that falsely names the current primary in `consumed_turn_ids` can
  still misattribute a reply. That field is already the system's explicit
  fold-ack contract and is the strongest available protocol evidence; the new
  telemetry makes its use measurable.

## Test and verification plan

Follow bug-fix TDD: add the exact regression first, run it against unmodified
Orchestra and record the failure, then implement and rerun it green.

Focused regression cases:

1. Primary source 6406 + autosteer source 6407; a successful final reply echoes
   the fold ID and consumes both. Before the fix, dispatcher source is 6407,
   its turn ID is the fold ID, the primary has zero replies, and a distinct Stop
   fallback is deliverable. After the fix, dispatcher source is 6406, effective
   turn ID is the primary, the primary records one final reply, and finalization
   is already-delivered with no fallback send.
2. The same shape with an active stream preview must not emit a turn-mismatch
   and must finalize the primary preview.
3. An old ledgered autosteer reply that does not consume the current pending ID
   remains late and never quotes or records against the current primary.
4. A true extra-turn autosteer with no live primary still quotes its own source.
5. An `edit-fold` combined reply follows the same proven-fold rule.
6. Ambiguous consumed pending IDs do not remap.
7. A failed delivery neither spends the primary quote nor records the reply.
8. An interim fold reply stays interim and still permits the existing produced-
   final rescue.
9. A non-interim fold reply followed by distinct Stop text stays
   already-delivered and does not produce a duplicate fallback.

Verification gates:

- Focused Orchestra regression test shows red before and green after.
- All Orchestra unit/integration tests pass with no unexpected skips.
- Polygram's non-streamed rich tests pass against the new exact Orchestra pin.
- Full Polygram test suite passes with no unexpected skips.
- A controlled Shumorobot fold scenario produces one combined rich reply
  quoting the primary and a `cli-fold-reply-attributed` event, with no
  `stream-preview-turn-mismatch`, `cli-late-reply-correlated`, or
  `cli-consumed-ack-fallback-rescued` for that turn.
- Deploy Shumabit only after the canary passes; verify unrelated UMI Assistant,
  Water, and tmux owners are unchanged according to the normal deploy gate.

## Soak and rollback

For 24 hours after Shumabit rollout, compare against the 14-day baseline:

- proven fold replies produce `cli-fold-reply-attributed`;
- late-autosteer events followed by zero-reply fallback rescue trend to zero;
- no rise in `channels-orphan-reply-dropped`, turn timeouts, or missing final
  answers; and
- no duplicate-answer report in the affected chat.

Rollback is an exact Polygram/Orchestra version rollback through the normal
release/deploy procedure. There is no persistent state to unwind.

## Success criteria

- The reported production shape yields one combined answer quoting the primary
  message.
- A proven folded reply is owned consistently by dispatch, preview, quoting,
  and pending-turn finalization.
- True late replies remain isolated from a newer pending turn.
- Genuine zero-reply and interim-only fallbacks retain their current rescue.
- Rich formatting remains available on both reply-tool and genuine
  non-streamed paths.
