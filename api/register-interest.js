export const config = { runtime: 'edge' };

import { ConvexHttpClient } from 'convex/browser';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;

// Rate limiting via Upstash Redis (survives serverless scaling, unlike in-memory Map)
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 3600; // 1 hour

async function isRateLimited(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // If Redis isn't configured, allow the request (graceful degradation)
  if (!url || !token) return false;

  const key = `rl:register:${ip}`;
  try {
    // INCR the key and set TTL atomically via Upstash REST pipeline
    // Pipeline: INCR key, then EXPIRE key (only if it's a new key)
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, RATE_WINDOW_SECONDS, 'NX'], // NX = only set if no TTL exists
      ]),
      signal: AbortSignal.timeout(2_000),
    });

    if (!resp.ok) return false; // Redis issue — allow the request

    const results = await resp.json();
    // results[0].result = current count after INCR
    const count = results?.[0]?.result ?? 0;
    return count > RATE_LIMIT;
  } catch {
    // Redis unavailable — allow the request rather than blocking everyone
    return false;
  }
}

export default async function handler(req) {
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // Use x-real-ip (set by Vercel) first, then last x-forwarded-for entry (most trusted)
  const ip = req.headers.get('x-real-ip')?.trim()
    || req.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    || 'anonymous';
  if (await isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(RATE_WINDOW_SECONDS),
        ...cors,
      },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const { email, source, appVersion } = body;
  if (!email || typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email address' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    return new Response(JSON.stringify({ error: 'Registration service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    const result = await client.mutation('registerInterest:register', {
      email,
      source: source || 'unknown',
      appVersion: appVersion || 'unknown',
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (err) {
    console.error('[register-interest] Convex error:', err);
    return new Response(JSON.stringify({ error: 'Registration failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
