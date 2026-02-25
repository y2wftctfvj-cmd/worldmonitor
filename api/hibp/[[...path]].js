// Vercel Edge Function — proxies HIBP (Have I Been Pwned) API requests
// server-side to avoid browser CORS restrictions on haveibeenpwned.com.
//
// The client fetches /api/hibp/api/v3/breaches and this function
// forwards the path after /api/hibp to haveibeenpwned.com.
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';

export const config = { runtime: 'edge' };

// Only allow specific HIBP API paths (prevent open proxy abuse)
const ALLOWED_PATHS = ['/api/v3/breaches', '/api/v3/breach/'];

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

  // Extract the HIBP path from the request URL
  // e.g. /api/hibp/api/v3/breaches -> /api/v3/breaches
  const url = new URL(req.url);
  const hibpPath = url.pathname.replace(/^\/api\/hibp/, '');

  // Validate: path must start with an allowed HIBP API path
  if (!ALLOWED_PATHS.some((allowed) => hibpPath.startsWith(allowed))) {
    return new Response(JSON.stringify({ error: 'Invalid HIBP path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const hibpUrl = `https://haveibeenpwned.com${hibpPath}${url.search}`;

  try {
    const response = await fetch(hibpUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        // HIBP requires a descriptive User-Agent
        'User-Agent': 'worldmonitor:osint-breaches:v1.0 (by worldmonitor)',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `HIBP returned ${response.status}` }), {
        status: response.status >= 500 ? 502 : response.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const data = await response.text();

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Breach data changes infrequently — cache for 1 hour
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    console.error('[hibp-proxy] Error:', hibpPath, error.message);

    return new Response(JSON.stringify({
      error: isTimeout ? 'HIBP request timeout' : 'Failed to fetch from HIBP',
      details: error.message,
    }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
