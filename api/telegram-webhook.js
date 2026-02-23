/**
 * Telegram Webhook — lets users chat with Monitor via Telegram.
 *
 * Telegram sends a POST with an Update object whenever someone messages the bot.
 * We validate the request, fetch lightweight context (GDELT headlines + market quotes),
 * run it through Groq/OpenRouter with the Monitor persona, and reply via Bot API.
 *
 * Auth: secret token passed as ?token= query param (must match CRON_SECRET).
 * Stateless: no conversation history across messages.
 *
 * Setup (one-time):
 *   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://worldmonitor.app/api/telegram-webhook?token=${CRON_SECRET}"
 */

export const config = { runtime: 'edge' };

// --- LLM settings (same as chat.js) ---
const TEMPERATURE = 0.3;
const MAX_TOKENS = 500;
const LLM_TIMEOUT_MS = 15000;

// --- Telegram message length cap ---
const TELEGRAM_MAX_LENGTH = 4096;

// --- Monitor persona (same as chat.js) ---
const SYSTEM_PROMPT = `You are Monitor, a senior intelligence analyst for World Monitor.

RULES:
- Every claim MUST reference dashboard data provided in context. No speculation without evidence.
- If data is stale (>2h old), say so explicitly.
- Lead with the answer, then supporting evidence.
- Flag cross-domain connections proactively (e.g., military + shipping + oil = escalation signal).
- When uncertain, give probability ranges, not certainties.
- Be concise. 2-4 sentences for simple questions, up to a paragraph for analysis.
- Never start with "I'd be happy to help" or similar filler.
- If asked about something not in the dashboard context, say "I don't have data on that right now."
- Format for Telegram: use *bold* for emphasis, keep paragraphs short.`;

export default async function handler(request) {
  // Only accept POST (Telegram always POSTs)
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // --- Validate secret token to prevent unauthorized access ---
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || token !== cronSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  // --- Verify Telegram + LLM providers are configured ---
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('[telegram-webhook] TELEGRAM_BOT_TOKEN not set');
    return new Response('Bot not configured', { status: 503 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!groqKey && !openRouterKey) {
    console.error('[telegram-webhook] No LLM provider configured');
    return new Response('AI not configured', { status: 503 });
  }

  // --- Parse the Telegram Update ---
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Only handle text messages (ignore photos, stickers, edits, callbacks, etc.)
  const message = update?.message;
  if (!message?.text || !message?.chat?.id) {
    // Return 200 so Telegram doesn't retry non-text updates
    return new Response('OK', { status: 200 });
  }

  const chatId = message.chat.id;
  const userText = message.text.trim();

  // Ignore empty messages
  if (!userText) {
    return new Response('OK', { status: 200 });
  }

  // Cap user message at 2000 chars to prevent abuse
  const truncatedText = userText.length > 2000 ? userText.slice(0, 2000) : userText;

  try {
    // --- Fetch lightweight context in parallel ---
    const context = await fetchContext();

    // --- Build LLM messages ---
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: `CURRENT INTELLIGENCE DATA:\n${context}` },
      { role: 'user', content: truncatedText },
    ];

    // --- Call Groq (primary) → OpenRouter (fallback) ---
    const reply = await callLLM(messages, groqKey, openRouterKey);

    // --- Send reply back to Telegram ---
    await sendTelegramMessage(botToken, chatId, reply);

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('[telegram-webhook] Error:', err.message || err);

    // Try to send an error message to the user so they know something went wrong
    try {
      await sendTelegramMessage(
        botToken,
        chatId,
        'Monitor is temporarily offline. Try again in a moment.'
      );
    } catch {
      // If even the error message fails, just log it
      console.error('[telegram-webhook] Failed to send error message to user');
    }

    return new Response('OK', { status: 200 });
  }
}

/**
 * Fetch lightweight server-side context: GDELT headlines + market quotes.
 * Both are public APIs, no keys needed. Failures are non-fatal.
 */
async function fetchContext() {
  const sections = [];

  // Fetch GDELT headlines and market quotes in parallel
  const [headlines, quotes] = await Promise.allSettled([
    fetchGdeltHeadlines(),
    fetchMarketQuotes(),
  ]);

  if (headlines.status === 'fulfilled' && headlines.value) {
    sections.push(`HEADLINES:\n${headlines.value}`);
  }

  if (quotes.status === 'fulfilled' && quotes.value) {
    sections.push(`MARKETS:\n${quotes.value}`);
  }

  if (sections.length === 0) {
    return 'No live data available right now.';
  }

  return sections.join('\n\n');
}

/**
 * Fetch 10 recent headlines from GDELT DOC API.
 * Free, no key, returns global news sorted by relevance.
 */
async function fetchGdeltHeadlines() {
  const gdeltUrl =
    'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang:english&mode=artlist&maxrecords=10&format=json&sort=datedesc';

  const resp = await fetch(gdeltUrl, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) return null;

  const data = await resp.json();
  const articles = data?.articles;
  if (!Array.isArray(articles) || articles.length === 0) return null;

  // Format: "- Title (source, date)"
  return articles
    .map((a) => `- ${a.title} (${a.domain}, ${a.seendate?.slice(0, 10) || 'recent'})`)
    .join('\n');
}

/**
 * Fetch key market quotes from Yahoo Finance v8 API (public, no key).
 * Covers: S&P 500, oil, gold, 10Y treasury, VIX.
 */
async function fetchMarketQuotes() {
  const symbols = ['^GSPC', 'CL=F', 'GC=F', '^TNX', '^VIX'];
  const names = { '^GSPC': 'S&P 500', 'CL=F': 'Oil (WTI)', 'GC=F': 'Gold', '^TNX': '10Y Yield', '^VIX': 'VIX' };

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols.join(',')}&range=1d&interval=1d`;

  const resp = await fetch(yahooUrl, {
    headers: { 'User-Agent': 'WorldMonitor/1.0' },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  const results = data?.spark?.result;
  if (!Array.isArray(results)) return null;

  // Format each quote as "- Name: price (change%)"
  const lines = [];
  for (const item of results) {
    const symbol = item.symbol;
    const name = names[symbol] || symbol;
    const meta = item.response?.[0]?.meta;
    if (!meta) continue;

    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    if (price == null) continue;

    let changeStr = '';
    if (prevClose && prevClose !== 0) {
      const changePct = ((price - prevClose) / prevClose) * 100;
      changeStr = ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
    }

    lines.push(`- ${name}: ${price.toFixed(2)}${changeStr}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Call Groq (primary) then OpenRouter (fallback).
 * Returns the LLM reply text or throws if both fail.
 */
async function callLLM(messages, groqKey, openRouterKey) {
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
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${provider.name} returned ${resp.status}: ${errBody}`);
      }

      const data = await resp.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (!reply) {
        throw new Error(`${provider.name} returned no content`);
      }

      return reply;
    } catch (err) {
      console.error(`[telegram-webhook] ${provider.name} failed:`, err.message || err);
    }
  }

  throw new Error('All LLM providers failed');
}

/**
 * Send a text message to a Telegram chat via Bot API.
 * Uses Markdown parse mode. Truncates to 4096 chars (Telegram limit).
 */
async function sendTelegramMessage(botToken, chatId, text) {
  // Truncate if needed (Telegram's hard limit is 4096 chars)
  const truncated = text.length > TELEGRAM_MAX_LENGTH
    ? text.slice(0, TELEGRAM_MAX_LENGTH - 3) + '...'
    : text;

  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: truncated,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    // If Markdown parsing fails, retry without parse_mode
    if (resp.status === 400 && errBody.includes("can't parse")) {
      const retryResp = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: truncated,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!retryResp.ok) {
        throw new Error(`Telegram retry failed: ${retryResp.status}`);
      }
      return;
    }
    throw new Error(`Telegram API error ${resp.status}: ${errBody}`);
  }
}
