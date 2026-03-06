/**
 * Telegram Webhook — lets users chat with Monitor via Telegram.
 *
 * v2.7.0: Upgraded to Qwen 3.5 Plus (1M context, tool-calling),
 * conversation memory (Redis, 30 turns, 48h TTL), watchlist commands,
 * and the full Monitor intelligence analyst persona.
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
  runTool,
  fetchGoogleNewsHeadlines,
  fetchMarketQuotes,
  fetchAllTelegramChannels,
  fetchAllRedditPosts,
  fetchTopicNews,
  fetchGeopoliticalMarkets,
} from './_tools/monitor-tools.js';

import {
  loadWatchlist,
  saveWatchlist,
} from './_tools/redis-helpers.js';

import { getEntityHistory, normalizeEntity, loadLedgerEntries, computeBaselines } from './_tools/event-ledger.js';
import { detectAnomalies, detectConvergence } from './_tools/intel-analysis.js';
import {
  createWatchlistItem,
  formatWatchlistSummary,
  hydrateWatchlistItems,
  normalizeWatchTerm,
} from './_tools/watchlist-utils.js';

// ---------------------------------------------------------------------------
// LLM settings
// ---------------------------------------------------------------------------
const TEMPERATURE = 0.3;
const MAX_TOKENS = 2000;
const LLM_TIMEOUT_MS = 18000; // Must fit within Vercel's 30s edge limit after context fetch
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
      const list = formatWatchlistSummary(watchlist, MAX_WATCHLIST_ITEMS);
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

  // /history <entity> — 7-day timeline for an entity
  if (lower.startsWith('/history ')) {
    const entity = text.slice(9).trim();
    if (!entity) {
      await sendTelegramMessage(botToken, chatId, 'Usage: /history <entity>\nExample: /history Iran');
      return true;
    }
    const result = await handleHistoryCommand(entity, redisUrl, redisToken);
    await sendTelegramMessage(botToken, chatId, result);
    return true;
  }

  // /anomalies — current entities above baseline
  if (lower === '/anomalies') {
    const result = await handleAnomaliesCommand(redisUrl, redisToken);
    await sendTelegramMessage(botToken, chatId, result);
    return true;
  }

  // /convergence — cross-domain convergence signals
  if (lower === '/convergence') {
    const result = await handleConvergenceCommand(redisUrl, redisToken);
    await sendTelegramMessage(botToken, chatId, result);
    return true;
  }

  // /sitrep — full situation report with patterns
  if (lower === '/sitrep') {
    await sendTelegramMessage(botToken, chatId, 'Compiling situation report...');
    const result = await handleSitrepCommand(redisUrl, redisToken, openRouterKey, groqKey);
    await sendTelegramMessage(botToken, chatId, result);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// /brief — Full intelligence briefing on demand
// ---------------------------------------------------------------------------

async function generateBriefing(chatId, redisUrl, redisToken, openRouterKey, groqKey) {
  // Use cached snapshot from Redis (stored every 5 min by monitor-check).
  // This saves ~8s of data fetching — critical for the 25s Edge timeout.
  const [watchlist, snapshot] = await Promise.all([
    loadWatchlist(chatId, redisUrl, redisToken),
    loadSnapshot(redisUrl, redisToken),
  ]);

  let context;
  if (snapshot) {
    // Cached snapshot exists — use it directly (fast path, ~100ms)
    context = snapshot;
  } else {
    // No snapshot (first run or expired) — fetch minimal data sources
    const [headlines, markets] = await Promise.allSettled([
      fetchGoogleNewsHeadlines(),
      fetchMarketQuotes(),
    ]);
    const sections = [];
    if (headlines.status === 'fulfilled' && headlines.value) sections.push(`HEADLINES:\n${headlines.value}`);
    if (markets.status === 'fulfilled' && markets.value) sections.push(`MARKETS:\n${markets.value}`);
    context = sections.length > 0 ? sections.join('\n\n') : 'No data available — monitor cycle may not have run yet.';
  }

  const watchlistStr = watchlist.length > 0
    ? watchlist.map(w => `- "${w.term}" (since ${new Date(w.addedAt).toLocaleDateString()})`).join('\n')
    : 'No active watches.';

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const fullContext = `BRIEFING REQUESTED: ${now}\n\n${context}\n\nUSER WATCHLIST:\n${watchlistStr}`;

  const briefingPrompt = `You are Monitor delivering a full intelligence briefing via Telegram.

Structure your response with these sections, each starting on a new line with *HEADER*:

*INTELLIGENCE BRIEF*
(one line: date + "Monitor v3.0 — Evidence Fusion")

*MARKETS*
Key prices + daily changes + what's moving and why. Use the EXACT numbers from the data — do not estimate or round. 2-3 sentences max.

*GEOPOLITICAL*
Top 3 developing situations. Cite which source (Telegram channel, Reddit sub, news outlet) reported each item. 1-2 sentences per situation.

*SIGNALS*
What's unusual across Telegram/Reddit right now. Only mention genuinely unusual patterns, not routine news. 2-3 bullet points.

*PREDICTIONS*
Top prediction market movers with probabilities. Use the EXACT percentages from the data. If data shows NaN or N/A, skip that market.

*WATCHLIST*
Status of each watched item — is it quiet, active, or critical right now?

*OUTLOOK*
2-3 specific indicators to watch in the next 24 hours.

IMPORTANT RULES:
- Use the EXACT market prices and percentages from the data provided. Never invent prices.
- If a data source returned no results, say "No data available" — don't make things up.
- Keep each section focused. The full briefing will be split across multiple messages.
- Format for Telegram: *bold* headers, short paragraphs, bullet points with hyphens.`;

  const messages = [
    { role: 'system', content: briefingPrompt },
    { role: 'system', content: `CURRENT INTELLIGENCE DATA:\n${fullContext}` },
    { role: 'user', content: 'Deliver the full intelligence briefing.' },
  ];

  try {
    // Use Groq-first for /brief — fast (~2s) and doesn't need tool-calling
    const reply = await callBriefLLM(messages, groqKey, openRouterKey);
    return reply;
  } catch {
    return 'Failed to generate briefing. Try again in a moment.';
  }
}

/**
 * Load the latest snapshot from Redis (stored by monitor-check every 5 min).
 */
async function loadSnapshot(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return null;
  try {
    const resp = await fetch(`${redisUrl}/get/monitor:snapshot`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result || null;
  } catch {
    return null;
  }
}

/**
 * LLM call optimized for /brief — Groq first (fast, ~2s), OpenRouter fallback.
 * No tool-calling needed. Separate from callLLMRaw to avoid the slow Qwen/DeepSeek
 * primary path that burns 15s+ of the 25s Edge budget.
 */
async function callBriefLLM(messages, groqKey, openRouterKey) {
  const providers = [];

  // Groq first — fast (500 tok/s), free, perfect for briefings
  if (groqKey) {
    providers.push({
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      apiKey: groqKey,
    });
  }

  // OpenRouter fallback — slower but smarter
  if (openRouterKey) {
    providers.push({
      name: 'DeepSeek',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'deepseek/deepseek-v3.2',
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
        signal: AbortSignal.timeout(15000), // 15s — leaves headroom in the 25s Edge budget
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${provider.name} returned ${resp.status}: ${errBody}`);
      }

      const data = await resp.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (!reply) throw new Error(`${provider.name} returned no content`);

      console.log(`[telegram-webhook] /brief served by ${provider.name}`);
      return reply;
    } catch (err) {
      console.error(`[telegram-webhook] /brief ${provider.name} failed:`, err.message || err);
    }
  }

  throw new Error('All LLM providers failed for /brief');
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
// New intel commands — /history, /anomalies, /convergence, /sitrep
// ---------------------------------------------------------------------------

/**
 * /history <entity> — show 7-day timeline from the ledger.
 */
async function handleHistoryCommand(entity, redisUrl, redisToken) {
  const ledger = await getEntityHistory(entity, redisUrl, redisToken);

  if (!ledger) {
    return `No history found for "${entity}". The entity may not have appeared in recent monitoring cycles, or the ledger hasn't accumulated enough data yet.`;
  }

  const observations = ledger.observations || [];
  const baseline = ledger.baseline || {};

  const parts = [];
  parts.push(`*ENTITY HISTORY: ${ledger.displayName || entity}*`);
  parts.push(`Normalized: ${ledger.entity}`);
  parts.push(`Observations: ${observations.length} over ${Math.round((Date.now() - (observations[0]?.ts || Date.now())) / 86400000)} days`);
  parts.push('');

  // Baseline stats
  if (baseline.observationCount >= 5) {
    parts.push('*Baseline (7-day)*');
    parts.push(`Avg daily mentions: ${baseline.avgDailyMentions}`);
    parts.push(`Avg confidence: ${baseline.avgConfidence}`);
    parts.push(`Avg source count: ${baseline.avgSourceCount}`);
    parts.push('');
  }

  // Recent observations (last 10)
  const recentObs = observations.slice(-10);
  if (recentObs.length > 0) {
    parts.push('*Recent Activity*');
    for (const obs of recentObs) {
      const date = new Date(obs.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      const sources = obs.sourceCount || 1;
      parts.push(`- ${date} UTC | ${obs.severity} | conf: ${obs.confidence} | ${sources} sources`);
    }
    parts.push('');
  }

  // Severity distribution
  const severityCounts = {};
  for (const obs of observations) {
    severityCounts[obs.severity] = (severityCounts[obs.severity] || 0) + 1;
  }
  parts.push('*Severity Distribution*');
  for (const [sev, count] of Object.entries(severityCounts).sort((a, b) => b[1] - a[1])) {
    parts.push(`${sev}: ${count}`);
  }

  return parts.join('\n');
}

/**
 * /anomalies — show entities currently above their baseline.
 * Reads from recent alerts and ledger data.
 */
async function handleAnomaliesCommand(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return 'Anomaly detection requires Redis.';

  // Load recent alerts to find active entities
  let recentAlerts = [];
  try {
    const resp = await fetch(`${redisUrl}/get/monitor:recent-alerts`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.result) recentAlerts = JSON.parse(data.result);
    }
  } catch { /* proceed with empty */ }

  if (recentAlerts.length === 0) {
    return '*ANOMALY REPORT*\n\nNo recent alerts to analyze. The monitor pipeline may not have produced alerts recently.';
  }

  // Extract entities from recent alerts
  const allEntities = [...new Set(recentAlerts.flatMap(a => a.entities || []))];
  if (allEntities.length === 0) {
    return '*ANOMALY REPORT*\n\nNo entity data in recent alerts.';
  }

  const baselines = await computeBaselines(allEntities, redisUrl, redisToken);

  const parts = ['*ANOMALY REPORT*', ''];
  let foundAnomalies = 0;

  for (const [entity, baseline] of baselines) {
    if (baseline.insufficient) continue;
    // Count how many recent alerts mention this entity
    const recentCount = recentAlerts.filter(a => (a.entities || []).some(e => normalizeEntity(e) === entity)).length;
    // Compare to baseline (alerts per day vs observations per day)
    if (recentCount >= 3 && baseline.avgDailyMentions > 0) {
      const ratio = Math.round((recentCount / baseline.avgDailyMentions) * 100);
      parts.push(`\u26A1 *${entity}*: ${recentCount} alerts (${ratio}% of daily baseline ${baseline.avgDailyMentions})`);
      foundAnomalies++;
    }
  }

  if (foundAnomalies === 0) {
    parts.push('No anomalies detected. All entities are within normal baseline ranges.');
  }

  parts.push('');
  parts.push(`_Based on ${allEntities.length} entities from ${recentAlerts.length} recent alerts._`);

  return parts.join('\n');
}

/**
 * /convergence — show cross-domain convergence signals from the latest digest cache.
 */
async function handleConvergenceCommand(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return 'Convergence detection requires Redis.';

  // Load today's digest cache for entity activity data
  let cache = null;
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(`monitor:digest-cache:${dateStr}`)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.result) cache = JSON.parse(data.result);
    }
  } catch { /* proceed without cache */ }

  const parts = ['*CROSS-DOMAIN CONVERGENCE*', ''];

  if (!cache || !cache.topAlerts || cache.topAlerts.length === 0) {
    parts.push('No convergence data available. The monitor pipeline needs to accumulate cycle data first.');
    return parts.join('\n');
  }

  // Look for entities that appear across multiple source types
  const entitySourceTypes = new Map();
  for (const alert of cache.topAlerts) {
    const sourceTypes = alert.sourceTypes || [];
    for (const entity of (alert.entities || [])) {
      const normalized = normalizeEntity(entity);
      if (!entitySourceTypes.has(normalized)) {
        entitySourceTypes.set(normalized, { types: new Set(), displayName: entity });
      }
      for (const type of sourceTypes) {
        entitySourceTypes.get(normalized).types.add(type);
      }
    }
  }

  // Show entities with 3+ source types (proxy for cross-domain)
  let found = 0;
  const sorted = [...entitySourceTypes.entries()].sort((a, b) => b[1].types.size - a[1].types.size);
  for (const [entity, data] of sorted) {
    if (data.types.size >= 3) {
      parts.push(`\u{1F500} *${data.displayName}*: ${[...data.types].join(' + ')} (${data.types.size} source types)`);
      found++;
    }
    if (found >= 10) break;
  }

  if (found === 0) {
    parts.push('No multi-domain convergence detected in today\'s data.');
  }

  parts.push('');
  parts.push(`_Based on ${cache.topAlerts.length} promoted events today._`);

  return parts.join('\n');
}

/**
 * /sitrep — full situation report combining recent alerts + analysis.
 */
async function handleSitrepCommand(redisUrl, redisToken, openRouterKey, groqKey) {
  if (!redisUrl || !redisToken) return 'SITREP requires Redis.';

  // Load all available data from Redis
  const [recentAlertsResp, sourceHealthResp, cacheResp] = await Promise.allSettled([
    fetch(`${redisUrl}/get/monitor:recent-alerts`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    }),
    fetch(`${redisUrl}/get/monitor:source-health`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    }),
    fetch(`${redisUrl}/get/${encodeURIComponent(`monitor:digest-cache:${new Date().toISOString().slice(0, 10)}`)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    }),
  ]);

  let recentAlerts = [];
  let sourceHealth = null;
  let cache = null;

  try {
    if (recentAlertsResp.status === 'fulfilled' && recentAlertsResp.value.ok) {
      const data = await recentAlertsResp.value.json();
      if (data.result) recentAlerts = JSON.parse(data.result);
    }
  } catch { /* proceed */ }

  try {
    if (sourceHealthResp.status === 'fulfilled' && sourceHealthResp.value.ok) {
      const data = await sourceHealthResp.value.json();
      if (data.result) sourceHealth = JSON.parse(data.result);
    }
  } catch { /* proceed */ }

  try {
    if (cacheResp.status === 'fulfilled' && cacheResp.value.ok) {
      const data = await cacheResp.value.json();
      if (data.result) cache = JSON.parse(data.result);
    }
  } catch { /* proceed */ }

  // Build SITREP message
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  const parts = [];
  parts.push(`*SITUATION REPORT*`);
  parts.push(dateStr);
  parts.push('');

  // Recent alerts summary
  if (recentAlerts.length > 0) {
    parts.push('*RECENT ALERTS*');
    const top = recentAlerts.slice(-5);
    for (const alert of top) {
      const title = typeof alert === 'string' ? alert : alert.title;
      const severity = typeof alert === 'object' ? alert.severity : 'unknown';
      parts.push(`- [${severity}] ${title}`);
    }
    parts.push('');
  }

  // Entity activity from cache
  if (cache?.entityCounts) {
    const topEntities = Object.entries(cache.entityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (topEntities.length > 0) {
      parts.push('*ENTITY ACTIVITY*');
      for (const [entity, count] of topEntities) {
        parts.push(`- ${entity}: ${count} mentions`);
      }
      parts.push('');
    }
  }

  // Source health
  if (sourceHealth) {
    const entries = Object.entries(sourceHealth);
    const okCount = entries.filter(([, v]) => v.status === 'ok').length;
    const degraded = entries
      .filter(([, v]) => v.status === 'degraded' || (v.consecutiveDegraded || 0) >= 2)
      .map(([name, value]) => `${name} (${value.detail || `${value.consecutiveDegraded || 0} degraded`})`);
    const failed = entries
      .filter(([, v]) => v.status === 'failed' || (v.consecutiveFailures || 0) >= 2)
      .map(([name, value]) => `${name} (${value.consecutiveFailures || 0} fails)`);
    parts.push('*SOURCE STATUS*');
    parts.push(`${okCount}/${entries.length} healthy`);
    if (degraded.length > 0) {
      parts.push(`Degraded: ${degraded.join(', ')}`);
    }
    if (failed.length > 0) {
      parts.push(`Failed: ${failed.join(', ')}`);
    }
    parts.push('');
  }

  if (parts.length <= 3) {
    parts.push('No data available for SITREP. The monitor pipeline may not have run recently.');
  }

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

  // Each fetch has its own AbortSignal.timeout (5-8s), so allSettled
  // completes within ~8s with partial results for any that timed out.
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
        let toolResult;
        try {
          toolResult = await runTool(toolName, toolArgs);
        } catch (toolErr) {
          console.error(`[telegram-webhook] Tool ${toolName} failed:`, toolErr.message || toolErr);
          toolResult = `Tool "${toolName}" failed: ${toolErr.message || 'unknown error'}. Try a different approach.`;
        }

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
// Watchlist — commands (add/remove use shared helpers from redis-helpers.js)
// ---------------------------------------------------------------------------

/**
 * Add a term to the watchlist.
 */
async function addToWatchlist(chatId, rawTerm, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return 'Watchlist requires Redis. Configure UPSTASH_REDIS_REST_URL.';

  const item = createWatchlistItem(rawTerm);
  if (!item) return 'Invalid watchlist term.';

  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
  const normalized = normalizeWatchTerm(item.term);

  if (watchlist.some((entry) => normalizeWatchTerm(entry.normalized || entry.term) === normalized)) {
    return `"${item.term}" is already on your watchlist.`;
  }

  if (watchlist.length >= MAX_WATCHLIST_ITEMS) {
    return `Watchlist full (${MAX_WATCHLIST_ITEMS} max). Remove one first with /unwatch.`;
  }

  const updated = [...hydrateWatchlistItems(watchlist), item];
  try {
    await saveWatchlist(chatId, updated, redisUrl, redisToken);
  } catch (err) {
    console.error('[telegram-webhook] Watchlist save failed:', err.message);
    return `Failed to save "${item.term}" to watchlist. Try again in a moment.`;
  }
  return `Added "${item.term}" to watchlist. I'll alert you when it appears in high-trust intel.`;
}

/**
 * Remove a term from the watchlist.
 */
async function removeFromWatchlist(chatId, term, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return 'Watchlist requires Redis.';

  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
  const normalized = normalizeWatchTerm(term);
  const updated = watchlist.filter((entry) => normalizeWatchTerm(entry.normalized || entry.term) !== normalized);

  if (updated.length === watchlist.length) {
    return `"${term}" was not on your watchlist.`;
  }

  try {
    await saveWatchlist(chatId, updated, redisUrl, redisToken);
  } catch (err) {
    console.error('[telegram-webhook] Watchlist save failed:', err.message);
    return `Failed to remove "${term}". Try again in a moment.`;
  }
  return `Removed "${term}" from watchlist.`;
}

// ---------------------------------------------------------------------------
// Telegram sending
// ---------------------------------------------------------------------------

/**
 * Send a message to Telegram, splitting into multiple messages if needed.
 * Splits on section headers (*HEADER*) first, then on paragraph breaks.
 * Each chunk stays under TELEGRAM_MAX_LENGTH.
 */
async function sendTelegramMessage(botToken, chatId, text) {
  const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH);

  for (const chunk of chunks) {
    await sendSingleTelegramMessage(botToken, chatId, chunk);
  }
}

/**
 * Split a long message into chunks that fit within the Telegram limit.
 * Prefers splitting on section headers (*BOLD HEADER*), then double newlines,
 * then single newlines, as a last resort mid-text.
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

    // Find a good split point within the max length
    let splitAt = -1;

    // Prefer splitting before a section header line (*SOMETHING*)
    const headerPattern = /\n\*[A-Z]/g;
    let headerMatch;
    while ((headerMatch = headerPattern.exec(remaining)) !== null) {
      if (headerMatch.index > 0 && headerMatch.index <= maxLen) {
        splitAt = headerMatch.index;
      }
      if (headerMatch.index > maxLen) break;
    }

    // If no header split found, try double newline
    if (splitAt === -1) {
      const lastDoubleNewline = remaining.lastIndexOf('\n\n', maxLen);
      if (lastDoubleNewline > maxLen * 0.3) splitAt = lastDoubleNewline;
    }

    // If still nothing, try single newline
    if (splitAt === -1) {
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.3) splitAt = lastNewline;
    }

    // Last resort: hard cut
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Send a single Telegram message (must be under 4096 chars).
 * Falls back to plain text if Markdown parsing fails.
 */
async function sendSingleTelegramMessage(botToken, chatId, text) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
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
          text,
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
