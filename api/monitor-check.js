/**
 * Smart Monitor Check — Evidence Fusion intelligence analysis cycle.
 *
 * v3.0.0: Evidence Fusion. Replaces monolithic LLM-decides-severity approach
 * with a structured normalize -> cluster -> score -> promote pipeline.
 * LLM now only summarizes pre-scored candidates — it doesn't decide what to alert on.
 *
 * The cycle:
 *   1. COLLECT   — fetch all 9 data sources in parallel
 *   2. FUSE      — normalize records, cluster by entity, score additively, promote by threshold
 *   3. SUMMARIZE — LLM writes analysis + watch_next for promoted candidates only
 *   4. ALERT     — send notable/urgent findings to Telegram with confidence metadata
 *   5. STORE     — save record IDs + snapshot for next cycle
 *
 * Auth: accepts both Vercel cron auth (Bearer token) AND QStash signatures.
 *
 * Env vars required:
 *   CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *   OPENROUTER_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 * Optional:
 *   QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY (for QStash auth)
 *   CLOUDFLARE_API_TOKEN
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
} from './_tools/monitor-tools.js';

import {
  loadAllWatchlists,
  redisSet,
  loadPreviousRecordIds,
  storeRecordIds,
} from './_tools/redis-helpers.js';

import { runFusion } from './_tools/evidence-fusion.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LLM_TIMEOUT_MS = 10000; // Edge = 25s total. Budget: collect 8s + LLM 10s + overhead 5s
const MAX_TOKENS = 1500;  // Shorter output = faster response
const SNAPSHOT_TTL_SECONDS = 600; // 10 min — snapshots expire after 2 cycles
const DEVELOPING_THRESHOLD = 3; // 3 consecutive cycles to trigger "developing" alert
const CYCLE_LOCK_KEY = 'monitor:cycle-lock';
const CYCLE_LOCK_TTL = 30; // seconds — auto-expires if handler crashes

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(request) {
  // --- AUTH: accept Vercel cron OR QStash signature ---
  // AUTH: QStash forwards our Bearer token via Upstash-Forward-Authorization header,
  // which arrives as a standard Authorization header. Both Vercel cron and QStash
  // use the same Bearer token mechanism — no separate signature verification needed.
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
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
  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;

  // Overlap protection: acquire a Redis lock so QStash + Vercel cron
  // can't run concurrent cycles. Lock auto-expires after 30s.
  const lockAcquired = await acquireLock(redisUrl, redisToken);
  if (!lockAcquired) {
    return jsonResponse(200, { skipped: true, reason: 'Another cycle is already running' });
  }

  try {
    // -----------------------------------------------------------------------
    // 1. COLLECT — fetch all data sources in parallel (15s max for entire phase)
    // -----------------------------------------------------------------------
    // Each fetch has its own AbortSignal.timeout (5-8s), so allSettled
    // finishes within ~8s. No outer timeout needed — it would discard ALL
    // partial results on timeout (allSettled returns nothing until done).
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
    // 2. EVIDENCE FUSION — normalize, cluster, score, promote
    // -----------------------------------------------------------------------
    const collectResults = {
      headlines, markets, telegram, reddit, predictions,
      earthquakes, outages, military, govFeeds,
    };

    // Load watchlists and previous record IDs in parallel
    const [watchlists, previousRecordIds, developingItems] = await Promise.all([
      loadAllWatchlists(redisUrl, redisToken),
      loadPreviousRecordIds(redisUrl, redisToken),
      loadDevelopingItems(redisUrl, redisToken),
    ]);
    const watchlistTerms = watchlists.flatMap(w => w.terms);

    // Run the fusion pipeline: normalize -> cluster -> score -> promote
    const { allCandidates, records } = runFusion(collectResults, previousRecordIds, watchlistTerms);
    const promotedCandidates = allCandidates.filter(c => c.severity !== 'routine');

    console.log(`[monitor-check] Fusion: ${records.length} records -> ${allCandidates.length} clusters -> ${promotedCandidates.length} promoted`);

    // -----------------------------------------------------------------------
    // 3. LLM SUMMARIZE — only for promoted candidates (notable/urgent)
    // -----------------------------------------------------------------------
    let findings = [];
    if (promotedCandidates.length > 0) {
      // Ask LLM to write analysis + watch_next for each promoted candidate
      const llmResult = await summarizeCandidates(
        promotedCandidates,
        developingItems,
        openRouterKey,
        groqKey
      );

      if (llmResult && Array.isArray(llmResult.findings)) {
        findings = llmResult.findings;
      } else {
        // LLM failed — use fusion data directly (no analysis text, but scores are valid)
        findings = promotedCandidates.map(c => ({
          severity: c.severity,
          title: c.entities.slice(0, 3).join(' / ') || 'Unknown event',
          analysis: `Confidence ${c.confidence}: ${c.records.length} records from ${new Set(c.records.map(r => r.sourceId)).size} sources.`,
          sources: [...new Set(c.records.map(r => r.sourceId))],
          watchlist_match: c.watchlistMatch,
          watch_next: ['Monitor source volume', 'Check for mainstream pickup'],
          _confidence: c.confidence,
          _scoreBreakdown: c.scoreBreakdown,
        }));
      }
    }

    // -----------------------------------------------------------------------
    // 4. ALERT — send notable/urgent findings to Telegram
    // -----------------------------------------------------------------------
    let alertsSent = 0;
    let skippedDeveloping = 0;
    let skippedDuplicate = 0;

    if (findings.length > 0) {
      const recentTitles = await loadRecentAlertTitles(redisUrl, redisToken);

      for (const finding of findings) {
        if (!finding || typeof finding !== 'object') continue;
        if (typeof finding.severity !== 'string') continue;
        if (typeof finding.title !== 'string' || finding.title.length === 0) continue;

        if (finding.severity === 'routine') continue;

        // Telegram-only source check — create new object instead of mutating
        const sources = Array.isArray(finding.sources)
          ? finding.sources.filter(s => typeof s === 'string')
          : [];
        const sourceTypes = new Set(sources.map(s => s.split(':')[0]));
        const isTelegramOnly = sourceTypes.size === 1 && sourceTypes.has('telegram');
        let alertFinding = finding;
        if (isTelegramOnly && finding.severity !== 'developing') {
          alertFinding = {
            ...finding,
            severity: 'developing',
            title: finding.title.startsWith('UNVERIFIED')
              ? finding.title
              : `UNVERIFIED: ${finding.title}`,
          };
        }

        if (alertFinding.severity === 'developing') { skippedDeveloping++; continue; }

        // Similarity dedup
        const isDuplicate = recentTitles.some(
          recent => jaccardSimilarity(finding.title, recent) > 0.4
        );
        if (isDuplicate) { skippedDuplicate++; continue; }

        // Add fusion metadata to the alert
        await sendIntelAlert(botToken, chatId, alertFinding);
        await saveRecentAlertTitle(redisUrl, redisToken, finding.title);
        alertsSent++;
      }

      // Track developing items from LLM findings
      await updateDevelopingItems(findings, redisUrl, redisToken);
    }

    // Check developing items that have hit the threshold
    await checkDevelopingAlerts(botToken, chatId, redisUrl, redisToken);

    // -----------------------------------------------------------------------
    // 5. STORE — save record IDs for next-cycle delta detection
    // -----------------------------------------------------------------------
    const currentRecordIds = records.map(r => r.id);
    await storeRecordIds(redisUrl, redisToken, currentRecordIds);

    // Also store snapshot for /brief and other features that use it
    if (records.length > 0) {
      const currentSnapshot = buildSnapshot(collectResults);
      await storeSnapshot(redisUrl, redisToken, currentSnapshot);
    }

    await releaseLock(redisUrl, redisToken);
    return jsonResponse(200, {
      ok: true,
      alertsSent,
      fusionClusters: allCandidates.length,
      promoted: promotedCandidates.length,
      findings: findings.length,
      skippedDeveloping,
      skippedDuplicate,
    });
  } catch (err) {
    await releaseLock(redisUrl, redisToken);
    console.error('[monitor-check] Cycle failed:', err.message || err);
    return jsonResponse(500, { error: 'Analysis cycle failed' });
  }
}

// ---------------------------------------------------------------------------
// Cycle lock — prevents overlapping runs from QStash + Vercel cron
// ---------------------------------------------------------------------------

/**
 * Try to acquire an exclusive lock via Redis SET NX EX.
 * Returns true if lock acquired, false if another cycle holds it.
 */
async function acquireLock(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return true; // No Redis = no locking, proceed

  try {
    const resp = await fetch(`${redisUrl}/set/${CYCLE_LOCK_KEY}/1/EX/${CYCLE_LOCK_TTL}/NX`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return true; // Redis error = don't block, proceed

    const data = await resp.json();
    return data.result === 'OK';
  } catch {
    return true; // Network error = don't block, proceed
  }
}

/**
 * Release the cycle lock.
 */
async function releaseLock(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;

  try {
    await fetch(`${redisUrl}/del/${CYCLE_LOCK_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Lock will auto-expire via TTL
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
    sections.push(`PREDICTION MARKETS (Polymarket):\n${markets.map(m => `- ${m.title}: ${m.probability ?? 'N/A'}% (vol: $${Math.round(m.volume || 0).toLocaleString('en-US')})`).join('\n')}`);
  }

  // Earthquakes
  if (results.earthquakes.status === 'fulfilled' && results.earthquakes.value?.length > 0) {
    sections.push(`EARTHQUAKES:\n${results.earthquakes.value.map(eq => `- M${(eq.mag || 0).toFixed(1)} — ${eq.place} (${eq.time})`).join('\n')}`);
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

/**
 * Summarize pre-scored fusion candidates using LLM.
 *
 * The LLM writes analysis + watch_next for each candidate.
 * It does NOT set severity or confidence — those come from the fusion engine.
 * This cuts LLM input tokens by ~60% vs the old full-dump approach.
 */
async function summarizeCandidates(promotedCandidates, developingItems, openRouterKey, groqKey) {
  const developingSection = developingItems.length > 0
    ? `\nDEVELOPING ITEMS FROM PREVIOUS CYCLES:\n${developingItems.map(d => `- "${d.topic}" (${d.count} consecutive cycles)`).join('\n')}`
    : '';

  // Build compact candidate summaries for the LLM
  const candidateSummaries = promotedCandidates.map((c, i) => {
    const sources = [...new Set(c.records.map(r => r.sourceId))];
    const sampleTexts = c.records.slice(0, 5).map(r => `  - [${r.sourceId}] ${r.text.substring(0, 150)}`).join('\n');
    return `EVENT ${i + 1} (severity: ${c.severity}, confidence: ${c.confidence}, entities: ${c.entities.join(', ')}):
Sources: ${sources.join(', ')}
Score breakdown: reliability=${c.scoreBreakdown.reliability}, corroboration=${c.scoreBreakdown.corroboration}, recency=${c.scoreBreakdown.recency}, cross_domain=${c.scoreBreakdown.crossDomain}, novelty=${c.scoreBreakdown.novelty}, contradiction=${c.scoreBreakdown.contradiction}
${c.watchlistMatch ? `Watchlist match: "${c.watchlistMatch}"` : ''}
Sample records:
${sampleTexts}`;
  }).join('\n\n');

  const analysisPrompt = `These events have been pre-scored by the evidence fusion system.
For each event, write:
1. A short headline title (5-10 words)
2. A 2-3 sentence analysis explaining what is happening and why it matters
3. 2-3 specific indicators to watch next

Do NOT change the severity — it has been set by the scoring system.
${developingSection}

PRE-SCORED EVENTS:
${candidateSummaries}

OUTPUT FORMAT (respond ONLY with valid JSON, no markdown code fences):
{
  "findings": [
    {
      "title": "Short headline",
      "analysis": "2-3 sentences explaining what is happening and why it matters",
      "watch_next": ["indicator 1", "indicator 2"]
    }
  ]
}

RULES:
- Output exactly ${promotedCandidates.length} findings, one per event, in the same order.
- Keep titles consistent across cycles. Use consistent topic-level names.
- Telegram-only claims should note "UNVERIFIED" in analysis.
- Be concise. The scoring system already determined importance.`;

  const messages = [
    { role: 'system', content: 'You are an intelligence analysis system. Output ONLY valid JSON. No explanatory text.' },
    { role: 'user', content: analysisPrompt },
  ];

  // Call LLM — same provider cascade as before
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

      const parsed = JSON.parse(content);

      // Merge LLM output back into fusion candidates
      // LLM provides title + analysis + watch_next; fusion provides severity, sources, confidence
      const mergedFindings = promotedCandidates.map((candidate, i) => {
        const llmFinding = parsed.findings?.[i] || {};
        const sources = [...new Set(candidate.records.map(r => r.sourceId))];

        return {
          severity: candidate.severity,
          title: llmFinding.title || candidate.entities.slice(0, 3).join(' / '),
          analysis: llmFinding.analysis || '',
          sources,
          watchlist_match: candidate.watchlistMatch,
          watch_next: llmFinding.watch_next || [],
          _confidence: candidate.confidence,
          _scoreBreakdown: candidate.scoreBreakdown,
        };
      });

      console.log(`[monitor-check] ${provider.name} summarized ${mergedFindings.length} candidates`);
      return { findings: mergedFindings };
    } catch (err) {
      console.error(`[monitor-check] ${provider.name} failed:`, err.message || err);
    }
  }

  console.error('[monitor-check] All LLM providers failed for summarization');
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
    `${emoji} *${severityLabel}* \\- ${escapeMarkdown(finding.title)}`,
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

  // Fusion metadata — show confidence score and source count
  if (finding._confidence != null) {
    const sourceCount = Array.isArray(finding.sources) ? finding.sources.length : 0;
    const breakdown = finding._scoreBreakdown || {};
    const metaParts = [`conf: ${finding._confidence}`];
    if (sourceCount > 0) metaParts.push(`${sourceCount} sources`);
    if (breakdown.crossDomain > 0) metaParts.push(`cross\\-domain`);
    parts.push(`_${metaParts.join(' \\| ')}_`);
  }

  parts.push('');
  parts.push('_5\\-min cycle \\| evidence fusion_');

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
      const confStr = finding._confidence != null ? `\n\nConfidence: ${finding._confidence}` : '';
      const plainText = `${finding.severity.toUpperCase()} — ${finding.title}\n\n${finding.analysis || ''}\n\nSources: ${(finding.sources || []).join(', ')}${confStr}`;
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

  const existing = await loadDevelopingItems(redisUrl, redisToken);
  const now = Date.now();

  // Build updated list immutably — increment existing, add new
  const developingFindings = findings.filter(f => f.severity === 'developing');
  let updated = existing.map(d => {
    const match = developingFindings.find(f => f.title.toLowerCase() === d.topic.toLowerCase());
    if (match) return { ...d, count: d.count + 1, lastSeen: now };
    return d;
  });

  // Add new developing items not already tracked
  for (const finding of developingFindings) {
    const alreadyTracked = updated.some(d => d.topic.toLowerCase() === finding.title.toLowerCase());
    if (!alreadyTracked) {
      updated = [...updated, { topic: finding.title, count: 1, lastSeen: now }];
    }
  }

  // Remove items not seen in last 30 min (6 cycles)
  const thirtyMinAgo = now - 30 * 60 * 1000;
  const active = updated.filter(d => d.lastSeen > thirtyMinAgo);

  try {
    await redisSet(redisUrl, redisToken, 'monitor:developing', JSON.stringify(active), 3600);
  } catch (err) {
    console.error('[monitor-check] Failed to save developing items:', err.message);
  }
}

async function checkDevelopingAlerts(botToken, chatId, redisUrl, redisToken) {
  const developing = await loadDevelopingItems(redisUrl, redisToken);
  const recentTitles = await loadRecentAlertTitles(redisUrl, redisToken);

  for (const item of developing) {
    if (item.count >= DEVELOPING_THRESHOLD) {
      // Similarity dedup for developing alerts too
      const isDuplicate = recentTitles.some(
        recent => jaccardSimilarity(item.topic, recent) > 0.4
      );
      if (isDuplicate) continue;

      await sendIntelAlert(botToken, chatId, {
        severity: 'developing',
        title: item.topic,
        analysis: `This has been building for ${item.count * 5} minutes across ${item.count} analysis cycles. No mainstream trigger yet, but the pattern is consistent.`,
        sources: ['multi-cycle analysis'],
        watchlist_match: null,
        watch_next: ['Escalation in source volume', 'Mainstream media pickup', 'Market reaction'],
      });

      await saveRecentAlertTitle(redisUrl, redisToken, item.topic);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis snapshot storage
// ---------------------------------------------------------------------------

async function storeSnapshot(redisUrl, redisToken, snapshot) {
  if (!redisUrl || !redisToken) return;

  try {
    // Truncate snapshot if too large for Redis (max ~1MB for free tier)
    if (snapshot.length > 500000) {
      console.warn(`[monitor-check] Snapshot truncated: ${snapshot.length} → 500000 chars (${Math.round((snapshot.length - 500000) / 1000)}KB lost)`);
    }
    const truncated = snapshot.length > 500000 ? snapshot.slice(0, 500000) : snapshot;
    await redisSet(redisUrl, redisToken, 'monitor:snapshot', truncated, SNAPSHOT_TTL_SECONDS);
  } catch (err) {
    console.error('[monitor-check] Failed to store snapshot:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Similarity-based deduplication
// ---------------------------------------------------------------------------

const RECENT_ALERTS_KEY = 'monitor:recent-alerts';
const RECENT_ALERTS_TTL = 7200; // 2 hours
const MAX_RECENT_ALERTS = 50;

/**
 * Jaccard word similarity — compares word overlap between two strings.
 * Returns 0.0 (no overlap) to 1.0 (identical words).
 * Zero dependencies, fast, works well for short alert titles.
 */
function jaccardSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Load recent alert titles from Redis (last 50, 2h TTL).
 */
async function loadRecentAlertTitles(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];
  try {
    const resp = await fetch(`${redisUrl}/get/${RECENT_ALERTS_KEY}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.result) return [];
    const titles = JSON.parse(data.result);
    return Array.isArray(titles) ? titles : [];
  } catch {
    return [];
  }
}

/**
 * Save a new alert title to the recent alerts list.
 */
async function saveRecentAlertTitle(redisUrl, redisToken, title) {
  if (!redisUrl || !redisToken) return;
  try {
    const existing = await loadRecentAlertTitles(redisUrl, redisToken);
    const updated = [...existing, title].slice(-MAX_RECENT_ALERTS);
    await redisSet(redisUrl, redisToken, RECENT_ALERTS_KEY, JSON.stringify(updated), RECENT_ALERTS_TTL);
  } catch (err) {
    console.error('[monitor-check] Failed to save recent alert title:', err.message);
  }
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
