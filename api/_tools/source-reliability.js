/**
 * Source Reliability Ratings — maps each data source to a reliability tier.
 *
 * Scores range from 0-40. Higher = more trustworthy.
 * Used by the evidence fusion engine to weight records by source quality.
 */

// Reliability tiers — each tier has a numeric score and human-readable label
const RELIABILITY = {
  wire:            { score: 40, label: 'Wire/Gov' },       // Reuters, State Dept, USGS, Cloudflare
  mainstream:      { score: 32, label: 'Mainstream' },      // Google News headlines
  domain:          { score: 24, label: 'Domain Expert' },   // GDELT military, War on the Rocks, prediction markets
  social_verified: { score: 16, label: 'Social OSINT' },    // Reddit high-score, Telegram verified channels
  social_raw:      { score: 8,  label: 'Social Raw' },      // Reddit low-score, Telegram unverified
  weak:            { score: 4,  label: 'Weak/Anon' },       // Single anonymous source
};

// Telegram channels considered "verified" aggregators (larger, established OSINT accounts)
const VERIFIED_TELEGRAM_CHANNELS = new Set([
  'intelslava', 'osintdefender', 'BellumActaNews', 'IntelRepublic',
  'militarysummary', 'CIG_telegram', 'iranintl_en', 'rnintelligence',
]);

// Map source identifiers to their reliability tier key
const SOURCE_MAP = {
  // Wire / government feeds
  headlines:  'mainstream',    // Google News RSS — mainstream aggregator
  govFeeds:   'wire',          // Reuters, State Dept, War on the Rocks
  earthquakes: 'wire',         // USGS — authoritative government source
  outages:    'wire',          // Cloudflare Radar — authoritative infra source

  // Domain expert sources
  markets:     'domain',       // Yahoo Finance market data
  predictions: 'domain',       // Polymarket prediction markets
  military:    'domain',       // GDELT military news aggregation
};

/**
 * Get reliability info for a source identifier.
 *
 * @param {string} sourceId - e.g., "headlines", "telegram:intelslava", "reddit:worldnews"
 * @param {Object} [meta] - optional metadata (e.g., { score: 150 } for Reddit posts)
 * @returns {{ score: number, label: string, tier: string }}
 */
export function getReliability(sourceId, meta) {
  // Direct match in the static map (headlines, markets, etc.)
  if (SOURCE_MAP[sourceId]) {
    const tier = SOURCE_MAP[sourceId];
    return { ...RELIABILITY[tier], tier };
  }

  // Telegram channels — split by verified vs unverified
  if (sourceId.startsWith('telegram:')) {
    const channel = sourceId.split(':')[1];
    const tier = VERIFIED_TELEGRAM_CHANNELS.has(channel) ? 'social_verified' : 'social_raw';
    return { ...RELIABILITY[tier], tier };
  }

  // Reddit posts — split by score threshold
  if (sourceId.startsWith('reddit:')) {
    const redditScore = meta?.score ?? 0;
    const tier = redditScore > 100 ? 'social_verified' : 'social_raw';
    return { ...RELIABILITY[tier], tier };
  }

  // Unknown source — treat as weak
  return { ...RELIABILITY.weak, tier: 'weak' };
}

export { RELIABILITY };
