import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, 'servers.example.json');
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const DEFAULT_PORT = Number.parseInt(process.env.MCP_GATEWAY_PORT || '8788', 10);
const clientCache = new Map();
const serverState = new Map();
let cachedConfig = null;
let cachedConfigPath = '';

function json(status, body, headers = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function send(res, payload) {
  res.writeHead(payload.status, payload.headers);
  res.end(payload.body);
}

function resolveValue(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] || '');
  }
  if (Array.isArray(value)) {
    return value.map(resolveValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolveValue(inner)]));
  }
  return value;
}

async function loadConfig() {
  const configPath = resolve(process.env.MCP_GATEWAY_CONFIG || DEFAULT_CONFIG_PATH);
  if (cachedConfig && cachedConfigPath === configPath) return cachedConfig;

  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const servers = resolveValue(parsed.servers || {});
  cachedConfig = { servers };
  cachedConfigPath = configPath;
  return cachedConfig;
}

function ensureAuthorized(req) {
  const authToken = process.env.MCP_GATEWAY_TOKEN || '';
  if (!authToken) {
    // No token configured — reject all requests instead of silently allowing
    console.error('[mcp-gateway] MCP_GATEWAY_TOKEN not set — rejecting request');
    return false;
  }
  const header = req.headers.authorization || '';
  return header === `Bearer ${authToken}`;
}

const MAX_BODY_SIZE = 1_000_000; // 1MB — prevents memory exhaustion from oversized payloads

async function readJson(req) {
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalSize += buf.length;
    if (totalSize > MAX_BODY_SIZE) {
      req.destroy();
      throw Object.assign(new Error('Payload too large'), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  return JSON.parse(body);
}

function getToolTimeoutMs(body) {
  const value = Number.parseInt(String(body.timeoutMs || process.env.MCP_GATEWAY_TOOL_TIMEOUT_MS || DEFAULT_TOOL_TIMEOUT_MS), 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.min(value, 60_000);
}

function updateServerState(alias, patch) {
  const previous = serverState.get(alias) || {
    status: 'idle',
    consecutiveFailures: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastError: '',
    lastDurationMs: 0,
  };
  const next = { ...previous, ...patch };
  serverState.set(alias, next);
  return next;
}

async function createTransport(alias, serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') {
    throw new Error(`Unknown MCP server: ${alias}`);
  }

  if (serverConfig.transport === 'streamable-http') {
    const headers = serverConfig.headers || {};
    return new StreamableHTTPClientTransport(new URL(serverConfig.url), {
      requestInit: { headers },
    });
  }

  if (serverConfig.transport === 'sse') {
    const headers = serverConfig.headers || {};
    return new SSEClientTransport(new URL(serverConfig.url), {
      requestInit: { headers },
    });
  }

  if (serverConfig.transport === 'stdio') {
    return new StdioClientTransport({
      command: serverConfig.command,
      args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
      cwd: serverConfig.cwd || undefined,
      env: serverConfig.env || undefined,
      stderr: serverConfig.stderr || 'pipe',
    });
  }

  throw new Error(`Unsupported MCP transport for ${alias}: ${serverConfig.transport}`);
}

async function getClientEntry(alias) {
  const config = await loadConfig();
  const serverConfig = config.servers[alias];
  if (!serverConfig) {
    throw new Error(`Unknown MCP server: ${alias}`);
  }

  const existing = clientCache.get(alias);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const client = new Client({
    name: 'worldmonitor-mcp-gateway',
    version: '1.0.0',
  });

  const transport = await createTransport(alias, serverConfig);
  await client.connect(transport);

  const entry = {
    alias,
    client,
    transport,
    config: serverConfig,
    connectedAt: Date.now(),
    lastUsedAt: Date.now(),
    toolCache: null,
  };
  clientCache.set(alias, entry);
  updateServerState(alias, {
    status: 'ok',
    lastSuccessAt: Date.now(),
    lastError: '',
  });
  return entry;
}

async function closeClient(alias) {
  const entry = clientCache.get(alias);
  if (!entry) return;
  clientCache.delete(alias);

  try {
    await entry.transport.close();
  } catch {
    // ignore close errors
  }
}

async function listTools(alias) {
  const entry = await getClientEntry(alias);
  if (entry.toolCache) {
    entry.lastUsedAt = Date.now();
    return entry.toolCache;
  }

  const result = await entry.client.listTools();
  entry.lastUsedAt = Date.now();
  entry.toolCache = result.tools || [];
  return entry.toolCache;
}

function serializeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || 'unknown_error');
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try {
          await onTimeout?.();
        } finally {
          reject(new Error(`timeout_after_${timeoutMs}ms`));
        }
      }, timeoutMs);
    }),
  ]);
}

async function handleInvoke(body) {
  const alias = String(body.server || '').trim();
  const tool = String(body.tool || '').trim();
  const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
  const timeoutMs = getToolTimeoutMs(body);

  if (!alias || !tool) {
    return json(400, { ok: false, error: 'server and tool are required' });
  }

  const startedAt = Date.now();

  try {
    const entry = await getClientEntry(alias);
    const result = await withTimeout(
      entry.client.callTool({ name: tool, arguments: args }),
      timeoutMs,
      async () => {
        await closeClient(alias);
      },
    );

    entry.lastUsedAt = Date.now();
    updateServerState(alias, {
      status: result?.isError ? 'degraded' : 'ok',
      lastSuccessAt: Date.now(),
      consecutiveFailures: 0,
      lastError: result?.isError ? 'tool_error' : '',
      lastDurationMs: Date.now() - startedAt,
    });

    return json(200, {
      ok: true,
      server: alias,
      tool,
      durationMs: Date.now() - startedAt,
      result,
    });
  } catch (error) {
    updateServerState(alias, {
      status: 'failed',
      lastFailureAt: Date.now(),
      consecutiveFailures: (serverState.get(alias)?.consecutiveFailures || 0) + 1,
      lastError: serializeError(error),
      lastDurationMs: Date.now() - startedAt,
    });

    return json(502, {
      ok: false,
      server: alias,
      tool,
      error: serializeError(error),
      durationMs: Date.now() - startedAt,
    });
  }
}

async function handleCatalog() {
  const config = await loadConfig();
  const catalog = [];
  for (const alias of Object.keys(config.servers)) {
    try {
      const tools = await listTools(alias);
      catalog.push({
        server: alias,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description || '',
          title: tool.title || '',
        })),
      });
      updateServerState(alias, {
        status: 'ok',
        lastSuccessAt: Date.now(),
        lastError: '',
      });
    } catch (error) {
      updateServerState(alias, {
        status: 'failed',
        lastFailureAt: Date.now(),
        consecutiveFailures: (serverState.get(alias)?.consecutiveFailures || 0) + 1,
        lastError: serializeError(error),
      });
      catalog.push({
        server: alias,
        error: serializeError(error),
        tools: [],
      });
    }
  }

  return json(200, { ok: true, servers: catalog });
}

async function handleHealth() {
  const config = await loadConfig();
  const health = {};
  for (const alias of Object.keys(config.servers)) {
    health[alias] = {
      transport: config.servers[alias].transport,
      ...(serverState.get(alias) || { status: 'idle' }),
    };
  }
  return json(200, { ok: true, servers: health });
}

async function route(req, res) {
  if (!ensureAuthorized(req)) {
    send(res, json(401, { ok: false, error: 'unauthorized' }));
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, await handleHealth());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/tools') {
      send(res, await handleCatalog());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/tools/invoke') {
      const body = await readJson(req);
      send(res, await handleInvoke(body));
      return;
    }

    send(res, json(404, { ok: false, error: 'not_found' }));
  } catch (error) {
    if (error.statusCode === 413) {
      send(res, json(413, { ok: false, error: 'payload_too_large' }));
      return;
    }
    send(res, json(500, { ok: false, error: serializeError(error) }));
  }
}

function startIdleReaper() {
  const interval = setInterval(async () => {
    const cutoff = Date.now() - DEFAULT_IDLE_TTL_MS;
    const aliases = [...clientCache.keys()];
    for (const alias of aliases) {
      const entry = clientCache.get(alias);
      if (!entry) continue;
      if (entry.lastUsedAt < cutoff) {
        await closeClient(alias);
        updateServerState(alias, { status: 'idle' });
      }
    }
  }, 60_000);
  interval.unref?.();
}

async function startServer({ port = DEFAULT_PORT } = {}) {
  if (!process.env.MCP_GATEWAY_TOKEN) {
    console.warn('[mcp-gateway] WARNING: MCP_GATEWAY_TOKEN not set — all requests will be rejected');
  }
  await loadConfig();
  startIdleReaper();

  const server = http.createServer((req, res) => {
    void route(req, res);
  });

  await new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => resolvePromise());
  });

  const actualPort = server.address()?.port || port;
  console.log(`[mcp-gateway] Listening on http://127.0.0.1:${actualPort}`);

  return {
    server,
    port: actualPort,
    async close() {
      const aliases = [...clientCache.keys()];
      await Promise.allSettled(aliases.map((alias) => closeClient(alias)));
      await new Promise((resolvePromise, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolvePromise();
        });
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('[mcp-gateway] Failed to start:', error);
    process.exit(1);
  });
}

export { startServer, loadConfig };
