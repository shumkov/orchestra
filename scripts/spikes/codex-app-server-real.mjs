#!/usr/bin/env node

import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  createReadStream,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import canonicalJson from '../../lib/canonical-json.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../tests/fixtures/codex-app-server-0.145.0');
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'));
const { canonicalizeToolInput } = canonicalJson;
const SUBPROCESS_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const options = {
    binary: process.env.POLYGRAM_CODEX_BIN ?? '',
    launcher: process.env.ORCHESTRA_SESSION_LAUNCHER ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = argv[++index] ?? '';
    else if (arg === '--launcher') options.launcher = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function canonicalJsonSha256(value) {
  return createHash('sha256')
    .update(canonicalizeToolInput(value))
    .digest('hex');
}

function validateExecutable(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const target = statSync(path);
  if (!target.isFile() || (target.mode & 0o111) === 0) {
    throw new Error(`${label} must be an executable regular file`);
  }

  const root = parse(path).root;
  let component = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    component = join(component, part);
    const stat = lstatSync(component);
    if (stat.uid !== 0 && stat.uid !== process.getuid?.()) {
      throw new Error(`${label} path chain contains an unexpected owner`);
    }
    if (stat.mode & 0o022) {
      throw new Error(`${label} path chain contains a group/world-writable component`);
    }
  }
  return target;
}

export function runCommand(
  options,
  args,
  spawnOptions = {},
  timeoutMs = SUBPROCESS_TIMEOUT_MS,
) {
  const command = options.launcher || options.binary;
  const commandArgs = options.launcher ? [options.binary, ...args] : args;
  return spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...spawnOptions,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

function requireSuccess(result, operation) {
  if (result.error) throw new Error(`${operation} could not start: ${result.error.code ?? 'UNKNOWN'}`);
  if (result.signal) throw new Error(`${operation} ended by signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${operation} exited ${result.status}`);
}

function assertHash(path, expected, label) {
  const actual = sha256(path);
  if (actual !== expected) throw new Error(`${label} schema hash mismatch`);
}

function assertCanonicalHash(value, expected, label) {
  const actual = canonicalJsonSha256(value);
  if (actual !== expected) throw new Error(`${label} canonical schema hash mismatch`);
}

export function workspaceWritePolicyFrom(schema) {
  return schema.definitions?.SandboxPolicy?.oneOf?.find(
    (policy) => policy.title === 'WorkspaceWriteSandboxPolicy',
  );
}

export function hasRestrictedWorkspaceReadPolicy(schema) {
  return Object.hasOwn(
    workspaceWritePolicyFrom(schema)?.properties ?? {},
    'readOnlyAccess',
  );
}

export function gateExitCode(hasRestrictedReadPolicy) {
  return hasRestrictedReadPolicy ? 0 : 2;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.binary) throw new Error('pass the pinned binary with --binary or POLYGRAM_CODEX_BIN');
  validateExecutable(options.binary, 'Codex binary');
  if (realpathSync(options.binary) !== options.binary) {
    throw new Error('Codex binary must already be the resolved versioned path');
  }
  if (options.launcher) validateExecutable(options.launcher, 'session launcher');
  if (await sha256File(options.binary) !== manifest.binarySha256) {
    throw new Error('Codex binary hash mismatch');
  }

  const version = runCommand(options, ['--version']);
  requireSuccess(version, 'version check');
  if (version.stdout.trim() !== manifest.cliVersion) throw new Error('Codex binary version mismatch');

  const scratch = mkdtempSync(join(tmpdir(), 'orchestra-codex-u1a-'));
  try {
    const codexHome = join(scratch, 'codex-home');
    const stable = join(scratch, 'stable');
    const experimental = join(scratch, 'experimental');
    mkdirSync(codexHome);
    const env = Object.fromEntries(
      Object.entries({
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        CODEX_HOME: codexHome,
      }).filter(([, value]) => value !== undefined),
    );

    const stableResult = runCommand(
      options,
      ['app-server', 'generate-json-schema', '--out', stable],
      { env },
    );
    requireSuccess(stableResult, 'stable schema generation');
    const experimentalResult = runCommand(
      options,
      ['app-server', 'generate-json-schema', '--experimental', '--out', experimental],
      { env },
    );
    requireSuccess(experimentalResult, 'experimental schema generation');

    assertHash(
      join(stable, 'ClientRequest.json'),
      manifest.schemaSha256.stableClientRequest,
      'stable ClientRequest',
    );
    assertHash(
      join(stable, 'codex_app_server_protocol.schemas.json'),
      manifest.schemaSha256.stableProtocol,
      'stable protocol',
    );
    const schema = JSON.parse(
      readFileSync(join(stable, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'),
    );
    const experimentalV2Schema = JSON.parse(
      readFileSync(join(experimental, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'),
    );
    assertCanonicalHash(
      schema,
      manifest.schemaSha256.stableProtocolV2Canonical,
      'stable v2 protocol',
    );
    assertHash(
      join(experimental, 'ClientRequest.json'),
      manifest.schemaSha256.experimentalClientRequest,
      'experimental ClientRequest',
    );
    assertHash(
      join(experimental, 'codex_app_server_protocol.schemas.json'),
      manifest.schemaSha256.experimentalProtocol,
      'experimental protocol',
    );
    assertCanonicalHash(
      experimentalV2Schema,
      manifest.schemaSha256.experimentalProtocolV2Canonical,
      'experimental v2 protocol',
    );

    const turnSteer = schema.definitions?.TurnSteerParams;
    const recordedTurnSteer = JSON.parse(
      readFileSync(join(fixtureDir, 'turn-steer.schema.json'), 'utf8'),
    );
    if (canonicalizeToolInput(turnSteer) !== canonicalizeToolInput(recordedTurnSteer)) {
      throw new Error('recorded turn/steer fixture differs from generated schema');
    }
    const required = [...(turnSteer?.required ?? [])].sort();
    const expectedRequired = ['expectedTurnId', 'input', 'threadId'];
    if (JSON.stringify(required) !== JSON.stringify(expectedRequired)) {
      throw new Error('turn/steer active-turn precondition changed');
    }
    const description = turnSteer.properties?.expectedTurnId?.description ?? '';
    if (!description.includes('active turn id precondition')) {
      throw new Error('turn/steer active-turn targeting description changed');
    }

    const workspaceWritePolicy = workspaceWritePolicyFrom(schema);
    const recordedWorkspaceWrite = JSON.parse(
      readFileSync(join(fixtureDir, 'workspace-write-sandbox.schema.json'), 'utf8'),
    );
    delete recordedWorkspaceWrite.observation;
    if (
      canonicalizeToolInput(workspaceWritePolicy)
      !== canonicalizeToolInput(recordedWorkspaceWrite)
    ) {
      throw new Error('recorded workspaceWrite fixture differs from generated schema');
    }
    const hasRestrictedReadPolicy = hasRestrictedWorkspaceReadPolicy(schema);
    if (hasRestrictedReadPolicy !== manifest.observations.workspaceWriteReadOnlyAccessField) {
      throw new Error('workspaceWrite read-access surface changed');
    }

    const result = {
      gate: hasRestrictedReadPolicy ? 'CONTINUE' : 'STOP',
      cliVersion: manifest.cliVersion,
      binarySha256: manifest.binarySha256,
      schemaHashesVerified: true,
      launcherMode: options.launcher ? 'configured-wrapper' : 'direct',
      activeTurnTargeting: 'expectedTurnId required',
      restrictedWorkspaceReadPolicy: hasRestrictedReadPolicy,
      reason: hasRestrictedReadPolicy
        ? null
        : 'Pinned schema cannot deny agent commands read access to CODEX_HOME and unrelated secrets.',
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = gateExitCode(hasRestrictedReadPolicy);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`codex-app-server U1a check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
