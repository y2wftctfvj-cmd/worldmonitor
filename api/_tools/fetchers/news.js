/**
 * News Fetchers — headlines, wire services, military news, CISA, GDACS.
 *
 * All sources are free public APIs with no keys required.
 * Each function uses AbortSignal timeouts for safety.
 */

/** Government & wire service RSS feeds */
const GOV_FEEDS = [
  // Wire services — primary breaking news sources
  { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters World' },
  { url: 'https://www.state.gov/rss-feeds/press-releases/feed/', name: 'State Dept' },
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World' },
  { url: 'https://www.france24.com/en/rss', name: 'France24' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
  // Defense specialist — break military stories before mainstream
  { url: 'https://warontherocks.com/feed/', name: 'War on the Rocks' },
  { url: 'https://breakingdefense.com/feed/', name: 'Breaking Defense' },
  { url: 'https://www.thedrive.com/the-war-zone/feed', name: 'The War Zone' },
  // Alliance/institution feeds
  { url: 'https://www.nato.int/cps/en/natohq/news.htm', name: 'NATO' },
  // UN disaster coordination — earthquakes, tsunamis, floods, cyclones
  { url: 'https://www.gdacs.org/xml/rss.xml', name: 'GDACS' },
];

const HEADLINE_SOURCE_ALLOWLIST = new Set([
  'reuters',
  'associated press',
  'ap news',
  'bbc news',
  'bbc',
  'cbs news',
  'nbc news',
  'abc news',
  'cnn',
  'bloomberg',
  'financial times',
  'the wall street journal',
  'wall street journal',
  'the new york times',
  'new york times',
  'the washington post',
  'washington post',
  'politico',
  'axios',
  'the guardian',
  'guardian',
  'al jazeera english',
  'al jazeera',
  'france 24',
  'dw',
  'sky news',
  'npr',
  'fox news',
]);

// ---------------------------------------------------------------------------
// RSS XML parsing helpers
// ---------------------------------------------------------------------------
const TITLE_PATTERN = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
const DATE_PATTERN = /<pubDate>(.*?)<\/pubDate>/;
const LINK_PATTERN = /<link>(.*?)<\/link>/;

export function normalizeHeadlineSourceName(source) {
  return String(source || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

export function isAllowlistedHeadlineSource(source) {
  return HEADLINE_SOURCE_ALLOWLIST.has(normalizeHeadlineSourceName(source));
}

export function parseGoogleNewsHeadline(rawTitle) {
  const value = String(rawTitle || '').trim();
  const separator = value.lastIndexOf(' - ');
  if (separator <= 0) {
    return { title: value, source: '' };
  }

  return {
    title: value.slice(0, separator).trim(),
    source: value.slice(separator + 3).trim(),
  };
}

/** Parse GDELT date format ("20260223T143000Z") into a Date object */
function parseGdeltDate(dateStr) {
  if (!dateStr) return null;
  try {
    const isoAttempt = new Date(dateStr);
    if (!isNaN(isoAttempt.getTime())) return isoAttempt;

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

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch 10 recent headlines from Google News RSS (World topic).
 * Free, no key, always available.
 */
export async function fetchGoogleNewsHeadlines() {
  const rssUrl =
    'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en';

  try {
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;

    const xml = await resp.text();
    const items = [];
    const seenTitles = new Set();
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 10) {
      const titleMatch = itemMatch[0].match(TITLE_PATTERN);
      const rawTitle = titleMatch?.[1] || titleMatch?.[2];
      if (!rawTitle) continue;

      const parsed = parseGoogleNewsHeadline(rawTitle);
      if (parsed.source && !isAllowlistedHeadlineSource(parsed.source)) continue;

      const dedupeKey = parsed.title.toLowerCase();
      if (!parsed.title || seenTitles.has(dedupeKey)) continue;
      seenTitles.add(dedupeKey);
      items.push(parsed.source ? `${parsed.title} - ${parsed.source}` : parsed.title);
    }

    if (items.length === 0) return null;
    return items.map((t) => `- ${t}`).join('\n');
  } catch {
    return null;
  }
}

/**
 * Search Google News for topic-specific results.
 */
export async function fetchTopicNews(query) {
  if (!query || query.length < 3) return null;

  const stopWords = new Set([
    'what', 'whats', 'how', 'why', 'when', 'where', 'who', 'is', 'are', 'was', 'were',
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'about', 'from',
    'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'has', 'have', 'had',
    'tell', 'me', 'us', 'your', 'my', 'this', 'that', 'it', 'its', 'and', 'or', 'but',
    'current', 'latest', 'today', 'now', 'going', 'happening', 'update', 'status',
    'threat', 'level', 'situation', 'analysis', 'brief', 'report',
  ]);

  const keywords = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return null;

  const searchTerms = keywords.slice(0, 3).join('+');
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchTerms)}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;

    const xml = await resp.text();
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 5) {
      const titleMatch = itemMatch[0].match(TITLE_PATTERN);
      const dateMatch = itemMatch[0].match(DATE_PATTERN);
      const title = titleMatch?.[1] || titleMatch?.[2];
      const pubDate = dateMatch?.[1] || '';
      if (title) items.push(`- ${title}${pubDate ? ` (${pubDate})` : ''}`);
    }

    if (items.length === 0) return null;
    return `Search: "${keywords.join(' ')}"\n${items.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Fetch military-related news velocity from GDELT.
 * Returns article count and sample titles.
 */
export async function fetchMilitaryNews() {
  try {
    const query = '(military OR troops OR deployment OR mobilization OR "carrier strike" OR "fighter jets" OR airspace)';
    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=30&format=json&sort=datedesc`;
    const resp = await fetch(gdeltUrl, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return { count: 0, articles: [] };

    const data = await resp.json();
    const articles = data?.articles || [];
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    // Count recent articles and collect titles
    let recentCount = 0;
    const recentTitles = [];
    for (const article of articles) {
      const articleDate = parseGdeltDate(article.seendate);
      if (articleDate && articleDate.getTime() > twoHoursAgo) {
        recentCount++;
        if (recentTitles.length < 5) {
          recentTitles.push((article.title || 'Untitled').substring(0, 100));
        }
      }
    }

    return { count: recentCount, articles: recentTitles };
  } catch {
    return { count: 0, articles: [] };
  }
}

/**
 * Fetch headlines from government & wire service RSS feeds.
 * Returns array of { source, title, link, publishedAt, date } objects.
 */
export async function fetchGovFeeds() {
  const results = await Promise.allSettled(
    GOV_FEEDS.map(async (feed) => {
      try {
        const resp = await fetch(feed.url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return [];

        const xml = await resp.text();
        const items = [];
        const itemPattern = /<item>[\s\S]*?<\/item>/g;
        let itemMatch;
        while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 3) {
          const titleMatch = itemMatch[0].match(TITLE_PATTERN);
          const linkMatch = itemMatch[0].match(LINK_PATTERN);
          const dateMatch = itemMatch[0].match(DATE_PATTERN);
          const title = titleMatch?.[1] || titleMatch?.[2];
          if (title) {
            const publishedAt = dateMatch?.[1] || '';
            items.push({
              source: feed.name,
              title,
              link: linkMatch?.[1] || '',
              publishedAt,
              date: publishedAt,
            });
          }
        }
        return items;
      } catch {
        return [];
      }
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

/**
 * Fetch recent CISA cybersecurity advisories via RSS.
 * Returns array of { source, title, link, date } — top 5 items.
 * Free, no key needed. Authoritative US government source.
 */
export async function fetchCISAAlerts() {
  try {
    const resp = await fetch('https://www.cisa.gov/cybersecurity-advisories/all.xml', {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];

    const xml = await resp.text();
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    let itemMatch;

    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 5) {
      const titleMatch = itemMatch[0].match(TITLE_PATTERN);
      const linkMatch = itemMatch[0].match(LINK_PATTERN);
      const dateMatch = itemMatch[0].match(DATE_PATTERN);
      const title = titleMatch?.[1] || titleMatch?.[2];
      if (title) {
        items.push({
          source: 'CISA',
          title,
          link: linkMatch?.[1] || '',
          date: dateMatch?.[1] || '',
        });
      }
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * Fetch GDACS disaster alerts with enhanced GeoRSS parsing.
 * Returns array of { title, alertLevel, eventType, severity, lat, lon, source }.
 * Only returns Orange and Red alerts (skips Green).
 */
export async function fetchGDACSAlerts() {
  try {
    const resp = await fetch('https://www.gdacs.org/xml/rss_24h.xml', {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];

    const xml = await resp.text();
    const items = [];
    const itemPattern = /<item>[\s\S]*?<\/item>/g;
    const alertLevelPattern = /gdacs:alertlevel[^>]*>(.*?)</i;
    const severityPattern = /gdacs:severity[^>]*>(.*?)</i;
    const eventTypePattern = /gdacs:eventtype[^>]*>(.*?)</i;
    const latPattern = /geo:lat[^>]*>([\d.\-]+)</i;
    const lonPattern = /geo:long?[^>]*>([\d.\-]+)</i;
    let itemMatch;

    while ((itemMatch = itemPattern.exec(xml)) !== null && items.length < 10) {
      const block = itemMatch[0];
      const titleMatch = block.match(TITLE_PATTERN);
      const title = titleMatch?.[1] || titleMatch?.[2];
      if (!title) continue;

      // Parse GDACS-specific fields
      const alertLevel = block.match(alertLevelPattern)?.[1]?.trim() || 'Unknown';
      const severity = block.match(severityPattern)?.[1]?.trim() || '';
      const eventType = block.match(eventTypePattern)?.[1]?.trim() || '';
      const lat = parseFloat(block.match(latPattern)?.[1] || '0');
      const lon = parseFloat(block.match(lonPattern)?.[1] || '0');

      // Only Orange and Red alerts — skip Green (routine)
      const level = alertLevel.toLowerCase();
      if (level === 'green') continue;

      items.push({
        title,
        alertLevel,
        eventType,
        severity,
        lat,
        lon,
        source: 'GDACS',
      });
    }

    return items;
  } catch {
    return [];
  }
}
