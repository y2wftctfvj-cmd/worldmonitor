/**
 * Telegram Webhook — lets users chat with Monitor via Telegram.
 *
 * v2.7.0: Upgraded to Qwen 3.5 Plus (1M context, tool-calling),
 * conversation memory (Redis, 30 turns, 48h TTL), watchlist commands,
 * and the full Monitor intelligence analyst persona.
 *
 * Auth: secret token passed as ?token= query param (must match CRON_SECRET).
 *
 * Commands: /watch, /unwatch, /watches, /brief, /status, /clear
 *
 * Setup (one-time):
 *   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://worldmonitor.app/api/telegram-webhook?token=${CRON_SECRET}"
 */

export const config = { runtime: 'edge' };

import {
  TOOL_DEFINITIONS,
  runTool,
  fetchGoogleNewsHeadlines,
  fetchMarketQuotes,
  fetchAllTelegramChannels,
  fetchAllRedditPosts,
  fetchTopicNews,
  fetchGeopoliticalMarkets,
} from './tools/monitor-tools.js';

// ---------------------------------------------------------------------------
// LLM settings
// ---------------------------------------------------------------------------
const TEMPERATURE = 0.3;
const MAX_TOKENS = 2000;
const LLM_TIMEOUT_MS = 30000; // Qwen can be slower with big context
const MAX_TOOL_CALLS_PER_TURN = 3;
const TELEGRAM_MAX_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Conversation memory settings
// ---------------------------------------------------------------------------
const MAX_HISTORY_MESSAGES = 30;
const HISTORY_TTL_SECONDS = 48 * 60 * 60; // 48 hours
const MAX_WATCHLIST_ITEMS = 20;

// ---------------------------------------------------------------------------
// Monitor persona — v2.7 upgraded
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Monitor, a senior intelligence analyst.

IDENTITY:
- Direct, concise, data-driven. No filler.
- You think in probabilities and leading indicators.
- You proactively flag cross-domain connections nobody asked about.
- You challenge assumptions when evidence contradicts them.

CAPABILITIES:
- You have tools to search news, markets, Telegram, Reddit, prediction markets, earthquake data, and flight anomalies. Use them when asked about topics not in your current context.
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

  // Validate secret token
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const cronSecret = process.env.CRON_SECRET;
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
    // --- Check for slash commands (handled before LLM call) ---
    const commandResult = await handleCommand(truncatedText, chatId, botToken, redisUrl, redisToken, openRouterKey, groqKey);
    if (commandResult) {
      return new Response('OK', { status: 200 });
    }

    // --- Load conversation history from Redis ---
    const history = await loadHistory(chatId, redisUrl, redisToken);

    // --- Load watchlist for context ---
    const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);

    // --- Fetch lightweight context in parallel ---
    const context = await fetchContext(truncatedText);

    // --- Build LLM messages ---
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: buildContextMessage(context, watchlist) },
      ...history,
      { role: 'user', content: truncatedText },
    ];

    // --- Call LLM with tool-calling support ---
    const reply = await callLLMWithTools(messages, openRouterKey, groqKey);

    // --- Save user message + assistant reply to Redis ---
    await appendHistory(chatId, 'user', truncatedText, redisUrl, redisToken);
    await appendHistory(chatId, 'assistant', reply, redisUrl, redisToken);

    // --- Send reply back to Telegram ---
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
// Command handling — /watch, /unwatch, /watches, /brief, /status, /clear
// ---------------------------------------------------------------------------

/**
 * Handle slash commands. Returns true if a command was processed.
 */
async function handleCommand(text, chatId, botToken, redisUrl, redisToken, openRouterKey, groqKey) {
  const lower = text.toLowerCase().trim();

  // /watch <term>
  if (lower.startsWith('/watch ') && !lower.startsWith('/watches')) {
    const term = text.slice(7).trim();
    if (!term) {
      await sendTelegramMessage(botToken, chatId, 'Usage: /watch <topic>\nExample: /watch Taiwan');
      return true;
    }
    const result = await addToWatchlist(chatId, term, redisUrl, redisToken);
    await sendTelegramMessage(botToken, chatId, result);
    return true;
  }

  // /unwatch <term>
  if (lower.startsWith('/unwatch ')) {
    const term = text.slice(9).trim();
    if (!term) {
      await sendTelegramMessage(botToken, chatId, 'Usage: /unwatch <topic>');
      return true;
    }
    const result = await removeFromWatchlist(chatId, term, redisUrl, redisToken);
    await sendTelegramMessage(botToken, chatId, result);
    return true;
  }

  // /watches — list active watches
  if (lower === '/watches') {
    const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
    if (watchlist.length === 0) {
      await sendTelegramMessage(botToken, chatId, 'No active watches. Use /watch <topic> to add one.');
    } else {
      const list = watchlist.map((w, i) => `${i + 1}. ${w.term} (since ${new Date(w.addedAt).toLocaleDateString()})`).join('\n');
      await sendTelegramMessage(botToken, chatId, `*Active Watchlist* (${watchlist.length}/${MAX_WATCHLIST_ITEMS}):\n${list}`);
    }
    return true;
  }

  // /brief — full intelligence briefing
  if (lower === '/brief') {
    await sendTelegramMessage(botToken, chatId, 'Compiling intelligence briefing...');
    const briefing = await generateBriefing(chatId, redisUrl, redisToken, openRouterKey, groqKey);
    await sendTelegramMessage(botToken, chatId, briefing);
    return true;
  }

  // /status — quick signal summary
  if (lower === '/status') {
    const status = await generateStatus();
    await sendTelegramMessage(botToken, chatId, status);
    return true;
  }

  // /clear — clear conversation history
  if (lower === '/clear') {
    await clearHistory(chatId, redisUrl, redisToken);
    await sendTelegramMessage(botToken, chatId, 'Conversation history cleared.');
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// /brief — Full intelligence briefing on demand
// ---------------------------------------------------------------------------

async function generateBriefing(chatId, redisUrl, redisToken, openRouterKey, groqKey) {
  // Fetch ALL data sources in parallel
  const [headlines, markets, telegram, reddit, predictions] = await Promise.allSettled([
    fetchGoogleNewsHeadlines(),
    fetchMarketQuotes(),
    fetchAllTelegramChannels(),
    fetchAllRedditPosts(),
    fetchGeopoliticalMarkets(),
  ]);

  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);

  // Build context string
  const sections = [];
  if (headlines.status === 'fulfilled' && headlines.value) sections.push(`HEADLINES:\n${headlines.value}`);
  if (markets.status === 'fulfilled' && markets.value) sections.push(`MARKETS:\n${markets.value}`);

  if (telegram.status === 'fulfilled' && telegram.value?.length > 0) {
    const telegramStr = telegram.value.slice(-15).map(p => `- [${p.channel}] ${p.text}`).join('\n');
    sections.push(`TELEGRAM OSINT:\n${telegramStr}`);
  }

  if (reddit.status === 'fulfilled' && reddit.value?.length > 0) {
    const redditStr = reddit.value.slice(0, 10).map(p => `- [r/${p.sub}, ${p.score}pts] ${p.title}`).join('\n');
    sections.push(`REDDIT OSINT:\n${redditStr}`);
  }

  if (predictions.status === 'fulfilled' && predictions.value?.length > 0) {
    const predStr = predictions.value.slice(0, 10).map(m => `- ${m.title}: ${m.probability ?? 'N/A'}% (vol: $${Math.round(m.volume).toLocaleString('en-US')})`).join('\n');
    sections.push(`PREDICTION MARKETS (Polymarket):\n${predStr}`);
  }

  const watchlistStr = watchlist.length > 0
    ? watchlist.map(w => `- "${w.term}" (since ${new Date(w.addedAt).toLocaleDateString()})`).join('\n')
    : 'No active watches.';

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const context = `DATA FETCHED AT: ${now}\n\n${sections.join('\n\n')}\n\nUSER WATCHLIST:\n${watchlistStr}`;

  const briefingPrompt = `You are Monitor delivering a full intelligence briefing.

Structure your response exactly like this:
*INTELLIGENCE BRIEF*

*MARKETS*
Key prices + daily changes + what's moving and why

*GEOPOLITICAL*
Top 3 developing situations with source citations

*SIGNALS*
What's unusual across Telegram/Reddit right now

*PREDICTIONS*
Top prediction market movers (Polymarket)

*WATCHLIST*
Status of each watched item

*OUTLOOK*
What to watch in the next 24 hours

Be specific. Cite sources. Give probabilities where relevant.
Format for Telegram: use *bold* for section headers. Keep paragraphs short.`;

  const messages = [
    { role: 'system', content: briefingPrompt },
    { role: 'system', content: `CURRENT INTELLIGENCE DATA:\n${context}` },
    { role: 'user', content: 'Deliver the full intelligence briefing.' },
  ];

  try {
    const reply = await callLLM(messages, openRouterKey, groqKey);
    return reply;
  } catch {
    return 'Failed to generate briefing. Try again in a moment.';
  }
}

// ---------------------------------------------------------------------------
// /status — Quick signal summary
// ---------------------------------------------------------------------------

async function generateStatus() {
  const [markets, headlines] = await Promise.allSettled([
    fetchMarketQuotes(),
    fetchGoogleNewsHeadlines(),
  ]);

  const parts = ['*MONITOR STATUS*\n'];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  parts.push(`${now}\n`);

  if (markets.status === 'fulfilled' && markets.value) {
    parts.push('*Markets:*');
    parts.push(markets.value);
    parts.push('');
  }

  if (headlines.status === 'fulfilled' && headlines.value) {
    const topHeadlines = headlines.value.split('\n').slice(0, 3).join('\n');
    parts.push('*Top Headlines:*');
    parts.push(topHeadlines);
  }

  parts.push('\n_Use /brief for full analysis._');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

/**
 * Fetch lightweight context for a conversational reply.
 * Not as comprehensive as /brief — just enough for a quick answer.
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
// LLM calling with tool support
// ---------------------------------------------------------------------------

/**
 * Call the LLM with tool-calling support.
 * Handles up to MAX_TOOL_CALLS_PER_TURN tool call rounds.
 */
async function callLLMWithTools(messages, openRouterKey, groqKey) {
  let currentMessages = [...messages];
  let toolCallsUsed = 0;

  while (toolCallsUsed < MAX_TOOL_CALLS_PER_TURN) {
    const response = await callLLMRaw(currentMessages, openRouterKey, groqKey, true);
    const choice = response?.choices?.[0];

    if (!choice) throw new Error('LLM returned no choices');

    const assistantMessage = choice.message;

    // If there are tool calls, process them
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      // Add the assistant's message (with tool_calls) to the conversation
      currentMessages.push(assistantMessage);

      // Process each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function?.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
        } catch {
          toolArgs = {};
        }

        console.log(`[telegram-webhook] Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);
        const toolResult = await runTool(toolName, toolArgs);

        // Add the tool result
        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      toolCallsUsed++;
      continue;
    }

    // No tool calls — return the text reply
    const reply = assistantMessage.content;
    if (!reply) throw new Error('LLM returned no content');
    return reply;
  }

  // Hit tool call limit — do one final call without tools
  const finalResponse = await callLLMRaw(currentMessages, openRouterKey, groqKey, false);
  const reply = finalResponse?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('LLM returned no content after tool calls');
  return reply;
}

/**
 * Make a raw LLM API call. Returns the full response JSON.
 * Tries Qwen 3.5 Plus (primary) → DeepSeek V3.2 (fallback) → Groq Llama (emergency).
 */
async function callLLMRaw(messages, openRouterKey, groqKey, includeTools) {
  const providers = [];

  // Primary: Qwen 3.5 Plus via OpenRouter (1M context, tool-calling)
  if (openRouterKey) {
    providers.push({
      name: 'Qwen',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'qwen/qwen3.5-plus-02-15',
      apiKey: openRouterKey,
      supportsTools: true,
    });

    // Fallback: DeepSeek V3.2 via OpenRouter (164K context)
    providers.push({
      name: 'DeepSeek',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'deepseek/deepseek-v3.2',
      apiKey: openRouterKey,
      supportsTools: true,
    });
  }

  // Emergency: Groq Llama (free, always available, no tool-calling)
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

      // Only include tools for providers that support them
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

/**
 * Simple text-only LLM call (no tool-calling). Used by /brief.
 */
async function callLLM(messages, openRouterKey, groqKey) {
  const response = await callLLMRaw(messages, openRouterKey, groqKey, false);
  const reply = response?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('LLM returned no content');
  return reply;
}

// ---------------------------------------------------------------------------
// Conversation memory — Redis-backed
// ---------------------------------------------------------------------------

/**
 * Load conversation history from Redis.
 * Returns array of {role, content} messages (max 30).
 */
async function loadHistory(chatId, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];

  try {
    const key = `chat:${chatId}:history`;
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    if (!data.result) return [];

    const history = JSON.parse(data.result);
    if (!Array.isArray(history)) return [];

    // Validate each entry — only allow user/assistant roles with string content
    const validRoles = new Set(['user', 'assistant']);
    return history.filter(
      (entry) => validRoles.has(entry?.role) && typeof entry?.content === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * Append a message to conversation history.
 * Trims to 30 messages, resets TTL to 48 hours.
 */
async function appendHistory(chatId, role, content, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;

  try {
    // Load current history
    const history = await loadHistory(chatId, redisUrl, redisToken);

    // Append new message
    const updated = [...history, { role, content, ts: Date.now() }];

    // Trim to most recent 30 messages
    const trimmed = updated.slice(-MAX_HISTORY_MESSAGES);

    // Save with 48h TTL — use pipeline POST body (safe for large values)
    const key = `chat:${chatId}:history`;
    const value = JSON.stringify(trimmed);
    await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['SET', key, value, 'EX', String(HISTORY_TTL_SECONDS)]]),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    console.error('[telegram-webhook] Failed to save history:', err.message);
  }
}

/**
 * Clear conversation history.
 */
async function clearHistory(chatId, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;

  try {
    const key = `chat:${chatId}:history`;
    await fetch(`${redisUrl}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Non-critical
  }
}

// ---------------------------------------------------------------------------
// Watchlist — Redis-backed persistent storage
// ---------------------------------------------------------------------------

/**
 * Load user's watchlist from Redis.
 * Returns array of { term, addedAt } objects.
 */
export async function loadWatchlist(chatId, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];

  try {
    const key = `watchlist:${chatId}`;
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    if (!data.result) return [];

    const watchlist = JSON.parse(data.result);
    return Array.isArray(watchlist) ? watchlist : [];
  } catch {
    return [];
  }
}

/**
 * Add a term to the watchlist.
 */
async function addToWatchlist(chatId, rawTerm, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return 'Watchlist requires Redis. Configure UPSTASH_REDIS_REST_URL.';

  // Sanitize: strip to alphanumeric/spaces/hyphens, max 50 chars
  const term = rawTerm.replace(/[^\w\s\-]/g, '').trim().slice(0, 50);
  if (term.length === 0) return 'Invalid watchlist term.';

  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);

  // Check for duplicates (case-insensitive)
  if (watchlist.some(w => w.term.toLowerCase() === term.toLowerCase())) {
    return `"${term}" is already on your watchlist.`;
  }

  if (watchlist.length >= MAX_WATCHLIST_ITEMS) {
    return `Watchlist full (${MAX_WATCHLIST_ITEMS} max). Remove one first with /unwatch.`;
  }

  const updated = [...watchlist, { term, addedAt: Date.now() }];
  await saveWatchlist(chatId, updated, redisUrl, redisToken);
  return `Added "${term}" to watchlist. I'll alert you when it appears in any intel source.`;
}

/**
 * Remove a term from the watchlist.
 */
async function removeFromWatchlist(chatId, term, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return 'Watchlist requires Redis.';

  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
  const termLower = term.toLowerCase();
  const updated = watchlist.filter(w => w.term.toLowerCase() !== termLower);

  if (updated.length === watchlist.length) {
    return `"${term}" was not on your watchlist.`;
  }

  await saveWatchlist(chatId, updated, redisUrl, redisToken);
  return `Removed "${term}" from watchlist.`;
}

/**
 * Save watchlist to Redis (no TTL — persists indefinitely).
 */
async function saveWatchlist(chatId, watchlist, redisUrl, redisToken) {
  try {
    const key = `watchlist:${chatId}`;
    const value = JSON.stringify(watchlist);
    await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['SET', key, value]]),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    console.error('[telegram-webhook] Failed to save watchlist:', err.message);
  }
}

/**
 * Load ALL user watchlists (for the analysis cycle).
 * Scans Redis for watchlist:* keys. Returns { chatId, terms[] } array.
 */
export async function loadAllWatchlists(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];

  try {
    // Use SCAN to find all watchlist keys
    // Upstash REST: /scan/0/match/watchlist:*/count/100
    const resp = await fetch(`${redisUrl}/scan/0/match/watchlist:*/count/100`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    const keys = data.result?.[1] || [];

    const watchlists = [];
    for (const key of keys) {
      const chatId = key.replace('watchlist:', '');
      const items = await loadWatchlist(chatId, redisUrl, redisToken);
      if (items.length > 0) {
        watchlists.push({
          chatId,
          terms: items.map(w => w.term),
        });
      }
    }
    return watchlists;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Telegram sending
// ---------------------------------------------------------------------------

/**
 * Send a text message to a Telegram chat via Bot API.
 * Uses Markdown parse mode. Truncates to 4096 chars.
 */
async function sendTelegramMessage(botToken, chatId, text) {
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
