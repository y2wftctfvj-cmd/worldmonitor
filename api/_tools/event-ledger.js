/**
 * Event Ledger — persistent entity observation history with baselines.
 *
 * Gives the system memory. Instead of forgetting everything between cycles
 * (10-min Redis TTL), the ledger stores 7 days of per-entity observations.
 *
 * What it stores for each entity:
 *   - Every promoted event: timestamp, severity, confidence, source count
 *   - Rolling 7-day baseline: average daily mentions, avg confidence
 *   - Display name: most recent human-readable form
 *
 * Redis key: ledger:{normalizedEntity} (e.g., ledger:iran)
 * TTL: 604800s (7 days)
 *
 * Entity normalization:
 *   "Iran", "Islamic Republic of Iran", "Tehran" all resolve to "iran"
 *   This prevents entity fragmentation in the ledger.
 *
 * Budget: 2 Redis pipeline calls per cycle (1 GET + 1 SET) = 576 cmds/day
 */

import { redisSet } from './redis-helpers.js';

// ---------------------------------------------------------------------------
// Entity normalization — resolve variants to canonical names
// ---------------------------------------------------------------------------

// Common aliases — lowercase keys, canonical lowercase values
const ENTITY_ALIASES = {
  'islamic republic of iran': 'iran',
  'tehran': 'iran',
  'persian gulf': 'iran',
  'prc': 'china',
  'peoples republic of china': 'china',
  "people's republic of china": 'china',
  'beijing': 'china',
  'taipei': 'taiwan',
  'republic of china': 'taiwan',
  'kyiv': 'ukraine',
  'kiev': 'ukraine',
  'moscow': 'russia',
  'kremlin': 'russia',
  'russian federation': 'russia',
  'dprk': 'north korea',
  'pyongyang': 'north korea',
  'rok': 'south korea',
  'seoul': 'south korea',
  'gaza strip': 'gaza',
  'palestinian territories': 'palestine',
  'west bank': 'palestine',
  'idf': 'israel',
  'tel aviv': 'israel',
  'hezbollah': 'lebanon',
  'houthi': 'yemen',
  'houthis': 'yemen',
  'ansar allah': 'yemen',
  'eu': 'european union',
  'nato alliance': 'nato',
  'united states': 'us',
  'united states of america': 'us',
  'usa': 'us',
  'washington': 'us',
  'pentagon': 'us',
  'white house': 'us',
  'united kingdom': 'uk',
  'britain': 'uk',
  'great britain': 'uk',
  'london': 'uk',
};

/**
 * Normalize an entity name to its canonical form.
 * Lowercase, trim, resolve aliases.
 */
export function normalizeEntity(name) {
  if (!name || typeof name !== 'string') return '';
  const lower = name.toLowerCase().trim();
  return ENTITY_ALIASES[lower] || lower;
}

// ---------------------------------------------------------------------------
// Ledger constants
// ---------------------------------------------------------------------------

const LEDGER_TTL = 604800; // 7 days
const LEDGER_PREFIX = 'ledger:';
const FREQ_PREFIX = 'freq:daily:';
const MAX_OBSERVATIONS = 2016; // 7 days x 288 cycles/day
const MIN_BASELINE_OBSERVATIONS = 5; // Need 5+ observations for meaningful baselines

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Update the ledger with promoted candidates from this cycle.
 * Uses Redis pipeline for efficiency (1 GET pipeline + 1 SET pipeline).
 *
 * Idempotent: skips if cycleKey matches the last recorded cycle for any entity.
 * Within-cycle dedup: if two observations share a cluster, keep highest confidence.
 */
export async function updateLedger(candidates, cycleKey, cycleTs, redisUrl, redisToken) {
  if (!redisUrl || !redisToken || !candidates || candidates.length === 0) return;

  // Group candidates by normalized entity
  const entityUpdates = new Map(); // normalizedEntity -> { displayName, observations[] }

  for (const candidate of candidates) {
    if (candidate.severity === 'routine') continue; // Only track promoted events

    for (const entity of candidate.entities) {
      const normalized = normalizeEntity(entity);
      if (!normalized) continue;

      if (!entityUpdates.has(normalized)) {
        entityUpdates.set(normalized, { displayName: entity, observations: [] });
      }

      const entry = entityUpdates.get(normalized);
      // Keep the most "proper" display name (longest, likely most specific)
      if (entity.length > entry.displayName.length) {
        entry.displayName = entity;
      }

      entry.observations.push({
        ts: cycleTs,
        severity: candidate.severity,
        confidence: candidate.confidence,
        sourceCount: new Set(candidate.records.map(r => r.sourceId)).size,
        sourceTypes: [...new Set(candidate.records.map(r => r.sourceId.split(':')[0]))],
        clusterId: candidate.clusterId,
        cycleKey,
      });
    }
  }

  if (entityUpdates.size === 0) return;

  // Within-cycle dedup: for each entity, if multiple observations share a cluster,
  // keep only the highest-confidence one
  for (const [, entry] of entityUpdates) {
    const byCluster = new Map();
    for (const obs of entry.observations) {
      const existing = byCluster.get(obs.clusterId);
      if (!existing || obs.confidence > existing.confidence) {
        byCluster.set(obs.clusterId, obs);
      }
    }
    entry.observations = [...byCluster.values()];
  }

  try {
    // Load existing ledger entries via pipeline
    const entities = [...entityUpdates.keys()];
    const getCommands = entities.map(e => ['GET', `${LEDGER_PREFIX}${e}`]);
    const getResp = await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(getCommands),
      signal: AbortSignal.timeout(3000),
    });

    if (!getResp.ok) return;
    const getResults = await getResp.json();

    // Build SET pipeline with updated ledger entries
    const setCommands = [];
    const dateStr = new Date(cycleTs).toISOString().slice(0, 10);
    const freqIncrCommands = [];

    for (let i = 0; i < entities.length; i++) {
      const normalized = entities[i];
      const update = entityUpdates.get(normalized);
      const existing = getResults[i]?.result ? JSON.parse(getResults[i].result) : null;

      // Build updated ledger entry
      const ledgerEntry = existing || {
        entity: normalized,
        displayName: update.displayName,
        observations: [],
        baseline: { avgDailyMentions: 0, avgConfidence: 0, avgSourceCount: 0, observationCount: 0, lastUpdated: 0 },
      };

      // Update display name to the most recent form
      ledgerEntry.displayName = update.displayName;

      // Check idempotency — skip if we already recorded this cycle
      const alreadyRecorded = ledgerEntry.observations.some(o => o.cycleKey === cycleKey);
      if (alreadyRecorded) continue;

      // Append new observations
      ledgerEntry.observations = [...ledgerEntry.observations, ...update.observations];

      // Trim to rolling window (keep newest)
      if (ledgerEntry.observations.length > MAX_OBSERVATIONS) {
        ledgerEntry.observations = ledgerEntry.observations.slice(-MAX_OBSERVATIONS);
      }

      // Recompute baselines from the full observation window
      ledgerEntry.baseline = computeBaselineFromObservations(ledgerEntry.observations);

      // Queue SET command
      setCommands.push(['SET', `${LEDGER_PREFIX}${normalized}`, JSON.stringify(ledgerEntry), 'EX', String(LEDGER_TTL)]);

      // Queue frequency increment for today
      freqIncrCommands.push(['INCRBY', `${FREQ_PREFIX}${dateStr}:${normalized}`, String(update.observations.length)]);
    }

    if (setCommands.length === 0) return;

    // Execute SET pipeline
    const allCommands = [...setCommands, ...freqIncrCommands];
    await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(allCommands),
      signal: AbortSignal.timeout(3000),
    });

    // Set TTL on frequency keys (they don't auto-expire via SET)
    const freqTtlCommands = freqIncrCommands.map(cmd => {
      const key = cmd[1];
      return ['EXPIRE', key, String(LEDGER_TTL)];
    });
    if (freqTtlCommands.length > 0) {
      await fetch(`${redisUrl}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${redisToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(freqTtlCommands),
        signal: AbortSignal.timeout(2000),
      });
    }
  } catch (err) {
    console.error('[event-ledger] Failed to update ledger:', err.message);
  }
}

/**
 * Load ledger entries for multiple entities.
 * Returns a Map of normalizedEntity -> ledgerEntry.
 */
export async function loadLedgerEntries(entities, redisUrl, redisToken) {
  if (!redisUrl || !redisToken || !entities || entities.length === 0) return new Map();

  try {
    const normalized = [...new Set(entities.map(normalizeEntity).filter(Boolean))];
    const getCommands = normalized.map(e => ['GET', `${LEDGER_PREFIX}${e}`]);

    const resp = await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(getCommands),
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) return new Map();
    const results = await resp.json();

    const ledgerMap = new Map();
    for (let i = 0; i < normalized.length; i++) {
      if (results[i]?.result) {
        try {
          ledgerMap.set(normalized[i], JSON.parse(results[i].result));
        } catch {
          // Skip corrupted entries
        }
      }
    }
    return ledgerMap;
  } catch (err) {
    console.error('[event-ledger] Failed to load ledger entries:', err.message);
    return new Map();
  }
}

/**
 * Compute baselines for a set of entities.
 * Returns a Map of normalizedEntity -> baseline object.
 * Entities with fewer than MIN_BASELINE_OBSERVATIONS return { insufficient: true }.
 */
export async function computeBaselines(entities, redisUrl, redisToken) {
  const ledgerMap = await loadLedgerEntries(entities, redisUrl, redisToken);
  const baselines = new Map();

  for (const [entity, ledger] of ledgerMap) {
    if (ledger.baseline && ledger.baseline.observationCount >= MIN_BASELINE_OBSERVATIONS) {
      baselines.set(entity, ledger.baseline);
    } else {
      baselines.set(entity, { insufficient: true, observationCount: ledger.baseline?.observationCount || 0 });
    }
  }

  return baselines;
}

/**
 * Get full entity history for the /history command.
 * Returns the complete ledger entry including all observations.
 */
export async function getEntityHistory(entity, redisUrl, redisToken) {
  if (!redisUrl || !redisToken || !entity) return null;

  const normalized = normalizeEntity(entity);
  if (!normalized) return null;

  try {
    const resp = await fetch(`${redisUrl}/get/${LEDGER_PREFIX}${encodeURIComponent(normalized)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute baseline statistics from an array of observations.
 * Returns average daily mentions, confidence, and source count over the observation window.
 */
function computeBaselineFromObservations(observations) {
  if (!observations || observations.length === 0) {
    return { avgDailyMentions: 0, avgConfidence: 0, avgSourceCount: 0, observationCount: 0, lastUpdated: 0 };
  }

  const now = Date.now();
  const totalObs = observations.length;

  // Calculate the span in days (minimum 1 day to avoid division by zero)
  const oldestTs = Math.min(...observations.map(o => o.ts));
  const spanMs = now - oldestTs;
  const spanDays = Math.max(spanMs / (24 * 60 * 60 * 1000), 1);

  // Average daily mentions
  const avgDailyMentions = totalObs / spanDays;

  // Average confidence across all observations
  const avgConfidence = observations.reduce((sum, o) => sum + (o.confidence || 0), 0) / totalObs;

  // Average source count
  const avgSourceCount = observations.reduce((sum, o) => sum + (o.sourceCount || 1), 0) / totalObs;

  return {
    avgDailyMentions: Math.round(avgDailyMentions * 10) / 10, // 1 decimal
    avgConfidence: Math.round(avgConfidence * 10) / 10,
    avgSourceCount: Math.round(avgSourceCount * 10) / 10,
    observationCount: totalObs,
    lastUpdated: now,
  };
}
