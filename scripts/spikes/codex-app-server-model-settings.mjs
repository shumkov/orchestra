#!/usr/bin/env node

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppServerConnection,
  attestConnectionPolicy,
  attestPinnedCodexBinary,
  characterizeThreadProfile,
  initializeConnection,
  sanitizedAppServerEnv,
  validateDaemonSecretRoots,
} from './codex-app-server-real.mjs';
import {
  listModelCatalog,
  selectAdvertisedModelEffort,
} from './codex-app-server-u1b.mjs';

const require = createRequire(import.meta.url);
const {
  protocolSchema,
} = require('../../lib/codex/app-server-client.js');

const TURN_TIMEOUT_MS = 120_000;
const SETTINGS_NOTIFICATION_TIMEOUT_MS = 5_000;
const NO_OP_NOTIFICATION_WINDOW_MS = 750;
const ACTIVE_SLEEP_SECONDS = 8;
const ACTIVE_COMMAND = `/bin/sleep ${ACTIVE_SLEEP_SECONDS}`;

function pair(model, effort) {
  if (
    typeof model !== 'string'
    || model.length === 0
    || typeof effort !== 'string'
    || effort.length === 0
  ) {
    throw new Error('model settings pair requires model and effort');
  }
  return Object.freeze({ model, effort });
}

function exactPair(actual, expected) {
  return (
    actual?.model === expected.model
    && (actual?.effort ?? actual?.reasoningEffort) === expected.effort
  );
}

function isEmptyResult(result) {
  return (
    result
    && typeof result === 'object'
    && !Array.isArray(result)
    && Object.keys(result).length === 0
  );
}

function sanitizedErrorClass(error) {
  if (error?.code === 'CODEX_RPC_OUTCOME_UNKNOWN') return 'outcome-unknown';
  if (Number.isSafeInteger(error?.rpcCode)) return 'rpc-error';
  if (error?.code === 'CODEX_RPC_NOT_SENT') return 'not-sent';
  return 'client-error';
}

async function characterizeExperimentalRequest(operation) {
  try {
    const result = await operation();
    return {
      responseClass: isEmptyResult(result)
        ? 'empty-result'
        : 'nonempty-result',
      errorClass: null,
    };
  } catch (error) {
    return {
      responseClass: 'error',
      errorClass: sanitizedErrorClass(error),
    };
  }
}

export function chooseAlternateModelSettings(catalog, selected) {
  const current = selectAdvertisedModelEffort(
    catalog,
    selected.model,
    selected.effort,
  );
  const sameModel = catalog.find(({ model }) => model === current.model);
  const alternateEffort = sameModel.supportedReasoningEfforts.find(
    (effort) => effort !== current.effort,
  );
  if (alternateEffort) return pair(current.model, alternateEffort);
  const alternateModel = catalog.find(({ model }) => model !== current.model);
  if (!alternateModel) {
    throw new Error('G-MODEL-1 requires a distinct advertised settings pair');
  }
  return pair(
    alternateModel.model,
    alternateModel.defaultReasoningEffort,
  );
}

export function evaluateModelSettingsGate(evidence) {
  const checks = {
    experimentalOutcomesCharacterized: (
      ['changed', 'noOp', 'active'].every((lane) => (
        typeof evidence.experimental?.[lane]?.responseClass === 'string'
        && typeof evidence.experimental[lane].notificationObserved === 'boolean'
      ))
    ),
    activeTurnUninterrupted: (
      evidence.activeTurnStartedOnce === true
      && evidence.activeTurnCompleted === true
      && evidence.activeTurnStatus === 'completed'
    ),
    perTurnOverrideCompleted: evidence.perTurnOverrideCompleted === true,
    notificationOrderCharacterized: (
      Array.isArray(evidence.notificationOrder)
      && evidence.notificationOrder.includes('turn-start-response')
      && evidence.notificationOrder.includes('turn-started')
      && typeof evidence.settingsNotificationObserved === 'boolean'
    ),
    sameThreadResumed: evidence.sameThreadResumed === true,
    resumePairExact: evidence.resumePairExact === true,
    resumedTurnCompleted: evidence.resumedTurnCompleted === true,
    productionAllowlistExcluded:
      evidence.productionAllowlistExcluded === true,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    gate: failedChecks.length === 0 ? 'CONTINUE' : 'STOP',
    exitCode: failedChecks.length === 0 ? 0 : 2,
    failedChecks,
  };
}

function retainedEvent(notification) {
  if (notification.method === 'thread/settings/updated') {
    return {
      kind: 'settings-updated',
      model: notification.params?.threadSettings?.model ?? null,
      effort: notification.params?.threadSettings?.effort ?? null,
    };
  }
  if (notification.method === 'turn/started') {
    return {
      kind: 'turn-started',
      turnId: notification.params?.turn?.id ?? null,
    };
  }
  if (notification.method === 'turn/completed') {
    return {
      kind: 'turn-completed',
      turnId: notification.params?.turn?.id ?? null,
      status: notification.params?.turn?.status ?? null,
    };
  }
  return { kind: notification.method };
}

async function waitForNewNotification(
  connection,
  priorNotifications,
  predicate,
  timeoutMs,
) {
  const prior = new Set(priorNotifications);
  return connection.waitForNotification(
    (notification) => (
      !prior.has(notification)
      && predicate(notification)
    ),
    timeoutMs,
  );
}

function settingsNotification(expected) {
  return (notification) => (
    notification.method === 'thread/settings/updated'
    && exactPair(notification.params?.threadSettings, expected)
  );
}

async function startNoToolsTurn(
  connection,
  threadId,
  selected,
  marker,
  eventLog = null,
) {
  const response = await connection.request('turn/start', {
    threadId,
    model: selected.model,
    effort: selected.effort,
    input: [{
      type: 'text',
      text: `Reply with exactly ${marker}. Do not use tools.`,
    }],
  });
  const turnId = response?.turn?.id;
  if (!turnId) throw new Error('G-MODEL-1 turn/start omitted turn id');
  eventLog?.push({ kind: 'turn-start-response', turnId });
  const terminal = await connection.waitForNotification(
    (notification) => (
      notification.method === 'turn/completed'
      && notification.params?.turn?.id === turnId
    ),
    TURN_TIMEOUT_MS,
  );
  if (!terminal) throw new Error('G-MODEL-1 turn did not complete');
  const allowed = new Set(['userMessage', 'agentMessage', 'reasoning']);
  if (
    terminal.params?.turn?.status !== 'completed'
    || (terminal.params?.turn?.items ?? [])
      .some(({ type }) => !allowed.has(type))
  ) {
    throw new Error('G-MODEL-1 no-tools turn was not exact');
  }
  return { turnId, terminal };
}

async function startActiveTurn(connection, threadId, selected) {
  const response = await connection.request('turn/start', {
    threadId,
    model: selected.model,
    effort: selected.effort,
    input: [{
      type: 'text',
      text: (
        `Run exactly ${ACTIVE_COMMAND} once, then reply exactly `
        + 'G_MODEL_ACTIVE_DONE. Do not run any other command.'
      ),
    }],
  });
  const turnId = response?.turn?.id;
  if (!turnId) throw new Error('G-MODEL-1 active turn omitted turn id');
  const started = await connection.waitForNotification(
    (notification) => (
      notification.method === 'turn/started'
      && notification.params?.turn?.id === turnId
    ),
    SETTINGS_NOTIFICATION_TIMEOUT_MS,
  );
  if (!started) throw new Error('G-MODEL-1 active turn never started');
  const command = await connection.waitForNotification(
    (notification) => (
      notification.method === 'item/started'
      && notification.params?.turnId === turnId
      && notification.params?.item?.type === 'commandExecution'
    ),
    TURN_TIMEOUT_MS,
  );
  if (!command?.params?.item?.command?.includes(ACTIVE_COMMAND)) {
    throw new Error('G-MODEL-1 active turn did not run the exact sleep');
  }
  return turnId;
}

export async function characterizeModelSettings(options) {
  options = {
    ...options,
    daemonSecretRoots: validateDaemonSecretRoots(
      options.daemonSecretRoots,
      realpathSync(options.codexHome),
      realpathSync(options.workspace),
    ),
  };
  await attestPinnedCodexBinary(options);
  const env = sanitizedAppServerEnv(options);
  const rawConfigSha256 = createHash('sha256')
    .update(readFileSync(`${options.codexHome}/config.toml`))
    .digest('hex');
  const connections = new Set();
  const openConnection = async ({
    characterizeExperimentalSettings = false,
    eventLog = null,
  } = {}) => {
    const connection = new AppServerConnection({
      ...options,
      characterizeExperimentalSettings,
      retainTurnStarted: true,
      ...(eventLog
        ? {
            onRetainedNotification(notification) {
              eventLog.push(retainedEvent(notification));
            },
          }
        : {}),
    }, env);
    connections.add(connection);
    await initializeConnection(
      connection,
      realpathSync(options.codexHome),
    );
    await attestConnectionPolicy(
      connection,
      options,
      rawConfigSha256,
    );
    return connection;
  };
  const closeConnection = async (connection) => {
    if (!connection) return;
    await connection.close();
    connections.delete(connection);
  };
  try {
    const eventLog = [];
    let productConnection = await openConnection({ eventLog });
    const catalog = await listModelCatalog(productConnection);
    const baseline = pair(options.model, options.effort);
    selectAdvertisedModelEffort(
      catalog,
      baseline.model,
      baseline.effort,
    );
    const alternate = options.alternateModel
      ? pair(options.alternateModel, options.alternateEffort)
      : chooseAlternateModelSettings(catalog, baseline);
    selectAdvertisedModelEffort(
      catalog,
      alternate.model,
      alternate.effort,
    );
    if (exactPair(baseline, alternate)) {
      throw new Error('G-MODEL-1 alternate pair must differ');
    }

    const productFresh = await characterizeThreadProfile(
      productConnection,
      'thread/start',
      {
        cwd: realpathSync(options.workspace),
        model: baseline.model,
      },
    );
    await startNoToolsTurn(
      productConnection,
      productFresh.threadId,
      baseline,
      'G_MODEL_PRODUCT_BASELINE_READY',
    );

    const productEventStart = eventLog.length;
    let prior = [...productConnection.notifications];
    const product = await startNoToolsTurn(
      productConnection,
      productFresh.threadId,
      alternate,
      'G_MODEL_PRODUCT_OVERRIDE_READY',
      eventLog,
    );
    let productSettings = null;
    try {
      productSettings = await waitForNewNotification(
        productConnection,
        prior,
        settingsNotification(alternate),
        SETTINGS_NOTIFICATION_TIMEOUT_MS,
      );
    } catch {}
    const notificationOrder = eventLog.slice(productEventStart)
      .filter((event) => (
        event.kind === 'settings-updated'
          ? exactPair(event, alternate)
          : event.turnId === product.turnId
      ))
      .map(({ kind }) => kind);

    await closeConnection(productConnection);
    productConnection = null;

    let replacement = await openConnection();
    const resumed = await characterizeThreadProfile(
      replacement,
      'thread/resume',
      { threadId: productFresh.threadId },
    );
    const resumedTurn = await startNoToolsTurn(
      replacement,
      productFresh.threadId,
      alternate,
      'G_MODEL_RESUME_READY',
    );
    await closeConnection(replacement);
    replacement = null;

    let idleExperimental = await openConnection({
      characterizeExperimentalSettings: true,
    });
    const idleFresh = await characterizeThreadProfile(
      idleExperimental,
      'thread/start',
      {
        cwd: realpathSync(options.workspace),
        model: baseline.model,
      },
    );
    prior = [...idleExperimental.notifications];
    const changed = await characterizeExperimentalRequest(() => (
      idleExperimental.request('thread/settings/update', {
        threadId: idleFresh.threadId,
        model: alternate.model,
        effort: alternate.effort,
      })
    ));
    let changedNotification = null;
    try {
      changedNotification = await waitForNewNotification(
        idleExperimental,
        prior,
        settingsNotification(alternate),
        SETTINGS_NOTIFICATION_TIMEOUT_MS,
      );
    } catch {}

    let noOp = {
      responseClass: 'not-attempted',
      errorClass: 'changed-update-not-applied',
    };
    let noOpNotification = null;
    if (changed.responseClass === 'empty-result') {
      prior = [...idleExperimental.notifications];
      noOp = await characterizeExperimentalRequest(() => (
        idleExperimental.request('thread/settings/update', {
          threadId: idleFresh.threadId,
          model: alternate.model,
          effort: alternate.effort,
        })
      ));
      try {
        noOpNotification = await waitForNewNotification(
          idleExperimental,
          prior,
          (notification) => (
            notification.method === 'thread/settings/updated'
          ),
          NO_OP_NOTIFICATION_WINDOW_MS,
        );
      } catch {}
    }
    await closeConnection(idleExperimental);
    idleExperimental = null;

    let activeExperimental = await openConnection({
      characterizeExperimentalSettings: true,
    });
    const activeFresh = await characterizeThreadProfile(
      activeExperimental,
      'thread/start',
      {
        cwd: realpathSync(options.workspace),
        model: baseline.model,
      },
    );
    let activeTurnId = null;
    let activeSetupClass = 'started';
    try {
      activeTurnId = await startActiveTurn(
        activeExperimental,
        activeFresh.threadId,
        baseline,
      );
    } catch (error) {
      activeSetupClass = sanitizedErrorClass(error);
    }
    let active = {
      responseClass: 'not-attempted',
      errorClass: 'active-turn-not-started',
    };
    let activeUpdateNotification = null;
    let activeTerminal = null;
    let activeTurnStartedCount = 0;
    if (activeTurnId) {
      prior = [...activeExperimental.notifications];
      active = await characterizeExperimentalRequest(() => (
        activeExperimental.request('thread/settings/update', {
          threadId: activeFresh.threadId,
          model: alternate.model,
          effort: alternate.effort,
        })
      ));
      try {
        activeUpdateNotification = await waitForNewNotification(
          activeExperimental,
          prior,
          settingsNotification(alternate),
          SETTINGS_NOTIFICATION_TIMEOUT_MS,
        );
      } catch {}
      try {
        activeTerminal = await activeExperimental.waitForNotification(
          (notification) => (
            notification.method === 'turn/completed'
            && notification.params?.turn?.id === activeTurnId
          ),
          TURN_TIMEOUT_MS,
        );
      } catch {}
      activeTurnStartedCount = activeExperimental.notifications.filter(
        (notification) => (
          notification.method === 'turn/started'
          && notification.params?.turn?.id === activeTurnId
        ),
      ).length;
    }
    await closeConnection(activeExperimental);
    activeExperimental = null;

    const evidence = {
      experimental: {
        changed: {
          ...changed,
          notificationObserved: Boolean(changedNotification),
        },
        noOp: {
          ...noOp,
          notificationObserved: Boolean(noOpNotification),
        },
        active: {
          ...active,
          notificationObserved: Boolean(activeUpdateNotification),
        },
      },
      activeTurnStartedOnce: activeTurnStartedCount === 1,
      activeTurnCompleted: Boolean(activeTerminal),
      activeTurnStatus: activeTerminal?.params?.turn?.status ?? null,
      perTurnOverrideCompleted:
        product.terminal.params?.turn?.status === 'completed',
      settingsNotificationObserved: Boolean(productSettings),
      notificationOrder,
      sameThreadResumed: resumed.threadId === productFresh.threadId,
      resumePairExact: exactPair({
        model: resumed.model,
        effort: resumed.reasoningEffort,
      }, alternate),
      resumedTurnCompleted:
        resumedTurn.terminal.params?.turn?.status === 'completed',
      productionAllowlistExcluded:
        !Object.hasOwn(
          protocolSchema.clientRequests,
          'thread/settings/update',
        ),
    };
    return {
      ...evaluateModelSettingsGate(evidence),
      runtime: {
        cliVersion: protocolSchema.cliVersion,
      },
      pairs: { baseline, alternate },
      experimentalIdle: {
        changed: evidence.experimental.changed,
        noOp: evidence.experimental.noOp,
      },
      experimentalActive: {
        ...evidence.experimental.active,
        setupClass: activeSetupClass,
        originalTurnStartedOnce: evidence.activeTurnStartedOnce,
        originalTurnStatus: evidence.activeTurnStatus,
      },
      perTurnOverride: {
        turnCompleted: evidence.perTurnOverrideCompleted,
        settingsNotificationObserved:
          evidence.settingsNotificationObserved,
        notificationOrder,
      },
      resume: {
        sameThread: evidence.sameThreadResumed,
        modelAndEffortExact: evidence.resumePairExact,
        laterTurnCompleted: evidence.resumedTurnCompleted,
      },
      productionSettingsUpdateAllowlisted: false,
      redaction: (
        'Only booleans, ordering labels, model and effort slugs, and '
        + 'runtime version are retained.'
      ),
    };
  } finally {
    await Promise.allSettled(
      [...connections].map((connection) => connection.close()),
    );
  }
}

function parseArgs(argv) {
  const options = {
    binary: process.env.POLYGRAM_CODEX_BIN ?? '',
    launcher: process.env.ORCHESTRA_SESSION_LAUNCHER ?? '',
    codexHome: process.env.ORCHESTRA_CODEX_HOME ?? '',
    workspace: process.env.ORCHESTRA_CODEX_WORKSPACE ?? '',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    alternateModel: '',
    alternateEffort: '',
    daemonSecretRoots: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = argv[++index] ?? '';
    else if (arg === '--launcher') options.launcher = argv[++index] ?? '';
    else if (arg === '--codex-home') options.codexHome = argv[++index] ?? '';
    else if (arg === '--workspace') options.workspace = argv[++index] ?? '';
    else if (arg === '--model') options.model = argv[++index] ?? '';
    else if (arg === '--effort') options.effort = argv[++index] ?? '';
    else if (arg === '--alternate-model') {
      options.alternateModel = argv[++index] ?? '';
    } else if (arg === '--alternate-effort') {
      options.alternateEffort = argv[++index] ?? '';
    } else if (arg === '--daemon-secret-root') {
      options.daemonSecretRoots.push(argv[++index] ?? '');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const key of ['binary', 'codexHome', 'workspace', 'model', 'effort']) {
    if (!options[key]) throw new Error(`missing required G-MODEL-1 option: ${key}`);
  }
  if (Boolean(options.alternateModel) !== Boolean(options.alternateEffort)) {
    throw new Error('alternate model and effort must be supplied together');
  }
  if (options.daemonSecretRoots.length === 0) {
    options.daemonSecretRoots = (
      process.env.ORCHESTRA_CODEX_DAEMON_SECRET_ROOTS ?? ''
    ).split(delimiter).filter(Boolean);
  }
  if (options.daemonSecretRoots.length === 0) {
    throw new Error('at least one daemon secret root is required');
  }
  return options;
}

async function main() {
  const result = await characterizeModelSettings(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.gate === 'CONTINUE' ? 0 : 2;
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  await main();
}
