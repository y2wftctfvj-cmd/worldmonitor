/**
 * Shared Redis helpers — used by both monitor-check.js and telegram-webhook.js.
 *
 * Centralizes watchlist loading so both files stay in sync.
 * All functions are safe to call with null/undefined redisUrl/redisToken
 * (they return empty defaults).
 */

// ---------------------------------------------------------------------------
// Watchlist — shared between monitor-check (bulk scan) and telegram-webhook
// ---------------------------------------------------------------------------

/**
 * Load a single user's watchlist from Redis.
 * Returns array of { term, addedAt } objects.
 */
export async function loadWatchlist(chatId, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];

  try {
    const key = `watchlist:${chatId}`;
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    if (!data.result) return [];

    const watchlist = JSON.parse(data.result);
    return Array.isArray(watchlist) ? watchlist : [];
  } catch {
    return [];
  }
}

/**
 * Save watchlist to Redis (no TTL — persists indefinitely).
 */
export async function saveWatchlist(chatId, watchlist, redisUrl, redisToken) {
  const key = `watchlist:${chatId}`;
  const value = JSON.stringify(watchlist);
  const resp = await fetch(`${redisUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(2000),
  });
  if (!resp.ok) {
    throw new Error(`Redis SET failed: ${resp.status}`);
  }
}

/**
 * Load ALL user watchlists (for the analysis cycle).
 * Scans Redis for watchlist:* keys with full cursor iteration.
 * Returns array of { chatId, terms[] }.
 */
export async function loadAllWatchlists(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];

  try {
    // SCAN can return partial results — loop until cursor returns to "0"
    const keys = [];
    let cursor = '0';
    do {
      const resp = await fetch(`${redisUrl}/scan/${cursor}/match/watchlist:*/count/100`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) break;

      const data = await resp.json();
      cursor = String(data.result?.[0] ?? '0');
      const pageKeys = data.result?.[1] || [];
      keys.push(...pageKeys);
    } while (cursor !== '0');

    if (keys.length === 0) return [];

    // Batch GET all keys in a single pipeline call
    const pipeline = keys.map(key => ['GET', key]);
    const batchResp = await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(3000),
    });
    if (!batchResp.ok) return [];

    const batchData = await batchResp.json();
    const watchlists = [];
    for (let i = 0; i < keys.length; i++) {
      const result = batchData[i]?.result;
      if (!result) continue;
      try {
        const items = JSON.parse(result);
        if (Array.isArray(items) && items.length > 0) {
          const chatIdFromKey = keys[i].replace('watchlist:', '');
          watchlists.push({ chatId: chatIdFromKey, terms: items.map(w => w.term) });
        }
      } catch {
        // Skip malformed watchlist
      }
    }
    return watchlists;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Generic Redis SET via pipeline (safe for large values)
// ---------------------------------------------------------------------------

/**
 * Set a Redis key via pipeline POST body (safe for values >8KB).
 * URL-path encoding breaks for large values, so we use the pipeline endpoint.
 */
export async function redisSet(redisUrl, redisToken, key, value, exSeconds) {
  try {
    const command = exSeconds
      ? ['SET', key, value, 'EX', String(exSeconds)]
      : ['SET', key, value];
    const resp = await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command]),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[redis] SET failed for key ${key}: HTTP ${resp.status} ${body}`);
    }
  } catch (err) {
    console.error(`[redis] SET failed for key ${key}:`, err.message);
  }
}
