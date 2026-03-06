/**
 * Watchlist normalization, matching, and reporting helpers.
 */

import { normalizeEntity } from './event-ledger.js';

const MAX_WATCH_TERM_LENGTH = 50;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'into',
  'about', 'after', 'before', 'over', 'under', 'into', 'near', 'what', 'when',
  'where', 'which', 'while', 'there', 'their', 'them', 'your', 'ours', 'its',
  'status', 'update', 'latest', 'today', 'news', 'report', 'brief', 'alert',
]);

/**
 * Convert a raw watch term into a consistent display + normalized shape.
 */
export function createWatchlistItem(rawTerm, now = Date.now()) {
  const term = sanitizeWatchlistTerm(rawTerm);
  if (!term) return null;

  return {
    term,
    normalized: normalizeWatchTerm(term),
    addedAt: now,
    lastMatchedAt: null,
    hitCount: 0,
  };
}

export function sanitizeWatchlistTerm(rawTerm) {
  if (typeof rawTerm !== 'string') return '';
  return rawTerm
    .replace(/[^\p{L}\p{N}\s\-.,/]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_WATCH_TERM_LENGTH);
}

export function normalizeWatchTerm(term) {
  const sanitized = sanitizeWatchlistTerm(term).toLowerCase();
  if (!sanitized) return '';
  return normalizeEntity(sanitized).replace(/\s+/g, ' ').trim();
}

/**
 * Backward-compatible hydration from legacy watchlist records.
 */
export function hydrateWatchlistItems(items) {
  if (!Array.isArray(items)) return [];

  const hydrated = [];
  const seen = new Set();

  for (const raw of items) {
    const term = typeof raw === 'string'
      ? sanitizeWatchlistTerm(raw)
      : sanitizeWatchlistTerm(raw?.term || raw?.label || '');
    const normalized = typeof raw === 'object' && raw?.normalized
      ? normalizeWatchTerm(raw.normalized)
      : normalizeWatchTerm(term);

    if (!term || !normalized) continue;

    const key = normalized;
    if (seen.has(key)) continue;
    seen.add(key);

    hydrated.push({
      term,
      normalized,
      addedAt: Number(raw?.addedAt || Date.now()),
      lastMatchedAt: raw?.lastMatchedAt ? Number(raw.lastMatchedAt) : null,
      hitCount: Number.isFinite(Number(raw?.hitCount)) ? Number(raw.hitCount) : 0,
    });
  }

  return hydrated.sort((a, b) => a.addedAt - b.addedAt);
}

export function formatWatchlistSummary(items, maxItems = 20) {
  const watchlist = hydrateWatchlistItems(items);
  if (watchlist.length === 0) {
    return 'No active watches. Use /watch <topic> to add one.';
  }

  return watchlist
    .slice(0, maxItems)
    .map((item, index) => {
      const since = formatDate(item.addedAt);
      const lastMatch = item.lastMatchedAt ? formatRelativeTime(item.lastMatchedAt) : 'no hits yet';
      const hitLabel = item.hitCount === 1 ? '1 hit' : `${item.hitCount} hits`;
      return `${index + 1}. ${item.term} — ${hitLabel}, last match ${lastMatch}, watching since ${since}`;
    })
    .join('\n');
}

/**
 * Return all watchlist matches for a candidate across all stored watchlists.
 */
export function findCandidateWatchlistMatches(candidate, watchlists) {
  const matches = [];
  if (!candidate || !Array.isArray(watchlists)) return matches;

  for (const watchlist of watchlists) {
    const chatId = String(watchlist.chatId || '');
    const items = hydrateWatchlistItems(watchlist.items || watchlist.terms || []);
    for (const item of items) {
      const match = matchCandidateToWatchItem(candidate, item);
      if (!match) continue;
      matches.push({
        chatId,
        term: item.term,
        normalized: item.normalized,
        matchType: match.matchType,
      });
    }
  }

  return dedupeMatches(matches);
}

export function applyWatchlistMatchStats(items, matches, now = Date.now()) {
  const watchlist = hydrateWatchlistItems(items);
  const normalizedMatches = new Set((matches || []).map((match) => normalizeWatchTerm(match.normalized || match.term)));
  if (normalizedMatches.size === 0) return watchlist;

  return watchlist.map((item) => {
    if (!normalizedMatches.has(item.normalized)) return item;
    return {
      ...item,
      lastMatchedAt: now,
      hitCount: (item.hitCount || 0) + 1,
    };
  });
}

/**
 * Match against normalized entities first, then strong phrase coverage.
 */
export function matchCandidateToWatchItem(candidate, item) {
  if (!candidate || !item?.normalized) return null;

  const candidateEntities = new Set((candidate.entities || []).map((entity) => normalizeEntity(entity)));
  if (candidateEntities.has(item.normalized)) {
    return { matchType: 'entity' };
  }

  const phraseTokens = tokenizeWatchPhrase(item.term);
  if (phraseTokens.length === 0) return null;

  const haystack = [
    ...(candidate.entities || []),
    ...((candidate.records || []).map((record) => record.text || '')),
  ].join(' ').toLowerCase();

  const hasAllTokens = phraseTokens.every((token) => haystack.includes(token));
  if (hasAllTokens) {
    return { matchType: phraseTokens.length === 1 ? 'keyword' : 'phrase' };
  }

  return null;
}

function tokenizeWatchPhrase(term) {
  return sanitizeWatchlistTerm(term)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => normalizeEntity(token))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function dedupeMatches(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.chatId}:${normalizeWatchTerm(match.normalized || match.term)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return 'unknown';
  }
}

function formatRelativeTime(timestamp) {
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return 'just now';
  if (deltaMs < 60 * 60_000) return `${Math.max(1, Math.round(deltaMs / 60_000))}m ago`;
  if (deltaMs < 24 * 60 * 60_000) return `${Math.max(1, Math.round(deltaMs / (60 * 60_000)))}h ago`;
  return `${Math.max(1, Math.round(deltaMs / (24 * 60 * 60_000)))}d ago`;
}
