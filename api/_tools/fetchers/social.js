/**
 * Social Media Fetchers — Telegram, Reddit, Twitter/X, Bluesky.
 *
 * Telegram uses public web scraping (t.me/s/{channel}).
 * Reddit uses the public JSON API.
 * Twitter/X uses Nitter RSS feeds (no API key needed).
 * Bluesky uses the public AT Protocol API.
 */

/** 25+ public Telegram channels (verified via t.me/s/{channel}) */
export const TELEGRAM_CHANNELS = [
  // Conflict/geopolitical aggregators
  'intelslava', 'militarysummary', 'breakingmash', 'legitimniy',
  // Middle East / Iran
  'iranintl_en', 'CIG_telegram',
  // Global OSINT & intel aggregators
  'IntelRepublic', 'combatftg', 'osintdefender', 'BellumActaNews',
  'OsintTv',
  // Military news
  'GeneralMCNews', 'rnintelligence',
  // Regional
  'RVvoenkor', 'usaperiodical',
  // Mainstream news organizations
  'Bloomberg', 'guardian', 'cnbci',
  // Al Jazeera (English + Arabic for cross-language corroboration)
  'AJENews_Official', 'ajanews',
  // Ukraine/Russia conflict — direct from the front
  'KyivIndependent_official', 'ukrainenowenglish',
  // Official government/military
  'idfofficial',
  // Israel/Middle East news organizations
  'ILTVNews', 'TheTimesOfIsrael2022',
  // Journalist channels (individual reporters with direct-source intel)
  'barakravid1',
];

/** 12+ geopolitical/OSINT subreddits */
export const SUBREDDITS = [
  // Geopolitics
  'worldnews', 'geopolitics', 'osint', 'CredibleDefense',
  'internationalsecurity', 'middleeastwar', 'iranpolitics',
  // Military/defense
  'CombatFootage', 'WarCollege',
  // Cyber
  'netsec', 'cybersecurity',
  // Markets (cross-domain correlation)
  'wallstreetbets',
];

const TELEGRAM_POST_LIMIT = 3;
const TELEGRAM_MAX_TEXT_LENGTH = 350;
const TELEGRAM_NOISE_PATTERNS = [
  /please open telegram to view this post/gi,
  /view in telegram/gi,
  /open a channel via telegram app/gi,
  /join channel/gi,
  /share this post/gi,
  /via telegram app/gi,
  /forwarded from/gi,
];

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

export function decodeHtmlEntities(text) {
  if (!text) return '';

  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function stripTelegramBoilerplate(text) {
  let cleaned = String(text || '');
  for (const pattern of TELEGRAM_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return cleaned;
}

export function cleanTelegramHtml(html) {
  if (!html) return '';

  const withoutMedia = String(html)
    .replace(/<blockquote[^>]*>/gi, '<div>')
    .replace(/<\/blockquote>/gi, '</div>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2');

  const text = decodeHtmlEntities(withoutMedia)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return stripTelegramBoilerplate(text)
    .replace(/\b(?:http|https):\/\/t\.me\/\S+/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isMeaningfulTelegramText(text) {
  const value = String(text || '').trim();
  if (value.length < 25) return false;

  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || normalized.length < 20) return false;
  if (/^(view in telegram|open a channel|join channel)/.test(normalized)) return false;

  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.length >= 4;
}

function truncateTelegramText(text) {
  if (text.length <= TELEGRAM_MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_MAX_TEXT_LENGTH - 3).trim()}...`;
}

function parseTelegramPost(channel, block) {
  const textMatch = block.match(/class="tgme_widget_message_text[^\"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*tgme_widget_message_(?:footer|info)|<a[^>]*class="tgme_widget_message_date"|<div class="tgme_widget_message_link")/i);
  if (!textMatch) return null;

  const text = cleanTelegramHtml(textMatch[1]);
  if (!isMeaningfulTelegramText(text)) return null;

  const linkMatch = block.match(/class="tgme_widget_message_date"[^>]*href="([^"]+)"/i)
    || block.match(/data-post="([^"]+)"/i);

  let link = null;
  if (linkMatch?.[1]) {
    link = linkMatch[1].startsWith('http')
      ? linkMatch[1]
      : `https://t.me/${String(linkMatch[1]).replace(/^\//, '')}`;
  }

  const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/i);
  const publishedAt = timeMatch?.[1] || null;

  return {
    channel,
    text: truncateTelegramText(text),
    publishedAt,
    link,
  };
}

export function parseTelegramChannelHtml(channel, html) {
  if (!html) return [];

  const blocks = String(html)
    .split(/<div class="tgme_widget_message_wrap[^>]*>/i)
    .slice(1);

  const posts = [];
  const seen = new Set();

  for (const block of blocks) {
    const parsed = parseTelegramPost(channel, block);
    if (!parsed) continue;

    const dedupeKey = `${parsed.channel}:${parsed.text.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    posts.push(parsed);
  }

  return posts.slice(-TELEGRAM_POST_LIMIT);
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch latest messages from all Telegram OSINT channels.
 * Returns array of { channel, text, publishedAt, link } objects.
 */
export async function fetchAllTelegramChannels() {
  const results = await Promise.allSettled(
    TELEGRAM_CHANNELS.map(async (channel) => {
      const url = `https://t.me/s/${channel}`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];

      const html = await resp.text();
      return parseTelegramChannelHtml(channel, html);
    })
  );

  return results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);
}

/**
 * Fetch top posts from all tracked subreddits.
 * Returns array of { sub, title, score, comments } objects.
 */
export async function fetchAllRedditPosts() {
  const postsPerSub = 3;
  const BATCH_SIZE = 4;
  const allPosts = [];

  // Batch 4 subreddits at a time to avoid Reddit rate limits
  for (let i = 0; i < SUBREDDITS.length; i += BATCH_SIZE) {
    const batch = SUBREDDITS.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (sub) => {
        const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${postsPerSub}&raw_json=1`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'WorldMonitor/2.7' },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];

        const data = await resp.json();
        const children = data?.data?.children;
        if (!Array.isArray(children)) return [];

        return children
          .filter((c) => c?.data?.title && !c.data.stickied)
          .map((c) => ({
            sub,
            title: c.data.title,
            score: c.data.score || 0,
            comments: c.data.num_comments || 0,
          }));
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') allPosts.push(...result.value);
    }
  }

  return allPosts.sort((a, b) => b.score - a.score);
}

/**
 * Fetch recent tweets from OSINT accounts via Nitter RSS feeds.
 * Nitter is a free Twitter frontend that exposes RSS — no API key needed.
 * Returns array of { account, text } objects.
 */
export async function fetchTwitterOsint() {
  const OSINT_ACCOUNTS = [
    'IntelDoge', 'sentdefender', 'Global_Mil_Info', 'NotWoofers',
    'RALee85', 'Flash_news_ua', 'Faytuks',
  ];

  // Multiple Nitter instances for redundancy — if one is down, try the next
  const NITTER_INSTANCES = [
    'nitter.privacydev.net',
    'nitter.poast.org',
  ];

  const allTweets = [];

  const results = await Promise.allSettled(
    OSINT_ACCOUNTS.map(async (account) => {
      // Try each Nitter instance until one works
      for (const instance of NITTER_INSTANCES) {
        try {
          const rssUrl = `https://${instance}/${account}/rss`;
          const resp = await fetch(rssUrl, {
            headers: { 'User-Agent': 'WorldMonitor/2.7' },
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) continue;

          const xml = await resp.text();
          const tweets = [];
          const itemPattern = /<item>[\s\S]*?<\/item>/g;
          const titlePattern = /<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/;
          const descPattern = /<description><!\[CDATA\[(.*?)\]\]>|<description>(.*?)<\/description>/;
          let itemMatch;
          while ((itemMatch = itemPattern.exec(xml)) !== null && tweets.length < 3) {
            // Prefer description (full tweet) over title (truncated)
            const descMatch = itemMatch[0].match(descPattern);
            const titleMatch = itemMatch[0].match(titlePattern);
            const rawText = descMatch?.[1] || descMatch?.[2] || titleMatch?.[1] || titleMatch?.[2];
            if (!rawText) continue;

            // Strip HTML tags and clean up
            const text = rawText
              .replace(/<br\s*\/?>/gi, ' ')
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim();

            if (text.length > 10) {
              const truncated = text.length > 280 ? text.slice(0, 280) + '...' : text;
              tweets.push({ account, text: truncated });
            }
          }

          return tweets;
        } catch {
          continue; // Try next Nitter instance
        }
      }
      return []; // All instances failed for this account
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') allTweets.push(...result.value);
  }

  return allTweets;
}

/**
 * Fetch recent posts from OSINT accounts on Bluesky via the AT Protocol.
 *
 * Returns engagement metadata (likes, reposts, velocity) so the fusion engine
 * can weight high-engagement posts as stronger signals. A post with 500 likes
 * in 5 minutes is breaking news; same post after 6 hours is stale.
 *
 * @returns {Array<{ account: string, text: string, engagement: number }>}
 */
export async function fetchBlueskyOsint() {
  const BLUESKY_ACCOUNTS = [
    // OSINT investigations
    'bellingcat.com',
    'conflictnews.com',
    // Military/defense OSINT
    'osinttechnical.bsky.social',
    'julianroepcke.bsky.social',
    // Journalists with conflict/geopolitical focus
    'christopherjm.bsky.social',
    'eaborido.bsky.social',
    'shaborak.bsky.social',
    // Conflict tracking
    'warmonitor.bsky.social',
    'auaborak.bsky.social',
  ];

  const allPosts = [];
  const now = Date.now();

  const results = await Promise.allSettled(
    BLUESKY_ACCOUNTS.map(async (handle) => {
      try {
        const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=5&filter=posts_no_replies`;
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];

        const data = await resp.json();
        return (data.feed || [])
          .map(item => {
            const post = item.post;
            const text = post?.record?.text;
            if (!text || text.length < 10) return null;

            // Calculate engagement velocity: (likes + reposts*2) / age in minutes
            const likes = post.likeCount || 0;
            const reposts = post.repostCount || 0;
            const createdAt = new Date(post.record?.createdAt || 0).getTime();
            const ageMinutes = Math.max((now - createdAt) / 60000, 1);
            const engagement = (likes + reposts * 2) / ageMinutes;

            const truncated = text.length > 280 ? text.slice(0, 280) + '...' : text;
            return {
              account: handle.split('.')[0],
              text: truncated,
              engagement: Math.round(engagement * 100) / 100,
            };
          })
          .filter(Boolean)
          .slice(0, 3);
      } catch {
        return [];
      }
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') allPosts.push(...result.value);
  }

  return allPosts;
}
