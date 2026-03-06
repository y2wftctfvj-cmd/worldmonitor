/**
 * Alert Dedup — Jaccard similarity and entity overlap deduplication.
 *
 * Prevents sending duplicate alerts about the same story.
 * Uses word-level Jaccard similarity on titles + entity overlap.
 */

import { redisSet } from './redis-helpers.js';

const RECENT_ALERTS_KEY = 'monitor:recent-alerts';
const MAX_RECENT_ALERTS = 100;
const SEVERITY_RANK = { routine: 0, developing: 1, notable: 2, breaking: 3, urgent: 4 };

/**
 * Jaccard word similarity — compares word overlap between two strings.
 * Returns 0.0 (no overlap) to 1.0 (identical words).
 * Filters out short words (<=2 chars) to focus on meaningful content words.
 */
export function jaccardSimilarity(a, b) {
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
 * Check if two entity arrays describe the same story.
 * Two shared entities is a strong match; one shared entity is enough when both
 * alerts are tightly scoped.
 */
export function hasEntityOverlap(entitiesA, entitiesB) {
  if (!Array.isArray(entitiesA) || !Array.isArray(entitiesB) || entitiesA.length === 0 || entitiesB.length === 0) {
    return false;
  }

  const setA = new Set(entitiesA.map((entity) => String(entity).toLowerCase()));
  const overlap = entitiesB.filter((entity) => setA.has(String(entity).toLowerCase())).length;
  return overlap >= 2 || (overlap >= 1 && Math.min(entitiesA.length, entitiesB.length) <= 2);
}

/**
 * Decide whether a new finding should be suppressed as a duplicate.
 * Allows genuine severity escalations through.
 */
export function isDuplicateAlert(finding, recentAlerts) {
  if (!finding || !Array.isArray(recentAlerts) || recentAlerts.length === 0) return false;

  const newTitle = String(finding.title || '');
  const newEntities = Array.isArray(finding._entities) ? finding._entities : [];
  const newRank = SEVERITY_RANK[finding.severity] || 0;

  return recentAlerts.some((recent) => {
    const titleSimilarity = jaccardSimilarity(newTitle, recent.title || '');
    const entityOverlap = hasEntityOverlap(newEntities, recent.entities || []);
    const sameStory = titleSimilarity > 0.33 || (entityOverlap && titleSimilarity > 0.18);
    if (!sameStory) return false;

    const oldRank = recent.severity ? (SEVERITY_RANK[recent.severity] || 0) : newRank;
    return newRank <= oldRank;
  });
}

/**
 * Load recent alerts from Redis.
 * Returns array of { title, entities, severity } objects.
 * Backward-compatible: handles old format (string[]) gracefully.
 */
export async function loadRecentAlerts(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];
  try {
    const resp = await fetch(`${redisUrl}/get/${RECENT_ALERTS_KEY}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.result) return [];
    const parsed = JSON.parse(data.result);
    if (!Array.isArray(parsed)) return [];
    // Handle old format (string[]) — convert to { title, entities }
    return parsed.map(item =>
      typeof item === 'string' ? { title: item, entities: [] } : item
    );
  } catch {
    return [];
  }
}

/**
 * Save a new alert to the recent alerts list with title + entities.
 */
export async function saveRecentAlert(redisUrl, redisToken, title, entities, severity) {
  if (!redisUrl || !redisToken) return;
  try {
    const existing = await loadRecentAlerts(redisUrl, redisToken);
    // 4-hour TTL — long enough to prevent spam (48 cycles), short enough to re-alert on evolving crises
    const ttl = 14400;
    const updated = [...existing, { title, entities: entities || [], severity: severity || 'notable' }].slice(-MAX_RECENT_ALERTS);
    await redisSet(redisUrl, redisToken, RECENT_ALERTS_KEY, JSON.stringify(updated), ttl);
  } catch (err) {
    console.error('[alert-dedup] Failed to save recent alert:', err.message);
  }
}
