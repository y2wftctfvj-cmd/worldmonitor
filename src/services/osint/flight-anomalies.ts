/**
 * OSINT Flight Anomaly Detection
 *
 * Analyzes military flight data for unusual patterns:
 * - Circling / loitering behavior (orbit detection)
 * - Emergency squawk codes (hijack, radio failure, general emergency)
 * - Unusual altitude (too low or too high for normal operations)
 * - Dark transponder detection (future: transponder on/off transitions)
 *
 * Position history is maintained per callsign so that circling detection
 * works across successive data snapshots (not just a single fetch).
 */

import type { MilitaryFlight } from '@/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The kinds of anomalies we can detect */
export type FlightAnomalyType =
  | 'circling'
  | 'squawk_emergency'
  | 'unusual_altitude'
  | 'dark_transponder';

/** Severity levels for detected anomalies */
export type FlightAnomalySeverity = 'low' | 'medium' | 'high';

/** A single detected anomaly linked to a flight */
export interface FlightAnomaly {
  callsign: string;
  type: FlightAnomalyType;
  description: string;
  lat: number;
  lon: number;
  detectedAt: number;        // epoch ms
  severity: FlightAnomalySeverity;
}

// ---------------------------------------------------------------------------
// Emergency squawk code lookup
// ---------------------------------------------------------------------------

/** Maps well-known emergency squawk codes to human-readable descriptions */
const EMERGENCY_SQUAWK_CODES: Record<string, { label: string; severity: FlightAnomalySeverity }> = {
  '7500': { label: 'Hijack', severity: 'high' },
  '7600': { label: 'Radio failure', severity: 'medium' },
  '7700': { label: 'General emergency', severity: 'high' },
};

// ---------------------------------------------------------------------------
// Module-level position history
// ---------------------------------------------------------------------------

/** A single recorded position with timestamp */
interface PositionRecord {
  lat: number;
  lon: number;
  ts: number; // epoch ms
}

/**
 * Per-callsign sliding window of recent positions.
 * Used by circling detection to determine if a flight is orbiting.
 *
 * - Max 20 positions per callsign
 * - Positions older than 1 hour are pruned each cycle
 */
const positionHistory = new Map<string, PositionRecord[]>();

/** Maximum positions kept per callsign */
const MAX_HISTORY_LENGTH = 20;

/** Positions older than this are pruned (1 hour in ms) */
const HISTORY_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Circling detection thresholds
// ---------------------------------------------------------------------------

/** Minimum positions required before we evaluate circling */
const CIRCLING_MIN_POSITIONS = 5;

/** All positions must be within this radius of the centroid (km) */
const CIRCLING_MAX_RADIUS_KM = 15;

/** The angular range (in radians) must exceed PI (180 degrees) */
const CIRCLING_MIN_ANGULAR_RANGE = Math.PI;

// ---------------------------------------------------------------------------
// Altitude thresholds
// ---------------------------------------------------------------------------

/** Flights below this altitude (ft) are flagged as unusually low */
const ALTITUDE_LOW_THRESHOLD_FT = 1000;

/** Flights above this altitude (ft) are flagged as unusually high */
const ALTITUDE_HIGH_THRESHOLD_FT = 60000;

// ---------------------------------------------------------------------------
// Haversine helper
// ---------------------------------------------------------------------------

/**
 * Calculates the great-circle distance between two lat/lon points
 * using the standard Haversine formula.
 *
 * @returns distance in kilometres
 */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const EARTH_RADIUS_KM = 6371;

  // Convert degrees to radians
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const radLat1 = (lat1 * Math.PI) / 180;
  const radLat2 = (lat2 * Math.PI) / 180;

  // Haversine formula
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}

// ---------------------------------------------------------------------------
// Circling pattern detection
// ---------------------------------------------------------------------------

/**
 * Determines whether a set of positions indicates a circling / loitering pattern.
 *
 * Algorithm:
 * 1. Compute the centroid (average lat/lon) of all positions.
 * 2. Verify every position is within CIRCLING_MAX_RADIUS_KM of the centroid.
 * 3. Compute the bearing from the centroid to each position and check
 *    that the angular range spans more than 180 degrees (PI radians).
 *    This filters out straight-line approaches that happen to stay close
 *    to a midpoint.
 *
 * @returns true if the positions indicate circling behaviour
 */
function detectCirclingPattern(positions: PositionRecord[]): boolean {
  // Need enough data points to judge
  if (positions.length < CIRCLING_MIN_POSITIONS) {
    return false;
  }

  // --- Step 1: Compute centroid ---
  const centroidLat = positions.reduce((sum, p) => sum + p.lat, 0) / positions.length;
  const centroidLon = positions.reduce((sum, p) => sum + p.lon, 0) / positions.length;

  // --- Step 2: Check all positions are within the radius ---
  const allWithinRadius = positions.every((position) => {
    const distanceKm = haversineKm(centroidLat, centroidLon, position.lat, position.lon);
    return distanceKm <= CIRCLING_MAX_RADIUS_KM;
  });

  if (!allWithinRadius) {
    return false;
  }

  // --- Step 3: Compute angular range ---
  // Calculate bearing from centroid to each position using atan2.
  // atan2 returns values in [-PI, PI].
  const bearings = positions.map((position) => {
    const dLon = ((position.lon - centroidLon) * Math.PI) / 180;
    const centroidLatRad = (centroidLat * Math.PI) / 180;
    const posLatRad = (position.lat * Math.PI) / 180;

    const y = Math.sin(dLon) * Math.cos(posLatRad);
    const x =
      Math.cos(centroidLatRad) * Math.sin(posLatRad) -
      Math.sin(centroidLatRad) * Math.cos(posLatRad) * Math.cos(dLon);

    return Math.atan2(y, x); // radians, [-PI, PI]
  });

  // Sort bearings and find the largest gap between consecutive bearings.
  // The angular range is 2*PI minus that largest gap.
  const sorted = [...bearings].sort((a, b) => a - b);

  let maxGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    if (gap > maxGap) {
      maxGap = gap;
    }
  }

  // Wrap-around gap: from last bearing back to first bearing (full circle)
  const wrapGap = (2 * Math.PI) - ((sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0));
  if (wrapGap > maxGap) {
    maxGap = wrapGap;
  }

  // Angular range = full circle minus the largest gap
  const angularRange = (2 * Math.PI) - maxGap;

  return angularRange > CIRCLING_MIN_ANGULAR_RANGE;
}

// ---------------------------------------------------------------------------
// Position history helpers
// ---------------------------------------------------------------------------

/**
 * Updates the position history for a single callsign.
 * Appends the new position and trims the array to MAX_HISTORY_LENGTH.
 */
function updatePositionHistory(callsign: string, lat: number, lon: number, now: number): void {
  const existing = positionHistory.get(callsign) ?? [];

  // Append the new position
  const updated = [...existing, { lat, lon, ts: now }];

  // Keep only the most recent entries (trim from the front)
  const trimmed = updated.length > MAX_HISTORY_LENGTH
    ? updated.slice(updated.length - MAX_HISTORY_LENGTH)
    : updated;

  positionHistory.set(callsign, trimmed);
}

/**
 * Removes positions older than HISTORY_WINDOW_MS from all callsigns.
 * Also drops callsigns that have no remaining positions.
 */
function pruneOldHistories(now: number): void {
  const cutoff = now - HISTORY_WINDOW_MS;

  for (const [callsign, positions] of positionHistory.entries()) {
    // Keep only positions within the time window
    const fresh = positions.filter((p) => p.ts >= cutoff);

    if (fresh.length === 0) {
      positionHistory.delete(callsign);
    } else {
      positionHistory.set(callsign, fresh);
    }
  }
}

// ---------------------------------------------------------------------------
// Main detection entry point
// ---------------------------------------------------------------------------

/**
 * Scans an array of military flights and returns any detected anomalies.
 *
 * For each flight with valid coordinates:
 * 1. Update the per-callsign position history
 * 2. Check for circling behaviour (needs history from previous calls)
 * 3. Check for emergency squawk codes
 * 4. Check for unusual altitude
 *
 * After processing all flights, old position histories are pruned.
 *
 * @param flights - The current batch of military flight positions
 * @returns Array of detected anomalies (may be empty)
 */
export function detectAnomalies(flights: MilitaryFlight[]): FlightAnomaly[] {
  const anomalies: FlightAnomaly[] = [];
  const now = Date.now();

  for (const flight of flights) {
    // Skip flights without valid coordinates
    if (flight.lat == null || flight.lon == null) {
      continue;
    }

    // Skip flights on the ground — not interesting for airborne anomaly detection
    if (flight.onGround) {
      continue;
    }

    const { callsign, lat, lon } = flight;

    // ---------------------------------------------------------------
    // 1. Update position history
    // ---------------------------------------------------------------
    updatePositionHistory(callsign, lat, lon, now);

    // ---------------------------------------------------------------
    // 2. Check for circling / loitering pattern
    // ---------------------------------------------------------------
    const history = positionHistory.get(callsign) ?? [];
    if (detectCirclingPattern(history)) {
      anomalies.push({
        callsign,
        type: 'circling',
        description:
          `${callsign} appears to be circling/loitering — ` +
          `${history.length} positions within ${CIRCLING_MAX_RADIUS_KM}km ` +
          `with >180° angular spread`,
        lat,
        lon,
        detectedAt: now,
        severity: 'medium',
      });
    }

    // ---------------------------------------------------------------
    // 3. Check squawk codes against emergency map
    // ---------------------------------------------------------------
    const squawkCode = flight.squawk;
    if (squawkCode && EMERGENCY_SQUAWK_CODES[squawkCode]) {
      const { label, severity } = EMERGENCY_SQUAWK_CODES[squawkCode];
      anomalies.push({
        callsign,
        type: 'squawk_emergency',
        description:
          `${callsign} squawking ${squawkCode} (${label})`,
        lat,
        lon,
        detectedAt: now,
        severity,
      });
    }

    // ---------------------------------------------------------------
    // 4. Check for unusual altitude
    // ---------------------------------------------------------------
    const altitudeFt = flight.altitude;
    if (altitudeFt != null) {
      if (altitudeFt < ALTITUDE_LOW_THRESHOLD_FT && altitudeFt > 0) {
        // Very low altitude — could be terrain-following or NOE flight
        anomalies.push({
          callsign,
          type: 'unusual_altitude',
          description:
            `${callsign} at unusually low altitude: ${altitudeFt}ft ` +
            `(threshold: ${ALTITUDE_LOW_THRESHOLD_FT}ft)`,
          lat,
          lon,
          detectedAt: now,
          severity: 'low',
        });
      } else if (altitudeFt > ALTITUDE_HIGH_THRESHOLD_FT) {
        // Extremely high altitude — possibly U-2, RQ-4, or other ISR platform
        anomalies.push({
          callsign,
          type: 'unusual_altitude',
          description:
            `${callsign} at unusually high altitude: ${altitudeFt}ft ` +
            `(threshold: ${ALTITUDE_HIGH_THRESHOLD_FT}ft)`,
          lat,
          lon,
          detectedAt: now,
          severity: 'low',
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // Prune stale position histories so memory doesn't grow unbounded
  // ---------------------------------------------------------------
  pruneOldHistories(now);

  return anomalies;
}
