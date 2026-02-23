/**
 * Telegram OSINT Proxy -- Vercel Edge Function
 *
 * Proxies requests to Telegram's public channel web preview pages
 * (t.me/s/{channel}) to bypass browser CORS restrictions.
 *
 * In development, Vite's dev server proxy handles this instead.
 * This edge function serves the same role in production on Vercel.
 *
 * Accepts two URL patterns (both work):
 *   GET /api/telegram-osint/s/intelslava     (path-based, used by client)
 *   GET /api/telegram-osint?channel=intelslava (query-param fallback)
 *
 * Response: Raw HTML from https://t.me/s/{channel}
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

/** Only allow alphanumeric + underscore channel names (Telegram's format) */
const CHANNEL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

export default async function handler(request) {
  const corsHeaders = getCorsHeaders(request, 'GET, OPTIONS');

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only accept GET
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Check origin
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract channel name from path or query parameter.
  // Client sends: /api/telegram-osint/s/{channel}
  // Fallback:     /api/telegram-osint?channel={channel}
  const requestUrl = new URL(request.url);
  const pathMatch = requestUrl.pathname.match(/\/api\/telegram-osint\/s\/([a-zA-Z][a-zA-Z0-9_]+)/);
  const channel = pathMatch ? pathMatch[1] : requestUrl.searchParams.get('channel');

  if (!channel) {
    return new Response(JSON.stringify({ error: 'Missing channel parameter' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!CHANNEL_NAME_RE.test(channel)) {
    return new Response(JSON.stringify({ error: 'Invalid channel name' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Fetch the public Telegram channel preview page
  const telegramUrl = `https://t.me/s/${channel}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(telegramUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `Telegram returned ${response.status}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const html = await response.text();

    return new Response(html, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=120',
      },
    });
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    console.error('[telegram-osint] Fetch error:', channel, error.message);

    return new Response(JSON.stringify({
      error: isTimeout ? 'Telegram request timed out' : 'Failed to fetch Telegram channel',
      channel,
    }), {
      status: isTimeout ? 504 : 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
