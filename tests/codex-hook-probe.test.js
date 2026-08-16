'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const probeUrl = pathToFileURL(path.resolve(
  __dirname,
  '../scripts/spikes/codex-app-server-hook-probe.mjs',
)).href;

function hookPair(eventName) {
  return {
    eventName,
    startedStatus: 'running',
    completedStatus: 'completed',
    orderedStartThenComplete: true,
    startedAtIsSeconds: true,
    completedAtIsSeconds: true,
    notificationCount: 2,
    notificationTurnIdMatchesRawTurn: true,
  };
}

function passingEvidence(overrides = {}) {
  return {
    pinnedBinaryAttested: true,
    isolatedCodexHomeMode0700: true,
    credentialFree: { authFileAbsent: true, providerRequiresAuth: false },
    trustLifecycle: {
      discoveredUntrusted: true,
      renderedTrusted: true,
      mutatedHashChanged: true,
      mutatedStatusModified: true,
      configDigestUnchangedOnMutation: true,
      reRenderedDigestChanged: true,
      reRenderedTrusted: true,
    },
    authoritative: {
      source: 'production-client',
      turnStatus: 'completed',
      assistantItemObserved: true,
      faultCategory: null,
      turnStartResponseMatchesStarted: true,
      completedTurnMatchesStarted: true,
      deliveredHookMethods: [],
    },
    control: {
      source: 'production-client',
      turnStatus: 'completed',
      assistantItemObserved: true,
      faultCategory: null,
      turnStartResponseMatchesStarted: true,
      completedTurnMatchesStarted: true,
      deliveredHookMethods: [],
    },
    hookEvents: ['sessionStart', 'userPromptSubmit'],
    hookPairs: [hookPair('sessionStart'), hookPair('userPromptSubmit')],
    hookStdin: {
      sessionStart: 'present-without-turn-id',
      userPromptSubmit: 'matches-authoritative-turn',
    },
    ownedConfigDigestStable: true,
    ...overrides,
  };
}

test('hook probe gate passes only on complete authoritative evidence', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  const result = evaluateHookProbeGate(passingEvidence());
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.gate, 'CONTINUE');
});

// The gate exists to prove the production notification boundary. Evidence from
// the independent spike transport is not that boundary.
test('a spike-only client cannot stand in for the production lane', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const source of ['spike-client', 'raw-stdio', undefined]) {
    const evidence = passingEvidence();
    evidence.authoritative = { ...evidence.authoritative, source };
    assert.deepEqual(
      evaluateHookProbeGate(evidence).failedChecks,
      ['authoritativeLaneIsProductionClient'],
      `source ${String(source)} must not satisfy the authoritative lane`,
    );
  }
});

test('the authoritative lane must observe a completed turn with an assistant item', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const overrides of [
    { turnStatus: 'failed' },
    { turnStatus: null },
    { assistantItemObserved: false },
    { faultCategory: 'protocol' },
  ]) {
    const evidence = passingEvidence();
    evidence.authoritative = { ...evidence.authoritative, ...overrides };
    assert.deepEqual(
      evaluateHookProbeGate(evidence).failedChecks,
      ['authoritativeTurnCompleted'],
    );
  }
});

test('the authoritative lane must correlate all three turn identities', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const key of ['turnStartResponseMatchesStarted', 'completedTurnMatchesStarted']) {
    const evidence = passingEvidence();
    evidence.authoritative = { ...evidence.authoritative, [key]: false };
    assert.deepEqual(
      evaluateHookProbeGate(evidence).failedChecks,
      ['authoritativeTurnIdentityConsistent'],
    );
  }
});

// The secondary raw observation characterizes dropped payloads only. A healthy
// raw turn must never compensate for an authoritative lane that did not finish.
test('a successful raw lane cannot rescue a failed authoritative lane', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  const evidence = passingEvidence();
  evidence.authoritative = { ...evidence.authoritative, turnStatus: 'failed' };
  const result = evaluateHookProbeGate(evidence);
  assert.equal(result.gate, 'STOP');
  assert.ok(result.failedChecks.includes('authoritativeTurnCompleted'));
});

test('no hook notification may reach the production delivered sink', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  const evidence = passingEvidence();
  evidence.authoritative = {
    ...evidence.authoritative,
    deliveredHookMethods: ['hook/started'],
  };
  assert.deepEqual(
    evaluateHookProbeGate(evidence).failedChecks,
    ['authoritativeHookSinkClean'],
  );
});

// Nonempty hook traffic is not the bar: the exact configured multiset is.
test('the exact configured hook event set is required', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  const oneEvent = passingEvidence({
    hookEvents: ['userPromptSubmit'],
    hookPairs: [hookPair('userPromptSubmit')],
    hookStdin: { userPromptSubmit: 'matches-authoritative-turn' },
  });
  const result = evaluateHookProbeGate(oneEvent);
  assert.equal(result.gate, 'STOP', 'one event with a valid pair must not pass');
  assert.ok(result.failedChecks.includes('hookEventSetExact'));

  const duplicated = passingEvidence({
    hookEvents: ['sessionStart', 'sessionStart', 'userPromptSubmit'],
  });
  assert.ok(evaluateHookProbeGate(duplicated).failedChecks.includes('hookEventSetExact'));
});

test('each configured event needs exactly one started and one completed notification', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const mutation of [
    { notificationCount: 1 },
    { notificationCount: 3 },
    { orderedStartThenComplete: false },
    { startedStatus: 'completed' },
    { completedStatus: 'failed' },
  ]) {
    const evidence = passingEvidence();
    evidence.hookPairs = [
      { ...hookPair('sessionStart'), ...mutation },
      hookPair('userPromptSubmit'),
    ];
    assert.deepEqual(
      evaluateHookProbeGate(evidence).failedChecks,
      ['hookNotificationPairsExact'],
    );
  }
});

test('hook timestamps must be epoch seconds on every notification', async () => {
  const { evaluateHookProbeGate, looksLikeEpochSeconds } = await import(probeUrl);
  const evidence = passingEvidence();
  evidence.hookPairs = [
    { ...hookPair('sessionStart'), startedAtIsSeconds: false },
    hookPair('userPromptSubmit'),
  ];
  assert.deepEqual(
    evaluateHookProbeGate(evidence).failedChecks,
    ['hookTimestampsAreSeconds'],
  );
  assert.equal(looksLikeEpochSeconds(1_786_866_124), true);
  assert.equal(looksLikeEpochSeconds(1_786_866_124_000), false);
  assert.equal(looksLikeEpochSeconds(1.5), false);
});

// `sessionStart` stdin legitimately omits `turn_id`; a missing capture does not.
test('stdin captures must exist per event with the expected turn identity shape', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const hookStdin of [
    { userPromptSubmit: 'matches-authoritative-turn' },
    { sessionStart: 'present-without-turn-id' },
    { sessionStart: 'missing', userPromptSubmit: 'matches-authoritative-turn' },
    { sessionStart: 'present-without-turn-id', userPromptSubmit: 'mismatch' },
  ]) {
    assert.deepEqual(
      evaluateHookProbeGate(passingEvidence({ hookStdin })).failedChecks,
      ['hookStdinCapturesExact'],
    );
  }
});

test('the trust lifecycle must prove mutation drift and re-render separately', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const key of [
    'discoveredUntrusted',
    'renderedTrusted',
    'mutatedHashChanged',
    'mutatedStatusModified',
    'configDigestUnchangedOnMutation',
    'reRenderedDigestChanged',
    'reRenderedTrusted',
  ]) {
    const evidence = passingEvidence();
    evidence.trustLifecycle = { ...evidence.trustLifecycle, [key]: false };
    assert.deepEqual(
      evaluateHookProbeGate(evidence).failedChecks,
      ['hookTrustLifecycle'],
      `${key} must be gated`,
    );
  }
});

test('the hooks-off control lane must complete cleanly with no hook traffic', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const overrides of [
    { turnStatus: 'failed' },
    { faultCategory: 'protocol' },
    { deliveredHookMethods: ['hook/completed'] },
    { source: 'spike-client' },
  ]) {
    const evidence = passingEvidence();
    evidence.control = { ...evidence.control, ...overrides };
    assert.deepEqual(
      evaluateHookProbeGate(evidence).failedChecks,
      ['controlLaneClean'],
    );
  }
});

test('credential-free is gated on concrete conditions, not a hardcoded flag', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const credentialFree of [
    { authFileAbsent: false, providerRequiresAuth: false },
    { authFileAbsent: true, providerRequiresAuth: true },
  ]) {
    assert.deepEqual(
      evaluateHookProbeGate(passingEvidence({ credentialFree })).failedChecks,
      ['credentialFreeByConstruction'],
    );
  }
});

test('failure categories are a closed whitelist and carry no raw text', async () => {
  const { FAILURE_CATEGORIES, categorizeFailure } = await import(probeUrl);
  assert.ok(FAILURE_CATEGORIES.includes('unknown'));
  for (const category of FAILURE_CATEGORIES) {
    assert.match(category, /^[a-z-]+$/);
  }
  const secret = 'boom /Users/example/.codex/config.toml 01a00985-3f69-7360-9668-c93eaf37913c';
  const categorized = categorizeFailure(new Error(secret));
  assert.ok(FAILURE_CATEGORIES.includes(categorized));
  assert.doesNotMatch(categorized, /Users|01a00985|boom/);

  // The production client hands `onFault` a frozen outcome carrying
  // `errorCode`, not a thrown Error; both must categorize precisely.
  assert.equal(
    categorizeFailure({
      kind: 'codex-app-server-fault',
      errorCode: 'CODEX_PROTOCOL_ERROR',
      clientRootErrorCode: 'CODEX_PROTOCOL_ERROR',
    }),
    'protocol',
  );
  assert.equal(categorizeFailure({ errorCode: 'CODEX_TRANSPORT_ERROR' }), 'transport');
});

test('a STOP envelope is content-free by construction', async () => {
  const { stopEnvelope, envelopeIsContentFree } = await import(probeUrl);
  const envelope = stopEnvelope(
    new Error('/Users/example/.codex/hooks.json exploded for turn 01a00985-3f69-7360-9668-c93eaf37913c'),
  );
  assert.equal(envelope.gate, 'STOP');
  assert.equal(envelopeIsContentFree(envelope), true);
  assert.doesNotMatch(
    JSON.stringify(envelope),
    /Users|hooks\.json|01a00985|exploded/,
  );
});

// A passing run prints the whole envelope, so containment has to hold on
// CONTINUE, not only on STOP.
test('a CONTINUE envelope strips raw turn ids from both lanes', async () => {
  const { buildResultEnvelope, envelopeIsContentFree } = await import(probeUrl);
  const evidence = passingEvidence();
  evidence.authoritative = {
    ...evidence.authoritative,
    authoritativeTurnId: '01a00985-3f69-7360-9668-c93eaf37913c',
  };
  evidence.control = {
    ...evidence.control,
    authoritativeTurnId: '01a00986-8cc4-77c1-a717-26136a05f85b',
  };
  const envelope = buildResultEnvelope(evidence);
  assert.equal(envelope.gate, 'CONTINUE');
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /"authoritativeTurnId"/);
  assert.doesNotMatch(serialized, /01a00985|01a00986/);
  assert.equal(envelopeIsContentFree(envelope), true);
});

// An unapproved key is dropped by the projection rather than escalated; the
// point is that it can never be emitted, whatever it contains.
test('a stray path-bearing key is dropped without leaking into the envelope', async () => {
  const { buildResultEnvelope, envelopeIsContentFree } = await import(probeUrl);
  const evidence = passingEvidence();
  evidence.authoritative = {
    ...evidence.authoritative,
    strayPath: '/Users/example/.codex/config.toml',
  };
  const envelope = buildResultEnvelope(evidence);
  assert.equal(envelope.gate, 'CONTINUE');
  assert.equal(envelopeIsContentFree(envelope), true);
  assert.doesNotMatch(JSON.stringify(envelope), /Users|config\.toml|strayPath/);
});

// Peer-controlled strings must never be echoed; anything off the closed enum
// becomes a category, not an emitted value or object key.
test('unexpected peer-controlled names and statuses never reach the envelope', async () => {
  const { buildResultEnvelope } = await import(probeUrl);
  for (const mutate of [
    (evidence) => { evidence.hookEvents = ['sessionStart', 'SECRET_EVENT']; },
    (evidence) => {
      evidence.hookPairs = [
        { ...hookPair('sessionStart'), startedStatus: 'SECRET_STATUS' },
        hookPair('userPromptSubmit'),
      ];
    },
    (evidence) => { evidence.hookStdin = { SECRET_KEY: 'present-without-turn-id' }; },
    (evidence) => { evidence.authoritative.faultCategory = 'SECRET_CATEGORY'; },
  ]) {
    const evidence = passingEvidence();
    mutate(evidence);
    const envelope = buildResultEnvelope(evidence);
    assert.equal(envelope.gate, 'STOP');
    assert.doesNotMatch(JSON.stringify(envelope), /SECRET_/);
  }
});

test('providerRequiresAuth is derived from the config actually written', async () => {
  const { readProviderRequiresAuth } = await import(probeUrl);
  assert.equal(readProviderRequiresAuth('requires_openai_auth = false\n'), false);
  assert.equal(readProviderRequiresAuth('requires_openai_auth = true\n'), true);
  assert.equal(readProviderRequiresAuth('model = "x"\n'), null);
});

test('the control lane is held to the same completion and identity predicates', async () => {
  const { evaluateHookProbeGate } = await import(probeUrl);
  for (const overrides of [
    { assistantItemObserved: false },
    { turnStartResponseMatchesStarted: false },
    { completedTurnMatchesStarted: false },
  ]) {
    const evidence = passingEvidence();
    evidence.control = { ...evidence.control, ...overrides };
    assert.deepEqual(
      evaluateHookProbeGate(evidence).failedChecks,
      ['controlLaneClean'],
      `control ${Object.keys(overrides)[0]} must be gated`,
    );
  }
});

// A last-writer-wins capture file only proves presence; the gate needs the
// exact invocation count per event.
test('stdin captures require exactly one invocation per configured event', async () => {
  const { summarizeStdinCaptures } = await import(probeUrl);
  const digest = 'b'.repeat(64);
  const once = [
    { eventName: 'sessionStart', turnIdPresent: false, turnIdSha256: null },
    { eventName: 'userPromptSubmit', turnIdPresent: true, turnIdSha256: digest },
  ];
  assert.deepEqual(summarizeStdinCaptures(once, digest), {
    sessionStart: 'present-without-turn-id',
    userPromptSubmit: 'matches-authoritative-turn',
  });
  assert.deepEqual(
    summarizeStdinCaptures(
      [...once, { eventName: 'sessionStart', turnIdPresent: false, turnIdSha256: null }],
      digest,
    ),
    { sessionStart: 'unexpected-invocation-count', userPromptSubmit: 'matches-authoritative-turn' },
  );
  assert.deepEqual(
    summarizeStdinCaptures([once[1]], digest),
    { sessionStart: 'missing', userPromptSubmit: 'matches-authoritative-turn' },
  );
  assert.deepEqual(
    summarizeStdinCaptures(
      [{ eventName: 'sessionStart', turnIdPresent: true, turnIdSha256: 'c'.repeat(64) }, once[1]],
      digest,
    ),
    { sessionStart: 'unexpected-turn-id', userPromptSubmit: 'matches-authoritative-turn' },
  );
});

// A probe root containing spaces must not break the generated hook command.
test('generated shell arguments are quoted so paths with spaces survive', async () => {
  const { shellQuote, hookCommandFor } = await import(probeUrl);
  assert.equal(shellQuote('/plain/path'), "'/plain/path'");
  assert.equal(shellQuote("/od'd/path"), "'/od'\\''d/path'");
  const command = hookCommandFor('/probe root/with spaces/probe-hook.sh', 'sessionStart', '');
  assert.match(command, /'\/probe root\/with spaces\/probe-hook\.sh'/);
  assert.doesNotMatch(command, /(^|[^'])\/probe root/);
});

// Emission is a closed-key projection, so benign plain text — which no
// denylist regex would catch — must still never reach the output.
test('unapproved keys are dropped at every emission boundary', async () => {
  const { buildResultEnvelope } = await import(probeUrl);
  const cases = [
    ['top level', (evidence) => { evidence.operatorNote = 'harmless note'; }],
    ['authoritative lane', (evidence) => { evidence.authoritative.operatorNote = 'harmless note'; }],
    ['control lane', (evidence) => { evidence.control.operatorNote = 'harmless note'; }],
    ['hook pair', (evidence) => { evidence.hookPairs[0].operatorNote = 'harmless note'; }],
    ['credentialFree', (evidence) => { evidence.credentialFree.operatorNote = 'harmless note'; }],
    ['trustLifecycle', (evidence) => { evidence.trustLifecycle.operatorNote = 'harmless note'; }],
  ];
  for (const [where, mutate] of cases) {
    const evidence = passingEvidence();
    mutate(evidence);
    const envelope = buildResultEnvelope(evidence);
    assert.doesNotMatch(
      JSON.stringify(envelope),
      /operatorNote|harmless note/,
      `${where} leaked an unapproved key`,
    );
  }
});

test('non-scalar values in approved slots are rejected rather than emitted', async () => {
  const { buildResultEnvelope } = await import(probeUrl);
  const evidence = passingEvidence();
  evidence.ownedConfigDigestStable = { nested: 'plain words here' };
  const envelope = buildResultEnvelope(evidence);
  assert.equal(envelope.gate, 'STOP');
  assert.doesNotMatch(JSON.stringify(envelope), /nested|plain words/);
});

// Hook stdin can carry the user prompt; nothing raw may reach disk.
test('the hook capture script persists only closed fields, never raw stdin', async (t) => {
  const { hookCaptureScriptBody, readStdinCaptureRecords } = await import(probeUrl);
  const { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, chmodSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { spawnSync } = require('node:child_process');
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-u23-stdin-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const captureDir = path.join(scratch, 'capture');
  require('node:fs').mkdirSync(captureDir, { mode: 0o700 });
  const script = path.join(scratch, 'hook.sh');
  writeFileSync(script, hookCaptureScriptBody(captureDir), { mode: 0o700 });
  chmodSync(script, 0o700);

  const stdin = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    turn_id: '01a00985-3f69-7360-9668-c93eaf37913c',
    session_id: '01a00985-31c7-7020-b03f-3d7219939bd4',
    prompt: 'SENTINEL_PROMPT_TEXT',
    cwd: '/Users/example/SENTINEL_PATH',
    transcript_path: '/Users/example/SENTINEL_TRANSCRIPT',
  });
  const run = spawnSync('/bin/sh', [script, 'userPromptSubmit'], { input: stdin, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  const files = readdirSync(captureDir);
  assert.equal(files.length, 1);
  const onDisk = readFileSync(path.join(captureDir, files[0]), 'utf8');
  assert.doesNotMatch(onDisk, /SENTINEL_PROMPT_TEXT|SENTINEL_PATH|SENTINEL_TRANSCRIPT/);
  assert.doesNotMatch(onDisk, /01a00985-3f69-7360-9668-c93eaf37913c/, 'no raw turn id on disk');

  const [record] = readStdinCaptureRecords(captureDir);
  assert.equal(record.eventName, 'userPromptSubmit');
  assert.equal(record.turnIdPresent, true);
  assert.match(record.turnIdSha256, /^[a-f0-9]{64}$/);
});

test('a sessionStart capture records absent turn identity without inventing one', async (t) => {
  const { hookCaptureScriptBody, readStdinCaptureRecords } = await import(probeUrl);
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { spawnSync } = require('node:child_process');
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-u23-stdin-abs-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const captureDir = path.join(scratch, 'capture');
  mkdirSync(captureDir, { mode: 0o700 });
  const script = path.join(scratch, 'hook.sh');
  writeFileSync(script, hookCaptureScriptBody(captureDir), { mode: 0o700 });
  chmodSync(script, 0o700);
  const run = spawnSync('/bin/sh', [script, 'sessionStart'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const [record] = readStdinCaptureRecords(captureDir);
  assert.equal(record.eventName, 'sessionStart');
  assert.equal(record.turnIdPresent, false);
  assert.equal(record.turnIdSha256, null);
});

test('raw responses are not cached for the session', async (t) => {
  const { withRawSession } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(JSON.stringify({ id: 1, result: { secret: 'SENTINEL_RESULT_TEXT' } }) + '\\n');",
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const snapshot = await withRawSession(rawPeerOptions(scratch, peer), async (session) => {
    const result = await session.request('initialize', {}, 'test', 4_000);
    assert.equal(result.secret, 'SENTINEL_RESULT_TEXT', 'the caller still receives its result');
    return session.retainedSnapshot();
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /SENTINEL_RESULT_TEXT/,
    'no session-wide raw response cache may retain the result',
  );
});

test('documented usage matches the accepted arguments', async () => {
  const { USAGE, parseHookProbeArgs } = await import(probeUrl);
  const documented = [...USAGE.matchAll(/(--[a-z-]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(documented, ['--binary', '--probe-root']);

  assert.deepEqual(
    parseHookProbeArgs(['--binary', '/abs/codex', '--probe-root', '/abs/root']),
    { binary: '/abs/codex', probeRoot: '/abs/root' },
  );
  assert.throws(() => parseHookProbeArgs(['--workspace', '/abs/ws']), /unknown argument/);
  assert.throws(
    () => parseHookProbeArgs(['--binary', '/abs/codex']),
    /missing required hook probe option/,
  );
});

function rawPeerSession(t, bodyLines) {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const scratch = mkdtempSync(path.join(tmpdir(), 'orchestra-u23-raw-session-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const peer = path.join(scratch, 'peer.mjs');
  writeFileSync(peer, bodyLines.join('\n'), { mode: 0o700 });
  return { scratch, peer };
}

// Unit paths inject a group inspector so they never depend on a live process
// lister; restricted shells have no usable /bin/ps. The real lister stays on
// the authoritative live gate and is covered by its own tests below.
function rawPeerOptions(scratch, peer, env = {}) {
  return {
    binary: peer,
    launcher: process.execPath,
    workspace: scratch,
    env: { PATH: '/usr/bin:/bin', ...env },
    inspectGroup: () => [],
  };
}

test('the raw session rejects an oversized newline-free partial line', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(`{\"id\":1,\"result\":{\"pad\":\"${'X'.repeat(1_100_000)}`);",
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const error = await withRawSession(
    rawPeerOptions(scratch, peer),
    async (session) => session.request('initialize', {}, 'test', 4_000),
  ).then(() => null, (caught) => caught);
  assert.ok(error);
  assert.equal(categorizeFailure(error), 'bounds');
});

test('the raw session rejects malformed framing instead of discarding it', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write('this is not json\\n');",
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const error = await withRawSession(
    rawPeerOptions(scratch, peer),
    async (session) => session.request('initialize', {}, 'test', 4_000),
  ).then(() => null, (caught) => caught);
  assert.ok(error);
  assert.equal(categorizeFailure(error), 'framing');
});

test('the raw session tears its child down when the body throws', async (t) => {
  const { withRawSession } = await import(probeUrl);
  const { readFileSync, existsSync } = require('node:fs');
  const { scratch, peer } = rawPeerSession(t, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.U23_PIDFILE, String(process.pid));",
    'setInterval(() => {}, 1_000);',
  ]);
  const pidfile = path.join(scratch, 'peer.pid');
  const error = await withRawSession(
    rawPeerOptions(scratch, peer, { U23_PIDFILE: pidfile }),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw new Error('probe body failed');
    },
  ).then(() => null, (caught) => caught);
  assert.ok(error);
  assert.ok(existsSync(pidfile), 'the peer must have started');
  const pid = Number(readFileSync(pidfile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    'the raw session must not leave its child alive',
  );
});

// A valid turn followed by garbage must not return a passing result: the
// terminal failure is re-checked after the body resolves.
test('the raw session fails closed on data that arrives after the body resolves', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\\n');",
    "  setTimeout(() => process.stdout.write('not json at all\\n'), 50);",
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const error = await withRawSession(rawPeerOptions(scratch, peer), async (session) => {
    const result = await session.request('initialize', {}, 'test', 4_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return result;
  }).then(() => null, (caught) => caught);
  assert.ok(error, 'trailing malformed data must fail the session');
  assert.equal(categorizeFailure(error), 'framing');
});

test('the raw session rejects ambiguous and unknown envelopes', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  for (const [name, emitted] of [
    ['response and method together', { id: 1, result: {}, method: 'turn/started' }],
    ['result and error together', { id: 1, result: {}, error: { code: -1 } }],
    ['unknown notification method', { method: 'totally/unknown', params: {} }],
    ['response id that was never sent', { id: 99, result: {} }],
  ]) {
    await t.test(name, async (subtest) => {
      const { scratch, peer } = rawPeerSession(subtest, [
        "import readline from 'node:readline';",
        'const lines = readline.createInterface({ input: process.stdin });',
        "lines.once('line', () => {",
        `  process.stdout.write(JSON.stringify(${JSON.stringify(emitted)}) + '\\n');`,
        '});',
        'setInterval(() => {}, 1_000);',
      ]);
      const error = await withRawSession(
        rawPeerOptions(scratch, peer),
        async (session) => session.request('initialize', {}, 'test', 3_000),
      ).then(() => null, (caught) => caught);
      assert.ok(error, `${name} must fail closed`);
      // Rejected on ingestion, not merely left to time out.
      assert.ok(
        ['framing', 'protocol'].includes(categorizeFailure(error)),
        `${name} categorized ${categorizeFailure(error)}`,
      );
    });
  }
});

test('the raw session bounds stderr bytes', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "process.stderr.write('X'.repeat(2_000_000));",
    'setInterval(() => {}, 1_000);',
  ]);
  const error = await withRawSession(
    rawPeerOptions(scratch, peer),
    async (session) => session.request('initialize', {}, 'test', 4_000),
  ).then(() => null, (caught) => caught);
  assert.ok(error);
  assert.equal(categorizeFailure(error), 'bounds');
});

test('the raw session retains no arbitrary parsed payload', async (t) => {
  const { withRawSession } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(JSON.stringify({ method: 'hook/started', params: { threadId: 'SECRET_THREAD', run: { id: 'SECRET_RUN', eventName: 'sessionStart', status: 'running', startedAt: 1786866124, sourcePath: '/Users/example/SECRET.toml', entries: [{ kind: 'context', text: 'SECRET_TEXT' }] } } }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');",
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const retained = await withRawSession(rawPeerOptions(scratch, peer), async (session) => {
    await session.request('initialize', {}, 'test', 4_000);
    return session.hookSummaries;
  });
  assert.ok(Array.isArray(retained));
  assert.doesNotMatch(JSON.stringify(retained), /SECRET_|\/Users\//);
});

test('a failed production close is a cleanup failure that stops the gate', async () => {
  const { runProductionLaneWithClient, evaluateHookProbeGate, FAILURE_CATEGORIES } =
    await import(probeUrl);
  assert.ok(FAILURE_CATEGORIES.includes('cleanup'));
  const outcome = await runProductionLaneWithClient({
    createClient: () => ({
      start: async () => {},
      request: async (method) => (method === 'thread/start'
        ? { thread: { id: 't' } }
        : { turn: { id: 'x' } }),
      close: async () => { throw Object.assign(new Error('x'), { code: 'CODEX_PROCESS_CLEANUP_UNVERIFIED' }); },
    }),
    lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },
    binary: '/b',
    model: 'm',
    completionTimeoutMs: 50,
  });
  assert.equal(outcome.faultCategory, 'cleanup');
  const evidence = passingEvidence();
  evidence.authoritative = { ...evidence.authoritative, faultCategory: 'cleanup' };
  assert.ok(evaluateHookProbeGate(evidence).failedChecks.includes('authoritativeTurnCompleted'));
});

test('probe scratch is removed even when the loopback provider fails to start', async (t) => {
  const { characterizeHookNotifications } = await import(probeUrl);
  const { mkdtempSync, rmSync, readdirSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'orchestra-u23-provider-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let attested = false;
  const envelope = await characterizeHookNotifications({
    binary: '/stubbed/codex',
    probeRoot: root,
    // Attestation must succeed so the failure lands after the probe root
    // exists; otherwise the cleanup path is never exercised.
    attestBinary: async () => {
      attested = true;
      return { path: '/stubbed/codex', sha256: 'a'.repeat(64), version: 'stub' };
    },
    startProvider: async () => { throw new Error('provider refused to listen'); },
  });
  assert.equal(attested, true, 'the stubbed attestation must have run');
  assert.equal(envelope.gate, 'STOP', 'provider start failure must stop the gate');
  assert.deepEqual(readdirSync(root), [], 'probe scratch must not survive');
});

test('the raw session rejects a trailing partial line at EOF', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');",
    "  process.stdout.write('{\"id\":2,\"resu');",
    '  setTimeout(() => process.exit(0), 30);',
    '});',
  ]);
  const error = await withRawSession(rawPeerOptions(scratch, peer), async (session) => {
    await session.request('initialize', {}, 'test', 4_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }).then(() => null, (caught) => caught);
  assert.ok(error, 'a trailing partial at EOF must fail closed');
  assert.equal(categorizeFailure(error), 'framing');
});

test('the raw session rejects unsupported envelope keys and versions', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  for (const [name, emitted] of [
    ['arbitrary extra top-level key', { id: 1, result: {}, extra: 1 }],
    ['unsupported jsonrpc version', { jsonrpc: '1.0', id: 1, result: {} }],
    ['notification with extra key', { method: 'turn/started', params: {}, extra: 1 }],
  ]) {
    await t.test(name, async (subtest) => {
      const { scratch, peer } = rawPeerSession(subtest, [
        "import readline from 'node:readline';",
        'const lines = readline.createInterface({ input: process.stdin });',
        "lines.once('line', () => {",
        `  process.stdout.write(JSON.stringify(${JSON.stringify(emitted)}) + '\\n');`,
        '});',
        'setInterval(() => {}, 1_000);',
      ]);
      const error = await withRawSession(
        rawPeerOptions(scratch, peer),
        async (session) => session.request('initialize', {}, 'test', 3_000),
      ).then(() => null, (caught) => caught);
      assert.ok(error, `${name} must fail closed`);
      assert.equal(categorizeFailure(error), 'framing');
    });
  }
});

// Garbage that lands while the child is being torn down must still fail the
// session; a body that already resolved cannot mask it.
test('the raw session fails closed on malformed bytes that arrive during teardown', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  // Scheduling-independent by construction: a grandchild inherits stdout and
  // writes strictly after the session child has exited, so the bytes cannot be
  // caught by waiting on child exit plus a fixed number of event-loop ticks.
  // Only awaiting a real stdout end/drain observes them.
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    "import { spawn } from 'node:child_process';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');",
    "  process.on('SIGTERM', () => {",
    "    spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => { require('node:fs').writeSync(1, 'garbage after exit\\\\n'); process.exit(0); }, 250);\"], { stdio: ['ignore', 'inherit', 'ignore'], detached: false });",
    '    process.exit(0);',
    '  });',
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const error = await withRawSession(
    rawPeerOptions(scratch, peer),
    async (session) => session.request('initialize', {}, 'test', 4_000),
  ).then(() => null, (caught) => caught);
  assert.ok(error, 'teardown-time garbage must fail the session');
  assert.equal(categorizeFailure(error), 'framing');
});

test('the raw session proves the whole owned group is gone, not just the leader', async (t) => {
  const { withRawSession } = await import(probeUrl);
  const { readFileSync, existsSync } = require('node:fs');
  const { scratch, peer } = rawPeerSession(t, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    // A descendant that ignores SIGTERM: only whole-group escalation removes it.
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    'writeFileSync(process.env.U23_DESCENDANT_PIDFILE, String(child.pid));',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1_000);',
  ]);
  const pidfile = path.join(scratch, 'descendant.pid');
  await withRawSession(
    rawPeerOptions(scratch, peer, { U23_DESCENDANT_PIDFILE: pidfile }),
    async () => { await new Promise((resolve) => setTimeout(resolve, 400)); },
  ).catch(() => {});
  assert.ok(existsSync(pidfile), 'the descendant must have started');
  const descendantPid = Number(readFileSync(pidfile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(
    () => process.kill(descendantPid, 0),
    /ESRCH/,
    'a TERM-ignoring descendant must not survive the session',
  );
});

test('a fault delivered during close still fails the production lane', async () => {
  const { runProductionLaneWithClient } = await import(probeUrl);
  const outcome = await runProductionLaneWithClient({
    createClient: (options) => ({
      start: async () => {},
      request: async (method) => (method === 'thread/start'
        ? { thread: { id: 't' } }
        : { turn: { id: 'x' } }),
      close: async () => {
        // The client settles its fault checkpoint during close.
        await options.onFault({
          kind: 'codex-app-server-fault',
          errorCode: 'CODEX_PROTOCOL_ERROR',
          clientRootErrorCode: 'CODEX_PROTOCOL_ERROR',
        });
      },
    }),
    lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },
    binary: '/b',
    model: 'm',
    completionTimeoutMs: 50,
  });
  assert.equal(
    outcome.faultCategory,
    'protocol',
    'a fault observed during close must not be lost',
  );
});

test('provider close failure yields a content-free cleanup stop', async (t) => {
  const { characterizeHookNotifications, envelopeIsContentFree } = await import(probeUrl);
  const { mkdtempSync, rmSync, readdirSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'orchestra-u23-provider-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envelope = await characterizeHookNotifications({
    binary: '/stubbed/codex',
    probeRoot: root,
    attestBinary: async () => ({ path: '/stubbed/codex', sha256: 'a'.repeat(64), version: 'stub' }),
    startProvider: async () => ({
      port: 1,
      close: async () => { throw new Error('provider close exploded at /Users/example'); },
    }),
    runLanes: async () => ({ gate: 'CONTINUE', checks: {}, failedChecks: [], evidence: {} }),
  }).catch((error) => error);
  assert.equal(envelope.gate, 'STOP', 'provider close failure must stop the gate');
  assert.equal(envelope.failureCategory, 'cleanup');
  assert.equal(envelopeIsContentFree(envelope), true);
  assert.doesNotMatch(JSON.stringify(envelope), /Users|exploded/);
  assert.deepEqual(readdirSync(root), [], 'scratch must still be removed');
});

// Unit paths must not depend on a live process lister; restricted shells have
// no usable /bin/ps and would otherwise fail every raw-session case with a
// cleanup error that masks the outcome under test.
test('the raw session consults an injected group inspector instead of live ps', async (t) => {
  const { withRawSession } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');",
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const calls = [];
  await withRawSession(
    {
      ...rawPeerOptions(scratch, peer),
      inspectGroup: (pgid) => {
        calls.push(pgid);
        return [];
      },
    },
    async (session) => session.request('initialize', {}, 'test', 4_000),
  );
  assert.ok(calls.length > 0, 'the injected inspector must be the one consulted');
  assert.ok(
    calls.every((pgid) => Number.isSafeInteger(pgid) && pgid > 0),
    'the inspector receives the owned process group id',
  );
});

test('an owned group that never empties fails closed as a cleanup failure', async (t) => {
  const { withRawSession, categorizeFailure } = await import(probeUrl);
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.once('line', () => {",
    "  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');",
    '});',
    'setInterval(() => {}, 1_000);',
  ]);
  const error = await withRawSession(
    {
      ...rawPeerOptions(scratch, peer),
      // A survivor that never goes away must not be reported as clean.
      inspectGroup: () => [999_999],
    },
    async (session) => session.request('initialize', {}, 'test', 4_000),
  ).then(() => null, (caught) => caught);
  assert.ok(error, 'a non-empty owned group must fail the session');
  assert.equal(categorizeFailure(error), 'cleanup');
});

// The live gate keeps the real lister and must fail closed, not silently pass,
// when it cannot run.
test('the default group inspector fails closed when the process lister is unavailable', async () => {
  const { createGroupInspector, categorizeFailure } = await import(probeUrl);
  const inspector = createGroupInspector('/nonexistent/process/lister');
  let caught = null;
  try {
    inspector(process.pid);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'an unavailable lister must not be treated as an empty group');
  assert.equal(categorizeFailure(caught), 'cleanup');
});

// Conditional by design: the real lister is the authoritative live gate's
// mechanism, and a shell that denies /bin/ps has nothing to assert here. The
// fail-closed behaviour above stays unconditional so denial can never be
// mistaken for an empty group.
test('the default group inspector reads the real lister where one is available', async (t) => {
  const { createGroupInspector } = await import(probeUrl);
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 1_000,
  });
  if (probe.error || probe.status !== 0 || typeof probe.stdout !== 'string') {
    t.skip('no usable /bin/ps in this shell; the live gate covers the real lister');
    return;
  }
  const members = createGroupInspector()(process.pid);
  assert.ok(Array.isArray(members), 'the real lister returns an enumerable group');
});

// Pinned HookMetadata carries `command` and `sourcePath` (and may carry prompt
// text). Only the four fields the trust lifecycle and trusted-state rendering
// actually need may survive discovery.
test('hook discovery keeps only the four fields it needs and discards the rest', async (t) => {
  const { listHooks } = await import(probeUrl);
  const metadata = {
    key: '/probe/hooks.json:session_start:0:0',
    currentHash: `sha256:${'a'.repeat(64)}`,
    trustStatus: 'untrusted',
    enabled: false,
    command: "sh '/Users/example/SENTINEL_COMMAND.sh' sessionStart",
    sourcePath: '/Users/example/.codex/SENTINEL_SOURCE.json',
    prompt: 'SENTINEL_PROMPT_TEXT',
    eventName: 'sessionStart',
    displayOrder: 0,
    handlerType: 'command',
    isManaged: false,
    source: 'user',
    timeoutSec: 10,
  };
  const { scratch, peer } = rawPeerSession(t, [
    "import readline from 'node:readline';",
    'const lines = readline.createInterface({ input: process.stdin });',
    "const meta = " + JSON.stringify(metadata) + ";",
    "lines.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    '  if (message.method === "initialize") {',
    "    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');",
    '  } else if (message.method === "hooks/list") {',
    "    process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ cwd: '/w', errors: [], warnings: [], hooks: [meta] } ] } }) + '\\n');",
    '  }',
    '});',
    'setInterval(() => {}, 1_000);',
  ]);

  const discovered = await listHooks(rawPeerOptions(scratch, peer), peer);
  assert.equal(discovered.length, 1);
  assert.deepEqual(
    Object.keys(discovered[0]).sort(),
    ['currentHash', 'enabled', 'key', 'trustStatus'],
  );
  assert.doesNotMatch(
    JSON.stringify(discovered),
    /SENTINEL_COMMAND|SENTINEL_SOURCE|SENTINEL_PROMPT|command|sourcePath/,
    'command, sourcePath and prompt text must not be retained',
  );
  assert.equal(discovered[0].trustStatus, 'untrusted');
  assert.equal(discovered[0].enabled, false);
});

test('hook discovery rejects malformed or oversized metadata fail-closed', async () => {
  const { projectHookMetadata, categorizeFailure } = await import(probeUrl);
  const valid = {
    key: '/probe/hooks.json:session_start:0:0',
    currentHash: `sha256:${'a'.repeat(64)}`,
    trustStatus: 'trusted',
    enabled: true,
  };
  assert.deepEqual(projectHookMetadata(valid), valid);
  for (const [name, mutation] of [
    ['unknown trust status', { trustStatus: 'SENTINEL_STATUS' }],
    ['non-boolean enabled', { enabled: 'yes' }],
    ['malformed hash', { currentHash: 'not-a-digest' }],
    ['oversized key', { key: 'k'.repeat(5_000) }],
    ['missing key', { key: undefined }],
  ]) {
    let caught = null;
    try {
      projectHookMetadata({ ...valid, ...mutation });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${name} must fail closed`);
    assert.equal(categorizeFailure(caught), 'framing');
    assert.doesNotMatch(String(caught.message), /SENTINEL_STATUS|kkkk/);
  }
});

test('trusted hook state renders each discovered hook and refuses incomplete input', async () => {
  const { renderTrustedHookState } = await import(probeUrl);
  const rendered = renderTrustedHookState([
    { key: '/probe/hooks.json:session_start:0:0', currentHash: 'sha256:abc' },
  ]);
  assert.match(rendered, /\[hooks\.state\."\/probe\/hooks\.json:session_start:0:0"\]/);
  assert.match(rendered, /trusted_hash = "sha256:abc"/);
  assert.match(rendered, /enabled = true/);
  assert.throws(() => renderTrustedHookState([]), /no hooks were discovered/);
  assert.throws(
    () => renderTrustedHookState([{ key: 'k' }]),
    /missing its key or current hash/,
  );
});
