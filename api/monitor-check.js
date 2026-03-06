/**
 * Smart Monitor Check — Evidence Fusion intelligence analysis cycle.
 *
 * v3.0.0: Evidence Fusion. Replaces monolithic LLM-decides-severity approach
 * with a structured normalize -> cluster -> score -> promote pipeline.
 * LLM now only summarizes pre-scored candidates — it doesn't decide what to alert on.
 *
 * The cycle:
 *   1. COLLECT   — fetch all 11 data sources in parallel
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
  fetchTwitterOsint,
  fetchBlueskyOsint,
  fetchCISAAlerts,
  fetchTravelAdvisories,
  fetchGPSJamming,
  fetchOFACSanctions,
  fetchGDACSAlerts,
} from './_tools/monitor-tools.js';

import {
  loadAllWatchlists,
  redisSet,
  loadPreviousRecordIds,
  storeRecordIds,
  updateWatchlistMatchStats,
} from './_tools/redis-helpers.js';

import { normalize, cluster, score, promote } from './_tools/evidence-fusion.js';
import { getReliability, TELEGRAM_MAINSTREAM, TELEGRAM_OSINT_VERIFIED } from './_tools/source-reliability.js';
import { createCycleTelemetry, storeTelemetry } from './_tools/telemetry.js';
import { updateLedger, loadLedgerEntries, computeBaselines } from './_tools/event-ledger.js';
import { detectAnomalies, detectEscalation, detectConvergence, generateHistoricalContext } from './_tools/intel-analysis.js';
import { acquireLock, releaseLock } from './_tools/cycle-lock.js';
import { buildSnapshot, storeSnapshot } from './_tools/snapshot-builder.js';
import { isDuplicateAlert, loadRecentAlerts, saveRecentAlert } from './_tools/alert-dedup.js';
import { formatSourceName, sendIntelAlert } from './_tools/alert-sender.js';
import { loadDevelopingItems, updateDevelopingItems, checkDevelopingAlerts } from './_tools/developing-tracker.js';
import { buildEvidenceProfile, buildTriggerExplanation } from './_tools/evidence-gate.js';
import { filterLowSignalRecords } from './_tools/intel-noise.js';
import { classifySourceResult, mergeSourceHealth } from './_tools/source-health.js';
import { findCandidateWatchlistMatches } from './_tools/watchlist-utils.js';
import {
  buildCandidateSupport,
  buildCandidateChangeSummary,
  buildCandidateUncertaintySummary,
  buildCandidateFactLine,
  buildEvidenceNarrative,
} from './_tools/alert-enrichment.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LLM_TIMEOUT_MS = 15000; // Edge = 25s total. Budget: collect 6s + LLM 15s + overhead 4s
const MAX_TOKENS = 1800;  // ~360 words per finding for top 5 candidates
const SNAPSHOT_TTL_SECONDS = 900; // 15 min — survives 2 full 5-min cycles with buffer
const MAX_ALERTS_PER_CYCLE = 3; // Telegram-first workflow: fewer, sharper alerts
const ENABLE_TWITTER_ALERT_SOURCE = process.env.ENABLE_TWITTER_ALERT_SOURCE === '1';

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

  // Derive cycle timestamp once — all downstream code uses this, not Date.now()
  // Truncated to 5-min boundary so QStash retries get the same key
  const cycleNow = Date.now();
  const cycleTsBoundary = Math.floor(cycleNow / 300000) * 300000;
  const cycleKey = `cycle:${new Date(cycleTsBoundary).toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;

  // Idempotency: SET NX EX — if key exists, this cycle already ran (or is running)
  // Prevents QStash retry double-writes and concurrent Vercel cron overlap
  const lockAcquired = await acquireLock(redisUrl, redisToken, cycleKey);
  if (!lockAcquired) {
    return jsonResponse(200, { skipped: true, reason: 'Cycle already processed', cycleKey });
  }

  try {
    // -----------------------------------------------------------------------
    // 1. COLLECT — fetch all data sources in parallel, timed
    // -----------------------------------------------------------------------
    const telem = createCycleTelemetry();

    const sourceTasks = [
      { name: 'headlines', fetch: () => fetchGoogleNewsHeadlines() },
      { name: 'markets', fetch: () => fetchMarketQuotes() },
      { name: 'telegram', fetch: () => fetchAllTelegramChannels() },
      { name: 'reddit', fetch: () => fetchAllRedditPosts() },
      { name: 'predictions', fetch: () => fetchGeopoliticalMarkets() },
      { name: 'earthquakes', fetch: () => fetchEarthquakes() },
      { name: 'outages', fetch: () => fetchInternetOutages(cloudflareToken) },
      { name: 'military', fetch: () => fetchMilitaryNews() },
      { name: 'govFeeds', fetch: () => fetchGovFeeds() },
      ENABLE_TWITTER_ALERT_SOURCE
        ? { name: 'twitter', fetch: () => fetchTwitterOsint() }
        : { name: 'twitter', disabled: true },
      { name: 'bluesky', fetch: () => fetchBlueskyOsint() },
      { name: 'cisaAlerts', fetch: () => fetchCISAAlerts() },
      { name: 'travelAdvisories', fetch: () => fetchTravelAdvisories() },
      { name: 'gpsJamming', fetch: () => fetchGPSJamming() },
      { name: 'sanctions', fetch: () => fetchOFACSanctions(redisUrl, redisToken) },
      { name: 'gdacsEnhanced', fetch: () => fetchGDACSAlerts() },
    ];

    const {
      results: collectResults,
      assessments: sourceAssessments,
    } = await telem.stage('collect', async () => {
      const activeTasks = sourceTasks.filter((task) => !task.disabled);
      const settled = await Promise.allSettled(activeTasks.map((task) => task.fetch()));

      const results = {};
      const assessments = {};
      let succeeded = 0;
      let degraded = 0;
      let failed = 0;
      let disabled = 0;
      let activeIndex = 0;

      for (const task of sourceTasks) {
        if (task.disabled) {
          results[task.name] = { status: 'fulfilled', value: [] };
          assessments[task.name] = { status: 'degraded', sampleSize: 0, reason: 'disabled_by_default' };
          degraded++;
          disabled++;
          continue;
        }

        const settledResult = settled[activeIndex++];
        results[task.name] = settledResult;
        const assessment = classifySourceResult(task.name, settledResult);
        assessments[task.name] = assessment;

        if (assessment.status === 'ok') succeeded++;
        else if (assessment.status === 'degraded') degraded++;
        else failed++;
      }

      return {
        _meta: {
          succeeded,
          degraded,
          failed,
          disabled,
          totalSources: sourceTasks.length,
        },
        _value: { results, assessments },
      };
    });

    // -----------------------------------------------------------------------
    // 1b. SOURCE HEALTH — track which sources succeeded/failed
    // -----------------------------------------------------------------------
    const sourceHealth = await updateSourceHealth(redisUrl, redisToken, sourceAssessments);

    // -----------------------------------------------------------------------
    // 2. EVIDENCE FUSION — normalize, cluster, score, promote (individually timed)
    // -----------------------------------------------------------------------

    // Load watchlists and previous record IDs in parallel
    const [watchlists, previousRecordIds, developingItems] = await Promise.all([
      loadAllWatchlists(redisUrl, redisToken),
      loadPreviousRecordIds(redisUrl, redisToken),
      loadDevelopingItems(redisUrl, redisToken),
    ]);
    const watchlistTerms = watchlists.flatMap((watchlist) => watchlist.items?.map((item) => item.term) || watchlist.terms || []);

    const records = await telem.stage('normalize', () => {
      const r = filterLowSignalRecords(normalize(collectResults), watchlistTerms);
      return { _meta: { recordCount: r.length }, _value: r };
    });

    const candidates = await telem.stage('cluster', () => {
      const c = cluster(records);
      return { _meta: { clusterCount: c.length }, _value: c };
    });

    const scored = await telem.stage('score', () => {
      return { _value: score(candidates, previousRecordIds) };
    });

    // Tag watchlist matches before promotion
    const tagged = scored.map(candidate => {
      const matches = findCandidateWatchlistMatches(candidate, watchlists);
      return {
        ...candidate,
        watchlistMatches: matches,
        watchlistMatch: matches[0]?.term || null,
      };
    });

    const allCandidates = await telem.stage('promote', () => {
      const promoted = promote(tagged);
      const sorted = [...promoted].sort((a, b) => b.confidence - a.confidence);
      const promotedCount = sorted.filter(c => c.severity !== 'routine').length;
      return { _meta: { promoted: promotedCount }, _value: sorted };
    });

    const promotedCandidates = allCandidates.filter(c => c.severity !== 'routine');
    console.log(`[monitor-check] Fusion: ${records.length} records -> ${allCandidates.length} clusters -> ${promotedCandidates.length} promoted`);

    // -----------------------------------------------------------------------
    // 2b. LEDGER — persist entity observations for memory + baselines
    // -----------------------------------------------------------------------
    await telem.stage('ledger', async () => {
      await updateLedger(promotedCandidates, cycleKey, cycleTsBoundary, redisUrl, redisToken);
      return { _meta: { entities: promotedCandidates.flatMap(c => c.entities).length }, _value: null };
    });

    // -----------------------------------------------------------------------
    // 2c. ANALYZE — anomaly detection, escalation, convergence, historical context
    // -----------------------------------------------------------------------
    let analysisResults = { anomalies: [], escalations: [], convergences: [], historicalContext: [] };

    if (promotedCandidates.length > 0) {
      analysisResults = await telem.stage('analyze', async () => {
        // Load ledger data and baselines for entities in this cycle
        const allEntities = [...new Set(promotedCandidates.flatMap(c => c.entities))];
        const [ledgerEntries, baselines] = await Promise.all([
          loadLedgerEntries(allEntities, redisUrl, redisToken),
          computeBaselines(allEntities, redisUrl, redisToken),
        ]);

        // Run all four analysis functions (all deterministic, no LLM)
        const anomalies = detectAnomalies(promotedCandidates, baselines);
        const escalations = detectEscalation(ledgerEntries);
        const convergences = detectConvergence(allCandidates); // Uses ALL candidates for domain coverage
        const historicalContext = generateHistoricalContext(promotedCandidates, ledgerEntries, baselines);

        const results = { anomalies, escalations, convergences, historicalContext };
        return {
          _meta: {
            anomalies: anomalies.length,
            escalations: escalations.length,
            convergences: convergences.length,
            contextLines: historicalContext.length,
          },
          _value: results,
        };
      });
    }

    // -----------------------------------------------------------------------
    // 3. LLM SUMMARIZE — only for promoted candidates (notable/urgent)
    // -----------------------------------------------------------------------
    let findings = [];
    if (promotedCandidates.length > 0) {
      findings = await telem.stage('summarize', async () => {
        // Cap LLM input to top 5 by confidence — avoids prompt bloat that causes timeouts
        const LLM_CANDIDATE_LIMIT = 5;
        const llmCandidates = promotedCandidates.slice(0, LLM_CANDIDATE_LIMIT);
        const overflowCandidates = promotedCandidates.slice(LLM_CANDIDATE_LIMIT);

        const llmResult = await summarizeCandidates(
          llmCandidates,
          developingItems,
          openRouterKey,
          groqKey,
          analysisResults
        );

        // Build fallback findings for overflow candidates (or all if LLM failed)
        const buildFallback = (c) => {
          const sourceNames = [...new Set(c.records.map(r => r.sourceId))];
          const sampleTexts = c.records
            .slice(0, 3)
            .map(r => `[${formatSourceName(r.sourceId)}] ${r.text.substring(0, 200)}`)
            .join('\n');
          return buildStructuredFinding(c, {
            analysis: sampleTexts,
            why_matters: c.records[0]?.text?.substring(0, 220) || '',
            watch_next: [`${c.records.length} record(s) from ${sourceNames.length} source(s)`, `Score: ${c.confidence}`],
          }, analysisResults);
        };

        const overflowFindings = overflowCandidates.map(buildFallback);

        if (llmResult && Array.isArray(llmResult.findings)) {
          return { _meta: { llmProvider: llmResult.provider }, _value: [...llmResult.findings, ...overflowFindings] };
        }
        // LLM failed entirely — fallback for all candidates
        return {
          _meta: { llmErrors: llmResult?.errors || ['unknown failure'] },
          _value: promotedCandidates.map(buildFallback),
        };
      });
    }

    // -----------------------------------------------------------------------
    // 4. ALERT — send notable/urgent findings to Telegram
    // -----------------------------------------------------------------------
    const alertResult = await telem.stage('alert', async () => {
      let alertsSent = 0;
      let skippedDeveloping = 0;
      let skippedDuplicate = 0;
      let watchlistHitsUpdated = 0;

      if (findings.length > 0) {
        const recentAlerts = await loadRecentAlerts(redisUrl, redisToken);
        const trustworthyWatchlistMatches = allCandidates
          .filter((candidate) => candidate.watchlistMatches?.length > 0)
          .filter((candidate) => candidate.sourceProfile?.passesTrustGate || candidate.sourceProfile?.verifiedSourceCount >= 1)
          .flatMap((candidate) => candidate.watchlistMatches);

        if (trustworthyWatchlistMatches.length > 0) {
          await updateWatchlistMatchStats(trustworthyWatchlistMatches, redisUrl, redisToken, cycleTsBoundary);
          watchlistHitsUpdated = trustworthyWatchlistMatches.length;
        }

        for (const finding of findings) {
          if (!finding || typeof finding !== 'object') continue;
          if (typeof finding.severity !== 'string') continue;
          if (typeof finding.title !== 'string' || finding.title.length === 0) continue;

          if (finding.severity === 'routine') continue;
          if (finding._sourceProfile && finding._sourceProfile.passesTrustGate === false) continue;

          // Cap alerts per cycle to prevent notification floods
          if (alertsSent >= MAX_ALERTS_PER_CYCLE) break;

          // Tier-aware Telegram source check — don't blanket-suppress verified OSINT
          const sources = Array.isArray(finding.sources)
            ? finding.sources.filter(s => typeof s === 'string')
            : [];
          const sourceTypes = new Set(sources.map(s => s.split(':')[0]));
          const isTelegramOnly = sourceTypes.size === 1 && sourceTypes.has('telegram');
          let alertFinding = finding;
          if (isTelegramOnly && finding.severity !== 'developing') {
            // Count how many sources are mainstream or OSINT-verified
            const verifiedCount = sources.filter(s => {
              const channel = s.startsWith('telegram:') ? s.split(':')[1] : '';
              return TELEGRAM_MAINSTREAM.has(channel) || TELEGRAM_OSINT_VERIFIED.has(channel);
            }).length;

            if (verifiedCount >= 2) {
              // 2+ verified/OSINT sources — keep original severity
              alertFinding = finding;
            } else if (verifiedCount === 1) {
              // 1 verified source — cap at notable (don't suppress to developing)
              const cappedSeverity = finding.severity === 'urgent' || finding.severity === 'breaking'
                ? 'notable' : finding.severity;
              alertFinding = { ...finding, severity: cappedSeverity };
            } else {
              // 0 verified sources — downgrade to developing
              alertFinding = {
                ...finding,
                severity: 'developing',
                title: finding.title.startsWith('UNVERIFIED')
                  ? finding.title
                  : `UNVERIFIED: ${finding.title}`,
              };
            }
          }

          if (alertFinding.severity === 'developing') { skippedDeveloping++; continue; }

          const isDuplicate = isDuplicateAlert(alertFinding, recentAlerts);
          if (isDuplicate) { skippedDuplicate++; continue; }

          // Add fusion metadata to the alert
          await sendIntelAlert(botToken, chatId, alertFinding);
          // Save only top 5 entities — prevents bloated entity lists from blocking everything
          const topEntities = (finding._entities || []).slice(0, 5);
          await saveRecentAlert(redisUrl, redisToken, alertFinding.title, topEntities, alertFinding.severity);
          recentAlerts.push({ title: alertFinding.title, entities: topEntities, severity: alertFinding.severity });
          alertsSent++;

          // Rapid re-check disabled — QStash cascade caused alert floods.
          // TODO: Re-enable with proper rate limiting (e.g., 1 re-check per cluster, not per alert)
          // if (alertFinding.severity === 'breaking' || alertFinding.severity === 'urgent') {
          //   await scheduleRecheck(redisUrl, redisToken);
          // }
        }

        // Track developing items from LLM findings
        await updateDevelopingItems(findings, redisUrl, redisToken);
      }

      // Check developing items that have hit the threshold
      await checkDevelopingAlerts(botToken, chatId, redisUrl, redisToken);

      return {
        _meta: { sent: alertsSent },
        _value: { alertsSent, skippedDeveloping, skippedDuplicate, watchlistHitsUpdated },
      };
    });

    // -----------------------------------------------------------------------
    // 5. STORE — save record IDs + telemetry + snapshot for next cycle
    // -----------------------------------------------------------------------
    const currentRecordIds = records.map(r => r.id);
    await storeRecordIds(redisUrl, redisToken, currentRecordIds);

    // Store snapshot for /brief and other features that use it
    if (records.length > 0) {
      const currentSnapshot = buildSnapshot(collectResults);
      await storeSnapshot(redisUrl, redisToken, currentSnapshot, SNAPSHOT_TTL_SECONDS);
    }

    // -----------------------------------------------------------------------
    // 5b. DIGEST-CACHE — save bounded daily cache for daily digest
    // -----------------------------------------------------------------------
    await updateDigestCache(redisUrl, redisToken, promotedCandidates, allCandidates, sourceHealth, cycleTsBoundary);

    // Finalize and store telemetry
    const telemetry = telem.finish();
    await storeTelemetry(redisUrl, redisToken, telemetry);

    await releaseLock(redisUrl, redisToken);

    return jsonResponse(200, {
      ok: true,
      cycleKey,
      alertsSent: alertResult.alertsSent,
      fusionClusters: allCandidates.length,
      promoted: promotedCandidates.length,
      findings: findings.length,
      skippedDeveloping: alertResult.skippedDeveloping,
      skippedDuplicate: alertResult.skippedDuplicate,
      watchlistHitsUpdated: alertResult.watchlistHitsUpdated,
      sourceHealth,
      analysis: {
        anomalies: analysisResults.anomalies?.length || 0,
        escalations: analysisResults.escalations?.length || 0,
        convergences: analysisResults.convergences?.length || 0,
      },
      telemetry,
    });
  } catch (err) {
    await releaseLock(redisUrl, redisToken);
    console.error('[monitor-check] Cycle failed:', err.message || err);
    return jsonResponse(500, { error: 'Analysis cycle failed' });
  }
}


// ---------------------------------------------------------------------------
// AI analysis cycle
// ---------------------------------------------------------------------------

/**
 * Build analysis context section for the LLM prompt.
 * Contains anomalies, convergences, and historical context from deterministic analysis.
 */
function buildAnalysisSection(analysisResults) {
  const sections = [];

  if (analysisResults.anomalies?.length > 0) {
    const lines = analysisResults.anomalies.map(a =>
      `- ${a.displayName}: ${a.ratio}x above baseline (${a.currentSources} sources, normally ${a.baselineDaily}/day)`
    );
    sections.push(`ANOMALIES DETECTED:\n${lines.join('\n')}`);
  }

  if (analysisResults.convergences?.length > 0) {
    const lines = analysisResults.convergences.map(c =>
      `- ${c.displayName}: signals from ${c.domains.join(' + ')} (${c.domainCount} domains)`
    );
    sections.push(`CROSS-DOMAIN CONVERGENCE:\n${lines.join('\n')}`);
  }

  if (analysisResults.escalations?.length > 0) {
    const lines = analysisResults.escalations.map(e =>
      `- ${e.displayName}: severity rising (delta +${e.severityDelta}), ${e.escalationsThisMonth} notable+ events this month`
    );
    sections.push(`ESCALATION DETECTED:\n${lines.join('\n')}`);
  }

  if (analysisResults.historicalContext?.length > 0) {
    sections.push(`HISTORICAL CONTEXT:\n${analysisResults.historicalContext.map(l => `- ${l}`).join('\n')}`);
  }

  return sections.length > 0 ? '\n' + sections.join('\n\n') : '';
}

export function deriveGroundedTitle(candidate) {
  const bestRecord = candidate?.records
    ?.filter((record) => record.text && record.text.length > 15)
    .sort((a, b) => {
      const relA = getReliability(a.sourceId, a.meta);
      const relB = getReliability(b.sourceId, b.meta);
      return (relB?.score || 0) - (relA?.score || 0);
    })[0];

  if (!bestRecord?.text) {
    return candidate?.entities?.slice(0, 3).join(', ') + ': developing situation';
  }

  return bestRecord.text
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+-\s+(Reuters|AP News|Associated Press|BBC News|Bloomberg|The Guardian|Guardian|CNN|CNBC|CBS News|NBC News)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

function buildStructuredFinding(candidate, llmFinding = {}, analysisResults = {}) {
  const sources = [...new Set(candidate.records.map((record) => record.sourceId))];
  const sourceProfile = candidate.sourceProfile || buildEvidenceProfile(candidate.records);
  const whyTriggered = buildTriggerExplanation(sourceProfile, candidate.watchlistMatch);
  const support = buildCandidateSupport(candidate);

  return {
    severity: candidate.severity,
    title: deriveGroundedTitle(candidate),
    fact_line: buildCandidateFactLine(candidate, llmFinding.fact_line || ''),
    analysis: llmFinding.analysis || '',
    why_matters: llmFinding.why_matters || llmFinding.why_now || '',
    why_i_believe: buildEvidenceNarrative({ support, _sourceProfile: sourceProfile }),
    what_changed: buildCandidateChangeSummary(candidate),
    uncertainty: buildCandidateUncertaintySummary(candidate, llmFinding.uncertainty || ''),
    sources,
    support,
    watchlist_match: candidate.watchlistMatch,
    watch_next: Array.isArray(llmFinding.watch_next)
      ? llmFinding.watch_next.filter((item) => typeof item === 'string' && item.trim()).slice(0, 4)
      : [],
    _confidence: candidate.confidence,
    _scoreBreakdown: candidate.scoreBreakdown,
    _entities: candidate.entities,
    _analysis: analysisResults || {},
    _sourceProfile: sourceProfile,
    _whyTriggered: whyTriggered,
  };
}

/**
 * Summarize pre-scored fusion candidates using LLM.
 *
 * The LLM writes analysis + watch_next for each candidate.
 * It does NOT set severity or confidence — those come from the fusion engine.
 * This cuts LLM input tokens by ~60% vs the old full-dump approach.
 */
async function summarizeCandidates(promotedCandidates, developingItems, openRouterKey, groqKey, analysisResults) {
  const developingSection = developingItems.length > 0
    ? `\nDEVELOPING ITEMS FROM PREVIOUS CYCLES:\n${developingItems.map(d => `- "${d.topic}" (${d.count} consecutive cycles)`).join('\n')}`
    : '';

  // Build analysis context from deterministic intel analysis
  const analysisSection = buildAnalysisSection(analysisResults || {});

  // Build compact candidate summaries for the LLM
  const candidateSummaries = promotedCandidates.map((c, i) => {
    const sources = [...new Set(c.records.map(r => formatSourceName(r.sourceId)))];
    const sampleTexts = c.records.slice(0, 5).map(r => {
      const timeLabel = r.timestamp ? new Date(r.timestamp).toISOString().slice(11, 16) + ' UTC' : '';
      return `  - [${formatSourceName(r.sourceId)}] ${timeLabel ? `[${timeLabel}] ` : ''}${r.text.substring(0, 350)}`;
    }).join('\n');
    return `EVENT ${i + 1} (severity: ${c.severity}, confidence: ${c.confidence}, entities: ${c.entities.join(', ')}):
Sources: ${sources.join(', ')}
Score breakdown: reliability=${c.scoreBreakdown.reliability}, corroboration=${c.scoreBreakdown.corroboration}, recency=${c.scoreBreakdown.recency}, cross_domain=${c.scoreBreakdown.crossDomain}, novelty=${c.scoreBreakdown.novelty}, contradiction=${c.scoreBreakdown.contradiction}
${c.watchlistMatch ? `Watchlist match: "${c.watchlistMatch}"` : ''}
Sample records:
${sampleTexts}`;
  }).join('\n\n');

  const analysisPrompt = `You are writing intelligence alert briefs. Read the SOURCE RECORDS below and write:

1. A single-sentence FACT LINE — concrete, factual, and anchored in the strongest reporting
2. A 3-5 sentence analysis: SITUATION (cite facts from records) -> ASSESSMENT (meaning) -> IMPLICATIONS (consequences)
3. A single-sentence WHY IT MATTERS summary
4. A single-sentence UNCERTAINTY line — what is not confirmed yet
5. 2-3 specific, measurable indicators to watch next

PRE-SCORED EVENTS WITH SOURCE RECORDS:
${candidateSummaries}
${developingSection}

ADDITIONAL CONTEXT (reference in assessment section, NEVER use in titles):
${analysisSection || 'No anomaly or escalation data available.'}

OUTPUT FORMAT (respond ONLY with valid JSON, no markdown code fences):
{
  "findings": [
    {
      "fact_line": "Single factual sentence anchored in the source records.",
      "analysis": "SITUATION: [what happened, cite sources]. ASSESSMENT: [what this means]. IMPLICATIONS: [consequences].",
      "why_matters": "Short sentence on why this matters now.",
      "uncertainty": "Short sentence on what remains unconfirmed.",
      "watch_next": ["specific measurable indicator", "concrete trigger to monitor"]
    }
  ]
}

OTHER RULES:
- Output exactly ${promotedCandidates.length} findings, one per event, in the same order.
- Reference specific details from source records — names, numbers, locations, times.
- Telegram-only claims should note "UNVERIFIED" in analysis.
- FACT LINE must be a plain factual sentence, not analysis or speculation.
- UNCERTAINTY must describe what is still unknown, not repeat the confirmed facts.
- watch_next must be specific. BAD: "further developments". GOOD: "IAEA Board emergency session".
- Never use: "situation developing", "remains to be seen", "could potentially escalate", "bears watching".`;

  const messages = [
    { role: 'system', content: `You are Monitor, a senior intelligence analyst writing alerts for a geopolitical dashboard.

Your job: turn raw multi-source intelligence into concise, actionable analysis.

Writing style:
- Lead with specific facts, not vague summaries
- Name specific actors, locations, numbers, dates from the source data
- Structure: WHAT is happening -> WHY it matters -> SO WHAT (implications)
- If sources disagree or only one domain reports, say so explicitly
- Include one line on what remains unknown
- Never use filler: "situation developing", "remains to be seen", "could escalate"

Output ONLY valid JSON. No markdown fences.` },
    { role: 'user', content: analysisPrompt },
  ];

  // Call LLM — provider cascade: Groq 70B (fast, best) → Groq 8B (fastest, good enough) → OpenRouter
  const llmErrors = [];
  const providers = [];
  if (groqKey) {
    providers.push({
      name: 'Groq-70B',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      apiKey: groqKey,
    });
    providers.push({
      name: 'Groq-8B',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      apiKey: groqKey,
    });
  }
  if (openRouterKey) {
    providers.push({
      name: 'Llama-OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'meta-llama/llama-3.3-70b-instruct',
      apiKey: openRouterKey,
    });
  }

  for (const provider of providers) {
    try {
      const fetchStart = Date.now();
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
      console.log(`[monitor-check] ${provider.name} responded in ${Date.now() - fetchStart}ms (status: ${resp.status})`);

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${provider.name} returned ${resp.status}: ${errBody.substring(0, 300)}`);
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`${provider.name} returned no content`);

      const parsed = JSON.parse(content);

      // Merge LLM output back into fusion candidates
      const mergedFindings = promotedCandidates.map((candidate, i) => {
        const llmFinding = parsed.findings?.[i] || {};
        return buildStructuredFinding(candidate, llmFinding, analysisResults);
      });

      // Log first finding so we can verify LLM output quality in Vercel logs
      if (mergedFindings.length > 0) {
        const sample = mergedFindings[0];
        console.log(`[monitor-check] Sample finding: "${sample.title}" | fact: ${(sample.fact_line || '').substring(0, 160)} | uncertainty: ${(sample.uncertainty || '').substring(0, 120)} | watch_next: ${JSON.stringify(sample.watch_next)}`);
      }
      console.log(`[monitor-check] ${provider.name} summarized ${mergedFindings.length} candidates`);
      return { findings: mergedFindings, provider: provider.name };
    } catch (err) {
      const errMsg = `${provider.name}: ${(err.message || String(err)).substring(0, 200)}`;
      console.error(`[monitor-check] ${errMsg}`);
      llmErrors.push(errMsg);
    }
  }

  console.error('[monitor-check] All LLM providers failed for summarization');
  return { findings: null, errors: llmErrors };
}



// ---------------------------------------------------------------------------
// Source health tracking — intelligence gap reporting
// ---------------------------------------------------------------------------

/**
 * Track per-source health across cycles in Redis.
 * Stores a hash map: sourceId -> { status, lastSuccessAt, lastNonEmptyAt, ... }.
 * TTL: 24 hours (for daily digest).
 */
async function updateSourceHealth(redisUrl, redisToken, sourceAssessments) {
  if (!redisUrl || !redisToken) return {};

  try {
    // Load existing health data
    const resp = await fetch(`${redisUrl}/get/monitor:source-health`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    let existing = {};
    if (resp.ok) {
      const data = await resp.json();
      if (data.result) existing = JSON.parse(data.result);
    }

    const merged = mergeSourceHealth(existing, sourceAssessments, Date.now());

    // Store with 24h TTL
    await redisSet(redisUrl, redisToken, 'monitor:source-health', JSON.stringify(merged), 86400);
    return merged;
  } catch {
    // Non-critical — don't block the cycle
    return {};
  }
}

// ---------------------------------------------------------------------------
// Digest cache — bounded daily cache for the daily digest
// ---------------------------------------------------------------------------

/**
 * Save cycle data to a per-day digest cache key for the daily digest to read.
 * Bounded: top 20 alerts, top 50 entities, latest source health.
 * TTL: 48h (timezone edge safety).
 */
async function updateDigestCache(redisUrl, redisToken, promotedCandidates, allCandidates, currentSourceHealth, cycleTs) {
  if (!redisUrl || !redisToken) return;

  try {
    const dateStr = new Date(cycleTs).toISOString().slice(0, 10); // YYYY-MM-DD
    const cacheKey = `monitor:digest-cache:${dateStr}`;
    const DIGEST_CACHE_TTL = 172800; // 48h

    // Load existing cache for today (if any)
    let existing = { topAlerts: [], entityCounts: {}, sourceHealth: null };
    try {
      const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(cacheKey)}`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.result) existing = JSON.parse(data.result);
      }
    } catch {
      // Start fresh if cache is corrupted
    }

    // Append promoted candidates to topAlerts (capped at 20, sorted by confidence)
    const newAlerts = promotedCandidates.map(c => ({
      entities: c.entities.slice(0, 5),
      severity: c.severity,
      confidence: c.confidence,
      sourceCount: new Set(c.records.map(r => r.sourceId)).size,
      sourceTypes: [...new Set(c.records.map(r => r.sourceId.split(':')[0]))],
      ts: cycleTs,
    }));
    const allAlerts = [...(existing.topAlerts || []), ...newAlerts]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 20);

    // Accumulate entity counts (top 50 by frequency)
    const entityCounts = { ...(existing.entityCounts || {}) };
    for (const candidate of allCandidates) {
      for (const entity of candidate.entities) {
        entityCounts[entity] = (entityCounts[entity] || 0) + 1;
      }
    }
    // Keep only top 50 entities
    const sortedEntities = Object.entries(entityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    const trimmedEntityCounts = Object.fromEntries(sortedEntities);

    // Latest source health (overwritten each cycle, not accumulated)
    const cache = {
      topAlerts: allAlerts,
      entityCounts: trimmedEntityCounts,
      sourceHealth: currentSourceHealth,
      lastCycleTs: cycleTs,
    };

    await redisSet(redisUrl, redisToken, cacheKey, JSON.stringify(cache), DIGEST_CACHE_TTL);
  } catch (err) {
    console.error('[monitor-check] Failed to update digest cache:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
