/**
 * MISP-style Warning Lists — filter false-positive entity matches.
 *
 * Three filtering layers + co-occurrence boost:
 *   A. Ambiguous entities — common English words that need context verification
 *   B. False-positive phrases — multi-word phrases that prove a match is wrong
 *   C. Common-word entities — short acronyms needing case-sensitive verification
 *   D. Co-occurrence boost — ambiguous entities validated by other confirmed entities
 */

// ---------------------------------------------------------------------------
// A. Countries/actors that are also common English words.
//    Each maps to context terms — at least one must co-occur for the match
//    to be valid (unless another validated entity co-occurs — see layer D).
// ---------------------------------------------------------------------------
const AMBIGUOUS_ENTITIES = new Map([
  ['Turkey', ['ankara', 'erdogan', 'nato', 'syria', 'military', 'kurdish', 'istanbul', 'lira', 'turkish']],
  ['Jordan', ['amman', 'middle east', 'king abdullah', 'west bank', 'jordanian', 'hashemite']],
  ['Georgia', ['tbilisi', 'caucasus', 'south ossetia', 'abkhazia', 'georgian']],
  ['Chile', ['santiago', 'south america', 'copper', 'chilean', 'andes']],
  ['Chad', ['ndjamena', 'sahel', 'africa', 'boko haram', 'chadian']],
  ['Niger', ['niamey', 'sahel', 'uranium', 'coup', 'nigerien']],
  ['Mali', ['bamako', 'sahel', 'wagner', 'malian', 'junta']],
  ['Panama', ['canal', 'latin america', 'darien', 'panamanian']],
  ['Cuba', ['havana', 'caribbean', 'castro', 'embargo', 'cuban']],
  ['Congo', ['kinshasa', 'brazzaville', 'drc', 'congolese', 'cobalt']],
  ['Modi', ['india', 'bjp', 'delhi', 'hindu', 'kashmir']],
]);

// ---------------------------------------------------------------------------
// B. Multi-word phrases that prove an entity match is wrong.
//    If the phrase appears in text, the associated entity is suppressed.
// ---------------------------------------------------------------------------
const FALSE_POSITIVE_PHRASES = [
  // Turkey (food) vs Turkey (country)
  { phrase: 'turkey breast', suppresses: 'Turkey' },
  { phrase: 'turkey dinner', suppresses: 'Turkey' },
  { phrase: 'turkey sandwich', suppresses: 'Turkey' },
  { phrase: 'turkey recipe', suppresses: 'Turkey' },
  { phrase: 'turkey day', suppresses: 'Turkey' },
  { phrase: 'turkey hunting', suppresses: 'Turkey' },
  { phrase: 'cold turkey', suppresses: 'Turkey' },
  // Jordan (person) vs Jordan (country)
  { phrase: 'michael jordan', suppresses: 'Jordan' },
  { phrase: 'jordan peterson', suppresses: 'Jordan' },
  { phrase: 'jordan brand', suppresses: 'Jordan' },
  { phrase: 'air jordan', suppresses: 'Jordan' },
  // Xi (Greek letter / fraternity) vs Xi Jinping
  { phrase: 'sigma xi', suppresses: 'Xi Jinping' },
  { phrase: 'xi chapter', suppresses: 'Xi Jinping' },
];

// ---------------------------------------------------------------------------
// C. Short acronyms needing case-sensitive verification in original text.
//    Key = canonical entity name from entity-dictionary.
//    Value = { short: case-sensitive regex, long: case-insensitive longer form }
//    Entity passes if EITHER pattern matches the original text.
// ---------------------------------------------------------------------------
const COMMON_WORD_ENTITIES = new Map([
  ['WHO', { short: /\bWHO\b/, long: /world health organization/i }],
  ['UN', { short: /\bUN\b/, long: /united nations/i }],
  ['EU', { short: /\bEU\b/, long: /european union/i }],
  ['United Kingdom', { short: /\bUK\b/, long: /united kingdom|britain/i }],
  ['Federal Reserve', { short: /\bFed\b|\bFED\b/, long: /federal reserve/i }],
  ['Xi Jinping', { short: /\bXi\b/, long: /xi jinping/i }],
]);

// ---------------------------------------------------------------------------
// Main filter function
// ---------------------------------------------------------------------------

/**
 * Apply warning-list filters to raw entity extraction results.
 *
 * Called at the end of extractEntities() to reduce false positives
 * without changing the function signature or return shape.
 *
 * @param {string} text - Original text that entities were extracted from
 * @param {{ countries: string[], actors: string[], orgs: string[], all: string[] }} rawEntities
 * @returns {{ countries: string[], actors: string[], orgs: string[], all: string[] }}
 */
export function applyWarningLists(text, rawEntities) {
  const textLower = text.toLowerCase();
  const suppressed = new Set();

  // Layer B: False-positive phrases (cheapest check, most decisive)
  for (const { phrase, suppresses } of FALSE_POSITIVE_PHRASES) {
    if (textLower.includes(phrase)) {
      suppressed.add(suppresses);
    }
  }

  // Layer C: Case-sensitive verification for short acronyms
  for (const [entity, patterns] of COMMON_WORD_ENTITIES) {
    if (!rawEntities.all.includes(entity)) continue;
    // Entity passes if either the short (case-sensitive) or long form matches
    if (!patterns.short.test(text) && !patterns.long.test(text)) {
      suppressed.add(entity);
    }
  }

  // Layer A: Ambiguous entities — need context terms or co-occurrence
  // Build set of non-ambiguous validated entities for co-occurrence boost (layer D)
  const validatedEntities = new Set(
    rawEntities.all.filter(e => !AMBIGUOUS_ENTITIES.has(e) && !suppressed.has(e))
  );

  for (const [entity, contextTerms] of AMBIGUOUS_ENTITIES) {
    if (!rawEntities.all.includes(entity)) continue;
    if (suppressed.has(entity)) continue;

    // Check if any context term appears in the text
    const hasContext = contextTerms.some(term => textLower.includes(term));

    // Layer D: Co-occurrence boost — another validated entity present?
    const hasCoOccurrence = validatedEntities.size > 0;

    if (!hasContext && !hasCoOccurrence) {
      suppressed.add(entity);
    }
  }

  // No entities suppressed — return original to avoid unnecessary allocations
  if (suppressed.size === 0) return rawEntities;

  // Filter all entity arrays
  const countries = rawEntities.countries.filter(e => !suppressed.has(e));
  const actors = rawEntities.actors.filter(e => !suppressed.has(e));
  const orgs = rawEntities.orgs.filter(e => !suppressed.has(e));

  return {
    countries,
    actors,
    orgs,
    all: [...countries, ...actors, ...orgs],
  };
}
