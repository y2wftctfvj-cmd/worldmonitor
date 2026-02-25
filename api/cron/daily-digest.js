/**
 * Daily Digest Cron — sends an evening Telegram summary.
 *
 * Runs at midnight UTC (configured in vercel.json).
 * Combines top headlines, market data, and a short AI insight
 * into a single Telegram MarkdownV2 message.
 *
 * Data sources (with fallbacks):
 *   Headlines: GDELT → Google News RSS (no key needed)
 *   Markets:   Finnhub (FINNHUB_API_KEY) → Yahoo Finance (no key needed)
 *   AI:        Groq → OpenRouter (only runs when data is available)
 *
 * Required env vars:
 *   CRON_SECRET          — Vercel cron auth (Bearer token)
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHAT_ID     — your numeric chat id
 *
 * Optional env vars (degrade gracefully if missing):
 *   FINNHUB_API_KEY      — market quotes via Finnhub (falls back to Yahoo)
 *   GROQ_API_KEY         — AI insight via Llama 3.1
 *   OPENROUTER_API_KEY   — AI fallback via OpenRouter
 */

export const config = { runtime: 'edge' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Symbols to fetch market quotes for */
const MARKET_SYMBOLS = ['SPY', 'QQQ', 'GLD', 'USO'];

/** Human-readable labels for each symbol */
const SYMBOL_LABELS = {
  SPY: 'S&P 500',
  QQQ: 'Nasdaq 100',
  GLD: 'Gold',
  USO: 'Oil',
};

/** Yahoo Finance symbol mapping (different format from Finnhub) */
const YAHOO_SYMBOLS = {
  SPY: 'SPY',
  QQQ: 'QQQ',
  GLD: 'GLD',
  USO: 'USO',
};

/** GDELT endpoint — top 5 English headlines sorted by hybrid relevance */
const GDELT_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang:eng&mode=artlist&maxrecords=5&format=json&sort=hybridrel';

/** Google News RSS — World topic feed (free, no key needed) */
const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(request) {
  // --- 1. Authenticate: only Vercel's cron scheduler should hit this ---
  const expectedToken = process.env.CRON_SECRET;
  if (
    !expectedToken ||
    request.headers.get('authorization') !== `Bearer ${expectedToken}`
  ) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  // --- 2. Ensure Telegram is configured ---
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return jsonResponse(503, { error: 'Telegram not configured' });
  }

  // --- 3. Gather data in parallel: headlines + market quotes ---
  const [headlines, marketQuotes] = await Promise.all([
    fetchHeadlines(),
    fetchMarketSnapshot(),
  ]);

  // --- 4. Generate AI insight ONLY when we have real data ---
  // Without data the LLM hallucinates fake assessments
  const hasData = headlines.length > 0 || marketQuotes.length > 0;
  const aiInsight = hasData ? await generateAiInsight(headlines, marketQuotes) : null;

  // --- 5. Build the Telegram message ---
  const message = buildDigestMessage(headlines, marketQuotes, aiInsight);

  // --- 6. Send via Telegram Bot API ---
  try {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('[daily-digest] Telegram API error:', resp.status, errBody);
      return jsonResponse(502, { error: 'Telegram API error', status: resp.status });
    }

    return jsonResponse(200, { ok: true, sections: { headlines: headlines.length, markets: marketQuotes.length, aiInsight: !!aiInsight } });
  } catch (err) {
    console.error('[daily-digest] Failed to send Telegram message:', err);
    return jsonResponse(502, { error: 'Failed to reach Telegram' });
  }
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch top headlines: try GDELT first, fall back to Google News RSS.
 * Returns an array of { title, url } objects (may be empty on failure).
 */
async function fetchHeadlines() {
  // Try GDELT first (richer data with URLs)
  const gdeltHeadlines = await fetchGdeltHeadlines();
  if (gdeltHeadlines.length > 0) return gdeltHeadlines;

  // Fallback: Google News RSS (free, no key, always available)
  console.warn('[daily-digest] GDELT failed, falling back to Google News RSS');
  return fetchGoogleNewsHeadlines();
}

/**
 * Fetch top 5 headlines from GDELT's article list API.
 */
async function fetchGdeltHeadlines() {
  try {
    const resp = await fetch(GDELT_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.error('[daily-digest] GDELT returned', resp.status);
      return [];
    }
    const data = await resp.json();
    const articles = data?.articles ?? [];
    return articles.slice(0, 5).map((article) => ({
      title: article.title ?? 'Untitled',
      url: article.url ?? '',
    }));
  } catch (err) {
    console.error('[daily-digest] GDELT fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch top headlines from Google News RSS (free, no key needed).
 * Same approach used in telegram-webhook.js.
 */
async function fetchGoogleNewsHeadlines() {
  try {
    const resp = await fetch(GOOGLE_NEWS_RSS, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];

    const xml = await resp.text();

    // Parse RSS items with simple regex (Edge runtime has no DOMParser)
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
    const linkPattern = /<link>(.*?)<\/link>/;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 5) {
      const titleMatch = itemMatch[0].match(titlePattern);
      const linkMatch = itemMatch[0].match(linkPattern);
      const title = titleMatch?.[1] || titleMatch?.[2];
      if (title) {
        items.push({
          title,
          url: linkMatch?.[1] || '',
        });
      }
    }

    return items;
  } catch (err) {
    console.error('[daily-digest] Google News RSS failed:', err.message);
    return [];
  }
}

/**
 * Fetch market quotes: try Finnhub first, fall back to Yahoo Finance.
 * Returns an array of { symbol, label, price, changePercent } objects.
 */
async function fetchMarketSnapshot() {
  // Try Finnhub first (needs API key)
  const finnhubQuotes = await fetchFinnhubQuotes();
  if (finnhubQuotes.length > 0) return finnhubQuotes;

  // Fallback: Yahoo Finance (free, no key needed)
  console.warn('[daily-digest] Finnhub unavailable, falling back to Yahoo Finance');
  return fetchYahooQuotes();
}

/**
 * Fetch quotes from Finnhub (requires FINNHUB_API_KEY).
 */
async function fetchFinnhubQuotes() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];

  const results = await Promise.all(
    MARKET_SYMBOLS.map(async (symbol) => {
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
      } catch (err) {
        console.error(`[daily-digest] Finnhub ${symbol} failed:`, err.message);
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

/**
 * Fetch quotes from Yahoo Finance v8 spark API (free, no key needed).
 * Same approach used in telegram-webhook.js.
 */
async function fetchYahooQuotes() {
  try {
    const symbols = Object.values(YAHOO_SYMBOLS).join(',');
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=1d&interval=1d`;

    const resp = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'WorldMonitor/1.0' },
      signal: AbortSignal.timeout(8_000),
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
  } catch (err) {
    console.error('[daily-digest] Yahoo Finance failed:', err.message);
    return [];
  }
}

/**
 * Ask Groq (primary) or OpenRouter (fallback) for a 2-sentence insight.
 * Only called when we have real data — never with empty headlines + markets.
 * Returns a string or null if AI is unavailable / fails.
 */
async function generateAiInsight(headlines, marketQuotes) {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!groqKey && !openRouterKey) {
    console.warn('[daily-digest] No AI provider configured — skipping insight');
    return null;
  }

  const headlineSummary = headlines.length > 0
    ? headlines.map((h, i) => `${i + 1}. ${h.title}`).join('\n')
    : 'No headlines available.';

  const marketSummary = marketQuotes.length > 0
    ? marketQuotes.map((q) => `${q.label} (${q.symbol}): $${q.price?.toFixed(2)} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent?.toFixed(2) ?? '?'}%)`).join('\n')
    : 'No market data available.';

  const systemPrompt = `You are Monitor, a senior intelligence analyst. Given today's headlines and market data, provide a 2-sentence intelligence assessment. Be direct, reference specific data points, and flag anything that warrants overnight watch. Sign off with a single actionable recommendation. CRITICAL: Only reference data provided below. If a section says "No data available", do NOT make up information for that section.`;
  const userPrompt = `Given today's top headlines:\n${headlineSummary}\n\nAnd market data:\n${marketSummary}\n\nProvide your intelligence assessment.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // Try Groq first, then OpenRouter
  const providers = [];
  if (groqKey) {
    providers.push({
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      apiKey: groqKey,
    });
  }
  if (openRouterKey) {
    providers.push({
      name: 'OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      apiKey: openRouterKey,
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
          max_tokens: 150,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        console.error(`[daily-digest] ${provider.name} returned`, resp.status);
        continue;
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch (err) {
      console.error(`[daily-digest] ${provider.name} failed:`, err.message);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Build a Telegram MarkdownV2 message with three sections:
 *   1. TOP STORIES — numbered list of headlines
 *   2. MARKETS     — symbol prices with change arrows
 *   3. AI INSIGHT  — two-sentence analysis
 *
 * All dynamic text is escaped to avoid MarkdownV2 parsing errors.
 */
function buildDigestMessage(headlines, marketQuotes, aiInsight) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  const parts = [];

  // Header
  parts.push(`*MONITOR \u2014 Evening Brief*`);
  parts.push(escapeMarkdown(dateStr));
  parts.push('');

  // --- TOP STORIES ---
  parts.push('*TOP STORIES*');
  if (headlines.length > 0) {
    headlines.forEach((headline, index) => {
      const number = escapeMarkdown(`${index + 1}.`);
      const title = escapeMarkdown(headline.title);
      parts.push(`${number} ${title}`);
    });
  } else {
    parts.push(escapeMarkdown('No headlines available.'));
  }
  parts.push('');

  // --- MARKETS ---
  parts.push('*MARKETS*');
  if (marketQuotes.length > 0) {
    marketQuotes.forEach((quote) => {
      const arrow = quote.changePercent >= 0 ? '\u2B06' : '\u2B07';
      const sign = quote.changePercent >= 0 ? '+' : '';
      const changeStr = `${sign}${quote.changePercent?.toFixed(2) ?? '?'}%`;
      const priceStr = `$${quote.price?.toFixed(2) ?? '?'}`;
      const line = `${quote.label}: ${priceStr} (${changeStr}) ${arrow}`;
      parts.push(escapeMarkdown(line));
    });
  } else {
    parts.push(escapeMarkdown('Market data unavailable.'));
  }
  parts.push('');

  // --- AI INSIGHT ---
  parts.push('*INTELLIGENCE ASSESSMENT*');
  if (aiInsight) {
    parts.push(escapeMarkdown(aiInsight));
  } else {
    parts.push(escapeMarkdown('Insufficient data for assessment.'));
  }
  parts.push('');
  parts.push('_Monitor is watching\\. Sleep well\\._');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Shorthand for returning a JSON Response with a given status code.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
