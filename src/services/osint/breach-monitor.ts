/**
 * OSINT Breach Monitor — Have I Been Pwned (HIBP) Integration
 *
 * Monitors recent data breaches via the HIBP API and checks them
 * against a watchlist of domains. Results are cached for 1 hour
 * to avoid excessive API calls.
 *
 * Usage:
 *   - fetchRecentBreaches()        → all breaches from the last 30 days
 *   - checkWatchedDomains(domains) → breaches matching your watchlist
 *   - getBreachStats()             → summary stats with top 5 by impact
 */

// ---- Constants ----

/** HIBP API v3 base URL */
const HIBP_API = 'https://haveibeenpwned.com/api/v3';

/** Cache time-to-live: 1 hour in milliseconds */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Fetch timeout: 10 seconds in milliseconds */
const FETCH_TIMEOUT_MS = 10 * 1000;

/** Only include breaches added in the last 30 days */
const RECENT_WINDOW_DAYS = 30;

/** User-Agent header required by HIBP API */
const USER_AGENT = 'WorldMonitor-BreachMonitor/1.0';

// ---- Types ----

/** Core breach information returned by this module */
export interface BreachInfo {
  name: string;          // Unique breach identifier (e.g., "Adobe")
  title: string;         // Human-readable name (e.g., "Adobe")
  domain: string;        // Breached domain (e.g., "adobe.com")
  breachDate: string;    // When the breach occurred (ISO date string)
  addedDate: string;     // When HIBP indexed it (ISO date string)
  pwnCount: number;      // Number of compromised accounts
  description: string;   // HTML description of the breach
  dataClasses: string[]; // Types of data exposed (e.g., ["Email addresses", "Passwords"])
}

/** Summary statistics for recent breaches */
export interface BreachStats {
  recentCount: number;          // Total breaches in the last 30 days
  totalPwned: number;           // Sum of all compromised accounts
  topBreaches: BreachInfo[];    // Top 5 breaches sorted by pwnCount
}

/** Raw breach object from the HIBP API (partial — only fields we use) */
interface HibpBreachResponse {
  Name: string;
  Title: string;
  Domain: string;
  BreachDate: string;
  AddedDate: string;
  PwnCount: number;
  Description: string;
  DataClasses: string[];
}

// ---- Module-level Cache ----

/**
 * In-memory cache: maps domain → list of breaches for that domain.
 * Populated on each successful fetch, cleared when TTL expires.
 */
const cachedBreaches: Map<string, BreachInfo[]> = new Map();

/** Timestamp of the last successful API fetch (epoch ms) */
let lastFetchTime = 0;

// ---- Internal Helpers ----

/**
 * Returns true if the cache is still valid (fetched less than 1 hour ago).
 */
function isCacheFresh(): boolean {
  return Date.now() - lastFetchTime < CACHE_TTL_MS;
}

/**
 * Maps a raw HIBP API breach object to our simplified BreachInfo shape.
 * Uses immutable mapping — no mutation of the input object.
 */
function toBreachInfo(raw: HibpBreachResponse): BreachInfo {
  return {
    name: raw.Name,
    title: raw.Title,
    domain: raw.Domain,
    breachDate: raw.BreachDate,
    addedDate: raw.AddedDate,
    pwnCount: raw.PwnCount,
    description: raw.Description,
    dataClasses: [...raw.DataClasses],
  };
}

/**
 * Checks whether a breach was added to HIBP within the last 30 days.
 */
function isRecentBreach(breach: BreachInfo): boolean {
  const addedTimestamp = new Date(breach.addedDate).getTime();
  const cutoff = Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return addedTimestamp >= cutoff;
}

/**
 * Indexes an array of breaches by their domain, storing them in the cache.
 * Each domain key maps to an array of all breaches for that domain.
 */
function indexByDomain(breaches: BreachInfo[]): void {
  // Clear previous cache entries before re-indexing
  cachedBreaches.clear();

  for (const breach of breaches) {
    // Normalize domain to lowercase for consistent lookups
    const domainKey = breach.domain.toLowerCase();

    // Skip breaches with no domain (some HIBP entries have empty domains)
    if (!domainKey) continue;

    // Group breaches by domain — push to existing array to avoid O(n^2) spreading
    const existing = cachedBreaches.get(domainKey);
    if (existing) {
      existing.push(breach);
    } else {
      cachedBreaches.set(domainKey, [breach]);
    }
  }
}

/**
 * Flattens the domain-indexed cache back into a single array of breaches.
 * Returns a new array (no mutation of cache internals).
 */
function getAllCachedBreaches(): BreachInfo[] {
  const allBreaches: BreachInfo[] = [];
  for (const breachList of cachedBreaches.values()) {
    allBreaches.push(...breachList);
  }
  return allBreaches;
}

// ---- Exported Functions ----

/**
 * Fetches recent data breaches from the HIBP API.
 *
 * Returns cached results if the cache is less than 1 hour old.
 * Otherwise, makes a fresh GET /breaches request with a 10s timeout,
 * filters to breaches added in the last 30 days, and indexes by domain.
 *
 * @returns Array of recent BreachInfo objects
 * @throws Error if the API request fails or times out
 */
export async function fetchRecentBreaches(): Promise<BreachInfo[]> {
  // Return cached data if it's still fresh
  if (isCacheFresh() && cachedBreaches.size > 0) {
    return getAllCachedBreaches();
  }

  // Set up a 10-second timeout via AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${HIBP_API}/breaches`, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `HIBP API returned ${response.status}: ${response.statusText}`
      );
    }

    const rawBreaches: HibpBreachResponse[] = await response.json();

    // Map to our BreachInfo shape and filter to last 30 days only
    const recentBreaches = rawBreaches
      .map(toBreachInfo)
      .filter(isRecentBreach);

    // Index by domain for fast watchlist lookups
    indexByDomain(recentBreaches);

    // Mark cache as fresh
    lastFetchTime = Date.now();

    return getAllCachedBreaches();
  } catch (error) {
    // Provide a clear error message for timeout vs other failures
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`HIBP API request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(
      `Failed to fetch breaches from HIBP: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Checks a list of watched domains against recent breaches.
 *
 * Calls fetchRecentBreaches() (which uses the cache) and returns
 * only breaches whose domain matches one of the provided domains.
 *
 * @param domains - Array of domain strings to check (e.g., ["adobe.com", "linkedin.com"])
 * @returns Array of BreachInfo objects matching the watched domains
 */
export async function checkWatchedDomains(domains: string[]): Promise<BreachInfo[]> {
  // Fetch (or use cached) recent breaches
  await fetchRecentBreaches();

  // Normalize input domains to lowercase for consistent comparison
  const normalizedDomains = domains.map(domain => domain.toLowerCase());

  // Collect matching breaches from the domain-indexed cache
  const matchingBreaches: BreachInfo[] = [];

  for (const domain of normalizedDomains) {
    const domainBreaches = cachedBreaches.get(domain);
    if (domainBreaches) {
      matchingBreaches.push(...domainBreaches);
    }
  }

  return matchingBreaches;
}

/**
 * Returns summary statistics for recent breaches.
 *
 * Fetches recent breaches, calculates totals, and returns the top 5
 * breaches sorted by number of compromised accounts (pwnCount).
 *
 * @returns Stats object with recentCount, totalPwned, and topBreaches
 */
export async function getBreachStats(): Promise<BreachStats> {
  const breaches = await fetchRecentBreaches();

  // Sum up all compromised accounts across recent breaches
  const totalPwned = breaches.reduce(
    (sum, breach) => sum + breach.pwnCount,
    0
  );

  // Sort by impact (highest pwnCount first) and take top 5
  const topBreaches = [...breaches]
    .sort((a, b) => b.pwnCount - a.pwnCount)
    .slice(0, 5);

  return {
    recentCount: breaches.length,
    totalPwned,
    topBreaches,
  };
}
