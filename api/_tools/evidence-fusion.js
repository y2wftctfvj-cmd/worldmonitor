/**
 * Evidence Fusion Engine — normalize, cluster, score, promote.
 *
 * Inserts a deterministic scoring layer between raw data collection
 * and LLM analysis. The LLM only summarizes pre-scored candidates —
 * it no longer decides what to alert on.
 *
 * Pipeline: COLLECT -> NORMALIZE -> CLUSTER -> SCORE -> PROMOTE -> LLM SUMMARIZE
 */

import { getReliability } from './source-reliability.js';
import { extractEntities } from './entity-dictionary.js';
import { filterValidRecords, validateCandidate } from './schema-validator.js';

// ---------------------------------------------------------------------------
// Step 1: NORMALIZE — convert raw source data into CanonicalRecords
// ---------------------------------------------------------------------------

/**
 * Normalize raw collect results into a flat array of CanonicalRecords.
 *
 * Each source type has its own normalizer that extracts text, assigns
 * a source ID, and runs entity extraction.
 *
 * @param {Object} collectResults - Raw results from Promise.allSettled
 * @returns {import('./fusion-schemas.js').CanonicalRecord[]}
 */
export function normalize(collectResults) {
  const records = [];
  const now = new Date().toISOString();

  // Headlines (string with "- headline" lines)
  if (collectResults.headlines?.status === 'fulfilled' && collectResults.headlines.value) {
    const lines = collectResults.headlines.value.split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const text = line.replace(/^-\s*/, '').trim();
      if (text.length < 10) continue;
      const { tier } = getReliability('headlines');
      records.push(makeRecord('headlines', tier, text, now, {}));
    }
  }

  // Telegram (array of { channel, text })
  if (collectResults.telegram?.status === 'fulfilled' && Array.isArray(collectResults.telegram.value)) {
    for (const post of collectResults.telegram.value) {
      if (!post.text || post.text.length < 10) continue;
      const sourceId = `telegram:${post.channel}`;
      const { tier } = getReliability(sourceId);
      records.push(makeRecord(sourceId, tier, post.text, now, { channel: post.channel }));
    }
  }

  // Reddit (array of { sub, title, score, comments })
  if (collectResults.reddit?.status === 'fulfilled' && Array.isArray(collectResults.reddit.value)) {
    for (const post of collectResults.reddit.value) {
      if (!post.title || post.title.length < 10) continue;
      const sourceId = `reddit:${post.sub}`;
      const { tier } = getReliability(sourceId, { score: post.score });
      records.push(makeRecord(sourceId, tier, post.title, now, { score: post.score, sub: post.sub }));
    }
  }

  // Markets (string with "- Symbol: price (change)" lines)
  if (collectResults.markets?.status === 'fulfilled' && collectResults.markets.value) {
    const lines = collectResults.markets.value.split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const text = line.replace(/^-\s*/, '').trim();
      if (text.length < 5) continue;
      const { tier } = getReliability('markets');
      records.push(makeRecord('markets', tier, text, now, {}));
    }
  }

  // Predictions (array of { title, probability, volume, slug })
  if (collectResults.predictions?.status === 'fulfilled' && Array.isArray(collectResults.predictions.value)) {
    for (const market of collectResults.predictions.value) {
      if (!market.title) continue;
      const text = `${market.title}: ${market.probability ?? 'N/A'}% (vol: $${Math.round(market.volume || 0).toLocaleString('en-US')})`;
      const { tier } = getReliability('predictions');
      records.push(makeRecord('predictions', tier, text, now, { probability: market.probability, volume: market.volume }));
    }
  }

  // Earthquakes (array of { mag, place, time, id })
  if (collectResults.earthquakes?.status === 'fulfilled' && Array.isArray(collectResults.earthquakes.value)) {
    for (const eq of collectResults.earthquakes.value) {
      const text = `M${(eq.mag || 0).toFixed(1)} earthquake — ${eq.place || 'Unknown'}`;
      const { tier } = getReliability('earthquakes');
      records.push(makeRecord('earthquakes', tier, text, eq.time || now, { mag: eq.mag, place: eq.place }));
    }
  }

  // Outages (array of { country, description })
  if (collectResults.outages?.status === 'fulfilled' && Array.isArray(collectResults.outages.value)) {
    for (const outage of collectResults.outages.value) {
      const text = `${outage.country}: ${outage.description}`;
      const { tier } = getReliability('outages');
      records.push(makeRecord('outages', tier, text, now, { country: outage.country }));
    }
  }

  // Military ({ count, articles: string[] })
  if (collectResults.military?.status === 'fulfilled' && collectResults.military.value) {
    const mil = collectResults.military.value;
    if (Array.isArray(mil.articles)) {
      for (const article of mil.articles) {
        if (!article || article.length < 10) continue;
        const { tier } = getReliability('military');
        records.push(makeRecord('military', tier, article, now, { totalCount: mil.count }));
      }
    }
  }

  // Gov/wire feeds (array of { source, title })
  if (collectResults.govFeeds?.status === 'fulfilled' && Array.isArray(collectResults.govFeeds.value)) {
    for (const feed of collectResults.govFeeds.value) {
      if (!feed.title || feed.title.length < 10) continue;
      const { tier } = getReliability('govFeeds');
      records.push(makeRecord('govFeeds', tier, `[${feed.source}] ${feed.title}`, now, { feedSource: feed.source }));
    }
  }

  // Validate records at the boundary where external data enters
  const { valid, dropped } = filterValidRecords(records);
  if (dropped.length > 0) {
    console.warn(`[schema] Dropped ${dropped.length} invalid records:`, dropped.map(d => d.reason));
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Step 2: CLUSTER — group records by shared entities
// ---------------------------------------------------------------------------

/**
 * Group records into EventCandidates by shared entity pairs.
 *
 * Records sharing 1+ entity pair (e.g., "Iran+Nuclear") go into the
 * same cluster. Single-entity records form their own clusters.
 *
 * @param {import('./fusion-schemas.js').CanonicalRecord[]} records
 * @returns {import('./fusion-schemas.js').EventCandidate[]}
 */
export function cluster(records) {
  const clusterMap = new Map(); // clusterId -> { entities, records }

  for (const record of records) {
    if (record.entities.length === 0) continue; // Skip entity-less records

    if (record.entities.length === 1) {
      // Single entity — forms its own cluster
      const key = record.entities[0];
      addToCluster(clusterMap, key, [key], record);
    } else {
      // Generate entity pairs — cap at 5 entities to avoid quadratic explosion
      const sorted = [...record.entities].sort().slice(0, 5);
      const pairs = [];
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          pairs.push(`${sorted[i]}+${sorted[j]}`);
        }
      }

      // Use the first pair as the primary cluster (most specific)
      // but also track all entities
      if (pairs.length > 0) {
        addToCluster(clusterMap, pairs[0], sorted, record);
      }

      // For additional pairs, merge into existing clusters if they exist,
      // otherwise create new ones
      for (let p = 1; p < pairs.length; p++) {
        addToCluster(clusterMap, pairs[p], sorted, record);
      }
    }
  }

  // Deduplicate: merge clusters that share records
  const merged = mergeOverlappingClusters(clusterMap);

  // Convert to EventCandidate shape with empty scores
  return merged.map(({ clusterId, entities, records: clusterRecords }) => ({
    clusterId,
    entities,
    records: clusterRecords,
    confidence: 0,
    scoreBreakdown: {
      reliability: 0,
      corroboration: 0,
      recency: 0,
      crossDomain: 0,
      contradiction: 0,
    },
    severity: 'routine',
    watchlistMatch: null,
  }));
}

// ---------------------------------------------------------------------------
// Step 3: SCORE — apply additive confidence formula
// ---------------------------------------------------------------------------

/**
 * Score each EventCandidate using an additive confidence formula.
 *
 * Components:
 *   reliability  (0-40): max reliability score across all records in cluster
 *   corroboration (0-25): min(distinct_sources * 8, 25)
 *   recency      (0-15): 15 if <30min, 10 if <2h, 5 if <6h, 0 otherwise
 *   crossDomain  (0-15): 5 points per distinct source TYPE
 *   contradiction (-25):  subtract if records have opposing signals
 *
 * @param {import('./fusion-schemas.js').EventCandidate[]} candidates
 * @param {Set<string>} previousRecordIds - Record IDs from last cycle
 * @returns {import('./fusion-schemas.js').EventCandidate[]}
 */
export function score(candidates, previousRecordIds) {
  const now = Date.now();
  const prevIds = previousRecordIds || new Set();

  return candidates.map(candidate => {
    const { records } = candidate;

    // Reliability: best source in the cluster
    const reliability = Math.max(...records.map(r => {
      const rel = getReliability(r.sourceId, r.meta);
      return rel.score;
    }));

    // Corroboration: number of distinct source identifiers
    const distinctSources = new Set(records.map(r => r.sourceId)).size;
    const corroboration = Math.min(distinctSources * 8, 25);

    // Recency: how fresh is the newest record?
    const newestTimestamp = Math.max(...records.map(r => {
      const t = new Date(r.timestamp).getTime();
      return isNaN(t) ? 0 : t;
    }));
    const ageMs = now - newestTimestamp;
    let recency = 0;
    if (ageMs < 30 * 60 * 1000) recency = 15;       // < 30 min
    else if (ageMs < 2 * 60 * 60 * 1000) recency = 10; // < 2 hours
    else if (ageMs < 6 * 60 * 60 * 1000) recency = 5;  // < 6 hours

    // Cross-domain: distinct source types (wire, social, domain, etc.)
    const sourceTypes = new Set(records.map(r => r.sourceType));
    const crossDomain = Math.min(sourceTypes.size * 5, 15);

    // Novelty: bonus for records not seen in the previous cycle
    const newRecordCount = records.filter(r => !prevIds.has(r.id)).length;
    const novelty = newRecordCount > 0 ? Math.min(newRecordCount * 3, 10) : 0;

    // Contradiction: simple heuristic — if records mention opposing signals
    // (e.g., "ceasefire" + "attack"), apply penalty
    const contradiction = detectContradiction(records);

    // Final confidence: additive, clamped to 0-100
    const confidence = Math.max(0, Math.min(100,
      reliability + corroboration + recency + crossDomain + novelty - contradiction
    ));

    return {
      ...candidate,
      confidence,
      scoreBreakdown: {
        reliability,
        corroboration,
        recency,
        crossDomain,
        novelty,
        contradiction,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Step 4: PROMOTE — apply threshold rules to assign severity
// ---------------------------------------------------------------------------

/**
 * Assign severity labels based on confidence thresholds.
 *
 * - confidence >= 65 AND crossDomain >= 10 -> "urgent"
 * - confidence >= 45 -> "notable"
 * - confidence >= 25 AND watchlistMatch -> "notable" (lower bar for watched topics)
 * - everything else -> "routine"
 *
 * @param {import('./fusion-schemas.js').EventCandidate[]} candidates
 * @returns {import('./fusion-schemas.js').EventCandidate[]}
 */
export function promote(candidates) {
  return candidates.map(candidate => {
    const { confidence, scoreBreakdown, watchlistMatch } = candidate;

    let severity = 'routine';

    if (confidence >= 65 && scoreBreakdown.crossDomain >= 10) {
      severity = 'urgent';
    } else if (confidence >= 45) {
      severity = 'notable';
    } else if (confidence >= 25 && watchlistMatch) {
      severity = 'notable';
    }

    return { ...candidate, severity };
  });
}

// ---------------------------------------------------------------------------
// Orchestrator — runs the full fusion pipeline
// ---------------------------------------------------------------------------

/**
 * Run the complete evidence fusion pipeline.
 *
 * @param {Object} collectResults - Raw results from Promise.allSettled
 * @param {Set<string>} previousRecordIds - Record IDs from last cycle (for delta detection)
 * @param {string[]} watchlistTerms - User watchlist terms
 * @returns {{ allCandidates: EventCandidate[], records: CanonicalRecord[] }}
 */
export function runFusion(collectResults, previousRecordIds, watchlistTerms) {
  const records = normalize(collectResults);
  const candidates = cluster(records);
  const scored = score(candidates, previousRecordIds);

  // Tag watchlist matches before promotion
  const tagged = scored.map(candidate => {
    const match = (watchlistTerms || []).find(term =>
      candidate.entities.some(e => e.toLowerCase().includes(term.toLowerCase()))
    );
    return { ...candidate, watchlistMatch: match || null };
  });

  const promoted = promote(tagged);

  // Validate candidates (log-only — invalid means our code has a bug)
  for (const candidate of promoted) {
    const check = validateCandidate(candidate);
    if (!check.valid) {
      console.warn(`[schema] Invalid candidate "${candidate.clusterId}": ${check.reason}`);
    }
  }

  // Sort by confidence descending — most important first
  const sorted = [...promoted].sort((a, b) => b.confidence - a.confidence);

  return { allCandidates: sorted, records };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a CanonicalRecord with a deterministic ID and extracted entities.
 */
function makeRecord(sourceId, sourceType, text, timestamp, meta) {
  const id = `${sourceId}:${simpleHash(text)}`;
  const { all: entities } = extractEntities(text);

  return {
    id,
    sourceId,
    sourceType,
    text,
    entities,
    timestamp,
    meta,
  };
}

/**
 * Simple string hash — deterministic, fast, good enough for dedup IDs.
 * NOT cryptographic. Returns 8-char hex string.
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Add a record to a cluster in the cluster map.
 */
function addToCluster(clusterMap, key, entities, record) {
  if (!clusterMap.has(key)) {
    clusterMap.set(key, { entities: [...new Set(entities)], records: [] });
  }
  const cluster = clusterMap.get(key);
  // Avoid duplicate records in the same cluster
  if (!cluster.records.some(r => r.id === record.id)) {
    cluster.records.push(record);
  }
  // Merge entities
  for (const entity of entities) {
    if (!cluster.entities.includes(entity)) {
      cluster.entities.push(entity);
    }
  }
}

/**
 * Merge clusters that share records (de-overlap).
 * If two clusters share >50% of records, merge them.
 */
function mergeOverlappingClusters(clusterMap) {
  const clusters = [...clusterMap.entries()].map(([key, val]) => ({
    clusterId: key,
    entities: val.entities,
    records: val.records,
  }));

  // Simple greedy merge: iterate and merge overlapping pairs
  const merged = [];
  const consumed = new Set();

  for (let i = 0; i < clusters.length; i++) {
    if (consumed.has(i)) continue;

    let current = clusters[i];
    consumed.add(i);

    for (let j = i + 1; j < clusters.length; j++) {
      if (consumed.has(j)) continue;

      const other = clusters[j];
      const currentIds = new Set(current.records.map(r => r.id));
      const overlap = other.records.filter(r => currentIds.has(r.id)).length;
      const minSize = Math.min(current.records.length, other.records.length);

      if (minSize > 0 && overlap / minSize > 0.5) {
        // Merge: combine records and entities
        const allRecordIds = new Set();
        const allRecords = [];
        for (const r of [...current.records, ...other.records]) {
          if (!allRecordIds.has(r.id)) {
            allRecordIds.add(r.id);
            allRecords.push(r);
          }
        }
        current = {
          clusterId: current.clusterId,
          entities: [...new Set([...current.entities, ...other.entities])],
          records: allRecords,
        };
        consumed.add(j);
      }
    }

    merged.push(current);
  }

  return merged;
}

/**
 * Detect contradictions within a cluster's records.
 *
 * Simple keyword-pair heuristic: if records mention opposing concepts
 * (e.g., "ceasefire" + "strike"), apply a penalty score.
 *
 * @returns {number} Contradiction penalty (0-25)
 */
function detectContradiction(records) {
  const opposingPairs = [
    ['ceasefire', 'attack'],
    ['ceasefire', 'strike'],
    ['peace', 'war'],
    ['withdrawal', 'deployment'],
    ['de-escalation', 'escalation'],
    ['retreat', 'advance'],
    ['calm', 'crisis'],
  ];

  const allText = records.map(r => r.text.toLowerCase()).join(' ');
  let penalty = 0;

  for (const [wordA, wordB] of opposingPairs) {
    if (allText.includes(wordA) && allText.includes(wordB)) {
      penalty += 8; // Each opposing pair adds penalty
    }
  }

  return Math.min(penalty, 25);
}
