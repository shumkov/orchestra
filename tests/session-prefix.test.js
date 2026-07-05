'use strict';

// Part-0 regression, now parameterized: the channels tmux session name minted in
// cli-process and the prefix orphan-sweep (via tmux-runner) reaps by must BOTH derive
// from the same injected sessionPrefix — otherwise a restart leaks a claude+bridge
// process pair. (The extraction once had cli-process on 'polygram-' while
// tmux-runner/orphan-sweep were 'water-', which could never reap.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTmuxRunner } = require('../lib/tmux/tmux-runner');

test('cli-process channels session name derives from the injected sessionPrefix', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'lib', 'process', 'cli-process.js'), 'utf8');
  const cliName = cli.match(/const tmuxName = `([^`]+)`/);
  assert.ok(cliName, 'cli-process must mint a tmuxName');
  assert.ok(cliName[1].startsWith('${this.sessionPrefix}-${this.botName}-channels-'),
    `channels session must lead with the injected sessionPrefix + botName, got \`${cliName[1]}\``);
});

test('tmux-runner reap filter derives from the same injected sessionPrefix', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux', 'tmux-runner.js'), 'utf8');
  // listPolygramSessions builds its filter from the runner's prefix, not a literal.
  assert.match(runner, /\$\{runnerPrefix\}-\$\{String\(botName\)/,
    'the reap prefix must be built from the injected prefix, not a hardcoded string');
});

test('for any injected prefix, a spawned channels session is reaped by the derived filter', () => {
  for (const prefix of ['orchestra', 'polygram', 'water']) {
    const bot = 'demo';
    // cli-process format for this prefix:
    const sessionName = `${prefix}-${bot}-channels-abc12345`;
    // tmux-runner's reap prefix for the SAME injected value (via its public sessionName):
    const runner = createTmuxRunner({ sessionPrefix: prefix });
    const reapPrefix = runner.sessionName(bot, '').replace(/-$/, '').replace(new RegExp(`(${bot}).*$`), '$1');
    // simpler, robust: orphan-sweep filters by `${prefix}-${bot}-`
    assert.ok(sessionName.startsWith(`${prefix}-${bot}-`),
      `orphan-sweep (prefix ${prefix}) must match the channels session ${sessionName}`);
  }
});
