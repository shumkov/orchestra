# CLI turns that end in an API error (StopFailure)

Orchestra half of Polygram's `docs/0.41-cli-api-error-surfacing-spec.md`,
which holds the full evidence, the alternatives, and the review record.

## Problem

When a model request keeps failing, claude 2.1.283 retries it (about three
minutes by default), writes a synthetic assistant entry
(`isApiErrorMessage: true`, e.g. `error: "server_error"`), and ends the query
**without Stop**. It fires the documented `StopFailure` hook instead, but only
when one is registered. `CliProcess` registered none, so the turn had no end
signal. It stayed pending until the 30-minute checkpoint, and follow-ups were
autosteered into it. Production: VPS shumabit, 2026-11-04/05, with CLIProxy's
Claude credentials expired.

## Pinned-CLI facts this relies on

Verified on 2.1.283 by binary reading and a real-CLI run against a local
HTTP-500 stub (Polygram `scripts/spikes/cli-api-error-stub.mjs`).
Re-check them on every pin bump.

- `StopFailure` payload: the common fields plus `error` (enum),
  `error_details`, and `last_assistant_message`. The last field is the
  rendered error, including the gateway host. The hook is fire-and-forget.
- `prompt_id` identifies the query. The turn's UserPromptSubmit, a folded
  follow-up's extra UserPromptSubmit, its tool hooks, and its final
  Stop/StopFailure all share it. A queued prompt that runs as its own cycle
  gets a new one.
- A sub-agent whose request fails fires `StopFailure` with `agent_id` and the
  parent's `prompt_id`, and **no SubagentStop**. The main thread carries no
  `agent_id`, even under `--agent`.
- No StopFailure fires when a retry recovers, or when the user sends C-c
  during the retries.
- The org-disabled notice that the pane `AUTH_DISABLED` detector matches is
  the content of `error: "oauth_org_not_allowed"`.

## Behaviour

- `StopFailure` is registered and parsed. `apiError` is clamped to the enum
  (otherwise `'unknown'`), and `promptId` is normalized on every event.
- A sub-agent StopFailure is handled as that sub-agent's SubagentStop.
- A main-thread StopFailure is terminal (not activity). It never enters the
  Stop or workflow-completion machinery, which would deliver
  `last_assistant_message` as the answer.
- **Attribution is by `prompt_id` only.** A pending records the `prompt_id`
  of the UserPromptSubmit that first marked it seen.
  - Without a `prompt_id`, the event is logged and nothing settles; the
    ceilings remain the backstop.
  - A turn that was in flight at the last C-c is left to the interrupt
    resolution. A turn started after the C-c settles normally.
- **A matched turn**:
  - waits while a reply is still being delivered; the API error then
    outranks any finalize or timeout queued meanwhile;
  - resolves as answered if it already delivered a final reply;
  - otherwise rejects at once: `CLAUDE_API_ERROR` with `err.apiError`, and a
    message free of the class and the provider text. For
    `oauth_org_not_allowed` it rejects with the existing `AUTH_DISABLED`
    error.
  - The rejection happens before `idle` is emitted, so a throwing listener
    cannot strand the turn after its ceilings were cleared.
- **No match**: a prompt that ran with no pending turn (a follow-up that runs
  after a failed turn, a wakeup) is remembered at its UserPromptSubmit,
  together with the first follow-up message it picked up. The memory is a
  bounded map of the last 8 prompts, because the next prompt's line can be
  written first.
  - A delivered final reply to that follow-up clears its message, since the
    user is no longer waiting on it.
  - Its StopFailure emits `api-error { apiError, anchorMsgId, sessionId,
    backend }` once (`onApiError`).
  - A late failure of a turn that already settled matches neither, so it is
    only logged.
- Nothing is retried or re-sent, and no session is restarted.

## Telemetry

| Event | Fields |
|---|---|
| `cli-turn-api-error` | `turn_id`, `api_error_code`, `api_error_unlisted`, `delivered` / `deferred`, `reply_count`, `duration_ms` |
| `cli-stop-failure-unattributed` | `reason` (`no-prompt-id`, `own-cycle`, `no-matching-pending`), `api_error_code`, `api_error_unlisted`, `pending_count`, `anchor_msg_id` |
| `cli-stop-failure-ignored` | `reason` (`closed`, `bridge-disconnecting`), `api_error_code` |
| `cli-stop-failure-subagent` | `agent_id`, `api_error_code` |
| `cli-stop-failure-during-interrupt` | `turn_id`, `api_error_code` |
| `cli-auth-disabled-detected` | `source: 'stop-failure'` |
