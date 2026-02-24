/**
 * Chat API Endpoint — AI-powered Q&A about dashboard data.
 *
 * Accepts user messages with dashboard context, returns AI analysis
 * via Groq (primary) with OpenRouter fallback. Both use Llama 3.1 8B.
 *
 * Request: POST /api/chat
 *   Body: {
 *     message: string,          — the user's question
 *     context?: string,         — serialized dashboard data (feeds, alerts, etc.)
 *     history?: Array<{role, content}>  — previous conversation turns
 *   }
 *
 * Rate limited to 30 requests per minute per IP via Upstash Redis.
 */

export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

// --- Rate limit settings ---
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60;

// --- Input validation limits ---
const MAX_MESSAGE_LENGTH = 5000;
const MAX_CONTEXT_LENGTH = 50000;
const MAX_HISTORY_ENTRIES = 10;
const MAX_HISTORY_MESSAGE_LENGTH = 5000;

// --- LLM settings ---
const TEMPERATURE = 0.3;
const MAX_TOKENS = 500;
const REQUEST_TIMEOUT_MS = 15000;

// --- Monitor persona: defines how the AI behaves ---
const SYSTEM_PROMPT = `You are Monitor, a senior intelligence analyst for World Monitor.

RULES:
- Every claim MUST reference dashboard data provided in context. No speculation without evidence.
- If data is stale (>2h old), say so explicitly.
- Lead with the answer, then supporting evidence.
- Flag cross-domain connections proactively (e.g., military + shipping + oil = escalation signal).
- When uncertain, give probability ranges, not certainties.
- Be concise. 2-4 sentences for simple questions, up to a paragraph for analysis.
- Never start with "I'd be happy to help" or similar filler.
- If asked about something not in the dashboard context, say "I don't have data on that right now."`;

export default async function handler(request) {
  // --- CORS preflight: browsers send OPTIONS before POST ---
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request, 'POST, OPTIONS'),
    });
  }

  // --- Only accept POST requests ---
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    });
  }

  // --- Block requests from unknown origins ---
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- Check that at least one LLM provider is configured ---
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!groqKey && !openRouterKey) {
    return new Response(
      JSON.stringify({
        error: 'No AI providers configured. Set GROQ_API_KEY or OPENROUTER_API_KEY in Vercel env vars.',
      }),
      {
        status: 503,
        headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
      }
    );
  }

  // --- Rate limit: 30 requests/minute per IP via Upstash Redis ---
  // Use x-real-ip (set by Vercel) first, then last x-forwarded-for entry (most trusted)
  const ip = request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    || 'anonymous';
  if (await isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Rate limited' }), {
      status: 429,
      headers: {
        ...getCorsHeaders(request, 'POST, OPTIONS'),
        'Content-Type': 'application/json',
        'Retry-After': '60',
      },
    });
  }

  // --- Parse the request body ---
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    });
  }

  const { message, context, history } = payload;

  // --- Validate: message is required and within size limits ---
  if (!message || typeof message !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing or invalid message' }), {
      status: 400,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return new Response(
      JSON.stringify({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` }),
      {
        status: 400,
        headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
      }
    );
  }

  // --- Validate context size (dashboard data can be large but not unbounded) ---
  if (context && (typeof context !== 'string' || context.length > MAX_CONTEXT_LENGTH)) {
    return new Response(
      JSON.stringify({ error: `Context too long (max ${MAX_CONTEXT_LENGTH} characters)` }),
      {
        status: 400,
        headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
      }
    );
  }

  // --- Build the messages array for the LLM ---
  const messages = buildMessages(message, context, history);

  // --- Try Groq first, fall back to OpenRouter ---
  const providers = [];
  if (groqKey) {
    providers.push({
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      apiKey: groqKey,
    });
  }
  if (openRouterKey) {
    providers.push({
      name: 'OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      apiKey: openRouterKey,
    });
  }

  // --- Attempt each provider in order until one succeeds ---
  for (const provider of providers) {
    try {
      const reply = await callProvider(provider, messages);
      // Success — return the AI response
      return new Response(
        JSON.stringify({ reply, provider: provider.name }),
        {
          status: 200,
          headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
        }
      );
    } catch (err) {
      // Log and try the next provider
      console.error(`[chat] ${provider.name} failed:`, err.message || err);
    }
  }

  // --- All providers failed ---
  return new Response(
    JSON.stringify({ error: 'All AI providers failed. Try again in a moment.' }),
    {
      status: 502,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Build the messages array sent to the LLM.
 *
 * Structure:
 *   1. System prompt (Monitor persona)
 *   2. Dashboard context as a second system message (if provided)
 *   3. Last 10 conversation history entries (user/assistant roles only)
 *   4. The current user message
 */
function buildMessages(message, context, history) {
  const messages = [];

  // Always start with the Monitor persona
  messages.push({ role: 'system', content: SYSTEM_PROMPT });

  // Inject dashboard context so the LLM can reference real data
  if (context && typeof context === 'string') {
    messages.push({
      role: 'system',
      content: `CURRENT DASHBOARD DATA:\n${context}`,
    });
  }

  // Include recent conversation history for continuity (max 10 turns, each capped)
  if (Array.isArray(history)) {
    const validRoles = new Set(['user', 'assistant']);
    const recentHistory = history
      .filter((msg) => validRoles.has(msg?.role) && typeof msg?.content === 'string')
      .slice(-MAX_HISTORY_ENTRIES);

    for (const msg of recentHistory) {
      // Truncate individual history messages to prevent payload abuse
      const content = msg.content.length > MAX_HISTORY_MESSAGE_LENGTH
        ? msg.content.slice(0, MAX_HISTORY_MESSAGE_LENGTH)
        : msg.content;
      messages.push({ role: msg.role, content });
    }
  }

  // The current question from the user
  messages.push({ role: 'user', content: message });

  return messages;
}

/**
 * Call a single LLM provider (Groq or OpenRouter).
 *
 * Returns the assistant's reply text, or throws on failure.
 * Uses a 15-second timeout to avoid hanging requests.
 */
async function callProvider(provider, messages) {
  const response = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`${provider.name} returned ${response.status}: ${errorBody}`);
  }

  const data = await response.json();

  // Extract the reply text from the standard OpenAI-compatible response format
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) {
    throw new Error(`${provider.name} returned no content in response`);
  }

  return reply;
}

/**
 * Rate limit via Upstash Redis pipeline (same pattern as telegram-alert.js).
 *
 * Uses INCR + EXPIRE with NX flag:
 *   - INCR atomically increments the counter for this IP
 *   - EXPIRE NX sets a 60-second TTL only if one isn't already set
 *   - If the count exceeds 30, the request is rate-limited
 *
 * Gracefully degrades: if Redis is down or not configured, allow the request.
 */
async function isRateLimited(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // If Redis isn't configured, skip rate limiting (graceful degradation)
  if (!url || !token) return false;

  const key = `rl:chat:${ip}`;
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
    // Redis error — allow the request rather than block legitimate users
    return false;
  }
}
