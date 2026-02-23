/**
 * Focus Modes — preset views that filter the dashboard to relevant panels.
 *
 * Why: With 48 panels the dashboard is overwhelming. Focus modes let users
 * pick a "lens" (Crisis, Markets, Tech, Overview) so only the panels they
 * care about right now are visible.
 *
 * How it works:
 *   1. Each mode lists the panel keys it wants to show.
 *   2. When a mode is active, only those panels are visible.
 *   3. "All" mode shows every panel (original behaviour).
 *   4. The active mode is persisted in localStorage.
 */

export interface FocusMode {
  /** Unique key stored in localStorage */
  id: string;
  /** Display name shown in the selector */
  label: string;
  /** Short icon/emoji for the pill button */
  icon: string;
  /** Panel keys to show. Empty array = show ALL panels (no filter). */
  panels: string[];
}

// -- Mode Definitions ---------------------------------------------------

/** Overview: top-level situational awareness — the "front page" */
const OVERVIEW: FocusMode = {
  id: 'overview',
  label: 'Overview',
  icon: '🌐',
  panels: [
    'map',
    'live-news',
    'live-webcams',
    'insights',
    'strategic-posture',
    'cii',
    'strategic-risk',
    'markets',
    'commodities',
    'economic',
    'polymarket',
  ],
};

/** Crisis: conflict, intel, instability — "what's on fire?" */
const CRISIS: FocusMode = {
  id: 'crisis',
  label: 'Crisis',
  icon: '🔴',
  panels: [
    'map',
    'live-news',
    'insights',
    'strategic-posture',
    'cii',
    'strategic-risk',
    'intel',
    'gdelt-intel',
    'cascade',
    'middleeast',
    'africa',
    'latam',
    'asia',
    'ucdp-events',
    'displacement',
    'satellite-fires',
    'population-exposure',
    'climate',
  ],
};

/** Markets: financial data, commodities, crypto — "show me the money" */
const MARKETS_MODE: FocusMode = {
  id: 'markets-mode',
  label: 'Markets',
  icon: '📈',
  panels: [
    'map',
    'live-news',
    'insights',
    'markets',
    'commodities',
    'economic',
    'finance',
    'heatmap',
    'crypto',
    'macro-signals',
    'etf-flows',
    'stablecoins',
    'polymarket',
    'energy',
    'monitors',
  ],
};

/** Tech: AI, startups, cybersecurity, dev community */
const TECH_MODE: FocusMode = {
  id: 'tech-mode',
  label: 'Tech',
  icon: '💻',
  panels: [
    'map',
    'live-news',
    'insights',
    'tech',
    'ai',
    'crypto',
    'layoffs',
    'monitors',
  ],
};

/** Geopolitics: regional news, government, think tanks, energy */
const GEOPOLITICS: FocusMode = {
  id: 'geopolitics',
  label: 'Geopolitics',
  icon: '🏛️',
  panels: [
    'map',
    'live-news',
    'insights',
    'strategic-posture',
    'cii',
    'strategic-risk',
    'intel',
    'gdelt-intel',
    'politics',
    'middleeast',
    'africa',
    'latam',
    'asia',
    'energy',
    'gov',
    'thinktanks',
    'polymarket',
  ],
};

/** All: shows every panel — the original default behaviour */
const ALL: FocusMode = {
  id: 'all',
  label: 'All',
  icon: '⊞',
  panels: [], // empty = no filter, show everything
};

// -- Exports ------------------------------------------------------------

/** Ordered list of all available focus modes */
export const FOCUS_MODES: FocusMode[] = [
  OVERVIEW,
  CRISIS,
  MARKETS_MODE,
  TECH_MODE,
  GEOPOLITICS,
  ALL,
];

/** Default mode for first-time users */
export const DEFAULT_FOCUS_MODE = 'overview';

/** localStorage key for persisting the selected mode */
export const FOCUS_MODE_STORAGE_KEY = 'worldmonitor-focus-mode';

/**
 * Returns the panel keys that should be visible for a given mode.
 * If the mode has an empty panels array (like "All"), returns null
 * meaning "don't filter — show whatever panelSettings says".
 */
export function getPanelsForMode(modeId: string): string[] | null {
  const mode = FOCUS_MODES.find((m) => m.id === modeId);
  if (!mode || mode.panels.length === 0) return null;
  return mode.panels;
}
