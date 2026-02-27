import { applyWarningLists } from './warning-lists.js';

/**
 * Entity Dictionary — lightweight regex + dictionary entity extraction.
 *
 * No npm dependencies. Uses pre-built dictionaries of countries, actors,
 * and organizations relevant to geopolitical intelligence monitoring.
 * Fast: ~0.5ms per text block.
 */

// Countries and regions (~50 entries, lowercase key -> canonical name)
const COUNTRIES = {
  'iran': 'Iran', 'iraq': 'Iraq', 'israel': 'Israel', 'palestine': 'Palestine',
  'china': 'China', 'taiwan': 'Taiwan', 'japan': 'Japan', 'south korea': 'South Korea',
  'north korea': 'North Korea', 'dprk': 'North Korea',
  'ukraine': 'Ukraine', 'russia': 'Russia', 'belarus': 'Belarus',
  'syria': 'Syria', 'lebanon': 'Lebanon', 'yemen': 'Yemen', 'saudi arabia': 'Saudi Arabia',
  'turkey': 'Turkey', 'egypt': 'Egypt', 'libya': 'Libya', 'sudan': 'Sudan',
  'india': 'India', 'pakistan': 'Pakistan', 'afghanistan': 'Afghanistan',
  'united states': 'United States', 'usa': 'United States', 'u.s.': 'United States',
  'united kingdom': 'United Kingdom', 'uk': 'United Kingdom', 'britain': 'United Kingdom',
  'germany': 'Germany', 'france': 'France', 'poland': 'Poland', 'romania': 'Romania',
  'italy': 'Italy', 'spain': 'Spain', 'greece': 'Greece',
  'mexico': 'Mexico', 'brazil': 'Brazil', 'venezuela': 'Venezuela', 'colombia': 'Colombia',
  'cuba': 'Cuba', 'philippines': 'Philippines', 'indonesia': 'Indonesia',
  'south africa': 'South Africa', 'nigeria': 'Nigeria', 'ethiopia': 'Ethiopia',
  'somalia': 'Somalia', 'congo': 'Congo', 'myanmar': 'Myanmar',
  'gaza': 'Gaza', 'west bank': 'West Bank', 'crimea': 'Crimea',
  'donbas': 'Donbas', 'donbass': 'Donbas', 'kherson': 'Kherson',
  'taiwan strait': 'Taiwan Strait', 'south china sea': 'South China Sea',
  'persian gulf': 'Persian Gulf', 'red sea': 'Red Sea', 'black sea': 'Black Sea',
};

// Actors and leaders (~40 entries)
const ACTORS = {
  'putin': 'Putin', 'zelensky': 'Zelensky', 'zelenskyy': 'Zelensky',
  'xi jinping': 'Xi Jinping', 'xi': 'Xi Jinping',
  'biden': 'Biden', 'trump': 'Trump',
  'netanyahu': 'Netanyahu', 'khamenei': 'Khamenei',
  'erdogan': 'Erdogan', 'modi': 'Modi', 'macron': 'Macron',
  'kim jong un': 'Kim Jong Un', 'kim jong-un': 'Kim Jong Un',
  'mbs': 'MBS', 'bin salman': 'MBS',
  'idf': 'IDF', 'hamas': 'Hamas', 'hezbollah': 'Hezbollah', 'houthis': 'Houthis',
  'houthi': 'Houthis', 'taliban': 'Taliban', 'isis': 'ISIS', 'isil': 'ISIS',
  'wagner': 'Wagner', 'prigozhin': 'Prigozhin',
  'cia': 'CIA', 'mossad': 'Mossad', 'fsb': 'FSB', 'gru': 'GRU',
  'pentagon': 'Pentagon', 'kremlin': 'Kremlin', 'white house': 'White House',
  'irgc': 'IRGC', 'quds force': 'Quds Force',
  'pla': 'PLA', 'peoples liberation army': 'PLA',
  'azov': 'Azov', 'spetsnaz': 'Spetsnaz',
};

// Organizations (~25 entries)
const ORGS = {
  'nato': 'NATO', 'un': 'UN', 'united nations': 'UN',
  'iaea': 'IAEA', 'opec': 'OPEC', 'opec+': 'OPEC+',
  'eu': 'EU', 'european union': 'EU',
  'who': 'WHO', 'imf': 'IMF', 'world bank': 'World Bank',
  'brics': 'BRICS', 'asean': 'ASEAN', 'g7': 'G7', 'g20': 'G20',
  'icj': 'ICJ', 'icc': 'ICC',
  'swift': 'SWIFT', 'fed': 'Federal Reserve', 'federal reserve': 'Federal Reserve',
  'ecb': 'ECB', 'sec': 'SEC',
  'red cross': 'Red Cross', 'amnesty international': 'Amnesty International',
  'aukus': 'AUKUS', 'quad': 'Quad',
};

// Pre-build regex patterns for each dictionary (sorted longest-first to match multi-word entries)
function buildPatterns(dictionary) {
  const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
  return keys.map(key => ({
    pattern: new RegExp(`\\b${escapeRegex(key)}\\b`, 'i'),
    canonical: dictionary[key],
  }));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COUNTRY_PATTERNS = buildPatterns(COUNTRIES);
const ACTOR_PATTERNS = buildPatterns(ACTORS);
const ORG_PATTERNS = buildPatterns(ORGS);

/**
 * Extract entities from a text string.
 *
 * Returns deduplicated canonical names grouped by type.
 * Fast: runs all dictionary checks in a single pass per category.
 *
 * @param {string} text - The text to extract entities from
 * @returns {{ countries: string[], actors: string[], orgs: string[], all: string[] }}
 */
export function extractEntities(text) {
  if (!text || typeof text !== 'string') {
    return { countries: [], actors: [], orgs: [], all: [] };
  }

  const countries = new Set();
  const actors = new Set();
  const orgs = new Set();

  // Match against each dictionary
  for (const { pattern, canonical } of COUNTRY_PATTERNS) {
    if (pattern.test(text)) countries.add(canonical);
  }
  for (const { pattern, canonical } of ACTOR_PATTERNS) {
    if (pattern.test(text)) actors.add(canonical);
  }
  for (const { pattern, canonical } of ORG_PATTERNS) {
    if (pattern.test(text)) orgs.add(canonical);
  }

  return applyWarningLists(text, {
    countries: [...countries],
    actors: [...actors],
    orgs: [...orgs],
    all: [...countries, ...actors, ...orgs],
  });
}
