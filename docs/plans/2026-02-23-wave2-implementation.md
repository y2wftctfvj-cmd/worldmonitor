# Wave 2: Smarter AI + OSINT — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform World Monitor from a passive data dashboard into an active intelligence system with a real AI analyst (Monitor), event-driven alerts, pattern detection, predictive signals, and OSINT feeds.

**Architecture:** All AI chat goes through a new `/api/chat.js` Vercel Edge Function using the existing Groq/OpenRouter fallback. OSINT feeds plug into the existing signal aggregator. Pattern detection and predictions are pure client-side services using IndexedDB for 90-day history. Telegram cron endpoints collect data server-side and push digests.

**Tech Stack:** Vercel Edge Functions (JS), TypeScript (client), Groq LLM API, Reddit JSON API, Telegram Bot API, OpenSky (existing), AIS Stream (existing), HIBP API, IndexedDB, localStorage.

---

## Task 1: Chat API Endpoint

**Files:**
- Create: `api/chat.js`

**Step 1: Create the chat endpoint**

This is a Vercel Edge Function that accepts user messages with dashboard context and returns AI responses via Groq (primary) with OpenRouter fallback.

```javascript
// api/chat.js
export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

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
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(request, 'POST, OPTIONS') });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    });
  }
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

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
  if (!message) {
    return new Response(JSON.stringify({ error: 'Missing message' }), {
      status: 400,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    });
  }

  // Build messages array for LLM
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  // Add dashboard context as system message
  if (context) {
    messages.push({
      role: 'system',
      content: `CURRENT DASHBOARD STATE (${new Date().toISOString()}):\n${context}`,
    });
  }

  // Add conversation history (last 5 exchanges)
  const recentHistory = Array.isArray(history) ? history.slice(-10) : [];
  for (const msg of recentHistory) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current user message
  messages.push({ role: 'user', content: message });

  // Try Groq first, then OpenRouter
  const groqKey = process.env.GROQ_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const providers = [];
  if (groqKey) {
    providers.push({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: { model: 'llama-3.1-8b-instant', messages, temperature: 0.3, max_tokens: 500 },
      name: 'groq',
    });
  }
  if (openrouterKey) {
    providers.push({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
      },
      body: { model: 'meta-llama/llama-3.1-8b-instruct:free', messages, temperature: 0.3, max_tokens: 500 },
      name: 'openrouter',
    });
  }

  if (providers.length === 0) {
    return new Response(JSON.stringify({ error: 'No AI providers configured', reply: 'AI chat requires a Groq or OpenRouter API key. Add one to your environment variables.' }), {
      status: 503,
      headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
    });
  }

  for (const provider of providers) {
    try {
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers,
        body: JSON.stringify(provider.body),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.warn(`[chat] ${provider.name} returned ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (reply) {
        return new Response(JSON.stringify({ reply, provider: provider.name }), {
          status: 200,
          headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
        });
      }
    } catch (err) {
      console.warn(`[chat] ${provider.name} failed:`, err);
    }
  }

  return new Response(JSON.stringify({ error: 'All AI providers failed', reply: 'All AI providers are currently unavailable. Please try again.' }), {
    status: 502,
    headers: { ...getCorsHeaders(request, 'POST, OPTIONS'), 'Content-Type': 'application/json' },
  });
}
```

**Step 2: Commit**

```bash
git add api/chat.js
git commit -m "feat: add /api/chat endpoint with Groq/OpenRouter fallback"
```

---

## Task 2: Upgrade ChatPanel to Use API + Multi-Turn

**Files:**
- Modify: `src/components/ChatPanel.ts`

**Step 1: Rewrite ChatPanel to use the API**

Replace the browser T5 call with a fetch to `/api/chat`. Keep multi-turn history. Update the persona branding.

Key changes:
- Store last 10 messages (5 exchanges) for multi-turn context
- Send `{ message, context, history }` to `/api/chat`
- Fall back to browser T5 if API returns error
- Change title from "AI Assistant" to "Monitor"
- Change welcome message to match Monitor persona
- Change placeholder to "Ask Monitor anything..."

```typescript
// In sendMessage(), replace the mlWorker.summarize call:

// Build history for API (last 10 messages)
const apiHistory = this.messages.slice(-10).map((m) => ({
  role: m.role,
  content: m.content,
}));

// Gather dashboard context
const context = this.contextGetter?.() ?? '';

try {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: trimmed, context, history: apiHistory }),
    signal: AbortSignal.timeout(20000),
  });

  if (resp.ok) {
    const data = await resp.json();
    response = data.reply || 'No response from Monitor.';
  } else {
    // Fallback to browser T5
    if (mlWorker.isAvailable) {
      const prompt = context
        ? `Dashboard context:\n${context}\n\nUser question: ${trimmed}\n\nAnswer concisely.`
        : trimmed;
      const results = await mlWorker.summarize([prompt]);
      response = results[0] || 'Monitor is offline. Try again shortly.';
    } else {
      response = 'Monitor is temporarily unavailable. Please try again.';
    }
  }
} catch {
  // Network error — try browser T5
  if (mlWorker.isAvailable) {
    const results = await mlWorker.summarize([trimmed]);
    response = results[0] || 'Monitor is offline.';
  } else {
    response = 'Monitor is temporarily unavailable.';
  }
}
```

Also update:
- `chat-panel-title` textContent: `'AI Assistant'` → `'Monitor'`
- Welcome message: `'I'm Monitor, your intelligence analyst. Ask me about any region, threat, market move, or pattern on the dashboard.'`
- Input placeholder: `'Ask about current events...'` → `'Ask Monitor anything...'`

**Step 2: Commit**

```bash
git add src/components/ChatPanel.ts
git commit -m "feat: upgrade ChatPanel to use /api/chat with multi-turn history"
```

---

## Task 3: Watchlist Service

**Files:**
- Create: `src/services/watchlist.ts`

**Step 1: Create the watchlist service**

Stores watched entities in localStorage. Provides matching against current signals.

```typescript
// src/services/watchlist.ts

const STORAGE_KEY = 'worldmonitor-watchlist';

export interface WatchItem {
  id: string;
  query: string;        // "Taiwan", "oil above $90", "China-Taiwan"
  type: 'region' | 'entity' | 'topic' | 'threshold';
  createdAt: number;
  lastTriggered: number | null;
}

export interface WatchMatch {
  watchId: string;
  query: string;
  matchedSignal: string;  // description of what matched
  timestamp: number;
}

export function getWatchlist(): WatchItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addWatch(query: string): WatchItem {
  const items = getWatchlist();
  const type = detectWatchType(query);
  const item: WatchItem = {
    id: `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    query: query.trim(),
    type,
    createdAt: Date.now(),
    lastTriggered: null,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify([item, ...items].slice(0, 50)));
  return item;
}

export function removeWatch(id: string): void {
  const items = getWatchlist().filter((w) => w.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function checkWatchlist(headlines: string[], signals: string[]): WatchMatch[] {
  const items = getWatchlist();
  const matches: WatchMatch[] = [];
  const allText = [...headlines, ...signals];

  for (const item of items) {
    const queryLower = item.query.toLowerCase();
    const terms = queryLower.split(/[\s-]+/).filter((t) => t.length > 2);

    for (const text of allText) {
      const textLower = text.toLowerCase();
      // Match if all significant terms appear in the text
      const allTermsMatch = terms.every((term) => textLower.includes(term));
      if (allTermsMatch) {
        // Suppress if triggered in last 30 minutes
        if (item.lastTriggered && Date.now() - item.lastTriggered < 30 * 60 * 1000) continue;
        matches.push({
          watchId: item.id,
          query: item.query,
          matchedSignal: text.slice(0, 200),
          timestamp: Date.now(),
        });
        // Update lastTriggered
        item.lastTriggered = Date.now();
        break; // One match per watch item per cycle
      }
    }
  }

  // Persist updated lastTriggered times
  if (matches.length > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  return matches;
}

function detectWatchType(query: string): WatchItem['type'] {
  if (/above|below|over|under|\$|%/i.test(query)) return 'threshold';
  // Common country/region names
  if (/taiwan|china|russia|ukraine|iran|israel|korea|gaza|crimea|strait|baltic|arctic/i.test(query)) return 'region';
  if (/oil|gold|bitcoin|s&p|nasdaq|vix/i.test(query)) return 'topic';
  return 'entity';
}
```

**Step 2: Commit**

```bash
git add src/services/watchlist.ts
git commit -m "feat: add watchlist service with localStorage persistence"
```

---

## Task 4: Pattern Memory Service (90-Day History)

**Files:**
- Create: `src/services/pattern-memory.ts`
- Modify: `src/services/storage.ts` (extend retention)

**Step 1: Create pattern-memory.ts**

Stores daily snapshots of CII scores and convergence data. Compares current patterns against historical ones.

```typescript
// src/services/pattern-memory.ts

import { initDB } from './storage';

const MAX_SNAPSHOTS = 90; // 90 days of daily snapshots

export interface DailySnapshot {
  timestamp: number;  // epoch ms, one per day
  date: string;       // YYYY-MM-DD
  ciiScores: Record<string, number>;          // country code → score
  convergenceZones: { region: string; score: number; signalTypes: string[] }[];
  signalCounts: Record<string, number>;       // signal type → count
  topAlerts: { severity: string; title: string }[];
}

export interface PatternMatch {
  matchDate: string;
  similarity: number;   // 0-1
  description: string;  // what happened then
  currentPattern: string;
  historicalOutcome: string;
}

// Save a snapshot (call once per day or on significant change)
export async function saveSnapshot(snapshot: DailySnapshot): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    const store = tx.objectStore('snapshots');
    store.put(snapshot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Get all snapshots (for pattern matching)
export async function getSnapshots(): Promise<DailySnapshot[]> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readonly');
    const store = tx.objectStore('snapshots');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

// Prune old snapshots beyond MAX_SNAPSHOTS
export async function pruneSnapshots(): Promise<void> {
  const snapshots = await getSnapshots();
  if (snapshots.length <= MAX_SNAPSHOTS) return;

  const sorted = [...snapshots].sort((a, b) => b.timestamp - a.timestamp);
  const toDelete = sorted.slice(MAX_SNAPSHOTS);

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    const store = tx.objectStore('snapshots');
    for (const snap of toDelete) {
      store.delete(snap.timestamp);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Compare current CII pattern against historical snapshots
export function findPatternMatches(
  currentScores: Record<string, number>,
  snapshots: DailySnapshot[],
): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const snap of snapshots) {
    // Compare CII score vectors using cosine similarity
    const similarity = ciiSimilarity(currentScores, snap.ciiScores);
    if (similarity > 0.85) {
      // Check if there was a significant event within 3 days after this snapshot
      const followingSnaps = snapshots.filter(
        (s) => s.timestamp > snap.timestamp && s.timestamp < snap.timestamp + 3 * 86_400_000,
      );
      const ciiSpike = followingSnaps.some((s) => {
        return Object.entries(s.ciiScores).some(([code, score]) => {
          const prev = snap.ciiScores[code] ?? 0;
          return score - prev > 10; // 10+ point spike = significant event
        });
      });

      if (ciiSpike) {
        const spikedCountries = followingSnaps
          .flatMap((s) =>
            Object.entries(s.ciiScores)
              .filter(([code, score]) => score - (snap.ciiScores[code] ?? 0) > 10)
              .map(([code]) => code),
          )
          .filter((v, i, a) => a.indexOf(v) === i);

        matches.push({
          matchDate: snap.date,
          similarity,
          description: `CII pattern similar to ${snap.date}`,
          currentPattern: `Current CII distribution matches historical snapshot`,
          historicalOutcome: `Within 72h, CII spiked 10+ points for: ${spikedCountries.join(', ')}`,
        });
      }
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}

// Cosine similarity between two CII score dictionaries
function ciiSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const allKeys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  if (allKeys.length === 0) return 0;

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (const key of allKeys) {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    dotProduct += va * vb;
    magA += va * va;
    magB += vb * vb;
  }

  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
```

**Step 2: Commit**

```bash
git add src/services/pattern-memory.ts
git commit -m "feat: add 90-day pattern memory with historical CII matching"
```

---

## Task 5: Prediction Engine

**Files:**
- Create: `src/services/prediction-engine.ts`

**Step 1: Create the prediction engine**

Defines precursor checklists for common geopolitical scenarios. Checks current signals against precursors and generates confidence-rated predictions.

```typescript
// src/services/prediction-engine.ts

export interface Precursor {
  id: string;
  label: string;
  check: (state: DashboardState) => boolean;
}

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  precursors: Precursor[];
  minPrecursors: number;  // minimum to trigger prediction
}

export interface Prediction {
  scenarioId: string;
  scenarioName: string;
  confidence: number;        // 0-100
  precursorResults: { label: string; met: boolean }[];
  metCount: number;
  totalCount: number;
  description: string;
  timestamp: number;
}

export interface DashboardState {
  ciiScores: Record<string, number>;
  convergenceZones: { region: string; score: number; signalTypes: string[] }[];
  militaryFlightCount: number;
  militaryVesselCount: number;
  oilPriceChange: number;    // percent change
  marketChange: number;       // S&P percent change
  activeOutages: number;
  protestCount: number;
  headlines: string[];
  signalTypes: string[];
}

// Scenario definitions
const SCENARIOS: ScenarioTemplate[] = [
  {
    id: 'strait_disruption',
    name: 'Strait of Hormuz Disruption',
    description: 'Shipping disruption in the Strait of Hormuz likely within 72h',
    minPrecursors: 3,
    precursors: [
      {
        id: 'naval_buildup',
        label: 'Naval buildup detected',
        check: (s) => s.militaryVesselCount > 5,
      },
      {
        id: 'oil_spike',
        label: 'Oil price rising (>2%)',
        check: (s) => s.oilPriceChange > 2,
      },
      {
        id: 'news_velocity',
        label: 'News velocity spike for region',
        check: (s) => s.headlines.some((h) => /hormuz|houthi|iran.*navy|red\s?sea/i.test(h)),
      },
      {
        id: 'regional_cii',
        label: 'Regional CII elevated (>70)',
        check: (s) => ['IR', 'YE', 'SA', 'AE'].some((c) => (s.ciiScores[c] ?? 0) > 70),
      },
      {
        id: 'convergence',
        label: 'Multi-signal convergence in Middle East',
        check: (s) => s.convergenceZones.some((z) => z.region.includes('Middle East') && z.score > 50),
      },
    ],
  },
  {
    id: 'taiwan_escalation',
    name: 'Taiwan Strait Escalation',
    description: 'Military escalation in Taiwan Strait likely within 48h',
    minPrecursors: 3,
    precursors: [
      {
        id: 'military_flights',
        label: 'Elevated military flights near Taiwan',
        check: (s) => s.militaryFlightCount > 10,
      },
      {
        id: 'naval_presence',
        label: 'Naval vessels in East China Sea',
        check: (s) => s.militaryVesselCount > 3,
      },
      {
        id: 'cii_spike',
        label: 'China or Taiwan CII > 75',
        check: (s) => (s.ciiScores['CN'] ?? 0) > 75 || (s.ciiScores['TW'] ?? 0) > 75,
      },
      {
        id: 'diplomatic_news',
        label: 'Diplomatic tension in headlines',
        check: (s) => s.headlines.some((h) => /taiwan.*china|pla.*strait|adiz.*breach/i.test(h)),
      },
      {
        id: 'outages',
        label: 'Internet outages in region',
        check: (s) => s.activeOutages > 2,
      },
    ],
  },
  {
    id: 'market_crash',
    name: 'Market Correction',
    description: 'Significant market downturn likely within 24h',
    minPrecursors: 3,
    precursors: [
      {
        id: 'market_drop',
        label: 'Markets already declining (>1%)',
        check: (s) => s.marketChange < -1,
      },
      {
        id: 'oil_shock',
        label: 'Oil price shock (>5%)',
        check: (s) => Math.abs(s.oilPriceChange) > 5,
      },
      {
        id: 'geopolitical_crisis',
        label: 'Multiple critical CII scores',
        check: (s) => Object.values(s.ciiScores).filter((v) => v > 80).length >= 2,
      },
      {
        id: 'news_crisis',
        label: 'Crisis keywords in headlines',
        check: (s) => s.headlines.some((h) => /crash|collapse|default|sanction|war\s+declar/i.test(h)),
      },
      {
        id: 'convergence',
        label: 'High convergence score (>70)',
        check: (s) => s.convergenceZones.some((z) => z.score > 70),
      },
    ],
  },
  {
    id: 'cyber_escalation',
    name: 'Cyber Escalation',
    description: 'State-sponsored cyber campaign likely within 48h',
    minPrecursors: 3,
    precursors: [
      {
        id: 'outage_spike',
        label: 'Internet outage spike (>5)',
        check: (s) => s.activeOutages > 5,
      },
      {
        id: 'geopolitical_tension',
        label: 'Geopolitical tension elevated',
        check: (s) => Object.values(s.ciiScores).some((v) => v > 70),
      },
      {
        id: 'cyber_news',
        label: 'Cyber attack headlines',
        check: (s) => s.headlines.some((h) => /cyber.*attack|ransomware|zero.?day|apt\d|state.*hack/i.test(h)),
      },
      {
        id: 'diplomatic_breakdown',
        label: 'Diplomatic breakdown in headlines',
        check: (s) => s.headlines.some((h) => /sanction|expel.*diplomat|recall.*ambassador/i.test(h)),
      },
      {
        id: 'military_posture',
        label: 'Military posture elevated',
        check: (s) => s.militaryFlightCount > 5 || s.militaryVesselCount > 3,
      },
    ],
  },
];

// Run all scenarios against current state
export function evaluateScenarios(state: DashboardState): Prediction[] {
  const predictions: Prediction[] = [];

  for (const scenario of SCENARIOS) {
    const results = scenario.precursors.map((p) => ({
      label: p.label,
      met: p.check(state),
    }));

    const metCount = results.filter((r) => r.met).length;

    if (metCount >= scenario.minPrecursors) {
      const confidence = Math.round((metCount / scenario.precursors.length) * 100);
      predictions.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        confidence,
        precursorResults: results,
        metCount,
        totalCount: scenario.precursors.length,
        description: scenario.description,
        timestamp: Date.now(),
      });
    }
  }

  return predictions.sort((a, b) => b.confidence - a.confidence);
}

// Get all scenario templates (for display/reference)
export function getScenarioTemplates(): ScenarioTemplate[] {
  return SCENARIOS;
}
```

**Step 2: Commit**

```bash
git add src/services/prediction-engine.ts
git commit -m "feat: add prediction engine with 4 scenario templates and precursor checklists"
```

---

## Task 6: OSINT — Reddit Intelligence Feed

**Files:**
- Create: `src/services/osint/reddit.ts`

**Step 1: Create reddit intelligence service**

Fetches top posts from geopolitical subreddits via Reddit's public JSON API (no auth needed). Extracts trending topics and sentiment signals.

```typescript
// src/services/osint/reddit.ts

const SUBREDDITS = [
  'worldnews',
  'geopolitics',
  'osint',
  'UkraineRussiaReport',
  'CredibleDefense',
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface RedditPost {
  subreddit: string;
  title: string;
  score: number;
  numComments: number;
  url: string;
  createdUtc: number;
  permalink: string;
}

export interface RedditIntel {
  posts: RedditPost[];
  trendingTopics: string[];
  fetchedAt: number;
}

let cachedResult: RedditIntel | null = null;

export async function fetchRedditIntel(): Promise<RedditIntel> {
  // Return cache if fresh
  if (cachedResult && Date.now() - cachedResult.fetchedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const allPosts: RedditPost[] = [];

  // Fetch subreddits in parallel
  const results = await Promise.allSettled(
    SUBREDDITS.map((sub) => fetchSubreddit(sub)),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allPosts.push(...result.value);
    }
  }

  // Sort by score (most upvoted = most significant)
  const sorted = allPosts.sort((a, b) => b.score - a.score);
  const topPosts = sorted.slice(0, 25);

  // Extract trending topics (words appearing in 3+ top post titles)
  const trendingTopics = extractTrendingTopics(topPosts.map((p) => p.title));

  const intel: RedditIntel = {
    posts: topPosts,
    trendingTopics,
    fetchedAt: Date.now(),
  };

  cachedResult = intel;
  return intel;
}

async function fetchSubreddit(name: string): Promise<RedditPost[]> {
  try {
    const resp = await fetch(`https://www.reddit.com/r/${name}/hot.json?limit=10&raw_json=1`, {
      headers: { 'User-Agent': 'WorldMonitor/1.0 (dashboard)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    const children = data?.data?.children ?? [];

    return children
      .filter((c: { kind: string }) => c.kind === 't3')
      .map((c: { data: Record<string, unknown> }) => ({
        subreddit: name,
        title: String(c.data.title ?? ''),
        score: Number(c.data.score ?? 0),
        numComments: Number(c.data.num_comments ?? 0),
        url: String(c.data.url ?? ''),
        createdUtc: Number(c.data.created_utc ?? 0) * 1000,
        permalink: `https://reddit.com${c.data.permalink ?? ''}`,
      }));
  } catch {
    return [];
  }
}

function extractTrendingTopics(titles: string[]): string[] {
  const wordCounts = new Map<string, number>();
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her', 'was', 'one', 'our', 'out', 'his', 'had', 'its', 'say', 'she', 'which', 'their', 'will', 'from', 'this', 'that', 'with', 'have', 'been', 'they', 'than', 'more', 'some', 'what', 'when', 'who', 'how', 'about', 'would', 'into', 'could', 'after', 'over', 'just']);

  for (const title of titles) {
    const words = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    const unique = [...new Set(words)];
    for (const word of unique) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  return [...wordCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
```

**Step 2: Commit**

```bash
git add src/services/osint/reddit.ts
git commit -m "feat: add Reddit intelligence feed from geopolitical subreddits"
```

---

## Task 7: OSINT — Breach Monitor (HIBP)

**Files:**
- Create: `src/services/osint/breach-monitor.ts`

**Step 1: Create breach monitor service**

Checks watched domains against the HIBP breach database.

```typescript
// src/services/osint/breach-monitor.ts

const HIBP_API = 'https://haveibeenpwned.com/api/v3';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (breach data doesn't change fast)

export interface BreachInfo {
  name: string;
  title: string;
  domain: string;
  breachDate: string;
  addedDate: string;
  pwnCount: number;
  description: string;
  dataClasses: string[];
}

let cachedBreaches: Map<string, BreachInfo[]> = new Map();
let lastFetchTime = 0;

// Fetch recent breaches from HIBP (no auth needed for this endpoint)
export async function fetchRecentBreaches(): Promise<BreachInfo[]> {
  if (Date.now() - lastFetchTime < CACHE_TTL_MS && cachedBreaches.size > 0) {
    return [...cachedBreaches.values()].flat();
  }

  try {
    const resp = await fetch(`${HIBP_API}/breaches`, {
      headers: {
        'User-Agent': 'WorldMonitor-Dashboard',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return [];

    const data: BreachInfo[] = await resp.json();

    // Only keep breaches from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recent = data.filter((b) => new Date(b.addedDate) > thirtyDaysAgo);

    // Index by domain
    cachedBreaches = new Map();
    for (const breach of recent) {
      const domain = breach.domain.toLowerCase();
      const existing = cachedBreaches.get(domain) ?? [];
      cachedBreaches.set(domain, [...existing, breach]);
    }

    lastFetchTime = Date.now();
    return recent;
  } catch {
    return [];
  }
}

// Check if any watched domains have been breached
export async function checkWatchedDomains(domains: string[]): Promise<BreachInfo[]> {
  await fetchRecentBreaches();

  const matches: BreachInfo[] = [];
  for (const domain of domains) {
    const breaches = cachedBreaches.get(domain.toLowerCase());
    if (breaches) {
      matches.push(...breaches);
    }
  }

  return matches;
}

// Get breach statistics for intelligence feed
export async function getBreachStats(): Promise<{
  recentCount: number;
  totalPwned: number;
  topBreaches: BreachInfo[];
}> {
  const breaches = await fetchRecentBreaches();
  const sorted = [...breaches].sort((a, b) => b.pwnCount - a.pwnCount);

  return {
    recentCount: breaches.length,
    totalPwned: breaches.reduce((sum, b) => sum + b.pwnCount, 0),
    topBreaches: sorted.slice(0, 5),
  };
}
```

**Step 2: Commit**

```bash
git add src/services/osint/breach-monitor.ts
git commit -m "feat: add HIBP breach monitor for watchlist domains"
```

---

## Task 8: OSINT — Flight Anomaly Detection

**Files:**
- Create: `src/services/osint/flight-anomalies.ts`

**Step 1: Create flight anomaly detector**

Analyzes existing military flight data for unusual patterns: circling, unusual squawk codes, and holding patterns.

```typescript
// src/services/osint/flight-anomalies.ts

import type { MilitaryFlight } from '@/types';

export interface FlightAnomaly {
  callsign: string;
  type: 'circling' | 'squawk_emergency' | 'unusual_altitude' | 'dark_transponder';
  description: string;
  lat: number;
  lon: number;
  detectedAt: number;
  severity: 'low' | 'medium' | 'high';
}

// Track recent positions per callsign for pattern detection
const positionHistory: Map<string, { lat: number; lon: number; ts: number }[]> = new Map();
const MAX_HISTORY_PER_FLIGHT = 20;
const HISTORY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Emergency squawk codes
const EMERGENCY_SQUAWKS = new Map([
  ['7500', 'hijack'],
  ['7600', 'radio failure'],
  ['7700', 'general emergency'],
]);

export function detectAnomalies(flights: MilitaryFlight[]): FlightAnomaly[] {
  const anomalies: FlightAnomaly[] = [];
  const now = Date.now();

  for (const flight of flights) {
    const callsign = flight.callsign || 'UNKNOWN';
    const lat = flight.latitude ?? 0;
    const lon = flight.longitude ?? 0;

    if (lat === 0 && lon === 0) continue;

    // Update position history
    const history = positionHistory.get(callsign) ?? [];
    const filtered = history.filter((p) => now - p.ts < HISTORY_WINDOW_MS);
    filtered.push({ lat, lon, ts: now });
    positionHistory.set(callsign, filtered.slice(-MAX_HISTORY_PER_FLIGHT));

    // Check for circling pattern (3+ positions within small radius)
    if (filtered.length >= 5) {
      const isCircling = detectCirclingPattern(filtered);
      if (isCircling) {
        anomalies.push({
          callsign,
          type: 'circling',
          description: `${callsign} circling over area for ${Math.round((now - filtered[0].ts) / 60000)} minutes`,
          lat, lon,
          detectedAt: now,
          severity: 'medium',
        });
      }
    }

    // Check squawk codes
    const squawk = (flight as Record<string, unknown>).squawk as string | undefined;
    if (squawk && EMERGENCY_SQUAWKS.has(squawk)) {
      anomalies.push({
        callsign,
        type: 'squawk_emergency',
        description: `${callsign} squawking ${squawk} (${EMERGENCY_SQUAWKS.get(squawk)})`,
        lat, lon,
        detectedAt: now,
        severity: 'high',
      });
    }

    // Check unusual altitude (military aircraft below 1000ft or above 60000ft)
    const altitude = (flight as Record<string, unknown>).altitude as number | undefined;
    if (altitude !== undefined) {
      if (altitude < 1000 && altitude > 0) {
        anomalies.push({
          callsign,
          type: 'unusual_altitude',
          description: `${callsign} at very low altitude (${altitude}ft)`,
          lat, lon,
          detectedAt: now,
          severity: 'medium',
        });
      }
    }
  }

  // Prune old position histories
  for (const [key, hist] of positionHistory.entries()) {
    if (hist.length === 0 || now - hist[hist.length - 1].ts > HISTORY_WINDOW_MS) {
      positionHistory.delete(key);
    }
  }

  return anomalies;
}

function detectCirclingPattern(positions: { lat: number; lon: number }[]): boolean {
  if (positions.length < 5) return false;

  // Calculate centroid
  const avgLat = positions.reduce((s, p) => s + p.lat, 0) / positions.length;
  const avgLon = positions.reduce((s, p) => s + p.lon, 0) / positions.length;

  // Check if all positions are within ~10km of centroid
  const maxDistKm = 15;
  const allNearCentroid = positions.every((p) => {
    const distKm = haversineKm(p.lat, p.lon, avgLat, avgLon);
    return distKm < maxDistKm;
  });

  if (!allNearCentroid) return false;

  // Check that the path covers significant angular range (not just hovering)
  const angles = positions.map((p) => Math.atan2(p.lat - avgLat, p.lon - avgLon));
  const angleRange = Math.max(...angles) - Math.min(...angles);

  return angleRange > Math.PI; // More than 180 degrees of arc = circling
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

**Step 2: Commit**

```bash
git add src/services/osint/flight-anomalies.ts
git commit -m "feat: add flight anomaly detection (circling, emergency squawks, unusual altitude)"
```

---

## Task 9: OSINT — AIS Dark Zone Detection

**Files:**
- Create: `src/services/osint/ais-dark-zones.ts`

**Step 1: Create AIS dark zone detector**

Tracks vessels that stop transmitting in sensitive areas (sanctions evasion, military operations).

```typescript
// src/services/osint/ais-dark-zones.ts

export interface VesselTrack {
  mmsi: string;
  name: string;
  lastLat: number;
  lastLon: number;
  lastSeen: number;   // epoch ms
}

export interface DarkZoneAlert {
  mmsi: string;
  vesselName: string;
  lastLat: number;
  lastLon: number;
  lastSeenAt: number;
  darkDuration: number;   // ms since last seen
  zone: string;           // name of sensitive zone
  severity: 'low' | 'medium' | 'high';
}

// Sensitive zones where transponder-off is suspicious
const SENSITIVE_ZONES: { name: string; lat: number; lon: number; radiusKm: number }[] = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.2, radiusKm: 150 },
  { name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, radiusKm: 100 },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, radiusKm: 200 },
  { name: 'Taiwan Strait', lat: 24.0, lon: 119.5, radiusKm: 150 },
  { name: 'Black Sea', lat: 43.0, lon: 34.0, radiusKm: 300 },
  { name: 'South China Sea', lat: 14.0, lon: 114.0, radiusKm: 400 },
  { name: 'Baltic Sea', lat: 58.0, lon: 20.0, radiusKm: 200 },
  { name: 'North Korean Waters', lat: 39.0, lon: 127.0, radiusKm: 200 },
  { name: 'Venezuelan Coast', lat: 10.5, lon: -66.0, radiusKm: 200 },
  { name: 'Iranian Coast', lat: 27.0, lon: 54.0, radiusKm: 250 },
];

// Track known vessels
const vesselRegistry: Map<string, VesselTrack> = new Map();
const DARK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes without signal = "dark"

// Update vessel positions from AIS stream
export function updateVesselPositions(vessels: { mmsi: string; name: string; lat: number; lon: number }[]): void {
  const now = Date.now();
  for (const v of vessels) {
    vesselRegistry.set(v.mmsi, {
      mmsi: v.mmsi,
      name: v.name || v.mmsi,
      lastLat: v.lat,
      lastLon: v.lon,
      lastSeen: now,
    });
  }

  // Prune vessels not seen in 24h
  for (const [mmsi, track] of vesselRegistry.entries()) {
    if (now - track.lastSeen > 24 * 60 * 60 * 1000) {
      vesselRegistry.delete(mmsi);
    }
  }
}

// Check for vessels that went dark in sensitive zones
export function detectDarkZones(): DarkZoneAlert[] {
  const now = Date.now();
  const alerts: DarkZoneAlert[] = [];

  for (const [, vessel] of vesselRegistry.entries()) {
    const darkDuration = now - vessel.lastSeen;

    // Only flag if dark for more than threshold
    if (darkDuration < DARK_THRESHOLD_MS) continue;

    // Check if last known position was in a sensitive zone
    for (const zone of SENSITIVE_ZONES) {
      const distKm = haversineKm(vessel.lastLat, vessel.lastLon, zone.lat, zone.lon);
      if (distKm <= zone.radiusKm) {
        const severity = darkDuration > 6 * 60 * 60 * 1000 ? 'high'
          : darkDuration > 2 * 60 * 60 * 1000 ? 'medium'
          : 'low';

        alerts.push({
          mmsi: vessel.mmsi,
          vesselName: vessel.name,
          lastLat: vessel.lastLat,
          lastLon: vessel.lastLon,
          lastSeenAt: vessel.lastSeen,
          darkDuration,
          zone: zone.name,
          severity,
        });
        break; // One zone per vessel
      }
    }
  }

  return alerts.sort((a, b) => b.darkDuration - a.darkDuration);
}

// Summary for signal aggregator
export function getDarkZoneSummary(): { totalDark: number; byZone: Record<string, number> } {
  const alerts = detectDarkZones();
  const byZone: Record<string, number> = {};
  for (const alert of alerts) {
    byZone[alert.zone] = (byZone[alert.zone] ?? 0) + 1;
  }
  return { totalDark: alerts.length, byZone };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

**Step 2: Commit**

```bash
git add src/services/osint/ais-dark-zones.ts
git commit -m "feat: add AIS dark zone detection for 10 sensitive maritime zones"
```

---

## Task 10: Telegram Daily Digest Cron Endpoint

**Files:**
- Create: `api/cron/daily-digest.js`
- Modify: `vercel.json` (add cron schedule)

**Step 1: Create the daily digest endpoint**

Vercel Cron Job that fires at 8:00 PM ET daily. Collects top events, risk shifts, and market data, generates an AI insight via Groq, then sends a structured Telegram message.

```javascript
// api/cron/daily-digest.js
export const config = { runtime: 'edge' };

export default async function handler(request) {
  // Verify cron secret (Vercel sets this header)
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return new Response(JSON.stringify({ error: 'Telegram not configured' }), { status: 503 });
  }

  try {
    // Collect data from multiple sources in parallel
    const [headlines, quoteData] = await Promise.allSettled([
      fetchTopHeadlines(),
      fetchMarketSnapshot(),
    ]);

    const headlineText = headlines.status === 'fulfilled' ? headlines.value : 'Headlines unavailable';
    const marketText = quoteData.status === 'fulfilled' ? quoteData.value : 'Market data unavailable';

    // Generate AI insight via Groq
    const insight = await generateInsight(headlineText, marketText);

    // Build Telegram message
    const now = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York',
    });

    const message = [
      `📊 *WORLD MONITOR — Evening Digest*`,
      `_${escapeMarkdown(now)}_`,
      ``,
      `📰 *TOP STORIES*`,
      escapeMarkdown(headlineText),
      ``,
      `📈 *MARKETS*`,
      escapeMarkdown(marketText),
      ``,
      `🧠 *AI INSIGHT*`,
      escapeMarkdown(insight),
    ].join('\n');

    await sendTelegram(botToken, chatId, message);

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error('[daily-digest] Failed:', err);
    return new Response(JSON.stringify({ error: 'Digest failed' }), { status: 500 });
  }
}

async function fetchTopHeadlines() {
  // Use GDELT API for recent headlines
  try {
    const resp = await fetch(
      'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang:eng&mode=artlist&maxrecords=5&format=json&sort=hybridrel',
      { signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) return 'Could not fetch headlines';
    const data = await resp.json();
    const articles = data?.articles ?? [];
    return articles
      .slice(0, 5)
      .map((a, i) => `${i + 1}\\. ${a.title}`)
      .join('\n') || 'No headlines available';
  } catch {
    return 'Headlines fetch timed out';
  }
}

async function fetchMarketSnapshot() {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return 'Market data not configured';

  const symbols = ['SPY', 'QQQ', 'GLD', 'USO'];
  const quotes = [];

  for (const symbol of symbols) {
    try {
      const resp = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (resp.ok) {
        const q = await resp.json();
        const change = q.dp ? `${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%` : 'N/A';
        quotes.push(`${symbol}: $${q.c?.toFixed(2) ?? 'N/A'} (${change})`);
      }
    } catch { /* skip */ }
  }

  return quotes.join(' | ') || 'Market data unavailable';
}

async function generateInsight(headlines, markets) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return 'AI insight unavailable (no API key)';

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'You are a senior intelligence analyst. Given today\'s headlines and market data, provide a 2-sentence insight connecting the dots. Focus on what matters and what to watch. Be direct.',
          },
          {
            role: 'user',
            content: `Headlines:\n${headlines}\n\nMarkets:\n${markets}\n\nWhat's the key insight?`,
          },
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return 'AI insight generation failed';
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || 'No insight generated';
  } catch {
    return 'AI insight timed out';
  }
}

async function sendTelegram(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
```

**Step 2: Add cron config to vercel.json**

Add to the top level of `vercel.json`:
```json
"crons": [
  {
    "path": "/api/cron/daily-digest",
    "schedule": "0 0 * * *"
  }
]
```

Note: `0 0 * * *` = midnight UTC = 8 PM ET. Vercel cron requires the Hobby plan (free) or Pro.

**Step 3: Add CRON_SECRET to .env.example**

```
# Vercel Cron Job secret (set automatically by Vercel, or generate with: openssl rand -hex 16)
CRON_SECRET=
```

**Step 4: Commit**

```bash
git add api/cron/daily-digest.js vercel.json .env.example
git commit -m "feat: add daily Telegram digest cron with AI insight generation"
```

---

## Task 11: Smart Monitor Check Cron (Event-Driven Alerts)

**Files:**
- Create: `api/cron/monitor-check.js`

**Step 1: Create the monitor check endpoint**

Runs every 15 minutes. Checks CII deltas, market moves, and convergence scores against thresholds. Only sends Telegram when something crosses a threshold.

```javascript
// api/cron/monitor-check.js
export const config = { runtime: 'edge' };

const THRESHOLDS = {
  ciiDelta: 8,           // CII points change
  marketMove: 3,         // percent
  convergenceScore: 65,  // out of 100
};

export default async function handler(request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return new Response(JSON.stringify({ skipped: true, reason: 'Telegram not configured' }), { status: 200 });
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    // Check market data for big moves
    const alerts = [];

    const marketAlert = await checkMarketMoves();
    if (marketAlert) alerts.push(marketAlert);

    // Check GDELT for breaking crisis news
    const crisisAlert = await checkCrisisNews();
    if (crisisAlert) alerts.push(crisisAlert);

    if (alerts.length === 0) {
      return new Response(JSON.stringify({ ok: true, alerts: 0 }), { status: 200 });
    }

    // Deduplicate against recent alerts via Redis
    const newAlerts = [];
    for (const alert of alerts) {
      const isDupe = await isRecentlyAlerted(redisUrl, redisToken, alert.key);
      if (!isDupe) {
        newAlerts.push(alert);
        await markAlerted(redisUrl, redisToken, alert.key);
      }
    }

    if (newAlerts.length === 0) {
      return new Response(JSON.stringify({ ok: true, alerts: 0, deduplicated: alerts.length }), { status: 200 });
    }

    // Send alerts to Telegram
    for (const alert of newAlerts) {
      const emoji = alert.severity === 'critical' ? '🔴' : '🟡';
      const message = `${emoji} *MONITOR ALERT*\n\n*${escapeMarkdown(alert.title)}*\n${escapeMarkdown(alert.body)}`;

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
    }

    return new Response(JSON.stringify({ ok: true, alerts: newAlerts.length }), { status: 200 });
  } catch (err) {
    console.error('[monitor-check] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}

async function checkMarketMoves() {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return null;

  try {
    const resp = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=SPY&token=${finnhubKey}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return null;
    const q = await resp.json();

    if (Math.abs(q.dp) > THRESHOLDS.marketMove) {
      const direction = q.dp > 0 ? 'surged' : 'dropped';
      return {
        key: `market-spy-${Math.floor(Date.now() / 3600000)}`,
        severity: Math.abs(q.dp) > 5 ? 'critical' : 'warning',
        title: `S&P 500 ${direction} ${Math.abs(q.dp).toFixed(1)}%`,
        body: `SPY at $${q.c?.toFixed(2)}. Day change: ${q.dp > 0 ? '+' : ''}${q.dp.toFixed(2)}%. This is a significant move.`,
      };
    }
  } catch { /* skip */ }
  return null;
}

async function checkCrisisNews() {
  try {
    const resp = await fetch(
      'https://api.gdeltproject.org/api/v2/doc/doc?query=(war OR missile OR earthquake OR tsunami OR nuclear) sourcelang:eng&mode=artlist&maxrecords=3&format=json&sort=datedesc',
      { signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const articles = data?.articles ?? [];

    if (articles.length > 0) {
      const top = articles[0];
      const title = top.title || 'Breaking crisis news detected';
      // Only alert if the article is less than 2 hours old
      const articleDate = new Date(top.seendate || 0);
      if (Date.now() - articleDate.getTime() > 2 * 60 * 60 * 1000) return null;

      return {
        key: `crisis-${title.slice(0, 30).replace(/\s/g, '-').toLowerCase()}-${Math.floor(Date.now() / 3600000)}`,
        severity: 'warning',
        title: 'Crisis News Detected',
        body: title.slice(0, 200),
      };
    }
  } catch { /* skip */ }
  return null;
}

async function isRecentlyAlerted(redisUrl, redisToken, key) {
  if (!redisUrl || !redisToken) return false;
  try {
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(`alert:${key}`)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.result !== null;
  } catch {
    return false;
  }
}

async function markAlerted(redisUrl, redisToken, key) {
  if (!redisUrl || !redisToken) return;
  try {
    await fetch(`${redisUrl}/set/${encodeURIComponent(`alert:${key}`)}/1/EX/3600`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* best effort */ }
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
```

**Step 2: Add to vercel.json crons**

```json
{
  "path": "/api/cron/monitor-check",
  "schedule": "*/15 * * * *"
}
```

**Step 3: Commit**

```bash
git add api/cron/monitor-check.js vercel.json
git commit -m "feat: add 15-min smart monitor check cron with deduplication"
```

---

## Task 12: Wire OSINT + Predictions into App.ts

**Files:**
- Modify: `src/App.ts` — import and call new services
- Modify: `src/services/signal-aggregator.ts` — accept OSINT signals

**Step 1: Add imports and wiring in App.ts**

Add imports for the new services and call them in the appropriate loading sections:

```typescript
// New imports to add
import { fetchRedditIntel } from '@/services/osint/reddit';
import { detectAnomalies } from '@/services/osint/flight-anomalies';
import { updateVesselPositions, detectDarkZones } from '@/services/osint/ais-dark-zones';
import { evaluateScenarios, type DashboardState } from '@/services/prediction-engine';
import { saveSnapshot, getSnapshots, findPatternMatches, pruneSnapshots } from '@/services/pattern-memory';
import { checkWatchlist } from '@/services/watchlist';
```

In the data loading cycle, after existing military/maritime data loads:

```typescript
// After military flights load:
const flightAnomalies = detectAnomalies(militaryFlights);
for (const anomaly of flightAnomalies) {
  this.alertCenter.push(
    anomaly.severity === 'high' ? 'critical' : 'warning',
    `Flight Anomaly: ${anomaly.callsign}`,
    anomaly.description,
    'flight-anomaly',
  );
}

// After AIS vessel data loads:
updateVesselPositions(vessels.map(v => ({ mmsi: v.mmsi, name: v.name, lat: v.lat, lon: v.lon })));
const darkZones = detectDarkZones();
for (const dz of darkZones) {
  if (dz.severity !== 'low') {
    this.alertCenter.push(
      'warning',
      `Vessel Dark: ${dz.vesselName}`,
      `Last seen near ${dz.zone} ${Math.round(dz.darkDuration / 60000)}min ago`,
      'dark-zone',
    );
  }
}

// Reddit OSINT (fire-and-forget, non-blocking):
fetchRedditIntel().then(intel => {
  // Make reddit data available to chat context
  this.redditIntel = intel;
}).catch(() => {});

// Predictions (after CII scores are calculated):
const dashState: DashboardState = {
  ciiScores: Object.fromEntries(ciiScores.map(s => [s.code, s.score])),
  convergenceZones: signalSummary.convergenceZones.map(z => ({
    region: z.region,
    score: /* convergence score */ 0,
    signalTypes: z.signalTypes,
  })),
  militaryFlightCount: militaryFlights.length,
  militaryVesselCount: militaryVessels.length,
  oilPriceChange: oilChangePercent,
  marketChange: spyChangePercent,
  activeOutages: outages.length,
  protestCount: protests.length,
  headlines: newsItems.map(n => n.title),
  signalTypes: [...signalSummary.byType.keys()],
};

const predictions = evaluateScenarios(dashState);
for (const pred of predictions) {
  this.alertCenter.push(
    pred.confidence > 75 ? 'critical' : 'warning',
    `🔮 ${pred.scenarioName} (${pred.confidence}%)`,
    `${pred.metCount}/${pred.totalCount} precursors met. ${pred.description}`,
    'prediction',
  );
}

// Watchlist check
const watchMatches = checkWatchlist(
  newsItems.map(n => n.title),
  signals.map(s => s.title),
);
for (const match of watchMatches) {
  this.alertCenter.push('warning', `Watchlist: ${match.query}`, match.matchedSignal, 'watchlist');
}
```

**Step 2: Update getChatContext() to include OSINT data**

Add reddit trending topics and predictions to the chat context string.

**Step 3: Commit**

```bash
git add src/App.ts src/services/signal-aggregator.ts
git commit -m "feat: wire OSINT feeds, predictions, and watchlist into main app loop"
```

---

## Task 13: Final Integration — Export New Modules

**Files:**
- Modify: `src/services/index.ts` — add exports for new modules

**Step 1: Add exports**

```typescript
// Add to src/services/index.ts
export * from './watchlist';
export * from './prediction-engine';
export * from './pattern-memory';
export * from './osint/reddit';
export * from './osint/breach-monitor';
export * from './osint/flight-anomalies';
export * from './osint/ais-dark-zones';
```

**Step 2: Build and verify**

```bash
npm run build
```

Fix any TypeScript errors that come up.

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete Wave 2 — smarter AI, OSINT, predictions, event-driven alerts"
```

---

## Execution Order Summary

| Task | Feature | Dependencies |
|------|---------|-------------|
| 1 | Chat API endpoint | None |
| 2 | ChatPanel upgrade | Task 1 |
| 3 | Watchlist service | None |
| 4 | Pattern memory | None |
| 5 | Prediction engine | None |
| 6 | Reddit OSINT | None |
| 7 | Breach monitor | None |
| 8 | Flight anomalies | None |
| 9 | AIS dark zones | None |
| 10 | Daily digest cron | None |
| 11 | Monitor check cron | None |
| 12 | Wire into App.ts | Tasks 1-9 |
| 13 | Final integration + build | Task 12 |

Tasks 1, 3-11 can be done in parallel. Tasks 2 depends on 1. Task 12 depends on 1-9. Task 13 depends on 12.
