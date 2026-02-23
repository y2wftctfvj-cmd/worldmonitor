/**
 * TrendStore — Centralized time-series accumulation service.
 *
 * Stores rolling metric data points keyed by string identifier.
 * Keeps last 7 days in memory, persists to localStorage on a throttle,
 * and auto-downsamples when a metric exceeds 2000 data points.
 *
 * Usage:
 *   trendStore.record('cyber-threats', 42);
 *   const series = trendStore.getSeries('cyber-threats');
 *   const delta  = trendStore.getLatestDelta('cyber-threats', 3600_000);
 */

/** A single time-series data point. */
export interface TrendPoint {
  timestamp: number;
  value: number;
}

/** Result of comparing current vs previous period averages. */
export interface TrendDelta {
  current: number;
  previous: number;
  changePercent: number;
}

/** Shape of the serialized localStorage payload. */
interface SerializedStore {
  version: 1;
  metrics: Record<string, TrendPoint[]>;
}

const STORAGE_KEY = 'worldmonitor-trends';
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_POINTS_PER_METRIC = 2000;
const PERSIST_THROTTLE_MS = 60_000; // flush at most every 60s

/**
 * Downsample the oldest half by averaging consecutive pairs.
 * Keeps the newer half at full resolution so sparklines stay crisp.
 * Example: 2000 pts -> oldest 1000 become 500 averages + newest 1000 = 1500.
 */
function downsample(points: readonly TrendPoint[]): TrendPoint[] {
  const midIndex = Math.floor(points.length / 2);
  const oldHalf = points.slice(0, midIndex);
  const recentHalf = points.slice(midIndex);

  // Average consecutive pairs in the old half
  const compressed: TrendPoint[] = [];
  for (let i = 0; i < oldHalf.length - 1; i += 2) {
    const pointA = oldHalf[i]!;
    const pointB = oldHalf[i + 1]!;
    compressed.push({
      timestamp: Math.round((pointA.timestamp + pointB.timestamp) / 2),
      value: (pointA.value + pointB.value) / 2,
    });
  }
  // Odd count: carry the last unpaired point as-is
  if (oldHalf.length % 2 !== 0) {
    compressed.push(oldHalf[oldHalf.length - 1]!);
  }
  return [...compressed, ...recentHalf];
}

/** Remove data points older than the retention window (immutable). */
function pruneOldPoints(points: readonly TrendPoint[], retentionMs: number): TrendPoint[] {
  const cutoff = Date.now() - retentionMs;
  return points.filter((p) => p.timestamp >= cutoff);
}

/** Average of values in a time window, or null if no points match. */
function averageInWindow(points: readonly TrendPoint[], fromMs: number, toMs: number): number | null {
  const matched = points.filter((p) => p.timestamp >= fromMs && p.timestamp < toMs);
  if (matched.length === 0) return null;
  return matched.reduce((acc, p) => acc + p.value, 0) / matched.length;
}

export class TrendStore {
  private metrics: Map<string, TrendPoint[]>;
  private readonly retentionMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(retentionMs: number = DEFAULT_RETENTION_MS) {
    this.retentionMs = retentionMs;
    this.metrics = new Map();
    this.loadFromStorage();
  }

  /** Add a data point. Timestamp defaults to now. Auto-downsamples past 2000 points. */
  record(key: string, value: number, timestamp?: number): void {
    const point: TrendPoint = { timestamp: timestamp ?? Date.now(), value };

    // Immutable append — no .push() on existing array
    const existing = this.metrics.get(key) ?? [];
    const updated = [...existing, point];

    // Downsample if over the hard cap
    const trimmed = updated.length > MAX_POINTS_PER_METRIC ? downsample(updated) : updated;
    this.metrics.set(key, trimmed);
    this.schedulePersist();
  }

  /** Get the series for a metric, optionally filtered to a time range. */
  getSeries(key: string, fromMs?: number, toMs?: number): TrendPoint[] {
    const points = this.metrics.get(key);
    if (!points) return [];

    // No range: return full copy
    if (fromMs === undefined && toMs === undefined) return [...points];

    const rangeStart = fromMs ?? 0;
    const rangeEnd = toMs ?? Infinity;
    return points.filter((p) => p.timestamp >= rangeStart && p.timestamp <= rangeEnd);
  }

  /**
   * Compare average value in the most recent window vs the preceding window
   * of the same length. Useful for "up 12% vs last hour" badges.
   * Returns null if either window has no data.
   */
  getLatestDelta(key: string, windowMs: number): TrendDelta | null {
    const points = this.metrics.get(key);
    if (!points || points.length === 0) return null;

    const now = Date.now();
    const currentAvg = averageInWindow(points, now - windowMs, now);
    const previousAvg = averageInWindow(points, now - windowMs * 2, now - windowMs);
    if (currentAvg === null || previousAvg === null) return null;

    // Avoid division by zero when previous period averaged exactly 0
    const changePercent = previousAvg !== 0
      ? ((currentAvg - previousAvg) / Math.abs(previousAvg)) * 100
      : 0;

    return {
      current: Math.round(currentAvg * 100) / 100,
      previous: Math.round(previousAvg * 100) / 100,
      changePercent: Math.round(changePercent * 10) / 10,
    };
  }

  /** List all metric keys currently tracked. */
  keys(): string[] {
    return [...this.metrics.keys()];
  }

  /** Remove all data for a single metric. */
  clear(key: string): void {
    this.metrics.delete(key);
    this.schedulePersist();
  }

  /** Load persisted data from localStorage, pruning stale points. */
  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as SerializedStore;
      if (parsed.version !== 1 || !parsed.metrics) return;

      const loaded = new Map<string, TrendPoint[]>();
      for (const [key, points] of Object.entries(parsed.metrics)) {
        const pruned = pruneOldPoints(points, this.retentionMs);
        if (pruned.length > 0) loaded.set(key, pruned);
      }
      this.metrics = loaded;
    } catch (error) {
      console.warn('[TrendStore] Failed to load from localStorage:', error);
      this.metrics = new Map();
    }
  }

  /** Serialize current state to localStorage, pruning stale data first. */
  private persistToStorage(): void {
    try {
      const metricsObj: Record<string, TrendPoint[]> = {};
      for (const [key, points] of this.metrics.entries()) {
        const pruned = pruneOldPoints(points, this.retentionMs);
        if (pruned.length > 0) {
          metricsObj[key] = pruned;
          this.metrics.set(key, pruned); // sync in-memory with pruned copy
        } else {
          this.metrics.delete(key); // entirely stale — drop it
        }
      }
      const payload: SerializedStore = { version: 1, metrics: metricsObj };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn('[TrendStore] Failed to persist to localStorage:', error);
    }
    this.dirty = false;
  }

  /** Throttled write: at most one localStorage flush per PERSIST_THROTTLE_MS. */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer !== null) return; // already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) this.persistToStorage();
    }, PERSIST_THROTTLE_MS);
  }
}

/** Global TrendStore instance — import this in components and services. */
export const trendStore = new TrendStore();
