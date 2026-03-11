/**
 * Digest Cache — bounded daily cache for the daily digest.
 *
 * Saves cycle data to a per-day Redis key so the daily digest
 * has pre-aggregated data to work with.
 * Bounded: top 20 alerts, top 50 entities, latest source health.
 */

import { redisSet } from './redis-helpers.js';

const DIGEST_CACHE_TTL = 172800; // 48h — timezone edge safety

/**
 * Save cycle data to a per-day digest cache key.
 *
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 * @param {Array} promotedCandidates - Promoted candidates from this cycle
 * @param {Array} allCandidates - All candidates (for entity counting)
 * @param {Object} currentSourceHealth - Latest source health snapshot
 * @param {number} cycleTs - Cycle timestamp (ms)
 * @param {Object} [mcpEnrichment={}] - MCP enrichment data
 */
export async function updateDigestCache(redisUrl, redisToken, promotedCandidates, allCandidates, currentSourceHealth, cycleTs, mcpEnrichment = {}) {
  if (!redisUrl || !redisToken) return;

  try {
    const dateStr = new Date(cycleTs).toISOString().slice(0, 10); // YYYY-MM-DD
    const cacheKey = `monitor:digest-cache:${dateStr}`;

    // Load existing cache for today (if any)
    let existing = { topAlerts: [], entityCounts: {}, sourceHealth: null, mcpSignals: [] };
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
      mcpSignals: Array.isArray(mcpEnrichment?.highlights)
        ? [...new Set([...(existing.mcpSignals || []), ...mcpEnrichment.highlights])].slice(-10)
        : (existing.mcpSignals || []),
      lastCycleTs: cycleTs,
    };

    await redisSet(redisUrl, redisToken, cacheKey, JSON.stringify(cache), DIGEST_CACHE_TTL);
  } catch (err) {
    console.error('[digest-cache] Failed to update digest cache:', err.message);
  }
}
