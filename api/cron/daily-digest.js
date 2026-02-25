/**
 * Daily Intelligence Digest — sends a comprehensive Telegram briefing.
 *
 * v2.7.0: Upgraded from "top 5 headlines + market snapshot" to a full
 * intelligence briefing with AI analysis via Qwen 3.5 Plus. Includes
 * markets, prediction markets, signal summary, and 24h outlook.
 *
 * Runs at midnight UTC (configured in vercel.json).
 *
 * Data sources (with fallbacks):
 *   Headlines: GDELT -> Google News RSS (no key needed)
 *   Markets:   Finnhub (FINNHUB_API_KEY) -> Yahoo Finance (no key needed)
 *   Predictions: Polymarket (free, no key)
 *   AI:        Qwen 3.5 Plus -> DeepSeek V3.2 -> Groq Llama
 *
 * Required env vars:
 *   CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional:
 *   FINNHUB_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY
 */

export const config = { runtime: 'edge' };

import { fetchGeopoliticalMarkets } from '../tools/prediction-markets.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKET_SYMBOLS = ['SPY', 'QQQ', 'GLD', 'USO'];

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

  // Gather all data in parallel
  const [headlines, finnhubQuotes, yahooQuotes, predictions] = await Promise.allSettled([
    fetchHeadlines(),
    fetchFinnhubQuotes(),
    fetchYahooQuotes(),
    fetchGeopoliticalMarkets(),
  ]);

  // Use Finnhub quotes if available, else Yahoo
  const marketQuotes = (finnhubQuotes.status === 'fulfilled' && finnhubQuotes.value.length > 0)
    ? finnhubQuotes.value
    : (yahooQuotes.status === 'fulfilled' ? yahooQuotes.value : []);

  const headlineData = headlines.status === 'fulfilled' ? headlines.value : [];
  const predictionData = predictions.status === 'fulfilled' ? predictions.value : [];

  // Generate AI intelligence briefing
  const hasData = headlineData.length > 0 || marketQuotes.length > 0;
  const aiBriefing = hasData
    ? await generateIntelBriefing(headlineData, marketQuotes, predictionData)
    : null;

  // Build the message
  const message = buildDigestMessage(headlineData, marketQuotes, predictionData, aiBriefing);

  // Send to Telegram
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

      // Retry without MarkdownV2 on parse failure
      if (resp.status === 400) {
        const plainMsg = buildPlainDigest(headlineData, marketQuotes, predictionData, aiBriefing);
        await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: plainMsg,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }

      return jsonResponse(502, { error: 'Telegram API error', status: resp.status });
    }

    return jsonResponse(200, {
      ok: true,
      sections: {
        headlines: headlineData.length,
        markets: marketQuotes.length,
        predictions: predictionData.length,
        aiBriefing: !!aiBriefing,
      },
    });
  } catch (err) {
    console.error('[daily-digest] Failed to send Telegram message:', err);
    return jsonResponse(502, { error: 'Failed to reach Telegram' });
  }
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchHeadlines() {
  const gdeltHeadlines = await fetchGdeltHeadlines();
  if (gdeltHeadlines.length > 0) return gdeltHeadlines;
  console.warn('[daily-digest] GDELT failed, falling back to Google News RSS');
  return fetchGoogleNewsRss();
}

async function fetchGdeltHeadlines() {
  try {
    const resp = await fetch(GDELT_URL, { signal: AbortSignal.timeout(10_000) });
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
    const resp = await fetch(GOOGLE_NEWS_RSS, { signal: AbortSignal.timeout(8_000) });
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
      headers: { 'User-Agent': 'WorldMonitor/2.7' },
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
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AI intelligence briefing
// ---------------------------------------------------------------------------

async function generateIntelBriefing(headlines, marketQuotes, predictions) {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!openRouterKey && !groqKey) return null;

  const headlineSummary = headlines.length > 0
    ? headlines.map((h, i) => `${i + 1}. ${h.title}`).join('\n')
    : 'No headlines available.';

  const marketSummary = marketQuotes.length > 0
    ? marketQuotes.map((q) => {
        const sign = q.changePercent >= 0 ? '+' : '';
        return `${q.label}: $${q.price?.toFixed(2)} (${sign}${q.changePercent?.toFixed(2)}%)`;
      }).join('\n')
    : 'No market data.';

  const predictionSummary = predictions.length > 0
    ? predictions.slice(0, 5).map(m => `${m.title}: ${m.probability}%`).join('\n')
    : 'No prediction market data.';

  const systemPrompt = 'You are Monitor, a senior intelligence analyst. Generate a daily intelligence briefing. Provide TWO sections: 1) SITUATION: 2-3 sentences summarizing the day. Reference specific data. Flag cross-domain connections. 2) OUTLOOK: 1-2 sentences on what to watch tomorrow with specific indicators. CRITICAL: Only reference data provided. Do NOT fabricate.';

  const userPrompt = `Headlines:\n${headlineSummary}\n\nMarkets:\n${marketSummary}\n\nPrediction Markets:\n${predictionSummary}`;

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
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) continue;
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
// Message builders
// ---------------------------------------------------------------------------

function buildDigestMessage(headlines, marketQuotes, predictions, aiBriefing) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  const parts = [];
  parts.push('*DAILY INTELLIGENCE BRIEF*');
  parts.push(escapeMarkdown(dateStr));
  parts.push('');

  if (aiBriefing) {
    parts.push(escapeMarkdown(aiBriefing));
    parts.push('');
  }

  parts.push('*MARKETS*');
  if (marketQuotes.length > 0) {
    marketQuotes.forEach((quote) => {
      const arrow = quote.changePercent >= 0 ? '\u2B06' : '\u2B07';
      const sign = quote.changePercent >= 0 ? '+' : '';
      const line = `${quote.label}: $${quote.price?.toFixed(2) ?? '?'} (${sign}${quote.changePercent?.toFixed(2) ?? '?'}%) ${arrow}`;
      parts.push(escapeMarkdown(line));
    });
  } else {
    parts.push(escapeMarkdown('Market data unavailable.'));
  }
  parts.push('');

  if (predictions.length > 0) {
    parts.push('*PREDICTION MARKETS*');
    predictions.slice(0, 5).forEach((m) => {
      parts.push(escapeMarkdown(`${m.title}: ${m.probability}%`));
    });
    parts.push('');
  }

  parts.push('*TOP STORIES*');
  if (headlines.length > 0) {
    headlines.forEach((headline, index) => {
      parts.push(escapeMarkdown(`${index + 1}. ${headline.title}`));
    });
  } else {
    parts.push(escapeMarkdown('No headlines available.'));
  }
  parts.push('');

  parts.push('_Monitor is watching\\. Sleep well\\._');
  return parts.join('\n');
}

function buildPlainDigest(headlines, marketQuotes, predictions, aiBriefing) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const parts = [`DAILY INTELLIGENCE BRIEF\n${dateStr}\n`];

  if (aiBriefing) parts.push(`${aiBriefing}\n`);

  parts.push('MARKETS');
  marketQuotes.forEach(q => {
    const sign = q.changePercent >= 0 ? '+' : '';
    parts.push(`${q.label}: $${q.price?.toFixed(2)} (${sign}${q.changePercent?.toFixed(2)}%)`);
  });
  parts.push('');

  if (predictions.length > 0) {
    parts.push('PREDICTION MARKETS');
    predictions.slice(0, 5).forEach(m => parts.push(`${m.title}: ${m.probability}%`));
    parts.push('');
  }

  parts.push('TOP STORIES');
  headlines.forEach((h, i) => parts.push(`${i + 1}. ${h.title}`));
  parts.push('\nMonitor is watching. Sleep well.');
  return parts.join('\n');
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
