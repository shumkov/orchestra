# Folded reply credit without full consumption proof

Status: reviewed (lifecycle and simplicity lenses); implemented
Extends: `docs/FOLDED_REPLY_ATTRIBUTION_SPEC.md`

## Problem

Polygram on the UMI VPS (Shumabit bot) still answers twice. On 2026-11-18 in
the UMI management `finance` topic:

1. message 1238 starts the primary CLI turn (`3fbaba66`); the agent sends an
   interim progress checklist (1239);
2. message 1240 arrives and is autosteered into the live primary (ledger
   turn `068875bb`);
3. the agent answers the steer with one non-interim `reply` (1243). It echoes
   the steer's `turn_id` and lists only the steer in `consumed_turn_ids`;
4. `_resolveReplyAttribution` has no proof that the reply consumed the primary,
   so `_recordReplyForPendingTurn` takes the late-reply branch
   (`cli-late-reply-correlated`); the primary records nothing;
5. 30 seconds later the combined CLI cycle stops. The primary has only the
   interim checklist, so `_computeTurnDelivery` takes `interim-rescue` and
   Polygram sends Stop's `last_assistant_message` as message 1245: a recap of
   1243, in English, quoting 1238.

With zero interim replies the same shape takes the `zero-reply` Stop fallback.
The August fix (`FOLDED_REPLY_ATTRIBUTION_SPEC.md`) only covers replies whose
`consumed_turn_ids` names both the steer and the primary; Claude does not
always do that.

Production, Shumabit, 30 days to 2026-11-18: 46 turns resolved with
`already_delivered=false` and a non-empty fallback text; in 16 of them a
`cli-late-reply-correlated` reply landed in the same session while the turn
was live (9 `interim-rescue`, 7 `zero-reply`). Each is a visible second answer.
The other 30 have no late reply and are not affected by this change.

## Approach

Prove the fold from the follow-up's own UserPromptSubmit, and let the proof
change only what the host turn delivers at Stop.

1. UserPromptSubmit handler: when it picks up a ledgered `autosteer` or
   `edit-fold` entry that is not itself a pending turn, and exactly one
   pending turn runs in the same query (`pending._promptId === ev.promptId`),
   store that turn's id on the entry as `foldHostTurnId`.
   The pinned CLI gives a follow-up folded into a running query that query's
   `prompt_id`; a follow-up run as its own query gets a new one
   (`CLI_API_ERROR_STOP_FAILURE_SPEC.md`, verified on 2.1.283). The finance
   session on 2.1.322 shows the same shape: the follow-up is a
   `queued_command` attachment inside the primary's single `promptId`.
2. `_recordReplyForPendingTurn`, late-reply branch: keep everything it does
   today. In addition, for a non-interim reply whose entry has a
   `foldHostTurnId` that is still pending and not being interrupted, set
   `host._foldReplyCredited = true` and log `cli-fold-reply-credited`
   (`turn_id` = host, `reply_turn_id` = echoed id, `source`).
3. `_computeTurnDelivery`: after the existing `final-reply` branch, a credited
   turn with Stop text returns `alreadyDelivered: true`, branch
   `fold-reply-credited`. The text is returned for the consumer's transcript
   and telemetry only, as the consumed-ack branch already does.

Nothing else changes. The reply is not added to the host's `replies`, so
`_turnHasFinalReply`, activity-quiet finalization, quiet timers, the reply cap
and `_clearFollowUpsThrough` behave as today: the host still ends on its own
Stop. The API-error path does not read the flag, so a query that fails after
the follow-up was answered still reports the error for the primary. Dispatch,
the quoted message (the follow-up), ledger acknowledgement and content dedup
are unchanged.

If the follow-up's UserPromptSubmit has not been read when the reply arrives
(hook log lag), nothing is credited and the old behaviour (a possible second
message) applies. The change can only remove a message when the fold is
proven.

## Trade-off (new, not covered by the August decision)

August's option 1 suppressed the Stop text only when the reply's
`consumed_turn_ids` named the primary, which is Claude's own claim that the
reply answered it. Here Claude named only the follow-up. If Claude answers the
follow-up, keeps working on the primary and puts the primary's answer only in
its closing text without a `reply`, that answer is no longer sent.

Evidence that this is the right trade-off: the 16 production cases above were
read (first lines of each message only). In all 16 the Stop text was an English
third-person recap of what had already been sent or done ("I sent Mai…",
"Waiting for Mai's answer…", "Yes, I researched the methods…"). None held an
answer that was not already in the chat. This matches August's 12/12.

Telemetry to watch after release: `cli-resolve-delivery` with branch
`fold-reply-credited` and its `text_len`; any user report of a missing answer
after a mid-turn follow-up.

## Alternatives rejected

- Record the host at injection time and credit until its Stop is captured
  (first draft). Stop is read 250 ms to 5 s after the bridge socket, and
  `_stopHookData` is also set by sub-agent boundary Stops and not set for
  unattributed Stops, so it is not a reliable "query ended" signal.
- Record the reply on the host through `_recordReplyForPendingTurn`. It would
  make the host look answered, letting activity-quiet end it while Claude is
  still working, and would hide an API error from the primary.
- Treat any late autosteer reply as the single pending turn's reply. Rejected
  in the August spec: a follow-up folded into an earlier turn would be
  credited to an unrelated later turn.
- Compare Stop text with delivered replies. The duplicates are recaps or
  translations (1245 is English, 1243 Russian), so text equality misses them.
- Re-anchor the reply on the primary (as the proven-fold path does). It changes
  which message the bubble quotes; the reply correctly quotes the follow-up
  today. Quote placement is a separate open design (Polygram
  `docs/STEER_VISUAL_SEGMENTS_SPEC.md`, unmerged).
- Fix it in the prompt only. Claude already has the instruction to list both
  ids and does not always follow it.

## Verification

Integration tests in `tests/cli-process-integration.test.js`:

- finance trace: primary, interim checklist, folded follow-up (same
  `prompt_id`), final reply naming only the follow-up, Stop with different
  text: `alreadyDelivered: true`, branch `fold-reply-credited`, reply still
  quotes the follow-up. Red before the change.
- the same with no interim reply (`zero-reply` shape). Red before the change.
- interim reply to the follow-up: not credited, Stop text delivered.
- follow-up run as its own query (new `prompt_id`): not credited.
- follow-up whose UserPromptSubmit was not observed: not credited.
- StopFailure after a credited reply: the primary is still rejected with
  `CLAUDE_API_ERROR`.
- follow-up folded into an earlier, finished turn and answered during a new
  turn: stays late, not credited, the new turn delivers its own Stop text.
  (Rewrite of the "unproven old autosteer reply" test, which injected into the
  current primary and so encoded the bug.)

Then Polygram consumes the new exact Orchestra version and runs its full
suite. Production proof after deploy: `cli-fold-reply-credited` events appear,
and `cli-resolve-delivery` with `already_delivered=false` after a
`cli-late-reply-correlated` in the same turn drops from ~16/month toward zero.
