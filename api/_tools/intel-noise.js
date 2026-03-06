/**
 * Low-signal filtering for broad news feeds.
 *
 * Keeps the alerting pipeline focused on geopolitics/intelligence and suppresses
 * generic domestic political churn unless the topic is explicitly watched.
 */

import { normalizeWatchTerm } from './watchlist-utils.js';

const US_POLITICS_PATTERNS = [
  /\b(trump|biden|democrat|republican|gop|white house|congress|senate|house)\b/i,
  /\b(re-?election|campaign|primary|polling|lawsuit|budget|medicaid|healthcare)\b/i,
  /\b(cost of living|anthropic|tariffs?)\b/i,
];

const GLOBAL_SIGNAL_TERMS = [
  'iran', 'israel', 'ukraine', 'russia', 'china', 'taiwan', 'syria', 'gaza', 'nato', 'sanctions',
  'missile', 'military', 'carrier', 'nuclear', 'ceasefire', 'embassy', 'oil', 'shipping', 'red sea',
  'strait', 'earthquake', 'outage', 'cyber', 'ofac', 'travel advisory', 'gdacs', 'cisa',
  'defense', 'troops', 'war', 'drone', 'airbase', 'kuwait', 'tehran', 'iaea', 'polymarket',
];

export function isLowSignalText(text, watchlistTerms = []) {
  const value = String(text || '').toLowerCase();
  if (!value) return false;

  const hasWatchlistOverride = (watchlistTerms || []).some((term) => {
    const normalized = normalizeWatchTerm(term);
    return normalized && value.includes(normalized);
  });
  if (hasWatchlistOverride) return false;

  const hasDomesticPattern = US_POLITICS_PATTERNS.some((pattern) => pattern.test(value));
  if (!hasDomesticPattern) return false;

  const hasGlobalSignal = GLOBAL_SIGNAL_TERMS.some((term) => value.includes(term));
  return !hasGlobalSignal;
}

export function filterLowSignalRecords(records, watchlistTerms = []) {
  if (!Array.isArray(records) || records.length === 0) return [];

  return records.filter((record) => {
    if (!record?.text) return false;

    // Only apply the domestic-noise filter to broad social/news sources.
    const sourceId = String(record.sourceId || '');
    const shouldCheck = sourceId === 'headlines' || sourceId.startsWith('reddit:');
    if (!shouldCheck) return true;

    return !isLowSignalText(record.text, watchlistTerms);
  });
}
