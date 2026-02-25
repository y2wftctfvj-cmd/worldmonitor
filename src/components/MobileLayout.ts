/**
 * MobileLayout — bottom tab bar + scrollable card list for mobile devices.
 *
 * Manages 5 tabs, each rendering a subset of the desktop panels in a
 * vertically-scrollable card list. Uses lightweight touch events for
 * pull-to-refresh.
 */

// Tab configuration — each tab shows a subset of panels
const MOBILE_TABS = [
  { id: 'map', label: 'Map', icon: '🗺️' },
  { id: 'news', label: 'News', icon: '📰' },
  { id: 'alerts', label: 'Alerts', icon: '🚨' },
  { id: 'osint', label: 'OSINT', icon: '🔍' },
  { id: 'markets', label: 'Markets', icon: '📈' },
] as const;

type MobileTabId = typeof MOBILE_TABS[number]['id'];

// Panels that belong to each tab (matched by panel ID / data-panel attribute)
const TAB_PANELS: Record<MobileTabId, string[]> = {
  map: [],  // Map tab uses the existing map-section, no extra panels
  news: ['live-news', 'gdelt-intel'],
  alerts: ['cii', 'cascade', 'strategic-risk'],
  osint: ['osint-intel'],
  markets: ['market', 'economic', 'crypto'],
};

export class MobileLayout {
  private container: HTMLElement;
  private activeTab: MobileTabId = 'map';
  private tabBar: HTMLElement | null = null;
  private contentArea: HTMLElement | null = null;
  private refreshIndicator: HTMLElement | null = null;
  private touchStartY = 0;
  private isPulling = false;
  private onRefresh: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Register a callback for pull-to-refresh.
   */
  public setRefreshHandler(handler: () => void): void {
    this.onRefresh = handler;
  }

  /**
   * Render the mobile layout — tab bar + content area.
   * Call this AFTER the desktop layout has already rendered, so we can
   * relocate panels into the mobile card list.
   */
  public mount(): void {
    this.renderTabBar();
    this.renderContentArea();
    this.switchTab(this.activeTab);
    this.setupPullToRefresh();
  }

  /** Build and inject the bottom tab bar */
  private renderTabBar(): void {
    this.tabBar = document.createElement('nav');
    this.tabBar.className = 'mobile-tab-bar';
    this.tabBar.innerHTML = MOBILE_TABS.map(
      (tab) =>
        `<button class="mobile-tab${tab.id === this.activeTab ? ' active' : ''}" data-tab="${tab.id}">
          <span class="mobile-tab-icon">${tab.icon}</span>
          <span class="mobile-tab-label">${tab.label}</span>
        </button>`
    ).join('');

    // Tab click handler
    this.tabBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
      if (!btn) return;
      const tabId = btn.dataset.tab as MobileTabId;
      if (tabId && tabId !== this.activeTab) {
        this.switchTab(tabId);
      }
    });

    document.body.appendChild(this.tabBar);
  }

  /** Create the scrollable content wrapper */
  private renderContentArea(): void {
    this.contentArea = document.createElement('div');
    this.contentArea.className = 'mobile-card-list';
    this.contentArea.id = 'mobileCardList';

    // Pull-to-refresh indicator
    this.refreshIndicator = document.createElement('div');
    this.refreshIndicator.className = 'mobile-refresh-indicator';
    this.refreshIndicator.textContent = 'Pull to refresh';
    this.contentArea.prepend(this.refreshIndicator);

    // Insert content area inside .main-content, after the map section.
    // The mobile CSS gives .main-content overflow:hidden but gives
    // .mobile-card-list its own overflow-y:auto so it scrolls independently.
    const mainContent = this.container.querySelector('.main-content');
    if (mainContent) {
      mainContent.appendChild(this.contentArea);
    } else {
      this.container.appendChild(this.contentArea);
    }
  }

  /** Switch to a tab — show/hide map + relocate panels */
  private switchTab(tabId: MobileTabId): void {
    this.activeTab = tabId;

    // Update tab bar active state
    this.tabBar?.querySelectorAll('.mobile-tab').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tabId);
    });

    // Show/hide map section
    const mapSection = this.container.querySelector('.map-section') as HTMLElement | null;
    if (mapSection) {
      mapSection.style.display = tabId === 'map' ? '' : 'none';
    }

    // Show/hide card list
    if (this.contentArea) {
      this.contentArea.style.display = tabId === 'map' ? 'none' : '';
    }

    // Move matching panels into card list
    if (tabId !== 'map' && this.contentArea) {
      // Clear existing panel cards (keep refresh indicator)
      const existing = this.contentArea.querySelectorAll('.panel');
      existing.forEach((el) => el.remove());

      const panelIds = TAB_PANELS[tabId] || [];
      const panelsGrid = this.container.querySelector('#panelsGrid');
      if (!panelsGrid) return;

      for (const panelId of panelIds) {
        const panel = panelsGrid.querySelector(`[data-panel="${panelId}"]`) as HTMLElement | null;
        if (panel) {
          // Clone the panel into mobile view (keep original in place for desktop)
          const clone = panel.cloneNode(true) as HTMLElement;
          clone.classList.add('mobile-card');
          this.contentArea.appendChild(clone);
        }
      }
    }
  }

  /** Lightweight pull-to-refresh via touch events */
  private setupPullToRefresh(): void {
    if (!this.contentArea) return;

    this.contentArea.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      if (touch && this.contentArea!.scrollTop === 0) {
        this.touchStartY = touch.clientY;
        this.isPulling = true;
      }
    }, { passive: true });

    this.contentArea.addEventListener('touchmove', (e) => {
      if (!this.isPulling) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dy = touch.clientY - this.touchStartY;
      if (dy > 0 && dy < 120 && this.refreshIndicator) {
        const progress = Math.min(dy / 60, 1);
        this.refreshIndicator.style.transform = `translateY(${dy * 0.5}px)`;
        this.refreshIndicator.style.opacity = String(progress);
        this.refreshIndicator.textContent = dy > 60 ? 'Release to refresh' : 'Pull to refresh';
      }
    }, { passive: true });

    this.contentArea.addEventListener('touchend', () => {
      if (!this.isPulling) return;
      this.isPulling = false;
      if (this.refreshIndicator) {
        const wasReady = this.refreshIndicator.textContent === 'Release to refresh';
        this.refreshIndicator.style.transform = '';
        this.refreshIndicator.style.opacity = '0';
        if (wasReady && this.onRefresh) {
          this.onRefresh();
        }
      }
    }, { passive: true });
  }

  /** Get the currently active tab */
  public getActiveTab(): MobileTabId {
    return this.activeTab;
  }

  /** Destroy and clean up */
  public destroy(): void {
    this.tabBar?.remove();
    this.contentArea?.remove();
    this.tabBar = null;
    this.contentArea = null;
  }
}
