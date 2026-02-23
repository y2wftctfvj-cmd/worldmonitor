/**
 * Pattern Memory Service
 *
 * Stores daily CII (Country Instability Index) snapshots in IndexedDB
 * and compares current patterns against historical ones to find similar
 * past situations. This helps surface "last time things looked like this,
 * here's what happened next" insights.
 *
 * Uses cosine similarity to compare CII score vectors across countries.
 */

import { initDB } from './storage';

// Keep up to 90 days of snapshots (roughly 3 months of history)
const MAX_SNAPSHOTS = 90;

// ─── Interfaces ──────────────────────────────────────────────────────

/**
 * A daily snapshot capturing the state of all CII scores,
 * convergence zones, signal counts, and top alerts at a point in time.
 */
export interface DailySnapshot {
  /** Unix timestamp (ms) — serves as the IndexedDB key */
  timestamp: number;
  /** Date string in YYYY-MM-DD format for human-readable grouping */
  date: string;
  /** CII scores keyed by country code, e.g. { "UA": 78, "MM": 65 } */
  ciiScores: Record<string, number>;
  /** Geographic convergence zones with their composite scores */
  convergenceZones: {
    region: string;
    score: number;
    signalTypes: string[];
  }[];
  /** Count of signals by type, e.g. { "protest": 12, "conflict": 5 } */
  signalCounts: Record<string, number>;
  /** Top alerts from that day for historical outcome reference */
  topAlerts: {
    severity: string;
    title: string;
  }[];
}

/**
 * A match between the current CII pattern and a historical snapshot.
 * Includes what happened after the historical match for context.
 */
export interface PatternMatch {
  /** Date of the historical match (YYYY-MM-DD) */
  matchDate: string;
  /** Cosine similarity between 0 (no match) and 1 (identical) */
  similarity: number;
  /** Human-readable description of what matched */
  description: string;
  /** Summary of the current pattern being compared */
  currentPattern: string;
  /** What happened after the historical match (e.g., CII spike info) */
  historicalOutcome: string;
}

// ─── IndexedDB Operations ────────────────────────────────────────────

/**
 * Save a daily snapshot into the IndexedDB snapshots store.
 * Uses `put` so it overwrites any existing snapshot with the same timestamp.
 */
export async function saveSnapshot(snapshot: DailySnapshot): Promise<void> {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');

    store.put(snapshot);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Retrieve all snapshots from IndexedDB, sorted by timestamp.
 * Returns an empty array if the store is empty or on error.
 */
export async function getSnapshots(): Promise<DailySnapshot[]> {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction('snapshots', 'readonly');
    const store = transaction.objectStore('snapshots');
    const request = store.getAll();

    request.onsuccess = () => {
      const snapshots = (request.result as DailySnapshot[]) || [];
      // Sort oldest-first by timestamp for consistent ordering
      snapshots.sort((a, b) => a.timestamp - b.timestamp);
      resolve(snapshots);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remove the oldest snapshots if we exceed MAX_SNAPSHOTS.
 * Keeps the store from growing unbounded over months of use.
 */
export async function pruneSnapshots(): Promise<void> {
  const snapshots = await getSnapshots();

  // Nothing to prune if we're under the limit
  if (snapshots.length <= MAX_SNAPSHOTS) {
    return;
  }

  // Figure out how many to delete (the oldest ones)
  const deleteCount = snapshots.length - MAX_SNAPSHOTS;
  const snapshotsToDelete = snapshots.slice(0, deleteCount);

  const database = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');

    // Delete each old snapshot by its timestamp key
    for (const snapshot of snapshotsToDelete) {
      store.delete(snapshot.timestamp);
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ─── Pattern Matching ────────────────────────────────────────────────

/**
 * Compute cosine similarity between two CII score dictionaries.
 *
 * Cosine similarity measures the angle between two vectors:
 *   similarity = (A . B) / (|A| * |B|)
 *
 * We union all country keys so that a country missing from one dict
 * is treated as score 0 in that vector. Returns 0 if either vector
 * has zero magnitude (all zeros).
 */
function ciiSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  // Collect all country codes from both dictionaries
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (const key of allKeys) {
    const valueA = a[key] ?? 0;
    const valueB = b[key] ?? 0;

    dotProduct += valueA * valueB;
    magnitudeA += valueA * valueA;
    magnitudeB += valueB * valueB;
  }

  // Avoid division by zero — if either vector is all zeros, no similarity
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

/**
 * Identify the top N countries by CII score in a score dictionary.
 * Used to build human-readable descriptions of patterns.
 */
function describeTopCountries(
  scores: Record<string, number>,
  count: number,
): string {
  const sorted = Object.entries(scores)
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .slice(0, count);

  if (sorted.length === 0) return 'no data';

  return sorted
    .map(([code, score]) => `${code}:${score}`)
    .join(', ');
}

/**
 * Check whether there was a CII spike (>10 point increase for any country)
 * in the snapshots within 3 days after a given reference snapshot.
 *
 * Returns a description of the spike if found, or a "no spike" message.
 */
function checkForFollowingSpike(
  referenceSnapshot: DailySnapshot,
  allSnapshots: DailySnapshot[],
): string {
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const windowStart = referenceSnapshot.timestamp;
  const windowEnd = referenceSnapshot.timestamp + THREE_DAYS_MS;

  // Find snapshots in the 3-day window after the reference
  const followingSnapshots = allSnapshots.filter(
    (snapshot) => snapshot.timestamp > windowStart && snapshot.timestamp <= windowEnd,
  );

  if (followingSnapshots.length === 0) {
    return 'No follow-up data available for the 3 days after this snapshot';
  }

  // Look for any country with a >10 point CII increase vs. the reference
  const spikes: { country: string; from: number; to: number; date: string }[] = [];

  for (const futureSnapshot of followingSnapshots) {
    for (const [country, futureScore] of Object.entries(futureSnapshot.ciiScores)) {
      const referenceScore = referenceSnapshot.ciiScores[country] ?? 0;
      const increase = futureScore - referenceScore;

      if (increase > 10) {
        spikes.push({
          country,
          from: referenceScore,
          to: futureScore,
          date: futureSnapshot.date,
        });
      }
    }
  }

  if (spikes.length === 0) {
    return 'No significant CII spikes in the following 3 days';
  }

  // Sort by biggest increase and report the top ones
  spikes.sort((a, b) => (b.to - b.from) - (a.to - a.from));
  const topSpikes = spikes.slice(0, 3);

  return topSpikes
    .map((spike) => `${spike.country} jumped from ${spike.from} to ${spike.to} on ${spike.date}`)
    .join('; ');
}

/**
 * Find historical snapshots whose CII patterns are similar to the current one.
 *
 * How it works:
 * 1. Computes cosine similarity between current scores and each historical snapshot
 * 2. Filters to matches above 0.85 similarity threshold
 * 3. For each match, checks if there was a CII spike (>10 pts) in the next 3 days
 * 4. Returns top 3 matches sorted by similarity (highest first)
 *
 * This is the core "pattern recognition" — it answers: "When did the world
 * look like this before, and what happened next?"
 */
export function findPatternMatches(
  currentScores: Record<string, number>,
  snapshots: DailySnapshot[],
): PatternMatch[] {
  const SIMILARITY_THRESHOLD = 0.85;
  const MAX_MATCHES = 3;

  // Build a human-readable summary of the current top countries
  const currentPatternDescription = describeTopCountries(currentScores, 5);

  // Compare current scores against each historical snapshot
  const candidates: PatternMatch[] = [];

  for (const snapshot of snapshots) {
    const similarity = ciiSimilarity(currentScores, snapshot.ciiScores);

    // Only keep matches above our threshold
    if (similarity > SIMILARITY_THRESHOLD) {
      const historicalPatternDescription = describeTopCountries(snapshot.ciiScores, 5);
      const historicalOutcome = checkForFollowingSpike(snapshot, snapshots);

      candidates.push({
        matchDate: snapshot.date,
        similarity: Math.round(similarity * 1000) / 1000, // Round to 3 decimal places
        description: `CII pattern on ${snapshot.date} (top: ${historicalPatternDescription}) is ${Math.round(similarity * 100)}% similar to current`,
        currentPattern: `Current top CII: ${currentPatternDescription}`,
        historicalOutcome,
      });
    }
  }

  // Sort by similarity descending and return top matches
  candidates.sort((a, b) => b.similarity - a.similarity);

  return candidates.slice(0, MAX_MATCHES);
}
