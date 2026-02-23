// ---------------------------------------------------------------------------
// Watchlist Service — localStorage-backed tracking for entities, regions,
// topics, and threshold-based alerts. Persists across page reloads.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'worldmonitor-watchlist';
const MAX_ITEMS = 50;

// 30 minutes in milliseconds — suppress duplicate matches within this window
const MATCH_COOLDOWN_MS = 30 * 60 * 1000;

// Minimum token length to be considered a "significant" term for matching
const MIN_SIGNIFICANT_LENGTH = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single item being watched (region, entity, topic, or threshold rule). */
export interface WatchItem {
  id: string;
  query: string;
  type: 'region' | 'entity' | 'topic' | 'threshold';
  createdAt: number;
  lastTriggered: number | null;
}

/** Returned when a watch item matches incoming text. */
export interface WatchMatch {
  watchId: string;
  query: string;
  matchedSignal: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Country / region names used by detectWatchType to classify queries
// ---------------------------------------------------------------------------

const REGION_TERMS = new Set([
  // Continents & macro-regions
  'africa', 'asia', 'europe', 'americas', 'oceania', 'middle east',
  'north america', 'south america', 'central america', 'caribbean',
  'southeast asia', 'east asia', 'south asia', 'central asia',
  'sub-saharan africa', 'north africa', 'eastern europe', 'western europe',
  'nordic', 'baltic', 'balkans', 'caucasus', 'pacific', 'arctic', 'antarctic',

  // Major countries (lowercase)
  'afghanistan', 'albania', 'algeria', 'argentina', 'armenia', 'australia',
  'austria', 'azerbaijan', 'bahrain', 'bangladesh', 'belarus', 'belgium',
  'bolivia', 'bosnia', 'brazil', 'bulgaria', 'cambodia', 'cameroon',
  'canada', 'chad', 'chile', 'china', 'colombia', 'congo', 'croatia',
  'cuba', 'cyprus', 'czech', 'denmark', 'ecuador', 'egypt', 'estonia',
  'ethiopia', 'finland', 'france', 'georgia', 'germany', 'ghana', 'greece',
  'guatemala', 'haiti', 'honduras', 'hungary', 'iceland', 'india',
  'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica',
  'japan', 'jordan', 'kazakhstan', 'kenya', 'korea', 'kuwait', 'laos',
  'latvia', 'lebanon', 'libya', 'lithuania', 'malaysia', 'mali', 'mexico',
  'moldova', 'mongolia', 'morocco', 'mozambique', 'myanmar', 'nepal',
  'netherlands', 'new zealand', 'nicaragua', 'niger', 'nigeria', 'norway',
  'oman', 'pakistan', 'palestine', 'panama', 'paraguay', 'peru',
  'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia',
  'rwanda', 'saudi arabia', 'senegal', 'serbia', 'singapore', 'slovakia',
  'slovenia', 'somalia', 'south africa', 'spain', 'sri lanka', 'sudan',
  'sweden', 'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania',
  'thailand', 'tunisia', 'turkey', 'turkmenistan', 'uganda', 'ukraine',
  'united arab emirates', 'uae', 'united kingdom', 'uk', 'united states',
  'usa', 'uruguay', 'uzbekistan', 'venezuela', 'vietnam', 'yemen',
  'zambia', 'zimbabwe',

  // Common shorthand / demonyms that imply a region
  'gaza', 'crimea', 'donbas', 'taiwan strait', 'south china sea',
  'red sea', 'black sea', 'strait of hormuz', 'suez canal',
]);

// ---------------------------------------------------------------------------
// Financial / topic terms used by detectWatchType
// ---------------------------------------------------------------------------

const TOPIC_TERMS = new Set([
  'inflation', 'gdp', 'recession', 'interest rate', 'fed', 'federal reserve',
  'ecb', 'bond', 'bonds', 'yield', 'yields', 'treasury', 'commodity',
  'commodities', 'oil', 'crude', 'natural gas', 'gold', 'silver', 'copper',
  'wheat', 'corn', 'semiconductor', 'semiconductors', 'trade war', 'tariff',
  'tariffs', 'sanctions', 'embargo', 'currency', 'forex', 'dollar', 'euro',
  'yen', 'yuan', 'bitcoin', 'crypto', 'cryptocurrency', 'stock market',
  'bear market', 'bull market', 'ipo', 'merger', 'acquisition', 'earnings',
  'revenue', 'debt', 'default', 'bankruptcy', 'unemployment', 'jobs',
  'payroll', 'cpi', 'ppi', 'housing', 'real estate', 'supply chain',
  'logistics', 'shipping', 'energy', 'nuclear', 'renewable', 'solar',
  'wind power', 'ev', 'electric vehicle', 'ai', 'artificial intelligence',
  'cybersecurity', 'pandemic', 'epidemic', 'vaccine', 'climate', 'emissions',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short unique ID (same pattern used elsewhere in the codebase). */
function generateWatchId(): string {
  return `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Safe check for localStorage availability (SSR / incognito guards). */
function isStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Detect the type of a watch query.
 *
 * Priority order:
 *  1. 'threshold' — contains price/numeric threshold keywords ($, %, above, below, etc.)
 *  2. 'region'    — matches a known country, region, or geographic term
 *  3. 'topic'     — matches a financial / macro term
 *  4. 'entity'    — everything else (company names, people, orgs)
 */
export function detectWatchType(query: string): WatchItem['type'] {
  const lower = query.toLowerCase().trim();

  // 1. Threshold: contains price/numeric trigger words or symbols
  if (/[$%]/.test(lower) || /\b(above|below|over|under)\b/.test(lower)) {
    return 'threshold';
  }

  // 2. Region: check if query matches a known geographic term
  if (REGION_TERMS.has(lower)) {
    return 'region';
  }
  // Also check if any multi-word region term appears within the query
  for (const region of REGION_TERMS) {
    if (region.length > 3 && lower.includes(region)) {
      return 'region';
    }
  }

  // 3. Topic: check if query matches a financial / macro term
  if (TOPIC_TERMS.has(lower)) {
    return 'topic';
  }
  for (const topic of TOPIC_TERMS) {
    if (topic.length > 3 && lower.includes(topic)) {
      return 'topic';
    }
  }

  // 4. Default: treat as an entity (company, person, org, etc.)
  return 'entity';
}

/**
 * Extract significant terms from a query string.
 * "Significant" means longer than 2 characters — short words like
 * "a", "in", "of" are noise and would cause false-positive matches.
 */
function getSignificantTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(term => term.length > MIN_SIGNIFICANT_LENGTH - 1); // > 2 chars means length >= 3
}

/**
 * Check whether ALL significant terms from a query appear somewhere
 * in the given text (case-insensitive substring match).
 */
function allTermsMatch(significantTerms: string[], text: string): boolean {
  if (significantTerms.length === 0) return false;
  const lowerText = text.toLowerCase();
  return significantTerms.every(term => lowerText.includes(term));
}

// ---------------------------------------------------------------------------
// Persistence — read / write the watchlist to localStorage
// ---------------------------------------------------------------------------

/** Read the full watchlist from localStorage. Returns [] on any error. */
export function getWatchlist(): WatchItem[] {
  if (!isStorageAvailable()) return [];

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Basic shape validation — drop any malformed entries
    return parsed.filter(
      (item): item is WatchItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.query === 'string' &&
        typeof item.type === 'string' &&
        typeof item.createdAt === 'number',
    );
  } catch {
    return [];
  }
}

/** Persist the watchlist array to localStorage. */
function saveWatchlist(items: WatchItem[]): void {
  if (!isStorageAvailable()) return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // localStorage full or unavailable — silently degrade
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a new watch item. Auto-detects the type from the query string,
 * prepends it to the list, and caps the list at MAX_ITEMS (50).
 * Returns the newly created WatchItem.
 */
export function addWatch(query: string): WatchItem {
  const trimmedQuery = query.trim();

  const newItem: WatchItem = {
    id: generateWatchId(),
    query: trimmedQuery,
    type: detectWatchType(trimmedQuery),
    createdAt: Date.now(),
    lastTriggered: null,
  };

  // Prepend to the front of the list (most recent first)
  const currentList = getWatchlist();
  const updatedList = [newItem, ...currentList].slice(0, MAX_ITEMS);
  saveWatchlist(updatedList);

  return newItem;
}

/**
 * Remove a watch item by its ID.
 * Filters out the matching item and persists the result.
 */
export function removeWatch(id: string): void {
  const currentList = getWatchlist();
  const filteredList = currentList.filter(item => item.id !== id);
  saveWatchlist(filteredList);
}

/**
 * Check all watch items against incoming headlines and signals.
 *
 * Matching rules:
 *  - ALL significant terms (> 2 chars) from the watch query must appear
 *    in the text for it to count as a match (case-insensitive).
 *  - Items triggered within the last 30 minutes are suppressed (cooldown).
 *  - Only one match per watch item per cycle (first match wins).
 *  - Updates lastTriggered on match and persists to localStorage.
 *
 * Returns an array of WatchMatch objects for any triggered items.
 */
export function checkWatchlist(headlines: string[], signals: string[]): WatchMatch[] {
  const watchlist = getWatchlist();
  if (watchlist.length === 0) return [];

  const now = Date.now();
  const allTexts = [...headlines, ...signals];
  const matches: WatchMatch[] = [];

  // Track which watch items got updated so we can persist in one write
  let anyUpdated = false;

  for (const item of watchlist) {
    // Skip items that were triggered within the cooldown window
    if (item.lastTriggered !== null && now - item.lastTriggered < MATCH_COOLDOWN_MS) {
      continue;
    }

    const significantTerms = getSignificantTerms(item.query);
    if (significantTerms.length === 0) continue;

    // Find the first matching text (one match per item per cycle)
    for (const text of allTexts) {
      if (allTermsMatch(significantTerms, text)) {
        // Record the match
        matches.push({
          watchId: item.id,
          query: item.query,
          matchedSignal: text,
          timestamp: now,
        });

        // Update lastTriggered in-place on this local copy (from getWatchlist's
        // fresh parse). This avoids creating N new objects; we persist the whole
        // list in one saveWatchlist call at the end.
        item.lastTriggered = now;
        anyUpdated = true;

        // One match per watch item — break to the next item
        break;
      }
    }
  }

  // Persist updated lastTriggered timestamps in one write
  if (anyUpdated) {
    saveWatchlist(watchlist);
  }

  return matches;
}
