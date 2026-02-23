// Vercel Edge Function — proxies Reddit API requests server-side
// to avoid browser CORS restrictions on reddit.com.
//
// The client fetches /api/reddit/r/{subreddit}/hot.json?limit=N&raw_json=1
// and this function forwards the path after /api/reddit to reddit.com.
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Block disallowed origins
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Extract the Reddit path from the request URL
  // e.g. /api/reddit/r/worldnews/hot.json -> /r/worldnews/hot.json
  const url = new URL(req.url);
  const redditPath = url.pathname.replace(/^\/api\/reddit/, '');

  // Validate: path must start with /r/ and contain a valid subreddit name
  const subredditMatch = redditPath.match(/^\/r\/([a-zA-Z0-9_]{1,50})\//);
  if (!subredditMatch) {
    return new Response(JSON.stringify({ error: 'Invalid Reddit path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Build the full Reddit URL, preserving query params (limit, raw_json, etc.)
  const redditUrl = `https://www.reddit.com${redditPath}${url.search}`;

  try {
    // 10-second timeout to avoid hanging on slow Reddit responses
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(redditUrl, {
      signal: controller.signal,
      headers: {
        // Reddit requires a descriptive User-Agent; generic ones get 429s
        'User-Agent': 'worldmonitor:osint-reddit:v1.0 (by worldmonitor)',
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `Reddit returned ${response.status}` }), {
        status: response.status >= 500 ? 502 : response.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const data = await response.text();

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    console.error('[reddit-proxy] Error:', redditPath, error.message);

    return new Response(JSON.stringify({
      error: isTimeout ? 'Reddit request timeout' : 'Failed to fetch from Reddit',
      details: error.message,
    }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
