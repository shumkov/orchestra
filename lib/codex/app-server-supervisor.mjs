import { spawn } from 'node:child_process';

const [binary, ...args] = process.argv.slice(2);
if (!binary) process.exit(64);

const child = spawn(binary, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.stdin.on('error', () => {});

let childExited = false;
let outputEnded = false;

function finishChild() {
  if (childExited) return;
  childExited = true;
  if (!outputEnded) {
    outputEnded = true;
    process.stdout.end();
  }
}

child.once('error', finishChild);
child.once('close', finishChild);
child.stdout.once('error', finishChild);
child.stderr.once('error', finishChild);

// The supervisor remains the owned process-group leader while the parent
// verifies that Codex and every descendant have left the group.
process.on('SIGTERM', () => {});
process.on('SIGUSR1', () => {
  if (childExited) process.exit(0);
});

setInterval(() => {}, 60_000);
