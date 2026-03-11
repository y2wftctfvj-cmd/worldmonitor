/**
 * /brief command handler — full intelligence briefing on demand.
 */

import { loadWatchlist } from '../redis-helpers.js';
import {
  fetchGoogleNewsHeadlines,
  fetchMarketQuotes,
} from '../monitor-tools.js';

/**
 * /brief — generate and send a full intelligence briefing.
 */
export async function handleBrief({ chatId, botToken, redisUrl, redisToken, openRouterKey, groqKey, sendMessage }) {
  await sendMessage(botToken, chatId, 'Compiling intelligence briefing...');

  const [watchlist, snapshot] = await Promise.all([
    loadWatchlist(chatId, redisUrl, redisToken),
    loadSnapshot(redisUrl, redisToken),
  ]);

  let context;
  if (snapshot) {
    // Cached snapshot exists — use it directly (fast path, ~100ms)
    context = snapshot;
  } else {
    // No snapshot — fetch minimal data sources
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
    const reply = await callBriefLLM(messages, groqKey, openRouterKey);
    await sendMessage(botToken, chatId, reply);
  } catch {
    await sendMessage(botToken, chatId, 'Failed to generate briefing. Try again in a moment.');
  }
}

/**
 * Load the latest snapshot from Redis.
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
 */
async function callBriefLLM(messages, groqKey, openRouterKey) {
  const providers = [];

  if (groqKey) {
    providers.push({
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      apiKey: groqKey,
    });
  }

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
          temperature: 0.3,
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${provider.name} returned ${resp.status}: ${errBody}`);
      }

      const data = await resp.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (!reply) throw new Error(`${provider.name} returned no content`);

      console.log(`[brief] /brief served by ${provider.name}`);
      return reply;
    } catch (err) {
      console.error(`[brief] ${provider.name} failed:`, err.message || err);
    }
  }

  throw new Error('All LLM providers failed for /brief');
}
