/**
 * Daily Intelligence Digest — reads from monitor-check's cached data.
 *
 * v4.0.0: Redis-first approach. Instead of live-fetching 10+ sources under a 25s
 * edge timeout (where most timeout), the digest reads pre-cached data from the
 * monitor-check pipeline that runs every 5 minutes.
 *
 * Live fetches (fast, ~3s total):
 *   - Markets: Finnhub -> Yahoo Finance (1s each)
 *   - Predictions: Polymarket (1s)
 *
 * Redis reads (instant, ~1s total):
 *   - monitor:recent-alerts — last 12h of promoted alerts from the pipeline
 *   - monitor:source-health — which sources succeeded/failed
 *   - monitor:digest-cache:{YYYY-MM-DD} — bounded daily cache with top alerts,
 *     entity counts, and source health from all cycles today
 *   - watchlist:{chatId} — user's watchlist
 *
 * Time budget: 3s fetch + 10s LLM + 5s Telegram = 18s total. 7s headroom.
 *
 * Runs at midnight UTC (configured in vercel.json).
 *
 * Required env vars:
 *   CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional:
 *   FINNHUB_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY,
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

export const config = { runtime: 'edge' };

import { fetchGeopoliticalMarkets } from './_tools/prediction-markets.js';

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

  // Timeout helper for live fetches
  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);

  // Fetch live data (markets + predictions only — fast, ~1s each) and Redis data in parallel
  // Total budget: ~3s for all parallel fetches
  const [
    finnhubQuotes, yahooQuotes, predictions,
    recentAlerts, sourceHealth, digestCache, watchlists,
  ] = await Promise.allSettled([
    // Live fetches — only markets + predictions (fast, reliable)
    withTimeout(fetchFinnhubQuotes(), 4000),
    withTimeout(fetchYahooQuotes(), 4000),
    withTimeout(fetchGeopoliticalMarkets(), 4000),
    // Redis reads — pre-cached by monitor-check pipeline (instant)
    withTimeout(loadRecentAlertsForDigest(redisUrl, redisToken), 2000),
    withTimeout(loadSourceHealth(redisUrl, redisToken), 2000),
    withTimeout(loadDigestCache(redisUrl, redisToken), 2000),
    withTimeout(loadWatchlistAlerts(redisUrl, redisToken, chatId), 2000),
  ]);

  // Resolve all data with safe defaults
  const safeValue = (result, fallback) =>
    result.status === 'fulfilled' && result.value != null ? result.value : fallback;

  const finnhubData = safeValue(finnhubQuotes, []);
  const yahooData = safeValue(yahooQuotes, []);
  const marketQuotes = finnhubData.length > 0 ? finnhubData : yahooData;
  const cache = safeValue(digestCache, { topAlerts: [], entityCounts: {}, sourceHealth: null });

  const briefingData = {
    marketQuotes,
    predictions: safeValue(predictions, []),
    recentAlerts: safeValue(recentAlerts, []),
    sourceHealth: safeValue(sourceHealth, null),
    watchlists: safeValue(watchlists, []),
    // From digest cache (populated by monitor-check every 5 min)
    topAlerts: cache.topAlerts || [],
    entityCounts: cache.entityCounts || {},
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
        markets: briefingData.marketQuotes.length,
        predictions: briefingData.predictions.length,
        recentAlerts: briefingData.recentAlerts.length,
        topAlerts: briefingData.topAlerts.length,
        entityCount: Object.keys(briefingData.entityCounts).length,
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
// Data fetchers — markets only (everything else comes from Redis cache)
// ---------------------------------------------------------------------------

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
      headers: { 'User-Agent': 'WorldMonitor/4.0' },
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
// Redis loaders — recent alerts, source health, digest cache, watchlists
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

/**
 * Load today's digest cache — bounded daily data from monitor-check cycles.
 * Contains topAlerts (20), entityCounts (50), sourceHealth snapshot.
 */
async function loadDigestCache(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return null;
  try {
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const cacheKey = `monitor:digest-cache:${dateStr}`;
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(cacheKey)}`, {
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
// AI intelligence briefing — reads from cached data
// ---------------------------------------------------------------------------

async function generateIntelBriefing(data) {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!openRouterKey && !groqKey) return null;

  // Build data summary for the LLM from cached + live data
  const sections = [];

  // Markets (live)
  if (data.marketQuotes.length > 0) {
    const marketLines = data.marketQuotes.map((q) => {
      const sign = q.changePercent >= 0 ? '+' : '';
      return `${q.label}: $${q.price?.toFixed(2)} (${sign}${q.changePercent?.toFixed(2)}%)`;
    });
    sections.push(`MARKETS:\n${marketLines.join('\n')}`);
  }

  // Predictions (live)
  if (data.predictions.length > 0) {
    sections.push(`PREDICTION MARKETS:\n${data.predictions.slice(0, 5).map(m => `${m.title}: ${m.probability}%`).join('\n')}`);
  }

  // Recent alerts from monitor pipeline (Redis)
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

  // Top alerts from digest cache (Redis — accumulated across all cycles today)
  if (data.topAlerts.length > 0) {
    const topSummary = data.topAlerts.slice(0, 10).map(a => {
      const entityStr = (a.entities || []).join(', ');
      const sources = a.sourceCount || 0;
      return `- [${a.severity}] ${entityStr} (conf: ${a.confidence}, ${sources} sources)`;
    }).join('\n');
    sections.push(`TOP EVENTS TODAY (from ${data.topAlerts.length} promoted events):\n${topSummary}`);
  }

  // Entity activity from digest cache (Redis — frequency counts)
  const entityEntries = Object.entries(data.entityCounts || {});
  if (entityEntries.length > 0) {
    const topEntities = entityEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([entity, count]) => `- ${entity}: ${count} mentions`)
      .join('\n');
    sections.push(`ENTITY ACTIVITY (top 15 by frequency):\n${topEntities}`);
  }

  // Source health (Redis)
  if (data.sourceHealth) {
    const degraded = Object.entries(data.sourceHealth)
      .filter(([, v]) => v.status === 'degraded' || v.consecutiveDegraded >= 2)
      .map(([name, v]) => `- ${name}: degraded (${v.detail || `${v.consecutiveDegraded || 0} empty cycles`})`);
    const failed = Object.entries(data.sourceHealth)
      .filter(([, v]) => v.status === 'failed' || v.consecutiveFailures >= 2)
      .map(([name, v]) => `- ${name}: ${v.consecutiveFailures || 0} consecutive failures`);
    const sourceGaps = [...failed, ...degraded];
    if (sourceGaps.length > 0) {
      sections.push(`SOURCE GAPS:\n${sourceGaps.join('\n')}`);
    }
  }

  if (sections.length === 0) return null;

  const systemPrompt = `You are Monitor, a senior intelligence analyst preparing the morning briefing.

Generate a DAILY INTELLIGENCE BRIEFING with these sections:

1. SECURITY OVERVIEW: Top 3 security events from the last 24h based on the alerts and top events. Lead with the most significant. Include "SO WHAT" for each.

2. MARKETS & ECONOMIC: Key market moves and what they signal. Note cross-domain connections (e.g., defense stocks up + conflict news).

3. ENTITY ACTIVITY: Which entities dominated today's intelligence cycle and what patterns are visible in the frequency data.

4. 24-HOUR OUTLOOK: What to watch today with specific, measurable indicators.

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

  // Provider cascade — try fastest first
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
        signal: AbortSignal.timeout(8_000),
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

  // MARKETS section (live data)
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

  // PREDICTION MARKETS section (live data)
  if (data.predictions.length > 0) {
    parts.push('*PREDICTION MARKETS*');
    for (const m of data.predictions.slice(0, 5)) {
      parts.push(escapeMarkdown(`${m.title}: ${m.probability}%`));
    }
    parts.push('');
  }

  // KEY DEVELOPMENTS section (from Redis cache — replaces old headlines/CISA/etc)
  if (data.recentAlerts.length > 0) {
    parts.push('*KEY DEVELOPMENTS \\(24h\\)*');
    const alerts = data.recentAlerts.slice(-5);
    for (const alert of alerts) {
      const title = typeof alert === 'string' ? alert : alert.title;
      const severity = typeof alert === 'object' ? alert.severity : '';
      const sevLabel = severity ? `[${severity}] ` : '';
      parts.push(escapeMarkdown(`- ${sevLabel}${title}`));
    }
    parts.push('');
  }

  // ENTITY ACTIVITY section (from digest cache)
  const entityEntries = Object.entries(data.entityCounts || {});
  if (entityEntries.length > 0) {
    parts.push('*ENTITY ACTIVITY*');
    const topEntities = entityEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const maxCount = topEntities[0]?.[1] || 1;
    for (const [entity, count] of topEntities) {
      // Simple bar chart using block characters
      const barLen = Math.round((count / maxCount) * 10);
      const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(10 - barLen);
      parts.push(escapeMarkdown(`${entity}: ${bar} ${count}`));
    }
    parts.push('');
  }

  // SOURCE HEALTH section (from Redis)
  if (data.sourceHealth) {
    const healthEntries = Object.entries(data.sourceHealth);
    const okCount = healthEntries.filter(([, v]) => v.status === 'ok').length;
    const degradedSources = healthEntries
      .filter(([, v]) => v.status === 'degraded' || v.consecutiveDegraded >= 2)
      .map(([name]) => name);
    const failedSources = healthEntries
      .filter(([, v]) => v.status === 'failed' || v.consecutiveFailures >= 2)
      .map(([name]) => name);

    parts.push('*SOURCE HEALTH*');
    const gaps = [...failedSources, ...degradedSources];
    if (gaps.length > 0) {
      parts.push(escapeMarkdown(`${okCount}/${healthEntries.length} healthy | Gaps: ${gaps.join(', ')}`));
    } else {
      parts.push(escapeMarkdown(`${okCount}/${healthEntries.length} sources healthy — all green`));
    }
    parts.push('');
  }

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
