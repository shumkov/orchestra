'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const pin = require('../lib/codex/protocol-schema.json');
const manifest = require('./fixtures/codex-app-server-0.167.2/manifest.json');
const load = kind => JSON.parse(readFileSync(path.join(__dirname, 'fixtures/codex-app-server-0.167.2', `${kind}-compatibility.schema.json`)));

test('candidate target and schema attestations match the active runtime', () => {
  assert.equal(pin.cliVersion, manifest.cliVersion);
  assert.deepEqual(pin.codeModeHostSha256ByTarget, manifest.codeModeHostSha256ByTarget);
  assert.deepEqual(pin.binarySha256ByTarget, manifest.binarySha256ByTarget);
  assert.equal(pin.generatedProtocolV2CanonicalSha256, manifest.schemaSha256.experimentalProtocolV2Canonical);
});

test('candidate schemas retain attachment, exact steering, terminal cleanup and legacy sandbox contracts', async () => {
  const { assertAttachmentResponseSchemas, assertTransportCorrelationSurfaces, workspaceWritePolicyFrom } = await import('../scripts/spikes/codex-app-server-real.mjs');
  for (const kind of ['stable', 'experimental']) {
    const definitions = load(kind);
    assertAttachmentResponseSchemas({ definitions });
    assertTransportCorrelationSurfaces({ definitions });
    assert(definitions.TurnSteerParams.required.includes('expectedTurnId'));
    assert(workspaceWritePolicyFrom({ definitions }));
    const command = definitions.HookMetadata.oneOf?.find(x => x.properties?.handlerType?.enum?.includes('command'));
    assert(command, 'command hook handler must remain a declared discriminated variant');
    assert.equal(command.properties.async.default, false);
    assert.equal(command.properties.async.type, 'boolean');
    for (const plan of ['promax', 'self_serve_business_prolite', 'ent26', 'enterprise_cbp_automation', 'edu_plus', 'edu_pro', 'sci', 'sci_plus']) assert(definitions.PlanType.enum.includes(plan));
  }
  const definitions = load('experimental');
  for (const name of ['ThreadBackgroundTerminalsListParams', 'ThreadBackgroundTerminalsCleanParams']) assert.deepEqual(definitions[name].required, ['threadId']);
});
