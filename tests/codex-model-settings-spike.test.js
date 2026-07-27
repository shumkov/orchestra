'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const settingsSpikeUrl = pathToFileURL(path.resolve(
  __dirname,
  '../scripts/spikes/codex-app-server-model-settings.mjs',
));
const rpcUrl = pathToFileURL(path.resolve(
  __dirname,
  '../scripts/spikes/codex-app-server-rpc.mjs',
));

test('G-MODEL-1 chooses a distinct authenticated pair deterministically', async () => {
  const { chooseAlternateModelSettings } = await import(settingsSpikeUrl);
  const catalog = [{
    model: 'gpt-5.6-sol',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['high', 'xhigh'],
  }, {
    model: 'gpt-5.6-terra',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['medium', 'high'],
  }];

  assert.deepEqual(
    chooseAlternateModelSettings(catalog, {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    }),
    { model: 'gpt-5.6-sol', effort: 'high' },
  );
  assert.throws(
    () => chooseAlternateModelSettings([{
      model: 'only-model',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['high'],
    }], {
      model: 'only-model',
      effort: 'high',
    }),
    /distinct advertised settings pair/,
  );
});

test('G-MODEL-1 records experimental errors without blocking the stable product gate', async () => {
  const { evaluateModelSettingsGate } = await import(settingsSpikeUrl);
  const evidence = {
    experimental: {
      changed: {
        responseClass: 'error',
        errorClass: 'rpc-error',
        notificationObserved: false,
      },
      noOp: {
        responseClass: 'not-attempted',
        errorClass: 'changed-update-not-applied',
        notificationObserved: false,
      },
      active: {
        responseClass: 'error',
        errorClass: 'rpc-error',
        notificationObserved: false,
      },
    },
    activeTurnStartedOnce: true,
    activeTurnCompleted: true,
    activeTurnStatus: 'completed',
    perTurnOverrideCompleted: true,
    settingsNotificationObserved: false,
    notificationOrder: [
      'turn-started',
      'turn-start-response',
    ],
    sameThreadResumed: true,
    resumePairExact: true,
    resumedTurnCompleted: true,
    productionAllowlistExcluded: true,
  };

  assert.deepEqual(evaluateModelSettingsGate(evidence), {
    gate: 'CONTINUE',
    exitCode: 0,
    failedChecks: [],
  });
  assert.deepEqual(
    evaluateModelSettingsGate({
      ...evidence,
      activeTurnStatus: 'interrupted',
      perTurnOverrideCompleted: false,
    }).failedChecks,
    ['activeTurnUninterrupted', 'perTurnOverrideCompleted'],
  );
});

test('experimental settings mutation is opt-in to the spike transport only', async () => {
  const { isCharacterizationRequestAllowed } = await import(rpcUrl);

  assert.equal(
    isCharacterizationRequestAllowed('thread/settings/update'),
    false,
  );
  assert.equal(
    isCharacterizationRequestAllowed('thread/settings/update', true),
    true,
  );
  assert.equal(
    isCharacterizationRequestAllowed('turn/start'),
    true,
  );
  assert.equal(
    isCharacterizationRequestAllowed('config/write', true),
    false,
  );
});

test('passed G-MODEL-1 fixture is sanitized and proves the stable product gate', () => {
  const fixture = JSON.parse(readFileSync(path.resolve(
    __dirname,
    'fixtures/codex-app-server-0.145.0/model-settings-observation.json',
  ), 'utf8'));
  const serialized = JSON.stringify(fixture);

  assert.equal(fixture.gate, 'CONTINUE');
  assert.equal(fixture.exitCode, 0);
  assert.deepEqual(fixture.failedChecks, []);
  assert.equal(fixture.perTurnOverride.turnCompleted, true);
  assert.equal(fixture.resume.sameThread, true);
  assert.equal(fixture.resume.modelAndEffortExact, true);
  assert.equal(fixture.resume.laterTurnCompleted, true);
  assert.equal(fixture.productionSettingsUpdateAllowlisted, false);
  assert.doesNotMatch(
    serialized,
    /threadId|turnId|generationId|clientUserMessageId|rawCommand|prompt|reply|account|authorization|\/Users\/|\/private\/|SECRET_/i,
  );
});
