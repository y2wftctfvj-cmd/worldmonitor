/**
 * AIS Dark Zone Detection
 *
 * Tracks vessels that stop transmitting AIS signals ("go dark") while inside
 * sensitive maritime zones. A vessel is considered "dark" when it hasn't
 * broadcast a position update within DARK_THRESHOLD_MS (30 minutes).
 *
 * Covers 10 geopolitically sensitive maritime zones — chokepoints, disputed
 * waters, and sanctioned coastlines — where AIS silence can indicate
 * smuggling, sanctions evasion, or military activity.
 */

// ---- Exported Interfaces ----

/** A vessel's most recent known position and identity */
export interface VesselTrack {
  mmsi: string;
  name: string;
  lastLat: number;
  lastLon: number;
  lastSeen: number; // epoch ms when last AIS signal was received
}

/** Alert emitted when a vessel goes dark inside a sensitive zone */
export interface DarkZoneAlert {
  mmsi: string;
  vesselName: string;
  lastLat: number;
  lastLon: number;
  lastSeenAt: number;   // epoch ms
  darkDuration: number;  // ms since last signal
  zone: string;          // human-readable zone name
  severity: 'low' | 'medium' | 'high';
}

// ---- Sensitive Zone Definitions ----

/** A circular geographic zone defined by a center point and radius */
interface SensitiveZone {
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
}

/**
 * 10 geopolitically sensitive maritime zones.
 * Each zone is a circle: if a vessel's last known position falls within
 * radiusKm of the center, it's considered "in the zone."
 */
const SENSITIVE_ZONES: readonly SensitiveZone[] = [
  { name: 'Strait of Hormuz',   lat: 26.5, lon: 56.2,   radiusKm: 150 },
  { name: 'Bab el-Mandeb',      lat: 12.6, lon: 43.3,   radiusKm: 100 },
  { name: 'Strait of Malacca',  lat: 2.5,  lon: 101.5,  radiusKm: 200 },
  { name: 'Taiwan Strait',      lat: 24.0, lon: 119.5,  radiusKm: 150 },
  { name: 'Black Sea',          lat: 43.0, lon: 34.0,   radiusKm: 300 },
  { name: 'South China Sea',    lat: 14.0, lon: 114.0,  radiusKm: 400 },
  { name: 'Baltic Sea',         lat: 58.0, lon: 20.0,   radiusKm: 200 },
  { name: 'North Korean Waters', lat: 39.0, lon: 127.0, radiusKm: 200 },
  { name: 'Venezuelan Coast',   lat: 10.5, lon: -66.0,  radiusKm: 200 },
  { name: 'Iranian Coast',      lat: 27.0, lon: 54.0,   radiusKm: 250 },
] as const;

// ---- Module State ----

/** Registry of all tracked vessels, keyed by MMSI */
const vesselRegistry: Map<string, VesselTrack> = new Map();

/** 30 minutes without an AIS signal = "dark" */
const DARK_THRESHOLD_MS = 30 * 60 * 1000;

/** Vessels not seen in 24 hours are pruned from the registry */
const PRUNE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ---- Severity Thresholds ----

const HIGH_SEVERITY_MS = 6 * 60 * 60 * 1000;   // > 6 hours dark
const MEDIUM_SEVERITY_MS = 2 * 60 * 60 * 1000;  // > 2 hours dark

// ---- Private Helpers ----

/** Earth's mean radius in kilometers (WGS-84 approximation) */
const EARTH_RADIUS_KM = 6371;

/**
 * Calculates the great-circle distance between two lat/lon points
 * using the Haversine formula.
 *
 * Why Haversine? It's the standard approach for short-to-medium distances
 * on a sphere. Good enough for "is this vessel within 400km of a zone center?"
 * without pulling in a full geodesy library.
 *
 * @param lat1 - Latitude of point 1 in degrees
 * @param lon1 - Longitude of point 1 in degrees
 * @param lat2 - Latitude of point 2 in degrees
 * @param lon2 - Longitude of point 2 in degrees
 * @returns Distance in kilometers
 */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  // Convert degrees to radians
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const radLat1 = toRad(lat1);
  const radLat2 = toRad(lat2);

  // Haversine formula: a = sin²(Δlat/2) + cos(lat1) · cos(lat2) · sin²(Δlon/2)
  const halfLatSin = Math.sin(dLat / 2);
  const halfLonSin = Math.sin(dLon / 2);
  const a = halfLatSin * halfLatSin + Math.cos(radLat1) * Math.cos(radLat2) * halfLonSin * halfLonSin;

  // c = 2 · atan2(√a, √(1−a))
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}

/**
 * Determines severity based on how long a vessel has been dark.
 *   - > 6 hours  → high   (likely intentional AIS suppression)
 *   - > 2 hours  → medium (suspicious, warrants monitoring)
 *   - otherwise  → low    (could be transient signal loss)
 */
function classifySeverity(darkDurationMs: number): 'low' | 'medium' | 'high' {
  if (darkDurationMs > HIGH_SEVERITY_MS) return 'high';
  if (darkDurationMs > MEDIUM_SEVERITY_MS) return 'medium';
  return 'low';
}

/**
 * Returns the name of the sensitive zone the vessel is inside, or null
 * if the vessel's position is outside all tracked zones.
 */
function findContainingZone(lat: number, lon: number): string | null {
  for (const zone of SENSITIVE_ZONES) {
    const distanceKm = haversineKm(lat, lon, zone.lat, zone.lon);
    if (distanceKm <= zone.radiusKm) {
      return zone.name;
    }
  }
  return null;
}

// ---- Exported Functions ----

/**
 * Updates the vessel registry with fresh AIS position reports.
 *
 * For each vessel in the input array, we either create a new registry entry
 * or update the existing one with the latest coordinates and timestamp.
 *
 * After updating, we prune any vessels that haven't been seen in 24 hours
 * to keep the registry from growing unbounded.
 *
 * @param vessels - Array of AIS position reports
 */
export function updateVesselPositions(
  vessels: ReadonlyArray<{ mmsi: string; name: string; lat: number; lon: number }>
): void {
  const now = Date.now();

  // Update or insert each vessel's position
  for (const vessel of vessels) {
    const track: VesselTrack = {
      mmsi: vessel.mmsi,
      name: vessel.name,
      lastLat: vessel.lat,
      lastLon: vessel.lon,
      lastSeen: now,
    };
    vesselRegistry.set(vessel.mmsi, track);
  }

  // Prune stale vessels (not seen in 24 hours)
  const pruneThreshold = now - PRUNE_THRESHOLD_MS;
  for (const [mmsi, track] of vesselRegistry) {
    if (track.lastSeen < pruneThreshold) {
      vesselRegistry.delete(mmsi);
    }
  }
}

/**
 * Scans the vessel registry for ships that have gone dark inside
 * sensitive maritime zones.
 *
 * A vessel is "dark" if its last AIS signal is older than DARK_THRESHOLD_MS
 * (30 minutes). We only flag vessels whose last known position falls within
 * one of the 10 sensitive zones.
 *
 * Results are sorted by darkDuration descending — longest silence first,
 * because those are the most likely to be intentional.
 *
 * @returns Array of DarkZoneAlert objects, sorted by duration (longest first)
 */
export function detectDarkZones(): DarkZoneAlert[] {
  const now = Date.now();
  const alerts: DarkZoneAlert[] = [];

  for (const track of vesselRegistry.values()) {
    const darkDuration = now - track.lastSeen;

    // Only flag vessels that have exceeded the dark threshold
    if (darkDuration < DARK_THRESHOLD_MS) {
      continue;
    }

    // Check if the vessel's last known position is inside a sensitive zone
    const zoneName = findContainingZone(track.lastLat, track.lastLon);
    if (zoneName === null) {
      continue;
    }

    // Build the alert with severity classification
    const alert: DarkZoneAlert = {
      mmsi: track.mmsi,
      vesselName: track.name,
      lastLat: track.lastLat,
      lastLon: track.lastLon,
      lastSeenAt: track.lastSeen,
      darkDuration,
      zone: zoneName,
      severity: classifySeverity(darkDuration),
    };

    alerts.push(alert);
  }

  // Sort by darkDuration descending — longest silence = most suspicious
  return alerts.sort((a, b) => b.darkDuration - a.darkDuration);
}

/**
 * Returns a high-level summary of current dark zone activity.
 *
 * Useful for dashboards and aggregate reporting without needing
 * to process individual vessel alerts.
 *
 * @returns totalDark: number of vessels currently dark in sensitive zones,
 *          byZone: breakdown of dark vessel count per zone name
 */
export function getDarkZoneSummary(): {
  totalDark: number;
  byZone: Record<string, number>;
} {
  const alerts = detectDarkZones();

  // Count dark vessels per zone
  const byZone: Record<string, number> = {};
  for (const alert of alerts) {
    byZone[alert.zone] = (byZone[alert.zone] ?? 0) + 1;
  }

  return {
    totalDark: alerts.length,
    byZone,
  };
}
