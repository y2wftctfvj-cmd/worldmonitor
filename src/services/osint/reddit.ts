/**
 * Reddit Intelligence Feed — OSINT module
 *
 * Fetches hot posts from geopolitical subreddits via Reddit's public JSON API.
 * Results are cached for 5 minutes to avoid hammering Reddit's servers.
 * Extracts trending topics by tokenizing post titles and counting word frequency.
 */

import { STOP_WORDS, SUPPRESSED_TRENDING_TERMS } from '@/utils/analysis-constants';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Geopolitical subreddits to monitor for intelligence signals */
const SUBREDDITS = [
  'worldnews',
  'geopolitics',
  'osint',
  'UkraineRussiaReport',
  'CredibleDefense',
] as const;

/** Cache time-to-live: 5 minutes (avoids excessive Reddit API calls) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Timeout for each subreddit fetch (Reddit can be slow) */
const FETCH_TIMEOUT_MS = 8_000;

/** How many top posts to keep after merging all subreddits */
const TOP_POSTS_LIMIT = 25;

/** Maximum number of trending topic words to return */
const TRENDING_TOPICS_LIMIT = 10;

/** Minimum times a word must appear across titles to qualify as "trending" */
const TRENDING_MIN_OCCURRENCES = 3;

/** Posts fetched per subreddit (Reddit "hot" endpoint) */
const POSTS_PER_SUBREDDIT = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Reddit post, normalized to the fields we care about */
export interface RedditPost {
  subreddit: string;
  title: string;
  score: number;
  numComments: number;
  url: string;
  createdUtc: number;
  permalink: string;
}

/** The full intelligence payload: top posts + trending topics + timestamp */
export interface RedditIntel {
  posts: RedditPost[];
  trendingTopics: string[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/** Cached result — null until first fetch, refreshed every CACHE_TTL_MS */
let cachedResult: RedditIntel | null = null;

/** Timestamp of the last successful fetch */
let cachedAt = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch geopolitical intelligence from Reddit.
 *
 * Returns a cached result if it's still fresh (< 5 min old).
 * Otherwise, fetches all subreddits in parallel, merges and sorts
 * by score, keeps the top 25, and extracts trending topics.
 */
export async function fetchRedditIntel(): Promise<RedditIntel> {
  // Return cache if it exists and hasn't expired
  const now = Date.now();
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  // Fetch all subreddits in parallel — allSettled so one failure
  // doesn't kill the whole batch (Reddit rate-limits are unpredictable)
  const results = await Promise.allSettled(
    SUBREDDITS.map(name => fetchSubreddit(name))
  );

  // Collect posts from all successful fetches
  const allPosts: RedditPost[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allPosts.push(...result.value);
    }
  }

  // Sort by score descending and keep the top N
  const topPosts = allPosts
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_POSTS_LIMIT);

  // Extract trending topics from the top post titles
  const titles = topPosts.map(post => post.title);
  const trendingTopics = extractTrendingTopics(titles);

  // Build the intel payload and cache it
  const intel: RedditIntel = {
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
 * Fetch hot posts from a single subreddit.
 *
 * Uses Reddit's public JSON API (no auth required), proxied through
 * /api/reddit to avoid browser CORS restrictions. The proxy (Vite dev
 * server or Vercel Edge Function) sets the User-Agent header server-side.
 * Includes an 8-second timeout to avoid hanging on slow responses.
 */
async function fetchSubreddit(name: string): Promise<RedditPost[]> {
  const url = `/api/reddit/r/${name}/hot.json?limit=${POSTS_PER_SUBREDDIT}&raw_json=1`;

  // AbortController gives us a clean timeout mechanism
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Reddit API returned ${response.status} for r/${name}`);
    }

    const json = await response.json();

    // Reddit wraps posts in data.children[].data
    const children: unknown[] = json?.data?.children ?? [];

    return children.map((child: unknown) => {
      const post = (child as { data: Record<string, unknown> }).data;
      return {
        subreddit: String(post.subreddit ?? name),
        title: String(post.title ?? ''),
        score: Number(post.score ?? 0),
        numComments: Number(post.num_comments ?? 0),
        url: String(post.url ?? ''),
        createdUtc: Number(post.created_utc ?? 0),
        permalink: `https://www.reddit.com${String(post.permalink ?? '')}`,
      };
    });
  } catch (error) {
    // Log the failure, then re-throw so Promise.allSettled records it
    // as a rejection. Other subreddits can still succeed independently.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Reddit OSINT] Failed to fetch r/${name}: ${message}`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract trending topics from an array of post titles.
 *
 * How it works:
 * 1. Tokenize each title into lowercase words (strip punctuation, drop short words)
 * 2. Remove common English stop words (shared set from analysis-constants)
 * 3. Count how often each word appears across ALL titles
 * 4. Keep only words appearing 3+ times (actually trending, not noise)
 * 5. Sort by frequency descending, return top 10
 */
function extractTrendingTopics(titles: string[]): string[] {
  // Count word frequency across all titles
  const wordCounts = new Map<string, number>();

  for (const title of titles) {
    // Tokenize: lowercase, strip non-alphanumeric, split on whitespace
    const words = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !STOP_WORDS.has(word) && !SUPPRESSED_TRENDING_TERMS.has(word));

    // Use a Set per title so each word only counts once per title
    // (prevents a single verbose title from dominating the counts)
    const uniqueWords = new Set(words);

    for (const word of uniqueWords) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  // Filter to words appearing in 3+ titles, sort by frequency, take top 10
  return Array.from(wordCounts.entries())
    .filter(([, count]) => count >= TRENDING_MIN_OCCURRENCES)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TRENDING_TOPICS_LIMIT)
    .map(([word]) => word);
}
