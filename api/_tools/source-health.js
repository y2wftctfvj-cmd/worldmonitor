/**
 * Source health assessment helpers.
 *
 * Distinguishes between:
 *   - ok: fetch succeeded and returned usable/non-empty data
 *   - degraded: fetch succeeded but returned empty/unusable data
 *   - failed: fetch rejected or returned no usable payload at all
 */

/**
 * Classify a Promise.allSettled result for a single source.
 *
 * @param {string} sourceName
 * @param {PromiseSettledResult<any>} result
 * @returns {{ status: 'ok'|'degraded'|'failed', sampleSize: number, reason?: string }}
 */
export function classifySourceResult(sourceName, result) {
  if (!result) {
    return { status: 'failed', sampleSize: 0, reason: 'missing_result' };
  }

  if (result.status === 'rejected') {
    const reason = result.reason instanceof Error
      ? result.reason.message
      : String(result.reason || 'fetch_failed');
    return { status: 'failed', sampleSize: 0, reason: reason.slice(0, 160) };
  }

  const sampleSize = getUsableSampleSize(sourceName, result.value);
  if (sampleSize > 0) {
    return { status: 'ok', sampleSize };
  }

  return {
    status: 'degraded',
    sampleSize: 0,
    reason: getDegradedReason(sourceName, result.value),
  };
}

/**
 * Merge fresh source assessments into the stored source-health map.
 *
 * @param {Record<string, any>} existing
 * @param {Record<string, {status: string, sampleSize: number, reason?: string}>} assessments
 * @param {number} now
 */
export function mergeSourceHealth(existing, assessments, now = Date.now()) {
  const merged = { ...(existing || {}) };

  for (const [name, assessment] of Object.entries(assessments || {})) {
    const prev = merged[name] || {};

    if (assessment.status === 'ok') {
      merged[name] = {
        status: 'ok',
        sampleSize: assessment.sampleSize,
        detail: '',
        lastSuccessAt: now,
        lastNonEmptyAt: now,
        consecutiveDegraded: 0,
        consecutiveFailures: 0,
      };
      continue;
    }

    if (assessment.status === 'degraded') {
      merged[name] = {
        status: 'degraded',
        sampleSize: 0,
        detail: assessment.reason || 'empty_payload',
        lastSuccessAt: now,
        lastNonEmptyAt: prev.lastNonEmptyAt || 0,
        consecutiveDegraded: (prev.consecutiveDegraded || 0) + 1,
        consecutiveFailures: 0,
      };
      continue;
    }

    merged[name] = {
      status: 'failed',
      sampleSize: 0,
      detail: assessment.reason || 'fetch_failed',
      lastSuccessAt: prev.lastSuccessAt || 0,
      lastNonEmptyAt: prev.lastNonEmptyAt || 0,
      consecutiveDegraded: 0,
      consecutiveFailures: (prev.consecutiveFailures || 0) + 1,
    };
  }

  return merged;
}

function getUsableSampleSize(sourceName, value) {
  if (value == null) return 0;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const bulletLines = trimmed.split('\n').filter((line) => line.trim().startsWith('-'));
    return bulletLines.length > 0 ? bulletLines.length : trimmed.length >= 20 ? 1 : 0;
  }

  if (Array.isArray(value)) {
    return value.filter(isUsableArrayItem).length;
  }

  if (typeof value === 'object') {
    if (sourceName === 'military') {
      const count = Number(value.count || 0);
      const articles = Array.isArray(value.articles) ? value.articles.filter(Boolean).length : 0;
      return Math.max(count, articles);
    }

    if ('items' in value && Array.isArray(value.items)) {
      return value.items.filter(isUsableArrayItem).length;
    }

    return Object.keys(value).length > 0 ? 1 : 0;
  }

  return 0;
}

function isUsableArrayItem(item) {
  if (item == null) return false;
  if (typeof item === 'string') return item.trim().length >= 10;
  if (typeof item === 'object') {
    if (typeof item.text === 'string') return item.text.trim().length >= 10;
    if (typeof item.title === 'string') return item.title.trim().length >= 10;
    if (typeof item.country === 'string') return item.country.trim().length >= 2;
    return Object.keys(item).length > 0;
  }
  return true;
}

function getDegradedReason(sourceName, value) {
  if (value == null) return 'empty_payload';
  if (typeof value === 'string') return value.trim() ? `filtered_${sourceName}` : 'empty_string';
  if (Array.isArray(value)) return value.length === 0 ? 'no_items' : `filtered_${sourceName}`;
  if (typeof value === 'object') {
    if (sourceName === 'military') return 'no_recent_activity';
    return Object.keys(value).length === 0 ? 'empty_object' : `filtered_${sourceName}`;
  }
  return 'unusable_payload';
}

/**
 * Track per-source health across cycles in Redis.
 * Stores a hash map: sourceId -> { status, lastSuccessAt, lastNonEmptyAt, ... }.
 * TTL: 24 hours (for daily digest).
 *
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 * @param {Object} sourceAssessments - Fresh assessments from this cycle
 * @returns {Promise<Object>} Merged source health map
 */
export async function updateSourceHealth(redisUrl, redisToken, sourceAssessments) {
  if (!redisUrl || !redisToken) return {};

  // Import redisSet inline to avoid circular dependency
  const { redisSet } = await import('./redis-helpers.js');

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
