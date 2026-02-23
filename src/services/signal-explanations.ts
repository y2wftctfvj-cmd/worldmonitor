// ---------------------------------------------------------------------------
// signal-explanations.ts
// Plain-English names, explanations, and severity for each correlation signal
// type defined in analysis-core.ts. Used by the UI to show human-readable
// descriptions of detected signals.
// ---------------------------------------------------------------------------

import type { SignalType } from './analysis-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata that turns a raw signal type into something a human can read. */
export interface SignalExplanation {
  /** Short, plain-English label (e.g. "Insider Signal") */
  name: string;
  /** One-sentence explanation of what the signal means */
  explanation: string;
  /** How urgent / important this signal type typically is */
  severity: 'low' | 'medium' | 'high';
  /** Text icon prefix -- "[!]" high, "[~]" medium, "[i]" low */
  icon: string;
}

// ---------------------------------------------------------------------------
// Icon constants (text-only, no emoji)
// ---------------------------------------------------------------------------

const ICON_HIGH = '[!]';
const ICON_MEDIUM = '[~]';
const ICON_LOW = '[i]';

// ---------------------------------------------------------------------------
// Lookup map -- one entry per SignalType
// ---------------------------------------------------------------------------

export const SIGNAL_EXPLANATIONS: Record<SignalType, SignalExplanation> = {
  // --- HIGH severity -------------------------------------------------------

  prediction_leads_news: {
    name: 'Insider Signal',
    explanation:
      'Prediction markets shifted without news coverage -- possible early intelligence or insider activity',
    severity: 'high',
    icon: ICON_HIGH,
  },

  triangulation: {
    name: 'Triple Confirmation',
    explanation:
      'Wire, government, and intelligence sources all confirm -- maximum credibility signal',
    severity: 'high',
    icon: ICON_HIGH,
  },

  military_surge: {
    name: 'Military Surge',
    explanation:
      'Unusual spike in military air or naval activity in sensitive region',
    severity: 'high',
    icon: ICON_HIGH,
  },

  hotspot_escalation: {
    name: 'Escalation Alert',
    explanation:
      'Country instability score rising rapidly -- situation deteriorating',
    severity: 'high',
    icon: ICON_HIGH,
  },

  sector_cascade: {
    name: 'Sector Contagion',
    explanation:
      'Disruption spreading from one sector to others -- cascade effect detected',
    severity: 'high',
    icon: ICON_HIGH,
  },

  // --- MEDIUM severity -----------------------------------------------------

  convergence: {
    name: 'Multi-Source Convergence',
    explanation:
      'Same event confirmed by 3+ independent source types within 1 hour -- high confidence',
    severity: 'medium',
    icon: ICON_MEDIUM,
  },

  velocity_spike: {
    name: 'News Velocity Spike',
    explanation:
      'Topic coverage surged 3x above baseline -- media amplification or real escalation',
    severity: 'medium',
    icon: ICON_MEDIUM,
  },

  flow_drop: {
    name: 'Pipeline Disruption',
    explanation:
      'Energy infrastructure flow reduction detected -- supply impact likely',
    severity: 'medium',
    icon: ICON_MEDIUM,
  },

  flow_price_divergence: {
    name: 'Price-Supply Disconnect',
    explanation:
      'Energy prices rising without corresponding pipeline news -- hidden supply constraint',
    severity: 'medium',
    icon: ICON_MEDIUM,
  },

  silent_divergence: {
    name: 'Silent Divergence',
    explanation:
      'Markets moved significantly without any explainable news -- hidden catalyst suspected',
    severity: 'medium',
    icon: ICON_MEDIUM,
  },

  geo_convergence: {
    name: 'Geographic Hotspot',
    explanation:
      'Multiple signal types clustering in same geographic area',
    severity: 'medium',
    icon: ICON_MEDIUM,
  },

  // --- LOW severity --------------------------------------------------------

  news_leads_markets: {
    name: 'News-Driven Move',
    explanation:
      'Markets responded to breaking news coverage within minutes',
    severity: 'low',
    icon: ICON_LOW,
  },

  keyword_spike: {
    name: 'Keyword Surge',
    explanation:
      'Specific keywords appeared across multiple sources simultaneously',
    severity: 'low',
    icon: ICON_LOW,
  },

  explained_market_move: {
    name: 'Explained Move',
    explanation:
      'Market shift has clear news catalyst -- correlation confirmed',
    severity: 'low',
    icon: ICON_LOW,
  },
} as const;

// ---------------------------------------------------------------------------
// Generic fallback for unrecognised signal types
// ---------------------------------------------------------------------------

const FALLBACK_EXPLANATION: SignalExplanation = {
  name: 'Unknown Signal',
  explanation: 'Signal type not yet catalogued -- review raw data for context',
  severity: 'low',
  icon: ICON_LOW,
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Return the explanation for a signal type, or a generic fallback if the
 * type is not in the lookup map.
 */
export function getSignalExplanation(type: string): SignalExplanation {
  const key = type as SignalType;
  return SIGNAL_EXPLANATIONS[key] ?? { ...FALLBACK_EXPLANATION };
}

/**
 * Build a formatted, human-readable alert string.
 *
 * Example output:
 *   "[!] Military Surge -- Red Sea: military vessels, shipping disruption,
 *    oil spike, Houthi news"
 */
export function formatSignalAlert(type: string, details: string): string {
  const { icon, name } = getSignalExplanation(type);
  return `${icon} ${name} -- ${details}`;
}
