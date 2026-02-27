/**
 * Cycle Telemetry — times each pipeline stage and stores results in Redis.
 *
 * Creates a telemetry tracker that wraps async functions with timing.
 * Stores results to Redis for observability (latest + last 50 history).
 *
 * Usage:
 *   const telem = createCycleTelemetry();
 *   const result = await telem.stage('collect', async () => {
 *     const data = await fetchAll();
 *     return { _meta: { count: data.length }, _value: data };
 *   });
 *   const telemetry = telem.finish();
 *   await storeTelemetry(redisUrl, redisToken, telemetry);
 */

/**
 * Create a telemetry tracker for a single pipeline cycle.
 *
 * Each stage returns { _meta, _value } where:
 *   _meta  → stored in telemetry output (e.g., { recordCount: 87 })
 *   _value → returned to the caller as the stage result
 *
 * If no _value key, the raw return is passed through.
 * If no _meta key, only timing (ms) is recorded.
 *
 * @returns {{ stage: Function, finish: Function }}
 */
export function createCycleTelemetry() {
  const cycleId = new Date().toISOString();
  const stages = {};
  const startTime = Date.now();

  return {
    /**
     * Time an async stage and store its metadata.
     *
     * @param {string} name - Stage name (e.g., 'collect', 'normalize')
     * @param {Function} fn - Async function to execute and time
     * @returns {*} The stage's return value (_value if present, otherwise full return)
     */
    async stage(name, fn) {
      const t0 = Date.now();
      const result = await fn();
      const ms = Date.now() - t0;

      // Extract _meta for telemetry storage
      const meta = result && typeof result === 'object' && result._meta
        ? result._meta
        : undefined;

      // Extract _value for caller, or return raw result
      const value = result && typeof result === 'object' && '_value' in result
        ? result._value
        : result;

      stages[name] = meta ? { ms, meta } : { ms };
      return value;
    },

    /**
     * Finalize telemetry — returns the complete timing object.
     *
     * @returns {{ cycleId: string, stages: Object, totalMs: number }}
     */
    finish() {
      return {
        cycleId,
        stages,
        totalMs: Date.now() - startTime,
      };
    },
  };
}

/**
 * Store telemetry data in Redis.
 *
 * Uses a single pipeline call for efficiency:
 *   - monitor:telemetry:latest — SET with 1h TTL (most recent cycle)
 *   - monitor:telemetry:history — LPUSH + LTRIM to keep last 50, 24h TTL
 *
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 * @param {Object} telemetry - Telemetry object from finish()
 */
export async function storeTelemetry(redisUrl, redisToken, telemetry) {
  if (!redisUrl || !redisToken) return;

  const json = JSON.stringify(telemetry);

  try {
    // Batch all Redis operations in one pipeline call
    const resp = await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['SET', 'monitor:telemetry:latest', json, 'EX', '3600'],
        ['LPUSH', 'monitor:telemetry:history', json],
        ['LTRIM', 'monitor:telemetry:history', '0', '49'],
        ['EXPIRE', 'monitor:telemetry:history', '86400'],
      ]),
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[telemetry] Redis pipeline failed: HTTP ${resp.status} ${body}`);
    }
  } catch (err) {
    console.error('[telemetry] Failed to store:', err.message);
  }
}
