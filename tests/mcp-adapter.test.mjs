import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  enrichCandidatesWithMcp,
  formatMcpObservationSection,
  invokeMcpTool,
} from '../api/_tools/mcp-adapter.js';

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

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

describe('mcp-adapter', { concurrency: 1 }, () => {
  it('normalizes successful Reddit MCP responses into canonical records', async () => {
    const restoreEnv = withEnv({
      MCP_GATEWAY_URL: 'https://mcp.test',
      MCP_GATEWAY_TOKEN: 'secret',
      MCP_ENABLED_TOOLS: 'reddit_search',
      MCP_TIMEOUT_MS: '1200',
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://mcp.test/v1/tools/invoke');
      return jsonResponse({
        ok: true,
        result: {
          structuredContent: {
            results: [
              {
                title: 'Iran strike update',
                selftext: 'Additional details from local witnesses.',
                subreddit: 'geopolitics',
                score: 210,
                num_comments: 45,
                author: 'analyst',
                url: 'https://reddit.com/r/geopolitics/post',
                created_utc: 1700000000,
              },
            ],
          },
        },
      });
    };

    try {
      const result = await invokeMcpTool('reddit_search', { query: 'iran' });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'ok');
      assert.equal(result.observations.length, 1);
      assert.equal(result.observations[0].sourceId, 'reddit:geopolitics');
      assert.equal(result.observations[0].meta.origin, 'mcp');
      assert.equal(result.assessment.status, 'ok');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('treats gateway auth failures as degraded without throwing', async () => {
    const restoreEnv = withEnv({
      MCP_GATEWAY_URL: 'https://mcp.test',
      MCP_GATEWAY_TOKEN: 'secret',
      MCP_ENABLED_TOOLS: 'news_gdelt_search',
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      async text() {
        return 'unauthorized';
      },
    });

    try {
      const result = await invokeMcpTool('news_gdelt_search', { query: 'iran' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'degraded');
      assert.equal(result.reason, 'auth_failed');
      assert.equal(result.assessment.reason, 'auth_failed');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('short-circuits when the Redis-backed circuit breaker is open', async () => {
    const restoreEnv = withEnv({
      MCP_GATEWAY_URL: 'https://mcp.test',
      MCP_GATEWAY_TOKEN: 'secret',
      MCP_ENABLED_TOOLS: 'news_gdelt_search',
    });
    const originalFetch = globalThis.fetch;
    let gatewayCalls = 0;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.startsWith('https://redis.test/get/')) {
        return jsonResponse({
          result: JSON.stringify({ failures: 3, openedUntil: Date.now() + 60_000, lastError: 'timeout' }),
        });
      }
      gatewayCalls += 1;
      throw new Error(`gateway should not be called when the breaker is open: ${raw}`);
    };

    try {
      const result = await invokeMcpTool('news_gdelt_search', { query: 'iran' }, {
        redisUrl: 'https://redis.test',
        redisToken: 'token',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'circuit_open');
      assert.equal(gatewayCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('enriches promoted candidates without changing their native trust gate state', async () => {
    const restoreEnv = withEnv({
      MCP_GATEWAY_URL: 'https://mcp.test',
      MCP_GATEWAY_TOKEN: 'secret',
      MCP_ENABLED_TOOLS: 'reddit_search,reddit_historical_search,news_gdelt_search',
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init.body));
      if (body.tool === 'reddit_search') {
        return jsonResponse({
          ok: true,
          result: {
            structuredContent: {
              results: [{
                title: 'Iran thread on r/worldnews',
                subreddit: 'worldnews',
                score: 300,
                num_comments: 60,
                url: 'https://reddit.com/r/worldnews/post',
                created_utc: 1700000100,
              }],
            },
          },
        });
      }
      if (body.tool === 'reddit_historical_search') {
        return jsonResponse({
          ok: true,
          result: {
            structuredContent: {
              data: [{
                title: 'Historical Iran mention',
                subreddit: 'geopolitics',
                score: 75,
                url: 'https://reddit.com/r/geopolitics/post',
                created_utc: 1680000000,
              }],
            },
          },
        });
      }
      if (body.tool === 'news_gdelt_search') {
        return jsonResponse({
          ok: true,
          result: {
            structuredContent: {
              articles: [{
                title: 'Reuters follow-up on Iran',
                domain: 'reuters.com',
                url: 'https://reuters.com/test',
                seendate: '20260307T120000Z',
              }],
            },
          },
        });
      }
      throw new Error(`Unexpected tool call: ${body.tool}`);
    };

    const sourceProfile = { passesTrustGate: true, strongSourceCount: 1, verifiedSourceCount: 2 };
    const candidate = {
      clusterId: 'iran+israel',
      entities: ['Iran', 'Israel'],
      severity: 'urgent',
      confidence: 72,
      sourceProfile,
      scoreBreakdown: {
        reliability: 40,
        corroboration: 20,
        recency: 10,
        crossDomain: 10,
        novelty: 4,
        surge: 0,
        contradiction: 0,
      },
      records: [{
        id: 'govFeeds:1',
        sourceId: 'govFeeds',
        sourceType: 'wire',
        text: '[Reuters] Iran confirms explosions near Isfahan',
        entities: ['iran', 'israel'],
        timestamp: new Date().toISOString(),
        meta: { feedSource: 'Reuters', link: 'https://reuters.com/base' },
      }],
    };

    try {
      const result = await enrichCandidatesWithMcp([candidate], { timeoutMs: 1200 });
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].severity, 'urgent');
      assert.equal(result.candidates[0].sourceProfile, sourceProfile);
      assert.ok(result.candidates[0].records.length > candidate.records.length);
      assert.equal(result.sourceAssessments['mcp:reddit'].status, 'ok');
      assert.equal(result.sourceAssessments['mcp:news'].status, 'ok');
      assert.ok(result.highlights.length >= 1);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('formats MCP observation sections for Telegram-safe output', () => {
    const section = formatMcpObservationSection('MCP TEST', [{
      sourceId: 'mcpNews',
      text: '[reuters.com] Example story',
      timestamp: '2026-03-07T12:00:00.000Z',
      meta: { feedSource: 'Reuters' },
    }]);

    assert.match(section, /\*MCP TEST\*/);
    assert.match(section, /Reuters/);
    assert.match(section, /Example story/);
  });
});
