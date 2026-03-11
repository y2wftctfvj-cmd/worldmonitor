/**
 * Telegram Webhook — lets users chat with Monitor via Telegram.
 *
 * v2.8.0: Extracted commands, memory, sender, and LLM tools into separate modules.
 *
 * Auth: Telegram's X-Telegram-Bot-Api-Secret-Token header (set via setWebhook).
 *   Falls back to ?token= query param for backwards compatibility.
 *
 * Commands: /watch, /unwatch, /watches, /brief, /status, /clear,
 *           /history, /anomalies, /convergence, /sitrep
 *
 * Setup (one-time):
 *   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://worldmonitor-two-kappa.vercel.app/api/telegram-webhook&secret_token=${CRON_SECRET}"
 */

export const config = { runtime: 'edge' };

import {
  TOOL_DEFINITIONS,
  fetchGoogleNewsHeadlines,
  fetchMarketQuotes,
  fetchAllTelegramChannels,
  fetchAllRedditPosts,
  fetchTopicNews,
} from './_tools/monitor-tools.js';

import { loadWatchlist } from './_tools/redis-helpers.js';
import { routeCommand } from './_tools/telegram-commands/index.js';
import { loadHistory, appendHistory, clearHistory } from './_tools/conversation-memory.js';
import { sendTelegramMessage } from './_tools/telegram-sender.js';
import { callLLMWithTools } from './_tools/llm-tools-caller.js';

// ---------------------------------------------------------------------------
// LLM settings
// ---------------------------------------------------------------------------
const TEMPERATURE = 0.3;
const MAX_TOKENS = 2000;
const LLM_TIMEOUT_MS = 18000;

// ---------------------------------------------------------------------------
// Monitor persona
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Monitor, a senior intelligence analyst.

IDENTITY:
- Direct, concise, data-driven. No filler.
- You think in probabilities and leading indicators.
- You proactively flag cross-domain connections nobody asked about.
- You challenge assumptions when evidence contradicts them.

CAPABILITIES:
- You have 14 tools: news search, market data, Telegram OSINT, Reddit OSINT, prediction markets, earthquake data (live + historical by region), military flight tracking (ADS-B with callsign detection), OFAC sanctions search, maritime vessel tracking, and ACLED armed conflict events database.
- For conflicts and violence, ALWAYS use search_conflict_events first — ACLED is the gold standard for battles, explosions, protests, and political violence worldwide. Specify country or region.
- When asked about a person, organization, or entity, use search_sanctions to check OFAC status and search_predictions_market for market-implied probabilities.
- For military situations, use track_flights for real ADS-B data alongside check_flights for news context.
- For earthquake analysis, use search_earthquakes for historical data by region, not just check_earthquakes for the last hour.
- For maritime chokepoints (Strait of Hormuz, Red Sea, South China Sea), use track_maritime.
- You remember conversations for 48 hours.
- You maintain watchlists that trigger proactive alerts.
- When analyzing a situation, always consider: What are the precursors? What would escalation look like? What are the leading indicators to watch?

ANALYSIS FRAMEWORK:
- Cite your source for every claim (which feed/tool provided it)
- Flag data age: if >2h old, say so
- When 2+ unrelated signals converge on the same region/topic, highlight it as a convergence signal and explain why it matters
- Give probability ranges, not certainties
- Always end analysis with: "Watch for:" + 2-3 specific next indicators

FORMAT: Telegram. Use *bold* for key points. Short paragraphs.
Never start with "I'd be happy to help" or similar filler.`;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Validate secret token — prefer Telegram's header, fall back to query param
  const cronSecret = process.env.CRON_SECRET;
  const headerToken = request.headers.get('x-telegram-bot-api-secret-token');
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  const token = headerToken || queryToken;
  if (!cronSecret || token !== cronSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Verify Telegram + LLM providers are configured
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('[telegram-webhook] TELEGRAM_BOT_TOKEN not set');
    return new Response('Bot not configured', { status: 503 });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!openRouterKey && !groqKey) {
    console.error('[telegram-webhook] No LLM provider configured');
    return new Response('AI not configured', { status: 503 });
  }

  // Redis config for conversation memory + watchlist
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Parse the Telegram Update
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Only handle text messages
  const message = update?.message;
  if (!message?.text || !message?.chat?.id) {
    return new Response('OK', { status: 200 });
  }

  const chatId = message.chat.id;

  // Restrict to specific chat ID
  const allowedChatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (allowedChatId && String(chatId) !== allowedChatId) {
    console.warn(`[telegram-webhook] Blocked chatId ${chatId} (allowed: ${allowedChatId})`);
    return new Response('OK', { status: 200 });
  }

  const userText = message.text.trim();
  if (!userText) {
    return new Response('OK', { status: 200 });
  }

  // Cap user message at 2000 chars
  const truncatedText = userText.length > 2000 ? userText.slice(0, 2000) : userText;

  try {
    // Command context shared across all command handlers
    const ctx = { chatId, botToken, redisUrl, redisToken, openRouterKey, groqKey, sendMessage: sendTelegramMessage };

    // Handle /clear inline (it's a one-liner)
    if (truncatedText.toLowerCase().trim() === '/clear') {
      await clearHistory(chatId, redisUrl, redisToken);
      await sendTelegramMessage(botToken, chatId, 'Conversation history cleared.');
      return new Response('OK', { status: 200 });
    }

    // Route slash commands to their handlers
    const commandHandled = await routeCommand(truncatedText, ctx);
    if (commandHandled) {
      return new Response('OK', { status: 200 });
    }

    // --- Conversational reply flow ---
    const history = await loadHistory(chatId, redisUrl, redisToken);
    const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
    const context = await fetchContext(truncatedText);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: buildContextMessage(context, watchlist) },
      ...history,
      { role: 'user', content: truncatedText },
    ];

    const reply = await callLLMWithTools(messages, openRouterKey, groqKey, callLLMRaw);

    // Save conversation turn to Redis
    await appendHistory(chatId, 'user', truncatedText, redisUrl, redisToken);
    await appendHistory(chatId, 'assistant', reply, redisUrl, redisToken);

    await sendTelegramMessage(botToken, chatId, reply);

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('[telegram-webhook] Error:', err.message || err);

    try {
      await sendTelegramMessage(
        botToken,
        chatId,
        'Monitor is temporarily offline. Try again in a moment.'
      );
    } catch {
      console.error('[telegram-webhook] Failed to send error message to user');
    }

    return new Response('OK', { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

/**
 * Fetch lightweight context for a conversational reply.
 */
async function fetchContext(userQuery = '') {
  const sections = [];

  const [headlines, quotes, reddit, telegram, topicNews] = await Promise.allSettled([
    fetchGoogleNewsHeadlines(),
    fetchMarketQuotes(),
    fetchAllRedditPosts(),
    fetchAllTelegramChannels(),
    fetchTopicNews(userQuery),
  ]);

  if (topicNews.status === 'fulfilled' && topicNews.value) {
    sections.push(`TOPIC-SPECIFIC NEWS:\n${topicNews.value}`);
  }
  if (headlines.status === 'fulfilled' && headlines.value) {
    sections.push(`HEADLINES:\n${headlines.value}`);
  }
  if (quotes.status === 'fulfilled' && quotes.value) {
    sections.push(`MARKETS:\n${quotes.value}`);
  }
  if (reddit.status === 'fulfilled' && reddit.value?.length > 0) {
    const redditStr = reddit.value.slice(0, 10).map(p => `- [r/${p.sub}, ${p.score}pts] ${p.title}`).join('\n');
    sections.push(`REDDIT OSINT:\n${redditStr}`);
  }
  if (telegram.status === 'fulfilled' && telegram.value?.length > 0) {
    const telegramStr = telegram.value.slice(-15).map(p => `- [${p.channel}] ${p.text}`).join('\n');
    sections.push(`TELEGRAM OSINT:\n${telegramStr}`);
  }

  if (sections.length === 0) return 'No live data available right now.';

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return `DATA FETCHED AT: ${now}\n\n${sections.join('\n\n')}`;
}

/**
 * Build the context system message including watchlist.
 */
function buildContextMessage(context, watchlist) {
  let msg = `CURRENT INTELLIGENCE DATA:\n${context}`;
  if (watchlist.length > 0) {
    msg += `\n\nUSER WATCHLIST:\n${watchlist.map(w => `- "${w.term}"`).join('\n')}`;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Raw LLM call — provider cascade
// ---------------------------------------------------------------------------

/**
 * Make a raw LLM API call. Returns the full response JSON.
 * Tries Qwen 3.5 Plus (primary) → DeepSeek V3.2 (fallback) → Groq Llama (emergency).
 */
async function callLLMRaw(messages, openRouterKey, groqKey, includeTools) {
  const providers = [];

  if (openRouterKey) {
    providers.push({
      name: 'Qwen',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'qwen/qwen3.5-plus-02-15',
      apiKey: openRouterKey,
      supportsTools: true,
    });
    providers.push({
      name: 'DeepSeek',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'deepseek/deepseek-v3.2',
      apiKey: openRouterKey,
      supportsTools: true,
    });
  }

  if (groqKey) {
    providers.push({
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      apiKey: groqKey,
      supportsTools: false,
    });
  }

  for (const provider of providers) {
    try {
      const body = {
        model: provider.model,
        messages,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
      };

      if (includeTools && provider.supportsTools) {
        body.tools = TOOL_DEFINITIONS;
      }

      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${provider.name} returned ${resp.status}: ${errBody}`);
      }

      const data = await resp.json();
      console.log(`[telegram-webhook] ${provider.name} responded successfully`);
      return data;
    } catch (err) {
      console.error(`[telegram-webhook] ${provider.name} failed:`, err.message || err);
    }
  }

  throw new Error('All LLM providers failed');
}
