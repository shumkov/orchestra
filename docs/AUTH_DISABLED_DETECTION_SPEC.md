# AUTH_DISABLED detection — spec

## Problem

When Anthropic disables Claude Code / subscription access on an account
(non-payment, org policy, an admin toggling a Team/Enterprise setting), the
`claude` CLI does not exit or surface an HTTP error orchestra's process
wrapper can see. It renders the notice **inside the TUI**, as if it were a
turn's output, then sits there — no reply-tool call, no hook `Stop` event.
orchestra's `CliProcess` has no detector for this text, so the turn just
waits. It is eventually killed by the existing idle ceiling
(`DEFAULT_TURN_TIMEOUT_MS` = 10 min) or the hard wall-clock backstop
(`DEFAULT_TURN_HARD_MAX_MS` = 90 min), rejecting with the generic
`err.code = 'TURN_TIMEOUT'` / `'TURN_MAX_EXCEEDED'` (cli-process.js:2458).
Both consumer bots (water, polygram) then classify that generic code into a
canned "went quiet" reply, 10+ minutes late, with no indication that the
real cause is an account-level auth problem an operator needs to act on.

Because CliProcess is shared, water and polygram can both go dark at the
same minute on the same account — which is what happened in production.

This is a **different failure mode** from the OAuth-refresh-token-expiry
case fixed in 0.3.0 (`checkClaudeAuthHealth` / `claude-bin.js`) — that one
is a free, local, credentials-file check for an *expired* token, done
*before* spawn. This one is Anthropic *actively disabling* access
mid-conversation; it has no file-readable precondition and can only be
observed in the live CLI output.

## What the message actually looks like (verified)

Contrary to the initial hand-off note ("NOT an HTTP 401/403"), the
underlying cause genuinely is an HTTP 403 (`permission_error`,
`"OAuth authentication is currently not allowed for this organization"`)
— but that response is consumed *inside* the `claude` binary. orchestra
runs `claude` inside tmux over the channels bridge; it never sees raw HTTP.
What it sees is the CLI's own rendering of the error, in the pane, as if it
were conversational output. Per Anthropic's own error reference
(`code.claude.com/docs/en/errors`, confirmed against multiple
`anthropics/claude-code` GitHub issues, e.g. #63886, #62722, #68212), the
literal, stable text is:

```
Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access
```

This is a fixed product string (not a template with variable account
details), and it is what the CLI prints regardless of surface (`/login`,
mid-session, `-p` mode surfaces it as the structured code
`oauth_org_not_allowed`, which orchestra also never sees — that's an SDK
path, not the CLI/tmux path CliProcess drives).

## Where in cli-process.js to hook this

CliProcess has three distinct places that inspect Claude's output, and only
one of them is a good fit:

1. **Bridge MCP protocol** (`_handleBridgeMessage`, `_dispatchToolCall`) —
   structured tool calls (`reply`, `ask`, permission requests) delivered
   over the channels socket. Not applicable: this failure produces no tool
   call. Claude never gets far enough to call anything.
2. **Hook ndjson stream** (`_handleHookEvent`, `Stop`'s
   `lastAssistantMessage`) — this *would* be the natural place if the CLI
   fired a `Stop` hook after emitting the notice. It does not: the turn
   diagnosis confirms it hangs to the idle ceiling rather than resolving via
   the existing zero-reply Stop-fallback (`_computeTurnDelivery`,
   cli-process.js:2153), which only fires once `Stop` lands. No `Stop`
   event here means no hook payload carries this text.
3. **tmux pane-capture watchdog** (`_pollMidTurnDialogs`, cli-process.js
   ~4008) — the *only* place that regex-matches Claude's literal rendered
   output. It already runs every `PONG_CHECK_INTERVAL_MS` (5s) while a turn
   is pending (`pendingTurns.size > 0`), captures the pane with `-J`
   (line-rewrap-safe), and matches a catalog of known dialog strings
   (`MID_TURN_PROMPTS`, `SESSION_AGE_PROMPT_RE`, `UNKNOWN_PROMPT_HEURISTIC_RE`).
   This is the existing "live scan of streamed output" the task referred
   to — it is the mechanism that already recovers session-age dialogs and
   other TUI-only text. It is the correct, minimal hook point.

**Chosen approach:** add an `AUTH_DISABLED_RE` check inside
`_pollMidTurnDialogs`, run once per poll, BEFORE the `STREAMING_HINT_RE` /
`MID_TURN_PROMPTS` / unknown-prompt checks (most severe signal first; on
confirmed match the rest of the method is skipped via an explicit early
`return` — see "same-poll interference" below). On confirmed match: reject
every currently-pending turn with `err.code = 'AUTH_DISABLED'`, mirroring
the existing drain idiom already used three times in this file
(`_handleBridgeDisconnected`, `_doKill`, `resetSession`). Detection latency
is bounded by two poll intervals (≤10s, see debounce below) — effectively
immediate next to the current 10-minute wait.

**Bounded tail, not the full pane.** `_pollMidTurnDialogs` reuses the
pane already captured for the other detectors, which defaults to
`capturePane`'s `lines: 1000` (tmux-runner.js:345). That's the right depth
for dialogs that must survive scrollback, but wrong for this detector: once
printed, the notice would stay inside a 1000-line window for a long time
(review finding — a legitimate assistant reply that happens to quote this
exact error text, e.g. a user asking Claude to explain the error, would
then falsely arm detection for every subsequent turn in the session until
~1000 lines of new output rolled it out of view). Mitigation: only test
`AUTH_DISABLED_RE` against the **last ~40 lines** of the already-captured
pane (`pane.split('\n').slice(-40).join('\n')` — same pattern already used
for the unknown-prompt excerpt at cli-process.js:4119-4120, no extra tmux
call). A wrapped single-sentence notice is 1-3 logical lines after `-J`
join; 40 lines comfortably covers TUI chrome around it while aging the
match out within roughly one screen of subsequent output — versus ~1000
lines for the untrimmed pane.

**Two-consecutive-poll debounce.** Even bounded to 40 lines, a single-poll
match isn't enough: a legitimate reply that quotes the string could still
be visible in the tail for one poll tick while the turn is still
in-flight (not yet `Stop`-resolved). Require the match on two consecutive
polls (`this._authDisabledArmed`, reset to `false` on any poll where the
tail does *not* match) before rejecting. Adds ≤1 poll interval (~5s) of
latency to the worst case; still trivial next to the 10-minute status quo.

**Implementation correction found in code review (must-fix, applied):** the
first draft only reset `_authDisabledArmed` inside the tail-check block
itself — every EARLY-RETURN guard above it (`this.closed`,
`pendingTurns.size === 0`, `_openQuestions.size > 0`, no `tmuxSession`, no
`captureWide`, a `captureWide` throw, an empty `pane`) left the flag
untouched. Concretely: turn A arms the flag, then resolves normally via
`Stop` — `pendingTurns` empties, so every subsequent poll returns early at
the `pendingTurns.size === 0` guard *without* touching the flag. It stays
`true` indefinitely. When an unrelated turn B starts later and its pane
still shows the same old text within the last 40 lines (plausible — nothing
scrolled it away during the idle gap), turn B's very FIRST poll sees the
stale `true` and "confirms" against it, rejecting a turn that had nothing
to do with the original sighting. This defeated the debounce's actual
purpose (protecting the *next* turn, not just the one that produced the
quote). Fixed by resetting `_authDisabledArmed = false` on every one of
those early-return paths, so "armed" can only ever mean "the immediately
preceding poll actually re-observed a match against a still-pending turn."
Caught by an independent correctness-review agent, confirmed by direct
reproduction, and pinned by a dedicated regression test (test plan below)
that fails against the first-draft code and passes against the fix.

**Same-poll interference with other detectors (review finding).** Once
`AUTH_DISABLED_RE` confirms, `_pollMidTurnDialogs` must `return`
immediately after the drain, rather than falling through to the
`STREAMING_HINT_RE` heartbeat, `MID_TURN_PROMPTS` loop, or
`UNKNOWN_PROMPT_HEURISTIC_RE` check. Reason: the drain empties
`pendingTurns`, and the TUI's idle input cursor (`❯ `) below a static
notice is exactly what `UNKNOWN_PROMPT_HEURISTIC_RE` matches — without the
early return, the same poll tick would also emit a confusing
`cli-mid-turn-unknown-prompt` telemetry row with `pending_count: 0`, or
worse, send stray dismissal keystrokes (`MID_TURN_PROMPTS` actions) into an
already-terminated turn.

**Drain must match-and-reject `pendingQueue`, not blunt-truncate it, and
must reset `inFlight` (review finding).** The three existing drain sites
are NOT identical: `_handleBridgeDisconnected` (cli-process.js:3436)
truncates `pendingQueue` with `this.pendingQueue.length = 0` and never
rejects its items; `_doKill` (3473) and `resetSession` (3697) both walk
`pendingQueue`, skip entries already covered by `pendingTurns` (matched by
`turnId`), and explicitly `reject()` the rest (`resetSession`'s own
comment: entries can be "pushed by callers other than this.send"). This
fix follows the `_doKill`/`resetSession` shape, not
`_handleBridgeDisconnected`'s — truncating without rejecting would leak
orphaned promises, reproducing the exact silent-hang bug class this fix
exists to close. All three existing sites also set `this.inFlight = false`
after draining; this fix does the same (missing it would leave
`inFlight` stuck `true` on a session that can never produce another
reply).

Not in scope: startup-time detection (before the first `send()`). If
access is disabled before any turn starts, the existing startup-gate /
dialog-timeout paths apply and are a different symptom with an existing
(if generic) error code. This spec only closes the mid-turn gap the
diagnosis describes.

## The regex

```js
const AUTH_DISABLED_RE =
  /organization\s+has\s+disabled\s+Claude\s+subscription\s+access\s+for\s+Claude\s+Code/i;
```

Anchored on the *exact*, distinctive middle clause of Anthropic's fixed
product string, not the full sentence (avoids the `·` bullet/separator,
which could be rendered inconsistently) and not the "use an Anthropic API
key instead" clause (which is generic advice someone could plausibly type
in unrelated conversation — the seed regex from the hand-off note used it
as a standalone alternative, which is the false-positive risk called out
in the task; this spec drops that alternative). `\s+` (not literal spaces)
tolerates any pane rewrap artifacts even though `captureWide` already
passes `-J` (join-wrapped) to tmux.

This phrase is Anthropic product copy naming both "Claude subscription
access" and "Claude Code" together in a disablement sentence — not
something a legitimate assistant reply would casually construct while
answering a user's question about API keys. Verified against real
production reports (GitHub issues #63886, #62722, #68212) — same string in
every report, not account-specific interpolation.

**False-positive check performed:** a legitimate reply like *"you can use
an Anthropic API key instead of your Claude subscription for that"* does
not match — it doesn't contain "disabled ... Claude Code" in that shape.
Covered by a negative test case (below).

**Residual false-positive: verbatim quoting (review finding, mitigated
above, not eliminated by regex alone).** A user debugging *this exact
issue* could paste the real string and ask Claude to explain it, and a
healthy Claude reply might echo it back. The regex cannot distinguish
"this is happening to me" from "here's what that message means" — no
regex can, the distinguishing signal is behavioral (does the turn go on to
resolve normally?), not textual. That's what the bounded-tail +
two-consecutive-poll debounce above defends against, not the regex shape.
Residual risk after mitigation: a session would have to (a) have this
exact phrase land in the last ~40 captured lines, (b) on two consecutive
5s-apart polls, (c) while the turn genuinely has not yet `Stop`-resolved
both times — a narrow enough window that it's an acceptable trade for
closing a 10-minute silent production hang. Blast radius if it ever does
mis-fire: self-scoped to that one chat's one turn (own pane, own
`pendingTurns`) — not a cross-tenant or cross-session amplification.

## The AUTH_DISABLED contract

- `err.code = 'AUTH_DISABLED'` on the rejection every currently-pending
  `send()` promise receives.
- `err.message` — human-readable, includes the detected pane excerpt
  is *not* included (see security note below) — just a static description.
- Emitted alongside the reject: `this.emit('auth-disabled-detected', {
  sessionId, backend })` (telemetry parity with `mid-turn-dialog-detected`)
  and `this._logEvent('cli-auth-disabled-detected', { pending_count })`
  (parity with the existing `cli-mid-turn-dialog-detected` telemetry row).
- `emit('idle')` fires before the rejections resolve, so a wired
  `HeartbeatReactor` stops cycling (Step E contract, pinned by existing
  tests for the other drain paths).
- The underlying `claude` process and tmux session are **not** killed and
  the session is **not** reset (`claudeSessionId` untouched) — mirrors
  `TURN_TIMEOUT`'s behavior, not `resetSession`'s. Killing/resetting is a
  policy decision (notify admin? pause the chat? wait for the org to
  re-enable?) that belongs to the consumer, not to the shared engine.
- water and polygram add `AUTH_DISABLED` as a `CODES` short-circuit in
  their own `classify()` (out of scope for this repo/PR — happening in
  parallel per the task).
- **Consumer backoff requirement (review finding, documented here since
  it's a cross-repo coordination point, not enforceable from this repo):**
  `AUTH_DISABLED` means the *account* is blocked, not the request — an
  immediate automatic retry will hit the same wall. Because
  `_pollMidTurnDialogs`'s only gate is `pendingTurns.size > 0`, a consumer
  that retries into the same session on catch will get rejected again on
  the next poll (≤5s), not instantly — this is not a busy-loop on
  orchestra's side (poll cadence is fixed, independent of `pendingTurns`
  churn) — but it is repeated wasted `send()` calls against a
  known-disabled account. water/polygram should treat `AUTH_DISABLED` as
  non-retryable (surface to the operator / admin, don't auto-resend) the
  same way they'd treat `AUTH_EXPIRED` today.
- The rejection `err.message` is a static, generic description — it does
  **not** include the captured pane excerpt. This mirrors the L13
  incident precedent already in this file (cli-process.js:1206-1210):
  logging raw pane/reply content at default log levels previously leaked
  private chat content into the log sink unconditionally. The matched
  string here is fixed Anthropic product copy with no user content, so
  there's nothing account-specific to lose by omitting it — but the
  precedent is why the omission is deliberate, not an oversight.

## orchestra's own `lib/error/classify.js` — decision

**Decision: no entry added.** Investigated and confirmed:
`lib/error/classify.js` is `require`d by exactly one file in this repo,
`lib/process/sdk-process.js` (only `isTransientHttpError`, for the SDK
backend's own retry-once decision on `SDKResultMessage`/`SDKAssistantMessage`
errors). It is not `require`d by `cli-process.js`, not called anywhere on a
`CliProcess`-thrown error, and not re-exported from `index.js` (confirmed:
`index.js`'s `module.exports` has no `classify` key). Its existing
`TURN_TIMEOUT`/`TURN_MAX_EXCEEDED`/`BRIDGE_DISCONNECTED` entries are
already dead weight for any CliProcess consumer of *this* package — nothing
in-repo classifies a CliProcess error through this file today (those
entries are there for internal consistency / a hypothetical future shared
consumer, not because something calls them). Adding `AUTH_DISABLED` here
would look like it wires the contract up when it does not — actively
misleading. This is purely a downstream-consumer concern: water and
polygram each already maintain their own `classify()` and add the
`AUTH_DISABLED` case there, per the task's parallel work.

## Failure modes / edge cases considered

- **`_openQuestions.size > 0` gate**: `_pollMidTurnDialogs` returns early
  while an interactive `ask` is outstanding (pane shows the question text,
  not activity). If Anthropic disables access while a question is
  mid-flight, detection is delayed until the question resolves or times
  out. Pre-existing limitation shared with every other entry in
  `MID_TURN_PROMPTS` — not introduced by this change, not fixed by it.
  Documented, not addressed (out of scope; the question-timeout backstop
  already bounds this).
- **Multiple pending turns**: pane detection is process-wide (one pane, not
  attributable to a specific turn), same limitation the `Stop`-hook
  attribution comment (cli-process.js:2074) already documents for that
  path. All currently-pending turns are rejected — correct, since a
  disabled account can serve none of them.
- **Re-detection after reject**: no time-windowed dedup is used (unlike
  `MID_TURN_DEDUP_WINDOW_MS` for `MID_TURN_PROMPTS`). Once rejected,
  `pendingTurns` is empty, so `_pollMidTurnDialogs`'s
  `pendingTurns.size === 0` guard means the next poll no-ops. If the
  consumer resends into the same wedged session, the pane still shows the
  notice (nothing consumes it) and the new turn is rejected again on the
  next poll (≤5s) — correct, not a busy-loop (poll cadence is fixed at
  `PONG_CHECK_INTERVAL_MS`, unrelated to pendingTurns state).
- **Startup-time disablement** (before first `send()`): out of scope, see
  above.
- **Leaking the raw pane excerpt**: existing telemetry
  (`cli-mid-turn-unknown-prompt`) logs a pane excerpt for *unknown*
  prompts, by design, for operator triage. This detector's payload is
  intentionally minimal (no excerpt) — see the L13-precedent note in the
  contract section above.
- **Not a new abstraction**: this is the *fourth* near-identical
  reject-all-pending drain block in this file
  (`_handleBridgeDisconnected`, `_doKill`, `resetSession`, now this).
  Extracting a shared `_rejectAllPending(code, opts)` helper was
  considered and deliberately deferred — the four sites differ enough
  (queue-truncate-vs-reject, `emit('idle')` conditionality,
  `claudeSessionId` reset, tmux/bridge teardown) that a parameterized
  helper risks more complexity than the duplication it removes, and
  refactoring three already-working shutdown paths is out of scope for a
  bug fix whose stated purpose is adding one detector. Flagged here as a
  legitimate follow-up, not silently skipped.

## Test plan

New test in `tests/resume-dialog-fix.test.js`-style direct-invocation form
(mirrors the existing `B2-midturn` test, which already drives
`_pollMidTurnDialogs()` directly against a manually-set `pendingTurns`
entry — no fake-bridge harness needed):

1. **Red**: construct a `CliProcess` with a fake runner whose
   `captureWide` returns a pane string containing the exact Anthropic
   notice. Seed `pendingTurns` with one entry (`resolve`/`reject` stubs
   that record calls). Call `_pollMidTurnDialogs()` **twice** (mirroring
   the two-consecutive-poll debounce) against the *current, unfixed* code.
   Assert the pending turn is **not** rejected (`reject` never called,
   entry still in `pendingTurns`) — pins the current bug (silent hang
   toward the 10-min ceiling).
2. **Green**: same test, run again after the fix lands. Assert `reject`
   is NOT yet called after the first poll (armed, not confirmed), then IS
   called once after the second poll with `err.code === 'AUTH_DISABLED'`,
   `pendingTurns` is empty, `'idle'` was emitted, and both
   `auth-disabled-detected` was emitted and `cli-auth-disabled-detected`
   was passed to `_logEvent` (via a fake `db.logEvent` collector, same
   pattern as `resume-dialog-fix.test.js`'s `session-age-dialog-fallback`
   assertion).
3. **Single-poll match does not reject**: one poll with a match must not
   drain `pendingTurns` by itself — asserts the debounce is load-bearing,
   not a no-op.
4. **Debounce resets on a clean poll**: match on poll 1, no match on poll
   2 (pane changed / cleared), match again on poll 3 → still requires two
   *consecutive* matching polls from that point; poll 3 alone doesn't
   reject. Guards against an accumulating counter instead of a reset-on-miss
   flag.
5. **Negative / false-positive guard**: pane text containing a *legitimate*
   assistant reply mentioning API keys (e.g. "you can use an Anthropic API
   key instead of your Claude subscription for that automation") must
   **not** trigger detection across repeated polls — assert `reject` is
   never called and the pending turn survives.
6. **Bounded tail**: a pane where the notice sits *before* the last ~40
   lines (padded with ≥40 lines of unrelated trailing output) must **not**
   trigger — pins the tail-bounding behavior, not just "some substring
   match somewhere in 1000 lines."
7. **Multi-turn drain**: two pending turns, two consecutive confirming
   polls → both rejected with `AUTH_DISABLED`, both removed from
   `pendingTurns` and any matching `pendingQueue` rows.
8. **No same-poll interference**: on the confirming poll, assert no
   `sendControl` keystrokes were sent and no `mid-turn-unknown-prompt` /
   `mid-turn-dialog-detected` events fired — pins the early-`return` after
   the drain.
9. Existing `resume-dialog-fix.test.js` / `cli-process-integration.test.js`
   suites re-run green (no regression to the existing `MID_TURN_PROMPTS`
   catalog or `STREAMING_HINT_RE` heartbeat).
10. **`pendingQueue` drain** (added after test-coverage review flagged it as
    uncovered): a `pendingQueue` entry matching a rejected `turnId` must not
    be double-rejected; a `pendingQueue`-only entry (no matching
    `pendingTurns` row) must still be rejected with `AUTH_DISABLED` and
    removed. Guards against silently regressing to
    `_handleBridgeDisconnected`'s blunt `pendingQueue.length = 0`
    truncation, which would leak orphaned promises — every existing test
    up to that point would still pass under that regression; this is the
    one that would catch it.
11. **Stale-arm regression** (added after correctness review found the bug
    described above): turn A arms the debounce, is then manually cleared
    from `pendingTurns` (simulating a normal `Stop` resolution before the
    second poll), and an unrelated turn B is added. Turn B's first poll
    must NOT be rejected. Verified this test fails against the pre-fix
    code (which had the detector but not the early-return resets) while
    every other test in the file still passes — confirms it's the specific
    pin for this bug, not a duplicate of the existing debounce tests.

Per the repo owner's TDD discipline, the whole suite was run red (detector
absent) then green (detector added) for the initial cut, and the two
review-driven additions (10, 11) were each independently confirmed red
against the version of the code that predated their respective fix.
