/**
 * Direct API Enrichment — calls source APIs directly without MCP gateway.
 *
 * When the MCP gateway is not configured (no MCP_GATEWAY_URL), enrichment
 * falls back to these direct HTTP calls. Returns data in the same format
 * as MCP tool results so normalizers work unchanged.
 *
 * All APIs are free, keyless, and publicly accessible.
 */

const FETCH_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// Wrap result in MCP content format so extractPayload() works unchanged
// ---------------------------------------------------------------------------
function wrapResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// ---------------------------------------------------------------------------
// Reddit search — reddit.com/search.json
// ---------------------------------------------------------------------------
async function redditSearch(args) {
  const query = args.query || args.q || '';
  if (!query) return wrapResult({ posts: [] });

  const sort = args.sort || 'relevance';
  const timeFilter = args.time_filter || 'week';
  const limit = Math.min(Number(args.limit) || 5, 10);

  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${timeFilter}&limit=${limit}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'WorldMonitor/1.0 (intelligence aggregator)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return wrapResult({ posts: [] });

  const data = await resp.json();
  const posts = (data?.data?.children || []).map(child => {
    const d = child.data;
    return {
      title: d.title,
      subreddit: d.subreddit,
      score: d.score,
      num_comments: d.num_comments,
      created_utc: d.created_utc,
      url: d.url,
      permalink: `https://reddit.com${d.permalink}`,
      selftext: (d.selftext || '').slice(0, 300),
      author: d.author,
    };
  });
  return wrapResult({ posts });
}

// ---------------------------------------------------------------------------
// GDELT article search — api.gdeltproject.org
// ---------------------------------------------------------------------------
async function gdeltSearch(args) {
  const query = args.query || args.q || '';
  if (!query) return wrapResult({ articles: [] });

  const timespan = args.timespan || '7d';
  const maxRecords = Math.min(Number(args.max_records) || 10, 25);

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=${maxRecords}&timespan=${timespan}&format=json`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return wrapResult({ articles: [] });

  const data = await resp.json();
  const articles = (data?.articles || []).map(a => ({
    title: a.title,
    url: a.url,
    source: a.domain || a.source,
    domain: a.domain,
    seendate: a.seendate,
    language: a.language,
    socialimage: a.socialimage,
  }));
  return wrapResult({ articles });
}

// ---------------------------------------------------------------------------
// GDELT events — api.gdeltproject.org event search
// ---------------------------------------------------------------------------
async function gdeltEvents(args) {
  const query = args.query || args.q || '';
  if (!query) return wrapResult({ events: [] });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=tonechart&timespan=7d&format=json`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return wrapResult({ events: [] });

  const data = await resp.json();
  return wrapResult({ events: data?.timeline || [] });
}

// ---------------------------------------------------------------------------
// USGS earthquake — earthquake.usgs.gov
// ---------------------------------------------------------------------------
async function earthquakeRecent(args) {
  const minmag = args.minmagnitude || '4.5';
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=${minmag}&limit=20&orderby=time`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return wrapResult({ features: [] });

  const data = await resp.json();
  return wrapResult({ features: data?.features || [] });
}

async function earthquakeSearch(args) {
  const params = new URLSearchParams({
    format: 'geojson',
    minmagnitude: args.minmagnitude || '4.5',
    limit: '20',
    orderby: 'time',
  });

  // Region bounding boxes (same as MCP server)
  const regionBoxes = {
    'middle east': { minlat: 12, maxlat: 42, minlon: 25, maxlon: 63 },
    'pacific ring': { minlat: -60, maxlat: 60, minlon: 100, maxlon: -70 },
    'mediterranean': { minlat: 30, maxlat: 46, minlon: -6, maxlon: 37 },
    'south asia': { minlat: 5, maxlat: 40, minlon: 60, maxlon: 100 },
    'east africa': { minlat: -15, maxlat: 15, minlon: 25, maxlon: 55 },
  };

  if (args.region) {
    const box = regionBoxes[args.region.toLowerCase()] || regionBoxes['middle east'];
    Object.entries(box).forEach(([k, v]) => params.set(k, String(v)));
  }

  const daysBack = Number(args.days_back) || 7;
  const start = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  params.set('starttime', start);

  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return wrapResult({ features: [] });

  const data = await resp.json();
  return wrapResult({ features: data?.features || [] });
}

// ---------------------------------------------------------------------------
// OpenSky flights — opensky-network.org
// ---------------------------------------------------------------------------

// Military callsign prefixes (same as MCP server)
const MILITARY_PREFIXES = [
  'RCH', 'EVAC', 'JAKE', 'REACH', 'DOOM', 'TOPCT', 'IRON', 'EPIC',
  'FORTE', 'DUKE', 'RHINO', 'TITAN', 'VIPER', 'HAVOC', 'GHOST',
  'NATO', 'CNV', 'RRR', 'SPAR', 'SAM', 'EXEC', 'ORDER', 'CHAOS',
];

const HOTSPOT_BOXES = {
  'middle east': [12, 25, 42, 63],
  'taiwan strait': [20, 115, 28, 125],
  'baltic': [53, 13, 60, 30],
  'black sea': [40, 27, 47, 42],
  'korean peninsula': [33, 124, 43, 132],
};

async function flightsMilitary(args) {
  const regionKey = (args.region || 'middle east').toLowerCase();
  const box = HOTSPOT_BOXES[regionKey] || HOTSPOT_BOXES['middle east'];

  const url = `https://opensky-network.org/api/states/all?lamin=${box[0]}&lomin=${box[1]}&lamax=${box[2]}&lomax=${box[3]}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return wrapResult({ states: [] });

  const data = await resp.json();
  const allStates = data?.states || [];

  // Filter to military callsigns
  const military = allStates.filter(s => {
    const callsign = (s[1] || '').trim().toUpperCase();
    return MILITARY_PREFIXES.some(prefix => callsign.startsWith(prefix));
  });

  return wrapResult({ states: military });
}

async function flightsRegion(args) {
  const { lamin, lomin, lamax, lomax } = args;
  if (!lamin || !lomin || !lamax || !lomax) return wrapResult({ states: [] });

  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return wrapResult({ states: [] });

  const data = await resp.json();
  return wrapResult({ states: data?.states || [] });
}

// ---------------------------------------------------------------------------
// OFAC sanctions — sanctionslist.ofac.treas.gov
// ---------------------------------------------------------------------------
async function sanctionsSearch(args) {
  const query = args.query || args.name || '';
  if (!query) return wrapResult({ results: [] });

  const url = `https://sanctionslist.ofac.treas.gov/api/search?name=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return wrapResult({ results: [] });

  const data = await resp.json();
  const results = (data?.results || data?.data || []).slice(0, 10).map(entry => ({
    name: entry.name || entry.lastName || '',
    type: entry.type || entry.sdnType || 'Unknown',
    program: Array.isArray(entry.programs) ? entry.programs.join(', ') : (entry.program || ''),
    aliases: entry.aliases || [],
    id: entry.id || entry.uid || '',
  }));
  return wrapResult({ results });
}

// ---------------------------------------------------------------------------
// Polymarket predictions — gamma-api.polymarket.com
// ---------------------------------------------------------------------------
async function predictionsSearch(args) {
  const query = args.query || args.q || '';
  if (!query) return wrapResult({ markets: [] });

  const limit = Math.min(Number(args.limit) || 5, 10);
  const url = `https://gamma-api.polymarket.com/events?limit=${limit}&active=true&closed=false&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return wrapResult({ markets: [] });

  const events = await resp.json();
  const markets = (Array.isArray(events) ? events : []).map(event => {
    const market = event.markets?.[0] || {};
    let probability = null;
    try {
      const prices = JSON.parse(market.outcomePrices || '[]');
      probability = prices[0] ? Math.round(Number(prices[0]) * 100) : null;
    } catch { /* ignore */ }

    return {
      title: event.title || market.question || '',
      probability,
      volume: Number(market.volume || event.volume || 0),
      outcomes: market.outcomes || [],
      end_date: market.endDate || event.endDate || null,
      url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
    };
  });
  return wrapResult({ markets });
}

// ---------------------------------------------------------------------------
// WikiData entity lookup — wikidata.org + wikipedia
// ---------------------------------------------------------------------------
async function entityLookup(args) {
  const query = args.query || '';
  if (!query) return wrapResult({ found: false });

  const lang = args.language || 'en';

  // Step 1: Search Wikidata
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${lang}&format=json&limit=1&origin=*`;
  const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(3000) });
  if (!searchResp.ok) return wrapResult({ found: false });

  const searchData = await searchResp.json();
  const entity = searchData?.search?.[0];
  if (!entity) return wrapResult({ found: false });

  // Step 2: Get Wikipedia summary
  let summary = '';
  try {
    const wikiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(entity.label)}`;
    const wikiResp = await fetch(wikiUrl, { signal: AbortSignal.timeout(3000) });
    if (wikiResp.ok) {
      const wikiData = await wikiResp.json();
      summary = wikiData?.extract || '';
    }
  } catch { /* optional — don't fail on Wikipedia */ }

  return wrapResult({
    found: true,
    wikidata_id: entity.id,
    label: entity.label,
    description: entity.description || '',
    summary: summary.slice(0, 500),
  });
}

// ---------------------------------------------------------------------------
// ACLED conflict events — api.acleddata.com
// ---------------------------------------------------------------------------
async function acledConflictEvents(args) {
  const apiKey = process.env.ACLED_ACCESS_TOKEN;
  if (!apiKey) return wrapResult({ events: [], error: 'ACLED_ACCESS_TOKEN not configured' });

  const daysBack = Number(args.days_back) || 7;
  const startDate = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const limit = Math.min(Number(args.limit) || 50, 100);

  const params = new URLSearchParams({
    key: apiKey,
    event_date: `${startDate}|`,
    event_date_where: '>=',
    limit: String(limit),
  });

  // Filter by region if provided
  if (args.region) {
    params.set('region', args.region);
  }
  // Filter by country if provided
  if (args.country) {
    params.set('country', args.country);
  }

  const url = `https://api.acleddata.com/acled/read?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return wrapResult({ events: [] });

  const data = await resp.json();
  const events = (data?.data || []).map(e => ({
    event_id: e.event_id_cnty,
    event_date: e.event_date,
    event_type: e.event_type,
    sub_event_type: e.sub_event_type,
    actor1: e.actor1,
    actor2: e.actor2,
    country: e.country,
    admin1: e.admin1,
    location: e.location,
    latitude: e.latitude,
    longitude: e.longitude,
    fatalities: Number(e.fatalities) || 0,
    notes: (e.notes || '').slice(0, 300),
    source: e.source,
  }));
  return wrapResult({ events });
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------
const DIRECT_HANDLERS = {
  reddit_search: redditSearch,
  reddit_historical_search: (args) => redditSearch({ ...args, sort: 'new', time_filter: 'month' }),
  news_gdelt_search: gdeltSearch,
  news_gdelt_events: gdeltEvents,
  earthquake_recent: earthquakeRecent,
  earthquake_search: earthquakeSearch,
  flights_region: flightsRegion,
  flights_military: flightsMilitary,
  sanctions_search: sanctionsSearch,
  predictions_search: predictionsSearch,
  entity_lookup: entityLookup,
  acled_events: acledConflictEvents,
};

/**
 * Call a tool's API directly without the MCP gateway.
 * Returns MCP-format result (content array with JSON text) for compatibility.
 *
 * @param {string} toolKey - Tool key from MCP_TOOL_MAP
 * @param {Object} args - Tool arguments
 * @returns {Object|null} MCP-format result or null if no handler exists
 */
export async function directInvoke(toolKey, args = {}) {
  const handler = DIRECT_HANDLERS[toolKey];
  if (!handler) return null;

  try {
    return await handler(args);
  } catch {
    // Direct enrichment is best-effort — don't break the cycle
    return null;
  }
}

/**
 * Check if a tool has a direct handler available.
 */
export function hasDirectHandler(toolKey) {
  return Boolean(DIRECT_HANDLERS[toolKey]);
}
