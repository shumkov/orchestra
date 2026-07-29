# Linux tracked-terminal host PID resolution

## Problem

The Codex U1a checker asks a sandboxed command to write `$$` before it becomes
`/bin/sleep 120`. On Linux that value belongs to the sandbox PID namespace. It
is not safe to pass to host-side `kill(pid, 0)`: namespace PID 3 can identify an
unrelated host process and produce `EPERM`, or give a misleading liveness
result.

The app-server process spawned by `AppServerConnection` has a known host PID.
The tracked sleep must be identified only inside that process's descendant
tree.

## Chosen approach

Darwin continues to treat the marker as the host PID and uses the existing
`kill(pid, 0)` liveness behavior.

On Linux, the checker:

1. Before starting the turn, records the `AppServerConnection` child host PID
   and its `/proc/<pid>/stat` start time, and records `/bin/sleep` device and
   inode identity. It also generates a per-invocation random token which the
   synthetic shell exports before executing sleep.
2. Enumerates at most 65,536 numeric `/proc` entries. PIDs are canonical
   decimal values from 2 through 2,147,483,647.
3. Reads at most 4,096 bytes from each `/proc/<pid>/stat`, parsing around the
   final `") "` delimiter. The directory PID must equal stat field 1; parent
   PID and start time must be canonical decimal strings. Duplicate records,
   cycles, more than 65,536 graph nodes, or ancestry deeper than 256 stop the
   checker.
4. Builds the host parent tree rooted at the fingerprinted app-server PID,
   whose start time must remain unchanged.
5. Reads at most 65,536 bytes each of NUL-delimited
   `/proc/<pid>/cmdline` and `/proc/<pid>/environ` evidence without trimming or
   text normalization. A candidate must have argv exactly equal to
   `["/bin/sleep", "120"]` and exactly one environment entry carrying the
   current invocation token. This prevents an older matching sleep in the same
   app-server tree from satisfying the new command's gate.
6. Requires `/proc/<pid>/exe` for that candidate to have the same device and
   inode as the pre-attested `/bin/sleep`.
7. Re-reads stat for the candidate and every ancestor through the app-server
   root after command-line and executable inspection. Every PID, parent PID,
   and start time must match the snapshot.
8. Records the selected host PID and its stat start time as the tracked process
   identity. Every later liveness check re-reads stat. A missing process or
   state `Z`, `X`, or `x` is dead; a matching non-dead start time is alive; PID
   reuse, malformed data, or unreadable required evidence is an error.

The initial resolution is retried only for a bounded interval because the
marker write immediately precedes `exec /bin/sleep`. Each attempt receives the
same absolute monotonic deadline and a cumulative proc-evidence byte budget;
both are checked throughout enumeration and after every required read.
Ambiguity, an exhausted work bound, or invalid proc evidence fails immediately.
Zero matches or an owned process disappearing during inspection retries from a
fresh snapshot every 100 ms for at most 5 seconds. A numeric proc entry that
disappears before its initial stat can be omitted from that point-in-time
snapshot; permission errors and malformed records fail immediately.

The proc enumerator and readers are injected into the exported selection
helpers so the Linux contract is unit-testable without a live Linux procfs.
Linux never calls `kill(0)` with either the namespace marker or the resolved
host PID. Cleanup remains the app-server background-terminal clean request and
the command's bounded self-expiry.

## Alternatives rejected

- Mapping the namespace marker globally through `NSpid` is broader than needed
  and can match processes outside the owned app-server tree. `NSpid` alone also
  cannot distinguish separate sandbox namespaces that reuse the same inner
  PID.
- Using the app-server process group does not prove which descendant is the
  exact synthetic sleep.
- Changing the sandbox command to expose a host PID crosses the isolation
  boundary and changes the live-verified probe instead of correcting the
  host-side checker.
- Treating `EPERM` as alive would preserve the namespace/host identity bug and
  could observe an unrelated process.

## Failure modes

The checker stops on a missing app-server root, zero or multiple matching sleep
descendants, duplicate or malformed proc records, a process-scan bound breach,
an aggregate evidence-budget or deadline breach, unreadable required stat,
command-line, environment, or executable evidence, invocation-token mismatch,
executable identity drift, an inconsistent ancestry chain, or a start-time
mismatch that indicates PID reuse. Processes that disappear before their
initial stat record can be read are omitted from that point-in-time snapshot;
the known root and every selected descendant remain mandatory. Cleanup is
still attempted when resolution fails, but no Linux error path signals a
process directly.

## Verification

Focused unit coverage must reproduce namespace PID 3 causing legacy host
`kill(0)` to throw `EPERM`, then prove:

- Linux selects the unique exact sleep beneath the app-server host PID and
  ignores unrelated host processes, including host PID 3.
- An older exact sleep beneath the same app-server cannot match a new
  invocation's token.
- Cleanup/death detection uses the selected host PID and matching start time.
- Zero and multiple matches fail closed.
- A reused PID, zombie state, changed ancestry, executable mismatch, malformed
  stat, or unreadable required proc file fails closed.
- Per-file, process-count, aggregate-byte, and absolute-deadline bounds are
  enforced.
- Darwin still uses the marker PID and existing `kill(0)` semantics.

The complete Codex spike test and full package suite must pass after the
focused regression turns green.
