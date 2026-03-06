/**
 * Cycle Lock — prevents overlapping runs from QStash + Vercel cron.
 *
 * Uses Redis SET NX EX for idempotency. The key is derived from
 * the 5-min boundary timestamp so QStash retries get the same key.
 *
 * Also handles rapid re-check scheduling via QStash for breaking events.
 */

const CYCLE_LOCK_TTL = 300; // 5 min — matches cycle interval
const RECHECK_KEY = 'monitor:recheck-count';
const MAX_RAPID_RECHECKS = 3;
const RECHECK_DELAY_MS = 60000; // 60 seconds between rapid re-checks

/**
 * Try to acquire an exclusive lock via Redis SET NX EX using the cycle's idempotency key.
 * Returns true if lock acquired, false if this cycle already ran.
 */
export async function acquireLock(redisUrl, redisToken, cycleKey) {
  if (!redisUrl || !redisToken) return true; // No Redis = no locking, proceed

  try {
    const resp = await fetch(`${redisUrl}/set/${encodeURIComponent(cycleKey)}/1/EX/${CYCLE_LOCK_TTL}/NX`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return true; // Redis error = don't block, proceed

    const data = await resp.json();
    return data.result === 'OK';
  } catch {
    return true; // Network error = don't block, proceed
  }
}

/**
 * Release the cycle lock. With idempotency keys, the lock auto-expires after 5 min.
 * This is a no-op now — kept for backward compatibility and clean error paths.
 */
export async function releaseLock(_redisUrl, _redisToken) {
  // Idempotency keys expire naturally via TTL — no need to delete.
}

/**
 * Schedule a rapid re-check via QStash if a breaking/urgent alert was sent.
 * Re-runs the same pipeline 60s later to catch follow-up reports and escalation.
 * Max 3 rapid re-checks per event burst, then back to normal 5-min cycle.
 */
export async function scheduleRecheck(redisUrl, redisToken) {
  const qstashToken = process.env.QSTASH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const vercelUrl = process.env.VERCEL_URL;
  if (!qstashToken || !cronSecret || !vercelUrl) return;

  // Check if we've already hit the rapid re-check limit
  const recheckCount = await getRecheckCount(redisUrl, redisToken);
  if (recheckCount >= MAX_RAPID_RECHECKS) {
    console.log(`[cycle-lock] Skipping re-check: already at ${recheckCount}/${MAX_RAPID_RECHECKS} rapid re-checks`);
    return;
  }

  try {
    // Increment re-check counter (auto-expires in 10 min so it resets after the burst)
    await incrementRecheckCount(redisUrl, redisToken);

    // Schedule QStash callback with delay
    const targetUrl = `https://${vercelUrl}/api/monitor-check`;
    const resp = await fetch('https://qstash.upstash.io/v2/publish/' + encodeURIComponent(targetUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        'Content-Type': 'application/json',
        'Upstash-Delay': `${Math.round(RECHECK_DELAY_MS / 1000)}s`,
        'Upstash-Forward-Authorization': `Bearer ${cronSecret}`,
      },
    });

    if (resp.ok) {
      console.log(`[cycle-lock] Scheduled rapid re-check #${recheckCount + 1} in ${RECHECK_DELAY_MS / 1000}s`);
    } else {
      console.error(`[cycle-lock] QStash re-check failed: ${resp.status}`);
    }
  } catch (err) {
    console.error('[cycle-lock] Failed to schedule re-check:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getRecheckCount(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return 0;
  try {
    const resp = await fetch(`${redisUrl}/get/${RECHECK_KEY}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return 0;
    const data = await resp.json();
    return parseInt(data.result, 10) || 0;
  } catch {
    return 0;
  }
}

async function incrementRecheckCount(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;
  try {
    await fetch(`${redisUrl}/incr/${RECHECK_KEY}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    await fetch(`${redisUrl}/expire/${RECHECK_KEY}/600`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Non-critical — if this fails, worst case we do extra re-checks
  }
}
