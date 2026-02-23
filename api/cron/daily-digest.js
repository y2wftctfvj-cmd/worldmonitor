/**
 * Daily Digest Cron — sends an evening Telegram summary.
 *
 * Runs at midnight UTC (configured in vercel.json).
 * Combines top headlines, market data, and a short AI insight
 * into a single Telegram MarkdownV2 message.
 *
 * Required env vars:
 *   CRON_SECRET          — Vercel cron auth (Bearer token)
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHAT_ID     — your numeric chat id
 *
 * Optional env vars (degrade gracefully if missing):
 *   FINNHUB_API_KEY      — market quotes for SPY, QQQ, GLD, USO
 *   GROQ_API_KEY         — AI insight via Llama 3.1
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

/** GDELT endpoint — top 5 English headlines sorted by hybrid relevance */
const GDELT_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang:eng&mode=artlist&maxrecords=5&format=json&sort=hybridrel';

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

  // --- 4. Generate AI insight (needs both headlines and market data) ---
  const aiInsight = await generateAiInsight(headlines, marketQuotes);

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
 * Fetch top 5 headlines from GDELT's article list API.
 * Returns an array of { title, url } objects (may be empty on failure).
 */
async function fetchHeadlines() {
  try {
    const resp = await fetch(GDELT_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.error('[daily-digest] GDELT returned', resp.status);
      return [];
    }
    const data = await resp.json();
    // GDELT returns { articles: [ { title, url, ... }, ... ] }
    const articles = data?.articles ?? [];
    return articles.slice(0, 5).map((article) => ({
      title: article.title ?? 'Untitled',
      url: article.url ?? '',
    }));
  } catch (err) {
    console.error('[daily-digest] GDELT fetch failed:', err);
    return [];
  }
}

/**
 * Fetch quotes for SPY, QQQ, GLD, USO from Finnhub in parallel.
 * Returns an array of { symbol, label, price, changePercent } objects.
 * Skips symbols that fail or returns empty if FINNHUB_API_KEY is missing.
 */
async function fetchMarketSnapshot() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.warn('[daily-digest] FINNHUB_API_KEY not set — skipping market data');
    return [];
  }

  // Fetch all symbols in parallel, each with its own 5s timeout
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
        // c = current price, dp = percent change from previous close
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

  // Filter out any failed fetches
  return results.filter(Boolean);
}

/**
 * Ask Groq (Llama 3.1 8B) for a 2-sentence insight connecting
 * today's headlines to market movements.
 * Returns a string or null if AI is unavailable / fails.
 */
async function generateAiInsight(headlines, marketQuotes) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.warn('[daily-digest] GROQ_API_KEY not set — skipping AI insight');
    return null;
  }

  // Build a concise prompt with the data we gathered
  const headlineSummary = headlines.length > 0
    ? headlines.map((h, i) => `${i + 1}. ${h.title}`).join('\n')
    : 'No headlines available.';

  const marketSummary = marketQuotes.length > 0
    ? marketQuotes.map((q) => `${q.label} (${q.symbol}): $${q.price} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent?.toFixed(2) ?? '?'}%)`).join('\n')
    : 'No market data available.';

  const systemPrompt = 'You are Monitor, a senior intelligence analyst. Given today\'s headlines and market data, provide a 2-sentence intelligence assessment. Be direct, reference specific data points, and flag anything that warrants overnight watch. Sign off with a single actionable recommendation.';
  const userPrompt = `Given today's top headlines:\n${headlineSummary}\n\nAnd market data:\n${marketSummary}\n\nProvide your intelligence assessment.`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.error('[daily-digest] Groq returned', resp.status);
      return null;
    }

    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.error('[daily-digest] Groq fetch failed:', err);
    return null;
  }
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
  // Header with today's date (UTC)
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
  parts.push(''); // blank line

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
  parts.push(''); // blank line

  // --- MARKETS ---
  parts.push('*MARKETS*');
  if (marketQuotes.length > 0) {
    marketQuotes.forEach((quote) => {
      // Arrow emoji based on positive/negative change
      const arrow = quote.changePercent >= 0 ? '\u2B06' : '\u2B07'; // up/down arrow
      const sign = quote.changePercent >= 0 ? '+' : '';
      const changeStr = `${sign}${quote.changePercent?.toFixed(2) ?? '?'}%`;
      const priceStr = `$${quote.price?.toFixed(2) ?? '?'}`;
      const line = `${quote.label}: ${priceStr} (${changeStr}) ${arrow}`;
      parts.push(escapeMarkdown(line));
    });
  } else {
    parts.push(escapeMarkdown('Market data unavailable.'));
  }
  parts.push(''); // blank line

  // --- AI INSIGHT ---
  parts.push('*INTELLIGENCE ASSESSMENT*');
  if (aiInsight) {
    parts.push(escapeMarkdown(aiInsight));
  } else {
    parts.push(escapeMarkdown('AI insight unavailable.'));
  }
  parts.push(''); // blank line
  parts.push('_Monitor is watching\\. Sleep well\\._');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Escape special characters for Telegram MarkdownV2.
 * Same pattern used in telegram-alert.js.
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
