#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  summarizeResourceSamples,
} from './codex-app-server-u1b.mjs';

const DEFAULT_COUNTS = [1, 10, 25];
const SAMPLE_INTERVAL_MS = 250;
const IDLE_SAMPLE_COUNT = 10;
const ACTIVE_SAMPLE_COUNT = 20;
const ACTIVE_PROXY_SECONDS = 8;

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed under the service identity`);
  }
  return result.stdout;
}

export function parseProcessSnapshot(output) {
  const processes = new Map();
  for (const line of output.split('\n')) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/,
    );
    if (!match) continue;
    const [, pid, ppid, pgid, session, state, rssKiB] = match;
    processes.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      session: Number(session),
      state,
      rssKiB: Number(rssKiB),
    });
  }
  return processes;
}

export function parseLsofDescriptorCounts(output) {
  const counts = new Map();
  let pid = null;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1));
      counts.set(pid, counts.get(pid) ?? 0);
    } else if (pid !== null && /^f\d+$/.test(line)) {
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
  }
  return counts;
}

function collectOwnedPids(rootPids, processes) {
  const owned = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes.values()) {
      if (owned.has(processInfo.ppid) && !owned.has(processInfo.pid)) {
        owned.add(processInfo.pid);
        changed = true;
      }
    }
  }
  return owned;
}

export function summarizeOwnedProcessTree(
  rootPids,
  processes,
  descriptorCounts,
) {
  for (const rootPid of rootPids) {
    if (!processes.has(rootPid)) {
      throw new Error('owned root process was absent from the resource snapshot');
    }
  }
  const roots = new Set(rootPids);
  const owned = collectOwnedPids(rootPids, processes);
  let rootRssKiB = 0;
  let treeRssKiB = 0;
  let rootFdCount = 0;
  let treeFdCount = 0;
  for (const pid of owned) {
    const rssKiB = processes.get(pid)?.rssKiB ?? 0;
    const fdCount = descriptorCounts.get(pid) ?? 0;
    treeRssKiB += rssKiB;
    treeFdCount += fdCount;
    if (roots.has(pid)) {
      rootRssKiB += rssKiB;
      rootFdCount += fdCount;
    }
  }
  return {
    rootRssKiB,
    treeRssKiB,
    rootFdCount,
    treeFdCount,
    descendantCount: owned.size - roots.size,
  };
}

function snapshotOwnedResources(rootPids) {
  const processes = parseProcessSnapshot(requireSuccess(
    spawnSync('/bin/ps', [
      '-axo',
      'pid=,ppid=,pgid=,sess=,state=,rss=,comm=',
    ], { encoding: 'utf8' }),
    'process snapshot',
  ));
  const owned = collectOwnedPids(rootPids, processes);
  const descriptorCounts = parseLsofDescriptorCounts(requireSuccess(
    spawnSync('/usr/sbin/lsof', [
      '-nP',
      '-a',
      '-p',
      [...owned].join(','),
      '-Fpf',
    ], { encoding: 'utf8' }),
    'descriptor snapshot',
  ));
  return summarizeOwnedProcessTree(rootPids, processes, descriptorCounts);
}

async function sampleResources(rootPids, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(snapshotOwnedResources(rootPids));
    if (index + 1 < count) await delay(SAMPLE_INTERVAL_MS);
  }
  return samples;
}

async function startIdleChild(options, env, model, rawConfigSha256) {
  const startedAt = performance.now();
  const connection = new AppServerConnection(options, env);
  try {
    await initializeConnection(connection, realpathSync(options.codexHome));
    await attestConnectionPolicy(
      connection,
      options,
      rawConfigSha256,
    );
    const initializedMs = performance.now() - startedAt;
    const threadStartedAt = performance.now();
    const profile = await characterizeThreadProfile(
      connection,
      'thread/start',
      {
        cwd: realpathSync(options.workspace),
        model,
        ephemeral: true,
      },
    );
    if (!profile.responseExtensionExact && !profile.settingsNotificationExact) {
      throw new Error('resource child omitted exact permission-profile provenance');
    }
    return {
      connection,
      threadId: profile.threadId,
      initializedMs,
      threadReadyMs: performance.now() - threadStartedAt,
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted.length % 2 === 0
    ? (sorted[(sorted.length / 2) - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return {
    medianMs: Math.round(median),
    maxMs: Math.round(Math.max(...values)),
  };
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  )];
}

async function characterizeWarmRpc(connection) {
  const values = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    await connection.request('account/read', { refreshToken: false });
    if (index > 0) values.push(performance.now() - startedAt);
  }
  return {
    sampleCount: values.length,
    p50Ms: Math.round(percentile(values, 50)),
    p95Ms: Math.round(percentile(values, 95)),
    maxMs: Math.round(Math.max(...values)),
  };
}

async function characterizeHostedActive(child, model, effort) {
  const { connection, threadId } = child;
  const started = await connection.request('turn/start', {
    threadId,
    model,
    effort,
    input: [{
      type: 'text',
      text: 'Run /bin/sleep 8 exactly once with the command tool, wait for it, then reply with exactly U1B_RESOURCE_READY.',
    }],
  });
  const turnId = started.turn?.id;
  if (!turnId) throw new Error('hosted resource turn omitted turn id');
  const command = await connection.waitForNotification(
    (message) => (
      message.method === 'item/started'
      && message.params?.threadId === threadId
      && message.params?.turnId === turnId
      && message.params?.item?.type === 'commandExecution'
      && message.params.item.command.includes('/bin/sleep 8')
    ),
    60_000,
  );
  if (!command) throw new Error('hosted resource command setup was inconclusive');
  const resources = summarizeResourceSamples(
    '1-active-hosted-turn',
    await sampleResources([connection.child.pid], ACTIVE_SAMPLE_COUNT),
  );
  const terminal = await connection.waitForNotification(
    (message) => (
      message.method === 'turn/completed'
      && message.params?.threadId === threadId
      && message.params?.turn?.id === turnId
    ),
    60_000,
  );
  if (terminal?.params?.turn?.status !== 'completed') {
    throw new Error('hosted resource turn did not complete');
  }
  return resources;
}

async function characterizeCount(
  options,
  env,
  model,
  effort,
  count,
  rawConfigSha256,
) {
  const children = [];
  try {
    children.push(...await Promise.all(
      Array.from(
        { length: count },
        () => startIdleChild(options, env, model, rawConfigSha256),
      ),
    ));
    const rootPids = children.map(({ connection }) => connection.child.pid);
    await delay(2_000);
    const idle = summarizeResourceSamples(
      `${count}-idle-ephemeral-thread`,
      await sampleResources(rootPids, IDLE_SAMPLE_COUNT),
    );
    const warmRpc = count === 1
      ? await characterizeWarmRpc(children[0].connection)
      : null;
    const hostedActive = count === 1
      ? await characterizeHostedActive(children[0], model, effort)
      : null;

    const commands = children.map(({ connection }) => connection.request(
      'command/exec',
      {
        cwd: realpathSync(options.workspace),
        command: ['/bin/sleep', String(ACTIVE_PROXY_SECONDS)],
        outputBytesCap: 256,
        timeoutMs: (ACTIVE_PROXY_SECONDS + 4) * 1_000,
      },
      (ACTIVE_PROXY_SECONDS + 6) * 1_000,
    ));
    await delay(500);
    const active = summarizeResourceSamples(
      `${count}-active-local-command-proxy`,
      await sampleResources(rootPids, ACTIVE_SAMPLE_COUNT),
    );
    const commandResults = await Promise.all(commands);
    if (commandResults.some((result) => result.exitCode !== 0)) {
      throw new Error('active local command proxy did not exit successfully');
    }
    return {
      count,
      initializedLatency: latencySummary(
        children.map((child) => child.initializedMs),
      ),
      threadReadyLatency: latencySummary(
        children.map((child) => child.threadReadyMs),
      ),
      ...(warmRpc ? { warmRpc } : {}),
      ...(hostedActive ? { hostedActive } : {}),
      idle,
      active,
    };
  } finally {
    await Promise.allSettled(
      children.map(({ connection }) => connection.close()),
    );
    for (const { connection } of children) {
      const pid = connection.child.pid;
      try {
        process.kill(pid, 0);
        throw new Error('owned resource child survived cleanup');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
}

export async function characterizeResources(options, counts = DEFAULT_COUNTS) {
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
  let catalogConnection;
  try {
    catalogConnection = new AppServerConnection(options, env);
    await initializeConnection(
      catalogConnection,
      realpathSync(options.codexHome),
    );
    await attestConnectionPolicy(catalogConnection, options, rawConfigSha256);
    const catalog = await listModelCatalog(catalogConnection);
    const selected = selectAdvertisedModelEffort(
      catalog,
      options.model,
      options.effort,
    );
    await catalogConnection.close();
    catalogConnection = null;

    const points = [];
    for (const count of counts) {
      points.push(await characterizeCount(
        options,
        env,
        selected.model,
        selected.effort,
        count,
        rawConfigSha256,
      ));
    }
    return {
      gate: 'CONTINUE',
      launcherMode: options.launcher ? 'configured-wrapper' : 'direct',
      activeRealAt10And25: 'NOT_RUN_ONE_LIVE_NATIVE_BETA',
      activeProxyMeaning: 'local command/sandbox/process overhead only',
      rssMeaning: 'recursive summed RSS; shared pages may be double-counted',
      points,
    };
  } finally {
    await catalogConnection?.close();
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
    counts: DEFAULT_COUNTS,
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
    else if (arg === '--counts') {
      options.counts = (argv[++index] ?? '').split(',').map(Number);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['binary', 'codexHome', 'workspace', 'model', 'effort']) {
    if (!options[key]) throw new Error(`missing required resource option: ${key}`);
  }
  if (
    options.counts.length === 0
    || options.counts.some(
      (count) => !Number.isSafeInteger(count) || count < 1 || count > 25,
    )
  ) {
    throw new Error('resource counts must be integers from 1 through 25');
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
  const options = parseArgs(process.argv.slice(2));
  const result = await characterizeResources(options, options.counts);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await main();
}
