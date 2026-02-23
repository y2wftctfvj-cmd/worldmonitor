/**
 * Telegram Alert Endpoint — forwards dashboard alerts to Telegram.
 *
 * Setup (one-time, free):
 *   1. Message @BotFather on Telegram → /newbot → copy the token
 *   2. Message @userinfobot → copy your numeric chat_id
 *   3. Add to Vercel env vars:
 *      TELEGRAM_BOT_TOKEN=123456:ABC...
 *      TELEGRAM_CHAT_ID=987654321
 *
 * Request: POST /api/telegram-alert
 *   Body: { severity: 'critical'|'warning'|'info', title: string, body: string }
 *
 * Rate limited to 10 alerts per minute via Upstash Redis.
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 60;

export default async function handler(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  // Only accept POST
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });
  }

  // Check origin
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify Telegram is configured
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return new Response(JSON.stringify({ error: 'Telegram not configured' }), {
      status: 503,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });
  }

  // Rate limit via Upstash Redis
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (await isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Rate limited' }), {
      status: 429,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  // Parse request body
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });
  }

  const { severity, title, body } = payload;
  if (!severity || !title) {
    return new Response(JSON.stringify({ error: 'Missing severity or title' }), {
      status: 400,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });
  }

  // Format Telegram message with severity emoji
  const emoji = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : '🔵';
  const text = `${emoji} *World Monitor Alert*\n\n*${escapeMarkdown(title)}*\n${escapeMarkdown(body || '')}`;

  // Send to Telegram Bot API
  try {
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
      console.error('[telegram-alert] Telegram API error:', resp.status, errBody);
      return new Response(JSON.stringify({ error: 'Telegram API error', status: resp.status }), {
        status: 502,
        headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[telegram-alert] Failed to send:', err);
    return new Response(JSON.stringify({ error: 'Failed to reach Telegram' }), {
      status: 502,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Rate limit via Upstash Redis (same pattern as register-interest.js)
 */
async function isRateLimited(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  const key = `rl:telegram:${ip}`;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, RATE_WINDOW_SECONDS, 'NX'],
      ]),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const results = await resp.json();
    const count = results?.[0]?.result ?? 0;
    return count > RATE_LIMIT;
  } catch {
    return false; // graceful degradation
  }
}
