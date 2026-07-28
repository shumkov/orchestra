// provenance: polygram@0.17.11 lib/tmux/orphan-sweep.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Boot-time tmux orphan sweep — kill any `<sessionPrefix>-<botName>-*` tmux
 * sessions left over from a prior daemon.
 *
 * Why this exists:
 *   - `lib/process-guard.js#claimPidFile` (rc.50) kills the prior
 *     polygram daemon at boot, but tmux sessions OUTLIVE their parent
 *     process — they're owned by the tmux server, not by polygram.
 *   - When the new daemon's TmuxProcess.start() tries to spawn a
 *     session with the bot-prefixed name, `tmux new-session` fails
 *     with EEXIST because the old session is still there.
 *   - The old session is unrecoverable: claudeSessionId is fresh per
 *     turn, the daemon writing to JSONL was SIGKILLed mid-turn, and
 *     any user-visible reply was already lost to the dead daemon.
 *
 * Strategy: list, kill, log. Best-effort — if tmux isn't running or
 * the kill races a concurrent operator, swallow the error and proceed.
 *
 * @see lib/process-guard.js (claimPidFile)
 * @see lib/tmux/tmux-runner.js (listPolygramSessions, killSession)
 */

'use strict';

const { createTmuxRunner } = require('./tmux-runner');

/**
 * Sweep all `<sessionPrefix>-<botName>-*` tmux sessions on the host (prefix from the runner).
 *
 * @param {object} opts
 * @param {string} opts.botName       — only sweep sessions for THIS bot
 * @param {object} [opts.runner]      — injected TmuxRunner (for tests)
 * @param {string} [opts.socketName]  — dedicated tmux server to enumerate, when
 *   no runner is injected. Must match the caller's own runner.
 * @param {object} [opts.logger=console]
 * @returns {Promise<{ swept: string[], errors: Array<{name:string, error:string}>,
 *   listFailed: boolean, listError?: string }>} `listFailed` is true when the
 *   host could not be enumerated at all — distinct from an empty `swept`, which
 *   means the host was reachable and genuinely had no orphans.
 */
async function sweepTmuxOrphans({
  botName, runner, logger = console, socketName = null,
} = {}) {
  if (!botName) throw new TypeError('sweepTmuxOrphans: botName required');
  // SECURITY (audit M2): dashes in bot names risk prefix-match
  // collision when two bots share a prefix (e.g. `shumabit` matches
  // `water-shumabit-prod-*` too). Warn so the operator can rename.
  // The trailing `-` in the listPolygramSessions filter prevents an
  // exact-prefix collision but DOES NOT prevent `shumabit` vs
  // `shumabit-prod`. Defense-in-depth: surface it.
  if (typeof botName === 'string' && botName.includes('-')) {
    logger.warn?.(
      `[orphan-sweep] bot name "${botName}" contains '-'; orphan-sweep `
      + `prefix matching could collide with other bot names sharing a `
      + `prefix. Consider renaming (e.g. use _ instead).`,
    );
  }
  // The fallback runner must target the SAME tmux server the caller uses.
  // Without forwarding socketName it would enumerate the default socket while
  // the app's sessions live on a dedicated one — finding nothing and reporting a
  // clean host, which is the very fail-open this function was hardened against.
  const r = runner || createTmuxRunner({ logger, socketName });
  let names;
  try {
    names = await r.listPolygramSessions(botName, { strict: true });
  } catch (err) {
    // "Could not ask" is NOT "nothing to sweep". Enumerating strictly and
    // reporting the failure lets the caller decide: with a dedicated socket and
    // `-N`, an unreachable server means the tmux unit never came up, and booting
    // on would leave the daemon blind to sessions it is supposed to own.
    logger.warn?.(`[orphan-sweep] list-sessions failed (${err.message}); cannot determine whether orphans exist`);
    return { swept: [], errors: [], listFailed: true, listError: err.message };
  }
  if (names.length === 0) {
    logger.log?.(`[orphan-sweep] no orphan tmux sessions for ${botName}`);
    return { swept: [], errors: [], listFailed: false };
  }
  logger.log?.(`[orphan-sweep] killing ${names.length} orphan tmux session(s): ${names.join(', ')}`);
  const errors = [];
  const swept = [];
  for (const name of names) {
    try {
      // strict: this loop REPORTS what it reaped. Non-strict killSession
      // resolves even when tmux refused, so every session would be logged as
      // swept and the `errors` array below could never be populated — a stale
      // session then survives and collides with the next spawn of that name.
      await r.killSession(name, { strict: true });
      swept.push(name);
    } catch (err) {
      errors.push({ name, error: err.message });
      logger.warn?.(`[orphan-sweep] kill ${name} failed: ${err.message}`);
    }
  }
  return { swept, errors, listFailed: false };
}

module.exports = { sweepTmuxOrphans };
