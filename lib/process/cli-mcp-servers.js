/**
 * Configured MCP servers for the CLI backend.
 *
 * The CLI backend runs claude with --strict-mcp-config, so the only MCP
 * servers a session gets are the ones in the mcp-config file CliProcess
 * writes. A consumer may name extra servers per chat or topic
 * (`mcpServers`, in Claude's own shape); this module decides which of them
 * are written next to the channels bridge.
 *
 * Rules:
 *   - Validation is strict: only known fields per server type. A bad entry
 *     is skipped, never fatal, so one typo cannot take a topic offline.
 *     (Claude CLI 2.1.322 drops bad entries silently; checking here makes
 *     the skip visible and does not depend on the CLI staying lenient.)
 *   - The bridge name is reserved, and buildMcpConfig assigns the bridge
 *     last as well as first, so no entry can replace it.
 *   - Skip records carry a name and a fixed reason code, never a server
 *     definition: definitions may hold secrets (headers, env).
 *
 * See docs/CLI_MCP_SERVERS_SPEC.md.
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// Claude's MCP server name rule; the name becomes the mcp__<name>__ prefix.
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const REMOTE_FIELDS = new Set(['type', 'url', 'headers', 'oauth', 'timeout']);
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'timeout']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;
}

function isStringMap(v) {
  return isPlainObject(v) && Object.values(v).every(x => typeof x === 'string');
}

function onlyFields(def, allowed) {
  return Object.keys(def).every(k => allowed.has(k));
}

function validTimeout(def) {
  return def.timeout === undefined
    || (typeof def.timeout === 'number' && Number.isFinite(def.timeout) && def.timeout > 0);
}

function isRemoteUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const { protocol } = new URL(u);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function isValidDefinition(def) {
  if (!isPlainObject(def)) return false;
  if (!validTimeout(def)) return false;
  if (def.type === 'http' || def.type === 'sse') {
    return onlyFields(def, REMOTE_FIELDS)
      && isRemoteUrl(def.url)
      && (def.headers === undefined || isStringMap(def.headers))
      && (def.oauth === undefined || isPlainObject(def.oauth));
  }
  if (def.type === undefined || def.type === 'stdio') {
    return onlyFields(def, STDIO_FIELDS)
      && typeof def.command === 'string' && def.command.length > 0
      && (def.args === undefined
        || (Array.isArray(def.args) && def.args.every(a => typeof a === 'string')))
      && (def.env === undefined || isStringMap(def.env));
  }
  return false;
}

/**
 * @param {object} opts
 * @param {*} opts.value — the resolved `mcpServers` config value
 * @param {string} opts.reservedName — the channels bridge's server name
 * @returns {{ servers: object, skipped: Array<{name: ?string, reason: string}> }}
 */
function resolveConfiguredMcpServers({ value, reservedName }) {
  if (value === undefined || value === null) return { servers: {}, skipped: [] };
  if (!isPlainObject(value)) {
    return { servers: {}, skipped: [{ name: null, reason: 'not-an-object' }] };
  }
  const servers = {};
  const skipped = [];
  for (const [name, def] of Object.entries(value)) {
    if (!SERVER_NAME_RE.test(name)) {
      skipped.push({ name, reason: 'invalid-name' });
    } else if (name === reservedName) {
      skipped.push({ name, reason: 'reserved-name' });
    } else if (!isValidDefinition(def)) {
      skipped.push({ name, reason: 'invalid-definition' });
    } else {
      servers[name] = def;
    }
  }
  return { servers, skipped };
}

/**
 * The mcp-config file body. The bridge key comes first so claude starts it
 * first, and is assigned again after the configured servers so a same-named
 * entry can never replace it, even if validation were bypassed.
 */
function buildMcpConfig({ bridgeName, bridgeDef, servers }) {
  return {
    mcpServers: { [bridgeName]: bridgeDef, ...servers, [bridgeName]: bridgeDef },
  };
}

/**
 * A server without a usable OAuth token exposes mcp__<name>__authenticate and
 * mcp__<name>__complete_authentication in the interactive CLI. A bot session
 * must never start an OAuth flow (an operator logs in interactively), so both
 * are denied for every configured server. Returns one comma-joined value for
 * --disallowedTools, or null when there is nothing to deny.
 */
function authToolDenyList(servers) {
  const names = Object.keys(servers || {});
  if (names.length === 0) return null;
  return names
    .flatMap(n => [`mcp__${n}__authenticate`, `mcp__${n}__complete_authentication`])
    .join(',');
}

function socketAccepts(sockPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Boot-time removal of mcp-config files left by sessions whose daemon died
 * (a clean teardown removes its own file). They hold the bridge socket secret
 * and any configured server's headers. A file stays while its session socket
 * accepts connections: under one Linux user, several daemons may share the
 * prefix and the directory.
 *
 * @param {object} opts
 * @param {string} opts.sessionPrefix — e.g. 'polygram'
 * @param {string} [opts.dir=os.tmpdir()]
 * @param {object} [opts.logger=console]
 * @returns {Promise<{ removed: string[], errors: Array<{file: string, error: string}> }>}
 */
async function sweepStaleMcpConfigs({ sessionPrefix, dir = os.tmpdir(), logger = console } = {}) {
  if (typeof sessionPrefix !== 'string' || sessionPrefix.length === 0) {
    throw new TypeError('sweepStaleMcpConfigs: sessionPrefix required');
  }
  const escaped = sessionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}-([0-9a-f]{32})-mcp\\.json$`);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removed: [], errors: [] };
  }
  const removed = [];
  const errors = [];
  for (const file of entries) {
    const m = re.exec(file);
    if (!m) continue;
    const sockPath = path.join(dir, `${sessionPrefix}-${m[1]}.sock`);
    if (fs.existsSync(sockPath) && await socketAccepts(sockPath)) continue;
    try {
      fs.unlinkSync(path.join(dir, file));
      removed.push(file);
    } catch (err) {
      errors.push({ file, error: err.message });
      logger.warn?.(`[mcp-config-sweep] remove ${file} failed: ${err.message}`);
    }
  }
  if (removed.length > 0) {
    logger.log?.(`[mcp-config-sweep] removed ${removed.length} stale mcp-config file(s)`);
  }
  return { removed, errors };
}

module.exports = {
  resolveConfiguredMcpServers,
  buildMcpConfig,
  authToolDenyList,
  sweepStaleMcpConfigs,
};
