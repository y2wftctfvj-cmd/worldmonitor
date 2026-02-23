/**
 * VirusTotal Campaign Tracking and Geographic Threat Aggregation
 *
 * Two capabilities built on top of the existing cyber threat infrastructure:
 *
 *   1. Geographic threat aggregation — Takes existing cyber threat data
 *      (from the RPC endpoint / AbuseIPDB) and groups by country to produce
 *      heatmap-ready summaries with severity classification.
 *
 *   2. VirusTotal domain/URL reputation — Optional server-side enrichment
 *      that checks domains and URLs against the VT v3 API. Requires an API
 *      key passed explicitly (never read from process.env on client side).
 *      Rate-limited to 4 requests per minute to stay within VT free tier.
 *
 * Usage:
 *   - aggregateThreatsByCountry(threats) -> country-level heatmap data
 *   - checkDomainVt(domain, apiKey)      -> domain reputation (server only)
 *   - checkUrlVt(url, apiKey)            -> URL reputation (server only)
 */

// ---- Constants ----

/** VirusTotal API v3 base URL */
const VT_API = 'https://www.virustotal.com/api/v3';

/** Cache TTL: 30 minutes (VT free tier rate limits are tight at 4 req/min) */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** VirusTotal free tier allows 4 requests per minute */
const MAX_VT_REQUESTS_PER_MIN = 4;

/** Minimum interval between VT requests (60s / 4 = 15s) */
const VT_REQUEST_INTERVAL_MS = Math.ceil(60_000 / MAX_VT_REQUESTS_PER_MIN);

/** Fetch timeout for VT API calls */
const FETCH_TIMEOUT_MS = 10_000;

// ---- Exported Interfaces ----

/** Domain reputation report from VirusTotal */
export interface VtDomainReport {
  domain: string;
  malicious: number;
  suspicious: number;
  harmless: number;
  categories: string[];
  lastAnalysisDate: string;
  reputation: number;
}

/** URL reputation report from VirusTotal */
export interface VtUrlReport {
  url: string;
  malicious: number;
  suspicious: number;
  harmless: number;
  lastAnalysisDate: string;
}

/** Country-level threat aggregation for heatmap display */
export interface ThreatGeoSummary {
  countryCode: string;
  countryName: string;
  threatCount: number;
  topMalware: string[];
  avgConfidence: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/** Combined report with VT enrichment and geographic aggregation */
export interface CyberOsintReport {
  vtDomainReports: VtDomainReport[];
  geoSummary: ThreatGeoSummary[];
  fetchedAt: number;
}

// ---- Module-level Caches ----

/** In-memory cache for VT domain reports, keyed by domain string */
const vtDomainCache: Map<string, { report: VtDomainReport; cachedAt: number }> = new Map();

/** In-memory cache for VT URL reports, keyed by the original URL */
const vtUrlCache: Map<string, { report: VtUrlReport; cachedAt: number }> = new Map();

/** Timestamp of the last VT API request (epoch ms) for rate limiting */
let lastVtRequest = 0;

// ---- Country Name Lookup ----

/**
 * ISO 3166-1 alpha-2 country codes mapped to display names.
 * Covers the top 50 countries by cyber threat activity.
 */
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  CN: 'China',
  RU: 'Russia',
  DE: 'Germany',
  GB: 'United Kingdom',
  FR: 'France',
  NL: 'Netherlands',
  JP: 'Japan',
  KR: 'South Korea',
  IN: 'India',
  BR: 'Brazil',
  CA: 'Canada',
  AU: 'Australia',
  IT: 'Italy',
  ES: 'Spain',
  SE: 'Sweden',
  PL: 'Poland',
  UA: 'Ukraine',
  RO: 'Romania',
  CZ: 'Czech Republic',
  TW: 'Taiwan',
  HK: 'Hong Kong',
  SG: 'Singapore',
  VN: 'Vietnam',
  TH: 'Thailand',
  ID: 'Indonesia',
  PH: 'Philippines',
  MY: 'Malaysia',
  TR: 'Turkey',
  ZA: 'South Africa',
  NG: 'Nigeria',
  EG: 'Egypt',
  AR: 'Argentina',
  MX: 'Mexico',
  CO: 'Colombia',
  CL: 'Chile',
  IR: 'Iran',
  PK: 'Pakistan',
  BD: 'Bangladesh',
  SA: 'Saudi Arabia',
  AE: 'United Arab Emirates',
  IL: 'Israel',
  FI: 'Finland',
  NO: 'Norway',
  DK: 'Denmark',
  AT: 'Austria',
  CH: 'Switzerland',
  BE: 'Belgium',
  IE: 'Ireland',
  PT: 'Portugal',
};

// ---- Internal Helpers ----

/**
 * Enforces VT rate limiting by waiting if the last request was too recent.
 * Returns immediately if enough time has passed since the last request.
 */
async function enforceVtRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastVtRequest;
  const waitMs = VT_REQUEST_INTERVAL_MS - elapsed;

  if (waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  lastVtRequest = Date.now();
}

/**
 * Checks whether a cached entry is still within the TTL window.
 */
function isCacheEntryFresh(cachedAt: number): boolean {
  return Date.now() - cachedAt < CACHE_TTL_MS;
}

/**
 * Sanitizes a domain string: trims whitespace, lowercases, removes protocol.
 * Returns empty string if the input is not a valid-looking domain.
 */
function sanitizeDomain(domain: string): string {
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');

  // Basic domain format check: at least one dot, no spaces
  if (!cleaned || !cleaned.includes('.') || /\s/.test(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Converts a URL to the base64url identifier that VirusTotal expects.
 * VT API requires: base64url(url) with no trailing '=' padding.
 */
function urlToVtId(url: string): string {
  // btoa works in both browser and modern Node (globalThis.btoa)
  const base64 = btoa(url);

  // Convert standard base64 to base64url (replace + with -, / with _, strip =)
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Classifies a country's threat severity based on threat count thresholds.
 * Thresholds: >= 20 critical, >= 10 high, >= 5 medium, else low.
 */
function classifySeverity(threatCount: number): 'low' | 'medium' | 'high' | 'critical' {
  if (threatCount >= 20) return 'critical';
  if (threatCount >= 10) return 'high';
  if (threatCount >= 5) return 'medium';
  return 'low';
}

// ---- Exported Functions ----

/**
 * Input shape for geographic threat aggregation.
 * Matches the fields available from the existing cyber threat RPC endpoint.
 */
interface ThreatInput {
  country: string;
  severity: string;
  tags: string[];
  abuseConfidence?: number;
}

/**
 * Aggregates an array of cyber threats by country code to produce
 * country-level heatmap data for the map display.
 *
 * For each country:
 *   - Counts total threats
 *   - Extracts the top 5 most common malware families from tags
 *   - Averages the AbuseIPDB confidence scores (0-100)
 *   - Classifies severity: >= 20 critical, >= 10 high, >= 5 medium, else low
 *
 * Results are sorted by threatCount descending.
 *
 * @param threats - Array of threat objects with country, severity, tags
 * @returns Country-level summaries sorted by threat count (highest first)
 */
export function aggregateThreatsByCountry(threats: ReadonlyArray<ThreatInput>): ThreatGeoSummary[] {
  // Group threats by country code using an accumulator map
  const countryMap = new Map<string, {
    threats: number;
    tagCounts: Map<string, number>;
    confidenceSum: number;
    confidenceCount: number;
  }>();

  for (const threat of threats) {
    // Skip threats with no country code
    const countryCode = (threat.country || '').trim().toUpperCase();
    if (!countryCode) continue;

    // Get or initialize the accumulator for this country
    const existing = countryMap.get(countryCode) || {
      threats: 0,
      tagCounts: new Map<string, number>(),
      confidenceSum: 0,
      confidenceCount: 0,
    };

    // Increment threat count
    const updated = {
      ...existing,
      threats: existing.threats + 1,
    };

    // Count tag occurrences for extracting top malware families
    for (const tag of threat.tags) {
      const normalizedTag = tag.trim().toLowerCase();
      if (!normalizedTag) continue;

      // Skip generic tags that are not malware-specific
      if (['botnet', 'c2', 'malware', 'phishing', 'spam'].includes(normalizedTag)) continue;

      // Skip score tags from AbuseIPDB (e.g., "score:95")
      if (normalizedTag.startsWith('score:')) continue;

      updated.tagCounts.set(normalizedTag, (existing.tagCounts.get(normalizedTag) || 0) + 1);
    }

    // Accumulate confidence scores (only when present and valid)
    if (
      typeof threat.abuseConfidence === 'number'
      && Number.isFinite(threat.abuseConfidence)
      && threat.abuseConfidence >= 0
      && threat.abuseConfidence <= 100
    ) {
      updated.confidenceSum = existing.confidenceSum + threat.abuseConfidence;
      updated.confidenceCount = existing.confidenceCount + 1;
    }

    countryMap.set(countryCode, updated);
  }

  // Convert the accumulator map to an array of ThreatGeoSummary objects
  const summaries: ThreatGeoSummary[] = [];

  for (const [countryCode, data] of countryMap.entries()) {
    // Extract top 5 malware tags sorted by frequency
    const topMalware = Array.from(data.tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);

    // Calculate average confidence score (default to 0 if none available)
    const avgConfidence = data.confidenceCount > 0
      ? Math.round(data.confidenceSum / data.confidenceCount)
      : 0;

    summaries.push({
      countryCode,
      countryName: COUNTRY_NAMES[countryCode] || countryCode,
      threatCount: data.threats,
      topMalware,
      avgConfidence,
      severity: classifySeverity(data.threats),
    });
  }

  // Sort by threat count descending so the worst countries appear first
  return summaries.sort((a, b) => b.threatCount - a.threatCount);
}

/**
 * Checks a domain's reputation against the VirusTotal API v3.
 *
 * IMPORTANT: This function is intended for server-side use only.
 * The API key must be passed explicitly — it is never read from
 * environment variables to prevent accidental client-side exposure.
 *
 * Rate-limited to 4 requests per minute (VT free tier limit).
 * Results are cached in memory for 30 minutes.
 *
 * @param domain - Domain to check (e.g., "example.com")
 * @param apiKey - VirusTotal API key (server-side only)
 * @returns Domain report, or null if the request fails
 */
export async function checkDomainVt(
  domain: string,
  apiKey: string,
): Promise<VtDomainReport | null> {
  // Validate inputs
  const cleanDomain = sanitizeDomain(domain);
  if (!cleanDomain) {
    return null;
  }

  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return null;
  }

  // Check cache first
  const cached = vtDomainCache.get(cleanDomain);
  if (cached && isCacheEntryFresh(cached.cachedAt)) {
    return cached.report;
  }

  // Enforce rate limiting before making the request
  await enforceVtRateLimit();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${VT_API}/domains/${encodeURIComponent(cleanDomain)}`, {
      method: 'GET',
      headers: {
        'x-apikey': apiKey.trim(),
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const attributes = payload?.data?.attributes;

    if (!attributes) {
      return null;
    }

    // Parse the VirusTotal v3 response into our simplified shape
    const analysisStats = attributes.last_analysis_stats || {};
    const lastAnalysisEpoch = attributes.last_analysis_date || 0;

    const report: VtDomainReport = {
      domain: cleanDomain,
      malicious: Number(analysisStats.malicious) || 0,
      suspicious: Number(analysisStats.suspicious) || 0,
      harmless: Number(analysisStats.harmless) || 0,
      categories: extractCategories(attributes.categories),
      lastAnalysisDate: lastAnalysisEpoch
        ? new Date(lastAnalysisEpoch * 1000).toISOString()
        : '',
      reputation: Number(attributes.reputation) || 0,
    };

    // Cache the successful result
    vtDomainCache.set(cleanDomain, { report, cachedAt: Date.now() });

    return report;
  } catch {
    // Return null on any failure (timeout, network error, parse error)
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Checks a URL's reputation against the VirusTotal API v3.
 *
 * IMPORTANT: This function is intended for server-side use only.
 * The URL is base64url-encoded per the VT API specification.
 *
 * Rate-limited to 4 requests per minute (VT free tier limit).
 * Results are cached in memory for 30 minutes.
 *
 * @param url - URL to check (e.g., "https://malicious-site.com/payload")
 * @param apiKey - VirusTotal API key (server-side only)
 * @returns URL report, or null if the request fails
 */
export async function checkUrlVt(
  url: string,
  apiKey: string,
): Promise<VtUrlReport | null> {
  // Validate inputs
  const trimmedUrl = (url || '').trim();
  if (!trimmedUrl) {
    return null;
  }

  // Basic URL format validation
  try {
    new URL(trimmedUrl);
  } catch {
    return null;
  }

  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return null;
  }

  // Check cache first
  const cached = vtUrlCache.get(trimmedUrl);
  if (cached && isCacheEntryFresh(cached.cachedAt)) {
    return cached.report;
  }

  // Enforce rate limiting before making the request
  await enforceVtRateLimit();

  // VT API requires the URL encoded as base64url
  const vtUrlId = urlToVtId(trimmedUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${VT_API}/urls/${vtUrlId}`, {
      method: 'GET',
      headers: {
        'x-apikey': apiKey.trim(),
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const attributes = payload?.data?.attributes;

    if (!attributes) {
      return null;
    }

    // Parse the VT v3 URL analysis response
    const analysisStats = attributes.last_analysis_stats || {};
    const lastAnalysisEpoch = attributes.last_analysis_date || 0;

    const report: VtUrlReport = {
      url: trimmedUrl,
      malicious: Number(analysisStats.malicious) || 0,
      suspicious: Number(analysisStats.suspicious) || 0,
      harmless: Number(analysisStats.harmless) || 0,
      lastAnalysisDate: lastAnalysisEpoch
        ? new Date(lastAnalysisEpoch * 1000).toISOString()
        : '',
    };

    // Cache the successful result
    vtUrlCache.set(trimmedUrl, { report, cachedAt: Date.now() });

    return report;
  } catch {
    // Return null on any failure (timeout, network error, parse error)
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- Internal Helpers (VT Response Parsing) ----

/**
 * Extracts category strings from the VT categories object.
 * VT returns categories as { "vendor": "category_name" } pairs.
 * We flatten to a deduplicated array of category strings.
 */
function extractCategories(categories: Record<string, string> | undefined): string[] {
  if (!categories || typeof categories !== 'object') {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const categoryValue of Object.values(categories)) {
    const normalized = String(categoryValue || '').trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}
