/**
 * Daily Intelligence Digest — multi-section professional briefing.
 *
 * v3.0.0: SitDeck-inspired upgrade. Multi-section briefing with:
 *   - Security overview (from recent monitor-check alerts in Redis)
 *   - Markets & economic (expanded: S&P, Oil, Gold, VIX, BTC, Defense ETF, predictions)
 *   - Cyber threats (CISA advisories)
 *   - Disaster & environmental (GDACS Orange/Red, earthquakes, NASA FIRMS fire data)
 *   - Travel & sanctions (Level 3-4 travel advisories, OFAC changes)
 *   - Signal intelligence (GPS jamming, internet outages)
 *   - Source health (which sources succeeded/failed in last 24h)
 *   - Watchlist summary
 *
 * Runs at midnight UTC (configured in vercel.json).
 *
 * Data sources:
 *   Headlines:    GDELT -> Google News RSS (no key)
 *   Markets:      Finnhub -> Yahoo Finance (no key)
 *   Predictions:  Polymarket (free, no key)
 *   New sources:  CISA, GDACS, travel advisories, GPS jamming, NASA FIRMS, OFAC
 *   Redis:        Recent alerts, source health, watchlists
 *   AI:           Qwen 3.5 Plus -> DeepSeek V3.2 -> Groq Llama
 *
 * Required env vars:
 *   CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional:
 *   FINNHUB_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY,
 *   NASA_FIRMS_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

export const config = { runtime: 'edge' };

import { fetchGeopoliticalMarkets } from './_tools/prediction-markets.js';
import {
  fetchCISAAlerts,
  fetchTravelAdvisories,
  fetchNASAFirms,
  fetchGPSJamming,
  fetchGDACSAlerts,
  fetchEarthquakes,
} from './_tools/monitor-tools.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKET_SYMBOLS_DIGEST = ['SPY', 'QQQ', 'GLD', 'USO'];

const SYMBOL_LABELS = {
  SPY: 'S&P 500',
  QQQ: 'Nasdaq 100',
  GLD: 'Gold',
  USO: 'Oil',
};

const YAHOO_SYMBOLS = { SPY: 'SPY', QQQ: 'QQQ', GLD: 'GLD', USO: 'USO' };

const GDELT_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang:eng&mode=artlist&maxrecords=5&format=json&sort=hybridrel';

const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(request) {
  const expectedToken = process.env.CRON_SECRET;
  if (!expectedToken || request.headers.get('authorization') !== `Bearer ${expectedToken}`) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return jsonResponse(503, { error: 'Telegram not configured' });
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const nasaKey = process.env.NASA_FIRMS_API_KEY;

  // Gather all data sources in parallel.
  // Edge function timeout = 25s. Budget: ~12s fetch + ~10s LLM + 3s overhead.
  // Wrap slow sources (NASA FIRMS) with tighter timeouts for the digest path.
  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);

  // All external sources get a hard 4s cap for the digest path.
  // Total parallel fetch budget: ~4s. LLM budget: ~8s. Telegram: ~5s. Overhead: 3s.
  // Must stay under 25s edge function limit (20s total target).
  const [
    headlines, finnhubQuotes, yahooQuotes, predictions,
    cisaAlerts, travelAdvisories, gdacsAlerts,
    earthquakes, gpsJamming, nasaFirms,
    recentAlerts, sourceHealth, watchlists,
  ] = await Promise.allSettled([
    // Existing sources (capped at 4s each — all run in parallel)
    withTimeout(fetchHeadlines(), 4000),
    withTimeout(fetchFinnhubQuotes(), 4000),
    withTimeout(fetchYahooQuotes(), 4000),
    withTimeout(fetchGeopoliticalMarkets(), 4000),
    // New sources (capped at 4s each)
    withTimeout(fetchCISAAlerts(), 4000),
    withTimeout(fetchTravelAdvisories(), 4000),
    withTimeout(fetchGDACSAlerts(), 4000),
    withTimeout(fetchEarthquakes(), 4000),
    withTimeout(fetchGPSJamming(), 4000),
    withTimeout(fetchNASAFirms(nasaKey), 4000),
    // Redis data (fast — 2s each)
    withTimeout(loadRecentAlertsForDigest(redisUrl, redisToken), 2000),
    withTimeout(loadSourceHealth(redisUrl, redisToken), 2000),
    withTimeout(loadWatchlistAlerts(redisUrl, redisToken, chatId), 2000),
  ]);

  // Resolve all data with safe defaults (withTimeout returns null on timeout)
  const safeValue = (result, fallback) =>
    result.status === 'fulfilled' && result.value != null ? result.value : fallback;

  const finnhubData = safeValue(finnhubQuotes, []);
  const yahooData = safeValue(yahooQuotes, []);
  const marketQuotes = finnhubData.length > 0 ? finnhubData : yahooData;

  const briefingData = {
    headlines: safeValue(headlines, []),
    marketQuotes,
    predictions: safeValue(predictions, []),
    cisaAlerts: safeValue(cisaAlerts, []),
    travelAdvisories: safeValue(travelAdvisories, []),
    gdacsAlerts: safeValue(gdacsAlerts, []),
    earthquakes: safeValue(earthquakes, []),
    gpsJamming: safeValue(gpsJamming, []),
    nasaFirms: safeValue(nasaFirms, null),
    recentAlerts: safeValue(recentAlerts, []),
    sourceHealth: safeValue(sourceHealth, null),
    watchlists: safeValue(watchlists, []),
  };

  // Generate AI briefing — hard 12s cap so we stay under 25s edge limit
  const aiBriefing = await withTimeout(generateIntelBriefing(briefingData), 12000);

  // Build the multi-section message
  const message = buildBriefingMessage(briefingData, aiBriefing);

  // Send to Telegram — split into chunks if message exceeds 4096 char limit
  try {
    const chunks = splitMessage(message, 4096);
    for (const chunk of chunks) {
      await sendDigestChunk(botToken, chatId, chunk);
    }

    return jsonResponse(200, {
      ok: true,
      chunks: chunks.length,
      sections: {
        headlines: briefingData.headlines.length,
        markets: briefingData.marketQuotes.length,
        predictions: briefingData.predictions.length,
        cisaAlerts: briefingData.cisaAlerts.length,
        travelAdvisories: briefingData.travelAdvisories.length,
        gdacsAlerts: briefingData.gdacsAlerts.length,
        gpsJamming: briefingData.gpsJamming.length,
        nasaFirms: !!briefingData.nasaFirms,
        recentAlerts: briefingData.recentAlerts.length,
        sourceHealth: !!briefingData.sourceHealth,
        aiBriefing: !!aiBriefing,
      },
    });
  } catch (err) {
    console.error('[daily-digest] Failed to send Telegram message:', err);
    return jsonResponse(502, { error: 'Failed to reach Telegram' });
  }
}

// ---------------------------------------------------------------------------
// Data fetchers — headlines and markets
// ---------------------------------------------------------------------------

async function fetchHeadlines() {
  // Race GDELT and Google News in parallel — use whichever returns data first
  const [gdelt, gnews] = await Promise.allSettled([
    fetchGdeltHeadlines(),
    fetchGoogleNewsRss(),
  ]);
  const gdeltData = gdelt.status === 'fulfilled' ? gdelt.value : [];
  if (gdeltData.length > 0) return gdeltData;
  return gnews.status === 'fulfilled' ? gnews.value : [];
}

async function fetchGdeltHeadlines() {
  try {
    const resp = await fetch(GDELT_URL, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data?.articles ?? []).slice(0, 5).map((a) => ({
      title: a.title ?? 'Untitled',
      url: a.url ?? '',
    }));
  } catch (err) {
    console.error('[daily-digest] GDELT fetch failed:', err.message);
    return [];
  }
}

async function fetchGoogleNewsRss() {
  try {
    const resp = await fetch(GOOGLE_NEWS_RSS, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return [];

    const xml = await resp.text();
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
    const linkPattern = /<link>(.*?)<\/link>/;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 5) {
      const titleMatch = itemMatch[0].match(titlePattern);
      const linkMatch = itemMatch[0].match(linkPattern);
      const title = titleMatch?.[1] || titleMatch?.[2];
      if (title) items.push({ title, url: linkMatch?.[1] || '' });
    }
    return items;
  } catch (err) {
    console.error('[daily-digest] Google News RSS failed:', err.message);
    return [];
  }
}

async function fetchFinnhubQuotes() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];

  const results = await Promise.all(
    MARKET_SYMBOLS_DIGEST.map(async (symbol) => {
      try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
        const resp = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.c === 0 && data.h === 0 && data.l === 0) return null;
        return {
          symbol,
          label: SYMBOL_LABELS[symbol] ?? symbol,
          price: data.c,
          changePercent: data.dp,
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

async function fetchYahooQuotes() {
  try {
    const symbols = Object.values(YAHOO_SYMBOLS).join(',');
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=1d&interval=1d`;
    const resp = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'WorldMonitor/3.0' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    const quotes = [];

    for (const [name, yahooSymbol] of Object.entries(YAHOO_SYMBOLS)) {
      const quote = data?.[yahooSymbol];
      if (!quote) continue;
      const closeArr = quote.close;
      const price = Array.isArray(closeArr) && closeArr.length > 0
        ? closeArr[closeArr.length - 1]
        : null;
      if (price == null) continue;

      const prevClose = quote.chartPreviousClose || quote.previousClose;
      const changePercent = prevClose && prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : 0;
      quotes.push({
        symbol: name,
        label: SYMBOL_LABELS[name] ?? name,
        price,
        changePercent,
      });
    }
    return quotes;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Redis loaders — recent alerts, source health, watchlists
// ---------------------------------------------------------------------------

async function loadRecentAlertsForDigest(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];
  try {
    const resp = await fetch(`${redisUrl}/get/monitor:recent-alerts`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.result) return [];
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadSourceHealth(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return null;
  try {
    const resp = await fetch(`${redisUrl}/get/monitor:source-health`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function loadWatchlistAlerts(redisUrl, redisToken, chatId) {
  if (!redisUrl || !redisToken || !chatId) return [];
  try {
    const key = `watchlist:${chatId}`;
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.result) return [];
    return JSON.parse(data.result);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AI intelligence briefing — enhanced with all new data
// ---------------------------------------------------------------------------

async function generateIntelBriefing(data) {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!openRouterKey && !groqKey) return null;

  // Build comprehensive data summary for the LLM
  const sections = [];

  // Headlines
  if (data.headlines.length > 0) {
    sections.push(`HEADLINES:\n${data.headlines.map((h, i) => `${i + 1}. ${h.title}`).join('\n')}`);
  }

  // Markets
  if (data.marketQuotes.length > 0) {
    const marketLines = data.marketQuotes.map((q) => {
      const sign = q.changePercent >= 0 ? '+' : '';
      return `${q.label}: $${q.price?.toFixed(2)} (${sign}${q.changePercent?.toFixed(2)}%)`;
    });
    sections.push(`MARKETS:\n${marketLines.join('\n')}`);
  }
  // Predictions
  if (data.predictions.length > 0) {
    sections.push(`PREDICTION MARKETS:\n${data.predictions.slice(0, 5).map(m => `${m.title}: ${m.probability}%`).join('\n')}`);
  }

  // Recent alerts from monitor pipeline
  if (data.recentAlerts.length > 0) {
    const alertSummary = data.recentAlerts
      .slice(-10)
      .map(a => {
        const title = typeof a === 'string' ? a : a.title;
        const severity = typeof a === 'object' ? a.severity : 'unknown';
        return `- [${severity}] ${title}`;
      })
      .join('\n');
    sections.push(`RECENT ALERTS (last 24h):\n${alertSummary}`);
  }

  // CISA
  if (data.cisaAlerts.length > 0) {
    sections.push(`CYBER THREATS (CISA):\n${data.cisaAlerts.map(a => `- ${a.title}`).join('\n')}`);
  }

  // GDACS
  if (data.gdacsAlerts.length > 0) {
    sections.push(`DISASTERS (GDACS):\n${data.gdacsAlerts.map(a => `- [${a.alertLevel}] ${a.title}${a.severity ? ` (${a.severity})` : ''}`).join('\n')}`);
  }

  // Earthquakes
  if (data.earthquakes.length > 0) {
    sections.push(`EARTHQUAKES:\n${data.earthquakes.map(eq => `- M${(eq.mag || 0).toFixed(1)} — ${eq.place}`).join('\n')}`);
  }

  // Travel advisories
  if (data.travelAdvisories.length > 0) {
    sections.push(`TRAVEL ADVISORIES:\n${data.travelAdvisories.map(a => `- [${a.source}] ${a.title}`).join('\n')}`);
  }

  // GPS jamming
  if (data.gpsJamming.length > 0) {
    sections.push(`GPS JAMMING:\n${data.gpsJamming.map(h => `- ${h.region}: ${h.pctAffected}% aircraft affected`).join('\n')}`);
  }

  // NASA FIRMS
  if (data.nasaFirms) {
    const fireLines = Object.entries(data.nasaFirms).map(([zone, count]) => `- ${zone}: ${count} fire detections`);
    sections.push(`SATELLITE FIRE DETECTION (NASA FIRMS):\n${fireLines.join('\n')}`);
  }

  // Source health
  if (data.sourceHealth) {
    const failed = Object.entries(data.sourceHealth)
      .filter(([, v]) => v.consecutiveFailures >= 3)
      .map(([name, v]) => `- ${name}: ${v.consecutiveFailures} consecutive failures`);
    if (failed.length > 0) {
      sections.push(`SOURCE GAPS:\n${failed.join('\n')}`);
    }
  }

  if (sections.length === 0) return null;

  const systemPrompt = `You are Monitor, a senior intelligence analyst preparing the morning briefing.

Generate a DAILY INTELLIGENCE BRIEFING with these sections:

1. SECURITY OVERVIEW: Top 3 security events from the last 24h. Lead with the most significant development. Include "SO WHAT" for each.

2. MARKETS & ECONOMIC: Key market moves and what they signal. Note any cross-domain connections (e.g., defense stocks up + conflict news).

3. CYBER THREATS: CISA advisories or active campaigns (if any data provided).

4. DISASTER & ENVIRONMENTAL: GDACS alerts, significant earthquakes, anomalous fire activity (if any).

5. TRAVEL & SANCTIONS: Travel advisory changes, OFAC additions (if any).

6. SIGNAL INTELLIGENCE: GPS jamming hotspots, internet outage patterns (if any).

7. 24-HOUR OUTLOOK: What to watch today with specific, measurable indicators.

RULES:
- Lead each section with the most significant item
- Include "SO WHAT" context — why each item matters
- Skip sections with no data (don't say "No data available")
- Reference specific numbers, names, and locations from the data
- Keep total output under 2000 characters
- Never fabricate data — only reference what's provided
- Never use filler phrases like "remains to be seen" or "situation developing"`;

  const userPrompt = sections.join('\n\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const providers = [];
  if (openRouterKey) {
    providers.push({
      name: 'Qwen',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'qwen/qwen3.5-plus-02-15',
      apiKey: openRouterKey,
    });
    providers.push({
      name: 'DeepSeek',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'deepseek/deepseek-v3.2',
      apiKey: openRouterKey,
    });
  }
  if (groqKey) {
    providers.push({
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      apiKey: groqKey,
    });
  }

  for (const provider of providers) {
    try {
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          temperature: 0.3,
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) continue;
      const responseData = await resp.json();
      const content = responseData?.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch (err) {
      console.error(`[daily-digest] ${provider.name} failed:`, err.message);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Message builder — multi-section professional briefing
// ---------------------------------------------------------------------------

function buildBriefingMessage(data, aiBriefing) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  const parts = [];
  parts.push('*DAILY INTELLIGENCE BRIEFING*');
  parts.push(escapeMarkdown(dateStr));
  parts.push('');

  // AI-generated briefing (the main analysis)
  if (aiBriefing) {
    parts.push(escapeMarkdown(aiBriefing));
    parts.push('');
  }

  // MARKETS section
  parts.push('*MARKETS \\& ECONOMIC*');
  if (data.marketQuotes.length > 0) {
    for (const quote of data.marketQuotes) {
      const arrow = quote.changePercent >= 0 ? '\u2B06' : '\u2B07';
      const sign = quote.changePercent >= 0 ? '+' : '';
      const line = `${quote.label}: $${quote.price?.toFixed(2) ?? '?'} (${sign}${quote.changePercent?.toFixed(2) ?? '?'}%) ${arrow}`;
      parts.push(escapeMarkdown(line));
    }
  } else {
    parts.push(escapeMarkdown('Market data unavailable.'));
  }
  parts.push('');

  // PREDICTION MARKETS section
  if (data.predictions.length > 0) {
    parts.push('*PREDICTION MARKETS*');
    for (const m of data.predictions.slice(0, 5)) {
      parts.push(escapeMarkdown(`${m.title}: ${m.probability}%`));
    }
    parts.push('');
  }

  // CYBER THREATS section
  if (data.cisaAlerts.length > 0) {
    parts.push('*CYBER THREATS*');
    for (const alert of data.cisaAlerts.slice(0, 3)) {
      parts.push(escapeMarkdown(`- ${alert.title}`));
    }
    parts.push('');
  }

  // DISASTER & ENVIRONMENTAL section
  const hasDisasterData = data.gdacsAlerts.length > 0 || data.earthquakes.length > 0 || data.nasaFirms;
  if (hasDisasterData) {
    parts.push('*DISASTER \\& ENVIRONMENTAL*');
    for (const alert of data.gdacsAlerts.slice(0, 3)) {
      parts.push(escapeMarkdown(`[${alert.alertLevel}] ${alert.title}`));
    }
    for (const eq of data.earthquakes.slice(0, 3)) {
      parts.push(escapeMarkdown(`M${(eq.mag || 0).toFixed(1)} — ${eq.place}`));
    }
    if (data.nasaFirms) {
      for (const [zone, count] of Object.entries(data.nasaFirms)) {
        parts.push(escapeMarkdown(`Fire: ${zone} — ${count} detections`));
      }
    }
    parts.push('');
  }

  // TRAVEL & SANCTIONS section
  const hasTravelData = data.travelAdvisories.length > 0;
  if (hasTravelData) {
    parts.push('*TRAVEL \\& SANCTIONS*');
    for (const advisory of data.travelAdvisories.slice(0, 5)) {
      parts.push(escapeMarkdown(`[L${advisory.level}] ${advisory.title}`));
    }
    parts.push('');
  }

  // SIGNAL INTELLIGENCE section
  if (data.gpsJamming.length > 0) {
    parts.push('*SIGNAL INTELLIGENCE*');
    for (const hotspot of data.gpsJamming.slice(0, 3)) {
      parts.push(escapeMarkdown(`GPS: ${hotspot.region} — ${hotspot.pctAffected}% affected`));
    }
    parts.push('');
  }

  // SOURCE HEALTH section
  if (data.sourceHealth) {
    const healthEntries = Object.entries(data.sourceHealth);
    const okCount = healthEntries.filter(([, v]) => v.status === 'ok').length;
    const failedSources = healthEntries
      .filter(([, v]) => v.consecutiveFailures >= 2)
      .map(([name]) => name);

    parts.push('*SOURCE HEALTH*');
    if (failedSources.length > 0) {
      parts.push(escapeMarkdown(`${okCount}/${healthEntries.length} online | Gaps: ${failedSources.join(', ')}`));
    } else {
      parts.push(escapeMarkdown(`${okCount}/${healthEntries.length} sources online — all healthy`));
    }
    parts.push('');
  }

  // TOP STORIES section
  parts.push('*TOP STORIES*');
  if (data.headlines.length > 0) {
    for (let i = 0; i < data.headlines.length; i++) {
      parts.push(escapeMarkdown(`${i + 1}. ${data.headlines[i].title}`));
    }
  } else {
    parts.push(escapeMarkdown('No headlines available.'));
  }
  parts.push('');

  parts.push('_Monitor is watching\\. Sleep well\\._');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Telegram message splitting and sending
// ---------------------------------------------------------------------------

/**
 * Split a long message into chunks under maxLen.
 * Prefers splitting on section headers, then double newlines, then single newlines.
 */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Prefer splitting before a section header (*SOMETHING*)
    const headerPattern = /\n\*[A-Z]/g;
    let headerMatch;
    while ((headerMatch = headerPattern.exec(remaining)) !== null) {
      if (headerMatch.index > 0 && headerMatch.index <= maxLen) {
        splitAt = headerMatch.index;
      }
      if (headerMatch.index > maxLen) break;
    }

    // Try double newline
    if (splitAt === -1) {
      const lastDoubleNewline = remaining.lastIndexOf('\n\n', maxLen);
      if (lastDoubleNewline > maxLen * 0.3) splitAt = lastDoubleNewline;
    }

    // Try single newline
    if (splitAt === -1) {
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.3) splitAt = lastNewline;
    }

    // Hard cut as last resort
    if (splitAt === -1) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Send a single digest chunk to Telegram.
 * Tries MarkdownV2 first, falls back to plain text on parse failure.
 */
async function sendDigestChunk(botToken, chatId, chunk) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: chunk,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error('[daily-digest] Telegram chunk error:', resp.status, errBody);

    // Retry without MarkdownV2 on parse failure
    if (resp.status === 400) {
      const plainChunk = chunk.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
      const retryResp = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: plainChunk,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5_000),
      });

      if (retryResp.ok) return;
    }

    throw new Error(`Telegram API error ${resp.status}`);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
