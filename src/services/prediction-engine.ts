/**
 * Prediction Engine
 *
 * Evaluates the current dashboard state against predefined geopolitical
 * scenario templates.  Each scenario has 5 precursors; when at least 3
 * are met the scenario is surfaced as a prediction with a confidence
 * rating equal to the percentage of precursors satisfied.
 *
 * Usage:
 *   const predictions = evaluateScenarios(currentState);
 *   // Returns only scenarios that meet their minimum precursor threshold,
 *   // sorted highest confidence first.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Snapshot of the live dashboard fed into the prediction engine. */
export interface DashboardState {
  /** Country Instability Index scores keyed by ISO-2 country code */
  ciiScores: Record<string, number>;
  /** Regions where multiple signal types overlap geographically */
  convergenceZones: {
    region: string;
    score: number;
    signalTypes: string[];
  }[];
  /** Total military aircraft currently tracked */
  militaryFlightCount: number;
  /** Total naval vessels currently tracked */
  militaryVesselCount: number;
  /** Percentage change in oil price (positive = increase) */
  oilPriceChange: number;
  /** Percentage change in equity markets (negative = decline) */
  marketChange: number;
  /** Number of active internet outage events */
  activeOutages: number;
  /** Number of tracked protest / unrest events */
  protestCount: number;
  /** Recent headline strings for keyword matching */
  headlines: string[];
  /** Signal type labels currently active across all feeds */
  signalTypes: string[];
}

/** A single evaluated prediction produced by the engine. */
export interface Prediction {
  /** Unique identifier for the scenario template */
  scenarioId: string;
  /** Human-readable name */
  scenarioName: string;
  /** Confidence percentage (0-100), based on precursors met */
  confidence: number;
  /** Detail on each precursor and whether it was satisfied */
  precursorResults: { label: string; met: boolean }[];
  /** Number of precursors that evaluated to true */
  metCount: number;
  /** Total precursors in the scenario */
  totalCount: number;
  /** Short narrative explaining the scenario */
  description: string;
  /** Epoch-ms timestamp when this prediction was generated */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single precursor check: label + a function that inspects the state. */
interface Precursor {
  label: string;
  check: (state: DashboardState) => boolean;
}

/** Full scenario template used by the engine. */
interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  precursors: Precursor[];
  /** Minimum precursors that must be met before the scenario triggers */
  minPrecursors: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Case-insensitive headline search.
 * Returns true if ANY headline contains at least one of the keywords.
 */
function headlinesContainAny(headlines: string[], keywords: string[]): boolean {
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  return headlines.some(headline => {
    const lowerHeadline = headline.toLowerCase();
    return lowerKeywords.some(kw => lowerHeadline.includes(kw));
  });
}

/**
 * Returns the highest CII score among the given country codes.
 * Missing countries are treated as 0.
 */
function maxCiiForCountries(
  ciiScores: Record<string, number>,
  codes: string[],
): number {
  let highest = 0;
  for (const code of codes) {
    const score = ciiScores[code] ?? 0;
    if (score > highest) highest = score;
  }
  return highest;
}

/**
 * Returns the highest convergence-zone score whose region string
 * matches any of the provided keywords (case-insensitive).
 */
function maxConvergenceForRegion(
  zones: DashboardState['convergenceZones'],
  regionKeywords: string[],
): number {
  const lowerKeywords = regionKeywords.map(k => k.toLowerCase());
  let highest = 0;
  for (const zone of zones) {
    const lowerRegion = zone.region.toLowerCase();
    if (lowerKeywords.some(kw => lowerRegion.includes(kw))) {
      if (zone.score > highest) highest = zone.score;
    }
  }
  return highest;
}

// ---------------------------------------------------------------------------
// Scenario definitions (4 scenarios x 5 precursors, min 3 to trigger)
// ---------------------------------------------------------------------------

const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  // ---- 1. Strait of Hormuz Disruption ----
  {
    id: 'hormuz-disruption',
    name: 'Strait of Hormuz Disruption',
    description:
      'Rising naval activity and regional instability suggest a potential ' +
      'disruption to oil transit through the Strait of Hormuz, the world\'s ' +
      'most critical energy chokepoint.',
    minPrecursors: 3,
    precursors: [
      {
        label: 'Naval buildup detected (vessels > 5)',
        check: (state) => state.militaryVesselCount > 5,
      },
      {
        label: 'Oil price spike (> 2%)',
        check: (state) => state.oilPriceChange > 2,
      },
      {
        label: 'Hormuz / Houthi-related headlines',
        check: (state) =>
          headlinesContainAny(state.headlines, [
            'hormuz',
            'houthi',
            'strait of hormuz',
            'persian gulf blockade',
          ]),
      },
      {
        label: 'Regional CII > 70 (IR / YE / SA / AE)',
        check: (state) =>
          maxCiiForCountries(state.ciiScores, ['IR', 'YE', 'SA', 'AE']) > 70,
      },
      {
        label: 'Middle East convergence score > 50',
        check: (state) =>
          maxConvergenceForRegion(state.convergenceZones, [
            'middle east',
            'persian gulf',
            'hormuz',
            'arabian',
          ]) > 50,
      },
    ],
  },

  // ---- 2. Taiwan Strait Escalation ----
  {
    id: 'taiwan-escalation',
    name: 'Taiwan Strait Escalation',
    description:
      'Elevated military flight activity and diplomatic tension indicators ' +
      'point toward a potential escalation in the Taiwan Strait.',
    minPrecursors: 3,
    precursors: [
      {
        label: 'Military flights elevated (> 10)',
        check: (state) => state.militaryFlightCount > 10,
      },
      {
        label: 'Naval vessel presence (> 3)',
        check: (state) => state.militaryVesselCount > 3,
      },
      {
        label: 'CN / TW CII > 75',
        check: (state) =>
          maxCiiForCountries(state.ciiScores, ['CN', 'TW']) > 75,
      },
      {
        label: 'Taiwan diplomatic tension headlines',
        check: (state) =>
          headlinesContainAny(state.headlines, [
            'taiwan',
            'taipei',
            'one china',
            'taiwan strait',
            'pla exercises',
          ]),
      },
      {
        label: 'Internet outages elevated (> 2)',
        check: (state) => state.activeOutages > 2,
      },
    ],
  },

  // ---- 3. Market Correction ----
  {
    id: 'market-correction',
    name: 'Market Correction',
    description:
      'A combination of economic shocks, surging instability scores, and ' +
      'crisis-level news coverage signals a potential broad market correction.',
    minPrecursors: 3,
    precursors: [
      {
        label: 'Markets declining (> 1%)',
        check: (state) => state.marketChange < -1,
      },
      {
        label: 'Oil shock (> 5%)',
        check: (state) => state.oilPriceChange > 5,
      },
      {
        label: 'Multiple critical CII scores (> 80)',
        check: (state) => {
          // Count countries with CII above 80
          const criticalCount = Object.values(state.ciiScores).filter(
            (score) => score > 80,
          ).length;
          return criticalCount >= 2;
        },
      },
      {
        label: 'Crisis keywords in headlines',
        check: (state) =>
          headlinesContainAny(state.headlines, [
            'crisis',
            'crash',
            'recession',
            'panic',
            'sell-off',
            'contagion',
            'default',
            'collapse',
          ]),
      },
      {
        label: 'Convergence score > 70',
        check: (state) =>
          state.convergenceZones.some((zone) => zone.score > 70),
      },
    ],
  },

  // ---- 4. Cyber Escalation ----
  {
    id: 'cyber-escalation',
    name: 'Cyber Escalation',
    description:
      'A surge in internet outages alongside geopolitical tension and cyber ' +
      'attack reporting suggests a coordinated or retaliatory cyber campaign.',
    minPrecursors: 3,
    precursors: [
      {
        label: 'Outage spike (> 5 active)',
        check: (state) => state.activeOutages > 5,
      },
      {
        label: 'Geopolitical tension CII > 70',
        check: (state) => {
          // Any tracked country exceeding the tension threshold
          return Object.values(state.ciiScores).some(
            (score) => score > 70,
          );
        },
      },
      {
        label: 'Cyber attack headlines',
        check: (state) =>
          headlinesContainAny(state.headlines, [
            'cyber attack',
            'cyberattack',
            'ransomware',
            'hack',
            'data breach',
            'DDoS',
            'malware',
          ]),
      },
      {
        label: 'Diplomatic breakdown headlines',
        check: (state) =>
          headlinesContainAny(state.headlines, [
            'diplomatic',
            'sanctions',
            'expel ambassador',
            'sever ties',
            'recall ambassador',
            'diplomatic breakdown',
          ]),
      },
      {
        label: 'Military posture elevated (flights > 5 or vessels > 3)',
        check: (state) =>
          state.militaryFlightCount > 5 || state.militaryVesselCount > 3,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate every scenario against the current dashboard state.
 *
 * Only scenarios that meet their minPrecursors threshold are returned.
 * Results are sorted by confidence descending (highest risk first).
 */
export function evaluateScenarios(state: DashboardState): Prediction[] {
  const now = Date.now();
  const triggered: Prediction[] = [];

  for (const scenario of SCENARIO_TEMPLATES) {
    // Run each precursor check and record the result
    const precursorResults = scenario.precursors.map((precursor) => ({
      label: precursor.label,
      met: precursor.check(state),
    }));

    const metCount = precursorResults.filter((r) => r.met).length;
    const totalCount = scenario.precursors.length;

    // Only surface scenarios that meet the minimum threshold
    if (metCount >= scenario.minPrecursors) {
      const confidence = Math.round((metCount / totalCount) * 100);

      triggered.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        confidence,
        precursorResults,
        metCount,
        totalCount,
        description: scenario.description,
        timestamp: now,
      });
    }
  }

  // Highest confidence first
  return triggered.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Return the raw scenario definitions so the UI can render checklists
 * even before any precursors are met.
 */
export function getScenarioTemplates(): {
  id: string;
  name: string;
  description: string;
  precursorLabels: string[];
  minPrecursors: number;
}[] {
  return SCENARIO_TEMPLATES.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    precursorLabels: scenario.precursors.map((p) => p.label),
    minPrecursors: scenario.minPrecursors,
  }));
}
