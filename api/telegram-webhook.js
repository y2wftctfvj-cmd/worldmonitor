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

  // Restrict to specific chat ID to prevent LLM quota abuse
  const allowedChatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (allowedChatId && String(chatId) !== allowedChatId) {
    console.warn(`[telegram-webhook] Blocked chatId ${chatId} (allowed: ${allowedChatId})`);
    return new Response('OK', { status: 200 });
  }

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
 * Fetch lightweight server-side context: headlines + markets + Reddit OSINT.
 * All public APIs, no keys needed. Failures are non-fatal.
 */
async function fetchContext() {
  const sections = [];

  // Fetch all four data sources in parallel
  const [headlines, quotes, reddit, telegram] = await Promise.allSettled([
    fetchGoogleNewsHeadlines(),
    fetchMarketQuotes(),
    fetchRedditOsint(),
    fetchTelegramOsint(),
  ]);

  if (headlines.status === 'fulfilled' && headlines.value) {
    sections.push(`HEADLINES:\n${headlines.value}`);
  }

  if (quotes.status === 'fulfilled' && quotes.value) {
    sections.push(`MARKETS:\n${quotes.value}`);
  }

  if (reddit.status === 'fulfilled' && reddit.value) {
    sections.push(`REDDIT OSINT:\n${reddit.value}`);
  }

  if (telegram.status === 'fulfilled' && telegram.value) {
    sections.push(`TELEGRAM OSINT:\n${telegram.value}`);
  }

  if (sections.length === 0) {
    return 'No live data available right now.';
  }

  return sections.join('\n\n');
}

/**
 * Fetch 10 recent headlines from Google News RSS.
 * Free, no key, always available. Uses the "World" topic feed.
 */
async function fetchGoogleNewsHeadlines() {
  const rssUrl =
    'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en';

  const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) return null;

  const xml = await resp.text();

  // Parse RSS items with simple regex (Edge runtime has no DOMParser)
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

  // Yahoo returns a flat object: { "^GSPC": { close: [...], chartPreviousClose: N }, ... }
  const lines = [];
  for (const symbol of symbols) {
    const quote = data?.[symbol];
    if (!quote) continue;

    const name = names[symbol] || symbol;
    const closeArr = quote.close;
    const price = Array.isArray(closeArr) && closeArr.length > 0
      ? closeArr[closeArr.length - 1]
      : null;
    if (price == null) continue;

    const prevClose = quote.chartPreviousClose || quote.previousClose;
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
 * Fetch latest messages from public Telegram OSINT channels.
 * Scrapes t.me/s/{channel} (public web preview) and extracts message text.
 * Same channels as the dashboard OSINT panel.
 */
async function fetchTelegramOsint() {
  const channels = ['intelslava', 'militarysummary', 'RVvoenkor', 'breakingmash', 'legitimniy'];

  // Fetch all channels in parallel
  const results = await Promise.allSettled(
    channels.map(async (channel) => {
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

      // Parse message text from Telegram's widget HTML
      const posts = [];
      const blocks = html.split('tgme_widget_message_wrap');
      for (const block of blocks) {
        // Extract message text from the widget div
        const textMatch = block.match(
          /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*tgme_widget_message_(?:footer|info)/
        );
        if (!textMatch) continue;

        // Strip HTML tags to get plain text
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
          // Truncate long messages to keep context compact
          const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
          posts.push({ channel, text: truncated });
        }
      }

      // Return only the 3 most recent messages per channel
      return posts.slice(-3);
    })
  );

  const allPosts = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  if (allPosts.length === 0) return null;

  // Take the last 10 messages across all channels (most recent)
  return allPosts
    .slice(-10)
    .map((p) => `- [${p.channel}] ${p.text}`)
    .join('\n');
}

/**
 * Fetch top posts from geopolitical subreddits via Reddit's public JSON API.
 * Same sources as the dashboard OSINT panel: worldnews, geopolitics, osint, CredibleDefense.
 */
async function fetchRedditOsint() {
  const subreddits = ['worldnews', 'geopolitics', 'osint', 'CredibleDefense'];
  const postsPerSub = 5;

  // Fetch all subreddits in parallel
  const results = await Promise.allSettled(
    subreddits.map(async (sub) => {
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${postsPerSub}&raw_json=1`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'WorldMonitor/1.0' },
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

  // Merge all posts, sort by score, take top 10
  const allPosts = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (allPosts.length === 0) return null;

  return allPosts
    .map((p) => `- [r/${p.sub}, ${p.score}pts] ${p.title}`)
    .join('\n');
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
