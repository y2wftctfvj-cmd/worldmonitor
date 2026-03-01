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

  // Twitter/X (array of { account, text })
  if (collectResults.twitter?.status === 'fulfilled' && Array.isArray(collectResults.twitter.value)) {
    for (const tweet of collectResults.twitter.value) {
      if (!tweet.text || tweet.text.length < 10) continue;
      const sourceId = `twitter:${tweet.account}`;
      const { tier } = getReliability('twitter');
      records.push(makeRecord(sourceId, tier, tweet.text, now, { account: tweet.account }));
    }
  }

  // Bluesky (array of { account, text, engagement })
  // Engagement velocity determines reliability tier:
  //   engagement >= 5.0 → osint_verified (viral post, likely breaking news)
  //   engagement >= 1.0 → social_verified (getting traction)
  //   below → social_raw (normal post)
  if (collectResults.bluesky?.status === 'fulfilled' && Array.isArray(collectResults.bluesky.value)) {
    for (const post of collectResults.bluesky.value) {
      if (!post.text || post.text.length < 10) continue;
      const sourceId = `bluesky:${post.account}`;
      const engagement = post.engagement || 0;
      let tier = 'social_raw';
      if (engagement >= 5.0) tier = 'osint_verified';
      else if (engagement >= 1.0) tier = 'social_verified';
      records.push(makeRecord(sourceId, tier, post.text, now, { account: post.account, engagement }));
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

  // CISA cyber alerts (array of { source, title, link, date })
  if (collectResults.cisaAlerts?.status === 'fulfilled' && Array.isArray(collectResults.cisaAlerts.value)) {
    for (const alert of collectResults.cisaAlerts.value) {
      if (!alert.title || alert.title.length < 10) continue;
      const { tier } = getReliability('cisa');
      records.push(makeRecord('cisa', tier, `[CISA] ${alert.title}`, now, { link: alert.link }));
    }
  }

  // Travel advisories (array of { source, title, level })
  if (collectResults.travelAdvisories?.status === 'fulfilled' && Array.isArray(collectResults.travelAdvisories.value)) {
    for (const advisory of collectResults.travelAdvisories.value) {
      if (!advisory.title || advisory.title.length < 10) continue;
      const { tier } = getReliability('travelAdvisory');
      records.push(makeRecord('travelAdvisory', tier, `[${advisory.source}] ${advisory.title}`, now, { level: advisory.level }));
    }
  }

  // GPS jamming (array of { region, pctAffected })
  if (collectResults.gpsJamming?.status === 'fulfilled' && Array.isArray(collectResults.gpsJamming.value)) {
    for (const hotspot of collectResults.gpsJamming.value) {
      if (!hotspot.region) continue;
      const text = `GPS jamming detected: ${hotspot.region} — ${hotspot.pctAffected}% of aircraft affected`;
      const { tier } = getReliability('gpsJamming');
      records.push(makeRecord('gpsJamming', tier, text, now, { pctAffected: hotspot.pctAffected }));
    }
  }

  // OFAC sanctions changes (array of { name, type, program })
  if (collectResults.sanctions?.status === 'fulfilled' && Array.isArray(collectResults.sanctions.value)) {
    for (const entry of collectResults.sanctions.value) {
      if (!entry.name) continue;
      const text = `OFAC sanctions: ${entry.name} (${entry.type}) — ${entry.program}`;
      const { tier } = getReliability('sanctions');
      records.push(makeRecord('sanctions', tier, text, now, { program: entry.program }));
    }
  }

  // Enhanced GDACS alerts (array of { title, alertLevel, eventType, severity, lat, lon })
  if (collectResults.gdacsEnhanced?.status === 'fulfilled' && Array.isArray(collectResults.gdacsEnhanced.value)) {
    for (const alert of collectResults.gdacsEnhanced.value) {
      if (!alert.title || alert.title.length < 10) continue;
      const text = `[GDACS ${alert.alertLevel}] ${alert.title}${alert.severity ? ` (${alert.severity})` : ''}`;
      const { tier } = getReliability('gdacsEnhanced');
      records.push(makeRecord('gdacsEnhanced', tier, text, now, {
        alertLevel: alert.alertLevel,
        eventType: alert.eventType,
        lat: alert.lat,
        lon: alert.lon,
      }));
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

  // Pass 1: merge clusters that share >50% of records
  const recordMerged = mergeOverlappingClusters(clusterMap);

  // Pass 2: merge clusters that share entities (Jaccard >= 0.35)
  // This catches "Iran+Khamenei" + "Iran+Israel" + "Iran+Netanyahu" = one event
  const merged = mergeByEntityOverlap(recordMerged);

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
      surge: 0,
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

    // Surge: bonus when many distinct sources report on the same cluster in one cycle
    const surge = distinctSources >= 4 ? 10 : 0;

    // Contradiction: simple heuristic — if records mention opposing signals
    // (e.g., "ceasefire" + "attack"), apply penalty
    const contradiction = detectContradiction(records);

    // Final confidence: additive, clamped to 0-100
    const confidence = Math.max(0, Math.min(100,
      reliability + corroboration + recency + crossDomain + novelty + surge - contradiction
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
        surge,
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
 * - confidence >= 45 AND (corroboration >= 16 OR reliability >= 32) -> "notable"
 *     Requires 2+ distinct sources, OR a single wire/mainstream source.
 *     Prevents single domain/social records from reaching notable alone.
 * - confidence >= 25 AND watchlistMatch -> "notable" (lower bar for watched topics)
 * - everything else -> "routine"
 *
 * @param {import('./fusion-schemas.js').EventCandidate[]} candidates
 * @returns {import('./fusion-schemas.js').EventCandidate[]}
 */
export function promote(candidates) {
  return candidates.map(candidate => {
    const { confidence, scoreBreakdown, watchlistMatch, entities, clusterId, records } = candidate;

    // Hard gate: minimum 2 distinct sources required for ANY promotion.
    // A single headline from one source is never "notable intelligence."
    const distinctSources = new Set(records.map(r => r.sourceId)).size;
    const hasMultipleSources = distinctSources >= 2;

    // Entity-pair clusters ("Iran+Israel") represent specific events.
    // Single-entity clusters ("Iran", "Trump") are broad topics — cap at notable.
    const isEntityPair = clusterId.includes('+');

    let severity = 'routine';

    if (!hasMultipleSources) {
      // Single source = routine. No exceptions.
      // One headline is never intelligence, even if it matches your watchlist.
      severity = 'routine';
    } else if (!isEntityPair) {
      // Multi-source broad topic — cap at notable (never urgent/breaking)
      // "Iran" trending across 6 sources is notable context, not an alert
      if (confidence >= 50 && watchlistMatch) {
        severity = 'notable';
      }
    } else {
      // Entity-pair clusters with 2+ sources — full promotion rules
      if (confidence >= 65 && (scoreBreakdown.crossDomain >= 10 || scoreBreakdown.corroboration >= 20)) {
        severity = 'urgent';
      } else if (confidence >= 55 && scoreBreakdown.corroboration >= 16 && scoreBreakdown.reliability >= 28) {
        severity = 'breaking';
      } else if (confidence >= 45 && scoreBreakdown.corroboration >= 16) {
        severity = 'notable';
      } else if (confidence >= 45 && watchlistMatch) {
        severity = 'notable';
      }
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
 * Merge clusters whose entity sets overlap significantly (Jaccard >= 0.35).
 *
 * Solves the "same event, different clusters" problem:
 *   Iran+Khamenei, Iran+Israel, Iran+Netanyahu → all about the same crisis.
 *   They share "Iran" — Jaccard("Iran,Khamenei", "Iran,Israel") = 1/3 ≈ 0.33
 *   but with 3+ entity overlap it's clearly the same story.
 *
 * Uses a greedy merge: largest clusters absorb smaller ones first.
 */
function mergeByEntityOverlap(clusters) {
  if (clusters.length <= 1) return clusters;

  // Sort by record count descending — biggest clusters absorb smaller ones
  const sorted = [...clusters].sort((a, b) => b.records.length - a.records.length);
  const merged = [];
  const consumed = new Set();

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(i)) continue;

    let current = sorted[i];
    consumed.add(i);

    for (let j = i + 1; j < sorted.length; j++) {
      if (consumed.has(j)) continue;

      const other = sorted[j];
      const currentSet = new Set(current.entities.map(e => e.toLowerCase()));
      const otherSet = new Set(other.entities.map(e => e.toLowerCase()));

      // Jaccard similarity on entity sets
      const intersection = [...otherSet].filter(e => currentSet.has(e)).length;
      const union = new Set([...currentSet, ...otherSet]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      // Merge if entities overlap enough. Two thresholds:
      //   Standard: Jaccard >= 0.35
      //   Absorption: small cluster shares an entity with a cluster 5x bigger
      const sizeRatio = current.records.length / Math.max(other.records.length, 1);
      const sharesEntity = intersection > 0;
      const shouldMerge = jaccard >= 0.35 || (sharesEntity && sizeRatio >= 5);

      if (shouldMerge) {
        // Merge: combine records (dedup by ID) and entities
        const allRecordIds = new Set();
        const allRecords = [];
        for (const r of [...current.records, ...other.records]) {
          if (!allRecordIds.has(r.id)) {
            allRecordIds.add(r.id);
            allRecords.push(r);
          }
        }
        current = {
          clusterId: current.clusterId, // Keep the bigger cluster's ID
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
