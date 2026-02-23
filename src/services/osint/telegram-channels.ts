/**
 * Telegram Public Channel Monitor -- OSINT module
 *
 * Fetches the latest messages from public Telegram channels via their web
 * preview pages (t.me/s/channel_name). This approach works without a bot
 * token or admin access because Telegram serves recent messages as plain
 * HTML for search-engine indexing.
 *
 * Results are cached for 10 minutes to avoid hammering Telegram's servers.
 * Trending topics are extracted by tokenizing message text, counting word
 * frequency, and filtering out common stop words.
 */

import { STOP_WORDS } from '@/utils/analysis-constants';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Public Telegram channels to monitor for geopolitical intelligence.
 * Only channels with public web previews enabled (t.me/s/) are usable.
 * Channels that return 302 have disabled previews and must be replaced.
 */
const CHANNELS = [
  'intelslava',       // Intel Slava Z — conflict/geopolitical aggregator
  'militarysummary',  // Military Summary — battlefield analysis
  'RVvoenkor',        // Russian war correspondents — frontline reporting
  'breakingmash',     // Mash — Russian breaking news aggregator
  'legitimniy',       // Legitimniy — political/geopolitical commentary
  'usaperiodical',    // USA Periodical — US news from Eastern perspective
] as const;

/** Cache time-to-live: 10 minutes (avoids excessive Telegram requests) */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Timeout for each channel fetch (Telegram can be slow from some regions) */
const FETCH_TIMEOUT_MS = 8_000;

/** How many top posts to keep after merging all channels */
const TOP_POSTS_LIMIT = 30;

/** Maximum number of trending topic words to return */
const TRENDING_TOPICS_LIMIT = 10;

/** Minimum times a word must appear across messages to qualify as "trending" */
const TRENDING_MIN_OCCURRENCES = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Telegram channel post, normalized to the fields we care about */
export interface TelegramPost {
  channel: string;
  text: string;
  timestamp: number;
  url: string;
  views: number;
}

/** The full intelligence payload: top posts + trending topics + timestamp */
export interface TelegramChannelIntel {
  posts: TelegramPost[];
  trendingTopics: string[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/** Cached result -- null until first fetch, refreshed every CACHE_TTL_MS */
let cachedResult: TelegramChannelIntel | null = null;

/** Timestamp of the last successful fetch */
let cachedAt = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch geopolitical intelligence from public Telegram channels.
 *
 * Returns a cached result if it is still fresh (< 10 min old).
 * Otherwise, fetches all channels in parallel, merges and sorts
 * by timestamp descending, keeps the top 30, and extracts trending topics.
 */
export async function fetchTelegramChannelIntel(): Promise<TelegramChannelIntel> {
  // Return cache if it exists and has not expired
  const now = Date.now();
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  // Fetch all channels in parallel -- allSettled so one failure
  // does not kill the whole batch (some channels may be geo-blocked)
  const results = await Promise.allSettled(
    CHANNELS.map(name => fetchChannel(name))
  );

  // Collect posts from all successful fetches
  const allPosts: TelegramPost[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allPosts.push(...result.value);
    }
  }

  // Sort by timestamp descending (newest first) and keep the top N
  const topPosts = [...allPosts]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, TOP_POSTS_LIMIT);

  // Extract trending topics from the message texts
  const texts = topPosts.map(post => post.text);
  const trendingTopics = extractTrendingTopics(texts);

  // Build the intel payload and cache it
  const intel: TelegramChannelIntel = {
    posts: topPosts,
    trendingTopics,
    fetchedAt: now,
  };

  cachedResult = intel;
  cachedAt = now;

  return intel;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Fetch recent posts from a single public Telegram channel.
 *
 * Uses Telegram's web preview page (t.me/s/channel_name), which serves
 * the latest ~20 messages as HTML. We parse the HTML with regex to extract
 * message text, view counts, timestamps, and post URLs.
 *
 * A browser-like User-Agent is required -- Telegram returns 403 for
 * generic bot/fetch user agents.
 */
async function fetchChannel(name: string): Promise<TelegramPost[]> {
  const url = `/api/telegram-osint/s/${name}`;

  // AbortController gives us a clean timeout mechanism
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Accept-Language hint -- User-Agent is handled by the proxy/edge function
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      throw new Error(`Telegram returned ${response.status} for channel ${name}`);
    }

    const html = await response.text();

    return parseChannelHtml(name, html);
  } catch (error) {
    // Log the failure, then return empty so other channels can still succeed.
    // We do NOT re-throw because Promise.allSettled already handles rejection,
    // but returning empty is simpler and avoids noisy "rejected" entries.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Telegram OSINT] Failed to fetch channel ${name}: ${message}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse the HTML from a Telegram channel web preview page.
 *
 * The page structure uses these key CSS classes:
 *   - tgme_widget_message: wrapper div with data-post="channel/id"
 *   - tgme_widget_message_text: the message body text
 *   - tgme_widget_message_views: view count (e.g. "12.3K")
 *   - <time datetime="...">: ISO timestamp of the post
 *
 * We use regex rather than a DOM parser to keep dependencies minimal.
 * The regex is intentionally lenient -- we would rather miss some posts
 * than crash on unexpected markup.
 */
function parseChannelHtml(channel: string, html: string): TelegramPost[] {
  const posts: TelegramPost[] = [];

  // We need to find individual message blocks. Telegram wraps each post in
  // a div with class "tgme_widget_message_wrap". We split on those boundaries.
  const messageBlocks = html.split('tgme_widget_message_wrap');

  for (const block of messageBlocks) {
    // Extract post ID from data-post attribute (format: "channel/12345")
    const postIdMatch = block.match(/data-post="([^"]+)"/);
    if (!postIdMatch) continue;

    const postId = postIdMatch[1]; // e.g. "intelslava/12345"
    const postUrl = `https://t.me/${postId}`;

    // Extract message text from the widget message text div.
    // Strip HTML tags to get plain text content.
    // Match text up to the footer/info div that always follows the message body.
    // The old regex ([\s\S]*?<\/div>) stopped at the first nested </div>.
    const textMatch = block.match(
      /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*tgme_widget_message_(?:footer|info)/
    );
    const rawText = textMatch?.[1] ?? '';
    // Strip HTML tags and decode basic entities for clean text
    const text = stripHtml(rawText);

    // Skip empty messages (e.g. image-only posts with no caption)
    if (!text.trim()) continue;

    // Extract view count (can be "1.2K", "5.6M", or plain number)
    // Match view count even when Telegram wraps it in a nested <span>
    const viewsMatch = block.match(
      /class="tgme_widget_message_views"[^>]*>[\s\S]*?(\d[\d.,KkMm]*)\s*<\/span>/
    );
    const views = viewsMatch?.[1] ? parseViewCount(viewsMatch[1].trim()) : 0;

    // Extract timestamp from the <time> element's datetime attribute
    const timeMatch = block.match(/datetime="([^"]+)"/);
    const timestamp = timeMatch?.[1] ? new Date(timeMatch[1]).getTime() : 0;

    // Only include posts with valid text and a parseable timestamp
    if (text && timestamp > 0) {
      posts.push({
        channel,
        text,
        timestamp,
        url: postUrl,
        views,
      });
    }
  }

  return posts;
}

/**
 * Strip HTML tags and decode common HTML entities to plain text.
 * Keeps it simple -- handles &amp; &lt; &gt; &quot; &nbsp; and numeric entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n') // Preserve line breaks
    .replace(/<[^>]+>/g, '')        // Strip all HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

/**
 * Parse Telegram's human-readable view counts into numbers.
 * Handles formats like "1.2K" (1200), "5.6M" (5600000), or plain "42".
 */
function parseViewCount(viewString: string): number {
  const normalized = viewString.trim().toUpperCase();

  if (normalized.endsWith('K')) {
    return Math.round(parseFloat(normalized) * 1_000);
  }
  if (normalized.endsWith('M')) {
    return Math.round(parseFloat(normalized) * 1_000_000);
  }

  const parsed = parseInt(normalized, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Extract trending topics from an array of message texts.
 *
 * How it works:
 * 1. Tokenize each message into lowercase words (strip punctuation, drop short words)
 * 2. Remove common English stop words (shared set from analysis-constants)
 * 3. Count how often each word appears across ALL messages
 * 4. Keep only words appearing 3+ times (actually trending, not noise)
 * 5. Sort by frequency descending, return top 10
 */
function extractTrendingTopics(texts: string[]): string[] {
  // Count word frequency across all messages
  const wordCounts = new Map<string, number>();

  for (const text of texts) {
    // Tokenize: lowercase, strip non-alphanumeric, split on whitespace
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !STOP_WORDS.has(word));

    // Use a Set per message so each word only counts once per message.
    // This prevents a single verbose post from dominating the counts.
    const uniqueWords = new Set(words);

    for (const word of uniqueWords) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  // Filter to words appearing in 3+ messages, sort by frequency, take top 10
  return Array.from(wordCounts.entries())
    .filter(([, count]) => count >= TRENDING_MIN_OCCURRENCES)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TRENDING_TOPICS_LIMIT)
    .map(([word]) => word);
}
