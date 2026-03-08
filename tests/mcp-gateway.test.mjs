import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { startServer } from '../mcp-gateway/server.mjs';

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('mcp-gateway', { concurrency: 1 }, () => {
  let gateway;
  let tempDir;
  let restoreEnv;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wm-mcp-gateway-'));
    const configPath = join(tempDir, 'servers.json');
    const fixturePath = resolve('tests/fixtures/mcp-echo-server.mjs');

    writeFileSync(configPath, JSON.stringify({
      servers: {
        echo: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixturePath],
        },
      },
    }, null, 2));

    restoreEnv = withEnv({
      MCP_GATEWAY_CONFIG: configPath,
      MCP_GATEWAY_TOKEN: 'secret',
    });

    gateway = await startServer({ port: 0 });
  });

  after(async () => {
    await gateway?.close();
    restoreEnv?.();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists configured tools from a stdio MCP server', async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/tools`, {
      headers: { Authorization: 'Bearer secret' },
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.servers[0].server, 'echo');
    assert.equal(payload.servers[0].tools[0].name, 'echo_tool');
  });

  it('invokes a stdio-backed MCP tool over HTTP', async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/tools/invoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        server: 'echo',
        tool: 'echo_tool',
        arguments: { query: 'worldmonitor' },
        timeoutMs: 2000,
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.structuredContent.results[0].title, 'Echo worldmonitor');
  });

  it('requires bearer auth when a gateway token is configured', async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.error, 'unauthorized');
  });
});
