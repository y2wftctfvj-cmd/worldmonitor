/**
 * Smart Monitor Check Cron — runs every 15 minutes via Vercel Cron.
 *
 * Checks for threshold breaches (market moves, crisis news, earthquakes,
 * internet outages, military news velocity) and sends deduplicated Telegram
 * alerts. Uses Upstash Redis to prevent repeat notifications within a 1-hour
 * window.
 *
 * Data sources:
 *   - Finnhub: SPY, QQQ, GLD, USO quotes for market move detection
 *   - GDELT: Crisis news + military news velocity
 *   - USGS: Significant earthquakes
 *   - Cloudflare Radar: Internet outages
 *
 * Env vars required:
 *   CRON_SECRET              — Vercel cron auth secret
 *   TELEGRAM_BOT_TOKEN       — Telegram bot token (from @BotFather)
 *   TELEGRAM_CHAT_ID         — Numeric chat ID for alerts
 *   FINNHUB_API_KEY          — Finnhub API key for stock quotes
 *   UPSTASH_REDIS_REST_URL   — Upstash Redis REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN — Upstash Redis auth token
 *   CLOUDFLARE_RADAR_TOKEN   — Cloudflare Radar API token for outage data
 */

export const config = { runtime: 'edge' };

// ---------------------------------------------------------------------------
// Thresholds — tweak these to control alert sensitivity
// ---------------------------------------------------------------------------
const THRESHOLDS = {
  marketMove: 3,            // Daily % change to trigger warning alert
  marketCritical: 5,        // Daily % change to trigger critical alert
  earthquakeMag: 6.0,       // Minimum magnitude for earthquake warning
  earthquakeCritical: 7.0,  // Minimum magnitude for earthquake critical
  militaryArticles: 20,     // Article count in 2h to trigger warning
  militaryCritical: 40,     // Article count in 2h to trigger critical
};

// ---------------------------------------------------------------------------
// Market symbols to monitor — each checked in parallel via Finnhub
// ---------------------------------------------------------------------------
const MARKET_SYMBOLS = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'Nasdaq 100' },
  { symbol: 'GLD', label: 'Gold' },
  { symbol: 'USO', label: 'Oil' },
];

// Max age (in milliseconds) for a GDELT article to be considered "breaking"
const MAX_ARTICLE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(request) {
  // Verify cron secret — Vercel sends this header on scheduled invocations.
  // Block if secret is missing OR if the header doesn't match (prevents
  // open-access when CRON_SECRET is accidentally unset in env vars).
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check that Telegram is configured; skip gracefully if not
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return new Response(JSON.stringify({ skipped: true, reason: 'Telegram not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Redis config for deduplication
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Collect alerts from all check functions
  const alerts = [];

  // --- Market move check (SPY via Finnhub) ---
  try {
    const marketAlerts = await checkMarketMoves(redisUrl, redisToken);
    alerts.push(...marketAlerts);
  } catch (err) {
    console.error('[monitor-check] Market check failed:', err);
  }

  // --- Crisis news check (GDELT) ---
  try {
    const crisisAlerts = await checkCrisisNews(redisUrl, redisToken);
    alerts.push(...crisisAlerts);
  } catch (err) {
    console.error('[monitor-check] Crisis news check failed:', err);
  }

  // --- Earthquake check (USGS) ---
  try {
    const earthquakeAlerts = await checkEarthquakes(redisUrl, redisToken);
    alerts.push(...earthquakeAlerts);
  } catch (err) {
    console.error('[monitor-check] Earthquake check failed:', err);
  }

  // --- Internet outage check (Cloudflare Radar) ---
  try {
    const outageAlerts = await checkInternetOutages(redisUrl, redisToken);
    alerts.push(...outageAlerts);
  } catch (err) {
    console.error('[monitor-check] Internet outage check failed:', err);
  }

  // --- Military news velocity check (GDELT) ---
  try {
    const militaryAlerts = await checkMilitaryVelocity(redisUrl, redisToken);
    alerts.push(...militaryAlerts);
  } catch (err) {
    console.error('[monitor-check] Military velocity check failed:', err);
  }

  // Send each new alert to Telegram
  let sentCount = 0;
  for (const alert of alerts) {
    try {
      await sendTelegramAlert(botToken, chatId, alert);
      sentCount++;
    } catch (err) {
      console.error('[monitor-check] Failed to send alert:', err);
    }
  }

  return new Response(JSON.stringify({ ok: true, alerts: sentCount }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// checkMarketMoves — fetch quotes for all MARKET_SYMBOLS from Finnhub in
// parallel, alert if |dp| > threshold for any of them
// ---------------------------------------------------------------------------
async function checkMarketMoves(redisUrl, redisToken) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];

  const results = [];

  // Fetch all symbols in parallel — each with its own 5s timeout
  const fetchPromises = MARKET_SYMBOLS.map(({ symbol, label }) => {
    const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;
    return fetch(quoteUrl, { signal: AbortSignal.timeout(5000) })
      .then(async (resp) => {
        if (!resp.ok) {
          console.error(`[monitor-check] Finnhub quote error for ${symbol}:`, resp.status);
          return null;
        }
        const quote = await resp.json();
        return { symbol, label, quote };
      });
  });

  const settled = await Promise.allSettled(fetchPromises);

  for (const result of settled) {
    // Skip failed or empty fetches
    if (result.status !== 'fulfilled' || !result.value) continue;

    const { symbol, label, quote } = result.value;
    // dp = daily percent change from Finnhub
    const dailyPctChange = quote.dp;
    if (dailyPctChange === undefined || dailyPctChange === null) continue;

    const absChange = Math.abs(dailyPctChange);

    // Only alert if move exceeds our threshold
    if (absChange > THRESHOLDS.marketMove) {
      // Dedup key: one alert per hour per symbol
      const hourKey = Math.floor(Date.now() / 3600000);
      const dedupeKey = `market-${symbol.toLowerCase()}-${hourKey}`;

      // Skip if we already alerted for this symbol this hour
      if (await isRecentlyAlerted(redisUrl, redisToken, dedupeKey)) continue;

      // Determine severity: >5% is critical, otherwise warning
      const severity = absChange > THRESHOLDS.marketCritical ? 'critical' : 'warning';
      const direction = dailyPctChange > 0 ? 'up' : 'down';

      results.push({
        severity,
        title: `${symbol} ${direction} ${absChange.toFixed(2)}%`,
        body: `${label} moved ${direction} ${absChange.toFixed(2)}% today (current: $${quote.c?.toFixed(2) || 'N/A'})`,
      });

      // Mark as alerted so we don't repeat within the hour
      await markAlerted(redisUrl, redisToken, dedupeKey);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// checkCrisisNews — fetch from GDELT for crisis-related keywords
// ---------------------------------------------------------------------------
async function checkCrisisNews(redisUrl, redisToken) {
  const results = [];

  try {
    // GDELT DOC 2.0 API — search for crisis keywords, sorted by date
    const crisisQuery = '(war OR missile OR earthquake OR tsunami OR nuclear OR "cyber attack" OR sanctions OR coup OR assassination OR invasion OR blockade OR "martial law" OR airstrike)';
    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(crisisQuery)}&mode=artlist&maxrecords=10&format=json&sort=datedesc`;
    const resp = await fetch(gdeltUrl, { signal: AbortSignal.timeout(8000) });

    if (!resp.ok) {
      console.error('[monitor-check] GDELT API error:', resp.status);
      return [];
    }

    const data = await resp.json();
    const articles = data?.articles || [];
    const now = Date.now();

    for (const article of articles) {
      // Parse article date — GDELT uses "YYYYMMDDTHHmmssZ" format
      const articleDate = parseGdeltDate(article.seendate);
      if (!articleDate) continue;

      // Only consider articles less than 2 hours old
      const ageMs = now - articleDate.getTime();
      if (ageMs > MAX_ARTICLE_AGE_MS) continue;

      // Build a slug from the title for deduplication
      const titleSlug = slugify(article.title || 'untitled');
      const hourKey = Math.floor(now / 3600000);
      const dedupeKey = `crisis-${titleSlug}-${hourKey}`;

      // Skip if we already sent this one
      if (await isRecentlyAlerted(redisUrl, redisToken, dedupeKey)) continue;

      results.push({
        severity: 'warning',
        title: `Crisis News: ${(article.title || 'Unknown').substring(0, 100)}`,
        body: `Source: ${article.domain || 'unknown'}\n${article.url || ''}`,
      });

      // Mark as alerted
      await markAlerted(redisUrl, redisToken, dedupeKey);

      // Cap at 3 crisis alerts per cycle to avoid flooding
      if (results.length >= 3) break;
    }
  } catch (err) {
    console.error('[monitor-check] GDELT fetch error:', err);
  }

  return results;
}

// ---------------------------------------------------------------------------
// checkEarthquakes — fetch significant earthquakes from USGS in the last hour
// ---------------------------------------------------------------------------
async function checkEarthquakes(redisUrl, redisToken) {
  const results = [];
  try {
    const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson';
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    const features = data?.features || [];
    const hourKey = Math.floor(Date.now() / 3600000);

    for (const feature of features) {
      const { mag, place, url: quakeUrl } = feature.properties || {};
      if (!mag || mag < THRESHOLDS.earthquakeMag) continue;

      const dedupeKey = `earthquake-${feature.id}-${hourKey}`;
      if (await isRecentlyAlerted(redisUrl, redisToken, dedupeKey)) continue;

      const severity = mag >= THRESHOLDS.earthquakeCritical ? 'critical' : 'warning';
      results.push({
        severity,
        title: `M${mag.toFixed(1)} Earthquake — ${place || 'Unknown location'}`,
        body: quakeUrl || '',
      });
      await markAlerted(redisUrl, redisToken, dedupeKey);
    }
  } catch (err) {
    console.error('[monitor-check] Earthquake check failed:', err);
  }
  return results;
}

// ---------------------------------------------------------------------------
// checkInternetOutages — fetch country-level outages from Cloudflare Radar
// ---------------------------------------------------------------------------
async function checkInternetOutages(redisUrl, redisToken) {
  const token = process.env.CLOUDFLARE_RADAR_TOKEN;
  if (!token) return [];

  const results = [];
  try {
    const url = 'https://api.cloudflare.com/client/v4/radar/annotations/outages?limit=5&dateRange=1h';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const outages = data?.result?.annotations || [];
    const hourKey = Math.floor(Date.now() / 3600000);

    for (const outage of outages) {
      if (outage.scope !== 'country') continue;
      const country = outage.locations || outage.asName || 'Unknown';
      const dedupeKey = `outage-${country}-${hourKey}`;
      if (await isRecentlyAlerted(redisUrl, redisToken, dedupeKey)) continue;

      results.push({
        severity: 'warning',
        title: `Internet Outage — ${country}`,
        body: outage.description || `Country-level internet disruption detected in ${country}`,
      });
      await markAlerted(redisUrl, redisToken, dedupeKey);
    }
  } catch (err) {
    console.error('[monitor-check] Internet outage check failed:', err);
  }
  return results;
}

// ---------------------------------------------------------------------------
// checkMilitaryVelocity — detect spikes in military-related news via GDELT
// ---------------------------------------------------------------------------
async function checkMilitaryVelocity(redisUrl, redisToken) {
  const results = [];
  try {
    const militaryQuery = '(military OR troops OR deployment OR mobilization OR "carrier strike" OR "fighter jets" OR airspace)';
    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(militaryQuery)}&mode=artlist&maxrecords=50&format=json&sort=datedesc`;
    const resp = await fetch(gdeltUrl, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];

    const data = await resp.json();
    const articles = data?.articles || [];
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    // Count articles from last 2 hours
    let recentCount = 0;
    for (const article of articles) {
      const articleDate = parseGdeltDate(article.seendate);
      if (articleDate && articleDate.getTime() > twoHoursAgo) {
        recentCount++;
      }
    }

    if (recentCount >= THRESHOLDS.militaryArticles) {
      const hourKey = Math.floor(now / 3600000);
      const dedupeKey = `military-velocity-${hourKey}`;
      if (await isRecentlyAlerted(redisUrl, redisToken, dedupeKey)) return [];

      const severity = recentCount >= THRESHOLDS.militaryCritical ? 'critical' : 'warning';
      results.push({
        severity,
        title: `Elevated military news activity`,
        body: `${recentCount} military-related articles detected in the last 2 hours`,
      });
      await markAlerted(redisUrl, redisToken, dedupeKey);
    }
  } catch (err) {
    console.error('[monitor-check] Military velocity check failed:', err);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Deduplication helpers — Upstash Redis GET/SET with 1-hour TTL
// ---------------------------------------------------------------------------

/**
 * Check if a deduplication key was already set (meaning we already sent
 * this alert recently). Returns true if already alerted.
 */
async function isRecentlyAlerted(redisUrl, redisToken, key) {
  // If Redis isn't configured, skip dedup (allow all alerts through)
  if (!redisUrl || !redisToken) return false;

  try {
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    // Upstash returns { result: null } when key doesn't exist
    return data.result !== null;
  } catch {
    // On error, allow alert through (fail open)
    return false;
  }
}

/**
 * Mark a deduplication key as alerted with a 1-hour TTL.
 * Next check within that hour will skip this alert.
 */
async function markAlerted(redisUrl, redisToken, key) {
  if (!redisUrl || !redisToken) return;

  try {
    // SET key "1" EX 3600 — expires in 1 hour
    await fetch(`${redisUrl}/set/${encodeURIComponent(key)}/1/ex/3600`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Non-critical — worst case we send a duplicate alert
    console.error('[monitor-check] Redis SET failed for key:', key);
  }
}

// ---------------------------------------------------------------------------
// Telegram sending
// ---------------------------------------------------------------------------

/**
 * Send a single alert message to Telegram using MarkdownV2 formatting.
 */
async function sendTelegramAlert(botToken, chatId, alert) {
  // Severity emoji: critical = red circle, warning = yellow circle
  const emoji = alert.severity === 'critical' ? '\u{1F534}' : '\u{1F7E1}';
  const text = [
    `${emoji} *MONITOR ALERT*`,
    '',
    `*${escapeMarkdown(alert.title)}*`,
    escapeMarkdown(alert.body || ''),
    '',
    '_Monitoring continues\\._',
  ].join('\n');

  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error('[monitor-check] Telegram API error:', resp.status, errBody);
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Escape special characters for Telegram MarkdownV2.
 * Same implementation as telegram-alert.js for consistency.
 */
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Parse GDELT date format (e.g. "20260223T143000Z") into a Date object.
 * Returns null if parsing fails.
 */
function parseGdeltDate(dateStr) {
  if (!dateStr) return null;
  try {
    // GDELT sometimes uses "YYYYMMDDTHHMMSSZ" or ISO-like formats
    // Try ISO parse first, then manual extraction
    const isoAttempt = new Date(dateStr);
    if (!isNaN(isoAttempt.getTime())) return isoAttempt;

    // Manual parse: "20260223T143000Z"
    const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
    if (match) {
      const [, year, month, day, hour, min, sec] = match;
      return new Date(Date.UTC(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour), parseInt(min), parseInt(sec)
      ));
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Convert a title to a URL-safe slug for deduplication keys.
 * Keeps only alphanumeric chars and dashes, truncates to 50 chars.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with dashes
    .replace(/^-+|-+$/g, '')       // Trim leading/trailing dashes
    .substring(0, 50);             // Cap length for Redis key readability
}
