/**
 * Chat API Endpoint — AI-powered Q&A about dashboard data.
 *
 * v2.7.0: Upgraded to Qwen 3.5 Plus (primary) with DeepSeek V3.2 and
 * Groq Llama fallbacks. Max tokens increased to 2000. Monitor persona
 * upgraded with cross-domain analysis and probability-based reasoning.
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
const MAX_TOKENS = 2000;
const REQUEST_TIMEOUT_MS = 30000;

// --- Monitor persona: v2.7 upgraded ---
const SYSTEM_PROMPT = `You are Monitor, a senior intelligence analyst for World Monitor.

IDENTITY:
- Direct, concise, data-driven. No filler.
- You think in probabilities and leading indicators.
- You proactively flag cross-domain connections nobody asked about.
- You challenge assumptions when evidence contradicts them.

RULES:
- Every claim MUST reference dashboard data provided in context. No speculation without evidence.
- If data is stale (>2h old), say so explicitly.
- Lead with the answer, then supporting evidence.
- Flag cross-domain connections proactively (e.g., military + shipping + oil = escalation signal).
- When uncertain, give probability ranges, not certainties.
- Be concise. 2-4 sentences for simple questions, up to a paragraph for analysis.
- Always end analysis with: "Watch for:" + 2-3 specific next indicators.
- Never start with "I'd be happy to help" or similar filler.
- If asked about something not in the dashboard context, say "I don't have data on that right now."`;

export default async function handler(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request, 'POST, OPTIONS'),
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    });
  }

  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check LLM providers
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!openRouterKey && !groqKey) {
    return new Response(
      JSON.stringify({ error: 'No AI providers configured. Set OPENROUTER_API_KEY or GROQ_API_KEY in Vercel env vars.' }),
      {
        status: 503,
        headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
      }
    );
  }

  // Rate limit
  const ip = request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
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

  // Parse request
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

  // Validate message
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

  // Validate context
  if (context && (typeof context !== 'string' || context.length > MAX_CONTEXT_LENGTH)) {
    return new Response(
      JSON.stringify({ error: `Context too long (max ${MAX_CONTEXT_LENGTH} characters)` }),
      {
        status: 400,
        headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
      }
    );
  }

  // Build messages
  const messages = buildMessages(message, context, history);

  // Build provider list: Qwen 3.5 Plus → DeepSeek V3.2 → Groq Llama
  const providers = [];
  if (openRouterKey) {
    providers.push({
      name: 'Qwen',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'qwen/qwen3.5-plus-02-15',
      apiKey: openRouterKey,
    });
    providers.push({
      name: 'DeepSeek',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'deepseek/deepseek-v3.2',
      apiKey: openRouterKey,
    });
  }
  if (groqKey) {
    providers.push({
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      apiKey: groqKey,
    });
  }

  // Try each provider
  for (const provider of providers) {
    try {
      const reply = await callProvider(provider, messages);
      return new Response(
        JSON.stringify({ reply, provider: provider.name }),
        {
          status: 200,
          headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
        }
      );
    } catch (err) {
      console.error(`[chat] ${provider.name} failed:`, err.message || err);
    }
  }

  // All failed
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
 */
function buildMessages(message, context, history) {
  const messages = [];

  messages.push({ role: 'system', content: SYSTEM_PROMPT });

  if (context && typeof context === 'string') {
    messages.push({
      role: 'system',
      content: `CURRENT DASHBOARD DATA:\n${context}`,
    });
  }

  // Recent conversation history (max 10 turns)
  if (Array.isArray(history)) {
    const validRoles = new Set(['user', 'assistant']);
    const recentHistory = history
      .filter((msg) => validRoles.has(msg?.role) && typeof msg?.content === 'string')
      .slice(-MAX_HISTORY_ENTRIES);

    for (const msg of recentHistory) {
      const content = msg.content.length > MAX_HISTORY_MESSAGE_LENGTH
        ? msg.content.slice(0, MAX_HISTORY_MESSAGE_LENGTH)
        : msg.content;
      messages.push({ role: msg.role, content });
    }
  }

  messages.push({ role: 'user', content: message });

  return messages;
}

/**
 * Call a single LLM provider.
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
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) {
    throw new Error(`${provider.name} returned no content in response`);
  }

  return reply;
}

/**
 * Rate limit via Upstash Redis.
 */
async function isRateLimited(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

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
    return false;
  }
}
