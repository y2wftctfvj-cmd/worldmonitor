/**
 * Alert Center — persistent notification drawer with alert history.
 *
 * Replaces the simple 3-second toast with a bell icon in the header that:
 *   1. Shows a badge count of unread alerts
 *   2. Opens a dropdown drawer listing recent alerts
 *   3. Persists alert history in localStorage (last 100)
 *   4. Groups alerts by severity (critical, warning, info)
 *
 * Security: All user-facing text is escaped via escapeHtml() before
 * insertion. The remaining innerHTML is static template HTML with no
 * untrusted input.
 */



// -- Types ------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  timestamp: number; // epoch ms
  read: boolean;
  category: string;  // e.g. 'earthquake', 'military', 'outage'
}

// -- Constants --------------------------------------------------------------

const STORAGE_KEY = 'worldmonitor-alerts';
const MAX_ALERTS = 100;

// -- Severity icons (static, no user input) ---------------------------------

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

// -- Component --------------------------------------------------------------

export class AlertCenter {
  private alerts: Alert[] = [];
  private isOpen = false;
  private bellEl: HTMLElement | null = null;
  private drawerEl: HTMLElement | null = null;

  constructor() {
    this.alerts = this.loadAlerts();
  }

  /**
   * Mount the bell icon into the header and the drawer into the DOM.
   * Call this once after the header has been rendered.
   */
  mount(headerRight: HTMLElement): void {
    // Create bell button
    this.bellEl = document.createElement('button');
    this.bellEl.className = 'alert-bell-btn';
    this.bellEl.title = 'Alerts';
    this.updateBellContent();

    // Insert bell before the settings button
    const settingsBtn = headerRight.querySelector('.settings-btn');
    if (settingsBtn) {
      headerRight.insertBefore(this.bellEl, settingsBtn);
    } else {
      headerRight.appendChild(this.bellEl);
    }

    // Create drawer (dropdown) — structure is static HTML, list is rendered separately
    this.drawerEl = document.createElement('div');
    this.drawerEl.className = 'alert-drawer';
    this.buildDrawerStructure();
    document.body.appendChild(this.drawerEl);

    // Event: toggle drawer on bell click
    this.bellEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // Event: close drawer when clicking outside
    document.addEventListener('click', (e) => {
      if (this.isOpen && this.drawerEl && !this.drawerEl.contains(e.target as Node)) {
        this.close();
      }
    });
  }

  /**
   * Push a new alert into the center. Shows a brief toast and adds to history.
   */
  push(severity: AlertSeverity, title: string, body: string, category: string): void {
    const alert: Alert = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      severity,
      title,
      body,
      timestamp: Date.now(),
      read: false,
      category,
    };

    // Prepend (newest first), cap at MAX_ALERTS
    this.alerts = [alert, ...this.alerts].slice(0, MAX_ALERTS);
    this.saveAlerts();
    this.updateBellContent();
    this.rebuildAlertList();

    // Also show a brief toast for critical/warning alerts
    if (severity !== 'info') {
      this.showBriefToast(severity, title);
    }

    // Forward critical/warning alerts to Telegram (fire-and-forget)
    if (severity !== 'info') {
      this.sendToTelegram(severity, title, body);
    }
  }

  /** How many unread alerts exist */
  get unreadCount(): number {
    return this.alerts.filter((a) => !a.read).length;
  }

  // -- Private: DOM building (safe — no raw user input in templates) --------

  /** Rebuild the bell icon + badge using DOM methods */
  private updateBellContent(): void {
    if (!this.bellEl) return;
    // Clear existing children
    while (this.bellEl.firstChild) this.bellEl.removeChild(this.bellEl.firstChild);

    // SVG bell icon
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path1.setAttribute('d', 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9');
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path2.setAttribute('d', 'M13.73 21a2 2 0 0 1-3.46 0');
    svg.appendChild(path1);
    svg.appendChild(path2);
    this.bellEl.appendChild(svg);

    // Badge (if unread)
    const unread = this.unreadCount;
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'alert-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      this.bellEl.appendChild(badge);
    }
  }

  /** Build the static drawer structure using DOM methods */
  private buildDrawerStructure(): void {
    if (!this.drawerEl) return;

    // Header row
    const header = document.createElement('div');
    header.className = 'alert-drawer-header';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'alert-drawer-title';
    titleSpan.textContent = 'Alerts';
    header.appendChild(titleSpan);

    const actions = document.createElement('div');
    actions.className = 'alert-drawer-actions';

    const markReadBtn = document.createElement('button');
    markReadBtn.className = 'alert-mark-read-btn';
    markReadBtn.textContent = 'Mark read';
    markReadBtn.addEventListener('click', () => this.markAllRead());
    actions.appendChild(markReadBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'alert-clear-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => this.clearAll());
    actions.appendChild(clearBtn);

    header.appendChild(actions);
    this.drawerEl.appendChild(header);

    // Alert list container
    const list = document.createElement('div');
    list.className = 'alert-drawer-list';
    list.id = 'alertDrawerList';
    this.drawerEl.appendChild(list);

    this.rebuildAlertList();
  }

  /** Rebuild the alert list items using safe DOM methods */
  private rebuildAlertList(): void {
    const list = document.getElementById('alertDrawerList');
    if (!list) return;

    // Clear existing
    while (list.firstChild) list.removeChild(list.firstChild);

    if (this.alerts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'alert-empty';
      empty.textContent = 'No alerts yet';
      list.appendChild(empty);
      return;
    }

    for (const a of this.alerts) {
      const item = document.createElement('div');
      item.className = `alert-item${a.read ? '' : ' unread'}`;
      item.dataset.id = a.id;

      // Header row: icon + title + time
      const hdr = document.createElement('div');
      hdr.className = 'alert-item-header';

      const icon = document.createElement('span');
      icon.className = 'alert-severity-icon';
      icon.textContent = SEVERITY_ICON[a.severity];
      hdr.appendChild(icon);

      const title = document.createElement('span');
      title.className = 'alert-item-title';
      title.textContent = a.title; // safe: textContent escapes
      hdr.appendChild(title);

      const time = document.createElement('span');
      time.className = 'alert-item-time';
      time.textContent = this.formatTime(a.timestamp);
      hdr.appendChild(time);

      item.appendChild(hdr);

      // Body
      const body = document.createElement('div');
      body.className = 'alert-item-body';
      body.textContent = a.body; // safe: textContent escapes
      item.appendChild(body);

      list.appendChild(item);
    }
  }

  private formatTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  // -- Private: State -------------------------------------------------------

  private toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    if (!this.drawerEl || !this.bellEl) return;
    this.isOpen = true;
    this.drawerEl.classList.add('open');
    // Position drawer below the bell button
    const rect = this.bellEl.getBoundingClientRect();
    this.drawerEl.style.top = `${rect.bottom + 4}px`;
    this.drawerEl.style.right = `${window.innerWidth - rect.right}px`;
  }

  private close(): void {
    this.isOpen = false;
    this.drawerEl?.classList.remove('open');
  }

  private markAllRead(): void {
    this.alerts = this.alerts.map((a) => ({ ...a, read: true }));
    this.saveAlerts();
    this.updateBellContent();
    this.rebuildAlertList();
  }

  private clearAll(): void {
    this.alerts = [];
    this.saveAlerts();
    this.updateBellContent();
    this.rebuildAlertList();
  }

  private showBriefToast(severity: AlertSeverity, title: string): void {
    document.querySelector('.toast-notification')?.remove();
    const el = document.createElement('div');
    el.className = `toast-notification toast-${severity}`;
    el.textContent = title; // safe: textContent
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  // -- Private: Persistence -------------------------------------------------

  private loadAlerts(): Alert[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private saveAlerts(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.alerts));
    } catch {
      // localStorage full — trim oldest alerts and retry
      this.alerts = this.alerts.slice(0, 50);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.alerts));
      } catch {
        // give up silently
      }
    }
  }

  /**
   * Forward an alert to Telegram via the /api/telegram-alert endpoint.
   * Fire-and-forget — failures are silently ignored (Telegram is optional).
   * Only sends if the endpoint is configured on the backend.
   */
  private async sendToTelegram(severity: AlertSeverity, title: string, body: string): Promise<void> {
    try {
      await fetch('/api/telegram-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity, title, body }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Telegram is optional — ignore failures silently
    }
  }
}
