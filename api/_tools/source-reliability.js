/**
 * Source Reliability Ratings — maps each data source to a reliability tier.
 *
 * Scores range from 0-40. Higher = more trustworthy.
 * Used by the evidence fusion engine to weight records by source quality.
 */

// Reliability tiers — each tier has a numeric score and human-readable label
const RELIABILITY = {
  wire:            { score: 40, label: 'Wire/Gov' },       // Reuters, State Dept, USGS, Cloudflare
  mainstream:      { score: 32, label: 'Mainstream' },      // Google News, Bloomberg, Guardian, CNBC, Al Jazeera
  osint_verified:  { score: 28, label: 'OSINT Verified' }, // Established OSINT accounts (IntelSlava, OSINTDefender, etc.)
  domain:          { score: 24, label: 'Domain Expert' },   // GDELT military, War on the Rocks, prediction markets
  social_verified: { score: 16, label: 'Social OSINT' },    // Reddit high-score
  social_raw:      { score: 8,  label: 'Social Raw' },      // Reddit low-score, Telegram unverified
  weak:            { score: 4,  label: 'Weak/Anon' },       // Single anonymous source
};

// Telegram channels — split into 3 tiers for granular reliability scoring

// Tier 1: Mainstream news orgs — same reliability as Google News headlines
const TELEGRAM_MAINSTREAM = new Set([
  'Bloomberg', 'guardian', 'cnbci', 'AJENews_Official', 'ajanews',
  'KyivIndependent_official', 'ILTVNews', 'TheTimesOfIsrael2022',
]);

// Tier 2: OSINT verified — established analysts with track record, not raw social
const TELEGRAM_OSINT_VERIFIED = new Set([
  'intelslava', 'osintdefender', 'BellumActaNews', 'IntelRepublic',
  'militarysummary', 'CIG_telegram', 'iranintl_en', 'rnintelligence',
  'ukrainenowenglish', 'idfofficial', 'barakravid1',
]);

// Everything else stays social_raw (score 8)

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

  // Twitter/X OSINT accounts — verified analysts
  twitter:    'osint_verified',

  // Bluesky OSINT accounts — verified analysts (AT Protocol, free API)
  bluesky:    'osint_verified',
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

  // Telegram channels — 3-tier: mainstream > osint_verified > social_raw
  if (sourceId.startsWith('telegram:')) {
    const channel = sourceId.split(':')[1];
    let tier = 'social_raw';
    if (TELEGRAM_MAINSTREAM.has(channel)) tier = 'mainstream';
    else if (TELEGRAM_OSINT_VERIFIED.has(channel)) tier = 'osint_verified';
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

export { RELIABILITY, TELEGRAM_MAINSTREAM, TELEGRAM_OSINT_VERIFIED };
