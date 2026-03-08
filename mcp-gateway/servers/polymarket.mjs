import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'polymarket',
  version: '1.0.0',
});

server.registerTool('predictions_search', {
  description: 'Search Polymarket prediction markets for event probabilities',
  inputSchema: {
    query: z.string().describe('Search query for prediction markets'),
    limit: z.string().optional().default('10').describe('Max results to return'),
  },
}, async ({ query, limit }) => {
  const maxResults = Math.min(Number(limit) || 10, 25);
  const url = `https://gamma-api.polymarket.com/events?title_contains=${encodeURIComponent(query)}&closed=false&limit=${maxResults}&order=volume24hr&ascending=false`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`Polymarket API returned ${resp.status}`);
  const events = await resp.json();

  const markets = (Array.isArray(events) ? events : []).map(event => {
    // Each event has markets array with outcome probabilities
    const eventMarkets = event.markets || [];
    const topMarket = eventMarkets[0] || {};
    const probability = topMarket.outcomePrices
      ? Math.round(JSON.parse(topMarket.outcomePrices)[0] * 100)
      : null;
    const volume = eventMarkets.reduce((sum, m) => sum + (Number(m.volume) || 0), 0);

    return {
      title: event.title || '',
      probability,
      volume,
      outcomes: eventMarkets.map(m => m.groupItemTitle || m.question || '').filter(Boolean),
      end_date: event.endDate || null,
      url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
    };
  });

  return {
    content: [{ type: 'text', text: JSON.stringify({ markets }) }],
    structuredContent: { markets },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
