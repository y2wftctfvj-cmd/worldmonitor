import { extractEntities } from './entity-dictionary.js';
import { formatSourceName } from './alert-sender.js';
import { normalizeEntity } from './event-ledger.js';
import { redisSet } from './redis-helpers.js';
import { directInvoke, hasDirectHandler } from './direct-enrichment.js';

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_BREAKER_OPEN_MS = 5 * 60 * 1000;
const BREAKER_FAILURE_THRESHOLD = 3;
const BREAKER_KEY_PREFIX = 'monitor:mcp:circuit:';

const MCP_TOOL_MAP = {
  reddit_search: {
    server: 'reddit',
    tool: 'reddit_search',
    defaultArgs: { response_format: 'json', sort: 'relevance', time_filter: 'week', limit: 5 },
  },
  reddit_historical_search: {
    server: 'reddit',
    tool: 'reddit_historical_search',
    defaultArgs: { response_format: 'json', search_type: 'posts', limit: 5 },
  },
  news_gdelt_search: {
    server: 'news',
    tool: 'news_gdelt_search',
    defaultArgs: { response_format: 'json', timespan: '7d', mode: 'artlist', max_records: 5 },
  },
  news_gdelt_events: {
    server: 'news',
    tool: 'news_gdelt_events',
    defaultArgs: { response_format: 'json', timespan: '7d' },
  },
  earthquake_recent: {
    server: 'usgs',
    tool: 'earthquake_recent',
    defaultArgs: {},
  },
  earthquake_search: {
    server: 'usgs',
    tool: 'earthquake_search',
    defaultArgs: { minmagnitude: '4.5' },
  },
  flights_region: {
    server: 'flights',
    tool: 'flights_region',
    defaultArgs: {},
  },
  flights_military: {
    server: 'flights',
    tool: 'flights_military',
    defaultArgs: {},
  },
  sanctions_search: {
    server: 'sanctions',
    tool: 'sanctions_search',
    defaultArgs: {},
  },
  predictions_search: {
    server: 'polymarket',
    tool: 'predictions_search',
    defaultArgs: { limit: '5' },
  },
  maritime_vessels: {
    server: 'maritime',
    tool: 'maritime_vessels',
    defaultArgs: {},
  },
  maritime_port_activity: {
    server: 'maritime',
    tool: 'maritime_port_activity',
    defaultArgs: {},
  },
  entity_lookup: {
    server: 'wikidata',
    tool: 'entity_lookup',
    defaultArgs: { language: 'en' },
  },
  acled_events: {
    server: 'acled',
    tool: 'acled_events',
    defaultArgs: { days_back: '7', limit: '30' },
  },
};

function getMcpTimeoutMs(override) {
  const raw = override ?? process.env.MCP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(value, 10_000);
}

function parseEnabledTools(raw) {
  const value = String(raw || '').trim();
  if (!value) return new Set(Object.keys(MCP_TOOL_MAP));
  return new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
}

function isToolEnabled(toolKey) {
  const enabled = parseEnabledTools(process.env.MCP_ENABLED_TOOLS);
  if (enabled.has('*')) return true;
  if (enabled.has(toolKey)) return true;
  const definition = MCP_TOOL_MAP[toolKey];
  return Boolean(definition && enabled.has(definition.server));
}

function getGatewayConfig() {
  const url = String(process.env.MCP_GATEWAY_URL || '').trim().replace(/\/$/, '');
  const token = String(process.env.MCP_GATEWAY_TOKEN || '').trim();
  return {
    url,
    token,
    enabled: Boolean(url),
  };
}

function simpleHash(str) {
  let hash = 0;
  const value = String(str || '');
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash &= hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function parseJsonMaybe(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }

  const text = Array.isArray(result?.content)
    ? result.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
    : '';

  return parseJsonMaybe(text) ?? text;
}

function toIsoTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && String(value).trim().length <= 13) {
    return toIsoTimestamp(asNumber);
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();

  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return new Date(Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
    )).toISOString();
  }

  return new Date().toISOString();
}

function buildRecord(sourceId, sourceType, text, timestamp, meta = {}) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 10) return null;
  const { all } = extractEntities(cleaned);
  return {
    id: `${sourceId}:${simpleHash(`${cleaned}:${timestamp}`)}`,
    sourceId,
    sourceType,
    text: cleaned,
    entities: all,
    timestamp,
    meta,
  };
}

function normalizeRedditPosts(items, { historical = false } = {}) {
  if (!Array.isArray(items)) return [];
  const records = [];
  for (const item of items) {
    const subreddit = String(item?.subreddit || item?.sub || 'reddit').replace(/^r\//i, '').trim() || 'reddit';
    const title = String(item?.title || '').trim();
    const body = String(item?.selftext || item?.body || '').replace(/\s+/g, ' ').trim();
    const preview = body ? ` — ${body.slice(0, 180)}${body.length > 180 ? '...' : ''}` : '';
    const text = title ? `${title}${preview}` : body;
    const record = buildRecord(
      `reddit:${subreddit}`,
      item?.score > 100 ? 'social_verified' : 'social_raw',
      text,
      toIsoTimestamp(item?.created_utc),
      {
        score: item?.score || 0,
        sub: subreddit,
        comments: item?.num_comments || 0,
        author: item?.author || '',
        link: item?.url || item?.permalink || null,
        origin: 'mcp',
        mcpTool: historical ? 'reddit_historical_search' : 'reddit_search',
        historical,
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeGdeltArticles(items) {
  if (!Array.isArray(items)) return [];
  const records = [];
  for (const article of items) {
    const domain = String(article?.domain || article?.source || 'GDELT').trim() || 'GDELT';
    const title = String(article?.title || '').trim();
    const description = String(article?.description || '').replace(/\s+/g, ' ').trim();
    const text = description ? `[${domain}] ${title} — ${description.slice(0, 180)}${description.length > 180 ? '...' : ''}` : `[${domain}] ${title}`;
    const record = buildRecord(
      'mcpNews',
      'domain',
      text,
      toIsoTimestamp(article?.seendate || article?.publishedAt),
      {
        feedSource: domain,
        link: article?.url || null,
        tone: article?.tone,
        language: article?.language,
        origin: 'mcp',
        mcpTool: 'news_gdelt_search',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeGdeltEvents(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const records = [];
  for (const feature of features) {
    const props = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const location = coordinates.length >= 2 ? ` (${coordinates[1]}, ${coordinates[0]})` : '';
    const mentions = props?.count ? `${props.count} mentions` : 'event overlap';
    const text = `${props?.name || 'GDELT event'} — ${mentions}${location}`;
    const record = buildRecord(
      'mcpEvents',
      'domain',
      text,
      toIsoTimestamp(props?.date || Date.now()),
      {
        link: props?.url || null,
        eventName: props?.name || '',
        coordinates,
        count: props?.count || 0,
        origin: 'mcp',
        mcpTool: 'news_gdelt_events',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeEarthquakeFeatures(features) {
  if (!Array.isArray(features)) return [];
  const records = [];
  for (const quake of features) {
    const mag = quake?.magnitude ?? quake?.mag;
    const place = quake?.place || 'Unknown location';
    const coords = Array.isArray(quake?.coordinates) ? quake.coordinates : [];
    const depth = quake?.depth != null ? `, ${Math.round(quake.depth)}km deep` : '';
    const text = `M${mag} — ${place}${depth}`;
    const record = buildRecord(
      'usgsQuake',
      'wire',
      text,
      toIsoTimestamp(quake?.time),
      {
        magnitude: mag,
        place,
        depth: quake?.depth,
        coordinates: coords,
        quakeId: quake?.id || '',
        link: quake?.url || null,
        origin: 'mcp',
        mcpTool: 'earthquake_search',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeFlightStates(flights) {
  if (!Array.isArray(flights)) return [];
  const records = [];
  for (const flight of flights) {
    const callsign = (flight?.callsign || '').trim() || flight?.icao24 || 'unknown';
    const country = flight?.origin_country || 'Unknown';
    const alt = flight?.altitude != null ? `, FL${Math.round(flight.altitude / 30.48)}` : '';
    const text = `${callsign} (${country})${alt}`;
    const record = buildRecord(
      'flightTrack',
      'domain',
      text,
      new Date().toISOString(),
      {
        icao24: flight?.icao24 || '',
        callsign,
        origin_country: country,
        latitude: flight?.latitude,
        longitude: flight?.longitude,
        altitude: flight?.altitude,
        velocity: flight?.velocity,
        on_ground: flight?.on_ground || false,
        origin: 'mcp',
        mcpTool: 'flights_military',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeSanctionsResults(items) {
  if (!Array.isArray(items)) return [];
  const records = [];
  for (const item of items) {
    const name = item?.name || 'Unknown entity';
    const type = item?.type || 'Unknown';
    const program = item?.program || '';
    const text = `${name} [${type}] — ${program}`;
    const record = buildRecord(
      'ofacMcp',
      'wire',
      text,
      new Date().toISOString(),
      {
        sanctionedName: name,
        entityType: type,
        program,
        aliases: item?.aliases || [],
        sanctionId: item?.id || '',
        origin: 'mcp',
        mcpTool: 'sanctions_search',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizePolymarketMarkets(markets) {
  if (!Array.isArray(markets)) return [];
  const records = [];
  for (const market of markets) {
    const title = market?.title || 'Unknown market';
    const prob = market?.probability != null ? `${market.probability}%` : 'N/A';
    const text = `${title}: ${prob}`;
    const record = buildRecord(
      'polymarketMcp',
      'domain',
      text,
      new Date().toISOString(),
      {
        marketTitle: title,
        probability: market?.probability,
        volume: market?.volume || 0,
        outcomes: market?.outcomes || [],
        endDate: market?.end_date || null,
        link: market?.url || null,
        origin: 'mcp',
        mcpTool: 'predictions_search',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeMaritimeVessels(vessels) {
  if (!Array.isArray(vessels)) return [];
  const records = [];
  for (const vessel of vessels) {
    const name = vessel?.name || vessel?.mmsi || 'Unknown vessel';
    const type = vessel?.type || 'Unknown type';
    const flag = vessel?.flag || '';
    const dest = vessel?.destination ? ` → ${vessel.destination}` : '';
    const text = `${name} (${flag}) ${type}${dest}`;
    const record = buildRecord(
      'maritime',
      'domain',
      text,
      new Date().toISOString(),
      {
        mmsi: vessel?.mmsi || '',
        vesselName: name,
        vesselType: type,
        flag,
        latitude: vessel?.latitude,
        longitude: vessel?.longitude,
        speed: vessel?.speed,
        heading: vessel?.heading,
        destination: vessel?.destination || '',
        origin: 'mcp',
        mcpTool: 'maritime_vessels',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeAcledEvents(events) {
  if (!Array.isArray(events)) return [];
  const records = [];
  for (const event of events) {
    const type = event?.event_type || 'Unknown';
    const subType = event?.sub_event_type ? ` (${event.sub_event_type})` : '';
    const location = [event?.location, event?.admin1, event?.country].filter(Boolean).join(', ');
    const fatalities = event?.fatalities > 0 ? ` — ${event.fatalities} fatalities` : '';
    const actors = [event?.actor1, event?.actor2].filter(Boolean).join(' vs ');
    const text = `${type}${subType}: ${actors || 'Unknown actors'} in ${location || 'Unknown location'}${fatalities}`;
    const record = buildRecord(
      'acled',
      'domain',
      text,
      event?.event_date ? new Date(event.event_date).toISOString() : new Date().toISOString(),
      {
        eventType: type,
        subEventType: event?.sub_event_type || '',
        actor1: event?.actor1 || '',
        actor2: event?.actor2 || '',
        country: event?.country || '',
        location: location,
        fatalities: event?.fatalities || 0,
        notes: event?.notes || '',
        source: event?.source || '',
        origin: 'direct',
        mcpTool: 'acled_events',
      },
    );
    if (record) records.push(record);
  }
  return records;
}

function normalizeMcpResult(toolKey, result) {
  const payload = extractPayload(result);

  if (toolKey === 'reddit_search') {
    return normalizeRedditPosts(payload?.results || []);
  }
  if (toolKey === 'reddit_historical_search') {
    return normalizeRedditPosts(payload?.data || [], { historical: true });
  }
  if (toolKey === 'news_gdelt_search') {
    return normalizeGdeltArticles(payload?.articles || []);
  }
  if (toolKey === 'news_gdelt_events') {
    return normalizeGdeltEvents(payload);
  }
  if (toolKey === 'earthquake_recent' || toolKey === 'earthquake_search') {
    return normalizeEarthquakeFeatures(payload?.features || []);
  }
  if (toolKey === 'flights_region' || toolKey === 'flights_military') {
    return normalizeFlightStates(payload?.flights || []);
  }
  if (toolKey === 'sanctions_search') {
    return normalizeSanctionsResults(payload?.results || []);
  }
  if (toolKey === 'predictions_search') {
    return normalizePolymarketMarkets(payload?.markets || []);
  }
  if (toolKey === 'maritime_vessels' || toolKey === 'maritime_port_activity') {
    return normalizeMaritimeVessels(payload?.vessels || []);
  }
  if (toolKey === 'entity_lookup') {
    // WikiData returns enrichment context, not signal records — pass through raw
    return [];
  }
  if (toolKey === 'acled_events') {
    return normalizeAcledEvents(payload?.events || []);
  }
  return [];
}

async function getBreakerState(toolKey, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return null;
  try {
    const key = `${BREAKER_KEY_PREFIX}${toolKey}`;
    const response = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

async function setBreakerState(toolKey, state, redisUrl, redisToken, ttlSeconds = Math.ceil(DEFAULT_BREAKER_OPEN_MS / 1000)) {
  if (!redisUrl || !redisToken) return;
  try {
    await redisSet(redisUrl, redisToken, `${BREAKER_KEY_PREFIX}${toolKey}`, JSON.stringify(state), ttlSeconds);
  } catch {
    // ignore Redis breaker failures
  }
}

async function recordBreakerSuccess(toolKey, redisUrl, redisToken) {
  await setBreakerState(toolKey, {
    failures: 0,
    openedUntil: 0,
    lastError: '',
    updatedAt: Date.now(),
  }, redisUrl, redisToken, 3600);
}

async function recordBreakerFailure(toolKey, error, redisUrl, redisToken) {
  const previous = await getBreakerState(toolKey, redisUrl, redisToken);
  const failures = (previous?.failures || 0) + 1;
  const openedUntil = failures >= BREAKER_FAILURE_THRESHOLD
    ? Date.now() + DEFAULT_BREAKER_OPEN_MS
    : 0;
  await setBreakerState(toolKey, {
    failures,
    openedUntil,
    lastError: String(error || 'failed').slice(0, 120),
    updatedAt: Date.now(),
  }, redisUrl, redisToken, openedUntil > 0 ? Math.ceil(DEFAULT_BREAKER_OPEN_MS / 1000) : 3600);
}

function buildAssessment(status, sampleSize, reason = '') {
  if (status === 'ok') return { status: 'ok', sampleSize };
  if (status === 'degraded') return { status: 'degraded', sampleSize: 0, reason: reason || 'no_items' };
  return { status: 'failed', sampleSize: 0, reason: reason || 'request_failed' };
}

/**
 * Direct API fallback — calls source APIs directly when MCP gateway is unavailable.
 * Returns the same shape as a successful gateway call so callers don't need to change.
 */
async function directFallback(toolKey, mergedArgs) {
  try {
    const raw = await directInvoke(toolKey, mergedArgs);
    if (!raw) {
      return {
        ok: false,
        status: 'degraded',
        reason: 'direct_no_result',
        assessment: buildAssessment('degraded', 0, 'direct_no_result'),
        observations: [],
      };
    }
    const observations = normalizeMcpResult(toolKey, raw);
    return {
      ok: true,
      status: observations.length > 0 ? 'ok' : 'degraded',
      reason: observations.length > 0 ? '' : 'no_items',
      observations,
      raw,
      assessment: observations.length > 0
        ? buildAssessment('ok', observations.length)
        : buildAssessment('degraded', 0, 'no_items'),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'degraded',
      reason: 'direct_error',
      assessment: buildAssessment('degraded', 0, 'direct_error'),
      observations: [],
    };
  }
}

export async function invokeMcpTool(toolKey, args = {}, options = {}) {
  const definition = MCP_TOOL_MAP[toolKey];
  if (!definition) {
    return {
      ok: false,
      status: 'failed',
      reason: 'unknown_tool',
      assessment: buildAssessment('failed', 0, 'unknown_tool'),
      observations: [],
    };
  }

  const gateway = getGatewayConfig();
  if (!gateway.enabled || !isToolEnabled(toolKey)) {
    // No MCP gateway — fall back to direct API calls if a handler exists
    if (hasDirectHandler(toolKey)) {
      return directFallback(toolKey, { ...definition.defaultArgs, ...(args || {}) });
    }
    return {
      ok: false,
      status: 'disabled',
      reason: gateway.enabled ? 'disabled_by_config' : 'gateway_not_configured',
      assessment: buildAssessment('degraded', 0, gateway.enabled ? 'disabled_by_config' : 'gateway_not_configured'),
      observations: [],
    };
  }

  const breaker = await getBreakerState(toolKey, options.redisUrl, options.redisToken);
  if (breaker?.openedUntil && breaker.openedUntil > Date.now()) {
    return {
      ok: false,
      status: 'degraded',
      reason: 'circuit_open',
      assessment: buildAssessment('degraded', 0, 'circuit_open'),
      observations: [],
    };
  }

  const requestBody = {
    server: definition.server,
    tool: definition.tool,
    arguments: {
      ...definition.defaultArgs,
      ...(args || {}),
    },
    timeoutMs: getMcpTimeoutMs(options.timeoutMs),
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (gateway.token) headers.Authorization = `Bearer ${gateway.token}`;

    const response = await fetch(`${gateway.url}/v1/tools/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(getMcpTimeoutMs(options.timeoutMs) + 250),
    });

    if (!response.ok) {
      const payload = await response.text();
      const reason = response.status === 401 ? 'auth_failed' : `gateway_${response.status}`;
      await recordBreakerFailure(toolKey, reason, options.redisUrl, options.redisToken);
      return {
        ok: false,
        status: response.status >= 500 ? 'failed' : 'degraded',
        reason,
        assessment: buildAssessment(response.status >= 500 ? 'failed' : 'degraded', 0, reason),
        observations: [],
        raw: payload,
      };
    }

    const payload = await response.json();
    const observations = normalizeMcpResult(toolKey, payload.result || {});
    await recordBreakerSuccess(toolKey, options.redisUrl, options.redisToken);

    return {
      ok: true,
      status: observations.length > 0 ? 'ok' : 'degraded',
      reason: observations.length > 0 ? '' : 'no_items',
      observations,
      raw: payload,
      assessment: observations.length > 0
        ? buildAssessment('ok', observations.length)
        : buildAssessment('degraded', 0, 'no_items'),
    };
  } catch (error) {
    const reason = String(error?.message || error || 'request_failed').includes('timeout')
      ? 'timeout'
      : 'request_failed';
    await recordBreakerFailure(toolKey, reason, options.redisUrl, options.redisToken);

    // Gateway failed — try direct API fallback before giving up
    if (hasDirectHandler(toolKey)) {
      const mergedArgs = { ...definition.defaultArgs, ...(args || {}) };
      return directFallback(toolKey, mergedArgs);
    }

    return {
      ok: false,
      status: reason === 'timeout' ? 'degraded' : 'failed',
      reason,
      assessment: buildAssessment(reason === 'timeout' ? 'degraded' : 'failed', 0, reason),
      observations: [],
    };
  }
}

function aggregateServerAssessments(results) {
  const byServer = new Map();
  for (const result of results) {
    const definition = MCP_TOOL_MAP[result.toolKey];
    if (!definition) continue;
    const current = byServer.get(definition.server) || [];
    current.push(result);
    byServer.set(definition.server, current);
  }

  const assessments = {};
  for (const [server, entries] of byServer.entries()) {
    const okCount = entries.filter((entry) => entry.status === 'ok').length;
    const degradedCount = entries.filter((entry) => entry.status === 'degraded' || entry.status === 'disabled').length;
    const sampleSize = entries.reduce((sum, entry) => sum + (entry.observations?.length || 0), 0);

    if (okCount > 0 && sampleSize > 0) {
      assessments[`mcp:${server}`] = { status: 'ok', sampleSize };
    } else if (degradedCount > 0) {
      assessments[`mcp:${server}`] = { status: 'degraded', sampleSize: 0, reason: entries.map((entry) => entry.reason).filter(Boolean)[0] || 'no_items' };
    } else {
      assessments[`mcp:${server}`] = { status: 'failed', sampleSize: 0, reason: entries.map((entry) => entry.reason).filter(Boolean)[0] || 'request_failed' };
    }
  }

  return assessments;
}

function buildCandidateQuery(candidate) {
  const entities = Array.isArray(candidate?.entities) ? candidate.entities.filter(Boolean) : [];
  const normalized = [...new Set(entities.map((entity) => normalizeEntity(entity)).filter(Boolean))];
  if (normalized.length >= 2) {
    return `${normalized[0]} AND ${normalized[1]}`;
  }
  if (normalized.length === 1) return normalized[0];

  const bestRecord = Array.isArray(candidate?.records) ? candidate.records[0]?.text || '' : '';
  return bestRecord.split(/\s+/).slice(0, 6).join(' ');
}

function summarizeObservation(record) {
  const source = record?.meta?.feedSource || formatSourceName(record?.sourceId || '');
  const date = record?.timestamp ? new Date(record.timestamp).toISOString().slice(11, 16) + ' UTC' : '';
  // Clean format: "Source HH:MM UTC: core text" — no pipes, no redundancy
  return `${source}${date ? ` ${date}` : ''}: ${record.text}`;
}

export function formatMcpObservationSection(title, observations, limit = 4) {
  const items = Array.isArray(observations) ? observations.slice(0, limit) : [];
  if (items.length === 0) return '';
  // Clean header + compact bullet list
  return `*${title}* (${items.length})\n${items.map((record) => `  ${summarizeObservation(record)}`).join('\n')}`;
}

export async function enrichCandidatesWithMcp(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { candidates: [], sourceAssessments: {}, highlights: [] };
  }

  // Enrichment works with MCP gateway OR direct API fallback — no gateway check needed
  const candidateLimit = Math.min(Number.parseInt(String(options.limit || 2), 10) || 2, candidates.length);
  const toolKeys = ['reddit_search', 'reddit_historical_search', 'news_gdelt_search'];
  const enriched = [...candidates];
  const flatResults = [];
  const highlights = [];

  await Promise.all(enriched.slice(0, candidateLimit).map(async (candidate, index) => {
    const query = buildCandidateQuery(candidate);
    if (!query) return;

    // Core enrichment: reddit + news
    const coreInvocations = await Promise.all(toolKeys.map(async (toolKey) => {
      const toolArgs = buildToolArgs(toolKey, query);
      const result = await invokeMcpTool(toolKey, toolArgs, options);
      result.toolKey = toolKey;
      return result;
    }));

    // Extended enrichment: sanctions, predictions, entity context, conflict events
    const extendedKeys = ['sanctions_search', 'predictions_search', 'entity_lookup', 'acled_events'];
    const extendedInvocations = await Promise.all(extendedKeys.map(async (toolKey) => {
      const toolArgs = buildToolArgs(toolKey, query);
      const result = await invokeMcpTool(toolKey, toolArgs, options);
      result.toolKey = toolKey;
      return result;
    }));

    const invocations = [...coreInvocations, ...extendedInvocations];
    const observations = invocations.flatMap((result) => result.observations || []).slice(0, 12);
    flatResults.push(...invocations);

    // Attach extended enrichment metadata to the candidate
    const sanctionsResult = extendedInvocations.find(r => r.toolKey === 'sanctions_search');
    const predictionsResult = extendedInvocations.find(r => r.toolKey === 'predictions_search');
    const entityResult = extendedInvocations.find(r => r.toolKey === 'entity_lookup');

    const mcpMeta = {};
    if (sanctionsResult?.ok && sanctionsResult.observations.length > 0) {
      mcpMeta.sanctionsMatch = true;
    }
    if (predictionsResult?.ok && predictionsResult.observations.length > 0) {
      const topPrediction = predictionsResult.observations[0]?.meta;
      mcpMeta.marketProbability = topPrediction?.probability ?? null;
    }
    if (entityResult?.ok && entityResult.raw?.result) {
      const entityPayload = extractPayload(entityResult.raw.result || entityResult.raw || {});
      if (entityPayload?.found) {
        mcpMeta.entityContext = {
          label: entityPayload.label,
          description: entityPayload.description,
          summary: (entityPayload.summary || entityPayload.wikipedia_summary || '').slice(0, 300),
        };
      }
    }

    // ACLED conflict events
    const acledResult = extendedInvocations.find(r => r.toolKey === 'acled_events');
    if (acledResult?.ok && acledResult.observations.length > 0) {
      mcpMeta.conflictEvents = acledResult.observations.length;
      const topEvent = acledResult.observations[0];
      mcpMeta.conflictSummary = topEvent?.text || '';
    }

    if (observations.length === 0 && Object.keys(mcpMeta).length === 0) return;

    const mergedRecords = dedupeRecords([...candidate.records, ...observations]);
    const summaries = observations.slice(0, 2).map((record) => summarizeObservation(record));
    highlights.push(`${query}: ${summaries.join(' | ')}`);

    enriched[index] = {
      ...candidate,
      records: mergedRecords,
      mcp: {
        query,
        observationCount: observations.length,
        highlights: summaries,
        ...mcpMeta,
      },
    };
  }));

  return {
    candidates: enriched,
    sourceAssessments: aggregateServerAssessments(flatResults),
    highlights,
  };
}

function buildToolArgs(toolKey, query) {
  if (toolKey === 'reddit_search') {
    return { query, response_format: 'json', sort: 'relevance', time_filter: 'week', limit: 4 };
  }
  if (toolKey === 'reddit_historical_search') {
    const after = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    return { query, response_format: 'json', after, limit: 4 };
  }
  if (toolKey === 'news_gdelt_search') {
    return { query, response_format: 'json', timespan: '30d', max_records: 4 };
  }
  if (toolKey === 'news_gdelt_events') {
    return { query, response_format: 'json', timespan: '30d' };
  }
  if (toolKey === 'earthquake_search') {
    return { region: query, minmagnitude: '4.5', days_back: '7' };
  }
  if (toolKey === 'flights_military') {
    return { region: query };
  }
  if (toolKey === 'sanctions_search') {
    return { query };
  }
  if (toolKey === 'predictions_search') {
    return { query, limit: '5' };
  }
  if (toolKey === 'maritime_vessels' || toolKey === 'maritime_port_activity') {
    return { port_name: query };
  }
  if (toolKey === 'entity_lookup') {
    return { query, language: 'en' };
  }
  if (toolKey === 'acled_events') {
    // Extract country from query for targeted ACLED search
    return { country: query.split(/\s+AND\s+/i)[0], days_back: '7', limit: '20' };
  }
  return { query, response_format: 'json' };
}

function dedupeRecords(records) {
  const seen = new Set();
  const deduped = [];
  for (const record of records || []) {
    if (!record?.id || seen.has(record.id)) continue;
    seen.add(record.id);
    deduped.push(record);
  }
  return deduped;
}

export async function searchMcpNews(query, options = {}) {
  const toolKeys = ['news_gdelt_search', 'news_gdelt_events'];
  const results = await Promise.all(toolKeys.map(async (toolKey) => {
    const result = await invokeMcpTool(toolKey, buildToolArgs(toolKey, query), options);
    result.toolKey = toolKey;
    return result;
  }));
  return {
    observations: dedupeRecords(results.flatMap((result) => result.observations || [])),
    sourceAssessments: aggregateServerAssessments(results),
  };
}

export async function searchMcpReddit(query, options = {}) {
  const toolKeys = ['reddit_search', 'reddit_historical_search'];
  const results = await Promise.all(toolKeys.map(async (toolKey) => {
    const result = await invokeMcpTool(toolKey, buildToolArgs(toolKey, query), options);
    result.toolKey = toolKey;
    return result;
  }));
  return {
    observations: dedupeRecords(results.flatMap((result) => result.observations || [])),
    sourceAssessments: aggregateServerAssessments(results),
  };
}

export async function buildMcpHistorySection(entity, options = {}) {
  const [reddit, news] = await Promise.all([
    searchMcpReddit(entity, options),
    searchMcpNews(entity, options),
  ]);
  const sections = [];
  const redditSection = formatMcpObservationSection(`REDDIT CONTEXT: ${entity}`, reddit.observations, 4);
  const newsSection = formatMcpObservationSection(`NEWS CONTEXT: ${entity}`, news.observations, 4);
  if (redditSection) sections.push(redditSection);
  if (newsSection) sections.push(newsSection);
  return {
    text: sections.join('\n\n'),
    sourceAssessments: { ...reddit.sourceAssessments, ...news.sourceAssessments },
  };
}

export function buildMcpSnapshotSection(enrichment) {
  const highlights = Array.isArray(enrichment?.highlights) ? enrichment.highlights.filter(Boolean).slice(0, 5) : [];
  if (highlights.length === 0) return '';
  return `ENRICHMENT:\n${highlights.map((line) => `- ${line}`).join('\n')}`;
}

export async function searchMcpSanctions(query, options = {}) {
  const result = await invokeMcpTool('sanctions_search', buildToolArgs('sanctions_search', query), options);
  result.toolKey = 'sanctions_search';
  return {
    observations: result.observations || [],
    sourceAssessments: aggregateServerAssessments([result]),
  };
}

export async function searchMcpPredictions(query, options = {}) {
  const result = await invokeMcpTool('predictions_search', buildToolArgs('predictions_search', query), options);
  result.toolKey = 'predictions_search';
  return {
    observations: result.observations || [],
    sourceAssessments: aggregateServerAssessments([result]),
  };
}

export async function lookupMcpEntity(query, options = {}) {
  const result = await invokeMcpTool('entity_lookup', buildToolArgs('entity_lookup', query), options);
  const payload = result.ok ? extractPayload(result.raw?.result || {}) : null;
  return payload?.found ? payload : null;
}

/**
 * Returns true if enrichment is available — either via MCP gateway OR direct API fallback.
 * Direct fallback covers all core enrichment tools (Reddit, GDELT, sanctions, predictions,
 * earthquakes, flights, entity lookup) without requiring the gateway infrastructure.
 */
export function gatewayConfigured() {
  // Always true — direct enrichment fallback handles gateway-less deployments
  return true;
}
