/**
 * OSINT Intelligence Panel
 *
 * Surfaces all collected OSINT data in a single tabbed panel:
 *   - Reddit (top geopolitical posts + trending topics)
 *   - Telegram (public channel posts + trending topics)
 *   - Breaches (recent HIBP data breaches + top by impact)
 *   - Flight Anomalies (circling, squawks, altitude drops)
 *   - Dark Zones (vessels gone dark in sensitive maritime areas)
 *   - Cyber Geo (country-level threat aggregation from VT/AbuseIPDB)
 *
 * Each tab renders independently. Data is pushed from App.ts via
 * public update methods — the panel never fetches data itself.
 */

import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import { sanitizeUrl } from '@/utils/sanitize';
import { trendStore } from '@/services/trend-store';
import { renderSparklineSvg, getTrendColor, formatDelta } from '@/utils/sparkline';
import type { RedditPost, RedditIntel } from '@/services/osint/reddit';
import type { TelegramPost, TelegramChannelIntel } from '@/services/osint/telegram-channels';
import type { BreachStats, BreachInfo } from '@/services/osint/breach-monitor';
import type { FlightAnomaly } from '@/services/osint/flight-anomalies';
import type { DarkZoneAlert } from '@/services/osint/ais-dark-zones';
import type { ThreatGeoSummary } from '@/services/osint/virustotal-campaigns';

// ---------------------------------------------------------------------------
// Tab definitions — each tab maps to one OSINT data source
// ---------------------------------------------------------------------------

interface OsintTab {
  id: string;
  icon: string;
  label: string;
}

const TABS: OsintTab[] = [
  { id: 'reddit',    icon: '\u{1F4E1}', label: 'Reddit' },
  { id: 'telegram',  icon: '\u{2708}',  label: 'Telegram' },
  { id: 'breaches',  icon: '\u{1F512}', label: 'Breaches' },
  { id: 'flights',   icon: '\u{26A0}',  label: 'Flights' },
  { id: 'darkzones', icon: '\u{1F6A2}', label: 'Dark Zones' },
  { id: 'cybergeo',  icon: '\u{1F30D}', label: 'Cyber Geo' },
];

// ---------------------------------------------------------------------------
// Panel class
// ---------------------------------------------------------------------------

export class OsintIntelPanel extends Panel {
  private activeTab = 'reddit';
  private tabsEl: HTMLElement | null = null;

  // Stored data from App.ts — updated via public setters
  private redditIntel: RedditIntel | null = null;
  private telegramIntel: TelegramChannelIntel | null = null;
  private breachStats: BreachStats | null = null;
  private flightAnomalies: FlightAnomaly[] = [];
  private darkZoneAlerts: DarkZoneAlert[] = [];
  private cyberGeoSummary: ThreatGeoSummary[] = [];

  constructor() {
    super({
      id: 'osint-intel',
      title: 'OSINT Intelligence',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Aggregated open-source intelligence from Reddit, Telegram, HIBP breach monitor, flight anomaly detection, AIS dark zone tracking, and VirusTotal/AbuseIPDB cyber threat geo-mapping.',
    });
    this.createTabs();
    this.renderActiveTab();
  }

  // ---------------------------------------------------------------------------
  // Tab management
  // ---------------------------------------------------------------------------

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'osint-intel-tabs' },
      ...TABS.map(tab =>
        h('button', {
          className: `osint-intel-tab ${tab.id === this.activeTab ? 'active' : ''}`,
          dataset: { tabId: tab.id },
          onClick: () => this.selectTab(tab.id),
        },
          h('span', { className: 'tab-icon' }, tab.icon),
          h('span', { className: 'tab-label' }, tab.label),
        ),
      ),
    );

    // Insert tabs between header and content (same pattern as GdeltIntelPanel)
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTab(tabId: string): void {
    if (tabId === this.activeTab) return;
    this.activeTab = tabId;

    // Update active tab styling
    this.tabsEl?.querySelectorAll('.osint-intel-tab').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tabId === tabId);
    });

    this.renderActiveTab();
  }

  // ---------------------------------------------------------------------------
  // Public data setters — called from App.ts when data arrives
  // ---------------------------------------------------------------------------

  public setRedditIntel(intel: RedditIntel): void {
    this.redditIntel = intel;
    this.updateTotalCount();
    if (this.activeTab === 'reddit') this.renderActiveTab();
  }

  public setTelegramIntel(intel: TelegramChannelIntel): void {
    this.telegramIntel = intel;
    this.updateTotalCount();
    if (this.activeTab === 'telegram') this.renderActiveTab();
  }

  public setBreachStats(stats: BreachStats): void {
    this.breachStats = stats;
    this.updateTotalCount();
    if (this.activeTab === 'breaches') this.renderActiveTab();
  }

  public setFlightAnomalies(anomalies: FlightAnomaly[]): void {
    this.flightAnomalies = anomalies;
    this.updateTotalCount();
    if (this.activeTab === 'flights') this.renderActiveTab();
  }

  public setDarkZoneAlerts(alerts: DarkZoneAlert[]): void {
    this.darkZoneAlerts = alerts;
    this.updateTotalCount();
    if (this.activeTab === 'darkzones') this.renderActiveTab();
  }

  public setCyberGeoSummary(summary: ThreatGeoSummary[]): void {
    this.cyberGeoSummary = summary;
    this.updateTotalCount();
    if (this.activeTab === 'cybergeo') this.renderActiveTab();
  }

  // ---------------------------------------------------------------------------
  // Count badge — total items across all sources
  // ---------------------------------------------------------------------------

  private updateTotalCount(): void {
    const total =
      (this.redditIntel?.posts.length ?? 0) +
      (this.telegramIntel?.posts.length ?? 0) +
      (this.breachStats?.recentCount ?? 0) +
      this.flightAnomalies.length +
      this.darkZoneAlerts.length +
      this.cyberGeoSummary.length;
    this.setCount(total);
  }

  // ---------------------------------------------------------------------------
  // Sparkline trend bar — shows mini chart + delta for a metric key
  // ---------------------------------------------------------------------------

  /**
   * Build a compact trend bar: [label] [sparkline SVG] [+12.3%]
   * Shows trend over the last hour compared to the hour before that.
   */
  private buildTrendBar(label: string, trendKey: string): HTMLElement | null {
    const series = trendStore.getSeries(trendKey);
    if (series.length < 2) return null; // need at least 2 points for a trend

    const values = series.map(p => p.value);
    const delta = trendStore.getLatestDelta(trendKey, 60 * 60 * 1000); // 1-hour window
    const deltaText = delta ? formatDelta(delta.changePercent) : '';
    const deltaColor = delta ? getTrendColor(delta.changePercent) : 'var(--text-dim)';

    const bar = h('div', { className: 'osint-trend-bar' },
      h('span', { className: 'osint-trend-label' }, label),
    );

    // Safe innerHTML: renderSparklineSvg builds SVG entirely from numeric
    // values — no user-supplied strings are interpolated (see sparkline.ts)
    const sparkWrap = h('span', { className: 'sparkline-wrap' });
    sparkWrap.innerHTML = renderSparklineSvg(values, {
      width: 80, height: 20, color: deltaColor, showDot: true, showArea: true,
    });
    bar.appendChild(sparkWrap);

    if (deltaText) {
      bar.appendChild(h('span', {
        className: 'osint-trend-delta',
        style: `color: ${deltaColor}`,
      }, deltaText));
    }

    return bar;
  }

  // ---------------------------------------------------------------------------
  // Rendering — dispatches to the correct tab renderer
  // ---------------------------------------------------------------------------

  private renderActiveTab(): void {
    switch (this.activeTab) {
      case 'reddit':    this.renderReddit(); break;
      case 'telegram':  this.renderTelegram(); break;
      case 'breaches':  this.renderBreaches(); break;
      case 'flights':   this.renderFlights(); break;
      case 'darkzones': this.renderDarkZones(); break;
      case 'cybergeo':  this.renderCyberGeo(); break;
    }
  }

  // ---- Reddit tab ----

  private renderReddit(): void {
    if (!this.redditIntel || this.redditIntel.posts.length === 0) {
      replaceChildren(this.content, this.emptyState('No Reddit data yet'));
      return;
    }

    const { posts, trendingTopics } = this.redditIntel;
    const trendBar = this.buildTrendBar('Post volume', 'reddit-posts');
    replaceChildren(this.content,
      h('div', { className: 'osint-intel-list' },
        // Sparkline trend (shows after first few refreshes)
        trendBar,
        // Trending topics bar
        trendingTopics.length > 0
          ? h('div', { className: 'osint-trending' },
              h('span', { className: 'osint-trending-label' }, 'Trending:'),
              ...trendingTopics.slice(0, 6).map(topic =>
                h('span', { className: 'osint-trending-tag' }, topic),
              ),
            )
          : null,
        // Post list
        ...posts.map(post => this.buildRedditPost(post)),
      ),
    );
  }

  private buildRedditPost(post: RedditPost): HTMLElement {
    const age = this.timeAgo(post.createdUtc * 1000);
    return h('a', {
      href: sanitizeUrl(post.permalink),
      target: '_blank',
      rel: 'noopener',
      className: 'osint-intel-item',
    },
      h('div', { className: 'osint-item-header' },
        h('span', { className: 'osint-item-source' }, `r/${post.subreddit}`),
        h('span', { className: 'osint-item-meta' }, `${this.formatNumber(post.score)} pts \u00B7 ${age}`),
      ),
      h('div', { className: 'osint-item-title' }, post.title),
    );
  }

  // ---- Telegram tab ----

  private renderTelegram(): void {
    if (!this.telegramIntel || this.telegramIntel.posts.length === 0) {
      replaceChildren(this.content, this.emptyState('No Telegram data yet'));
      return;
    }

    const { posts, trendingTopics } = this.telegramIntel;
    const trendBar = this.buildTrendBar('Post volume', 'telegram-posts');
    replaceChildren(this.content,
      h('div', { className: 'osint-intel-list' },
        trendBar,
        trendingTopics.length > 0
          ? h('div', { className: 'osint-trending' },
              h('span', { className: 'osint-trending-label' }, 'Trending:'),
              ...trendingTopics.slice(0, 6).map(topic =>
                h('span', { className: 'osint-trending-tag' }, topic),
              ),
            )
          : null,
        ...posts.map(post => this.buildTelegramPost(post)),
      ),
    );
  }

  private buildTelegramPost(post: TelegramPost): HTMLElement {
    const age = this.timeAgo(post.timestamp);
    // Truncate long messages to 200 chars for the list view
    const preview = post.text.length > 200 ? post.text.slice(0, 200) + '\u2026' : post.text;

    return h('a', {
      href: sanitizeUrl(post.url),
      target: '_blank',
      rel: 'noopener',
      className: 'osint-intel-item',
    },
      h('div', { className: 'osint-item-header' },
        h('span', { className: 'osint-item-source' }, post.channel),
        h('span', { className: 'osint-item-meta' }, `${this.formatViews(post.views)} views \u00B7 ${age}`),
      ),
      h('div', { className: 'osint-item-title' }, preview),
    );
  }

  // ---- Breaches tab ----

  private renderBreaches(): void {
    if (!this.breachStats || this.breachStats.recentCount === 0) {
      replaceChildren(this.content, this.emptyState('No recent breaches detected'));
      return;
    }

    const { recentCount, totalPwned, topBreaches } = this.breachStats;
    const trendBar = this.buildTrendBar('Breach count', 'breaches');
    replaceChildren(this.content,
      h('div', { className: 'osint-intel-list' },
        trendBar,
        // Summary bar
        h('div', { className: 'osint-summary-bar' },
          h('div', { className: 'osint-stat' },
            h('span', { className: 'osint-stat-value' }, String(recentCount)),
            h('span', { className: 'osint-stat-label' }, 'Breaches (30d)'),
          ),
          h('div', { className: 'osint-stat' },
            h('span', { className: 'osint-stat-value' }, this.formatNumber(totalPwned)),
            h('span', { className: 'osint-stat-label' }, 'Accounts Exposed'),
          ),
        ),
        // Top breaches list
        ...topBreaches.map(breach => this.buildBreachItem(breach)),
      ),
    );
  }

  private buildBreachItem(breach: BreachInfo): HTMLElement {
    return h('div', { className: 'osint-intel-item osint-breach-item' },
      h('div', { className: 'osint-item-header' },
        h('span', { className: 'osint-item-source' }, breach.domain || breach.title),
        h('span', { className: 'osint-item-meta' }, breach.breachDate),
      ),
      h('div', { className: 'osint-item-title' },
        `${breach.title} \u2014 ${this.formatNumber(breach.pwnCount)} accounts`,
      ),
      h('div', { className: 'osint-item-detail' },
        breach.dataClasses.slice(0, 4).join(', '),
      ),
    );
  }

  // ---- Flight Anomalies tab ----

  private renderFlights(): void {
    if (this.flightAnomalies.length === 0) {
      replaceChildren(this.content, this.emptyState('No flight anomalies detected'));
      return;
    }

    const trendBar = this.buildTrendBar('Anomalies', 'flight-anomalies');
    replaceChildren(this.content,
      h('div', { className: 'osint-intel-list' },
        trendBar,
        ...this.flightAnomalies.map(anomaly => this.buildFlightItem(anomaly)),
      ),
    );
  }

  private buildFlightItem(anomaly: FlightAnomaly): HTMLElement {
    const severityClass = `osint-severity-${anomaly.severity}`;
    const age = this.timeAgo(anomaly.detectedAt);

    return h('div', { className: `osint-intel-item ${severityClass}` },
      h('div', { className: 'osint-item-header' },
        h('span', { className: 'osint-item-source' }, anomaly.callsign),
        h('span', { className: 'osint-item-meta' }, `${anomaly.type.replace('_', ' ')} \u00B7 ${age}`),
      ),
      h('div', { className: 'osint-item-title' }, anomaly.description),
      h('div', { className: 'osint-item-detail' },
        `${anomaly.lat.toFixed(2)}, ${anomaly.lon.toFixed(2)}`,
      ),
    );
  }

  // ---- Dark Zones tab ----

  private renderDarkZones(): void {
    if (this.darkZoneAlerts.length === 0) {
      replaceChildren(this.content, this.emptyState('No dark zone alerts'));
      return;
    }

    const trendBar = this.buildTrendBar('Dark vessels', 'dark-zones');
    replaceChildren(this.content,
      h('div', { className: 'osint-intel-list' },
        trendBar,
        ...this.darkZoneAlerts.map(alert => this.buildDarkZoneItem(alert)),
      ),
    );
  }

  private buildDarkZoneItem(alert: DarkZoneAlert): HTMLElement {
    const severityClass = `osint-severity-${alert.severity}`;
    const darkMinutes = Math.round(alert.darkDuration / 60_000);

    return h('div', { className: `osint-intel-item ${severityClass}` },
      h('div', { className: 'osint-item-header' },
        h('span', { className: 'osint-item-source' }, alert.vesselName),
        h('span', { className: 'osint-item-meta' }, `Dark ${darkMinutes}min`),
      ),
      h('div', { className: 'osint-item-title' },
        `Last seen near ${alert.zone}`,
      ),
      h('div', { className: 'osint-item-detail' },
        `MMSI: ${alert.mmsi} \u00B7 ${alert.lastLat.toFixed(2)}, ${alert.lastLon.toFixed(2)}`,
      ),
    );
  }

  // ---- Cyber Geo tab ----

  private renderCyberGeo(): void {
    if (this.cyberGeoSummary.length === 0) {
      replaceChildren(this.content, this.emptyState('No cyber threat geo data'));
      return;
    }

    const trendBar = this.buildTrendBar('Threat countries', 'cyber-threats-countries');
    replaceChildren(this.content,
      h('div', { className: 'osint-intel-list' },
        trendBar,
        ...this.cyberGeoSummary.map(geo => this.buildCyberGeoItem(geo)),
      ),
    );
  }

  private buildCyberGeoItem(geo: ThreatGeoSummary): HTMLElement {
    const severityClass = `osint-severity-${geo.severity}`;
    const malwareList = geo.topMalware.slice(0, 3).join(', ') || 'unknown';

    return h('div', { className: `osint-intel-item ${severityClass}` },
      h('div', { className: 'osint-item-header' },
        h('span', { className: 'osint-item-source' }, `${geo.countryName} (${geo.countryCode})`),
        h('span', { className: 'osint-item-meta' }, `${geo.threatCount} threats`),
      ),
      h('div', { className: 'osint-item-title' },
        `Severity: ${geo.severity} \u00B7 Confidence: ${geo.avgConfidence}%`,
      ),
      h('div', { className: 'osint-item-detail' },
        `Top malware: ${malwareList}`,
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private emptyState(message: string): HTMLElement {
    return h('div', { className: 'osint-empty-state' }, message);
  }

  /** Format epoch-ms timestamp as relative time (e.g. "5m ago", "2h ago") */
  private timeAgo(epochMs: number): string {
    const seconds = Math.floor((Date.now() - epochMs) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  /** Format large numbers with K/M suffixes */
  private formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  /** Format view counts (same logic, but for Telegram view counts) */
  private formatViews(views: number): string {
    return this.formatNumber(views);
  }
}
