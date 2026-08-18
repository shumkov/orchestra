// Content-free hook recorder for the U23 hook-trust characterization.
//
// Registered as the command handler for every characterized hook event. Hook
// stdin carries the user prompt, the workspace path, and the transcript path,
// so the payload is parsed in place and never written to disk. Only closed
// fields survive: the event name, whether a turn id was supplied, that turn
// id's digest, and the wall-clock reading used to order the hook against the
// app-server's own events.
//
// The recorder is invoked as
// `<node> <this file> <eventName> <captureDir>` and is the `shipped-artifact`
// half of the typed command descriptor; the Node runtime that executes it is
// the `system-runtime` half. Both are attested by digest before the command
// that names them is rendered.
//
// It never writes to stdout or stderr and always exits 0: a recorder failure
// must never block or alter the turn under characterization.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const RECORDED_EVENTS = Object.freeze([
  'sessionStart',
  'userPromptSubmit',
  'stop',
]);

// One file per invocation, so repeated fires are counted rather than
// overwritten by the last writer.
export const RECORDER_FILE_PATTERN = /^capture\.(\d+)\.(\d+)\.json$/;
export const RECORDER_RECORD_KEYS = 'eventName,observedAtMs,payloadParsed,turnIdPresent,turnIdSha256';

const MAX_STDIN_BYTES = 256 * 1024;

// The only projection that ever reaches disk. `payload` is discarded in the
// same frame that produces the record.
export function projectHookPayload({ eventName, payload, observedAtMs, overflowed }) {
  const recognized = RECORDED_EVENTS.includes(eventName) ? eventName : null;
  let parsed = null;
  // A payload that tripped the bound is rejected whole. Keeping the prefix
  // that arrived before the bound would let a well-formed opening object be
  // accepted with an arbitrary amount of unread payload behind it.
  if (overflowed !== true && typeof payload === 'string' && payload.length > 0) {
    try {
      const candidate = JSON.parse(payload);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate;
      }
    } catch {
      parsed = null;
    }
  }
  const turnId = typeof parsed?.turn_id === 'string' && parsed.turn_id.length > 0
    ? parsed.turn_id
    : null;
  return {
    eventName: recognized,
    observedAtMs,
    payloadParsed: parsed !== null,
    turnIdPresent: turnId !== null,
    turnIdSha256: turnId === null
      ? null
      : createHash('sha256').update(turnId).digest('hex'),
  };
}

export function recorderFileName(pid, sequence) {
  return `capture.${pid}.${sequence}.json`;
}

function readBoundedStdin() {
  return new Promise((resolve) => {
    let text = '';
    let bytes = 0;
    let overflowed = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ text, overflowed });
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STDIN_BYTES) {
        overflowed = true;
        text = '';
        process.stdin.destroy();
        finish();
        return;
      }
      text += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.on('close', finish);
  });
}

async function main() {
  // Stamped at entry, before stdin is drained. Draining waits on whoever is
  // writing, so a stamp taken afterwards measures the writer's generosity
  // rather than the moment the hook fired, and inflates every margin derived
  // from it.
  const observedAtMs = Date.now();
  const [eventName, captureDir] = process.argv.slice(2);
  // A recorder that cannot name its own output directory writes nothing; the
  // reader reports the capture as missing rather than inventing one.
  if (typeof captureDir !== 'string' || !path.isAbsolute(captureDir)) return;
  const { text, overflowed } = await readBoundedStdin();
  const record = projectHookPayload({
    eventName, payload: text, observedAtMs, overflowed,
  });
  const file = path.join(
    captureDir,
    recorderFileName(process.pid, process.hrtime.bigint().toString()),
  );
  try {
    writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Never surface a recorder failure into the turn.
  }
}

if (process.argv[1] && process.argv[1].endsWith('u23-hook-recorder.mjs')) {
  await main();
  process.exitCode = 0;
}
