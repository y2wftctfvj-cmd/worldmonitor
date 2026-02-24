declare const process: { env: Record<string, string | undefined> };

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

// Temporal baseline constants
export const BASELINE_TTL = 7776000; // 90 days in seconds
export const MIN_SAMPLES = 10;
export const Z_THRESHOLD_LOW = 1.5;
export const Z_THRESHOLD_MEDIUM = 2.0;
export const Z_THRESHOLD_HIGH = 3.0;

export const VALID_BASELINE_TYPES = [
  'military_flights', 'vessels', 'protests', 'news', 'ais_gaps', 'satellite_fires',
];

// ========================================================================
// Temporal baseline helpers
// ========================================================================

export interface BaselineEntry {
  mean: number;
  m2: number;
  sampleCount: number;
  lastUpdated: string;
}

export function makeBaselineKey(type: string, region: string, weekday: number, month: number): string {
  return `baseline:${type}:${region}:${weekday}:${month}`;
}

export function getBaselineSeverity(zScore: number): string {
  if (zScore >= Z_THRESHOLD_HIGH) return 'critical';
  if (zScore >= Z_THRESHOLD_MEDIUM) return 'high';
  if (zScore >= Z_THRESHOLD_LOW) return 'medium';
  return 'normal';
}
