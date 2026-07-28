import { spawn } from 'node:child_process';

const GRACE_FLAG = '--group-term-grace-ms=';
const argv = process.argv.slice(2);
const graceMs = argv[0]?.startsWith(GRACE_FLAG)
  ? Number(argv.shift().slice(GRACE_FLAG.length))
  : Number.NaN;
const [binary, ...args] = argv;
if (!binary || !Number.isSafeInteger(graceMs) || graceMs < 0) process.exit(64);

const child = spawn(binary, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let childGone = false;
let terminating = false;
let graceTimer = null;

// Signalling our own group is safe precisely because we are its live leader:
// unlike the parent, we cannot have exited between deciding to signal and
// signalling, so the group id cannot have been recycled underneath the call.
function signalOwnGroup(signal) {
  try { process.kill(-process.pid, signal); } catch {}
}

// SIGKILL reaches this process too, so it is the last thing we do. The exit is
// only reached if the signal could not be sent, and the parent's read-only
// proof is what catches that.
function terminateGroup() {
  if (graceTimer !== null) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  signalOwnGroup('SIGKILL');
  process.exit(0);
}

function shutdown() {
  if (terminating) return;
  terminating = true;
  if (childGone) {
    terminateGroup();
    return;
  }
  signalOwnGroup('SIGTERM');
  graceTimer = setTimeout(terminateGroup, graceMs);
}

// Piped, so the app-server's own read rate applies backpressure to ours. The
// pipe must not end the child's stdin for us, because we end it deliberately
// on EOF below.
process.stdin.pipe(child.stdin, { end: false });

// The parent ending stdin — or dying — is the shutdown request. The parent
// never signals the group, so this is the only path that ends it. Ending the
// child's stdin hands the app-server its own EOF alongside the group signal.
function onParentStdinEnd() {
  try { child.stdin.end(); } catch {}
  shutdown();
}

process.stdin.once('end', onParentStdinEnd);
process.stdin.once('close', onParentStdinEnd);

child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.stdin.on('error', () => {});
child.stdout.once('error', () => {});
child.stderr.once('error', () => {});
// 'error' can arrive post-spawn — an abort, a failed kill, a failed message
// send — while the child is still running, so it proves nothing. 'close' is the
// only report of a gone child, and a failed spawn closes too.
child.once('error', () => {});

child.once('close', () => {
  childGone = true;
  // The pipe does not detach itself from a dead child's stdin, and while it
  // stays attached our stdin never surfaces EOF — which would lose the only
  // shutdown signal we have whenever the app-server exits before the parent
  // closes, stranding us as a permanent group leader. Detaching by hand and
  // resuming restores that; with the child gone the drained bytes have nowhere
  // to go and are discarded.
  process.stdin.unpipe(child.stdin);
  process.stdin.resume();
  process.stdout.end();
  if (terminating) terminateGroup();
});

// We must outlive the group we lead, so we ignore the TERM we send it.
process.on('SIGTERM', () => {});

setInterval(() => {}, 60_000);
