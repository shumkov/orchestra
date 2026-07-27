#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  AppServerConnection,
  attestConnectionPolicy,
  attestPinnedCodexBinary,
  sanitizedAppServerEnv,
  initializeConnection,
  characterizeThreadProfile,
  validateDaemonSecretRoots,
} from './codex-app-server-real.mjs';

const MODEL_LIST_MAX_PAGES = 100;
const MODEL_LIST_PAGE_SIZE = 100;
const REQUIRED_RESOURCE_FIELDS = [
  'rootRssKiB',
  'treeRssKiB',
  'rootFdCount',
  'treeFdCount',
  'descendantCount',
];

function boundedCatalogString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > 512
  ) {
    throw new Error(`model catalog returned an invalid ${label}`);
  }
  return value;
}

function projectCatalogModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('model catalog returned an invalid model');
  }
  if (!Array.isArray(value.supportedReasoningEfforts)) {
    throw new Error('model catalog omitted supported reasoning efforts');
  }
  const supportedReasoningEfforts = value.supportedReasoningEfforts.map(
    (option) => boundedCatalogString(
      option?.reasoningEffort,
      'reasoning effort',
    ),
  );
  if (new Set(supportedReasoningEfforts).size !== supportedReasoningEfforts.length) {
    throw new Error('model catalog repeated a reasoning effort');
  }
  const defaultReasoningEffort = boundedCatalogString(
    value.defaultReasoningEffort,
    'default reasoning effort',
  );
  if (!supportedReasoningEfforts.includes(defaultReasoningEffort)) {
    throw new Error('model catalog default effort was not supported');
  }
  return {
    id: boundedCatalogString(value.id, 'id'),
    model: boundedCatalogString(value.model, 'model'),
    defaultReasoningEffort,
    supportedReasoningEfforts,
  };
}

export async function listModelCatalog(connection) {
  const models = [];
  const seenCursors = new Set();
  let cursor;
  let pageCount = 0;
  do {
    if (pageCount >= MODEL_LIST_MAX_PAGES) {
      throw new Error('model catalog pagination exceeded the page limit');
    }
    pageCount += 1;
    const result = await connection.request('model/list', {
      includeHidden: false,
      limit: MODEL_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) {
      throw new Error('model catalog omitted data');
    }
    models.push(...result.data.map(projectCatalogModel));
    cursor = result.nextCursor ?? null;
    if (cursor != null) {
      boundedCatalogString(cursor, 'pagination cursor');
      if (seenCursors.has(cursor)) {
        throw new Error('model catalog pagination repeated a cursor');
      }
      seenCursors.add(cursor);
    }
  } while (cursor);
  const slugs = models.map((model) => model.model);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error('model catalog repeated a model');
  }
  return models;
}

export function selectAdvertisedModelEffort(catalog, requestedModel, requestedEffort) {
  const model = catalog.find((candidate) => candidate.model === requestedModel);
  if (!model) {
    throw new Error(`requested model is not advertised: ${requestedModel}`);
  }
  if (!model.supportedReasoningEfforts.includes(requestedEffort)) {
    throw new Error(
      `model ${requestedModel} does not advertise effort ${requestedEffort}`,
    );
  }
  return {
    model: model.model,
    effort: requestedEffort,
    defaultReasoningEffort: model.defaultReasoningEffort,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function summarizeResourceSamples(label, samples) {
  if (
    typeof label !== 'string'
    || label.length === 0
    || !Array.isArray(samples)
    || samples.length === 0
  ) {
    throw new Error('resource samples require a label and observations');
  }
  for (const sample of samples) {
    if (
      !sample
      || REQUIRED_RESOURCE_FIELDS.some(
        (field) => !Number.isFinite(sample[field]) || sample[field] < 0,
      )
    ) {
      throw new Error('incomplete resource sample');
    }
  }
  return {
    label,
    sampleCount: samples.length,
    ...Object.fromEntries(REQUIRED_RESOURCE_FIELDS.map((field) => {
      const values = samples.map((sample) => sample[field]);
      return [field, { median: median(values), max: Math.max(...values) }];
    })),
  };
}

export function evaluateModelPersistence({
  selected,
  freshResponse,
  settingsUpdate,
  resumeResponse,
  laterTurnCompleted,
}) {
  const settingsMatch = (
    (
      settingsUpdate?.model === selected.model
      && settingsUpdate?.effort === selected.effort
    )
    || (
      settingsUpdate == null
      && freshResponse?.model === selected.model
      && freshResponse?.reasoningEffort === selected.effort
    )
  );
  const freshMatch = freshResponse?.model === selected.model;
  const resumeMatch = (
    resumeResponse?.model === selected.model
    && resumeResponse?.reasoningEffort === selected.effort
  );
  const passed = Boolean(
    freshMatch
    && settingsMatch
    && resumeMatch
    && laterTurnCompleted,
  );
  return {
    gate: passed ? 'CONTINUE' : 'STOP',
    freshMatch,
    settingsMatch,
    resumeMatch,
    laterTurnCompleted: Boolean(laterTurnCompleted),
  };
}

async function completeNoToolsTurn(
  connection,
  threadId,
  marker,
  selection = null,
) {
  const started = await connection.request('turn/start', {
    threadId,
    ...(selection ?? {}),
    input: [{
      type: 'text',
      text: `Reply with exactly ${marker}. Do not use tools.`,
    }],
  });
  const turnId = started.turn?.id;
  if (!turnId) throw new Error('U1b turn/start omitted turn id');
  const terminal = await connection.waitForNotification(
    (message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === threadId
      && message.params?.turn?.id === turnId
    ),
    120_000,
  );
  if (terminal?.params?.turn?.status !== 'completed') {
    throw new Error('U1b no-tools turn did not complete');
  }
  const allowedItemTypes = new Set(['userMessage', 'agentMessage', 'reasoning']);
  if (
    (terminal.params.turn.items ?? [])
      .some((item) => !allowedItemTypes.has(item.type))
  ) {
    throw new Error('U1b no-tools turn unexpectedly used a tool');
  }
  return terminal;
}

export async function characterizeModelPersistence(options) {
  options = {
    ...options,
    daemonSecretRoots: validateDaemonSecretRoots(
      options.daemonSecretRoots,
      realpathSync(options.codexHome),
      realpathSync(options.workspace),
    ),
  };
  await attestPinnedCodexBinary(options);
  const rawConfigSha256 = createHash('sha256')
    .update(readFileSync(`${options.codexHome}/config.toml`))
    .digest('hex');
  const env = sanitizedAppServerEnv(options);
  let connection;
  let replacement;
  try {
    connection = new AppServerConnection(options, env);
    await initializeConnection(connection, realpathSync(options.codexHome));
    await attestConnectionPolicy(connection, options, rawConfigSha256);
    const catalog = await listModelCatalog(connection);
    const selected = selectAdvertisedModelEffort(
      catalog,
      options.model,
      options.effort,
    );
    const freshStartedAt = performance.now();
    const fresh = await characterizeThreadProfile(connection, 'thread/start', {
      cwd: realpathSync(options.workspace),
      model: selected.model,
    });
    const freshReadyMs = performance.now() - freshStartedAt;
    if (!fresh.responseExtensionExact && !fresh.settingsNotificationExact) {
      throw new Error('thread/start omitted exact permission-profile provenance');
    }
    if (fresh.model !== selected.model) {
      throw new Error('thread/start did not apply the selected model');
    }
    await completeNoToolsTurn(
      connection,
      fresh.threadId,
      'U1B_MODEL_READY',
      { model: selected.model, effort: selected.effort },
    );
    const settings = connection.notifications.findLast(
      (message) => (
        message.method === 'thread/settings/updated'
        && message.params?.threadId === fresh.threadId
        && (
          message.params?.threadSettings?.model !== undefined
          || message.params?.threadSettings?.effort !== undefined
        )
      ),
    )?.params?.threadSettings;
    await connection.close();
    connection = null;

    replacement = new AppServerConnection(options, env);
    await initializeConnection(replacement, realpathSync(options.codexHome));
    await attestConnectionPolicy(replacement, options, rawConfigSha256);
    const resumeStartedAt = performance.now();
    const resumed = await characterizeThreadProfile(
      replacement,
      'thread/resume',
      { threadId: fresh.threadId },
    );
    const resumeReadyMs = performance.now() - resumeStartedAt;
    if (!resumed.responseExtensionExact && !resumed.settingsNotificationExact) {
      throw new Error('thread/resume omitted exact permission-profile provenance');
    }
    const laterTerminal = await completeNoToolsTurn(
      replacement,
      fresh.threadId,
      'U1B_RESUME_READY',
    );
    const gate = evaluateModelPersistence({
      selected,
      freshResponse: fresh,
      settingsUpdate: settings,
      resumeResponse: resumed,
      laterTurnCompleted: laterTerminal.params.turn.status === 'completed',
    });
    return {
      ...gate,
      selected,
      advertisedModelCount: catalog.length,
      freshReadyMs: Math.round(freshReadyMs),
      resumeReadyMs: Math.round(resumeReadyMs),
    };
  } finally {
    await Promise.allSettled([
      connection?.close(),
      replacement?.close(),
    ].filter(Boolean));
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
    else if (arg === '--daemon-secret-root') {
      options.daemonSecretRoots.push(argv[++index] ?? '');
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['binary', 'codexHome', 'workspace', 'model', 'effort']) {
    if (!options[key]) throw new Error(`missing required U1b option: ${key}`);
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
  const result = await characterizeModelPersistence(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.gate === 'CONTINUE' ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await main();
}
