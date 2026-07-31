'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const {
  CodexAppServerClient,
  buildCodexAppServerEnv,
  protocolSchema,
  resolveCodexTargetPin,
} = require('./app-server-client');

const MAX_PAGES = 16;
const MAX_ENTRIES = 1_000;
const PAGE_LIMIT = 100;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_OBJECT_KEYS = 512;
const MAX_ARRAY_ITEMS = 1_024;
const MAX_NODES = 16_384;
const MAX_DEPTH = 16;
const POST_READ_SETTLE_MS = 25;
const SHA256_RE = /^[a-f0-9]{64}$/;
const EXPECTED_PROFILE_KEYS = new Set([
  'runtime',
  'binary',
  'target',
  'binarySha256',
  'cliVersion',
  'protocolSchemaSha256',
  'codexHome',
  'cwd',
  'env',
  'allowlistedEnvironmentFingerprint',
  'ownedConfigSha256',
  'expectedConfigSha256',
  'expectedConfig',
  'expectedLayers',
  'expectedOriginsSha256',
  'expectedRequirements',
  'expectedPermissionProfiles',
  'permissionProfileId',
  'model',
  'effort',
  'sessionLauncher',
  'sessionLauncherSha256',
]);
const OPTIONAL_EXPECTED_PROFILE_KEYS = new Set([
  'sessionLauncher',
  'sessionLauncherSha256',
]);
const PREFLIGHT_RESULT_KEYS = new Set([
  'runtime',
  'runtimeVersion',
  'schemaVersion',
  'spawnProfileId',
  'auth',
  'attestation',
  'models',
  'efforts',
  'selected',
]);
const SPAWN_PROFILE_KEYS = new Set([
  'runtime',
  'spawnProfileId',
  'expectedStaticProfile',
  'modelCatalog',
]);
const SUCCESSFUL_PREFLIGHT_RESULTS = new WeakSet();
const SPAWN_PROFILE_RECEIPTS = new WeakSet();

class CodexPreflightError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'CodexPreflightError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isDeepFrozenPlainData(value, visiting = new Set()) {
  if (value === null) return true;
  if (typeof value !== 'object') {
    return (
      typeof value === 'string'
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    );
  }
  if (!Object.isFrozen(value) || visiting.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value)
    && prototype !== Object.prototype
    && prototype !== null
  ) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  visiting.add(value);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!('value' in descriptor)) return false;
    if (!isDeepFrozenPlainData(descriptor.value, visiting)) return false;
  }
  visiting.delete(value);
  return true;
}

function plainObject(value, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`Codex preflight ${label} must be a plain object`);
  }
  return value;
}

function cloneBounded(value, label) {
  let nodes = 0;
  const clone = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new TypeError(`Codex preflight ${label} exceeds structural bounds`);
    }
    if (
      current === null
      || typeof current === 'boolean'
      || (
        typeof current === 'number'
        && Number.isFinite(current)
      )
    ) return current;
    if (typeof current === 'string') {
      if (Buffer.byteLength(current) > MAX_STRING_BYTES) {
        throw new TypeError(`Codex preflight ${label} contains an oversized string`);
      }
      return current;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_ITEMS) {
        throw new TypeError(`Codex preflight ${label} contains an oversized array`);
      }
      return current.map((entry) => clone(entry, depth + 1));
    }
    const object = plainObject(current, label);
    const entries = Object.entries(object);
    if (entries.length > MAX_OBJECT_KEYS) {
      throw new TypeError(`Codex preflight ${label} contains too many keys`);
    }
    return Object.fromEntries(entries.map(([key, entry]) => {
      if (Buffer.byteLength(key) > MAX_STRING_BYTES) {
        throw new TypeError(`Codex preflight ${label} contains an oversized key`);
      }
      return [key, clone(entry, depth + 1)];
    }));
  };
  return clone(value, 0);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  const input = typeof value === 'string'
    ? value
    : JSON.stringify(canonical(value));
  return createHash('sha256').update(input).digest('hex');
}

function requiredString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > MAX_STRING_BYTES
  ) {
    throw new TypeError(`Codex preflight ${label} must be a non-empty string`);
  }
  return value;
}

function requiredSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new TypeError(`Codex preflight ${label} must be a lowercase SHA-256`);
  }
  return value;
}

function exact(actual, expected, label) {
  let left;
  let right;
  try {
    left = JSON.stringify(canonical(cloneBounded(actual, label)));
    right = JSON.stringify(canonical(expected));
  } catch (error) {
    if (error instanceof CodexPreflightError) throw error;
    throw new CodexPreflightError(
      `Codex ${label} was malformed`,
      'CODEX_STATIC_PROFILE_MISMATCH',
      { cause: error },
    );
  }
  if (left !== right) {
    throw new CodexPreflightError(
      `Codex ${label} did not match the expected static profile`,
      'CODEX_STATIC_PROFILE_MISMATCH',
    );
  }
}

function normalizeExpectedProfile(value) {
  const targetReceipt = resolveCodexTargetPin();
  const source = plainObject(value, 'expectedStaticProfile');
  for (const key of Object.keys(source)) {
    if (!EXPECTED_PROFILE_KEYS.has(key)) {
      throw new TypeError(`Codex preflight unexpected static profile field: ${key}`);
    }
  }
  for (const key of EXPECTED_PROFILE_KEYS) {
    if (
      !OPTIONAL_EXPECTED_PROFILE_KEYS.has(key)
      && !Object.hasOwn(source, key)
    ) {
      throw new TypeError(`Codex preflight missing static profile field: ${key}`);
    }
  }
  if (source.runtime !== 'codex') {
    throw new TypeError('Codex preflight runtime must be codex');
  }
  const binary = requiredString(source.binary, 'binary');
  const codexHome = requiredString(source.codexHome, 'codexHome');
  const cwd = requiredString(source.cwd, 'cwd');
  if (
    !path.isAbsolute(binary)
    || !path.isAbsolute(codexHome)
    || !path.isAbsolute(cwd)
  ) {
    throw new TypeError('Codex preflight runtime paths must be absolute');
  }
  const binarySha256 = requiredSha256(
    source.binarySha256,
    'binarySha256',
  );
  const target = requiredString(source.target, 'target');
  const cliVersion = requiredString(source.cliVersion, 'cliVersion');
  const protocolSchemaSha256 = requiredSha256(
    source.protocolSchemaSha256,
    'protocolSchemaSha256',
  );
  const suppliedLauncher = source.sessionLauncher ?? null;
  const suppliedLauncherSha256 = source.sessionLauncherSha256 ?? null;
  if ((suppliedLauncher === null) !== (suppliedLauncherSha256 === null)) {
    throw new TypeError(
      'Codex preflight session launcher path and SHA-256 must be paired',
    );
  }
  const sessionLauncher = suppliedLauncher === null
    ? null
    : requiredString(suppliedLauncher, 'sessionLauncher');
  const sessionLauncherSha256 = suppliedLauncherSha256 === null
    ? null
    : requiredSha256(suppliedLauncherSha256, 'sessionLauncherSha256');
  if (sessionLauncher !== null && !path.isAbsolute(sessionLauncher)) {
    throw new TypeError('Codex preflight session launcher must be absolute');
  }
  if (
    target !== targetReceipt.target
    || binarySha256 !== targetReceipt.binarySha256
    || cliVersion !== targetReceipt.cliVersion
    || protocolSchemaSha256
      !== protocolSchema.generatedProtocolV2CanonicalSha256
  ) {
    throw new CodexPreflightError(
      'Codex runtime pin does not match the embedded protocol',
      'CODEX_RUNTIME_PIN_MISMATCH',
    );
  }

  const suppliedEnv = cloneBounded(source.env, 'environment');
  plainObject(suppliedEnv, 'environment');
  const env = buildCodexAppServerEnv(codexHome, suppliedEnv);
  const allowlistedEnvironmentFingerprint = requiredSha256(
    source.allowlistedEnvironmentFingerprint,
    'allowlistedEnvironmentFingerprint',
  );
  const observedEnvironmentFingerprint = digest(
    env,
  );
  if (
    allowlistedEnvironmentFingerprint !== observedEnvironmentFingerprint
  ) {
    throw new CodexPreflightError(
      'Codex allowlisted environment fingerprint did not match',
      'CODEX_STATIC_PROFILE_MISMATCH',
    );
  }

  const expectedConfig = cloneBounded(
    source.expectedConfig,
    'expected config projection',
  );
  const expectedLayers = cloneBounded(
    source.expectedLayers,
    'expected config layers',
  );
  const expectedRequirements = cloneBounded(
    source.expectedRequirements,
    'expected config requirements',
  );
  const expectedPermissionProfiles = cloneBounded(
    source.expectedPermissionProfiles,
    'expected permission profiles',
  );
  if (
    !Array.isArray(expectedLayers)
    || !Array.isArray(expectedPermissionProfiles)
    || expectedLayers.length > 64
    || expectedPermissionProfiles.length > MAX_ENTRIES
  ) {
    throw new TypeError(
      'Codex preflight expected layers or profiles exceeded their bounds',
    );
  }
  const expectedProfileIds = new Set();
  const normalizedExpectedPermissionProfiles = expectedPermissionProfiles
    .map((entry) => {
      const projected = validatePermissionProfile(entry).value;
      if (expectedProfileIds.has(projected.id)) {
        throw new CodexPreflightError(
          'Codex expected permission profiles contain a duplicate ID',
          'CODEX_PREFLIGHT_DUPLICATE',
        );
      }
      expectedProfileIds.add(projected.id);
      return projected;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const profile = {
    runtime: 'codex',
    binary,
    target,
    binarySha256,
    cliVersion,
    protocolSchemaSha256,
    codexHome,
    cwd,
    env,
    allowlistedEnvironmentFingerprint,
    ownedConfigSha256: requiredSha256(
      source.ownedConfigSha256,
      'ownedConfigSha256',
    ),
    expectedConfigSha256: requiredSha256(
      source.expectedConfigSha256,
      'expectedConfigSha256',
    ),
    expectedConfig,
    expectedLayers,
    expectedOriginsSha256: requiredSha256(
      source.expectedOriginsSha256,
      'expectedOriginsSha256',
    ),
    expectedRequirements,
    expectedPermissionProfiles: normalizedExpectedPermissionProfiles,
    permissionProfileId: requiredString(
      source.permissionProfileId,
      'permissionProfileId',
    ),
    model: requiredString(source.model, 'model'),
    effort: requiredString(source.effort, 'effort'),
    sessionLauncher,
    sessionLauncherSha256,
  };

  assertExpectedPolicy(profile);
  return profile;
}

function assertExpectedPolicy(profile) {
  const config = plainObject(profile.expectedConfig, 'expected config projection');
  if (
    config.sha256 !== profile.expectedConfigSha256
    || config.modelProvider !== 'openai'
    || config.defaultPermissions !== profile.permissionProfileId
    || config.approvalPolicy !== 'never'
    || config.approvalsReviewer !== 'user'
    || config.webSearch !== 'disabled'
    || config.allowLoginShell !== false
    || config.shellEnvironmentInherit !== 'none'
    || config.mcpServers?.count !== 0
    || config.mcpServers?.keySha256?.length !== 0
    || config.plugins?.count !== 0
    || config.plugins?.keySha256?.length !== 0
    || config.modelProviders?.count !== 0
    || config.modelProviders?.keySha256?.length !== 0
  ) {
    throw new CodexPreflightError(
      'Codex expected policy is outside the native beta contract',
      'CODEX_STATIC_PROFILE_MISMATCH',
    );
  }
  if (!Array.isArray(config.permissionProfiles)) {
    throw new TypeError(
      'Codex preflight expected config permission profiles must be an array',
    );
  }
  const configured = config.permissionProfiles.filter(
    (entry) => entry?.id === profile.permissionProfileId,
  );
  const listed = profile.expectedPermissionProfiles.filter(
    (entry) => entry?.id === profile.permissionProfileId,
  );
  if (
    configured.length !== 1
    || listed.length !== 1
    || configured[0].extends !== null
    || configured[0].networkEnabled !== false
    || listed[0].allowed !== true
  ) {
    throw new CodexPreflightError(
      'Codex expected permission profile is not uniquely allowed and isolated',
      'CODEX_STATIC_PROFILE_MISMATCH',
    );
  }
}

function paginationCursor(value) {
  if (value == null) return null;
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > 512
  ) {
    throw new CodexPreflightError(
      'Codex preflight pagination cursor was malformed',
      'CODEX_PREFLIGHT_PAGINATION',
    );
  }
  return value;
}

function projectClientFault(value) {
  if (value == null) return null;
  const outcome = plainObject(value, 'client fault outcome');
  const projected = {
    kind: outcome.kind,
    boundary: outcome.boundary,
    containment: outcome.containment,
    cleanup: outcome.cleanup,
    errorCode: outcome.errorCode,
    cleanupErrorCode: outcome.cleanupErrorCode,
    mutationOutcomeUnknown: outcome.mutationOutcomeUnknown,
  };
  if (
    projected.kind !== 'codex-app-server-fault'
    || !['pre-spawn', 'post-spawn'].includes(projected.boundary)
    || !['safe', 'unverified'].includes(projected.containment)
    || !['completed', 'failed'].includes(projected.cleanup)
    || typeof projected.errorCode !== 'string'
    || projected.errorCode.length === 0
    || (
      projected.cleanupErrorCode !== null
      && (
        typeof projected.cleanupErrorCode !== 'string'
        || projected.cleanupErrorCode.length === 0
      )
    )
    || typeof projected.mutationOutcomeUnknown !== 'boolean'
  ) {
    throw new CodexPreflightError(
      'Codex preflight client fault handoff was malformed',
      'CODEX_PREFLIGHT_FAULT_HANDOFF_FAILED',
    );
  }
  return Object.freeze(projected);
}

function clientFaultError(outcome) {
  const error = new CodexPreflightError(
    'Codex preflight app-server generation faulted',
    'CODEX_PREFLIGHT_CLIENT_FAULT',
  );
  error.clientFaultErrorCode = outcome.errorCode;
  error.clientFaultBoundary = outcome.boundary;
  error.clientFaultContainment = outcome.containment;
  error.clientFaultCleanup = outcome.cleanup;
  error.clientFaultCleanupErrorCode = outcome.cleanupErrorCode;
  return error;
}

function annotateFailureWithClientFault(error, outcome) {
  if (!error || !outcome) return;
  try {
    error.preflightClientFaultCode = outcome.errorCode;
    error.preflightClientFaultBoundary = outcome.boundary;
    error.preflightClientFaultContainment = outcome.containment;
  } catch {}
}

async function collectPages(client, method, baseParams, validateEntry) {
  const entries = [];
  const seenCursors = new Set();
  const seenKeys = new Map();
  let cursor;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = cursor === undefined
      ? { ...baseParams }
      : { ...baseParams, cursor };
    const result = plainObject(
      await client.request(method, params),
      `${method} result`,
    );
    if (!Array.isArray(result.data) || result.data.length > PAGE_LIMIT) {
      throw new CodexPreflightError(
        `Codex ${method} page exceeded the bounded result size`,
        'CODEX_PREFLIGHT_PAGINATION',
      );
    }
    for (const rawEntry of result.data) {
      const { value, keys } = validateEntry(rawEntry);
      for (const [kind, key] of Object.entries(keys)) {
        let seen = seenKeys.get(kind);
        if (!seen) {
          seen = new Set();
          seenKeys.set(kind, seen);
        }
        if (seen.has(key)) {
          throw new CodexPreflightError(
            `Codex ${method} returned a duplicate ${kind}`,
            'CODEX_PREFLIGHT_DUPLICATE',
          );
        }
        seen.add(key);
      }
      entries.push(value);
      if (entries.length > MAX_ENTRIES) {
        throw new CodexPreflightError(
          `Codex ${method} catalog exceeded the bounded result size`,
          'CODEX_PREFLIGHT_PAGINATION',
        );
      }
    }
    const nextCursor = paginationCursor(result.nextCursor);
    if (nextCursor === null) return entries;
    if (seenCursors.has(nextCursor)) {
      throw new CodexPreflightError(
        `Codex ${method} pagination cursor repeated`,
        'CODEX_PREFLIGHT_PAGINATION',
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new CodexPreflightError(
    `Codex ${method} exceeded the page limit`,
    'CODEX_PREFLIGHT_PAGINATION',
  );
}

function validatePermissionProfile(value) {
  const profile = plainObject(value, 'permission profile');
  const id = requiredString(profile.id, 'permission profile id');
  if (
    typeof profile.allowed !== 'boolean'
    || (
      profile.descriptionSha256 !== null
      && !SHA256_RE.test(profile.descriptionSha256)
    )
  ) {
    throw new CodexPreflightError(
      'Codex permission profile projection was malformed',
      'CODEX_STATIC_PROFILE_MISMATCH',
    );
  }
  return {
    value: {
      id,
      allowed: profile.allowed,
      descriptionSha256: profile.descriptionSha256,
    },
    keys: { profileId: id },
  };
}

function validateModel(value) {
  const source = plainObject(value, 'model');
  const projected = {
    id: requiredString(source.id, 'model id'),
    model: requiredString(source.model, 'model slug'),
    displayName: requiredString(source.displayName, 'model display name'),
    defaultReasoningEffort: requiredString(
      source.defaultReasoningEffort,
      'model default reasoning effort',
    ),
    supportedReasoningEfforts: cloneBounded(
      source.supportedReasoningEfforts,
      'model reasoning efforts',
    ),
    isDefault: source.isDefault,
  };
  requiredString(source.description, 'model description');
  if (
    source.hidden !== false
    || typeof source.isDefault !== 'boolean'
    || !Array.isArray(projected.supportedReasoningEfforts)
    || projected.supportedReasoningEfforts.length === 0
    || projected.supportedReasoningEfforts.length > 32
  ) {
    throw new CodexPreflightError(
      'Codex model projection was malformed',
      'CODEX_PREFLIGHT_CATALOG',
    );
  }
  const efforts = new Set();
  for (const effort of projected.supportedReasoningEfforts) {
    requiredString(effort, 'model reasoning effort');
    if (efforts.has(effort)) {
      throw new CodexPreflightError(
        'Codex model returned a duplicate reasoning effort',
        'CODEX_PREFLIGHT_DUPLICATE',
      );
    }
    efforts.add(effort);
  }
  if (!efforts.has(projected.defaultReasoningEffort)) {
    throw new CodexPreflightError(
      'Codex model default effort was not supported',
      'CODEX_PREFLIGHT_CATALOG',
    );
  }
  return {
    value: projected,
    keys: {
      modelId: projected.id,
      modelSlug: projected.model,
    },
  };
}

function staticAttestation(profile, configRead, requirements, profiles) {
  const configuredProfile = configRead.config.permissionProfiles.find(
    (entry) => entry.id === profile.permissionProfileId,
  );
  const listedProfile = profiles.find(
    (entry) => entry.id === profile.permissionProfileId,
  );
  const requirementProjection = requirements.requirements;
  const ids = profiles.map((entry) => digest(entry.id)).sort();
  return {
    binarySha256: profile.binarySha256,
    binaryPathSha256: digest(profile.binary),
    ...(profile.sessionLauncher === null ? {} : {
      sessionLauncherPathSha256: digest(profile.sessionLauncher),
      sessionLauncherSha256: profile.sessionLauncherSha256,
    }),
    credentialHomeSha256: digest(profile.codexHome),
    workspaceSha256: digest(profile.cwd),
    allowlistedEnvironmentFingerprint:
      profile.allowlistedEnvironmentFingerprint,
    ownedConfigSha256: profile.ownedConfigSha256,
    effectiveConfigSha256: configRead.config.sha256,
    originsSha256: configRead.originsSha256,
    layerCount: configRead.layers.length,
    layerSetSha256: digest(configRead.layers),
    requirements: requirementProjection === null
      ? null
      : {
          sha256: requirementProjection.sha256,
          keyCount: requirementProjection.keys.length,
          keySetSha256: digest([...requirementProjection.keys].sort()),
        },
    policy: {
      modelProvider: configRead.config.modelProvider,
      defaultPermissionIdSha256: digest(
        configRead.config.defaultPermissions,
      ),
      approvalPolicy: configRead.config.approvalPolicy,
      approvalsReviewer: configRead.config.approvalsReviewer,
      webSearch: configRead.config.webSearch,
      allowLoginShell: configRead.config.allowLoginShell,
      shellEnvironmentInherit:
        configRead.config.shellEnvironmentInherit,
      mcpServerCount: configRead.config.mcpServers.count,
      mcpServerSetSha256: digest(
        configRead.config.mcpServers.keySha256,
      ),
      pluginCount: configRead.config.plugins.count,
      pluginSetSha256: digest(configRead.config.plugins.keySha256),
      modelProviderCount: configRead.config.modelProviders.count,
      modelProviderSetSha256: digest(
        configRead.config.modelProviders.keySha256,
      ),
    },
    permissionProfile: {
      idSha256: digest(profile.permissionProfileId),
      allowed: listedProfile.allowed,
      extendsSha256: configuredProfile.extends === null
        ? null
        : digest(configuredProfile.extends),
      networkEnabled: configuredProfile.networkEnabled,
      filesystemSha256: configuredProfile.filesystemSha256,
      filesystemRuleCount: configuredProfile.filesystem.length,
      filesystemRuleSetSha256: digest(configuredProfile.filesystem),
      descriptionSha256: listedProfile.descriptionSha256,
    },
    permissionProfileCatalog: {
      count: profiles.length,
      allowedCount: profiles.filter((entry) => entry.allowed).length,
      idSetSha256: digest(ids),
    },
  };
}

function receiptInvalid(message) {
  return new CodexPreflightError(
    `Codex preflight receipt was invalid: ${message}`,
    'CODEX_PREFLIGHT_RECEIPT_INVALID',
  );
}

function createCodexSpawnProfile(expectedStaticProfile, preflightResult) {
  const profile = deepFreeze(normalizeExpectedProfile(expectedStaticProfile));
  let result;
  try {
    result = plainObject(preflightResult, 'result');
  } catch (error) {
    throw receiptInvalid(error.message);
  }
  for (const key of Object.keys(result)) {
    if (!PREFLIGHT_RESULT_KEYS.has(key)) {
      throw new TypeError(
        `Codex preflight unexpected preflight result field: ${key}`,
      );
    }
  }
  for (const key of PREFLIGHT_RESULT_KEYS) {
    if (!Object.hasOwn(result, key)) {
      throw new TypeError(`Codex preflight missing preflight result field: ${key}`);
    }
  }
  if (!isDeepFrozenPlainData(result)) {
    throw receiptInvalid('result must be deeply frozen plain data');
  }
  if (
    result.runtime !== 'codex'
    || result.runtimeVersion !== profile.cliVersion
    || result.schemaVersion !== profile.protocolSchemaSha256
    || !SHA256_RE.test(result.spawnProfileId)
  ) {
    throw receiptInvalid('runtime identity did not match the static profile');
  }
  let auth;
  let selected;
  try {
    auth = plainObject(result.auth, 'result auth');
    selected = plainObject(result.selected, 'result selection');
  } catch (error) {
    throw receiptInvalid(error.message);
  }
  if (
    auth.authenticated !== true
    || auth.accountType !== 'chatgpt'
    || typeof auth.requiresOpenaiAuth !== 'boolean'
    || selected.model !== profile.model
    || selected.effort !== profile.effort
    || !Array.isArray(result.models)
    || !Array.isArray(result.efforts)
  ) {
    throw receiptInvalid('authenticated model selection did not match');
  }
  const selectedModels = result.models.filter(
    (entry) => entry?.model === profile.model,
  );
  if (
    selectedModels.length !== 1
    || !Array.isArray(selectedModels[0].supportedReasoningEfforts)
    || !selectedModels[0].supportedReasoningEfforts.includes(profile.effort)
    || JSON.stringify(result.efforts)
      !== JSON.stringify(selectedModels[0].supportedReasoningEfforts)
  ) {
    throw receiptInvalid('selected model catalog entry did not match');
  }

  const expectedAttestation = staticAttestation(
    profile,
    {
      config: profile.expectedConfig,
      layers: profile.expectedLayers,
      originsSha256: profile.expectedOriginsSha256,
    },
    { requirements: profile.expectedRequirements },
    profile.expectedPermissionProfiles,
  );
  if (
    JSON.stringify(canonical(result.attestation))
    !== JSON.stringify(canonical(expectedAttestation))
  ) {
    throw receiptInvalid('static attestation did not match');
  }
  const expectedSpawnProfileId = digest({
    runtime: 'codex',
    runtimeVersion: profile.cliVersion,
    schemaVersion: profile.protocolSchemaSha256,
    attestation: expectedAttestation,
    accountType: 'chatgpt',
  });
  if (result.spawnProfileId !== expectedSpawnProfileId) {
    throw receiptInvalid('spawn-profile identity did not match');
  }
  if (!SUCCESSFUL_PREFLIGHT_RESULTS.has(result)) {
    throw receiptInvalid(
      'result was not produced by a successful preflight',
    );
  }

  const receipt = deepFreeze({
    runtime: 'codex',
    spawnProfileId: expectedSpawnProfileId,
    expectedStaticProfile: profile,
    modelCatalog: result.models,
  });
  SPAWN_PROFILE_RECEIPTS.add(receipt);
  return receipt;
}

function assertCodexSpawnProfile(receipt) {
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || !SPAWN_PROFILE_RECEIPTS.has(receipt)
    || !isDeepFrozenPlainData(receipt)
    || Object.keys(receipt).length !== SPAWN_PROFILE_KEYS.size
    || Object.keys(receipt).some((key) => !SPAWN_PROFILE_KEYS.has(key))
  ) {
    throw receiptInvalid(
      'factory requires an intact createCodexSpawnProfile receipt',
    );
  }
  return receipt;
}

async function readAndAssertStaticPolicy(profile, client) {
  const configRead = await client.request('config/read', {
    cwd: profile.cwd,
    includeLayers: true,
  });
  const requirements = await client.request(
    'configRequirements/read',
    undefined,
  );
  const permissionProfiles = await collectPages(
    client,
    'permissionProfile/list',
    { cwd: profile.cwd },
    validatePermissionProfile,
  );
  permissionProfiles.sort((left, right) => left.id.localeCompare(right.id));

  exact(configRead?.config, profile.expectedConfig, 'effective config');
  exact(configRead?.layers, profile.expectedLayers, 'config layers');
  exact(
    configRead?.originsSha256,
    profile.expectedOriginsSha256,
    'config origins',
  );
  exact(
    requirements?.requirements,
    profile.expectedRequirements,
    'config requirements',
  );
  exact(
    permissionProfiles,
    profile.expectedPermissionProfiles,
    'permission profile catalog',
  );
  return { configRead, requirements, permissionProfiles };
}

async function reattestCodexStaticPolicy(expectedStaticProfile, client) {
  if (!client || typeof client.request !== 'function') {
    throw new TypeError(
      'Codex static policy reattestation requires a live app-server client',
    );
  }
  const profile = normalizeExpectedProfile(expectedStaticProfile);
  await readAndAssertStaticPolicy(profile, client);
}

async function runPreflight(profile, client) {
  await client.start();
  const {
    configRead,
    requirements,
    permissionProfiles,
  } = await readAndAssertStaticPolicy(profile, client);

  const account = plainObject(
    await client.request('account/read', { refreshToken: false }),
    'account result',
  );
  if (account.account?.type !== 'chatgpt') {
    throw new CodexPreflightError(
      'Codex ChatGPT authentication is unavailable',
      'CODEX_AUTH_UNAVAILABLE',
    );
  }
  if (typeof account.requiresOpenaiAuth !== 'boolean') {
    throw new CodexPreflightError(
      'Codex authentication projection was malformed',
      'CODEX_AUTH_UNAVAILABLE',
    );
  }

  const models = await collectPages(
    client,
    'model/list',
    { includeHidden: false, limit: PAGE_LIMIT },
    validateModel,
  );
  models.sort((left, right) => (
    left.model.localeCompare(right.model)
    || left.id.localeCompare(right.id)
  ));
  const selected = models.find((entry) => entry.model === profile.model);
  if (!selected) {
    throw new CodexPreflightError(
      'Requested Codex model is unavailable',
      'CODEX_MODEL_UNAVAILABLE',
    );
  }
  if (!selected.supportedReasoningEfforts.includes(profile.effort)) {
    throw new CodexPreflightError(
      'Requested Codex reasoning effort is unavailable',
      'CODEX_EFFORT_UNAVAILABLE',
    );
  }

  const attestation = staticAttestation(
    profile,
    configRead,
    requirements,
    permissionProfiles,
  );
  const spawnProfileId = digest({
    runtime: 'codex',
    runtimeVersion: profile.cliVersion,
    schemaVersion: profile.protocolSchemaSha256,
    attestation,
    accountType: account.account.type,
  });
  return deepFreeze({
    runtime: 'codex',
    runtimeVersion: profile.cliVersion,
    schemaVersion: profile.protocolSchemaSha256,
    spawnProfileId,
    auth: {
      authenticated: true,
      accountType: account.account.type,
      requiresOpenaiAuth: account.requiresOpenaiAuth,
    },
    attestation,
    models,
    efforts: [...selected.supportedReasoningEfforts],
    selected: {
      model: selected.model,
      effort: profile.effort,
    },
  });
}

async function preflightCodexRuntime(
  expectedStaticProfile,
  {
    clientFactory = (options) => new CodexAppServerClient(options),
  } = {},
) {
  if (typeof clientFactory !== 'function') {
    throw new TypeError('Codex preflight clientFactory must be a function');
  }
  const profile = normalizeExpectedProfile(expectedStaticProfile);
  let latchedFault = null;
  const client = clientFactory({
    binary: profile.binary,
    sessionLauncher: profile.sessionLauncher,
    expectedSessionLauncherSha256: profile.sessionLauncherSha256,
    cwd: profile.cwd,
    codexHome: profile.codexHome,
    env: profile.env,
    expectedConfigSha256: profile.ownedConfigSha256,
    onNotification: async () => {
      throw new CodexPreflightError(
        'Codex preflight received an unexpected state notification',
        'CODEX_PREFLIGHT_UNEXPECTED_NOTIFICATION',
      );
    },
    onFault: (outcome) => {
      outcome?.assertActive?.();
      latchedFault = projectClientFault(outcome);
    },
  });
  if (
    !client
    || typeof client.start !== 'function'
    || typeof client.request !== 'function'
    || typeof client.close !== 'function'
    || typeof client.waitForFault !== 'function'
  ) {
    throw new TypeError('Codex preflight clientFactory returned an invalid client');
  }

  let result;
  let failure = null;
  try {
    result = await runPreflight(profile, client);
  } catch (error) {
    failure = error;
  }
  if (!failure) {
    await new Promise((resolve) => setTimeout(resolve, POST_READ_SETTLE_MS));
  }

  try {
    await client.close();
  } catch (error) {
    const closeFailure = new CodexPreflightError(
      'Codex preflight client cleanup failed',
      'CODEX_PREFLIGHT_CLOSE_FAILED',
      { cause: error },
    );
    closeFailure.preflightErrorCode = failure?.code ?? null;
    closeFailure.cleanupErrorCode = error?.code ?? null;
    throw closeFailure;
  }

  let terminalFault;
  try {
    terminalFault = projectClientFault(await client.waitForFault());
  } catch (error) {
    if (failure) {
      try {
        failure.preflightFaultHandoffErrorCode = error?.code ?? null;
      } catch {}
      throw failure;
    }
    if (
      error instanceof CodexPreflightError
      && error.code === 'CODEX_PREFLIGHT_FAULT_HANDOFF_FAILED'
    ) {
      throw error;
    }
    throw new CodexPreflightError(
      'Codex preflight client fault handoff failed',
      'CODEX_PREFLIGHT_FAULT_HANDOFF_FAILED',
      { cause: error },
    );
  }
  if (
    latchedFault
    && terminalFault
    && JSON.stringify(latchedFault) !== JSON.stringify(terminalFault)
  ) {
    const mismatch = new CodexPreflightError(
      'Codex preflight client fault handoff was inconsistent',
      'CODEX_PREFLIGHT_FAULT_HANDOFF_FAILED',
    );
    if (failure) {
      try {
        failure.preflightFaultHandoffErrorCode = mismatch.code;
      } catch {}
      throw failure;
    }
    throw mismatch;
  }
  const observedFault = latchedFault ?? terminalFault;
  if (failure) {
    annotateFailureWithClientFault(failure, observedFault);
    throw failure;
  }
  if (observedFault) throw clientFaultError(observedFault);
  SUCCESSFUL_PREFLIGHT_RESULTS.add(result);
  return result;
}

module.exports = {
  assertCodexSpawnProfile,
  CodexPreflightError,
  createCodexSpawnProfile,
  preflightCodexRuntime,
  reattestCodexStaticPolicy,
};
