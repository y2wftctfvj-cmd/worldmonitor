import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runTool } from '../api/_tools/monitor-tools.js';

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

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    },
  };
}

describe('monitor-tools MCP integration', { concurrency: 1, timeout: 15000 }, () => {
  it('appends MCP archive context to Reddit tool responses when available', async () => {
    const restoreEnv = withEnv({
      MCP_GATEWAY_URL: 'https://mcp.test',
      MCP_GATEWAY_TOKEN: 'secret',
      MCP_ENABLED_TOOLS: 'reddit_search,reddit_historical_search',
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init = {}) => {
      const raw = String(url);
      if (raw.includes('reddit.com/r/') && raw.includes('/search.json')) {
        return jsonResponse({
          data: {
            children: [
              { data: { title: 'Iran discussion on Reddit', score: 120 } },
            ],
          },
        });
      }

      if (raw === 'https://mcp.test/v1/tools/invoke') {
        const body = JSON.parse(String(init.body));
        if (body.tool === 'reddit_search') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                result: {
                  structuredContent: {
                    results: [{
                      title: 'Archive Reddit thread',
                      subreddit: 'worldnews',
                      score: 230,
                      url: 'https://reddit.com/archive',
                      created_utc: 1700000000,
                    }],
                  },
                },
              };
            },
          };
        }

        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              result: {
                structuredContent: {
                  data: [{
                    title: 'Older archive mention',
                    subreddit: 'geopolitics',
                    score: 90,
                    url: 'https://reddit.com/historical',
                    created_utc: 1680000000,
                  }],
                },
              },
            };
          },
        };
      }

      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const output = await runTool('search_reddit', { query: 'iran' });
      assert.match(output, /Iran discussion on Reddit/);
      assert.match(output, /\*REDDIT ARCHIVE: iran\*/);
      assert.match(output, /Archive Reddit thread/);
      assert.match(output, /Older archive mention/);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('search_sanctions invokes MCP and formats OFAC results', async () => {
    const restoreEnv = withEnv({
      MCP_GATEWAY_URL: 'https://mcp.test',
      MCP_GATEWAY_TOKEN: 'secret',
      MCP_ENABLED_TOOLS: 'sanctions_search',
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init = {}) => {
      const raw = String(url);
      if (raw === 'https://mcp.test/v1/tools/invoke') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              result: {
                structuredContent: {
                  results: [{
                    name: 'TEST SANCTIONS ENTITY',
                    type: 'Individual',
                    program: 'SDGT',
                    aliases: ['TSE'],
                    id: '99999',
                  }],
                },
              },
            };
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const output = await runTool('search_sanctions', { query: 'test entity' });
      assert.match(output, /OFAC SDN MATCHES/);
      assert.match(output, /TEST SANCTIONS ENTITY/);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('search_predictions_market combines live and MCP data', async () => {
    const restoreEnv = withEnv({
      MCP_GATEWAY_URL: 'https://mcp.test',
      MCP_GATEWAY_TOKEN: 'secret',
      MCP_ENABLED_TOOLS: 'predictions_search',
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init = {}) => {
      const raw = String(url);
      // Live Polymarket search
      if (raw.includes('gamma-api.polymarket.com')) {
        return jsonResponse([{
          title: 'Will Iran reach nuclear deal?',
          markets: [{
            outcomePrices: '[0.25, 0.75]',
            volume: '80000',
            groupItemTitle: 'Yes',
          }],
          endDate: '2027-01-01',
          slug: 'iran-nuclear',
        }]);
      }
      // MCP predictions search
      if (raw === 'https://mcp.test/v1/tools/invoke') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              result: {
                structuredContent: {
                  markets: [{
                    title: 'MCP enriched prediction',
                    probability: 30,
                    volume: 50000,
                    outcomes: ['Yes', 'No'],
                    url: 'https://polymarket.com/test',
                  }],
                },
              },
            };
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const output = await runTool('search_predictions_market', { query: 'iran' });
      assert.match(output, /Iran reach nuclear deal/);
      assert.match(output, /PREDICTION MARKETS/);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});
