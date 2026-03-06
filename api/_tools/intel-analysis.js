/**
 * Intel Analysis Engine — deterministic analysis that separates this from Google Alerts.
 *
 * All analysis is code (no LLM). The LLM only receives the results.
 * This is what makes it an intelligence system instead of a news aggregator.
 *
 * Four analysis functions:
 *   1. detectAnomalies — entities with frequency 3x+ above baseline
 *   2. detectEscalation — entities with rising severity over recent cycles
 *   3. detectConvergence — entities appearing across 3+ intelligence domains
 *   4. generateHistoricalContext — human-readable context strings for LLM prompts
 *
 * Inspired by:
 *   - Seerist: "subtle shifts in sentiment, unusual patterns" detection
 *   - CIA SATs: indicators/signposts of change against baselines
 *   - Palantir: linking entities across domains
 *   - Recorded Future: "invisible links" between documents
 */

import { normalizeEntity } from './event-ledger.js';

// ---------------------------------------------------------------------------
// Intelligence domain mapping — map source types to intel domains
// ---------------------------------------------------------------------------

// Which sources belong to which intelligence domains
const SOURCE_DOMAIN_MAP = {
  // Wire services / government
  'govFeeds': 'DIPLOMATIC',
  'headlines': 'DIPLOMATIC',
  // Military-specific
  'military': 'MILITARY',
  // Financial / economic
  'markets': 'ECONOMIC',
  'predictions': 'ECONOMIC',
  // Cyber / technical
  'cisa': 'CYBER',
  'outages': 'SIGINT',
  'gpsJamming': 'SIGINT',
  // Open source intelligence
  'telegram': 'OSINT',
  'reddit': 'OSINT',
  'twitter': 'OSINT',
  'bluesky': 'OSINT',
  // Security / law enforcement
  'sanctions': 'SECURITY',
  'travelAdvisory': 'SECURITY',
  // Environmental / disaster
  'earthquakes': 'ENVIRONMENTAL',
  'gdacsEnhanced': 'ENVIRONMENTAL',
};

/**
 * Map a source ID to its intelligence domain.
 * e.g., "telegram:intelslava" → "OSINT", "govFeeds" → "DIPLOMATIC"
 */
function getSourceDomain(sourceId) {
  if (!sourceId) return 'OSINT';
  // Check full sourceId first, then prefix before ':'
  if (SOURCE_DOMAIN_MAP[sourceId]) return SOURCE_DOMAIN_MAP[sourceId];
  const prefix = sourceId.split(':')[0];
  return SOURCE_DOMAIN_MAP[prefix] || 'OSINT';
}

// ---------------------------------------------------------------------------
// Severity ranking for escalation detection
// ---------------------------------------------------------------------------

const SEVERITY_RANK = {
  routine: 0,
  developing: 1,
  notable: 2,
  breaking: 3,
  urgent: 4,
};

// ---------------------------------------------------------------------------
// 1. ANOMALY DETECTION
// ---------------------------------------------------------------------------

/**
 * Detect entities with activity significantly above their 7-day baseline.
 *
 * Flags entities where:
 *   - Current cycle frequency is 3x+ above baseline daily average
 *   - AND the entity has 3+ distinct sources (not just one noisy channel)
 *
 * @param {Array} candidates - Promoted EventCandidates from this cycle
 * @param {Map} baselines - normalizedEntity -> baseline object (from computeBaselines)
 * @returns {Array} Anomaly objects sorted by ratio (highest first)
 */
export function detectAnomalies(candidates, baselines) {
  if (!candidates || candidates.length === 0 || !baselines) return [];

  // Count current cycle activity per entity
  const entityActivity = new Map(); // entity -> { sources: Set, mentions: number }

  for (const candidate of candidates) {
    for (const entity of candidate.entities) {
      const normalized = normalizeEntity(entity);
      if (!normalized) continue;

      if (!entityActivity.has(normalized)) {
        entityActivity.set(normalized, { sources: new Set(), mentions: 0, displayName: entity });
      }

      const activity = entityActivity.get(normalized);
      activity.mentions++;
      for (const record of candidate.records) {
        activity.sources.add(record.sourceId);
      }
    }
  }

  const anomalies = [];

  for (const [entity, activity] of entityActivity) {
    const baseline = baselines.get(entity);

    // Skip entities without meaningful baselines
    if (!baseline || baseline.insufficient) continue;

    // Convert daily average to per-cycle average (288 cycles/day)
    const baselinePerCycle = baseline.avgDailyMentions / 288;
    if (baselinePerCycle <= 0) continue;

    // Compute ratio — how many times above normal
    const ratio = activity.mentions / baselinePerCycle;

    // Threshold: 3x above baseline AND 3+ distinct sources
    if (ratio >= 3 && activity.sources.size >= 3) {
      anomalies.push({
        entity,
        displayName: activity.displayName,
        ratio: Math.round(ratio * 10) / 10,
        currentSources: activity.sources.size,
        currentMentions: activity.mentions,
        baselineDaily: baseline.avgDailyMentions,
        severity: ratio >= 10 ? 'critical' : ratio >= 5 ? 'high' : 'elevated',
      });
    }
  }

  // Sort by ratio — most anomalous first
  return anomalies.sort((a, b) => b.ratio - a.ratio);
}

// ---------------------------------------------------------------------------
// 2. ESCALATION DETECTION
// ---------------------------------------------------------------------------

/**
 * Detect entities where severity is trending upward over recent observations.
 *
 * Compares severity in the most recent observations (last hour) to earlier ones.
 * If the average severity rank is rising by 0.5+ ranks, it's escalating.
 *
 * @param {Map} ledgerEntries - normalizedEntity -> ledger entry (from loadLedgerEntries)
 * @returns {Array} Escalation objects for entities with rising severity
 */
export function detectEscalation(ledgerEntries) {
  if (!ledgerEntries || ledgerEntries.size === 0) return [];

  const escalations = [];
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  for (const [entity, ledger] of ledgerEntries) {
    const observations = ledger.observations || [];
    if (observations.length < 4) continue; // Need enough data points to detect trend

    // Split into recent (last hour) and earlier
    const recent = observations.filter(o => o.ts >= oneHourAgo);
    const earlier = observations.filter(o => o.ts < oneHourAgo);

    if (recent.length < 2 || earlier.length < 2) continue;

    // Compute average severity rank for each window
    const recentAvg = recent.reduce((sum, o) => sum + (SEVERITY_RANK[o.severity] || 0), 0) / recent.length;
    const earlierAvg = earlier.reduce((sum, o) => sum + (SEVERITY_RANK[o.severity] || 0), 0) / earlier.length;

    const delta = recentAvg - earlierAvg;

    // Threshold: severity rising by 0.5+ ranks
    if (delta >= 0.5) {
      // Count escalation events this month
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const escalationsThisMonth = observations.filter(o =>
        o.ts >= monthStart.getTime() &&
        (SEVERITY_RANK[o.severity] || 0) >= SEVERITY_RANK.notable
      ).length;

      escalations.push({
        entity,
        displayName: ledger.displayName || entity,
        trend: 'escalating',
        severityDelta: Math.round(delta * 100) / 100,
        recentSeverity: recentAvg,
        earlierSeverity: earlierAvg,
        recentObservations: recent.length,
        escalationsThisMonth,
      });
    }
  }

  return escalations.sort((a, b) => b.severityDelta - a.severityDelta);
}

// ---------------------------------------------------------------------------
// 3. CROSS-DOMAIN CONVERGENCE
// ---------------------------------------------------------------------------

/**
 * Detect entities appearing across 3+ distinct intelligence domains in the same cycle.
 *
 * This is "what Mossad would notice" — individual signals are noise,
 * convergence across domains is signal.
 *
 * Example: Iran appears in DIPLOMATIC (State Dept wire) + MILITARY (GDELT) +
 *          ECONOMIC (market move) + OSINT (Telegram channels) = 4-domain convergence
 *
 * @param {Array} candidates - All EventCandidates from this cycle (including routine)
 * @returns {Array} Convergence objects for entities with multi-domain signals
 */
export function detectConvergence(candidates) {
  if (!candidates || candidates.length === 0) return [];

  // Map entities to the domains they appear in
  const entityDomains = new Map(); // entity -> Set of domains

  for (const candidate of candidates) {
    // Determine which domains this candidate's sources represent
    const domains = new Set();
    for (const record of candidate.records) {
      domains.add(getSourceDomain(record.sourceId));
    }

    // Associate those domains with each entity
    for (const entity of candidate.entities) {
      const normalized = normalizeEntity(entity);
      if (!normalized) continue;

      if (!entityDomains.has(normalized)) {
        entityDomains.set(normalized, { domains: new Set(), displayName: entity });
      }

      const entry = entityDomains.get(normalized);
      for (const domain of domains) {
        entry.domains.add(domain);
      }
    }
  }

  // Filter to entities with 3+ domains
  const convergences = [];

  for (const [entity, data] of entityDomains) {
    if (data.domains.size >= 3) {
      convergences.push({
        entity,
        displayName: data.displayName,
        domains: [...data.domains].sort(),
        domainCount: data.domains.size,
        significance: data.domains.size >= 5 ? 'critical' : data.domains.size >= 4 ? 'high' : 'moderate',
      });
    }
  }

  return convergences.sort((a, b) => b.domainCount - a.domainCount);
}

// ---------------------------------------------------------------------------
// 4. HISTORICAL CONTEXT GENERATION
// ---------------------------------------------------------------------------

/**
 * Generate human-readable historical context strings for LLM prompts.
 *
 * Examples of output:
 *   "Iran: 3rd escalation this month (Feb 3, Feb 14, now)"
 *   "Taiwan: frequency 340% above 7-day baseline"
 *   "Russia+Ukraine: 14 consecutive cycles with notable+ severity"
 *
 * @param {Array} candidates - Promoted candidates from this cycle
 * @param {Map} ledgerEntries - normalizedEntity -> ledger entry
 * @param {Map} baselines - normalizedEntity -> baseline object
 * @returns {string[]} Context lines to inject into LLM prompt
 */
export function generateHistoricalContext(candidates, ledgerEntries, baselines) {
  const contextLines = [];

  if (!candidates || candidates.length === 0) return contextLines;

  for (const candidate of candidates) {
    if (candidate.severity === 'routine') continue;

    for (const entity of candidate.entities) {
      const normalized = normalizeEntity(entity);
      if (!normalized) continue;

      const ledger = ledgerEntries?.get(normalized);
      const baseline = baselines?.get(normalized);

      // Frequency vs baseline
      if (baseline && !baseline.insufficient && baseline.avgDailyMentions > 0) {
        const currentPerCycle = 1; // This entity appeared in this cycle
        const baselinePerCycle = baseline.avgDailyMentions / 288;
        if (baselinePerCycle > 0) {
          const ratio = currentPerCycle / baselinePerCycle;
          if (ratio >= 2) {
            contextLines.push(
              `${entity}: frequency ${Math.round(ratio * 100)}% above 7-day baseline (avg ${baseline.avgDailyMentions}/day)`
            );
          }
        }
      }

      if (!ledger) continue;
      const observations = ledger.observations || [];

      // Count escalations this month
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const notableThisMonth = observations.filter(o =>
        o.ts >= monthStart.getTime() &&
        (SEVERITY_RANK[o.severity] || 0) >= SEVERITY_RANK.notable
      );

      if (notableThisMonth.length >= 2) {
        const dates = notableThisMonth
          .map(o => new Date(o.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
          .slice(-5); // Show last 5 dates
        contextLines.push(
          `${entity}: ${getOrdinal(notableThisMonth.length)} notable+ event this month (${dates.join(', ')})`
        );
      }

      // Consecutive cycles with notable+ severity
      let consecutiveNotable = 0;
      for (let i = observations.length - 1; i >= 0; i--) {
        if ((SEVERITY_RANK[observations[i].severity] || 0) >= SEVERITY_RANK.notable) {
          consecutiveNotable++;
        } else {
          break;
        }
      }
      if (consecutiveNotable >= 3) {
        contextLines.push(
          `${entity}: ${consecutiveNotable} consecutive cycles with notable+ severity`
        );
      }
    }
  }

  // Deduplicate (same entity might appear in multiple candidates)
  return [...new Set(contextLines)];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get ordinal suffix for a number (1st, 2nd, 3rd, etc.)
 */
function getOrdinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const mod100 = n % 100;
  const suffix = suffixes[(mod100 - 20) % 10] || suffixes[mod100] || suffixes[0];
  return `${n}${suffix}`;
}
