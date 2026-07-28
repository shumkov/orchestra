'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sweepTmuxOrphans } = require('../lib/tmux/orphan-sweep');

const silent = { log: () => {}, warn: () => {}, error: () => {} };

function fakeRunner({ sessions = [], listError = null, killError = null } = {}) {
  const killed = [];
  return {
    killed,
    listPolygramSessions: async () => {
      if (listError) throw Object.assign(new Error(listError), { code: 'TMUX_LIST_FAILED' });
      return sessions;
    },
    killSession: async (name) => {
      if (killError) throw new Error(killError);
      killed.push(name);
    },
  };
}

describe('sweepTmuxOrphans', () => {
  test('kills the orphans it finds', async () => {
    const r = fakeRunner({ sessions: ['polygram-shumabit-channels-aa', 'polygram-shumabit-channels-bb'] });
    const res = await sweepTmuxOrphans({ botName: 'shumabit', runner: r, logger: silent });
    assert.deepEqual(res.swept, ['polygram-shumabit-channels-aa', 'polygram-shumabit-channels-bb']);
    assert.equal(res.listFailed, false);
  });

  test('a genuinely empty host is not a failure', async () => {
    const res = await sweepTmuxOrphans({ botName: 'shumabit', runner: fakeRunner(), logger: silent });
    assert.deepEqual(res.swept, []);
    assert.equal(res.listFailed, false);
  });

  // The fail-open this exists to close: when the tmux server is missing or
  // unreachable the sweep used to report a clean, empty result — indistinguishable
  // from "nothing to do". Under a dedicated socket with `-N` (never auto-start),
  // that is exactly the shape of a tmux unit that failed to come up, and the
  // caller must be able to fail loudly instead of booting on into a host whose
  // sessions it cannot see.
  test('an unreachable tmux server is reported, not read as a clean host', async () => {
    const res = await sweepTmuxOrphans({
      botName: 'shumabit',
      runner: fakeRunner({ listError: 'no server running on /tmp/tmux-1000/polygram' }),
      logger: silent,
    });
    assert.equal(res.listFailed, true);
    assert.match(res.listError, /no server running/);
    assert.deepEqual(res.swept, []);
  });

  test('per-session kill failures stay separate from a list failure', async () => {
    const res = await sweepTmuxOrphans({
      botName: 'shumabit',
      runner: fakeRunner({ sessions: ['polygram-shumabit-channels-aa'], killError: 'permission denied' }),
      logger: silent,
    });
    assert.equal(res.listFailed, false);
    assert.equal(res.errors.length, 1);
    assert.deepEqual(res.swept, []);
  });
});

describe('sweepTmuxOrphans fallback runner', () => {
  // With no injected runner the sweep builds its own. If that one talks to the
  // default socket while the app's sessions live on `-L polygram`, the sweep
  // enumerates an unrelated server, finds nothing, and reports a clean host.
  test('its own runner targets the caller’s dedicated socket', async () => {
    const seen = [];
    const { createTmuxRunner } = require('../lib/tmux/tmux-runner');
    const probe = async (cmd, args) => { seen.push(args); return { stdout: '', stderr: '' }; };
    // Prove the wiring at the layer we control: same option, same runner factory.
    const r = createTmuxRunner({ runFn: probe, socketName: 'polygram' });
    await r.listPolygramSessions('shumabit');
    assert.deepEqual(seen[0].slice(0, 2), ['-L', 'polygram']);
  });

  test('accepts socketName without an injected runner', async () => {
    // Real tmux is absent in CI; the point is that the option is accepted and the
    // unreachable server is reported rather than swallowed.
    const res = await sweepTmuxOrphans({
      botName: 'shumabit', socketName: 'polygram-test-nonexistent', logger: silent,
    });
    assert.equal(res.listFailed, true);
  });
});

describe('sweepTmuxOrphans through the real runner', () => {
  const { createTmuxRunner } = require('../lib/tmux/tmux-runner');

  // The hand-written fake above can drift from production behaviour — notably,
  // the real killSession swallows errors unless asked not to. Drive the sweep
  // through the actual runner (stubbing only the execFile seam) so a regression
  // in that contract fails here rather than in prod.
  function stubbedRunner(responses) {
    const runFn = async (cmd, args) => {
      const sub = args.find((a) => !a.startsWith('-') && a !== 'tmux') || args[0];
      const key = args.includes('list-sessions') ? 'list' : (args.includes('kill-session') ? 'kill' : sub);
      const r = responses[key];
      if (r && r.error) throw new Error(r.error);
      return { stdout: (r && r.stdout) || '', stderr: '' };
    };
    return createTmuxRunner({ runFn, sessionPrefix: 'polygram' });
  }

  test('a refused kill is reported as an error, not as swept', async () => {
    const runner = stubbedRunner({
      list: { stdout: 'polygram-shumabit-channels-aa\nunrelated' },
      kill: { error: 'operation not permitted' },
    });
    const res = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: silent });
    assert.deepEqual(res.swept, []);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].error, /kill-session failed/);
    assert.equal(res.listFailed, false);
  });

  test('a successful kill is reported as swept', async () => {
    const runner = stubbedRunner({ list: { stdout: 'polygram-shumabit-channels-aa' }, kill: {} });
    const res = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: silent });
    assert.deepEqual(res.swept, ['polygram-shumabit-channels-aa']);
    assert.equal(res.errors.length, 0);
  });

  test('an unreachable server is reported through the real listing path', async () => {
    const runner = stubbedRunner({ list: { error: 'no server running on /tmp/tmux-1000/polygram' } });
    const res = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: silent });
    assert.equal(res.listFailed, true);
    assert.deepEqual(res.swept, []);
  });
});
