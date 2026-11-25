# Codex app-server stdout backpressure

## Problem

`CodexAppServerClient._onStdoutData` splits each stdout chunk into JSONL
lines and queues every line on `messageChain`. It bounds that queue with
`maxQueuedLines` (256) and `maxQueuedBytes` (4 MiB) and calls
`child.stdout.pause()` once the queue is half full. But `pause()` only stops
*future* `data` events: the `while` loop keeps splitting the chunk it already
holds. One pipe chunk (64 KiB) of small notifications holds more than 256
lines, so the loop crosses the line cap inside a single chunk and faults the
client with `CODEX_PROTOCOL_ERROR: app-server inbound message queue exceeded
the size limit`.

Production: a command run by Codex printed fast output; the app-server sent
about 500 `item/commandExecution/outputDelta` notifications (~180 bytes each)
in one second, and the generation died with `CODEX_CONTAINMENT_FAILED` /
`app-server-fault`. The user sees "Codex could not verify this request's
durable outcome". Reproduced locally: one 49.8 KB chunk holding 300 delta lines
faults the client.

The queue caps exist to bound memory, not to reject legitimate bursts. Memory
is already bounded by `pause()`, as long as we stop splitting lines while the
queue is full.

## Approach

Check the caps once per chunk, not once per line.

- `pause()` inside a `data` handler reliably stops further `data` events, so
  splitting the chunk already in hand adds at most one chunk (64 KiB pipe
  read) on top of the queue. Memory stays bounded by half the caps plus one
  chunk plus one partial line (`maxLineBytes`), as it is today.
- `_onStdoutData`: before appending the chunk, fault with the existing
  queue-limit error only if the queue is already at or over `maxQueuedLines` /
  `maxQueuedBytes`. With a stream that honours `pause()` that cannot happen,
  because `data` only resumes once the queue is below half. It catches a
  stream that ignores `pause()`.
- Remove the per-line cap fault inside the split loop. Keep the half-full
  pause, `_resumeStdoutIfSafe`, the per-line and partial-line size checks and
  `_onStdoutEnd` unchanged.
- `_close()`: resume stdout when closing starts. `_onStdoutData` already
  discards data while closing; a paused pipe must not leave the app-server
  supervisor blocked on a full pipe while it should be handling stdin EOF.
  Bursts now pause stdout routinely, so cancelling during fast output would hit
  this.

## Alternatives rejected

- Stop splitting when the queue is full and keep the rest of the chunk in
  `stdoutBuffer`, draining it as the queue empties (first draft). Exact line
  bound, but it needs a drain loop, a new resume condition, end-of-stream
  draining and a separate hard bound, and reviewers found a stall (a line that
  fits `maxLineBytes` but not `maxQueuedBytes` with an empty queue) and a hard
  bound that faults on small configured caps. The one-chunk overshoot it
  avoids is already bounded.

- Raise `maxQueuedLines` (e.g. to 4096). Moves the cliff; a faster command or a
  bigger pipe chunk still kills the turn.
- Fault only on `maxQueuedBytes`, drop the line cap. Same cliff in bytes.
- Coalesce `outputDelta` notifications. Changes protocol semantics for one
  method and does not fix other bursts (e.g. `fileChange/outputDelta`).

## Failure modes

- Ordering is unchanged: every line of a chunk is queued in order.
- A stream without `pause()`, or one that ignores it, faults on the next chunk
  once the queue reaches its caps (unchanged error code and message).
- Close or fault while paused: `_close()` resumes stdout, and
  `_onStdoutData` drops data in `closing` / `closed` / faulted states.

## Tests

- Regression, deterministic: the existing caps test changes intent. Ten
  notifications in one write with `maxQueuedLines: 2`, and with
  `maxQueuedBytes: 256`, are all processed, the request resolves and the client
  stays healthy (red before the fix).
- Regression, production-shaped: 600 `item/commandExecution/outputDelta` lines
  in one write with default caps; the request resolves, the client stays
  healthy.
- A fake child (`spawnFn`) whose `stdout.pause()` does nothing, with a
  notification handler held pending, faults with `CODEX_PROTOCOL_ERROR` once a
  further chunk arrives over the caps.
