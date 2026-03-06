/**
 * Signal Fetchers — earthquakes, outages, GPS jamming, travel advisories,
 * OFAC sanctions, NASA FIRMS fire hotspots.
 *
 * These are non-news intelligence signals that provide cross-domain
 * correlation with traditional media sources.
 */

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch significant earthquakes from USGS (last hour).
 */
export async function fetchEarthquakes() {
  try {
    const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson';
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];

    const data = await resp.json();
    return (data?.features || []).map(f => ({
      mag: f.properties?.mag || 0,
      place: f.properties?.place || 'Unknown',
      time: new Date(f.properties?.time || 0).toISOString(),
      id: f.id,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch internet outages from Cloudflare Radar (requires token).
 */
export async function fetchInternetOutages(cloudflareToken) {
  if (!cloudflareToken) return [];

  try {
    const url = 'https://api.cloudflare.com/client/v4/radar/annotations/outages?limit=5&dateRange=1h';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cloudflareToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    return (data?.result?.annotations || [])
      .filter(o => o.scope === 'country')
      .map(o => ({
        country: o.locations || o.asName || 'Unknown',
        description: o.description || `Internet disruption in ${o.locations || 'unknown region'}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Fetch travel advisories from US State Dept (RSS) and UK FCDO (JSON API).
 * Only includes serious advisories: US Level 3-4, UK "advise against travel".
 * Returns array of { source, title, level } objects.
 */
export async function fetchTravelAdvisories() {
  const results = await Promise.allSettled([
    // US State Dept travel advisories via RSS
    (async () => {
      const resp = await fetch(
        'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.rss.xml',
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) return [];

      const xml = await resp.text();
      const items = [];
      const itemPattern = /<item>[\s\S]*?<\/item>/g;
      const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
      let itemMatch;

      while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 10) {
        const titleMatch = itemMatch[0].match(titlePattern);
        const title = titleMatch?.[1] || titleMatch?.[2];
        if (!title) continue;

        // Filter: only Level 3 (Reconsider Travel) and Level 4 (Do Not Travel)
        const levelMatch = title.match(/Level (\d)/i);
        const level = levelMatch ? parseInt(levelMatch[1], 10) : 0;
        if (level >= 3) {
          items.push({ source: 'State Dept Travel', title, level });
        }
      }

      return items;
    })(),

    // UK FCDO travel advice via JSON API
    (async () => {
      const resp = await fetch(
        'https://www.gov.uk/api/content/foreign-travel-advice',
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) return [];

      const data = await resp.json();
      const links = data?.links?.children || [];
      const items = [];

      for (const country of links.slice(0, 50)) {
        const title = country.title || '';
        const description = (country.description || '').toLowerCase();

        // Filter: only "advise against" travel
        if (description.includes('advise against') || description.includes('do not travel')) {
          items.push({
            source: 'UK FCDO',
            title: `${title} — ${country.description || 'Advise against travel'}`,
            level: description.includes('all travel') ? 4 : 3,
          });
        }
      }

      return items.slice(0, 10);
    })(),
  ]);

  // Combine US + UK results
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

/**
 * Fetch NASA FIRMS fire hotspot counts for conflict zones.
 * Uses bounding box API to get fire count — NOT the massive global CSV.
 * Requires NASA_FIRMS_API_KEY env var (free signup).
 * Returns { middleEast: number, ukraine: number } or null if no key.
 *
 * Intended for daily digest only — too heavy for 5-min cycle.
 */
export async function fetchNASAFirms(apiKey) {
  if (!apiKey) return null;

  // Bounding boxes for conflict zones: [west,south,east,north]
  const zones = [
    { name: 'middleEast', bbox: '25,30,55,45' },   // Iraq/Iran/Syria/Yemen
    { name: 'ukraine', bbox: '22,44,40,52' },        // Ukraine/western Russia border
  ];

  const results = await Promise.allSettled(
    zones.map(async (zone) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/VIIRS_SNPP_NRT/${zone.bbox}/1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return { name: zone.name, count: 0 };

      const csv = await resp.text();
      // Each line after the header is a fire detection
      const lineCount = csv.split('\n').filter(l => l.trim().length > 0).length;
      return { name: zone.name, count: Math.max(0, lineCount - 1) }; // Subtract header
    })
  );

  const fireCounts = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      fireCounts[r.value.name] = r.value.count;
    }
  }

  return Object.keys(fireCounts).length > 0 ? fireCounts : null;
}

/**
 * Fetch GPS/GNSS jamming data from gpsjam.org.
 * Returns array of { region, pctAffected } for zones with >10% aircraft affected.
 * Uses yesterday's date (data is daily, not real-time).
 */
export async function fetchGPSJamming() {
  try {
    // Use yesterday's date — gpsjam.org publishes daily
    const yesterday = new Date(Date.now() - 86400000);
    const dateStr = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD

    const url = `https://gpsjam.org/jammer.json?z=3&lat=35&lon=18&date=${dateStr}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'WorldMonitor/3.0' },
    });
    if (!resp.ok) return [];

    const data = await resp.json();

    // data is GeoJSON FeatureCollection or array of hex bins with pct_no_nav
    const features = data?.features || (Array.isArray(data) ? data : []);
    const hotspots = [];

    // Known hotspot regions for labeling (lat/lon ranges)
    const regionLabels = [
      { name: 'Eastern Mediterranean', latMin: 30, latMax: 40, lonMin: 25, lonMax: 38 },
      { name: 'Black Sea', latMin: 40, latMax: 47, lonMin: 28, lonMax: 42 },
      { name: 'Baltic Sea', latMin: 53, latMax: 60, lonMin: 14, lonMax: 30 },
      { name: 'Middle East', latMin: 20, latMax: 35, lonMin: 35, lonMax: 60 },
      { name: 'Red Sea', latMin: 12, latMax: 30, lonMin: 32, lonMax: 45 },
    ];

    for (const feature of features) {
      const pct = feature.properties?.pct_no_nav ?? feature.pct_no_nav ?? 0;
      if (pct <= 10) continue; // Only report significant jamming

      // Try to label the region based on coordinates
      const coords = feature.geometry?.coordinates?.[0]?.[0] || feature.geometry?.coordinates || [];
      const lon = Array.isArray(coords) ? (coords[0] || 0) : 0;
      const lat = Array.isArray(coords) ? (coords[1] || 0) : 0;

      let region = 'Unknown Region';
      for (const r of regionLabels) {
        if (lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax) {
          region = r.name;
          break;
        }
      }

      // Deduplicate by region — keep highest pct
      const existing = hotspots.find(h => h.region === region);
      if (existing) {
        existing.pctAffected = Math.max(existing.pctAffected, Math.round(pct));
      } else {
        hotspots.push({ region, pctAffected: Math.round(pct) });
      }
    }

    return hotspots.sort((a, b) => b.pctAffected - a.pctAffected).slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Fetch OFAC sanctions list changes by comparing hash of SDN CSV.
 * Checks Redis for previous hash — only reports delta (new additions).
 * Rate-limited to once per hour via Redis TTL key.
 *
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 * @returns {Array<{ name: string, type: string, program: string }>}
 */
export async function fetchOFACSanctions(redisUrl, redisToken) {
  // Rate limit: skip if we checked within the last hour
  if (redisUrl && redisToken) {
    try {
      const checkResp = await fetch(`${redisUrl}/get/monitor:sanctions-checked`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(2000),
      });
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        if (checkData.result) return []; // Already checked this hour
      }
    } catch {
      // Continue with check if Redis fails
    }
  }

  try {
    // Fetch the SDN CSV (typically ~2MB)
    const resp = await fetch('https://www.treasury.gov/ofac/downloads/sdn.csv', {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];

    const csv = await resp.text();

    // Compute a simple hash of the file for change detection
    let hash = 0;
    for (let i = 0; i < Math.min(csv.length, 100000); i++) {
      hash = ((hash << 5) - hash) + csv.charCodeAt(i);
      hash = hash & hash;
    }
    const currentHash = Math.abs(hash).toString(16);

    // Compare with stored hash
    let previousHash = null;
    if (redisUrl && redisToken) {
      try {
        const hashResp = await fetch(`${redisUrl}/get/monitor:sanctions-hash`, {
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(2000),
        });
        if (hashResp.ok) {
          const hashData = await hashResp.json();
          previousHash = hashData.result;
        }
      } catch {
        // First run — no previous hash
      }
    }

    // Mark this hour as checked (1h TTL)
    if (redisUrl && redisToken) {
      try {
        await fetch(`${redisUrl}/set/monitor:sanctions-checked/1/EX/3600`, {
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(2000),
        });
        // Store current hash for next comparison
        await fetch(`${redisUrl}/set/monitor:sanctions-hash/${encodeURIComponent(currentHash)}`, {
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // Non-critical
      }
    }

    // If hash matches, no changes
    if (previousHash && previousHash === currentHash) return [];

    // If this is the first run (no previous hash), don't report everything as new
    if (!previousHash) return [];

    // Hash changed — parse for recent entries.
    // SDN CSV format: UID, Name, Type, Program, ...
    // Report first 10 entries from the end (most recently added)
    const lines = csv.split('\n').filter(l => l.trim().length > 0);
    const newEntries = [];

    for (let i = Math.max(1, lines.length - 20); i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (cols.length >= 4 && cols[1]) {
        newEntries.push({
          name: cols[1].substring(0, 100),
          type: cols[2] || 'Unknown',
          program: cols[3] || 'Unknown',
        });
      }
    }

    return newEntries.slice(0, 10);
  } catch {
    return [];
  }
}
