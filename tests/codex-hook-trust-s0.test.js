'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const s0Url = pathToFileURL(path.resolve(
  __dirname,
  '../scripts/spikes/codex-hook-trust-s0.mjs',
)).href;
const recorderPath = path.resolve(__dirname, '../scripts/spikes/u23-hook-recorder.mjs');
const recorderUrl = pathToFileURL(recorderPath).href;

function scratch(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function attestedDescriptor(runtimePath, artifactPath, argv) {
  return {
    descriptor: {
      runtime: { path: runtimePath, kind: 'system-runtime' },
      artifacts: [{ path: artifactPath, kind: 'shipped-artifact' }],
      argv,
    },
    attested: new Set([runtimePath, artifactPath]),
  };
}

// ---------------------------------------------------------------------------
// Key derivation. Polygram must predeclare the exact config key it renders, so
// a wrong derivation has to fail closed rather than produce a key that merely
// looks plausible.
// ---------------------------------------------------------------------------

test('the config key derives from source path, snake event name and both indices', async () => {
  const { deriveHookKey, classifyHookKey, S0_EVENT_SNAKE } = await import(s0Url);
  assert.deepEqual(Object.keys(S0_EVENT_SNAKE).sort(), ['sessionStart', 'stop', 'userPromptSubmit']);
  const source = '/probe/hooks.json';
  assert.equal(deriveHookKey(source, 'sessionStart'), '/probe/hooks.json:session_start:0:0');
  assert.equal(
    deriveHookKey(source, 'userPromptSubmit'),
    '/probe/hooks.json:user_prompt_submit:0:0',
  );
  assert.equal(deriveHookKey(source, 'stop', 1, 2), '/probe/hooks.json:stop:1:2');
  const matched = classifyHookKey(deriveHookKey(source, 'stop', 1, 2), source, 'stop');
  assert.deepEqual(matched, {
    matchesTemplate: true, snakeTokenMatches: true, indexI: 1, indexJ: 2,
  });
});

test('a key that is merely plausible does not classify as a match', async () => {
  const { classifyHookKey } = await import(s0Url);
  const source = '/probe/hooks.json';
  for (const [name, key, event] of [
    ['camelCase event token', '/probe/hooks.json:userPromptSubmit:0:0', 'userPromptSubmit'],
    ['wrong event token', '/probe/hooks.json:stop:0:0', 'userPromptSubmit'],
    ['missing sub index', '/probe/hooks.json:stop:0', 'stop'],
    ['non-numeric index', '/probe/hooks.json:stop:a:0', 'stop'],
    ['foreign source path', '/other/hooks.json:stop:0:0', 'stop'],
    ['trailing content', '/probe/hooks.json:stop:0:0:extra', 'stop'],
  ]) {
    assert.equal(
      classifyHookKey(key, source, event).matchesTemplate,
      false,
      `${name} must not classify as the derived key`,
    );
  }
});

// ---------------------------------------------------------------------------
// Typed command descriptors. The renderer is the only way a command string
// comes into existence, and it refuses to render a path nobody attested.
// ---------------------------------------------------------------------------

test('a command renders deterministically from its typed descriptor', async () => {
  const { renderHookCommand, commandDigest } = await import(s0Url);
  const { descriptor, attested } = attestedDescriptor(
    '/usr/local/bin/node', '/opt/recorder.mjs', ['stop', '/probe/capture'],
  );
  const first = renderHookCommand(descriptor, attested);
  const second = renderHookCommand(descriptor, attested);
  assert.equal(first, second, 'the rendering must be a pure function of the descriptor');
  assert.equal(
    first,
    "'/usr/local/bin/node' '/opt/recorder.mjs' 'stop' '/probe/capture'",
  );
  assert.equal(commandDigest(first), commandDigest(second));
  assert.notEqual(
    commandDigest(first),
    commandDigest(renderHookCommand({
      ...descriptor,
      argv: ['sessionStart', '/probe/capture'],
    }, attested)),
  );
});

test('a descriptor naming an unattested or unpinned path cannot be rendered at all', async () => {
  const { renderHookCommand } = await import(s0Url);
  const { attested } = attestedDescriptor('/usr/local/bin/node', '/opt/recorder.mjs', ['stop']);
  for (const [name, runtimePath] of [
    ['bare binary name', 'codex'],
    ['relative path', './codex'],
    ['parent-relative path', '../bin/codex'],
    ['absolute but unattested', '/usr/bin/node'],
  ]) {
    assert.throws(
      () => renderHookCommand({
        runtime: { path: runtimePath, kind: 'system-runtime' },
        artifacts: [{ path: '/opt/recorder.mjs', kind: 'shipped-artifact' }],
        argv: ['stop'],
      }, attested),
      /attestation failure/,
      `${name} must be rejected before any command string exists`,
    );
  }
  assert.throws(
    () => renderHookCommand({
      runtime: { path: '/usr/local/bin/node', kind: 'system-runtime' },
      artifacts: [{ path: '/opt/other.mjs', kind: 'shipped-artifact' }],
      argv: ['stop'],
    }, attested),
    /attestation failure/,
    'an unattested artifact must be rejected too',
  );
});

test('argv carries literals only: metacharacters and control characters are rejected', async () => {
  const { renderHookCommand, assertLiteralArgument } = await import(s0Url);
  const { descriptor, attested } = attestedDescriptor(
    '/usr/local/bin/node', '/opt/recorder.mjs', ['stop'],
  );
  for (const argument of [
    '$HOME', '`id`', 'a;rm -rf /', 'a|b', 'a&b', 'a>b', 'a<b', 'a*b', 'a?b',
    'a(b)', 'a{b}', 'a[b]', "a'b", 'a\"b', 'a\\b', 'a\nb', 'a\rb',
    'a\tb', 'a\u0000b', 'a\u007fb', '',
  ]) {
    assert.throws(
      () => renderHookCommand({ ...descriptor, argv: [argument] }, attested),
      /bounds failure/,
      `${JSON.stringify(argument)} must not survive as a literal argument`,
    );
  }
  // A path with a space still renders; quoting handles it and it is not a
  // metacharacter.
  assert.equal(assertLiteralArgument('/probe root/capture', 'test'), '/probe root/capture');
  assert.equal(
    renderHookCommand({ ...descriptor, argv: ['/probe root/capture'] }, attested),
    "'/usr/local/bin/node' '/opt/recorder.mjs' '/probe root/capture'",
  );
});

// ---------------------------------------------------------------------------
// Metadata projection. `key`, `sourcePath`, `command` and every free-text
// optional field are compared against locally held expectations and discarded.
// ---------------------------------------------------------------------------

function rawMetadata(overrides = {}) {
  return {
    key: '/probe/SENTINEL_SOURCE.json:stop:0:0',
    currentHash: `sha256:${'a'.repeat(64)}`,
    trustStatus: 'trusted',
    enabled: true,
    command: "'/bin/node' '/opt/SENTINEL_COMMAND.mjs' 'stop'",
    sourcePath: '/probe/SENTINEL_SOURCE.json',
    eventName: 'stop',
    displayOrder: 0,
    handlerType: 'command',
    isManaged: false,
    source: 'user',
    timeoutSec: 30,
    ...overrides,
  };
}

test('hook metadata is projected to verdicts and never echoes raw identity', async () => {
  const { projectHookEntry } = await import(s0Url);
  const entry = rawMetadata({
    statusMessage: 'SENTINEL_STATUS_PROSE',
    matcher: 'SENTINEL_MATCHER',
    pluginId: 'SENTINEL_PLUGIN',
    additionalContextLimit: 2500,
    futureField: 'SENTINEL_UNKNOWN',
  });
  const projected = projectHookEntry(entry, {
    sourcePath: '/probe/SENTINEL_SOURCE.json',
    commandByEvent: { stop: "'/bin/node' '/opt/SENTINEL_COMMAND.mjs' 'stop'" },
  });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /SENTINEL_/, 'no raw field value may survive projection');
  assert.doesNotMatch(serialized, /\/probe\/|\/opt\/|sha256:/);
  assert.equal(projected.keyMatchesTemplate, true);
  assert.equal(projected.sourcePathMatchesManifest, true);
  assert.equal(projected.commandMatchesRendered, true);
  assert.equal(projected.currentHashWellFormed, true);
  assert.equal(projected.unknownFieldCount, 1);
  assert.deepEqual(
    projected.optionalFieldsNonNull.sort(),
    ['additionalContextLimit', 'command', 'matcher', 'pluginId', 'statusMessage'],
  );
});

test('a command that differs from the rendering is reported as a mismatch, not echoed', async () => {
  const { projectHookEntry } = await import(s0Url);
  const projected = projectHookEntry(
    rawMetadata({ command: 'SENTINEL_TAMPERED_COMMAND' }),
    {
      sourcePath: '/probe/SENTINEL_SOURCE.json',
      commandByEvent: { stop: "'/bin/node' '/opt/SENTINEL_COMMAND.mjs' 'stop'" },
    },
  );
  assert.equal(projected.commandPresent, true);
  assert.equal(projected.commandMatchesRendered, false);
  assert.doesNotMatch(JSON.stringify(projected), /SENTINEL_/);
});

test('an absent command is distinguished from a present one, since the pinned type allows null', async () => {
  const { projectHookEntry, HOOK_METADATA_OPTIONAL_FIELDS, HOOK_METADATA_REQUIRED_FIELDS } =
    await import(s0Url);
  assert.ok(
    HOOK_METADATA_OPTIONAL_FIELDS.includes('command'),
    'command is optional in the pinned HookMetadata, not required',
  );
  assert.ok(!HOOK_METADATA_REQUIRED_FIELDS.includes('command'));
  const without = { ...rawMetadata() };
  delete without.command;
  const projected = projectHookEntry(without, { sourcePath: '/probe/SENTINEL_SOURCE.json' });
  assert.equal(projected.commandPresent, false);
  assert.equal(projected.commandMatchesRendered, false);
  assert.deepEqual(projected.optionalFieldsWithKey, []);
});

test('peer values outside the pinned enums fail closed rather than being emitted', async () => {
  const { projectHookEntry } = await import(s0Url);
  for (const overrides of [
    { trustStatus: 'SENTINEL_STATUS' },
    { handlerType: 'SENTINEL_HANDLER' },
    { source: 'SENTINEL_SOURCE_KIND' },
    { eventName: 'SENTINEL_EVENT' },
  ]) {
    let caught = null;
    try {
      projectHookEntry(rawMetadata(overrides), { sourcePath: '/probe/SENTINEL_SOURCE.json' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${Object.keys(overrides)[0]} must fail closed`);
    assert.doesNotMatch(String(caught.message), /SENTINEL_/);
  }
});

// The trust half is split away from the emitted half — and a lone entry is
// not an exact match for the three-event manifest, so it yields nothing to
// render even though it carries a well-formed key and hash.
test('the trust half of an inventory is split away from the emitted half', async () => {
  const { splitHookInventory } = await import(s0Url);
  const { projected, trust, trustable } = splitHookInventory(
    [rawMetadata()],
    { sourcePath: '/probe/SENTINEL_SOURCE.json' },
  );
  assert.equal(trustable, false, 'a partial inventory is never trustable');
  assert.deepEqual(trust, [], 'a well-formed key and hash alone do not earn trust');
  assert.equal(projected.length, 1, 'it is still projected as evidence');
  assert.doesNotMatch(JSON.stringify(projected), /SENTINEL_|sha256:/);
});

// ---------------------------------------------------------------------------
// Envelope projection.
// ---------------------------------------------------------------------------

function passingMeasurement(overrides = {}) {
  const receipt = {
    kind: 'system-runtime',
    sha256: 'b'.repeat(64),
    nlink: 1,
    isRegularFile: true,
    isSymlink: false,
    isCanonicalPath: true,
    ownerIsSelf: false,
    ownerIsRoot: true,
    groupOrWorldWritable: false,
    ownerExecutable: true,
    ownerOnlyMode: false,
    satisfiesKindRule: true,
  };
  return {
    unmeasured: [],
    receipts: {
      pinnedBinaryAttested: true,
      target: 'aarch64-apple-darwin',
      systemRuntime: receipt,
      shippedArtifact: { ...receipt, kind: 'shipped-artifact', ownerIsSelf: true, ownerIsRoot: false },
      commandRenderIsDeterministic: true,
      commandDigestByEvent: {
        sessionStart: 'c'.repeat(64),
        userPromptSubmit: 'd'.repeat(64),
        stop: 'e'.repeat(64),
      },
    },
    credentialFree: {
      authFileAbsent: true, providerRequiresAuth: false, isolatedHomeMode0700: true,
    },
    e2ParamForms: {},
    e1UserLayer: {},
    e4FeatureFlag: {},
    e5KeyDerivation: {},
    metadata: {},
    e6FireTime: {},
    e7Ordering: {},
    turn: {},
    stability: {},
    cleanup: { strayProcessCount: 0, probeRootRemoved: true },
    ...overrides,
  };
}

test('the envelope drops unapproved keys at every nesting level', async () => {
  const { buildS0Envelope } = await import(s0Url);
  const measured = completeMeasurement();
  measured.operatorNote = '/Users/example/SENTINEL_TOP';
  measured.receipts.operatorNote = 'SENTINEL_RECEIPTS';
  measured.receipts.systemRuntime.operatorNote = 'SENTINEL_RUNTIME';
  measured.credentialFree.operatorNote = 'SENTINEL_CRED';
  measured.cleanup.operatorNote = 'SENTINEL_CLEANUP';
  // Injected into an otherwise complete entry, so the case tests leakage
  // rather than incidentally tripping the completeness gate.
  measured.metadata.trustedInventory[2].operatorNote = 'SENTINEL_ENTRY';
  measured.metadata.trustedInventory[2].key = '/probe/SENTINEL_KEY.json:stop:0:0';
  measured.turnIdentity.operatorNote = 'SENTINEL_IDENTITY';
  measured.e6FireTime.operatorNote = 'SENTINEL_FIRETIME';
  const envelope = buildS0Envelope(measured);
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /SENTINEL_|operatorNote|\/Users\//);
  assert.equal(envelope.gate, 'CONTINUE');
});

test('an out-of-enum value becomes null instead of being echoed into the envelope', async () => {
  const { buildS0Envelope } = await import(s0Url);
  const measured = passingMeasurement();
  measured.receipts.target = 'SENTINEL_TARGET';
  measured.e2ParamForms = {
    empty: { verdict: 'SENTINEL_VERDICT', rpcErrorClass: 'SENTINEL_CLASS', entryCount: 1 },
  };
  measured.e7Ordering = { userPromptSubmitVsTurnStartResponse: 'SENTINEL_ORDER' };
  const envelope = buildS0Envelope(measured);
  assert.doesNotMatch(JSON.stringify(envelope), /SENTINEL_/);
  assert.equal(envelope.evidence.receipts.target, null);
  assert.equal(envelope.evidence.e2ParamForms.empty.verdict, null);
  assert.equal(envelope.evidence.e7Ordering.userPromptSubmitVsTurnStartResponse, null);
});

test('an unmeasured decision stops the characterization instead of reporting a result', async () => {
  const { buildS0Envelope, S0_DECISIONS } = await import(s0Url);
  const envelope = buildS0Envelope(passingMeasurement({ unmeasured: ['E1', 'E6'] }));
  assert.equal(envelope.gate, 'STOP');
  assert.deepEqual(envelope.unmeasured, ['E1', 'E6']);
  for (const label of envelope.unmeasured) assert.ok(S0_DECISIONS.includes(label));
  const invented = buildS0Envelope(passingMeasurement({ unmeasured: ['SENTINEL_DECISION'] }));
  assert.deepEqual(invented.unmeasured, [], 'an unknown label is dropped, not echoed');
});

test('a content-bearing envelope is refused rather than printed', async () => {
  const { buildS0Envelope } = await import(s0Url);
  const measured = passingMeasurement();
  // A digest slot fed a path-shaped value must not reach the output.
  measured.receipts.systemRuntime.sha256 = '/Users/example/.codex/config.toml';
  const envelope = buildS0Envelope(measured);
  assert.doesNotMatch(JSON.stringify(envelope), /Users|config\.toml/);
  assert.equal(envelope.evidence.receipts.systemRuntime.sha256, null);
});

// ---------------------------------------------------------------------------
// Artifact and runtime attestation.
// ---------------------------------------------------------------------------

// Deliberately does not attest the ambient `process.execPath`. Whether the
// runtime that happens to be running the tests satisfies the rule is a
// property of the machine, not of the rule — a package-manager Node under a
// group-writable prefix is *correctly* rejected, and asserting otherwise would
// make the suite pass or fail on which `node` was first on PATH. The ambient
// runtime is checked where it matters: the live probe, strictly, via
// `--runtime`.
test('a shared root-owned 0755 runtime passes without being required to be owner-only', async () => {
  const { attestArtifact } = await import(s0Url);
  const receipt = attestArtifact('/bin/sh', 'system-runtime');
  assert.equal(receipt.ownerIsRoot, true);
  assert.equal(receipt.ownerOnlyMode, false, 'the fixture must not be owner-only');
  assert.equal(receipt.groupOrWorldWritable, false);
  assert.equal(receipt.parentChainSafe, true);
  assert.equal(receipt.satisfiesKindRule, true, '0700 must not be demanded of a shared runtime');
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
});

test('an owner-owned 0755 runtime under a safe chain also passes the rule', async (t) => {
  const { attestArtifact, parentChainIsSafe } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-runtime-');
  const runtime = path.join(dir, 'runtime');
  writeFileSync(runtime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(runtime, 0o755);
  // The fixture is only meaningful if its own chain is safe; assert that
  // rather than assume it, so a hostile TMPDIR fails loudly instead of
  // silently weakening the case.
  assert.equal(
    parentChainIsSafe(runtime),
    true,
    'the scratch chain must be safe for this fixture to mean anything',
  );
  const receipt = attestArtifact(runtime, 'system-runtime');
  assert.equal(receipt.ownerIsSelf, true);
  assert.equal(receipt.ownerIsRoot, false);
  assert.equal(receipt.ownerOnlyMode, false);
  assert.equal(receipt.satisfiesKindRule, true);
});

// The converse, and the reason `--runtime` exists: a runtime whose prefix is
// group-writable is refused however clean the binary itself is.
test('a runtime under a group-writable prefix is refused, whatever its own mode', async (t) => {
  const { attestArtifact, attestArtifactStrict } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-runtime-loose-');
  const prefix = path.join(dir, 'Cellar');
  mkdirSync(prefix, { mode: 0o775 });
  chmodSync(prefix, 0o775);
  const runtime = path.join(prefix, 'node');
  writeFileSync(runtime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(runtime, 0o755);
  const receipt = attestArtifact(runtime, 'system-runtime');
  assert.equal(receipt.groupOrWorldWritable, false, 'the binary itself is tight');
  assert.equal(receipt.parentChainSafe, false, 'its prefix is not');
  assert.equal(receipt.satisfiesKindRule, false);
  assert.throws(() => attestArtifactStrict(runtime, 'system-runtime'), /attestation failure/);
});

test('a shipped artifact must be owner-owned, unlinked, non-symlink and not group-writable', async (t) => {
  const { attestArtifact } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-attest-');
  const good = path.join(dir, 'recorder.mjs');
  writeFileSync(good, 'export default 1;\n', { mode: 0o700 });
  chmodSync(good, 0o700);
  assert.equal(attestArtifact(good, 'shipped-artifact').satisfiesKindRule, true);

  const groupWritable = path.join(dir, 'group-writable.mjs');
  writeFileSync(groupWritable, 'export default 1;\n', { mode: 0o770 });
  chmodSync(groupWritable, 0o770);
  assert.equal(attestArtifact(groupWritable, 'shipped-artifact').satisfiesKindRule, false);

  const linked = path.join(dir, 'linked.mjs');
  linkSync(good, linked);
  const linkedReceipt = attestArtifact(linked, 'shipped-artifact');
  assert.equal(linkedReceipt.nlink, 2);
  assert.equal(linkedReceipt.satisfiesKindRule, false, 'nlink > 1 must fail closed');

  const link = path.join(dir, 'symlink.mjs');
  symlinkSync(good, link);
  const symlinkReceipt = attestArtifact(link, 'shipped-artifact');
  assert.equal(symlinkReceipt.isSymlink, true);
  assert.equal(symlinkReceipt.satisfiesKindRule, false);

  assert.throws(() => attestArtifact(path.join(dir, 'missing.mjs'), 'shipped-artifact'), /attestation/);
  assert.throws(() => attestArtifact('relative.mjs', 'shipped-artifact'), /attestation/);
});

// ---------------------------------------------------------------------------
// Ordering derivation.
// ---------------------------------------------------------------------------

test('ordering verdicts are closed and a tie is ambiguous rather than an invented order', async () => {
  const { compareObservations, deriveOrdering, ORDER_VERDICTS, MARGIN_BUCKETS } =
    await import(s0Url);
  assert.equal(compareObservations(1, 2), 'before');
  assert.equal(compareObservations(2, 1), 'after');
  assert.equal(compareObservations(2, 2), 'ambiguous');
  assert.equal(compareObservations(null, 2), 'unobserved');
  assert.equal(compareObservations(2, undefined), 'unobserved');

  const timings = {
    threadStartResponseMs: 100,
    turnStartResponseMs: 200,
    turnStartedNotificationMs: 210,
    turnCompletedNotificationMs: 400,
  };
  const ordering = deriveOrdering(timings, [
    { eventName: 'sessionStart', observedAtMs: 90 },
    { eventName: 'userPromptSubmit', observedAtMs: 190 },
    { eventName: 'stop', observedAtMs: 380 },
  ]);
  for (const verdict of Object.values(ordering)) {
    if (typeof verdict === 'boolean') continue;
    assert.ok(
      ORDER_VERDICTS.includes(verdict) || MARGIN_BUCKETS.includes(verdict),
      `${verdict} is outside both closed sets`,
    );
  }
  assert.equal(ordering.sessionStartVsThreadStartResponse, 'before');
  assert.equal(ordering.userPromptSubmitVsTurnStartResponse, 'before');
  assert.equal(ordering.stopVsTurnCompletedNotification, 'before');
  assert.equal(ordering.userPromptSubmitVsStop, 'before');
});

// The `turn-accepted` checkpoint is recorded strictly after the turn/start
// response, so only a hook observed before that response is unconditionally
// before the checkpoint. A hook observed after it must not be claimed either
// way from wall-clock evidence alone.
test('the strictly-before-checkpoint claim is made only when the hook precedes the response', async () => {
  const { deriveOrdering } = await import(s0Url);
  const timings = {
    threadStartResponseMs: 100,
    turnStartResponseMs: 200,
    turnStartedNotificationMs: 210,
    turnCompletedNotificationMs: 400,
  };
  assert.equal(
    deriveOrdering(timings, [{ eventName: 'userPromptSubmit', observedAtMs: 199 }])
      .userPromptSubmitStrictlyBeforeTurnAccepted,
    true,
  );
  for (const observedAtMs of [200, 201, null]) {
    assert.equal(
      deriveOrdering(timings, [{ eventName: 'userPromptSubmit', observedAtMs }])
        .userPromptSubmitStrictlyBeforeTurnAccepted,
      false,
      `an observation at ${String(observedAtMs)} must not claim to precede the checkpoint`,
    );
  }
});

test('rpc error codes classify to a closed set', async () => {
  const { classifyRpcErrorCode, RPC_ERROR_CLASSES } = await import(s0Url);
  assert.equal(classifyRpcErrorCode(null), 'none');
  assert.equal(classifyRpcErrorCode(-32601), 'method-not-found');
  assert.equal(classifyRpcErrorCode(-32602), 'invalid-params');
  assert.equal(classifyRpcErrorCode(-32600), 'invalid-request');
  assert.equal(classifyRpcErrorCode(-32603), 'internal-error');
  assert.equal(classifyRpcErrorCode(12345), 'other');
  for (const value of [null, -32601, 7]) {
    assert.ok(RPC_ERROR_CLASSES.includes(classifyRpcErrorCode(value)));
  }
});

// ---------------------------------------------------------------------------
// The recorder. Hook stdin carries the user prompt, workspace and transcript
// path; nothing raw may reach disk.
// ---------------------------------------------------------------------------

function runRecorder(dir, eventName, stdin) {
  return spawnSync(process.execPath, [recorderPath, eventName, dir], {
    input: stdin,
    encoding: 'utf8',
  });
}

test('the recorder persists only closed fields and never the raw payload', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-recorder-');
  const captureDir = path.join(dir, 'capture');
  mkdirSync(captureDir, { mode: 0o700 });
  const run = runRecorder(captureDir, 'userPromptSubmit', JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    turn_id: '01a00985-3f69-7360-9668-c93eaf37913c',
    session_id: '01a00985-31c7-7020-b03f-3d7219939bd4',
    prompt: 'SENTINEL_PROMPT_TEXT',
    cwd: '/Users/example/SENTINEL_PATH',
    transcript_path: '/Users/example/SENTINEL_TRANSCRIPT',
    last_assistant_message: 'SENTINEL_ASSISTANT',
  }));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '', 'the recorder must write nothing to stdout');
  const files = readdirSync(captureDir);
  assert.equal(files.length, 1);
  const onDisk = readFileSync(path.join(captureDir, files[0]), 'utf8');
  assert.doesNotMatch(onDisk, /SENTINEL_/);
  assert.doesNotMatch(onDisk, /01a00985-3f69-7360-9668-c93eaf37913c/, 'no raw turn id on disk');
  assert.equal(lstatSync(path.join(captureDir, files[0])).mode & 0o777, 0o600);

  const [record] = readS0Captures(captureDir);
  assert.equal(record.eventName, 'userPromptSubmit');
  assert.equal(record.turnIdPresent, true);
  assert.equal(record.payloadParsed, true);
  assert.match(record.turnIdSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(record.observedAtMs));
});

test('a sessionStart capture records absent turn identity without inventing one', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-recorder-abs-');
  const captureDir = path.join(dir, 'capture');
  mkdirSync(captureDir, { mode: 0o700 });
  const run = runRecorder(captureDir, 'sessionStart', JSON.stringify({
    hook_event_name: 'SessionStart', source: 'startup',
  }));
  assert.equal(run.status, 0, run.stderr);
  const [record] = readS0Captures(captureDir);
  assert.equal(record.eventName, 'sessionStart');
  assert.equal(record.turnIdPresent, false);
  assert.equal(record.turnIdSha256, null);
  assert.equal(record.payloadParsed, true);
});

test('every invocation is counted rather than overwritten by the last writer', async (t) => {
  const { readS0Captures, summarizeCaptures } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-recorder-count-');
  const captureDir = path.join(dir, 'capture');
  mkdirSync(captureDir, { mode: 0o700 });
  const digest = require('node:crypto').createHash('sha256').update('turn-x').digest('hex');
  for (let index = 0; index < 3; index += 1) {
    runRecorder(captureDir, 'stop', JSON.stringify({ turn_id: 'turn-x' }));
  }
  assert.equal(readdirSync(captureDir).length, 3);
  const summary = summarizeCaptures(readS0Captures(captureDir), digest);
  assert.equal(summary.stop.invocationCount, 3);
  assert.equal(summary.stop.turnIdMatchesAuthoritative, true);
  assert.equal(summary.sessionStart.invocationCount, 0);
  assert.equal(summary.unrecognizedEventCount, 0);
});

test('an unrecognized event name is recorded as unrecognized, not echoed', async (t) => {
  const { readS0Captures, summarizeCaptures } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-recorder-bad-');
  const captureDir = path.join(dir, 'capture');
  mkdirSync(captureDir, { mode: 0o700 });
  const run = runRecorder(captureDir, 'SENTINEL_EVENT', JSON.stringify({ turn_id: 'x' }));
  assert.equal(run.status, 0, 'a recorder failure must never block the turn');
  const onDisk = readFileSync(
    path.join(captureDir, readdirSync(captureDir)[0]),
    'utf8',
  );
  assert.doesNotMatch(onDisk, /SENTINEL_/);
  const records = readS0Captures(captureDir);
  assert.equal(records[0].eventName, null);
  assert.equal(summarizeCaptures(records, null).unrecognizedEventCount, 1);
});

test('an unparsable payload is reported rather than guessed at', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-recorder-garbage-');
  const captureDir = path.join(dir, 'capture');
  mkdirSync(captureDir, { mode: 0o700 });
  runRecorder(captureDir, 'stop', 'SENTINEL_NOT_JSON');
  const onDisk = readFileSync(path.join(captureDir, readdirSync(captureDir)[0]), 'utf8');
  assert.doesNotMatch(onDisk, /SENTINEL_/);
  const [record] = readS0Captures(captureDir);
  assert.equal(record.payloadParsed, false);
  assert.equal(record.turnIdPresent, false);
});

test('the recorder writes nothing when it is not given an absolute capture directory', async (t) => {
  const dir = scratch(t, 'orchestra-u23-recorder-nodir-');
  const run = spawnSync(process.execPath, [recorderPath, 'stop'], {
    input: '{}', encoding: 'utf8', cwd: dir,
  });
  assert.equal(run.status, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('the recorder projection is pure and never returns the payload', async () => {
  const { projectHookPayload } = await import(recorderUrl);
  const record = projectHookPayload({
    eventName: 'stop',
    payload: JSON.stringify({ turn_id: 'turn-1', prompt: 'SENTINEL_PROMPT' }),
    observedAtMs: 42,
  });
  assert.doesNotMatch(JSON.stringify(record), /SENTINEL_|turn-1/);
  assert.deepEqual(
    Object.keys(record).sort(),
    ['eventName', 'observedAtMs', 'payloadParsed', 'turnIdPresent', 'turnIdSha256'],
  );
  assert.equal(projectHookPayload({ eventName: 'stop', payload: '[]', observedAtMs: 1 }).payloadParsed, false);
});

test('a capture file with an unexpected key set fails closed', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-capture-keys-');
  writeFileSync(path.join(dir, 'capture.1.2.json'), JSON.stringify({
    eventName: 'stop', turnIdPresent: false, turnIdSha256: null,
    observedAtMs: 1, payloadParsed: true, extra: 'SENTINEL_EXTRA',
  }));
  let caught = null;
  try {
    readS0Captures(dir);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'an unexpected capture key set must fail closed');
  assert.doesNotMatch(String(caught.message), /SENTINEL_/);
});

// ---------------------------------------------------------------------------
// Owned config rendering. The object model and its TOML rendering come from
// one source so they cannot drift apart, and a hooks-off rendering must not
// gain a byte from hook support existing.
// ---------------------------------------------------------------------------

test('the owned config renders deterministically and only carries what it was told to', async () => {
  const { buildS0Config, renderS0Config, jsonDigest } = await import(s0Url);
  const base = {
    codexHome: '/probe/home', workspace: '/probe/ws', providerPort: 4242,
  };
  const plain = buildS0Config({ ...base, withFeaturesHooks: false });
  assert.equal(Object.hasOwn(plain, 'features'), false);
  assert.equal(Object.hasOwn(plain, 'hooks'), false);
  assert.equal(renderS0Config(plain), renderS0Config(buildS0Config({ ...base, withFeaturesHooks: false })));
  assert.doesNotMatch(renderS0Config(plain), /\[features\]|hooks\.state/);

  const withFlag = buildS0Config({ ...base, withFeaturesHooks: true });
  assert.deepEqual(withFlag.features, { hooks: true });
  assert.match(renderS0Config(withFlag), /\[features\]\n"hooks" = true/);
  assert.notEqual(jsonDigest(plain), jsonDigest(withFlag));

  const trusted = buildS0Config({
    ...base,
    withFeaturesHooks: true,
    trustState: {
      '/probe/home/hooks.json:stop:0:0': `sha256:${'b'.repeat(64)}`,
      '/probe/home/hooks.json:session_start:0:0': `sha256:${'a'.repeat(64)}`,
    },
  });
  assert.deepEqual(
    Object.keys(trusted.hooks.state),
    ['/probe/home/hooks.json:session_start:0:0', '/probe/home/hooks.json:stop:0:0'],
    'trust stanza keys are sorted so the rendering is stable',
  );
  const rendered = renderS0Config(trusted);
  assert.match(rendered, /\[hooks\.state\."\/probe\/home\/hooks\.json:stop:0:0"\]/);
  assert.match(rendered, /"trusted_hash" = "sha256:b{64}"/);
  assert.equal(rendered.indexOf('session_start') < rendered.indexOf(':stop:'), true);
  assert.notEqual(jsonDigest(trusted), jsonDigest(withFlag));
});

test('documented usage matches the accepted arguments', async () => {
  const { USAGE, parseS0Args } = await import(s0Url);
  const documented = [...new Set(
    [...USAGE.matchAll(/(--[a-z-]+)/g)].map((match) => match[1]),
  )].sort();
  assert.deepEqual(documented, ['--binary', '--probe-root', '--runtime']);
  assert.deepEqual(
    parseS0Args(['--binary', '/abs/codex', '--probe-root', '/abs/root'], '/abs/node'),
    { binary: '/abs/codex', probeRoot: '/abs/root', runtime: '/abs/node' },
  );
  // The runtime is an attested artifact, so it must be overridable when the
  // invoking one sits under a parent chain the attestation rejects.
  assert.equal(
    parseS0Args(
      ['--binary', '/abs/codex', '--probe-root', '/abs/root', '--runtime', '/pinned/node'],
      '/abs/node',
    ).runtime,
    '/pinned/node',
  );
  assert.throws(() => parseS0Args(['--workspace', '/abs/ws']), /unknown argument/);
  assert.throws(() => parseS0Args(['--binary', '/abs/codex']), /missing required/);
  assert.throws(
    () => parseS0Args(['--binary', '/a', '--probe-root', '/b', '--runtime', ''], '/abs/node'),
    /missing required/,
  );
});

test('scratch is removed and a content-free stop is returned when the provider cannot start', async (t) => {
  const { characterizeHookTrust } = await import(s0Url);
  const root = scratch(t, 'orchestra-u23-s0-provider-');
  const envelope = await characterizeHookTrust({
    binary: '/stubbed/codex',
    probeRoot: root,
    attestBinary: async () => ({ path: '/stubbed/codex', sha256: 'a'.repeat(64), version: 'stub' }),
    startProvider: async () => { throw new Error('provider refused at /Users/example'); },
  });
  assert.equal(envelope.gate, 'STOP');
  assert.doesNotMatch(JSON.stringify(envelope), /Users|refused/);
  assert.deepEqual(readdirSync(root), [], 'characterization scratch must not survive');
});

// The release gate's own contract must not move because this characterization
// exists beside it.
test('the release gate keeps its two-event contract and its own evidence shape', async () => {
  const probe = await import(pathToFileURL(path.resolve(
    __dirname, '../scripts/spikes/codex-app-server-hook-probe.mjs',
  )).href);
  assert.deepEqual([...probe.EXPECTED_HOOK_EVENTS], ['sessionStart', 'userPromptSubmit']);
  assert.equal(typeof probe.startLoopbackProvider, 'function');
  const { S0_EVENTS } = await import(s0Url);
  assert.deepEqual([...S0_EVENTS], ['sessionStart', 'userPromptSubmit', 'stop']);
});

// The credential-free gate is only a gate if it can actually read the config
// this script writes. The release gate's reader matches a bare TOML key and
// this rendering quotes every key, so a shared reader would have reported
// "unknown" on every run instead of failing.
test('the credential-free reader agrees with the config this script actually writes', async () => {
  const { buildS0Config, renderS0Config, readRequiresOpenAiAuth } = await import(s0Url);
  const probe = await import(pathToFileURL(path.resolve(
    __dirname, '../scripts/spikes/codex-app-server-hook-probe.mjs',
  )).href);
  const rendered = renderS0Config(buildS0Config({
    codexHome: '/probe/home', workspace: '/probe/ws', providerPort: 4242,
    withFeaturesHooks: false,
  }));
  assert.match(rendered, /"requires_openai_auth" = false/);
  assert.equal(
    readRequiresOpenAiAuth(rendered),
    false,
    'credential-free must be read from the config actually written',
  );
  assert.equal(
    probe.readProviderRequiresAuth(rendered),
    null,
    'the bare-key reader cannot read this rendering; that is why a second reader exists',
  );
  assert.equal(readRequiresOpenAiAuth('requires_openai_auth = true\n'), true);
  assert.equal(readRequiresOpenAiAuth('"requires_openai_auth" = true\n'), true);
  assert.equal(readRequiresOpenAiAuth('model = "x"\n'), null);
});

test('every param form under test is projected, including the empty cwds list', async () => {
  const { PARAM_FORMS, buildS0Envelope } = await import(s0Url);
  assert.deepEqual([...PARAM_FORMS], [
    'omitted', 'empty', 'emptyCwds', 'ownedCwd', 'foreignCwd', 'bothCwds',
  ]);
  const envelope = buildS0Envelope(passingMeasurement({
    e2ParamForms: {
      empty: { verdict: 'accepted', responseKeysAreDataOnly: true, entryCount: 1 },
    },
  }));
  for (const form of PARAM_FORMS) {
    assert.ok(
      Object.hasOwn(envelope.evidence.e2ParamForms, form),
      `${form} must appear in the envelope even when unmeasured`,
    );
  }
  assert.equal(envelope.evidence.e2ParamForms.empty.responseKeysAreDataOnly, true);
  assert.equal(envelope.evidence.e2ParamForms.omitted.responseKeysAreDataOnly, false);
});

test('the same-session content source is a closed three-way verdict', async () => {
  const { FIRE_TIME_CONTENT_SOURCES, buildS0Envelope } = await import(s0Url);
  assert.deepEqual([...FIRE_TIME_CONTENT_SOURCES], [
    'on-disk-at-fire-time', 'thread-start-snapshot', 'refused',
  ]);
  const envelope = buildS0Envelope(passingMeasurement({
    e6FireTime: { sameSessionContentSource: 'SENTINEL_SOURCE' },
  }));
  assert.equal(envelope.evidence.e6FireTime.sameSessionContentSource, null);
  assert.doesNotMatch(JSON.stringify(envelope), /SENTINEL_/);
});

// Durations are the checkpoint race's budget, so they are reported as closed
// buckets rather than as raw readings.
test('margins are bucketed into a closed set and never emitted as raw readings', async () => {
  const { bucketMargin, MARGIN_BUCKETS, deriveOrdering } = await import(s0Url);
  assert.equal(bucketMargin(100, 99), 'negative');
  assert.equal(bucketMargin(100, 100.5), 'under-1ms');
  assert.equal(bucketMargin(100, 105), '1-10ms');
  assert.equal(bucketMargin(100, 150), '10-100ms');
  assert.equal(bucketMargin(100, 600), '100ms-1s');
  assert.equal(bucketMargin(100, 5_000), 'over-1s');
  assert.equal(bucketMargin(null, 5), 'unobserved');
  const ordering = deriveOrdering({
    threadStartResponseMs: 100,
    turnStartResponseMs: 200,
    turnStartedNotificationMs: 205,
    turnCompletedNotificationMs: 900,
  }, [
    { eventName: 'sessionStart', observedAtMs: 140 },
    { eventName: 'userPromptSubmit', observedAtMs: 260 },
    { eventName: 'stop', observedAtMs: 880 },
  ]);
  assert.equal(ordering.threadStartResponseToSessionStartBucket, '10-100ms');
  assert.equal(ordering.turnStartResponseToUserPromptSubmitBucket, '10-100ms');
  assert.equal(ordering.userPromptSubmitToStopBucket, '100ms-1s');
  assert.equal(ordering.stopToTurnCompletedBucket, '10-100ms');
  const serialized = JSON.stringify(ordering);
  for (const raw of ['100', '140', '260', '880', '900']) {
    assert.doesNotMatch(serialized, new RegExp(`\\b${raw}\\b`), 'no raw reading may be emitted');
  }
  for (const value of Object.values(ordering)) {
    if (typeof value === 'boolean') continue;
    assert.ok(
      MARGIN_BUCKETS.includes(value) || ['before', 'after', 'ambiguous', 'unobserved'].includes(value),
    );
  }
});

// ===========================================================================
// Gate completeness and safety.
//
// An envelope that reports every decision "measured" is not the same as an
// envelope whose measurements are safe or even present. These cases each hold
// the run otherwise complete and break exactly one property.
// ===========================================================================

function receiptFixture(kind, overrides = {}) {
  return {
    kind,
    sha256: (kind === 'system-runtime' ? 'e' : 'f').repeat(64),
    nlink: 1,
    isRegularFile: true,
    isSymlink: false,
    isCanonicalPath: true,
    ownerIsSelf: true,
    ownerIsRoot: false,
    groupOrWorldWritable: false,
    ownerExecutable: kind === 'system-runtime',
    ownerOnlyMode: false,
    satisfiesKindRule: true,
    parentChainSafe: true,
    ...overrides,
  };
}

function inventoryFixture(eventName, trustStatus, displayOrder) {
  return {
    eventName,
    trustStatus,
    handlerType: 'command',
    source: 'user',
    enabled: true,
    isManaged: false,
    displayOrder,
    timeoutSec: 600,
    requiredFieldsPresent: true,
    currentHashWellFormed: true,
    keyMatchesTemplate: true,
    keySnakeTokenMatches: true,
    keyIndexI: 0,
    keyIndexJ: 0,
    sourcePathMatchesManifest: true,
    commandPresent: true,
    commandMatchesRendered: true,
    optionalFieldsWithKey: [
      'additionalContextLimit', 'command', 'matcher', 'pluginId', 'statusMessage',
    ],
    optionalFieldsNonNull: ['command'],
    unknownFieldCount: 0,
  };
}

function layerFixture(withTrust) {
  return {
    layerCount: 2,
    layerTypes: ['user', 'system'],
    unrecognizedLayerCount: 0,
    userLayerPresent: true,
    userLayerDigest: (withTrust ? '1' : '2').repeat(64),
    userLayerEqualsWrittenObjectModel: true,
    userLayerTopLevelKeyCount: withTrust ? 13 : 12,
    userLayerUnexpectedTopLevelKeyCount: 0,
    userLayerHooksPresent: withTrust,
    userLayerHooksTableKeys: withTrust ? ['state'] : [],
    userLayerHooksUnexpectedTableKeyCount: 0,
    userLayerHooksStateEntryCount: withTrust ? 3 : 0,
    userLayerHooksStateKeysEqualPredeclared: true,
    userLayerHooksStateFieldNames: withTrust ? ['enabled', 'trusted_hash'] : [],
    userLayerHooksStateUnexpectedFieldCount: 0,
    effectiveConfigDigest: (withTrust ? '3' : '4').repeat(64),
    effectiveHooksPresent: withTrust,
    effectiveHooksTableKeyCount: withTrust ? 12 : 0,
  };
}

function paramFormFixture(verdict, overrides = {}) {
  return {
    verdict,
    rpcErrorClass: verdict === 'accepted' ? 'none' : 'invalid-request',
    responseKeysAreDataOnly: verdict === 'accepted',
    entryCount: verdict === 'accepted' ? 1 : 0,
    hookCount: verdict === 'accepted' ? 3 : 0,
    everyEntryCwdEqualsOwned: verdict === 'accepted',
    anyEntryCwdEqualsRequestedForeign: false,
    errorsEmptyOnEvery: true,
    warningsEmptyOnEvery: true,
    ...overrides,
  };
}

function captureFixture(invocationCount, present) {
  return {
    invocationCount,
    turnIdPresentOnEvery: present,
    turnIdAbsentOnEvery: !present,
    turnIdMatchesAuthoritative: present,
    payloadParsedOnEvery: true,
  };
}

// Mirrors a real passing live run.
function completeMeasurement(mutate = () => {}) {
  const measured = {
    unmeasured: [],
    receipts: {
      pinnedBinaryAttested: true,
      target: 'aarch64-apple-darwin',
      systemRuntime: receiptFixture('system-runtime'),
      shippedArtifact: receiptFixture('shipped-artifact', { ownerExecutable: false }),
      commandRenderIsDeterministic: true,
      appServerLaunchesIntended: 19,
      appServerLaunchesAttested: 19,
      commandDigestByEvent: {
        sessionStart: 'a'.repeat(64),
        userPromptSubmit: 'b'.repeat(64),
        stop: 'c'.repeat(64),
      },
    },
    credentialFree: {
      authFileAbsent: true,
      providerRequiresAuth: false,
      isolatedHomeMode0700: true,
    },
    e2ParamForms: {
      omitted: paramFormFixture('rejected'),
      empty: paramFormFixture('accepted'),
      emptyCwds: paramFormFixture('accepted'),
      ownedCwd: paramFormFixture('accepted'),
      foreignCwd: paramFormFixture('accepted', {
        everyEntryCwdEqualsOwned: false, anyEntryCwdEqualsRequestedForeign: true,
      }),
      bothCwds: paramFormFixture('accepted', {
        entryCount: 2, hookCount: 6,
        everyEntryCwdEqualsOwned: false, anyEntryCwdEqualsRequestedForeign: true,
      }),
    },
    e1UserLayer: {
      hooksPresentNoTrust: layerFixture(false),
      trusted: layerFixture(true),
      userLayerDigestStableAcrossSessions: true,
    },
    e4FeatureFlag: {
      withFlag: { hookCountListed: 3, allTrustedAfterRender: true, firedEventCount: 3 },
      withoutFlag: { hookCountListed: 3, allTrustedAfterRender: true, firedEventCount: 3 },
      requiredForDiscovery: false,
      requiredForExecution: false,
    },
    e5KeyDerivation: Object.fromEntries(
      ['sessionStart', 'userPromptSubmit', 'stop'].map((eventName) => [eventName, {
        matchesTemplate: true, snakeTokenMatches: true, indexI: 0, indexJ: 0,
      }]),
    ),
    metadata: {
      untrustedInventory: [
        inventoryFixture('sessionStart', 'untrusted', 0),
        inventoryFixture('userPromptSubmit', 'untrusted', 1),
        inventoryFixture('stop', 'untrusted', 2),
      ],
      trustedInventory: [
        inventoryFixture('sessionStart', 'trusted', 0),
        inventoryFixture('userPromptSubmit', 'trusted', 1),
        inventoryFixture('stop', 'trusted', 2),
      ],
      untrustedInventoryTrustable: true,
      trustedInventoryTrustable: true,
      currentHashStableAcrossSessions: true,
    },
    e6FireTime: {
      firstTurnCaptureCount: 3,
      sameSessionAfterMutationOldPathCount: 2,
      sameSessionAfterMutationNewPathCount: 0,
      sameSessionSecondTurn: { status: 'completed', assistantItemObserved: true, identityConsistent: true },
      newSessionInventoryExact: true,
      sameSessionContentSource: 'thread-start-snapshot',
      revalidatesAtFireTime: false,
      newSessionTrustStatusAfterMutation: ['modified'],
      newSessionOldPathCaptureCount: 0,
      newSessionNewPathCaptureCount: 0,
      newSessionTurnCompleted: true,
      snapshotBoundary: 'during-thread-start',
      boundaryPreSpawnVerdict: 'new-content',
      boundaryPostStartVerdict: 'new-content',
      boundaryPostThreadVerdict: 'none',
      boundaryLanesHealthy: true,
    },
    e7Ordering: {
      sessionStartVsThreadStartResponse: 'after',
      userPromptSubmitVsTurnStartResponse: 'after',
      userPromptSubmitVsTurnStartedNotification: 'after',
      userPromptSubmitVsStop: 'before',
      stopVsTurnStartedNotification: 'after',
      stopVsTurnCompletedNotification: 'before',
      turnStartedNotificationVsTurnStartResponse: 'after',
      userPromptSubmitStrictlyBeforeTurnAccepted: false,
      stopStrictlyBeforeTurnAccepted: false,
      threadStartResponseToSessionStartBucket: '10-100ms',
      turnStartResponseToUserPromptSubmitBucket: '1-10ms',
      turnStartedNotificationToUserPromptSubmitBucket: '1-10ms',
      userPromptSubmitToStopBucket: '10-100ms',
      stopToTurnCompletedBucket: '1-10ms',
    },
    turnIdentity: {
      responseMatchesStarted: true,
      responseMatchesCompleted: true,
      hookTurnIdsMatchResponse: true,
      allConsistent: true,
    },
    auxiliaryLanes: {
      newSessionLaneHealthy: true,
      featureFlagLaneHealthy: true,
      boundaryLanesHealthy: true,
    },
    turn: {
      hooksOn: {
        turnStatus: 'completed',
        faultCategory: 'none',
        deliveredHookMethodCount: 0,
        closeClean: true,
        childRetired: true,
        turnCount: 2,
      },
      firstTurn: {
        status: 'completed',
        assistantItemObserved: true,
        identityConsistent: true,
      },
      captures: {
        sessionStart: captureFixture(1, false),
        userPromptSubmit: captureFixture(1, true),
        stop: captureFixture(1, true),
        unrecognizedEventCount: 0,
      },
    },
    stability: {
      configDigestUnchangedAcrossTurn: true,
      hooksManifestDigestUnchangedAcrossTurn: true,
      configDigestChangedByTrustRender: true,
    },
    cleanup: { strayProcessCount: 0, probeRootRemoved: true },
  };
  mutate(measured);
  return measured;
}

test('a complete, safe measurement is the only thing that reaches CONTINUE', async () => {
  const { buildS0Envelope, S0_GATE_CHECKS } = await import(s0Url);
  const envelope = buildS0Envelope(completeMeasurement());
  assert.deepEqual(envelope.failedChecks, [], 'nothing may fail on complete evidence');
  assert.deepEqual(envelope.unmeasured, []);
  assert.equal(envelope.gate, 'CONTINUE');
  assert.deepEqual(
    Object.keys(envelope.checks).sort(),
    [...S0_GATE_CHECKS].sort(),
    'the check set is closed and fully reported',
  );
});

const ADVERSE_CASES = [
  ['unattested binary', (m) => { m.receipts.pinnedBinaryAttested = false; }, 'pinnedBinaryAttested'],
  ['unrecognized target', (m) => { m.receipts.target = 'SENTINEL_TARGET'; }, 'targetReceiptRecognized'],
  ['runtime fails its kind rule', (m) => { m.receipts.systemRuntime.satisfiesKindRule = false; }, 'systemRuntimeReceiptSafe'],
  ['runtime is a symlink despite a true summary', (m) => { m.receipts.systemRuntime.isSymlink = true; }, 'systemRuntimeReceiptSafe'],
  ['runtime is hard-linked', (m) => { m.receipts.systemRuntime.nlink = 2; }, 'systemRuntimeReceiptSafe'],
  ['runtime parent chain unsafe', (m) => { m.receipts.systemRuntime.parentChainSafe = false; }, 'systemRuntimeReceiptSafe'],
  ['runtime digest missing', (m) => { m.receipts.systemRuntime.sha256 = null; }, 'systemRuntimeReceiptSafe'],
  ['artifact group-writable', (m) => { m.receipts.shippedArtifact.groupOrWorldWritable = true; }, 'shippedArtifactReceiptSafe'],
  ['artifact not owner-owned', (m) => { m.receipts.shippedArtifact.ownerIsSelf = false; }, 'shippedArtifactReceiptSafe'],
  ['artifact parent chain unsafe', (m) => { m.receipts.shippedArtifact.parentChainSafe = false; }, 'shippedArtifactReceiptSafe'],
  ['only the first launch was attested', (m) => { m.receipts.appServerLaunchesAttested = 1; }, 'appServerLaunchesAllPrelaunchAttested'],
  ['no launch was attested', (m) => { m.receipts.appServerLaunchesIntended = 0; m.receipts.appServerLaunchesAttested = 0; }, 'appServerLaunchesAllPrelaunchAttested'],
  ['non-deterministic rendering', (m) => { m.receipts.commandRenderIsDeterministic = false; }, 'commandRenderingDeterministic'],
  ['missing command digest', (m) => { m.receipts.commandDigestByEvent.stop = 'not-a-digest'; }, 'commandDigestsComplete'],
  ['auth file present', (m) => { m.credentialFree.authFileAbsent = false; }, 'credentialFreeByConstruction'],
  ['provider demands auth', (m) => { m.credentialFree.providerRequiresAuth = true; }, 'credentialFreeByConstruction'],
  ['provider auth unknown', (m) => { m.credentialFree.providerRequiresAuth = null; }, 'credentialFreeByConstruction'],
  ['home not owner-only', (m) => { m.credentialFree.isolatedHomeMode0700 = false; }, 'credentialFreeByConstruction'],
  ['a param form was never probed', (m) => { delete m.e2ParamForms.emptyCwds; }, 'paramFormEvidenceComplete'],
  ['an accepted form reported errors', (m) => { m.e2ParamForms.empty.errorsEmptyOnEvery = false; }, 'paramFormEvidenceComplete'],
  ['an accepted form reported warnings', (m) => { m.e2ParamForms.empty.warningsEmptyOnEvery = false; }, 'paramFormEvidenceComplete'],
  ['an accepted form carried unexpected envelope keys', (m) => { m.e2ParamForms.empty.responseKeysAreDataOnly = false; }, 'paramFormEvidenceComplete'],
  ['the frozen form is not usable', (m) => { m.e2ParamForms.ownedCwd = paramFormFixture('rejected'); }, 'ownedCwdFormUsable'],
  ['user layer digest missing', (m) => { m.e1UserLayer.trusted.userLayerDigest = null; }, 'userLayerEvidenceComplete'],
  ['user layer digest unstable', (m) => { m.e1UserLayer.userLayerDigestStableAcrossSessions = false; }, 'userLayerEvidenceComplete'],
  ['unrecognized config layer', (m) => { m.e1UserLayer.trusted.unrecognizedLayerCount = 1; }, 'userLayerEvidenceComplete'],
  ['unexpected top-level key in the layer', (m) => { m.e1UserLayer.trusted.userLayerUnexpectedTopLevelKeyCount = 1; }, 'userLayerEvidenceComplete'],
  ['layer is not the exact parse', (m) => { m.e1UserLayer.trusted.userLayerEqualsWrittenObjectModel = false; }, 'userLayerIsExactParse'],
  ['trust state invisible in the layer', (m) => { m.e1UserLayer.trusted.userLayerHooksStateEntryCount = 2; }, 'trustStateVisibleInUserLayer'],
  ['hooks visible without trust', (m) => { m.e1UserLayer.hooksPresentNoTrust.userLayerHooksPresent = true; }, 'trustStateVisibleInUserLayer'],
  ['feature-flag answer unknown', (m) => { m.e4FeatureFlag.requiredForExecution = null; }, 'featureFlagEvidenceComplete'],
  ['key derivation not confirmed', (m) => { m.e5KeyDerivation.stop.matchesTemplate = false; }, 'keyDerivationConfirmed'],
  ['key indices unparsed', (m) => { m.e5KeyDerivation.stop.indexJ = null; }, 'keyDerivationConfirmed'],
  ['inventory carries an unknown field', (m) => { m.metadata.trustedInventory[0].unknownFieldCount = 1; }, 'hookInventoryComplete'],
  ['inventory is short', (m) => { m.metadata.trustedInventory.pop(); }, 'hookInventoryComplete'],
  ['inventory command mismatch', (m) => { m.metadata.trustedInventory[1].commandMatchesRendered = false; }, 'hookInventoryComplete'],
  ['inventory not trustable', (m) => { m.metadata.trustedInventoryTrustable = false; }, 'hookInventoryComplete'],
  ['hash unstable across sessions', (m) => { m.metadata.currentHashStableAcrossSessions = false; }, 'currentHashStableAcrossSessions'],
  ['fire-time source unknown', (m) => { m.e6FireTime.sameSessionContentSource = null; }, 'fireTimeEvidenceComplete'],
  ['fire-time revalidation unknown', (m) => { m.e6FireTime.revalidatesAtFireTime = null; }, 'fireTimeEvidenceComplete'],
  ['snapshot boundary not located', (m) => { m.e6FireTime.snapshotBoundary = null; }, 'snapshotBoundaryLocated'],
  ['boundary control did not run', (m) => { m.e6FireTime.boundaryPreSpawnVerdict = 'none'; }, 'snapshotBoundaryLocated'],
  ['a boundary lane could not be classified', (m) => { m.e6FireTime.boundaryPostThreadVerdict = null; }, 'snapshotBoundaryLocated'],
  ['a boundary lane was unhealthy', (m) => { m.auxiliaryLanes.boundaryLanesHealthy = false; }, 'auxiliaryLanesHealthy'],
  ['the fresh-session lane was unhealthy', (m) => { m.auxiliaryLanes.newSessionLaneHealthy = false; }, 'auxiliaryLanesHealthy'],
  ['the feature-flag lane was unhealthy', (m) => { m.auxiliaryLanes.featureFlagLaneHealthy = false; }, 'auxiliaryLanesHealthy'],
  ['an unrecognized decision label', (m) => { m.unmeasured = ['SENTINEL_LABEL']; }, 'unmeasuredLabelsRecognized'],
  ['an ordering verdict is ambiguous', (m) => { m.e7Ordering.stopVsTurnCompletedNotification = 'ambiguous'; }, 'orderingEvidenceComplete'],
  ['an ordering verdict is unobserved', (m) => { m.e7Ordering.userPromptSubmitVsStop = 'unobserved'; }, 'orderingEvidenceComplete'],
  ['a duration bucket is unobserved', (m) => { m.e7Ordering.turnStartResponseToUserPromptSubmitBucket = 'unobserved'; }, 'orderingEvidenceComplete'],
  ['turn identity inconsistent', (m) => { m.turnIdentity.responseMatchesStarted = false; }, 'turnIdentityConsistent'],
  ['hook turn ids do not match the response', (m) => { m.turnIdentity.hookTurnIdsMatchResponse = false; }, 'turnIdentityConsistent'],
  ['the first turn did not complete', (m) => { m.turn.firstTurn.status = 'failed'; }, 'characterizationTurnClean'],
  ['the first turn produced no assistant item', (m) => { m.turn.firstTurn.assistantItemObserved = false; }, 'characterizationTurnClean'],
  ['the first turn identity disagreed', (m) => { m.turn.firstTurn.identityConsistent = false; }, 'characterizationTurnClean'],
  ['turn faulted', (m) => { m.turn.hooksOn.faultCategory = 'protocol'; }, 'characterizationTurnClean'],
  ['a hook notification reached the sink', (m) => { m.turn.hooksOn.deliveredHookMethodCount = 1; }, 'characterizationTurnClean'],
  ['client close failed', (m) => { m.turn.hooksOn.closeClean = false; }, 'characterizationTurnClean'],
  ['the owned child was not proved retired', (m) => { m.turn.hooksOn.childRetired = false; }, 'characterizationTurnClean'],
  ['a capture is missing', (m) => { m.turn.captures.stop.invocationCount = 0; }, 'hookCapturesComplete'],
  ['a capture fired twice', (m) => { m.turn.captures.stop.invocationCount = 2; }, 'hookCapturesComplete'],
  ['a turn id did not match', (m) => { m.turn.captures.userPromptSubmit.turnIdMatchesAuthoritative = false; }, 'hookCapturesComplete'],
  ['sessionStart invented a turn id', (m) => { m.turn.captures.sessionStart.turnIdAbsentOnEvery = false; }, 'hookCapturesComplete'],
  ['an unrecognized capture appeared', (m) => { m.turn.captures.unrecognizedEventCount = 1; }, 'hookCapturesComplete'],
  ['the manifest changed across a turn', (m) => { m.stability.hooksManifestDigestUnchangedAcrossTurn = false; }, 'turnFileStabilityHeld'],
  ['a stray process survived', (m) => { m.cleanup.strayProcessCount = 1; }, 'ownedProcessesRetired'],
  ['scratch survived', (m) => { m.cleanup.probeRootRemoved = false; }, 'scratchRemoved'],
];

test('adverse evidence stops the gate instead of exiting clean', async () => {
  const { buildS0Envelope, S0_GATE_CHECKS, envelopeIsContentFree } = await import(s0Url);
  for (const [name, mutate, expectedCheck] of ADVERSE_CASES) {
    const envelope = buildS0Envelope(completeMeasurement(mutate));
    assert.equal(envelope.gate, 'STOP', `${name} must not reach CONTINUE`);
    assert.ok(
      envelope.failedChecks.includes(expectedCheck),
      `${name} must fail ${expectedCheck}, got ${JSON.stringify(envelope.failedChecks)}`,
    );
    for (const failed of envelope.failedChecks) {
      assert.ok(S0_GATE_CHECKS.includes(failed), `${failed} is outside the closed check set`);
    }
    assert.equal(envelopeIsContentFree(envelope), true, `${name} leaked content`);
    assert.doesNotMatch(JSON.stringify(envelope), /SENTINEL_/);
  }
});

test('every declared gate check is exercised by at least one adverse case', async () => {
  const { S0_GATE_CHECKS } = await import(s0Url);
  const covered = new Set(ADVERSE_CASES.map(([, , check]) => check));
  assert.deepEqual(
    [...S0_GATE_CHECKS].filter((check) => !covered.has(check)),
    [],
    'a gate check with no adverse case cannot be trusted to fire',
  );
});

test('an unmeasured decision and a failed check both stop the gate independently', async () => {
  const { buildS0Envelope } = await import(s0Url);
  const unmeasuredOnly = buildS0Envelope(completeMeasurement((m) => { m.unmeasured = ['E1']; }));
  assert.equal(unmeasuredOnly.gate, 'STOP');
  assert.deepEqual(unmeasuredOnly.failedChecks, []);
  const failedOnly = buildS0Envelope(completeMeasurement((m) => { m.cleanup.strayProcessCount = 3; }));
  assert.equal(failedOnly.gate, 'STOP');
  assert.deepEqual(failedOnly.unmeasured, []);
});

// ===========================================================================
// Inventory trust whitelisting.
//
// A key and a hash are only safe to render into a trust stanza if the whole
// inventory matched the expected manifest exactly. Harvesting them from
// entries whose identity did not check out is how a foreign or tampered hook
// would get itself trusted.
// ===========================================================================

function inventoryExpectations() {
  return {
    sourcePath: '/probe/hooks.json',
    trustStatus: 'untrusted',
    events: ['sessionStart', 'userPromptSubmit', 'stop'],
    commandByEvent: {
      sessionStart: "'/bin/node' '/opt/rec.mjs' 'sessionStart'",
      userPromptSubmit: "'/bin/node' '/opt/rec.mjs' 'userPromptSubmit'",
      stop: "'/bin/node' '/opt/rec.mjs' 'stop'",
    },
  };
}

// Mirrors the exact shape the live fixture produces, including the optional
// fields that are present-but-null.
function rawInventoryEntry(eventName, snake, displayOrder, overrides = {}) {
  return {
    key: `/probe/hooks.json:${snake}:0:0`,
    currentHash: `sha256:${eventName.length.toString().repeat(64).slice(0, 64)}`,
    trustStatus: 'untrusted',
    enabled: true,
    command: `'/bin/node' '/opt/rec.mjs' '${eventName}'`,
    sourcePath: '/probe/hooks.json',
    eventName,
    displayOrder,
    handlerType: 'command',
    isManaged: false,
    source: 'user',
    timeoutSec: 600,
    additionalContextLimit: null,
    matcher: null,
    pluginId: null,
    statusMessage: null,
    ...overrides,
  };
}

function rawInventory(mutate = () => {}) {
  const entries = [
    rawInventoryEntry('sessionStart', 'session_start', 0),
    rawInventoryEntry('userPromptSubmit', 'user_prompt_submit', 1),
    rawInventoryEntry('stop', 'stop', 2),
  ];
  mutate(entries);
  return entries;
}

test('an exactly matching inventory is trustable and yields one hash per descriptor', async () => {
  const { splitHookInventory } = await import(s0Url);
  const { projected, trust, trustable } = splitHookInventory(
    rawInventory(), inventoryExpectations(),
  );
  assert.equal(trustable, true);
  assert.equal(projected.length, 3);
  assert.equal(trust.length, 3);
  assert.deepEqual(
    trust.map((entry) => entry.key).sort(),
    [
      '/probe/hooks.json:session_start:0:0',
      '/probe/hooks.json:stop:0:0',
      '/probe/hooks.json:user_prompt_submit:0:0',
    ],
  );
});

test('an inventory that is not an exact match yields no trustable hash at all', async () => {
  const { splitHookInventory } = await import(s0Url);
  const cases = [
    ['a duplicate event', (e) => { e.push(rawInventoryEntry('stop', 'stop', 2)); }],
    ['an extra foreign hook', (e) => {
      e.push(rawInventoryEntry('sessionEnd', 'session_end', 3, { eventName: 'sessionEnd' }));
    }],
    ['a missing hook', (e) => { e.pop(); }],
    ['an empty inventory', (e) => { e.length = 0; }],
    ['a key that does not derive', (e) => { e[0].key = '/probe/hooks.json:sessionStart:0:0'; }],
    ['a foreign source path', (e) => { e[1].sourcePath = '/elsewhere/hooks.json'; }],
    ['a command that is not the rendering', (e) => { e[2].command = 'SENTINEL_TAMPERED'; }],
    ['an absent command', (e) => { delete e[2].command; }],
    ['a malformed hash', (e) => { e[0].currentHash = 'not-a-digest'; }],
    ['a managed hook', (e) => { e[1].isManaged = true; }],
    ['a non-user source', (e) => { e[1].source = 'plugin'; }],
    ['a prompt handler', (e) => { e[2].handlerType = 'prompt'; }],
    ['a missing required field', (e) => { delete e[0].timeoutSec; }],
    ['an unknown field', (e) => { e[0].futureField = 'SENTINEL_UNKNOWN'; }],
    ['duplicate keys on distinct events', (e) => { e[1].key = e[0].key; }],
  ];
  for (const [name, mutate] of cases) {
    const result = splitHookInventory(rawInventory(mutate), inventoryExpectations());
    assert.equal(result.trustable, false, `${name} must not be trustable`);
    assert.deepEqual(result.trust, [], `${name} must yield no harvestable hash`);
    assert.doesNotMatch(JSON.stringify(result.projected), /SENTINEL_/);
  }
});

test('rendering trust from an untrustable inventory is refused before any turn', async () => {
  const { trustStateFromInventory } = await import(s0Url);
  const good = trustStateFromInventory({
    trustable: true,
    trust: [{ key: '/probe/hooks.json:stop:0:0', currentHash: `sha256:${'a'.repeat(64)}` }],
  });
  assert.deepEqual(Object.keys(good), ['/probe/hooks.json:stop:0:0']);
  assert.throws(
    () => trustStateFromInventory({ trustable: false, trust: [] }),
    /attestation failure/,
  );
  assert.throws(
    () => trustStateFromInventory({ trustable: true, trust: [] }),
    /attestation failure/,
  );
});

// ===========================================================================
// Artifact attestation: enforcement, parent chain, and the swap window.
// ===========================================================================

test('an unsafe artifact is refused, not merely reported', async (t) => {
  const { attestArtifact, attestArtifactStrict } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-strict-');
  const target = path.join(dir, 'artifact.mjs');
  writeFileSync(target, 'export default 1;\n', { mode: 0o700 });
  chmodSync(target, 0o700);
  assert.equal(attestArtifactStrict(target, 'shipped-artifact').satisfiesKindRule, true);
  chmodSync(target, 0o770);
  assert.equal(attestArtifact(target, 'shipped-artifact').satisfiesKindRule, false);
  assert.throws(
    () => attestArtifactStrict(target, 'shipped-artifact'),
    /attestation failure/,
    'a reported-unsafe receipt must stop the run, not be carried forward',
  );
});

test('an artifact under a group-writable parent is unsafe however safe the file is', async (t) => {
  const { attestArtifact, attestArtifactStrict } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-parent-');
  const loose = path.join(dir, 'loose');
  mkdirSync(loose, { mode: 0o777 });
  chmodSync(loose, 0o777);
  const target = path.join(loose, 'artifact.mjs');
  writeFileSync(target, 'export default 1;\n', { mode: 0o600 });
  chmodSync(target, 0o600);
  const receipt = attestArtifact(target, 'shipped-artifact');
  assert.equal(receipt.groupOrWorldWritable, false, 'the file itself is tight');
  assert.equal(receipt.parentChainSafe, false, 'its directory is not');
  assert.equal(receipt.satisfiesKindRule, false);
  assert.throws(() => attestArtifactStrict(target, 'shipped-artifact'), /attestation failure/);
});

// The hook hash binds the command string and therefore the artifact's path,
// not the bytes of the script that path names. A swap between attestation and
// launch keeps the hash valid and changes what runs.
test('an artifact swapped after attestation is caught by re-attestation before launch', async (t) => {
  const { attestArtifactStrict, verifyPinnedArtifacts } = await import(s0Url);
  const dir = scratch(t, 'orchestra-u23-toctou-');
  const target = path.join(dir, 'artifact.mjs');
  writeFileSync(target, 'export default 1;\n', { mode: 0o700 });
  chmodSync(target, 0o700);
  const pinned = { recorder: attestArtifactStrict(target, 'shipped-artifact') };
  assert.equal(verifyPinnedArtifacts(pinned, { recorder: target }), true);
  writeFileSync(target, 'export default 2;\n', { mode: 0o700 });
  chmodSync(target, 0o700);
  let caught = null;
  try {
    verifyPinnedArtifacts(pinned, { recorder: target });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'a changed artifact body must be caught before the child launches');
  assert.match(String(caught.message), /attestation failure/);
  assert.doesNotMatch(String(caught.message), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ===========================================================================
// Capture ingestion bounds. A capture directory is attacker-adjacent: it is
// written by a child process, so it is validated before it is read.
// ===========================================================================

function captureDir(t, prefix) {
  const dir = scratch(t, prefix);
  const captures = path.join(dir, 'capture');
  mkdirSync(captures, { mode: 0o700 });
  return captures;
}

function writeCapture(dir, name, body = {
  eventName: 'stop', turnIdPresent: false, turnIdSha256: null,
  observedAtMs: 1, payloadParsed: true,
}) {
  const target = path.join(dir, name);
  writeFileSync(target, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

test('capture ingestion validates each file before it reads a byte of it', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const good = captureDir(t, 'orchestra-u23-cap-good-');
  writeCapture(good, 'capture.10.20.json');
  assert.equal(readS0Captures(good).length, 1);

  const named = captureDir(t, 'orchestra-u23-cap-name-');
  writeCapture(named, 'not-a-capture.json');
  assert.throws(() => readS0Captures(named), /framing failure/, 'filename pattern is enforced');

  const wrongMode = captureDir(t, 'orchestra-u23-cap-mode-');
  const loose = writeCapture(wrongMode, 'capture.1.2.json');
  chmodSync(loose, 0o644);
  assert.throws(() => readS0Captures(wrongMode), /framing failure/, 'mode is enforced');

  const linked = captureDir(t, 'orchestra-u23-cap-link-');
  const real = writeCapture(linked, 'capture.1.2.json');
  linkSync(real, path.join(linked, 'capture.1.3.json'));
  assert.throws(() => readS0Captures(linked), /framing failure/, 'nlink is enforced');

  const symlinked = captureDir(t, 'orchestra-u23-cap-sym-');
  const origin = writeCapture(symlinked, 'capture.1.2.json');
  symlinkSync(origin, path.join(symlinked, 'capture.1.4.json'));
  assert.throws(() => readS0Captures(symlinked), /framing failure/, 'symlinks are refused');
});

test('capture ingestion bounds file count and bytes before parsing', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const many = captureDir(t, 'orchestra-u23-cap-many-');
  for (let index = 0; index < 200; index += 1) writeCapture(many, `capture.1.${index}.json`);
  assert.throws(() => readS0Captures(many), /bounds failure/, 'file count is bounded');

  const huge = captureDir(t, 'orchestra-u23-cap-huge-');
  writeFileSync(path.join(huge, 'capture.1.2.json'), 'x'.repeat(200_000), { mode: 0o600 });
  chmodSync(path.join(huge, 'capture.1.2.json'), 0o600);
  assert.throws(() => readS0Captures(huge), /bounds failure/, 'per-file size is bounded');
});

// ===========================================================================
// Turn identity and the recorder's own clock.
// ===========================================================================

function stubClient(options, { responseId, startedId, completedId }) {
  return {
    child: { pid: 4_242_424 },
    start: async () => {},
    close: async () => {},
    request: async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      setImmediate(async () => {
        await options.onNotification({
          method: 'turn/started', params: { turn: { id: startedId } },
        });
        await options.onNotification({
          method: 'turn/completed',
          params: { turn: { id: completedId, status: 'completed' } },
        });
      });
      return { turn: { id: responseId } };
    },
  };
}

// The response id must be compared against the turn/started id. Comparing it
// against the completed id instead reports a consistent turn whenever the two
// notifications disagree, which is exactly the case worth catching.
test('a turn whose started id disagrees with its response is reported inconsistent', async () => {
  const { withProductionSession } = await import(s0Url);
  const disagreeing = await withProductionSession({
    binary: '/b',
    lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },
    model: 'm',
    guard: () => {},
    createClient: (options) => stubClient(options, {
      responseId: 'turn-A', startedId: 'turn-B', completedId: 'turn-A',
    }),
    verifyRetired: async () => true,
  }, async (handle) => handle.runTurn(handle.threadId));
  assert.equal(disagreeing.error, null);
  assert.equal(
    disagreeing.turns[0].responseMatchesStarted,
    false,
    'the response was compared against the wrong notification',
  );
  assert.equal(disagreeing.turns[0].identityConsistent, false);

  const agreeing = await withProductionSession({
    binary: '/b',
    lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },
    model: 'm',
    guard: () => {},
    createClient: (options) => stubClient(options, {
      responseId: 'turn-A', startedId: 'turn-A', completedId: 'turn-A',
    }),
    verifyRetired: async () => true,
  }, async (handle) => handle.runTurn(handle.threadId));
  assert.equal(agreeing.turns[0].identityConsistent, true);
});

test('each turn keeps its own outcome instead of being overwritten by the next', async () => {
  const { withProductionSession } = await import(s0Url);
  let call = 0;
  const session = await withProductionSession({
    binary: '/b',
    lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },
    model: 'm',
    guard: () => {},
    createClient: (options) => ({
      child: { pid: 4_242_425 },
      start: async () => {},
      close: async () => {},
      request: async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        call += 1;
        const id = `turn-${call}`;
        setImmediate(async () => {
          await options.onNotification({ method: 'turn/started', params: { turn: { id } } });
          await options.onNotification({
            method: 'turn/completed', params: { turn: { id, status: 'completed' } },
          });
        });
        return { turn: { id } };
      },
    }),
    verifyRetired: async () => true,
  }, async (handle) => {
    await handle.runTurn(handle.threadId);
    await handle.runTurn(handle.threadId);
  });
  assert.equal(session.turns.length, 2);
  assert.notEqual(session.turns[0].responseId, session.turns[1].responseId);
  assert.ok(session.turns.every((turn) => turn.identityConsistent === true));
});

test('a failed client close fails the lane rather than being absorbed', async () => {
  const { withProductionSession } = await import(s0Url);
  const session = await withProductionSession({
    binary: '/b',
    lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },
    model: 'm',
    guard: () => {},
    createClient: (options) => ({
      ...stubClient(options, { responseId: 't', startedId: 't', completedId: 't' }),
      close: async () => {
        throw Object.assign(new Error('x'), { code: 'CODEX_PROCESS_CLEANUP_UNVERIFIED' });
      },
    }),
    verifyRetired: async () => true,
  }, async (handle) => handle.runTurn(handle.threadId));
  assert.equal(session.outcome.closeClean, false);
  assert.equal(session.outcome.faultCategory, 'cleanup');
});

test('a child that cannot be proved retired fails the lane', async () => {
  const { withProductionSession } = await import(s0Url);
  const session = await withProductionSession({
    binary: '/b',
    lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },
    model: 'm',
    guard: () => {},
    createClient: (options) => stubClient(options, {
      responseId: 't', startedId: 't', completedId: 't',
    }),
    verifyRetired: async () => false,
  }, async (handle) => handle.runTurn(handle.threadId));
  assert.equal(session.outcome.childRetired, false);
});

// The hook's observation has to be stamped when the hook is entered. Stamping
// it after stdin has drained measures the writer's generosity, not the moment
// the hook fired, and it inflates every margin derived from it.
test('the recorder stamps its observation before it drains stdin', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const dir = captureDir(t, 'orchestra-u23-stamp-');
  const before = Date.now();
  const child = require('node:child_process').spawn(
    process.execPath, [recorderPath, 'stop', dir], { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  child.stdin.write('{"turn_id":"turn-slow"');
  await new Promise((resolve) => setTimeout(resolve, 600));
  child.stdin.end('}');
  await new Promise((resolve) => child.once('exit', resolve));
  const [record] = readS0Captures(dir);
  assert.equal(record.turnIdPresent, true, 'the whole payload must still be parsed');
  assert.ok(
    record.observedAtMs - before < 400,
    `the stamp must predate the drain: ${record.observedAtMs - before}ms after spawn`,
  );
});


// ===========================================================================
// Boundary lanes must be healthy before they are allowed to classify.
//
// A lane that faulted also produces no captures, which is indistinguishable
// from "the swapped-in content did not run" unless lane health is checked
// first. An unhealthy lane must abstain, not vote.
// ===========================================================================

test('a boundary lane classifies only from an exact capture split on a healthy lane', async () => {
  const { classifyBoundaryLane, BOUNDARY_LANE_VERDICTS } = await import(s0Url);
  assert.equal(classifyBoundaryLane({ newCount: 3, oldCount: 0, healthy: true }), 'new-content');
  assert.equal(classifyBoundaryLane({ newCount: 0, oldCount: 3, healthy: true }), 'old-content');
  assert.equal(classifyBoundaryLane({ newCount: 0, oldCount: 0, healthy: true }), 'none');
  assert.equal(classifyBoundaryLane({ newCount: 2, oldCount: 1, healthy: true }), 'ambiguous');
  // The whole point: an unhealthy lane looks exactly like "nothing ran".
  assert.equal(classifyBoundaryLane({ newCount: 0, oldCount: 0, healthy: false }), null);
  assert.equal(classifyBoundaryLane({ newCount: 3, oldCount: 0, healthy: false }), null);
  for (const verdict of BOUNDARY_LANE_VERDICTS) assert.match(verdict, /^[a-z-]+$/);
});

test('the snapshot boundary is located only from three healthy, monotonic lanes', async () => {
  const { classifySnapshotBoundary } = await import(s0Url);
  assert.equal(
    classifySnapshotBoundary({
      preSpawn: 'new-content', postStart: 'none', postThread: 'none',
    }),
    'at-or-before-process-spawn',
  );
  assert.equal(
    classifySnapshotBoundary({
      preSpawn: 'new-content', postStart: 'new-content', postThread: 'none',
    }),
    'during-thread-start',
  );
  assert.equal(
    classifySnapshotBoundary({
      preSpawn: 'new-content', postStart: 'new-content', postThread: 'new-content',
    }),
    'after-thread-start-response',
  );
  for (const [name, lanes] of [
    ['a lane that could not be classified', {
      preSpawn: 'new-content', postStart: null, postThread: 'none',
    }],
    ['a control that did not run', {
      preSpawn: 'none', postStart: 'none', postThread: 'none',
    }],
    ['a non-monotonic result', {
      preSpawn: 'new-content', postStart: 'none', postThread: 'new-content',
    }],
    ['an ambiguous lane', {
      preSpawn: 'new-content', postStart: 'ambiguous', postThread: 'none',
    }],
    ['untrusted content that ran anyway', {
      preSpawn: 'new-content', postStart: 'old-content', postThread: 'none',
    }],
  ]) {
    assert.equal(classifySnapshotBoundary(lanes), null, `${name} must not locate a boundary`);
  }
});

test('lane health requires a completed, identity-consistent, fault-free, retired turn', async () => {
  const { sessionLaneIsHealthy } = await import(s0Url);
  const healthy = {
    session: {
      error: null,
      outcome: {
        faultCategory: 'none', closeClean: true, childRetired: true,
        deliveredHookMethodCount: 0,
      },
    },
    turn: { status: 'completed', identityConsistent: true, assistantItemObserved: true },
  };
  assert.equal(sessionLaneIsHealthy(healthy.session, healthy.turn), true);
  for (const [name, mutate] of [
    ['a thrown lane', (h) => { h.session.error = new Error('x'); }],
    ['a fault', (h) => { h.session.outcome.faultCategory = 'protocol'; }],
    ['an unclean close', (h) => { h.session.outcome.closeClean = false; }],
    ['a surviving child', (h) => { h.session.outcome.childRetired = false; }],
    ['a delivered hook notification', (h) => { h.session.outcome.deliveredHookMethodCount = 1; }],
    ['an incomplete turn', (h) => { h.turn.status = 'failed'; }],
    ['an inconsistent identity', (h) => { h.turn.identityConsistent = false; }],
    ['no assistant item', (h) => { h.turn.assistantItemObserved = false; }],
    ['no turn at all', (h) => { h.turn = null; }],
  ]) {
    const candidate = structuredClone(healthy);
    candidate.session.error = null;
    mutate(candidate);
    assert.equal(
      sessionLaneIsHealthy(candidate.session, candidate.turn),
      false,
      `${name} must not count as a healthy lane`,
    );
  }
});

// ===========================================================================
// Per-turn assistant evidence.
// ===========================================================================

function assistantClient(options, turnPlan) {
  let call = 0;
  return {
    child: { pid: 4_242_426 },
    start: async () => {},
    close: async () => {},
    request: async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      const plan = turnPlan[call];
      call += 1;
      const id = plan.id;
      setImmediate(async () => {
        await options.onNotification({ method: 'turn/started', params: { turn: { id } } });
        if (plan.item) {
          await options.onNotification({
            method: 'item/completed',
            params: { turnId: plan.itemTurnId ?? id, item: { id: 'i', type: plan.item } },
          });
        }
        await options.onNotification({
          method: 'turn/completed',
          params: { turn: { id, status: plan.status } },
        });
      });
      return { turn: { id } };
    },
  };
}

// The lane-wide flag is overwritten by whatever the last turn did, and an
// `item/completed` of any type would satisfy it. The first turn's own
// agentMessage, correlated to that turn, is the evidence E7 rests on.
test('assistant evidence is per turn, typed agentMessage, and correlated to that turn', async () => {
  const { withProductionSession } = await import(s0Url);
  const lane = { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' };
  const session = await withProductionSession({
    binary: '/b',
    lane,
    model: 'm',
    guard: () => {},
    verifyRetired: async () => true,
    createClient: (options) => assistantClient(options, [
      { id: 'turn-1', status: 'completed', item: 'agentMessage' },
      { id: 'turn-2', status: 'failed' },
    ]),
  }, async (handle) => {
    await handle.runTurn(handle.threadId);
    await handle.runTurn(handle.threadId);
  });
  assert.equal(session.turns[0].assistantItemObserved, true);
  assert.equal(session.turns[0].status, 'completed');
  assert.equal(session.turns[1].assistantItemObserved, false, 'turn 2 produced no assistant item');
  assert.equal(session.turns[1].status, 'failed');

  const wrongType = await withProductionSession({
    binary: '/b',
    lane,
    model: 'm',
    guard: () => {},
    verifyRetired: async () => true,
    createClient: (options) => assistantClient(options, [
      { id: 'turn-1', status: 'completed', item: 'commandExecution' },
    ]),
  }, async (handle) => handle.runTurn(handle.threadId));
  assert.equal(
    wrongType.turns[0].assistantItemObserved,
    false,
    'a non-agentMessage item is not assistant evidence',
  );

  const foreignTurn = await withProductionSession({
    binary: '/b',
    lane,
    model: 'm',
    guard: () => {},
    verifyRetired: async () => true,
    createClient: (options) => assistantClient(options, [
      { id: 'turn-1', status: 'completed', item: 'agentMessage', itemTurnId: 'turn-other' },
    ]),
  }, async (handle) => handle.runTurn(handle.threadId));
  assert.equal(
    foreignTurn.turns[0].assistantItemObserved,
    false,
    'an item belonging to another turn is not this turn\'s evidence',
  );
});

// ===========================================================================
// Launch attestation is centrally enforced and counted.
// ===========================================================================

test('an app-server launch without its prelaunch guard is refused', async () => {
  const { withProductionSession } = await import(s0Url);
  const lane = { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' };
  await assert.rejects(
    () => withProductionSession({
      binary: '/b',
      lane,
      model: 'm',
      verifyRetired: async () => true,
      createClient: (options) => assistantClient(options, [
        { id: 't', status: 'completed', item: 'agentMessage' },
      ]),
    }, async (handle) => handle.runTurn(handle.threadId)),
    /attestation failure/,
    'a launch helper with no guard must not be able to start a child',
  );
});

test('the launch counter reports parity, not merely that a guard ran once', async () => {
  const { launchAttestationIsComplete } = await import(s0Url);
  assert.equal(launchAttestationIsComplete({ intended: 9, guarded: 9 }), true);
  assert.equal(
    launchAttestationIsComplete({ intended: 9, guarded: 1 }),
    false,
    'one guarded launch out of nine must not read as complete',
  );
  assert.equal(launchAttestationIsComplete({ intended: 0, guarded: 0 }), false);
  assert.equal(launchAttestationIsComplete({ intended: 3, guarded: 4 }), false);
});

// ===========================================================================
// Unknown decision labels.
// ===========================================================================

// Filtering an unrecognized label away makes an unknown decision invisible and
// lets the run exit clean. It must stop the gate — while still never echoing
// the label itself.
test('an unrecognized unmeasured label stops the gate content-free', async () => {
  const { buildS0Envelope } = await import(s0Url);
  const envelope = buildS0Envelope(completeMeasurement((m) => {
    m.unmeasured = ['SENTINEL_DECISION'];
  }));
  assert.equal(envelope.gate, 'STOP');
  assert.ok(envelope.failedChecks.includes('unmeasuredLabelsRecognized'));
  assert.deepEqual(envelope.unmeasured, [], 'the unknown label is never echoed');
  assert.doesNotMatch(JSON.stringify(envelope), /SENTINEL_/);

  const mixed = buildS0Envelope(completeMeasurement((m) => {
    m.unmeasured = ['E1', 'SENTINEL_OTHER'];
  }));
  assert.equal(mixed.gate, 'STOP');
  assert.deepEqual(mixed.unmeasured, ['E1']);
  assert.ok(mixed.failedChecks.includes('unmeasuredLabelsRecognized'));
  assert.doesNotMatch(JSON.stringify(mixed), /SENTINEL_/);
});

// ===========================================================================
// The whitelist must pin every field that defines the fixture.
//
// Matching only identity leaves the fields that decide whether a hook *runs*
// — trust status, enabled, ordering, timeout, optional shape — unchecked, and
// a hook that will never run is not a hook whose hash should be trusted.
// ===========================================================================

test('fixture-defining fields are pinned exactly before an inventory is trustable', async () => {
  const { splitHookInventory } = await import(s0Url);
  const base = () => inventoryExpectations();
  const cases = [
    ['a nonzero key index', (e) => { e[0].key = '/probe/hooks.json:session_start:1:0'; }],
    ['a nonzero sub index', (e) => { e[1].key = '/probe/hooks.json:user_prompt_submit:0:2'; }],
    ['an unexpected trust status', (e) => { e[2].trustStatus = 'trusted'; }],
    ['a disabled hook', (e) => { e[0].enabled = false; }],
    ['an out-of-order displayOrder', (e) => { e[1].displayOrder = 7; }],
    ['a non-integer timeout', (e) => { e[2].timeoutSec = 12.5; }],
    ['a negative timeout', (e) => { e[2].timeoutSec = -1; }],
    ['a populated matcher', (e) => { e[0].matcher = 'SENTINEL_MATCHER'; }],
    ['a populated statusMessage', (e) => { e[1].statusMessage = 'SENTINEL_STATUS'; }],
    ['a populated pluginId', (e) => { e[2].pluginId = 'SENTINEL_PLUGIN'; }],
    ['a populated additionalContextLimit', (e) => { e[0].additionalContextLimit = 2500; }],
  ];
  for (const [name, mutate] of cases) {
    const result = splitHookInventory(rawInventory(mutate), base());
    assert.equal(result.trustable, false, `${name} must not be trustable`);
    assert.deepEqual(result.trust, [], `${name} must yield no harvestable hash`);
    assert.doesNotMatch(JSON.stringify(result.projected), /SENTINEL_/);
  }
  // The unmutated fixture, with its expected optional shape, still passes.
  const ok = splitHookInventory(rawInventory(), base());
  assert.equal(ok.trustable, true);
  assert.equal(ok.trust.length, 3);
});

// ===========================================================================
// Capture ingestion must not re-resolve the path it validated.
// ===========================================================================

test('capture validation and read happen on one descriptor, not one path twice', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const dir = captureDir(t, 'orchestra-u23-cap-toctou-');
  const target = writeCapture(dir, 'capture.7.7.json');
  // A validated path that is swapped for a symlink before the read is the
  // classic lstat→open race. Opening with no-follow semantics and validating
  // the opened descriptor is what closes it.
  const decoy = path.join(dir, 'decoy.json');
  writeFileSync(decoy, JSON.stringify({
    eventName: 'stop', turnIdPresent: false, turnIdSha256: null,
    observedAtMs: 1, payloadParsed: true,
  }), { mode: 0o600 });
  rmSync(target);
  symlinkSync(decoy, target);
  assert.throws(
    () => readS0Captures(dir),
    /framing failure/,
    'a symlinked capture must never be followed, however it came to be one',
  );
});

// ===========================================================================
// A successful turn must not leave its completion deadline armed.
// ===========================================================================

test('a completed turn cancels its completion deadline and the loop drains', async (t) => {
  const dir = scratch(t, 'orchestra-u23-drain-');
  const driver = path.join(dir, 'driver.mjs');
  writeFileSync(driver, [
    `import { withProductionSession } from ${JSON.stringify(
      path.resolve(__dirname, '../scripts/spikes/codex-hook-trust-s0.mjs'),
    )};`,
    'const started = Date.now();',
    'await withProductionSession({',
    "  binary: '/b',",
    "  lane: { workspace: '/w', codexHome: '/h', env: {}, configSha256: 'a' },",
    "  model: 'm',",
    '  guard: () => {},',
    '  verifyRetired: async () => true,',
    '  createClient: (options) => ({',
    '    child: { pid: 1 },',
    '    start: async () => {},',
    '    close: async () => {},',
    '    request: async (method) => {',
    "      if (method === 'thread/start') return { thread: { id: 't' } };",
    '      setImmediate(async () => {',
    "        await options.onNotification({ method: 'turn/started', params: { turn: { id: 'x' } } });",
    "        await options.onNotification({ method: 'item/completed', params: { turnId: 'x', item: { id: 'i', type: 'agentMessage' } } });",
    "        await options.onNotification({ method: 'turn/completed', params: { turn: { id: 'x', status: 'completed' } } });",
    '      });',
    "      return { turn: { id: 'x' } };",
    '    },',
    '  }),',
    '}, async (handle) => handle.runTurn(handle.threadId));',
    "process.stdout.write(String(Date.now() - started));",
  ].join('\n'), { mode: 0o600 });
  const started = Date.now();
  const run = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 30_000 });
  const elapsed = Date.now() - started;
  assert.equal(run.status, 0, run.stderr);
  // A 45s completion deadline left armed keeps the event loop alive long after
  // the turn resolved, so natural exit is the assertion.
  assert.ok(
    elapsed < 10_000,
    `the process must exit naturally once the turn resolves, took ${elapsed}ms`,
  );
});

// ===========================================================================
// Absence is not the same as an observed false.
// ===========================================================================

test('an ordering boolean that was never observed is not read as an observed false', async () => {
  const { buildS0Envelope } = await import(s0Url);
  const present = buildS0Envelope(completeMeasurement());
  assert.equal(present.evidence.e7Ordering.userPromptSubmitStrictlyBeforeTurnAccepted, false);
  assert.ok(!present.failedChecks.includes('orderingEvidenceComplete'));

  for (const key of [
    'userPromptSubmitStrictlyBeforeTurnAccepted',
    'stopStrictlyBeforeTurnAccepted',
  ]) {
    const absent = buildS0Envelope(completeMeasurement((m) => { delete m.e7Ordering[key]; }));
    assert.equal(
      absent.evidence.e7Ordering[key],
      null,
      `${key} must project absence as null, not as false`,
    );
    assert.equal(absent.gate, 'STOP');
    assert.ok(absent.failedChecks.includes('orderingEvidenceComplete'));
  }
});

// A prevalidation followed by an open of the same name is a race. The swap
// here happens *after* the name has been vetted and immediately before the
// open, which is the window a path-based read leaves open and a no-follow
// open plus fstat on that same descriptor closes.
test('a capture swapped between prevalidation and open is refused', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const dir = captureDir(t, 'orchestra-u23-cap-swap-');
  const target = writeCapture(dir, 'capture.9.9.json');
  const decoy = path.join(dir, 'decoy.json');
  writeFileSync(decoy, JSON.stringify({
    eventName: 'stop', turnIdPresent: true, turnIdSha256: 'd'.repeat(64),
    observedAtMs: 1, payloadParsed: true,
  }), { mode: 0o600 });
  let swapped = false;
  assert.throws(
    () => readS0Captures(dir, {
      onBeforeOpen: () => {
        if (swapped) return;
        swapped = true;
        rmSync(target);
        symlinkSync(decoy, target);
      },
    }),
    /framing failure/,
    'the swapped-in symlink must not be followed by the read',
  );
  assert.equal(swapped, true, 'the injected swap must actually have run');
});

// A bounded reader that keeps what it read before the bound tripped will
// happily parse a valid prefix and ignore the rest, which is a way to feed the
// recorder a turn id it should never have accepted.
test('an oversized payload is rejected wholesale, not truncated to its valid prefix', async (t) => {
  const { readS0Captures } = await import(s0Url);
  const { projectHookPayload } = await import(recorderUrl);
  assert.equal(
    projectHookPayload({
      eventName: 'stop',
      payload: '{"turn_id":"turn-x"}',
      observedAtMs: 1,
      overflowed: true,
    }).turnIdPresent,
    false,
    'an overflowed read must not yield a turn id',
  );

  const dir = captureDir(t, 'orchestra-u23-overflow-');
  const child = require('node:child_process').spawn(
    process.execPath, [recorderPath, 'stop', dir], { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  // The recorder severs stdin the moment the bound trips, so the writer sees
  // EPIPE. That is the correct behaviour, not a test failure.
  child.stdin.on('error', () => {});
  child.stdin.write('{"turn_id":"turn-oversized"}');
  await new Promise((resolve) => setTimeout(resolve, 120));
  child.stdin.write('x'.repeat(400_000));
  try { child.stdin.end(); } catch { /* already severed */ }
  await new Promise((resolve) => child.once('exit', resolve));
  const records = readS0Captures(dir);
  if (records.length > 0) {
    assert.equal(records[0].payloadParsed, false, 'an overflowed payload is not a parsed payload');
    assert.equal(records[0].turnIdPresent, false, 'no turn id may survive an overflow');
    assert.equal(records[0].turnIdSha256, null);
  }
});

// ===========================================================================
// Final round: the remaining places where "it did not throw" stood in for
// evidence, and where a label said something the experiment did not show.
// ===========================================================================

test('the second same-session turn is judged on its record, not on not throwing', async () => {
  const { buildS0Envelope } = await import(s0Url);
  const ok = buildS0Envelope(completeMeasurement());
  assert.ok(!ok.failedChecks.includes('fireTimeEvidenceComplete'));
  for (const [name, mutate] of [
    ['it did not complete', (m) => { m.e6FireTime.sameSessionSecondTurn.status = 'failed'; }],
    ['it produced no assistant item', (m) => {
      m.e6FireTime.sameSessionSecondTurn.assistantItemObserved = false;
    }],
    ['its three identities disagreed', (m) => {
      m.e6FireTime.sameSessionSecondTurn.identityConsistent = false;
    }],
    ['it was never recorded', (m) => { m.e6FireTime.sameSessionSecondTurn = {}; }],
  ]) {
    const envelope = buildS0Envelope(completeMeasurement(mutate));
    assert.equal(envelope.gate, 'STOP', `${name} must stop the gate`);
    assert.ok(
      envelope.failedChecks.includes('fireTimeEvidenceComplete'),
      `${name} must fail fireTimeEvidenceComplete`,
    );
  }
});

test('the fresh session must report an exact three-entry modified inventory', async () => {
  const { buildS0Envelope } = await import(s0Url);
  for (const [name, mutate] of [
    ['an inexact inventory', (m) => { m.e6FireTime.newSessionInventoryExact = false; }],
    ['a status other than modified', (m) => {
      m.e6FireTime.newSessionTrustStatusAfterMutation = ['trusted'];
    }],
    ['more than one status', (m) => {
      m.e6FireTime.newSessionTrustStatusAfterMutation = ['modified', 'untrusted'];
    }],
  ]) {
    const envelope = buildS0Envelope(completeMeasurement(mutate));
    assert.equal(envelope.gate, 'STOP', `${name} must stop the gate`);
    assert.ok(envelope.failedChecks.includes('fireTimeEvidenceComplete'), name);
  }
});

// The fixture is frozen, so the launch count is a fact about it, not a free
// variable. Parity alone would accept a run that quietly stopped launching.
test('the launch gate pins the expected count, not merely parity', async () => {
  const { buildS0Envelope, EXPECTED_APP_SERVER_LAUNCHES } = await import(s0Url);
  assert.equal(EXPECTED_APP_SERVER_LAUNCHES, 19);
  const short = buildS0Envelope(completeMeasurement((m) => {
    m.receipts.appServerLaunchesIntended = 18;
    m.receipts.appServerLaunchesAttested = 18;
  }));
  assert.equal(short.gate, 'STOP', '18/18 is parity but not the frozen fixture');
  assert.ok(short.failedChecks.includes('appServerLaunchesAllPrelaunchAttested'));
  const over = buildS0Envelope(completeMeasurement((m) => {
    m.receipts.appServerLaunchesIntended = 20;
    m.receipts.appServerLaunchesAttested = 20;
  }));
  assert.equal(over.gate, 'STOP', '20/20 is parity but not the frozen fixture');
});

// postStart swaps after initialize and *before* the thread/start request;
// postThread swaps after the thread/start response. The fixing point is
// bracketed inside thread/start, so the label must say that and nothing wider.
test('the middle boundary outcome is named for the interval it actually brackets', async () => {
  const { classifySnapshotBoundary, SNAPSHOT_BOUNDARIES } = await import(s0Url);
  assert.deepEqual([...SNAPSHOT_BOUNDARIES], [
    'at-or-before-process-spawn',
    'during-thread-start',
    'after-thread-start-response',
  ]);
  assert.equal(
    classifySnapshotBoundary({
      preSpawn: 'new-content', postStart: 'new-content', postThread: 'none',
    }),
    'during-thread-start',
  );
  assert.equal(
    classifySnapshotBoundary({
      preSpawn: 'new-content', postStart: 'new-content', postThread: 'new-content',
    }),
    'after-thread-start-response',
  );
});

test('the fixture timeout is pinned to its exact value', async () => {
  const { splitHookInventory } = await import(s0Url);
  for (const timeoutSec of [30, 599, 601, 1200]) {
    const result = splitHookInventory(
      rawInventory((e) => { e[1].timeoutSec = timeoutSec; }),
      inventoryExpectations(),
    );
    assert.equal(
      result.trustable,
      false,
      `a positive integer timeout of ${timeoutSec} is still not the fixture's 600`,
    );
    assert.deepEqual(result.trust, []);
  }
  assert.equal(splitHookInventory(rawInventory(), inventoryExpectations()).trustable, true);
});

// ===========================================================================
// Trust discovery reads a cwd-scoped, exactly-shaped response or nothing.
// ===========================================================================

test('the discovery envelope is validated before a single hook is read from it', async () => {
  const { validateHooksListEnvelope } = await import(s0Url);
  const owned = '/probe/ws';
  const good = {
    data: [{ cwd: owned, errors: [], warnings: [], hooks: [{ eventName: 'stop' }] }],
  };
  assert.deepEqual(validateHooksListEnvelope(good, owned), good.data[0].hooks);
  for (const [name, envelope] of [
    ['a foreign cwd', {
      data: [{ cwd: '/elsewhere', errors: [], warnings: [], hooks: [] }],
    }],
    ['more than one entry', {
      data: [
        { cwd: owned, errors: [], warnings: [], hooks: [] },
        { cwd: '/elsewhere', errors: [], warnings: [], hooks: [] },
      ],
    }],
    ['no entry at all', { data: [] }],
    ['a non-empty errors array', {
      data: [{
        cwd: owned,
        errors: [{ message: 'SENTINEL_ERROR', path: '/SENTINEL_PATH' }],
        warnings: [],
        hooks: [],
      }],
    }],
    ['a non-empty warnings array', {
      data: [{ cwd: owned, errors: [], warnings: ['SENTINEL_WARNING'], hooks: [] }],
    }],
    ['an unexpected top-level key', {
      data: [{ cwd: owned, errors: [], warnings: [], hooks: [] }],
      nextCursor: 'SENTINEL_CURSOR',
    }],
    ['a missing data array', { entries: [] }],
  ]) {
    let caught = null;
    try {
      validateHooksListEnvelope(envelope, owned);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${name} must be refused before any hook is read`);
    assert.doesNotMatch(String(caught.message), /SENTINEL_|elsewhere|probe/);
  }
});

// The fresh-session control lists a manifest that was deliberately mutated, so
// its commands no longer match what was rendered — correctly making it
// untrustable. Exactness there is a different question from trustability: it
// asks whether all three hooks came back, one per event, uniformly `modified`.
test('an exact modified set is judged without demanding a command that changed', async () => {
  const { inventoryIsExactSet, splitHookInventory } = await import(s0Url);
  const mutated = rawInventory((e) => {
    for (const entry of e) {
      entry.trustStatus = 'modified';
      entry.command = "'/bin/node' '/opt/rec.mjs' 'elsewhere'";
    }
  });
  const { projected } = splitHookInventory(mutated, inventoryExpectations());
  assert.equal(
    splitHookInventory(mutated, { ...inventoryExpectations(), trustStatus: 'modified' }).trustable,
    false,
    'a changed command must still block trust',
  );
  assert.equal(inventoryIsExactSet(projected, 'modified', { expectCommandMatch: false }), true);

  for (const [name, mutate] of [
    ['a missing event', (e) => { e.pop(); }],
    ['a duplicate event', (e) => { e[2] = { ...e[1] }; }],
    ['a mixed status', (e) => { e[0].trustStatus = 'untrusted'; }],
    ['a malformed hash', (e) => { e[1].currentHash = 'nope'; }],
    ['a key that does not derive', (e) => { e[2].key = '/probe/hooks.json:stop:0'; }],
    ['a foreign source path', (e) => { e[0].sourcePath = '/elsewhere/hooks.json'; }],
    ['an unknown field', (e) => { e[1].futureField = 'SENTINEL_UNKNOWN'; }],
  ]) {
    const entries = rawInventory((e) => {
      for (const entry of e) entry.trustStatus = 'modified';
      mutate(e);
    });
    const result = splitHookInventory(entries, inventoryExpectations());
    assert.equal(
      inventoryIsExactSet(result.projected, 'modified', { expectCommandMatch: false }),
      false,
      `${name} must not count as an exact modified set`,
    );
  }
});

// The fresh modified control differs from the trust fixture in exactly one
// respect — its command was deliberately changed — so every other invariant
// must still be pinned. Anything looser and a hook that is disabled, reordered,
// re-timed or carrying an unexpected optional field would pass as "the same
// three hooks, now modified".
test('the modified control pins every invariant except the command it changed', async () => {
  const { inventoryIsExactSet, splitHookInventory } = await import(s0Url);
  const modified = (mutate = () => {}) => {
    const entries = rawInventory((e) => {
      for (const entry of e) {
        entry.trustStatus = 'modified';
        entry.command = "'/bin/node' '/opt/rec.mjs' 'elsewhere'";
      }
      mutate(e);
    });
    return splitHookInventory(entries, inventoryExpectations()).projected;
  };
  assert.equal(
    inventoryIsExactSet(modified(), 'modified', { expectCommandMatch: false }),
    true,
    'the unmutated modified control still passes',
  );

  for (const [name, mutate] of [
    ['a disabled hook', (e) => { e[0].enabled = false; }],
    ['a reordered hook', (e) => { e[1].displayOrder = 9; }],
    ['a re-timed hook', (e) => { e[2].timeoutSec = 30; }],
    ['a positive but wrong timeout', (e) => { e[2].timeoutSec = 601; }],
    ['a populated matcher', (e) => { e[0].matcher = 'SENTINEL_MATCHER'; }],
    ['a populated statusMessage', (e) => { e[1].statusMessage = 'SENTINEL_STATUS'; }],
    ['a populated additionalContextLimit', (e) => { e[2].additionalContextLimit = 2500; }],
    ['a missing optional key', (e) => { delete e[0].matcher; }],
    ['an absent command', (e) => { delete e[1].command; }],
    ['a nonzero key index', (e) => { e[2].key = '/probe/hooks.json:stop:1:0'; }],
  ]) {
    assert.equal(
      inventoryIsExactSet(modified(mutate), 'modified', { expectCommandMatch: false }),
      false,
      `${name} must not pass as the modified control`,
    );
  }

  // The command mismatch is expected, not merely tolerated: a control whose
  // command still matches means the mutation never took effect.
  const unmutatedCommand = splitHookInventory(
    rawInventory((e) => { for (const entry of e) entry.trustStatus = 'modified'; }),
    inventoryExpectations(),
  ).projected;
  assert.equal(
    inventoryIsExactSet(unmutatedCommand, 'modified', { expectCommandMatch: false }),
    false,
    'a control whose command still matches proves the mutation did not land',
  );
  assert.equal(
    inventoryIsExactSet(unmutatedCommand, 'modified', { expectCommandMatch: true }),
    true,
  );
});
