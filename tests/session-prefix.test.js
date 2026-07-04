'use strict';

// Part-0 regression: the channels tmux session name minted in cli-process must share
// the prefix that orphan-sweep (via tmux-runner) reaps by — otherwise a restart leaks a
// claude+bridge process pair. cli-process was 'polygram-' while tmux-runner/orphan-sweep
// were 'water-'; this pins the agreement.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('cli-process channels session prefix agrees with tmux-runner/orphan-sweep prefix', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'lib', 'process', 'cli-process.js'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux', 'tmux-runner.js'), 'utf8');

  // the channels session template in cli-process
  const cliName = cli.match(/const tmuxName = `([^`]+)`/);
  assert.ok(cliName, 'cli-process must mint a tmuxName');
  const cliPrefix = cliName[1].split('${')[0]; // literal prefix before the first interpolation
  // the reap prefix in tmux-runner's session listing
  const runnerPrefix = runner.match(/`([a-z-]+)\$\{String\(botName\)/)?.[1] || runner.match(/`([a-z-]+)\$\{botName\}/)?.[1];
  assert.ok(runnerPrefix, 'tmux-runner must define a session prefix');

  assert.equal(cliPrefix, runnerPrefix,
    `channels session prefix "${cliPrefix}" must equal orphan-sweep prefix "${runnerPrefix}" or restarts leak sessions`);
});

test('a spawned channels session name would be reaped by the derived prefix filter', () => {
  const bot = 'demo';
  const sessionName = `water-${bot}-channels-abc12345`; // the cli-process format
  const reapPrefix = `water-${bot}-`;                    // the orphan-sweep filter
  assert.ok(sessionName.startsWith(reapPrefix), 'orphan-sweep must match the channels session');
});
