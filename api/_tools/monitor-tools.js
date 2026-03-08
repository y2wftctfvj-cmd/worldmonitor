/**
 * Monitor Tools — tool registry and re-exports from fetcher modules.
 *
 * Used by both:
 *   - telegram-webhook.js (tool-calling for interactive queries)
 *   - monitor-check.js (5-minute analysis cycle bulk fetching)
 *
 * Fetcher implementations live in ./fetchers/ for maintainability.
 * This file provides the tool registry (TOOL_DEFINITIONS, runTool)
 * and re-exports all fetcher functions for backward compatibility.
 */

import {
  fetchGeopoliticalMarkets,
  searchPredictionMarkets,
} from './prediction-markets.js';

// Re-export all fetchers so existing imports from monitor-tools.js keep working
export {
  fetchGoogleNewsHeadlines,
  fetchTopicNews,
  fetchMilitaryNews,
  fetchGovFeeds,
  fetchCISAAlerts,
  fetchGDACSAlerts,
} from './fetchers/news.js';

export {
  TELEGRAM_CHANNELS,
  SUBREDDITS,
  fetchAllTelegramChannels,
  fetchAllRedditPosts,
  fetchTwitterOsint,
  fetchBlueskyOsint,
} from './fetchers/social.js';

export {
  MARKET_SYMBOLS,
  fetchMarketQuotes,
} from './fetchers/markets.js';

export {
  fetchEarthquakes,
  fetchInternetOutages,
  fetchTravelAdvisories,
  fetchNASAFirms,
  fetchGPSJamming,
  fetchOFACSanctions,
} from './fetchers/signals.js';

// Re-export prediction market functions
export { fetchGeopoliticalMarkets, searchPredictionMarkets };

// Import fetchers needed by tool implementations
import { fetchTopicNews } from './fetchers/news.js';
import { fetchMarketQuotes } from './fetchers/markets.js';
import {
  SUBREDDITS,
  fetchAllTelegramChannels,
  fetchAllRedditPosts,
} from './fetchers/social.js';
import { fetchEarthquakes } from './fetchers/signals.js';
import {
  formatMcpObservationSection,
  gatewayConfigured as mcpGatewayConfigured,
  searchMcpNews,
  searchMcpReddit,
} from './mcp-adapter.js';

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_news',
      description: 'Search recent news headlines for a specific topic',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g., "Iran nuclear", "Taiwan")' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_markets',
      description: 'Get current prices and daily changes for market symbols (S&P 500, Oil, Gold, VIX, Bitcoin)',
      parameters: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional specific symbols. If empty, returns all tracked markets.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_telegram',
      description: 'Search Telegram OSINT channels for mentions of a topic',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic to search for in Telegram posts' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_reddit',
      description: 'Search Reddit geopolitical/OSINT subreddits for a topic',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic to search for on Reddit' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_predictions',
      description: 'Get prediction market odds for geopolitical events from Polymarket',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic to search prediction markets for (e.g., "Iran", "Ukraine ceasefire")' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_earthquakes',
      description: 'Get recent significant earthquakes worldwide',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_flights',
      description: 'Check for military flight anomalies and elevated military news activity',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'Optional region to focus on (e.g., "Middle East", "Taiwan Strait")' },
        },
        required: [],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor — dispatches tool calls to the right function
// ---------------------------------------------------------------------------

/**
 * Run a tool call and return the result as a string.
 * Used by the telegram webhook to handle function-calling responses.
 */
export async function runTool(toolName, args) {
  switch (toolName) {
    case 'search_news':
      return await toolSearchNews(args.query);
    case 'check_markets':
      return await toolCheckMarkets(args.symbols);
    case 'search_telegram':
      return await toolSearchTelegram(args.query);
    case 'search_reddit':
      return await toolSearchReddit(args.query);
    case 'check_predictions':
      return await toolCheckPredictions(args.query);
    case 'check_earthquakes':
      return await toolCheckEarthquakes();
    case 'check_flights':
      return await toolCheckFlights(args.region);
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ---------------------------------------------------------------------------
// Tool implementations (return formatted strings for the LLM)
// ---------------------------------------------------------------------------

async function toolSearchNews(query) {
  const sections = [];
  const headlines = await fetchTopicNews(query);
  if (headlines) {
    sections.push(headlines);
  }

  if (query && mcpGatewayConfigured()) {
    const mcp = await searchMcpNews(query, { timeoutMs: 1200 });
    const section = formatMcpObservationSection(`MCP NEWS ARCHIVE: ${query}`, mcp.observations, 5);
    if (section) sections.push(section);
  }

  if (sections.length === 0) return `No recent news found for "${query}".`;
  return sections.join('\n\n');
}

async function toolCheckMarkets(symbols) {
  const quotes = await fetchMarketQuotes();
  if (!quotes) return 'Market data unavailable right now.';

  // If the LLM passed specific symbols, filter the output
  if (Array.isArray(symbols) && symbols.length > 0) {
    const filtered = quotes
      .split('\n')
      .filter(line => symbols.some(s => line.toLowerCase().includes(s.toLowerCase())));
    return filtered.length > 0 ? filtered.join('\n') : quotes;
  }

  return quotes;
}

async function toolSearchTelegram(query) {
  const posts = await fetchAllTelegramChannels();
  if (!posts || posts.length === 0) return 'No Telegram data available right now.';

  // Filter posts mentioning the query
  const queryLower = query.toLowerCase();
  const matching = posts
    .filter(p => p.text.toLowerCase().includes(queryLower))
    .slice(0, 10);

  if (matching.length === 0) {
    return `No mentions of "${query}" found in recent Telegram OSINT posts. Showing latest instead:\n${posts.slice(0, 5).map(p => `- [${p.channel}] ${p.text}`).join('\n')}`;
  }

  return `Found ${matching.length} mentions of "${query}" in Telegram channels:\n${matching.map(p => `- [${p.channel}] ${p.text}`).join('\n')}`;
}

async function toolSearchReddit(query) {
  const sections = [];

  // Use Reddit search API across tracked subreddits — batch 4 at a time to avoid rate limits
  const allResults = [];
  const BATCH_SIZE = 4;

  for (let i = 0; i < SUBREDDITS.length; i += BATCH_SIZE) {
    const batch = SUBREDDITS.slice(i, i + BATCH_SIZE);
    const searches = await Promise.allSettled(
      batch.map(async (sub) => {
        const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=on&sort=relevance&t=day&limit=3&raw_json=1`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'WorldMonitor/2.7' },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        return (data?.data?.children || [])
          .filter(c => c?.data?.title)
          .map(c => ({ sub, title: c.data.title, score: c.data.score || 0 }));
      })
    );

    for (const result of searches) {
      if (result.status === 'fulfilled') allResults.push(...result.value);
    }
  }

  if (allResults.length > 0) {
    sections.push(allResults
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(p => `- [r/${p.sub}, ${p.score}pts] ${p.title}`)
      .join('\n'));
  }

  if (query && mcpGatewayConfigured()) {
    const mcp = await searchMcpReddit(query, { timeoutMs: 1200 });
    const section = formatMcpObservationSection(`MCP REDDIT ARCHIVE: ${query}`, mcp.observations, 5);
    if (section) sections.push(section);
  }

  if (sections.length === 0) return `No Reddit results for "${query}" in the last 24 hours.`;
  return sections.join('\n\n');
}

async function toolCheckPredictions(query) {
  const markets = query
    ? await searchPredictionMarkets(query)
    : await fetchGeopoliticalMarkets();

  if (!markets || markets.length === 0) {
    return query
      ? `No prediction markets found for "${query}".`
      : 'Prediction market data unavailable.';
  }

  return markets
    .map(m => `- ${m.title}: ${m.probability != null ? m.probability + '%' : 'N/A'} (vol: $${Math.round(m.volume).toLocaleString('en-US')})`)
    .join('\n');
}

async function toolCheckEarthquakes() {
  const data = await fetchEarthquakes();
  if (!data || data.length === 0) return 'No significant earthquakes in the last hour.';

  return data
    .map(eq => `- M${eq.mag.toFixed(1)} — ${eq.place} (${eq.time})`)
    .join('\n');
}

async function toolCheckFlights(region) {
  // Use GDELT military news as a proxy for military activity
  const query = region
    ? `(military OR "fighter jets" OR airspace OR deployment) AND ${region}`
    : '(military OR "fighter jets" OR airspace OR "carrier strike" OR deployment)';

  const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=10&format=json&sort=datedesc`;

  try {
    const resp = await fetch(gdeltUrl, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return 'Military flight data unavailable.';
    const data = await resp.json();
    const articles = data?.articles || [];

    if (articles.length === 0) return `No recent military activity news${region ? ` for ${region}` : ''}.`;

    return articles
      .slice(0, 8)
      .map(a => `- ${(a.title || 'Untitled').substring(0, 120)} (${a.domain || 'unknown'})`)
      .join('\n');
  } catch {
    return 'Military flight data unavailable.';
  }
}
