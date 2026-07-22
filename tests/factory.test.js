'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('../index');
const { createProcessFactory } = require('../lib/process/factory');

// Minimal fakes so the 'cli' backend wiring is satisfied and the factory
// actually constructs a CliProcess (rather than logging "not wired" and
// falling back to SDK). Shapes match lib/tmux/tmux-runner.js + the
// toolDispatcher contract. Nothing is started, so no method fires here.
const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => 'Listening for channel messages from: server:orchestra-bridge',
};
const fakeDispatcher = async () => ({ ok: true });
const quietLogger = { warn: () => {}, error: () => {}, log: () => {} };

// Base wiring shared by every factory in this file. displayHint is layered on
// per-test. pmDefault:'cli' + empty config → every spawn routes to CliProcess.
function makeFactory(displayHint) {
  return createProcessFactory({
    config: { chats: {} },
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: quietLogger,
    displayHint,
    pmDefault: 'cli',
  });
}

test('displayHint function is resolved per spawn with (chatId, threadId, config)', () => {
  const config = { chats: {} };
  const calls = [];
  const resolver = (chatId, threadId, cfg) => {
    calls.push([chatId, threadId, cfg]);
    return `hint for ${chatId}/${threadId}`;
  };

  const factory = createProcessFactory({
    config,
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: quietLogger,
    displayHint: resolver,
    pmDefault: 'cli',
  });

  const proc = factory('session-1', { chatId: '123', threadId: '77', label: 'chat-a' });

  assert.ok(proc instanceof CliProcess, 'should construct a CliProcess');
  // The resolver ran once, with the spawning chat/topic and the closed-over config.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['123', '77']);
  assert.equal(calls[0][2], config, 'resolver receives the factory config object');
  // The CliProcess got the RESOLVED string — not the function, not a fallback.
  assert.equal(proc.displayHint, 'hint for 123/77');
  assert.equal(typeof proc.displayHint, 'string');
});

test('displayHint function resolves independently for each chat/topic', () => {
  const factory = makeFactory((chatId) => (chatId === 'rich' ? 'RICH TEXT ON' : ''));

  const rich = factory('s-rich', { chatId: 'rich', threadId: null });
  const plain = factory('s-plain', { chatId: 'plain', threadId: null });

  assert.equal(rich.displayHint, 'RICH TEXT ON');
  assert.equal(plain.displayHint, '');
});

test('displayHint string is forwarded unchanged (back-compat)', () => {
  const factory = makeFactory('static hint for all chats');

  const proc = factory('session-2', { chatId: '456', threadId: null, label: 'chat-b' });

  assert.ok(proc instanceof CliProcess);
  assert.equal(proc.displayHint, 'static hint for all chats');
});

test('displayHint default (omitted) is empty string', () => {
  const factory = createProcessFactory({
    config: { chats: {} },
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: quietLogger,
    pmDefault: 'cli',
  });

  const proc = factory('session-3', { chatId: '789', threadId: null });
  assert.equal(proc.displayHint, '');
});
