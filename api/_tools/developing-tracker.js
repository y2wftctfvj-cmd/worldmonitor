/**
 * Developing Items Tracker — tracks events that build over multiple cycles.
 *
 * If an event is classified as "developing" for 3+ consecutive cycles,
 * it gets promoted to a full alert. This catches slow-burn events that
 * don't have enough corroboration in any single cycle.
 */

import { redisSet } from './redis-helpers.js';
import { hasEntityOverlap, isDuplicateAlert, jaccardSimilarity, loadRecentAlerts, saveRecentAlert } from './alert-dedup.js';
import { sendIntelAlert } from './alert-sender.js';

const DEVELOPING_THRESHOLD = 3; // 3 consecutive cycles to trigger alert

/**
 * Load developing items from Redis.
 * Returns array of { topic, count, lastSeen, entities, alerted } objects.
 */
export async function loadDevelopingItems(redisUrl, redisToken) {
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

/**
 * Update developing items list with findings from current cycle.
 * Uses fuzzy matching (Jaccard + entity overlap) to track the same story.
 */
export async function updateDevelopingItems(findings, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;

  const existing = await loadDevelopingItems(redisUrl, redisToken);
  const now = Date.now();

  // Build updated list — use fuzzy matching instead of exact title
  const developingFindings = findings.filter(f => f.severity === 'developing');
  const matchedFindingIndices = new Set();

  let updated = existing.map(d => {
    const dEntities = d.entities || [];
    const matchIdx = developingFindings.findIndex((f, i) => {
      if (matchedFindingIndices.has(i)) return false;
      // Fuzzy title match
      if (jaccardSimilarity(f.title, d.topic) > 0.35) return true;
      // Entity overlap match — same entities = same story
      const fEntities = f._entities || [];
      if (fEntities.length === 0 || dEntities.length === 0) return false;
      return hasEntityOverlap(fEntities, dEntities);
    });

    if (matchIdx >= 0) {
      matchedFindingIndices.add(matchIdx);
      const match = developingFindings[matchIdx];
      const mergedEntities = [...new Set([...dEntities, ...(match._entities || [])])];
      return { ...d, count: d.count + 1, lastSeen: now, entities: mergedEntities };
    }
    return d;
  });

  // Add new developing items not already tracked
  for (let i = 0; i < developingFindings.length; i++) {
    if (matchedFindingIndices.has(i)) continue;
    const finding = developingFindings[i];
    updated = [...updated, {
      topic: finding.title,
      count: 1,
      lastSeen: now,
      entities: finding._entities || [],
      alerted: false,
    }];
  }

  // Remove items not seen in last 30 min (6 cycles)
  const thirtyMinAgo = now - 30 * 60 * 1000;
  const active = updated.filter(d => d.lastSeen > thirtyMinAgo);

  try {
    await redisSet(redisUrl, redisToken, 'monitor:developing', JSON.stringify(active), 3600);
  } catch (err) {
    console.error('[developing-tracker] Failed to save developing items:', err.message);
  }
}

/**
 * Check if any developing items have crossed the threshold and should alert.
 * Items that have been seen for DEVELOPING_THRESHOLD cycles get promoted.
 */
export async function checkDevelopingAlerts(botToken, chatId, redisUrl, redisToken) {
  const developing = await loadDevelopingItems(redisUrl, redisToken);
  const recentAlerts = await loadRecentAlerts(redisUrl, redisToken);
  let anyAlerted = false;

  for (const item of developing) {
    // Skip items already alerted — never re-trigger
    if (item.alerted) continue;
    if (item.count < DEVELOPING_THRESHOLD) continue;

    // Dedup: Jaccard on title OR entity overlap
    const itemEntities = item.entities || [];
    const isDuplicate = isDuplicateAlert({
      severity: 'developing',
      title: item.topic,
      _entities: itemEntities,
    }, recentAlerts);
    if (isDuplicate) {
      item.alerted = true;
      anyAlerted = true;
      continue;
    }

    await sendIntelAlert(botToken, chatId, {
      severity: 'developing',
      title: item.topic,
      analysis: `This has been building for ${item.count * 5} minutes across ${item.count} analysis cycles. No mainstream trigger yet, but the pattern is consistent.`,
      sources: ['multi-cycle analysis'],
      watchlist_match: null,
      watch_next: [
        'Confirmation from wire services or mainstream media',
        `Increase beyond ${item.count} consecutive detection cycles`,
      ],
    });

    await saveRecentAlert(redisUrl, redisToken, item.topic, itemEntities);
    item.alerted = true;
    anyAlerted = true;
  }

  // Persist alerted flags back to Redis
  if (anyAlerted) {
    try {
      await redisSet(redisUrl, redisToken, 'monitor:developing', JSON.stringify(developing), 3600);
    } catch (err) {
      console.error('[developing-tracker] Failed to save developing alerted flags:', err.message);
    }
  }
}
