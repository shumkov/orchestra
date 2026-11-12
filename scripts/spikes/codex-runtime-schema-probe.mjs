// Offline schema regeneration from the attested candidate, without user config.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { attestPinnedCodexBinary, protocolSchema } = require('../../lib/codex/app-server-client');
const { canonicalizeToolInput } = require('../../lib/canonical-json');
const manifest = require('../../tests/fixtures/codex-app-server-0.167.2/manifest.json');
const binary = process.argv[2]; assert(binary);
const attestation = await attestPinnedCodexBinary(binary);
const root = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-schema-probe-')); fs.chmodSync(root, 0o700);
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { platform: process.platform, arch: process.arch, version: attestation.version, target: attestation.target, paidCalls: 0, schemas: {} };
try {
  const home = path.join(root, 'home'); const codexHome = path.join(root, 'codex');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(codexHome, { mode: 0o700 });
  for (const kind of ['stable', 'experimental']) {
    const out = path.join(root, kind);
    execFileSync(binary, ['app-server', 'generate-json-schema', ...(kind === 'experimental' ? ['--experimental'] : []), '--out', out], { env: { HOME: home, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin' }, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const requestBytes = fs.readFileSync(path.join(out, 'ClientRequest.json'));
    const protocolBytes = fs.readFileSync(path.join(out, 'codex_app_server_protocol.schemas.json'));
    const v2 = JSON.parse(fs.readFileSync(path.join(out, 'codex_app_server_protocol.v2.schemas.json')));
    const canonical = hash(canonicalizeToolInput(v2));
    assert.equal(canonical, manifest.schemaSha256[kind + 'ProtocolV2Canonical']);
    const raw = manifest.schemaRawSha256ByTarget[attestation.target];
    if (raw) { assert.equal(hash(requestBytes), raw[kind + 'ClientRequest']); assert.equal(hash(protocolBytes), raw[kind + 'Protocol']); }
    if (kind === 'experimental') {
      const generated = JSON.parse(requestBytes);
      for (const [method, spec] of Object.entries(protocolSchema.clientRequests)) {
        const request = generated.oneOf.find(r => r.properties?.method?.enum?.[0] === method);
        assert(request, `pinned request missing: ${method}`);
        const ref = request.properties?.params?.$ref;
        const params = ref ? generated.definitions[ref.split('/').at(-1)] : request.properties?.params;
        for (const field of [...spec.required, ...spec.optional]) assert(Object.hasOwn(params?.properties ?? {}, field), `pinned parameter missing: ${method}.${field}`);
      }
    }
    report.schemas[kind] = { canonical, rawRequest: hash(requestBytes), rawProtocol: hash(protocolBytes), rawManifestCompared: Boolean(raw) };
  }
  report.outcome = 'passed';
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify(report, null, 2));
