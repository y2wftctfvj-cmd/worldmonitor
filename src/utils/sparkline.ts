/**
 * Reusable sparkline rendering utilities for dashboard panels.
 * Vanilla TypeScript — only depends on h() from dom-utils.
 */
import { h } from '@/utils/dom-utils';

// -- Types ------------------------------------------------------------------

export interface SparklineOptions {
  width?: number;       // SVG width in px (default 120)
  height?: number;      // SVG height in px (default 28)
  color?: string;       // Stroke/fill CSS color (default 'var(--accent)')
  fillOpacity?: number; // Area fill opacity (default 0.1)
  strokeWidth?: number; // Line thickness (default 1.5)
  showDot?: boolean;    // Dot on last point (default true)
  showArea?: boolean;   // Gradient area under curve (default true)
}

const DEFAULTS: Required<SparklineOptions> = {
  width: 120, height: 28, color: 'var(--accent)',
  fillOpacity: 0.1, strokeWidth: 1.5, showDot: true, showArea: true,
};

// -- Internal: numeric data → SVG polyline points string --------------------

function toPoints(data: number[], w: number, h: number): string {
  const min = Math.min(...data);
  const range = Math.max(...data) - min || 1; // 1 prevents div-by-zero on flat data
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  return data
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * (h - 2) - 1; // 1px padding top & bottom
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

// -- Public: SVG string -----------------------------------------------------

/**
 * Build an innerHTML-safe SVG sparkline string from numeric data.
 *
 * Edge cases:
 *  - empty array  → blank SVG placeholder
 *  - single value → horizontal line at midpoint
 *  - flat data    → horizontal line (range normalised to 1)
 *
 * The SVG is constructed entirely from numeric values — no user-supplied
 * strings are interpolated, so innerHTML assignment is safe.
 */
export function renderSparklineSvg(data: number[], options?: SparklineOptions): string {
  const o = { ...DEFAULTS, ...options };
  const { width: w, height: ht, color, fillOpacity, strokeWidth, showDot, showArea } = o;

  if (!data || data.length === 0) {
    return `<svg width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}"></svg>`;
  }

  // Single point — duplicate to form a flat line
  const series: number[] = data.length === 1 ? [data[0]!, data[0]!] : data;
  const pts = toPoints(series, w, ht);

  // Unique gradient ID so multiple sparklines on one page don't collide
  const gid = `sp-${Math.random().toString(36).slice(2, 8)}`;

  const defs = showArea
    ? `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="${color}" stop-opacity="${fillOpacity}"/>` +
      `<stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`
    : '';

  const area = showArea
    ? `<polygon points="${pts} ${w},${ht} 0,${ht}" fill="url(#${gid})" stroke="none"/>`
    : '';

  const line = `<polyline points="${pts}" fill="none" stroke="${color}" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Last-point dot — parse final "x,y" pair from the points string
  const lastPair = pts.split(' ').pop() ?? '0,0';
  const [dx, dy] = lastPair.split(',');
  const dot = showDot
    ? `<circle cx="${dx}" cy="${dy}" r="${strokeWidth + 0.5}" fill="${color}" opacity="0.9"/>`
    : '';

  return `<svg width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}" class="sparkline">` +
    `${defs}${area}${line}${dot}</svg>`;
}

// -- Public: DOM element ----------------------------------------------------

/**
 * Return an HTMLElement (span.sparkline-wrap) containing the sparkline SVG.
 * Uses the project's h() builder for DOM creation.
 */
export function renderSparklineElement(data: number[], options?: SparklineOptions): HTMLElement {
  const wrapper = h('span', { className: 'sparkline-wrap' });
  wrapper.innerHTML = renderSparklineSvg(data, options); // safe: numeric SVG only
  return wrapper;
}

// -- Public: trend color ----------------------------------------------------

/**
 * CSS color for a percentage change (threat-monitor semantics):
 *   > +5%  → red   (more threats = bad)
 *   < -5%  → green (fewer threats = good)
 *   ±5%    → neutral
 *
 * For financial data where "up = good", negate the value before calling.
 */
export function getTrendColor(changePercent: number): string {
  if (changePercent > 5) return 'var(--semantic-critical)';
  if (changePercent < -5) return 'var(--semantic-normal)';
  return 'var(--text-dim)';
}

// -- Public: delta formatting -----------------------------------------------

/**
 * Format a percent change with sign: "+15.2%", "-3.8%", "0.0%", or "—" for NaN.
 */
export function formatDelta(changePercent: number): string {
  if (!Number.isFinite(changePercent)) return '\u2014';
  const fixed = changePercent.toFixed(1);
  return changePercent > 0 ? `+${fixed}%` : `${fixed}%`;
}
