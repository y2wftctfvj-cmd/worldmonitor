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
  invokeMcpTool,
  searchMcpNews,
  searchMcpPredictions,
  searchMcpReddit,
  searchMcpSanctions,
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
  {
    type: 'function',
    function: {
      name: 'search_earthquakes',
      description: 'Search USGS earthquake database by region, magnitude, and timeframe',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'Region name (e.g., "middle east", "pacific ring", "mediterranean")' },
          min_magnitude: { type: 'string', description: 'Minimum magnitude (default: 4.5)' },
          days_back: { type: 'string', description: 'Days to search back (default: 7)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'track_flights',
      description: 'Track aircraft with military callsign pattern detection via ADS-B data',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'Hotspot region (e.g., "middle east", "taiwan strait", "baltic", "black sea")' },
          military_only: { type: 'boolean', description: 'Only show military callsign matches (default: true)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_sanctions',
      description: 'Search OFAC SDN sanctions list by entity name',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Entity name to search (person, organization, vessel)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_predictions_market',
      description: 'Search Polymarket prediction markets for event probabilities and volumes',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic to search (e.g., "Iran", "Ukraine ceasefire", "Trump")' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'track_maritime',
      description: 'Track vessel activity in maritime regions or ports',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'Maritime region for vessel search (e.g., "strait of hormuz", "south china sea")' },
          port: { type: 'string', description: 'Port name for arrival/departure activity' },
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
    case 'search_earthquakes':
      return await toolSearchEarthquakes(args.region, args.min_magnitude, args.days_back);
    case 'track_flights':
      return await toolTrackFlights(args.region, args.military_only);
    case 'search_sanctions':
      return await toolSearchSanctions(args.query);
    case 'search_predictions_market':
      return await toolSearchPredictionsMarket(args.query);
    case 'track_maritime':
      return await toolTrackMaritime(args.region, args.port);
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
    const section = formatMcpObservationSection(`NEWS ARCHIVE: ${query}`, mcp.observations, 5);
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
    const section = formatMcpObservationSection(`REDDIT ARCHIVE: ${query}`, mcp.observations, 5);
    if (section) sections.push(section);
  }

  if (sections.length === 0) return `No Reddit results for "${query}" in the last 24 hours.`;
  return sections.join('\n\n');
}

async function toolCheckPredictions(query) {
  const sections = [];
  const markets = query
    ? await searchPredictionMarkets(query)
    : await fetchGeopoliticalMarkets();

  if (markets && markets.length > 0) {
    sections.push(markets
      .map(m => `- ${m.title}: ${m.probability != null ? m.probability + '%' : 'N/A'} (vol: $${Math.round(m.volume).toLocaleString('en-US')})`)
      .join('\n'));
  }

  // Enhance with MCP Polymarket for richer metadata
  if (query && mcpGatewayConfigured()) {
    const mcp = await searchMcpPredictions(query, { timeoutMs: 2000 });
    if (mcp.observations.length > 0) {
      const section = formatMcpObservationSection(`PREDICTION MARKETS: ${query}`, mcp.observations, 5);
      if (section) sections.push(section);
    }
  }

  if (sections.length === 0) {
    return query
      ? `No prediction markets found for "${query}".`
      : 'Prediction market data unavailable.';
  }
  return sections.join('\n\n');
}

async function toolCheckEarthquakes() {
  const sections = [];
  const data = await fetchEarthquakes();
  if (data && data.length > 0) {
    sections.push(data
      .map(eq => `- M${eq.mag.toFixed(1)} — ${eq.place} (${eq.time})`)
      .join('\n'));
  }

  // Enhance with MCP for recent M4.5+ worldwide (uses the simpler earthquake_recent tool)
  if (mcpGatewayConfigured()) {
    const mcp = await invokeMcpTool('earthquake_recent', {}, { timeoutMs: 3000 });
    if (mcp.ok && mcp.observations.length > 0) {
      const section = formatMcpObservationSection('M4.5+ last 24h', mcp.observations, 6);
      if (section) sections.push(section);
    }
  }

  if (sections.length === 0) return 'No significant earthquakes in the last hour.';
  return sections.join('\n\n');
}

async function toolCheckFlights(region) {
  const sections = [];

  // GDELT military news as a proxy for military activity
  const query = region
    ? `(military OR "fighter jets" OR airspace OR deployment) AND ${region}`
    : '(military OR "fighter jets" OR airspace OR "carrier strike" OR deployment)';

  const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=10&format=json&sort=datedesc`;

  try {
    const resp = await fetch(gdeltUrl, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const data = await resp.json();
      const articles = data?.articles || [];
      if (articles.length > 0) {
        sections.push(articles
          .slice(0, 8)
          .map(a => `- ${(a.title || 'Untitled').substring(0, 120)} (${a.domain || 'unknown'})`)
          .join('\n'));
      }
    }
  } catch {
    // GDELT unavailable — continue with MCP
  }

  // Enhance with MCP ADS-B flight data
  if (mcpGatewayConfigured() && region) {
    const mcp = await invokeMcpTool('flights_military', { region: region.toLowerCase() }, { timeoutMs: 3000 });
    if (mcp.ok && mcp.observations.length > 0) {
      const section = formatMcpObservationSection(`ADS-B MILITARY FLIGHTS: ${region}`, mcp.observations, 6);
      if (section) sections.push(section);
    }
  }

  if (sections.length === 0) return `No recent military activity${region ? ` for ${region}` : ''}.`;
  return sections.join('\n\n');
}

async function toolSearchEarthquakes(region, minMagnitude, daysBack) {
  const sections = [];

  // Live USGS data
  const liveData = await fetchEarthquakes();
  if (liveData && liveData.length > 0) {
    sections.push('RECENT (last hour):\n' + liveData
      .map(eq => `- M${eq.mag.toFixed(1)} — ${eq.place} (${eq.time})`)
      .join('\n'));
  }

  // MCP historical search
  if (mcpGatewayConfigured()) {
    const mcpArgs = {
      region: region || '',
      minmagnitude: minMagnitude || '4.5',
      days_back: daysBack || '7',
    };
    const mcp = await invokeMcpTool('earthquake_search', mcpArgs, { timeoutMs: 3000 });
    if (mcp.ok && mcp.observations.length > 0) {
      const label = region ? `USGS SEARCH: ${region}` : 'USGS SEARCH: worldwide';
      const section = formatMcpObservationSection(label, mcp.observations, 8);
      if (section) sections.push(section);
    }
  }

  if (sections.length === 0) return 'No significant earthquakes found.';
  return sections.join('\n\n');
}

async function toolTrackFlights(region, militaryOnly) {
  if (!mcpGatewayConfigured()) return 'Flight tracking requires MCP gateway. ADS-B data unavailable.';

  const regionKey = (region || 'middle east').toLowerCase();
  const useMilitary = militaryOnly !== false;

  if (useMilitary) {
    const mcp = await invokeMcpTool('flights_military', { region: regionKey }, { timeoutMs: 5000 });
    if (!mcp.ok) return `Flight tracking unavailable for ${regionKey}: ${mcp.reason}`;
    if (mcp.observations.length === 0) {
      const totalInRegion = mcp.raw?.result?.structuredContent?.total_in_region || 'unknown';
      return `No military callsign matches in ${regionKey}. Total aircraft in region: ${totalInRegion}`;
    }
    return formatMcpObservationSection(`MILITARY FLIGHTS: ${regionKey}`, mcp.observations, 10) || 'No results.';
  }

  // Non-military: return all aircraft in region bounding box
  const regionBoxes = {
    'middle east': { lamin: '20', lomin: '30', lamax: '42', lomax: '65' },
    'taiwan strait': { lamin: '21', lomin: '115', lamax: '27', lomax: '125' },
    'baltic': { lamin: '53', lomin: '12', lamax: '66', lomax: '30' },
    'black sea': { lamin: '40', lomin: '27', lamax: '47', lomax: '42' },
  };
  const box = regionBoxes[regionKey];
  if (!box) return `Unknown region "${regionKey}". Available: ${Object.keys(regionBoxes).join(', ')}`;

  const mcp = await invokeMcpTool('flights_region', box, { timeoutMs: 5000 });
  if (!mcp.ok) return `Flight tracking unavailable: ${mcp.reason}`;
  return formatMcpObservationSection(`ALL FLIGHTS: ${regionKey}`, mcp.observations, 10) || 'No aircraft detected.';
}

async function toolSearchSanctions(query) {
  const sections = [];

  // MCP OFAC search
  if (mcpGatewayConfigured()) {
    const mcp = await searchMcpSanctions(query, { timeoutMs: 3000 });
    if (mcp.observations.length > 0) {
      sections.push(formatMcpObservationSection(`OFAC SDN MATCHES: ${query}`, mcp.observations, 10));
    }
  }

  if (sections.length === 0) return `No OFAC sanctions matches found for "${query}".`;
  return sections.filter(Boolean).join('\n\n');
}

async function toolSearchPredictionsMarket(query) {
  const sections = [];

  // Live Polymarket search
  const liveMarkets = await searchPredictionMarkets(query);
  if (liveMarkets && liveMarkets.length > 0) {
    sections.push('LIVE MARKETS:\n' + liveMarkets
      .map(m => `- ${m.title}: ${m.probability != null ? m.probability + '%' : 'N/A'} (vol: $${Math.round(m.volume).toLocaleString('en-US')})`)
      .join('\n'));
  }

  // MCP enrichment with richer metadata
  if (mcpGatewayConfigured()) {
    const mcp = await searchMcpPredictions(query, { timeoutMs: 2000 });
    if (mcp.observations.length > 0) {
      const section = formatMcpObservationSection(`PREDICTION MARKETS: ${query}`, mcp.observations, 5);
      if (section) sections.push(section);
    }
  }

  if (sections.length === 0) return `No prediction markets found for "${query}".`;
  return sections.join('\n\n');
}

async function toolTrackMaritime(region, port) {
  if (!mcpGatewayConfigured()) return 'Maritime tracking requires MCP gateway. Vessel data unavailable.';

  if (port) {
    const mcp = await invokeMcpTool('maritime_port_activity', { port_name: port }, { timeoutMs: 5000 });
    if (!mcp.ok) return `Maritime data unavailable for port "${port}": ${mcp.reason}`;
    if (mcp.observations.length === 0) return `No vessel activity found at port "${port}".`;
    return formatMcpObservationSection(`PORT ACTIVITY: ${port}`, mcp.observations, 10) || 'No results.';
  }

  if (region) {
    // Map region names to bounding boxes for vessel search
    const regionBoxes = {
      'strait of hormuz': { lamin: '25', lomin: '54', lamax: '28', lomax: '58' },
      'south china sea': { lamin: '5', lomin: '105', lamax: '25', lomax: '122' },
      'red sea': { lamin: '12', lomin: '36', lamax: '30', lomax: '44' },
      'black sea': { lamin: '40', lomin: '27', lamax: '47', lomax: '42' },
      'baltic': { lamin: '53', lomin: '12', lamax: '66', lomax: '30' },
    };
    const box = regionBoxes[region.toLowerCase()];
    if (!box) return `Unknown maritime region "${region}". Available: ${Object.keys(regionBoxes).join(', ')}`;

    const mcp = await invokeMcpTool('maritime_vessels', box, { timeoutMs: 5000 });
    if (!mcp.ok) return `Maritime data unavailable: ${mcp.reason}`;
    if (mcp.observations.length === 0) return `No vessels detected in ${region}.`;
    return formatMcpObservationSection(`VESSELS: ${region}`, mcp.observations, 10) || 'No results.';
  }

  return 'Specify a region or port to track maritime activity.';
}
