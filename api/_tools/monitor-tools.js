/**
 * Monitor Tools — shared data-fetching and tool-calling implementations.
 *
 * Used by both:
 *   - telegram-webhook.js (tool-calling for interactive queries)
 *   - monitor-check.js (5-minute analysis cycle bulk fetching)
 *
 * Each tool function fetches from free public APIs (no keys needed
 * except where noted). All use AbortSignal timeouts for safety.
 */

import {
  fetchGeopoliticalMarkets,
  searchPredictionMarkets,
} from './prediction-markets.js';

// ---------------------------------------------------------------------------
// Constants — channel and subreddit lists
// ---------------------------------------------------------------------------

/** 25+ public Telegram channels (verified via t.me/s/{channel}) */
export const TELEGRAM_CHANNELS = [
  // Conflict/geopolitical aggregators
  'intelslava', 'militarysummary', 'breakingmash', 'legitimniy',
  // Middle East / Iran
  'iranintl_en', 'CIG_telegram',
  // Global OSINT & intel aggregators
  'IntelRepublic', 'combatftg', 'osintdefender', 'BellumActaNews',
  'OsintTv',
  // Military news
  'GeneralMCNews', 'rnintelligence',
  // Regional
  'RVvoenkor', 'usaperiodical',
  // Mainstream news organizations
  'Bloomberg', 'guardian', 'cnbci',
  // Al Jazeera (English + Arabic for cross-language corroboration)
  'AJENews_Official', 'ajanews',
  // Ukraine/Russia conflict — direct from the front
  'KyivIndependent_official', 'ukrainenowenglish',
  // Official government/military
  'idfofficial',
  // Israel/Middle East news organizations
  'ILTVNews', 'TheTimesOfIsrael2022',
  // Journalist channels (individual reporters with direct-source intel)
  'barakravid1',
];

/** 12+ geopolitical/OSINT subreddits */
export const SUBREDDITS = [
  // Geopolitics
  'worldnews', 'geopolitics', 'osint', 'CredibleDefense',
  'internationalsecurity', 'middleeastwar', 'iranpolitics',
  // Military/defense
  'CombatFootage', 'WarCollege',
  // Cyber
  'netsec', 'cybersecurity',
  // Markets (cross-domain correlation)
  'wallstreetbets',
];

/** Market symbols to track */
export const MARKET_SYMBOLS = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: 'CL=F', name: 'Oil (WTI)' },
  { symbol: 'GC=F', name: 'Gold' },
  { symbol: '^TNX', name: '10Y Yield' },
  { symbol: '^VIX', name: 'VIX' },
  { symbol: 'BTC-USD', name: 'Bitcoin' },
  { symbol: 'ITA', name: 'Defense ETF' },  // iShares Aerospace & Defense — spikes before military news breaks
];

/** Government & wire service RSS feeds */
const GOV_FEEDS = [
  // Wire services — primary breaking news sources
  { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters World' },
  { url: 'https://www.state.gov/rss-feeds/press-releases/feed/', name: 'State Dept' },
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World' },
  { url: 'https://www.france24.com/en/rss', name: 'France24' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
  // Defense specialist — break military stories before mainstream
  { url: 'https://warontherocks.com/feed/', name: 'War on the Rocks' },
  { url: 'https://breakingdefense.com/feed/', name: 'Breaking Defense' },
  { url: 'https://www.thedrive.com/the-war-zone/feed', name: 'The War Zone' },
  // Alliance/institution feeds
  { url: 'https://www.nato.int/cps/en/natohq/news.htm', name: 'NATO' },
  // UN disaster coordination — earthquakes, tsunamis, floods, cyclones
  { url: 'https://www.gdacs.org/xml/rss.xml', name: 'GDACS' },
];

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
  const headlines = await fetchTopicNews(query);
  if (!headlines) return `No recent news found for "${query}".`;
  return headlines;
}

async function toolCheckMarkets(symbols) {
  const quotes = await fetchMarketQuotes();
  if (!quotes) return 'Market data unavailable right now.';

  // If the LLM passed specific symbols, filter the output
  if (Array.isArray(symbols) && symbols.length > 0) {
    const requested = new Set(symbols.map(s => s.toLowerCase()));
    const filtered = quotes
      .split('\n')
      .filter(line => requested.has('all') || symbols.some(s => line.toLowerCase().includes(s.toLowerCase())));
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

  if (allResults.length === 0) return `No Reddit results for "${query}" in the last 24 hours.`;

  return allResults
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(p => `- [r/${p.sub}, ${p.score}pts] ${p.title}`)
    .join('\n');
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

// ---------------------------------------------------------------------------
// Bulk fetch functions (for the analysis cycle and context building)
// ---------------------------------------------------------------------------

/**
 * Fetch 10 recent headlines from Google News RSS (World topic).
 * Free, no key, always available.
 */
export async function fetchGoogleNewsHeadlines() {
  const rssUrl =
    'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en';

  try {
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;

    const xml = await resp.text();

    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 10) {
      const titleMatch = itemMatch[0].match(titlePattern);
      const title = titleMatch?.[1] || titleMatch?.[2];
      if (title) items.push(title);
    }

    if (items.length === 0) return null;
    return items.map((t) => `- ${t}`).join('\n');
  } catch {
    return null;
  }
}

/**
 * Search Google News for topic-specific results.
 */
export async function fetchTopicNews(query) {
  if (!query || query.length < 3) return null;

  const stopWords = new Set([
    'what', 'whats', 'how', 'why', 'when', 'where', 'who', 'is', 'are', 'was', 'were',
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'about', 'from',
    'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'has', 'have', 'had',
    'tell', 'me', 'us', 'your', 'my', 'this', 'that', 'it', 'its', 'and', 'or', 'but',
    'current', 'latest', 'today', 'now', 'going', 'happening', 'update', 'status',
    'threat', 'level', 'situation', 'analysis', 'brief', 'report',
  ]);

  const keywords = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return null;

  const searchTerms = keywords.slice(0, 3).join('+');
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchTerms)}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;

    const xml = await resp.text();
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
    const datePattern = /<pubDate>(.*?)<\/pubDate>/;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 5) {
      const titleMatch = itemMatch[0].match(titlePattern);
      const dateMatch = itemMatch[0].match(datePattern);
      const title = titleMatch?.[1] || titleMatch?.[2];
      const pubDate = dateMatch?.[1] || '';
      if (title) items.push(`- ${title}${pubDate ? ` (${pubDate})` : ''}`);
    }

    if (items.length === 0) return null;
    return `Search: "${keywords.join(' ')}"\n${items.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Fetch key market quotes from Yahoo Finance (free, no key).
 * Covers: S&P 500, Oil, Gold, 10Y Yield, VIX, Bitcoin.
 *
 * Uses v7/finance/quote (structured quote data) as primary,
 * with v8/finance/chart per-symbol as fallback.
 */
export async function fetchMarketQuotes() {
  const symbols = MARKET_SYMBOLS.map(s => s.symbol);
  const names = Object.fromEntries(MARKET_SYMBOLS.map(s => [s.symbol, s.name]));

  // Try v7 quote endpoint first — returns structured price data directly
  const lines = await fetchQuotesV7(symbols, names);
  if (lines && lines.length > 0) return lines.join('\n');

  // Fallback: fetch per-symbol from v8 chart endpoint
  const fallbackLines = await fetchQuotesChartFallback(symbols, names);
  if (fallbackLines && fallbackLines.length > 0) return fallbackLines.join('\n');

  return null;
}

/**
 * Primary: Yahoo v7 quote endpoint — returns regularMarketPrice directly.
 */
async function fetchQuotesV7(symbols, names) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const results = data?.quoteResponse?.result;
    if (!Array.isArray(results) || results.length === 0) return null;

    const lines = [];
    for (const quote of results) {
      const name = names[quote.symbol] || quote.shortName || quote.symbol;
      const price = quote.regularMarketPrice;
      if (price == null || isNaN(price)) continue;

      const changePct = quote.regularMarketChangePercent;
      let changeStr = '';
      if (changePct != null && !isNaN(changePct)) {
        changeStr = ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
      }

      lines.push(`- ${name}: ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${changeStr}`);
    }

    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/**
 * Fallback: Yahoo v8 chart endpoint — one request per symbol, but reliable.
 */
async function fetchQuotesChartFallback(symbols, names) {
  const results = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;

      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta || {};
      const price = meta.regularMarketPrice;
      if (price == null || isNaN(price)) return null;

      const prevClose = meta.chartPreviousClose || meta.previousClose;
      let changeStr = '';
      if (prevClose && prevClose !== 0 && !isNaN(prevClose)) {
        const changePct = ((price - prevClose) / prevClose) * 100;
        changeStr = ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
      }

      const name = names[symbol] || symbol;
      return `- ${name}: ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${changeStr}`;
    })
  );

  const lines = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  return lines.length > 0 ? lines : null;
}

/**
 * Fetch latest messages from all Telegram OSINT channels.
 * Returns array of { channel, text } objects.
 */
export async function fetchAllTelegramChannels() {
  const results = await Promise.allSettled(
    TELEGRAM_CHANNELS.map(async (channel) => {
      const url = `https://t.me/s/${channel}`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];

      const html = await resp.text();
      const posts = [];
      const blocks = html.split('tgme_widget_message_wrap');

      for (const block of blocks) {
        const textMatch = block.match(
          /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*tgme_widget_message_(?:footer|info)/
        );
        if (!textMatch) continue;

        const text = textMatch[1]
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim();

        if (text.length > 10) {
          const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
          posts.push({ channel, text: truncated });
        }
      }

      return posts.slice(-3);
    })
  );

  return results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);
}

/**
 * Fetch top posts from all tracked subreddits.
 * Returns array of { sub, title, score, comments } objects.
 */
export async function fetchAllRedditPosts() {
  const postsPerSub = 3;
  const BATCH_SIZE = 4;
  const allPosts = [];

  // Batch 4 subreddits at a time to avoid Reddit rate limits
  for (let i = 0; i < SUBREDDITS.length; i += BATCH_SIZE) {
    const batch = SUBREDDITS.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (sub) => {
        const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${postsPerSub}&raw_json=1`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'WorldMonitor/2.7' },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];

        const data = await resp.json();
        const children = data?.data?.children;
        if (!Array.isArray(children)) return [];

        return children
          .filter((c) => c?.data?.title && !c.data.stickied)
          .map((c) => ({
            sub,
            title: c.data.title,
            score: c.data.score || 0,
            comments: c.data.num_comments || 0,
          }));
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') allPosts.push(...r.value);
    }
  }

  return allPosts.sort((a, b) => b.score - a.score);
}

/**
 * Fetch significant earthquakes from USGS (last hour).
 */
export async function fetchEarthquakes() {
  try {
    const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson';
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];

    const data = await resp.json();
    return (data?.features || []).map(f => ({
      mag: f.properties?.mag || 0,
      place: f.properties?.place || 'Unknown',
      time: new Date(f.properties?.time || 0).toISOString(),
      id: f.id,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch internet outages from Cloudflare Radar (requires token).
 */
export async function fetchInternetOutages(cloudflareToken) {
  if (!cloudflareToken) return [];

  try {
    const url = 'https://api.cloudflare.com/client/v4/radar/annotations/outages?limit=5&dateRange=1h';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cloudflareToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    return (data?.result?.annotations || [])
      .filter(o => o.scope === 'country')
      .map(o => ({
        country: o.locations || o.asName || 'Unknown',
        description: o.description || `Internet disruption in ${o.locations || 'unknown region'}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Fetch military-related news velocity from GDELT.
 * Returns article count and sample titles.
 */
export async function fetchMilitaryNews() {
  try {
    const query = '(military OR troops OR deployment OR mobilization OR "carrier strike" OR "fighter jets" OR airspace)';
    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=30&format=json&sort=datedesc`;
    const resp = await fetch(gdeltUrl, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return { count: 0, articles: [] };

    const data = await resp.json();
    const articles = data?.articles || [];
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    // Count recent articles and collect titles
    let recentCount = 0;
    const recentTitles = [];
    for (const article of articles) {
      const articleDate = parseGdeltDate(article.seendate);
      if (articleDate && articleDate.getTime() > twoHoursAgo) {
        recentCount++;
        if (recentTitles.length < 5) {
          recentTitles.push((article.title || 'Untitled').substring(0, 100));
        }
      }
    }

    return { count: recentCount, articles: recentTitles };
  } catch {
    return { count: 0, articles: [] };
  }
}

/**
 * Fetch headlines from government & wire service RSS feeds.
 * Returns array of { source, title } objects.
 */
export async function fetchGovFeeds() {
  const results = await Promise.allSettled(
    GOV_FEEDS.map(async (feed) => {
      try {
        const resp = await fetch(feed.url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return [];

        const xml = await resp.text();
        const items = [];
        const itemPattern = /<item>[\s\S]*?<\/item>/g;
        const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
        let itemMatch;
        while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 3) {
          const titleMatch = itemMatch[0].match(titlePattern);
          const title = titleMatch?.[1] || titleMatch?.[2];
          if (title) items.push({ source: feed.name, title });
        }
        return items;
      } catch {
        return [];
      }
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}


/**
 * Fetch recent tweets from OSINT accounts via Nitter RSS feeds.
 * Nitter is a free Twitter frontend that exposes RSS — no API key needed.
 * Returns array of { account, text } objects.
 */
export async function fetchTwitterOsint() {
  const OSINT_ACCOUNTS = [
    'IntelDoge', 'sentdefender', 'Global_Mil_Info', 'NotWoofers',
    'RALee85', 'Flash_news_ua', 'Faytuks',
  ];

  // Multiple Nitter instances for redundancy — if one is down, try the next
  const NITTER_INSTANCES = [
    'nitter.privacydev.net',
    'nitter.poast.org',
  ];

  const allTweets = [];

  const results = await Promise.allSettled(
    OSINT_ACCOUNTS.map(async (account) => {
      // Try each Nitter instance until one works
      for (const instance of NITTER_INSTANCES) {
        try {
          const rssUrl = `https://${instance}/${account}/rss`;
          const resp = await fetch(rssUrl, {
            headers: { 'User-Agent': 'WorldMonitor/2.7' },
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) continue;

          const xml = await resp.text();
          const tweets = [];
          const itemPattern = /<item>[\s\S]*?<\/item>/g;
          const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
          const descPattern = /<description><!\[CDATA\[(.*?)\]\]>|<description>(.*?)<\/description>/;
          let itemMatch;
          while ((itemMatch = itemPattern.exec(xml)) !== null && tweets.length < 3) {
            // Prefer description (full tweet) over title (truncated)
            const descMatch = itemMatch[0].match(descPattern);
            const titleMatch = itemMatch[0].match(titlePattern);
            const rawText = descMatch?.[1] || descMatch?.[2] || titleMatch?.[1] || titleMatch?.[2];
            if (!rawText) continue;

            // Strip HTML tags and clean up
            const text = rawText
              .replace(/<br\s*\/?>/gi, ' ')
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim();

            if (text.length > 10) {
              const truncated = text.length > 280 ? text.slice(0, 280) + '...' : text;
              tweets.push({ account, text: truncated });
            }
          }

          return tweets;
        } catch {
          continue; // Try next Nitter instance
        }
      }
      return []; // All instances failed for this account
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') allTweets.push(...result.value);
  }

  return allTweets;
}

/**
 * Fetch recent posts from OSINT accounts on Bluesky via the AT Protocol.
 * Free public API, no auth needed, growing OSINT community (many migrated from Twitter).
 * Returns array of { account, text } objects.
 */
/**
 * Fetch recent posts from OSINT accounts on Bluesky via the AT Protocol.
 *
 * Returns engagement metadata (likes, reposts, velocity) so the fusion engine
 * can weight high-engagement posts as stronger signals. A post with 500 likes
 * in 5 minutes is breaking news; same post after 6 hours is stale.
 *
 * @returns {Array<{ account: string, text: string, engagement: number }>}
 */
export async function fetchBlueskyOsint() {
  const BLUESKY_ACCOUNTS = [
    // OSINT investigations
    'bellingcat.com',
    'conflictnews.com',
    // Military/defense OSINT
    'osinttechnical.bsky.social',
    'julianroepcke.bsky.social',
    // Journalists with conflict/geopolitical focus
    'christopherjm.bsky.social',     // Christoph Koettl — NYT visual investigations
    'eaborido.bsky.social',          // Eliot Higgins — Bellingcat founder
    'shaborak.bsky.social',          // Shar Aborak — BBC Middle East
    // Conflict tracking
    'warmonitor.bsky.social',
    'auaborak.bsky.social',
  ];

  const allPosts = [];
  const now = Date.now();

  const results = await Promise.allSettled(
    BLUESKY_ACCOUNTS.map(async (handle) => {
      try {
        const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=5&filter=posts_no_replies`;
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];

        const data = await resp.json();
        return (data.feed || [])
          .map(item => {
            const post = item.post;
            const text = post?.record?.text;
            if (!text || text.length < 10) return null;

            // Calculate engagement velocity: (likes + reposts*2) / age in minutes
            const likes = post.likeCount || 0;
            const reposts = post.repostCount || 0;
            const createdAt = new Date(post.record?.createdAt || 0).getTime();
            const ageMinutes = Math.max((now - createdAt) / 60000, 1);
            const engagement = (likes + reposts * 2) / ageMinutes;

            const truncated = text.length > 280 ? text.slice(0, 280) + '...' : text;
            return {
              account: handle.split('.')[0],
              text: truncated,
              engagement: Math.round(engagement * 100) / 100,
            };
          })
          .filter(Boolean)
          .slice(0, 3);
      } catch {
        return [];
      }
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') allPosts.push(...result.value);
  }

  return allPosts;
}

// ---------------------------------------------------------------------------
// New intelligence sources (Phase 1 — SitDeck-inspired upgrade)
// ---------------------------------------------------------------------------

/**
 * Fetch recent CISA cybersecurity advisories via RSS.
 * Returns array of { source, title, link, date } — top 5 items.
 * Free, no key needed. Authoritative US government source.
 */
export async function fetchCISAAlerts() {
  try {
    const resp = await fetch('https://www.cisa.gov/cybersecurity-advisories/all.xml', {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];

    const xml = await resp.text();
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
    const linkPattern = /<link>(.*?)<\/link>/;
    const datePattern = /<pubDate>(.*?)<\/pubDate>/;
    let itemMatch;

    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 5) {
      const titleMatch = itemMatch[0].match(titlePattern);
      const linkMatch = itemMatch[0].match(linkPattern);
      const dateMatch = itemMatch[0].match(datePattern);
      const title = titleMatch?.[1] || titleMatch?.[2];
      if (title) {
        items.push({
          source: 'CISA',
          title,
          link: linkMatch?.[1] || '',
          date: dateMatch?.[1] || '',
        });
      }
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * Fetch travel advisories from US State Dept (RSS) and UK FCDO (JSON API).
 * Only includes serious advisories: US Level 3-4, UK "advise against travel".
 * Returns array of { source, title, level } objects.
 */
export async function fetchTravelAdvisories() {
  const results = await Promise.allSettled([
    // US State Dept travel advisories via RSS
    (async () => {
      const resp = await fetch(
        'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.rss.xml',
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) return [];

      const xml = await resp.text();
      const items = [];
      const itemPattern = /<item>[\s\S]*?<\/item>/g;
      const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
      let itemMatch;

      while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 10) {
        const titleMatch = itemMatch[0].match(titlePattern);
        const title = titleMatch?.[1] || titleMatch?.[2];
        if (!title) continue;

        // Filter: only Level 3 (Reconsider Travel) and Level 4 (Do Not Travel)
        const levelMatch = title.match(/Level (\d)/i);
        const level = levelMatch ? parseInt(levelMatch[1], 10) : 0;
        if (level >= 3) {
          items.push({ source: 'State Dept Travel', title, level });
        }
      }

      return items;
    })(),

    // UK FCDO travel advice via JSON API
    (async () => {
      const resp = await fetch(
        'https://www.gov.uk/api/content/foreign-travel-advice',
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) return [];

      const data = await resp.json();
      const links = data?.links?.children || [];
      const items = [];

      for (const country of links.slice(0, 50)) {
        const title = country.title || '';
        const description = (country.description || '').toLowerCase();

        // Filter: only "advise against" travel
        if (description.includes('advise against') || description.includes('do not travel')) {
          items.push({
            source: 'UK FCDO',
            title: `${title} — ${country.description || 'Advise against travel'}`,
            level: description.includes('all travel') ? 4 : 3,
          });
        }
      }

      return items.slice(0, 10);
    })(),
  ]);

  // Combine US + UK results
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

/**
 * Fetch NASA FIRMS fire hotspot counts for conflict zones.
 * Uses bounding box API to get fire count — NOT the massive global CSV.
 * Requires NASA_FIRMS_API_KEY env var (free signup).
 * Returns { middleEast: number, ukraine: number } or null if no key.
 *
 * Intended for daily digest only — too heavy for 5-min cycle.
 */
export async function fetchNASAFirms(apiKey) {
  if (!apiKey) return null;

  // Bounding boxes for conflict zones: [west,south,east,north]
  const zones = [
    { name: 'middleEast', bbox: '25,30,55,45' },   // Iraq/Iran/Syria/Yemen
    { name: 'ukraine', bbox: '22,44,40,52' },        // Ukraine/western Russia border
  ];

  const results = await Promise.allSettled(
    zones.map(async (zone) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/VIIRS_SNPP_NRT/${zone.bbox}/1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return { name: zone.name, count: 0 };

      const csv = await resp.text();
      // Each line after the header is a fire detection
      const lineCount = csv.split('\n').filter(l => l.trim().length > 0).length;
      return { name: zone.name, count: Math.max(0, lineCount - 1) }; // Subtract header
    })
  );

  const fireCounts = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      fireCounts[r.value.name] = r.value.count;
    }
  }

  return Object.keys(fireCounts).length > 0 ? fireCounts : null;
}

/**
 * Fetch GPS/GNSS jamming data from gpsjam.org.
 * Returns array of { region, pctAffected } for zones with >10% aircraft affected.
 * Uses yesterday's date (data is daily, not real-time).
 */
export async function fetchGPSJamming() {
  try {
    // Use yesterday's date — gpsjam.org publishes daily
    const yesterday = new Date(Date.now() - 86400000);
    const dateStr = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD

    const url = `https://gpsjam.org/jammer.json?z=3&lat=35&lon=18&date=${dateStr}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'WorldMonitor/3.0' },
    });
    if (!resp.ok) return [];

    const data = await resp.json();

    // data is GeoJSON FeatureCollection or array of hex bins with pct_no_nav
    const features = data?.features || (Array.isArray(data) ? data : []);
    const hotspots = [];

    // Known hotspot regions for labeling (lat/lon ranges)
    const regionLabels = [
      { name: 'Eastern Mediterranean', latMin: 30, latMax: 40, lonMin: 25, lonMax: 38 },
      { name: 'Black Sea', latMin: 40, latMax: 47, lonMin: 28, lonMax: 42 },
      { name: 'Baltic Sea', latMin: 53, latMax: 60, lonMin: 14, lonMax: 30 },
      { name: 'Middle East', latMin: 20, latMax: 35, lonMin: 35, lonMax: 60 },
      { name: 'Red Sea', latMin: 12, latMax: 30, lonMin: 32, lonMax: 45 },
    ];

    for (const feature of features) {
      const pct = feature.properties?.pct_no_nav ?? feature.pct_no_nav ?? 0;
      if (pct <= 10) continue; // Only report significant jamming

      // Try to label the region based on coordinates
      const coords = feature.geometry?.coordinates?.[0]?.[0] || feature.geometry?.coordinates || [];
      const lon = Array.isArray(coords) ? (coords[0] || 0) : 0;
      const lat = Array.isArray(coords) ? (coords[1] || 0) : 0;

      let region = 'Unknown Region';
      for (const r of regionLabels) {
        if (lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax) {
          region = r.name;
          break;
        }
      }

      // Deduplicate by region — keep highest pct
      const existing = hotspots.find(h => h.region === region);
      if (existing) {
        existing.pctAffected = Math.max(existing.pctAffected, Math.round(pct));
      } else {
        hotspots.push({ region, pctAffected: Math.round(pct) });
      }
    }

    return hotspots.sort((a, b) => b.pctAffected - a.pctAffected).slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Fetch OFAC sanctions list changes by comparing hash of SDN CSV.
 * Checks Redis for previous hash — only reports delta (new additions).
 * Rate-limited to once per hour via Redis TTL key.
 *
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 * @returns {Array<{ name: string, type: string, program: string }>}
 */
export async function fetchOFACSanctions(redisUrl, redisToken) {
  // Rate limit: skip if we checked within the last hour
  if (redisUrl && redisToken) {
    try {
      const checkResp = await fetch(`${redisUrl}/get/monitor:sanctions-checked`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(2000),
      });
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        if (checkData.result) return []; // Already checked this hour
      }
    } catch {
      // Continue with check if Redis fails
    }
  }

  try {
    // Fetch the SDN CSV (typically ~2MB)
    const resp = await fetch('https://www.treasury.gov/ofac/downloads/sdn.csv', {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];

    const csv = await resp.text();

    // Compute a simple hash of the file for change detection
    let hash = 0;
    for (let i = 0; i < Math.min(csv.length, 100000); i++) {
      hash = ((hash << 5) - hash) + csv.charCodeAt(i);
      hash = hash & hash;
    }
    const currentHash = Math.abs(hash).toString(16);

    // Compare with stored hash
    let previousHash = null;
    if (redisUrl && redisToken) {
      try {
        const hashResp = await fetch(`${redisUrl}/get/monitor:sanctions-hash`, {
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(2000),
        });
        if (hashResp.ok) {
          const hashData = await hashResp.json();
          previousHash = hashData.result;
        }
      } catch {
        // First run — no previous hash
      }
    }

    // Mark this hour as checked (1h TTL)
    if (redisUrl && redisToken) {
      try {
        await fetch(`${redisUrl}/set/monitor:sanctions-checked/1/EX/3600`, {
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(2000),
        });
        // Store current hash for next comparison
        await fetch(`${redisUrl}/set/monitor:sanctions-hash/${encodeURIComponent(currentHash)}`, {
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // Non-critical
      }
    }

    // If hash matches, no changes
    if (previousHash && previousHash === currentHash) return [];

    // If this is the first run (no previous hash), don't report everything as new
    if (!previousHash) return [];

    // Hash changed — parse for recent entries.
    // SDN CSV format: UID, Name, Type, Program, ...
    // Report first 10 entries from the end (most recently added)
    const lines = csv.split('\n').filter(l => l.trim().length > 0);
    const newEntries = [];

    for (let i = Math.max(1, lines.length - 20); i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (cols.length >= 4 && cols[1]) {
        newEntries.push({
          name: cols[1].substring(0, 100),
          type: cols[2] || 'Unknown',
          program: cols[3] || 'Unknown',
        });
      }
    }

    return newEntries.slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Fetch GDACS disaster alerts with enhanced GeoRSS parsing.
 * Returns array of { title, alertLevel, eventType, severity, lat, lon, source }.
 * Only returns Orange and Red alerts (skips Green).
 */
export async function fetchGDACSAlerts() {
  try {
    const resp = await fetch('https://www.gdacs.org/xml/rss_24h.xml', {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];

    const xml = await resp.text();
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
    const alertLevelPattern = /gdacs:alertlevel[^>]*>(.*?)</i;
    const severityPattern = /gdacs:severity[^>]*>(.*?)</i;
    const eventTypePattern = /gdacs:eventtype[^>]*>(.*?)</i;
    const latPattern = /geo:lat[^>]*>([\d.\-]+)</i;
    const lonPattern = /geo:long?[^>]*>([\d.\-]+)</i;
    let itemMatch;

    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 10) {
      const block = itemMatch[0];
      const titleMatch = block.match(titlePattern);
      const title = titleMatch?.[1] || titleMatch?.[2];
      if (!title) continue;

      // Parse GDACS-specific fields
      const alertLevel = block.match(alertLevelPattern)?.[1]?.trim() || 'Unknown';
      const severity = block.match(severityPattern)?.[1]?.trim() || '';
      const eventType = block.match(eventTypePattern)?.[1]?.trim() || '';
      const lat = parseFloat(block.match(latPattern)?.[1] || '0');
      const lon = parseFloat(block.match(lonPattern)?.[1] || '0');

      // Only Orange and Red alerts — skip Green (routine)
      const level = alertLevel.toLowerCase();
      if (level === 'green') continue;

      items.push({
        title,
        alertLevel, // 'Red', 'Orange', 'Green'
        eventType,  // 'EQ', 'TC', 'FL', 'VO'
        severity,
        lat,
        lon,
        source: 'GDACS',
      });
    }

    return items;
  } catch {
    return [];
  }
}

// Re-export prediction market functions
export { fetchGeopoliticalMarkets, searchPredictionMarkets };

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Parse GDELT date format ("20260223T143000Z") into a Date object */
function parseGdeltDate(dateStr) {
  if (!dateStr) return null;
  try {
    const isoAttempt = new Date(dateStr);
    if (!isNaN(isoAttempt.getTime())) return isoAttempt;

    const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
    if (match) {
      const [, year, month, day, hour, min, sec] = match;
      return new Date(Date.UTC(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour), parseInt(min), parseInt(sec)
      ));
    }
    return null;
  } catch {
    return null;
  }
}
