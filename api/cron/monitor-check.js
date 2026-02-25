/**
 * Smart Monitor Check — AI-powered intelligence analysis cycle.
 *
 * v2.7.0: Complete rewrite. Replaces threshold-based checks with an
 * AI analysis loop that runs every 5 minutes via QStash (or daily via
 * Vercel cron as backup).
 *
 * The cycle:
 *   1. COLLECT — fetch all data sources in parallel
 *   2. ANALYZE — feed everything into Qwen 3.5 Plus with previous snapshot
 *   3. DECIDE  — if AI flags notable/urgent findings, push Telegram alerts
 *   4. STORE   — save current snapshot for next cycle comparison
 *
 * Auth: accepts both Vercel cron auth (Bearer token) AND QStash signatures.
 *
 * Env vars required:
 *   CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *   OPENROUTER_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 * Optional:
 *   QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY (for QStash auth)
 *   CLOUDFLARE_RADAR_TOKEN
 */

export const config = { runtime: 'edge' };

import {
  fetchGoogleNewsHeadlines,
  fetchMarketQuotes,
  fetchAllTelegramChannels,
  fetchAllRedditPosts,
  fetchGeopoliticalMarkets,
  fetchEarthquakes,
  fetchInternetOutages,
  fetchMilitaryNews,
  fetchGovFeeds,
} from '../tools/monitor-tools.js';

// Import watchlist loader from telegram-webhook
// (uses the same Redis keys, same format)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LLM_TIMEOUT_MS = 60000; // AI analysis can take a while with huge context
const MAX_TOKENS = 3000;
const SNAPSHOT_TTL_SECONDS = 600; // 10 min — snapshots expire after 2 cycles
const DEVELOPING_THRESHOLD = 3; // 3 consecutive cycles to trigger "developing" alert

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(request) {
  // --- AUTH: accept Vercel cron OR QStash signature ---
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const qstashSignature = request.headers.get('upstash-signature');

  // Check Vercel cron auth
  const isVercelCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  // Check QStash signature (simplified — for full verification use @upstash/qstash SDK)
  // QStash also forwards the Bearer token we set in setup-qstash.js
  const isQStash = !!qstashSignature || (cronSecret && authHeader === `Bearer ${cronSecret}`);

  if (!isVercelCron && !isQStash) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  // Check Telegram config
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return jsonResponse(200, { skipped: true, reason: 'Telegram not configured' });
  }

  // Check LLM config
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!openRouterKey && !groqKey) {
    return jsonResponse(200, { skipped: true, reason: 'No LLM provider configured' });
  }

  // Redis config
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cloudflareToken = process.env.CLOUDFLARE_RADAR_TOKEN;

  try {
    // -----------------------------------------------------------------------
    // 1. COLLECT — fetch all data sources in parallel
    // -----------------------------------------------------------------------
    const [
      headlines, markets, telegram, reddit, predictions,
      earthquakes, outages, military, govFeeds,
    ] = await Promise.allSettled([
      fetchGoogleNewsHeadlines(),
      fetchMarketQuotes(),
      fetchAllTelegramChannels(),
      fetchAllRedditPosts(),
      fetchGeopoliticalMarkets(),
      fetchEarthquakes(),
      fetchInternetOutages(cloudflareToken),
      fetchMilitaryNews(),
      fetchGovFeeds(),
    ]);

    // -----------------------------------------------------------------------
    // 2. BUILD SNAPSHOT — assemble all data into one context string
    // -----------------------------------------------------------------------
    const currentSnapshot = buildSnapshot({
      headlines, markets, telegram, reddit, predictions,
      earthquakes, outages, military, govFeeds,
    });

    // -----------------------------------------------------------------------
    // 3. LOAD PREVIOUS — get last cycle's snapshot from Redis
    // -----------------------------------------------------------------------
    const previousSnapshot = await loadPreviousSnapshot(redisUrl, redisToken);

    // -----------------------------------------------------------------------
    // 4. LOAD WATCHLISTS — all user watchlists
    // -----------------------------------------------------------------------
    const watchlists = await loadAllWatchlists(redisUrl, redisToken);
    const watchlistTerms = watchlists.flatMap(w => w.terms);

    // -----------------------------------------------------------------------
    // 5. LOAD DEVELOPING ITEMS — track multi-cycle patterns
    // -----------------------------------------------------------------------
    const developingItems = await loadDevelopingItems(redisUrl, redisToken);

    // -----------------------------------------------------------------------
    // 6. ANALYZE — feed everything to the AI
    // -----------------------------------------------------------------------
    const analysis = await runAnalysisCycle(
      currentSnapshot,
      previousSnapshot,
      watchlistTerms,
      developingItems,
      openRouterKey,
      groqKey
    );

    // -----------------------------------------------------------------------
    // 7. ALERT — send notable/urgent findings to Telegram
    // -----------------------------------------------------------------------
    let alertsSent = 0;
    if (analysis && analysis.findings) {
      for (const finding of analysis.findings) {
        if (finding.severity === 'routine') continue;

        // Dedup: skip if we already sent this finding recently
        const dedupeKey = `alert-${slugify(finding.title)}-${Math.floor(Date.now() / 3600000)}`;
        if (await isRecentlyAlerted(redisUrl, redisToken, dedupeKey)) continue;

        await sendIntelAlert(botToken, chatId, finding);
        await markAlerted(redisUrl, redisToken, dedupeKey);
        alertsSent++;
      }

      // Track developing items
      await updateDevelopingItems(analysis.findings, redisUrl, redisToken);
    }

    // Check developing items that have hit the threshold
    await checkDevelopingAlerts(botToken, chatId, redisUrl, redisToken);

    // -----------------------------------------------------------------------
    // 8. STORE — save current snapshot for next cycle
    // -----------------------------------------------------------------------
    await storeSnapshot(redisUrl, redisToken, currentSnapshot);

    return jsonResponse(200, {
      ok: true,
      alertsSent,
      findings: analysis?.findings?.length || 0,
      summary: analysis?.situation_summary?.substring(0, 200) || '',
    });
  } catch (err) {
    console.error('[monitor-check] Cycle failed:', err.message || err);
    return jsonResponse(500, { error: 'Analysis cycle failed', message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Snapshot building — assemble all data into context
// ---------------------------------------------------------------------------

function buildSnapshot(results) {
  const sections = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  sections.push(`TIMESTAMP: ${now}`);

  // Headlines
  if (results.headlines.status === 'fulfilled' && results.headlines.value) {
    sections.push(`HEADLINES:\n${results.headlines.value}`);
  }

  // Markets
  if (results.markets.status === 'fulfilled' && results.markets.value) {
    sections.push(`MARKETS:\n${results.markets.value}`);
  }

  // Telegram OSINT
  if (results.telegram.status === 'fulfilled' && results.telegram.value?.length > 0) {
    const posts = results.telegram.value.slice(-20);
    sections.push(`TELEGRAM OSINT (${posts.length} posts from ${new Set(posts.map(p => p.channel)).size} channels):\n${posts.map(p => `- [${p.channel}] ${p.text}`).join('\n')}`);
  }

  // Reddit OSINT
  if (results.reddit.status === 'fulfilled' && results.reddit.value?.length > 0) {
    const posts = results.reddit.value.slice(0, 15);
    sections.push(`REDDIT OSINT (${posts.length} posts):\n${posts.map(p => `- [r/${p.sub}, ${p.score}pts] ${p.title}`).join('\n')}`);
  }

  // Prediction markets
  if (results.predictions.status === 'fulfilled' && results.predictions.value?.length > 0) {
    const markets = results.predictions.value.slice(0, 10);
    sections.push(`PREDICTION MARKETS (Polymarket):\n${markets.map(m => `- ${m.title}: ${m.probability}% (vol: $${Math.round(m.volume).toLocaleString()})`).join('\n')}`);
  }

  // Earthquakes
  if (results.earthquakes.status === 'fulfilled' && results.earthquakes.value?.length > 0) {
    sections.push(`EARTHQUAKES:\n${results.earthquakes.value.map(eq => `- M${eq.mag.toFixed(1)} — ${eq.place} (${eq.time})`).join('\n')}`);
  }

  // Internet outages
  if (results.outages.status === 'fulfilled' && results.outages.value?.length > 0) {
    sections.push(`INTERNET OUTAGES:\n${results.outages.value.map(o => `- ${o.country}: ${o.description}`).join('\n')}`);
  }

  // Military news
  if (results.military.status === 'fulfilled' && results.military.value) {
    const mil = results.military.value;
    sections.push(`MILITARY NEWS (${mil.count} articles in last 2h):\n${mil.articles.map(a => `- ${a}`).join('\n')}`);
  }

  // Government/wire feeds
  if (results.govFeeds.status === 'fulfilled' && results.govFeeds.value?.length > 0) {
    sections.push(`WIRE SERVICES:\n${results.govFeeds.value.map(f => `- [${f.source}] ${f.title}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// AI analysis cycle
// ---------------------------------------------------------------------------

async function runAnalysisCycle(currentSnapshot, previousSnapshot, watchlistTerms, developingItems, openRouterKey, groqKey) {
  const watchlistSection = watchlistTerms.length > 0
    ? `\nUSER WATCHLIST:\n${watchlistTerms.map(t => `- "${t}"`).join('\n')}\n\nFor each watchlist term: search ALL current data for mentions. If found in any source, include in findings with severity "notable" minimum. If found in 2+ sources, severity "urgent".`
    : '';

  const developingSection = developingItems.length > 0
    ? `\nDEVELOPING ITEMS FROM PREVIOUS CYCLES:\n${developingItems.map(d => `- "${d.topic}" (${d.count} consecutive cycles)`).join('\n')}`
    : '';

  const analysisPrompt = `Analyze the intelligence data below. Compare against the PREVIOUS CYCLE data to detect changes.

CURRENT DATA:
${currentSnapshot}

${previousSnapshot ? `PREVIOUS CYCLE DATA:\n${previousSnapshot}` : 'No previous cycle data available (first run).'}
${watchlistSection}
${developingSection}

OUTPUT FORMAT (respond ONLY with valid JSON, no markdown code fences):
{
  "findings": [
    {
      "severity": "urgent|notable|developing|routine",
      "title": "Short headline",
      "analysis": "2-3 sentences explaining what is happening and why it matters",
      "sources": ["telegram:intelslava", "reddit:worldnews", "markets:USO"],
      "watchlist_match": "Taiwan" or null,
      "watch_next": ["indicator 1", "indicator 2"]
    }
  ],
  "situation_summary": "1 paragraph overall assessment"
}

SEVERITY RULES:
- "routine": Normal news cycle. Do NOT alert.
- "notable": Genuinely unusual — not just normal news. Alert with analysis.
- "urgent": Multiple sources converging OR rapid change from previous cycle. Alert immediately.
- "developing": A situation is building but has not triggered yet. Track it.
- Cross-domain convergence (e.g., military news + market move + prediction shift) should ALWAYS be flagged as notable or urgent.
- Only flag "notable" if genuinely unusual (not routine news cycles).
- Check watchlist terms against ALL sources.
- Maximum 5 findings per cycle to avoid alert fatigue.`;

  const messages = [
    { role: 'system', content: 'You are an intelligence analysis system. Output ONLY valid JSON. No explanatory text.' },
    { role: 'user', content: analysisPrompt },
  ];

  // Call LLM
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
          temperature: 0.2,
          max_tokens: MAX_TOKENS,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${provider.name} returned ${resp.status}: ${errBody}`);
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`${provider.name} returned no content`);

      // Parse JSON response
      const analysis = JSON.parse(content);
      console.log(`[monitor-check] ${provider.name} analysis: ${analysis.findings?.length || 0} findings`);
      return analysis;
    } catch (err) {
      console.error(`[monitor-check] ${provider.name} failed:`, err.message || err);
    }
  }

  console.error('[monitor-check] All LLM providers failed for analysis');
  return null;
}

// ---------------------------------------------------------------------------
// Smart alert formatting
// ---------------------------------------------------------------------------

async function sendIntelAlert(botToken, chatId, finding) {
  const severityEmoji = {
    urgent: '\u{1F534}',    // red circle
    notable: '\u{1F7E1}',   // yellow circle
    developing: '\u{1F4E1}', // satellite
  };

  const emoji = severityEmoji[finding.severity] || '\u{1F7E1}';
  const severityLabel = finding.severity.toUpperCase();

  const parts = [
    `${emoji} *${severityLabel}* — ${escapeMarkdown(finding.title)}`,
    '',
  ];

  if (finding.analysis) {
    parts.push(escapeMarkdown(finding.analysis));
    parts.push('');
  }

  if (finding.sources && finding.sources.length > 0) {
    parts.push(`_Sources: ${escapeMarkdown(finding.sources.join(', '))}_`);
  }

  if (finding.watchlist_match) {
    parts.push(`_Watchlist match: "${escapeMarkdown(finding.watchlist_match)}"_`);
  }

  if (finding.watch_next && finding.watch_next.length > 0) {
    parts.push('');
    parts.push('*Watch for:*');
    for (const indicator of finding.watch_next) {
      parts.push(`\\- ${escapeMarkdown(indicator)}`);
    }
  }

  parts.push('');
  parts.push('_5\\-min cycle \\| AI analysis_');

  const text = parts.join('\n');

  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    // Retry without markdown on parse failure
    const errBody = await resp.text();
    if (resp.status === 400 && errBody.includes("can't parse")) {
      const plainText = `${finding.severity.toUpperCase()} — ${finding.title}\n\n${finding.analysis || ''}\n\nSources: ${(finding.sources || []).join(', ')}`;
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: plainText,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } else {
      console.error('[monitor-check] Telegram API error:', resp.status, errBody);
    }
  }
}

// ---------------------------------------------------------------------------
// Developing items tracking
// ---------------------------------------------------------------------------

async function loadDevelopingItems(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];
  try {
    const resp = await fetch(`${redisUrl}/get/monitor:developing`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.result) return [];
    return JSON.parse(data.result);
  } catch {
    return [];
  }
}

async function updateDevelopingItems(findings, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;

  const developing = await loadDevelopingItems(redisUrl, redisToken);

  // Increment count for developing findings, add new ones
  const developingFindings = findings.filter(f => f.severity === 'developing');
  for (const finding of developingFindings) {
    const topic = finding.title.toLowerCase();
    const existing = developing.find(d => d.topic.toLowerCase() === topic);
    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
    } else {
      developing.push({ topic: finding.title, count: 1, lastSeen: Date.now() });
    }
  }

  // Remove items not seen in last 30 min (6 cycles)
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  const active = developing.filter(d => d.lastSeen > thirtyMinAgo);

  try {
    await fetch(`${redisUrl}/set/monitor:developing/${encodeURIComponent(JSON.stringify(active))}/ex/3600`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Non-critical
  }
}

async function checkDevelopingAlerts(botToken, chatId, redisUrl, redisToken) {
  const developing = await loadDevelopingItems(redisUrl, redisToken);

  for (const item of developing) {
    if (item.count >= DEVELOPING_THRESHOLD) {
      // Check if we already alerted for this developing item
      const dedupeKey = `developing-${slugify(item.topic)}-${Math.floor(Date.now() / 3600000)}`;
      if (await isRecentlyAlerted(redisUrl, redisToken, dedupeKey)) continue;

      await sendIntelAlert(botToken, chatId, {
        severity: 'developing',
        title: item.topic,
        analysis: `This has been building for ${item.count * 5} minutes across ${item.count} analysis cycles. No mainstream trigger yet, but the pattern is consistent.`,
        sources: ['multi-cycle analysis'],
        watchlist_match: null,
        watch_next: ['Escalation in source volume', 'Mainstream media pickup', 'Market reaction'],
      });

      await markAlerted(redisUrl, redisToken, dedupeKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis snapshot storage
// ---------------------------------------------------------------------------

async function loadPreviousSnapshot(redisUrl, redisToken) {
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

async function storeSnapshot(redisUrl, redisToken, snapshot) {
  if (!redisUrl || !redisToken) return;

  try {
    // Truncate snapshot if too large for Redis (max ~1MB for free tier)
    const truncated = snapshot.length > 500000 ? snapshot.slice(0, 500000) : snapshot;
    await fetch(`${redisUrl}/set/monitor:snapshot/${encodeURIComponent(truncated)}/ex/${SNAPSHOT_TTL_SECONDS}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.error('[monitor-check] Failed to store snapshot:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Watchlist loading (same format as telegram-webhook.js)
// ---------------------------------------------------------------------------

async function loadAllWatchlists(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];

  try {
    const resp = await fetch(`${redisUrl}/scan/0/match/watchlist:*/count/100`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    const keys = data.result?.[1] || [];

    const watchlists = [];
    for (const key of keys) {
      try {
        const itemResp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(2000),
        });
        if (!itemResp.ok) continue;
        const itemData = await itemResp.json();
        if (!itemData.result) continue;

        const items = JSON.parse(itemData.result);
        if (Array.isArray(items) && items.length > 0) {
          const chatId = key.replace('watchlist:', '');
          watchlists.push({ chatId, terms: items.map(w => w.term) });
        }
      } catch {
        // Skip this watchlist
      }
    }
    return watchlists;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplication — same pattern as v2.6
// ---------------------------------------------------------------------------

async function isRecentlyAlerted(redisUrl, redisToken, key) {
  if (!redisUrl || !redisToken) return false;
  try {
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.result !== null;
  } catch {
    return false;
  }
}

async function markAlerted(redisUrl, redisToken, key) {
  if (!redisUrl || !redisToken) return;
  try {
    await fetch(`${redisUrl}/set/${encodeURIComponent(key)}/1/ex/3600`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    console.error('[monitor-check] Redis SET failed for key:', key);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
