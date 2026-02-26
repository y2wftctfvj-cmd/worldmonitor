# World Monitor — Complete Project Reference

**Version 2.7.0 | February 26, 2026**

---

## What This Is

World Monitor is a geopolitical intelligence platform. It has three interfaces:

1. **Web dashboard** — Interactive 3D globe with 35+ map layers, news panels, market data, OSINT feeds
2. **Telegram bot** — "Monitor", a conversational intelligence analyst with tool-calling, memory, and watchlists
3. **Desktop app** — Tauri 2.x native app (macOS/Windows/Linux) with local API server

The core intelligence loop runs every 5 minutes via QStash: collect data from 9 sources in parallel, feed it all to an AI model, and push alerts to Telegram when something notable happens.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla TypeScript + Vite 6 (no React/Vue) |
| Map | deck.gl 9 + MapLibre GL 5 (WebGL, 3D globe) |
| Charts | D3 7 |
| i18n | i18next (16 languages including RTL Arabic) |
| ML | Transformers.js (T5 classification in SharedWorker) |
| Backend | Vercel Edge Functions (Node.js 18+) |
| Cache | Upstash Redis (REST API) |
| Cron | Upstash QStash (5-min schedule) |
| Desktop | Tauri 2.10 (Rust backend, Node.js sidecar) |
| LLM (bot chat) | Qwen 3.5 Plus via OpenRouter (1M context, tool-calling) |
| LLM (analysis) | Groq Llama 3.3 70B (free, 500 tok/s) |
| LLM (fallback) | DeepSeek V3.2 via OpenRouter |
| Analytics | PostHog + Sentry |

---

## Project Structure

```
worldmonitor/
├── api/                        # Vercel API routes (Edge + Serverless)
│   ├── monitor-check.js        # 5-min AI intelligence cycle (755 LOC)
│   ├── telegram-webhook.js     # Telegram bot handler (972 LOC)
│   ├── daily-digest.js         # Daily briefing generator (431 LOC)
│   ├── chat.js                 # Conversational LLM endpoint (276 LOC)
│   ├── tools/
│   │   ├── monitor-tools.js    # All data fetchers (755 LOC)
│   │   └── prediction-markets.js # Polymarket integration (120 LOC)
│   ├── story.js                # Social meta tag generator
│   ├── og-story.js             # Dynamic OG image SVG
│   ├── rss-proxy.js            # CORS bridge for RSS
│   ├── setup-qstash.js         # One-time QStash schedule creation
│   ├── _cors.js                # Shared CORS utility
│   └── [15+ more edge functions]
│
├── server/                     # Protobuf RPC services (17 domains)
│   ├── router.ts               # Request dispatcher
│   ├── _shared/                # Redis cache, LLM calls, proto parsing
│   └── worldmonitor/*/v1/      # aviation, climate, conflict, cyber, displacement,
│                                 economic, infrastructure, intelligence, maritime,
│                                 market, military, news, prediction, research,
│                                 seismology, unrest, wildfire
│
├── src/                        # Frontend (~73K LOC)
│   ├── components/             # 58 UI panels/components
│   ├── services/               # 86 data service modules
│   ├── workers/                # Web Workers (analysis, ML)
│   ├── locales/                # 16 language files
│   ├── styles/                 # CSS themes
│   └── utils/                  # Helpers
│
├── src-tauri/                  # Desktop app (Rust + Tauri 2.x)
│   ├── src/                    # Rust backend
│   ├── sidecar/
│   │   └── local-api-server.mjs # Node.js sidecar (all API handlers locally)
│   └── tauri.conf.json         # Desktop build config
│
├── proto/                      # Protobuf definitions (17 services)
├── e2e/                        # Playwright E2E tests
├── scripts/                    # Build + deployment scripts
├── public/                     # Static assets + geojson baselines
├── middleware.ts               # Vercel Edge Middleware (bot blocking)
├── vite.config.ts              # Build config with variant system
├── vercel.json                 # Vercel project config
└── package.json                # v2.7.0
```

---

## The Intelligence Loop (monitor-check.js)

Runs every 5 minutes via QStash. This is the core of the product.

```
TRIGGER: QStash POST → /api/monitor-check (Bearer token auth)
                ↓
1. COLLECT (8s timeout, all parallel)
   ├─ Google News (10 headlines)
   ├─ Yahoo Finance (SPY, Oil, Gold, VIX, BTC, 10Y)
   ├─ Telegram OSINT (15 channels, 3 posts each)
   ├─ Reddit (12 subreddits, 3 posts each, batched 4 at a time)
   ├─ Polymarket (top 20 geopolitical markets)
   ├─ USGS Earthquakes (M4.5+, last hour)
   ├─ Cloudflare Radar (internet outages)
   ├─ GDELT (military news, last 2h)
   └─ Wire RSS (Reuters, State Dept, War on the Rocks)
                ↓
2. BUILD SNAPSHOT (all data → single text string, max 500KB)
                ↓
3. LOAD PREVIOUS CONTEXT (from Redis)
   ├─ Previous cycle snapshot (for diff detection)
   ├─ All user watchlists (SCAN watchlist:*)
   └─ Developing items (multi-cycle tracking)
                ↓
4. AI ANALYSIS (10s timeout)
   ├─ Input: current + previous snapshot + watchlist + developing items
   ├─ Primary: Groq Llama 3.3 70B (free, fast)
   ├─ Fallback: DeepSeek V3.2 via OpenRouter
   ├─ Output: JSON { findings[], situation_summary }
   ├─ Each finding: { severity, title, analysis, sources, watchlist_match, watch_next }
   └─ Severity: routine | notable | urgent | developing
                ↓
5. FILTER & ALERT
   ├─ Skip routine findings
   ├─ Cross-source verification: Telegram-only claims → downgrade to "developing"
   ├─ Jaccard word similarity dedup (>0.4 threshold vs last 50 titles, 2h window)
   └─ Send notable/urgent findings to Telegram via sendMessage API
                ↓
6. TRACK
   ├─ Update developing items in Redis (3-cycle threshold → alert)
   └─ Save snapshot for next cycle (600s TTL)
```

**Key constraints:**
- Edge runtime = 25 second hard limit (Vercel Hobby plan)
- Collection + LLM + Redis + Telegram must all fit in 25s
- Collection timeout: 8s. LLM timeout: 10s. Overhead budget: 5s.

---

## Telegram Bot (telegram-webhook.js)

Webhook: `POST /api/telegram-webhook?token={CRON_SECRET}`

### Commands
| Command | Action |
|---------|--------|
| `/watch <term>` | Add to watchlist (max 20). Checked every 5-min cycle. |
| `/unwatch <term>` | Remove from watchlist |
| `/watches` | List active watchlist |
| `/brief` | Full intelligence briefing (fetches all sources) |
| `/status` | Quick: markets + top headlines |
| `/clear` | Delete conversation history |

### How it works
1. Parse Telegram update → extract text + chat_id
2. Check for slash commands (handled before LLM)
3. Load conversation history from Redis (last 30 messages, 48h TTL)
4. Fetch live context in parallel (8s timeout): news, markets, Reddit, Telegram, topic search
5. Build messages: system prompt (Monitor persona) + context + history + user message
6. Call LLM with tool definitions (max 3 tool calls per turn)
7. Save user message + assistant reply to Redis
8. Send reply to Telegram (split at 4096 chars, Markdown with plain text fallback)

### Tools available to the bot
| Tool | Purpose |
|------|---------|
| `search_news(query)` | Fetch topic-specific headlines |
| `check_markets(symbols?)` | Current prices for given symbols |
| `search_telegram(query)` | Filter recent Telegram OSINT posts |
| `search_reddit(query)` | Search geopolitical subreddits |
| `check_predictions(query)` | Polymarket odds for a topic |
| `check_earthquakes()` | Recent M4.5+ quakes |
| `check_flights(region?)` | GDELT military activity |

### LLM provider chain (for chat)
1. Qwen 3.5 Plus via OpenRouter (1M context, tool-calling, $0.40/$2.40 per M)
2. DeepSeek V3.2 via OpenRouter (164K context, tool-calling)
3. Groq Llama 3.1 8B (emergency — no tool-calling)

---

## Data Fetchers (api/tools/monitor-tools.js)

| Function | Source | Timeout | Returns |
|----------|--------|---------|---------|
| `fetchGoogleNewsHeadlines()` | Google News RSS | 5s | 10 headlines |
| `fetchTopicNews(query)` | Google News search RSS | 5s | 5 articles |
| `fetchMarketQuotes()` | Yahoo Finance v7+v8 | 5s | 6 symbols |
| `fetchAllTelegramChannels()` | t.me/s/ web scrape | 5s/ch | 15 channels, 3 posts each |
| `fetchAllRedditPosts()` | reddit.com JSON | 5s/batch | 12 subs, batched 4 at a time |
| `fetchEarthquakes()` | USGS GeoJSON | 8s | M4.5+, last hour |
| `fetchInternetOutages(token)` | Cloudflare Radar | 8s | Country-level outages |
| `fetchMilitaryNews()` | GDELT | 8s | 30 articles, last 2h |
| `fetchGovFeeds()` | RSS (Reuters, State, WotR) | 8s | 3 items per feed |
| `fetchGeopoliticalMarkets()` | Polymarket Gamma API | 8s | Top 20 markets (5-min cache) |
| `searchPredictionMarkets(query)` | Polymarket Gamma API | 8s | 10 results |

### Telegram OSINT channels (15)
```
intelslava, militarysummary, RVvoenkor, breakingmash, legitimniy,
usaperiodical, osintdefender, BellumActaNews, OsintTv, IntelRepublic,
iranintl_en, CIG_telegram, combatftg, GeneralMCNews, rnintelligence
```

### Reddit subreddits (12)
```
worldnews, geopolitics, osint, CredibleDefense, internationalsecurity,
middleeastwar, iranpolitics, CombatFootage, WarCollege, netsec,
cybersecurity, wallstreetbets
```

---

## Redis Key Structure

| Key | TTL | Contents |
|-----|-----|----------|
| `monitor:snapshot` | 600s (10 min) | Full data snapshot from last cycle |
| `monitor:developing` | 3600s (1h) | Array of `{topic, count, lastSeen}` |
| `monitor:recent-alerts` | 7200s (2h) | Array of last 50 alert title strings |
| `watchlist:{chatId}` | None (persist) | Array of `{term, addedAt}` |
| `chat:{chatId}:history` | 172800s (48h) | Array of `{role, content, ts}` (max 30) |
| `summary:v3:{mode}:{variant}:{lang}:{hash}` | 86400s (24h) | Cached AI briefing |
| `risk:scores:{country}` | 86400s (24h) | CII scores + components |
| `country-intel:{country}` | 86400s (24h) | Full country brief |
| `gdelt:{query}:{variant}` | 14400s (4h) | GDELT search cache |

**Upstash REST API patterns:**
- GET: `GET /get/{key}`
- SET (small): `POST /set/{key}/{value}/ex/{ttl}`
- SET (large): `POST /pipeline` with `[["SET", key, value, "EX", ttl]]`
- SCAN: `GET /scan/0/match/{pattern}/count/100`
- Batch: `POST /pipeline` with array of commands

---

## Environment Variables

### Required
```
CRON_SECRET                  # Auth token for QStash + Vercel cron + Telegram webhook
TELEGRAM_BOT_TOKEN           # From @BotFather
TELEGRAM_CHAT_ID             # Your chat ID (from @userinfobot)
UPSTASH_REDIS_REST_URL       # Upstash Redis endpoint
UPSTASH_REDIS_REST_TOKEN     # Upstash Redis auth (read/write)
```

### LLM (at least one required)
```
GROQ_API_KEY                 # Groq (primary for monitor-check, free 14.4k req/day)
OPENROUTER_API_KEY           # OpenRouter (Qwen, DeepSeek — primary for Telegram chat)
```

### Optional Data Sources
```
CLOUDFLARE_API_TOKEN         # Internet outage monitoring
FINNHUB_API_KEY              # Stock quotes
FRED_API_KEY                 # Federal Reserve data
EIA_API_KEY                  # Energy data
ACLED_ACCESS_TOKEN           # Conflict events
WINGBITS_API_KEY             # Aircraft enrichment
NASA_FIRMS_API_KEY           # Satellite fire detection
AISSTREAM_API_KEY            # AIS vessel tracking
```

### QStash (for 5-min cron)
```
QSTASH_TOKEN                 # Upstash QStash auth
QSTASH_CURRENT_SIGNING_KEY   # Signature verification
QSTASH_NEXT_SIGNING_KEY      # Key rotation
```

### Site Config
```
VITE_VARIANT                 # "full" (default), "tech", or "finance"
VITE_SENTRY_DSN              # Error tracking
VITE_POSTHOG_KEY             # Analytics
CONVEX_URL                   # Email registration DB
```

---

## Middleware (middleware.ts)

Runs on `/api/*` and `/favico/*` paths. Controls what reaches API routes.

- **Blocks** all bot/crawler user agents (regex match)
- **Blocks** requests with no UA or UA < 10 chars
- **Allows** Telegram webhook path (Telegram sends bot-like UA)
- **Allows** `/api/monitor-check` and `/api/daily-digest` (QStash/Vercel cron UAs)
- **Allows** `/ingest` (PostHog analytics proxy)
- **Allows** social preview bots (Twitter, Facebook, Slack, etc.) on `/api/story` and `/api/og-story` only
- **Allows** social image bots on `/favico/` paths

---

## Alert Deduplication System

Two layers prevent spam:

### 1. Cross-source verification
If a finding's sources are ALL from Telegram channels (no Reddit, no headlines, no wire services), it gets downgraded to "developing" with "UNVERIFIED:" prefix. Prevents hallucinated events from single-source Telegram claims.

### 2. Jaccard word similarity
Every alert title is compared against the last 50 sent titles (stored in Redis, 2h TTL). If word overlap > 40%, it's a duplicate and gets skipped.

```
"Escalating US-Iran Tensions Amid Diplomatic Contradictions"
vs
"Escalating US-Iran Tensions Amid Diplomatic Deadlock"
→ Jaccard = 0.71 → DUPLICATE (skipped)

"US-Iran Tensions Escalate"
vs
"Bitcoin ETF Outflows Surge"
→ Jaccard = 0.0 → UNIQUE (sent)
```

The similarity function strips punctuation, removes words < 3 chars, and compares word sets.

---

## Build & Deploy

```bash
# Development
npm run dev                    # Vite dev server on localhost:5173

# Build
npm run build                  # tsc + vite build (production)
npx tsc --noEmit               # Type check only

# Deploy (Vercel)
npx vercel --prod --yes        # Force production deploy
# Note: GitHub auto-deploy needs Vercel-GitHub Login Connection setup

# Desktop
npm run desktop:dev            # Tauri dev mode
npm run desktop:build:full     # Build native binary

# Test
npm run test:e2e               # Playwright E2E
node --test                    # Node.js unit tests
```

### Vercel deployment notes
- Auto-deploy from GitHub is NOT currently connected (needs Login Connection in Vercel dashboard)
- Manual deploy: `npx vercel --prod --yes` from project root
- Edge functions: 25s timeout (Hobby plan)
- Build: ~45s (TypeScript + Vite + PWA)

---

## QStash Schedule

- **Schedule ID**: `scd_5bHM9FvCgWXtULU96taou3kCgfig`
- **Target**: `https://worldmonitor-two-kappa.vercel.app/api/monitor-check`
- **Cron**: `*/5 * * * *` (every 5 minutes)
- **Auth**: `Upstash-Forward-Authorization: Bearer {CRON_SECRET}`
- **Free tier**: 500 msg/day (288 needed for 5-min cycles)

---

## Known Issues & TODOs

1. **Polymarket 24h change not tracked** — API doesn't expose it. Need to store prices in Redis each cycle and compute deltas. (prediction-markets.js:58)
2. **Vercel-GitHub auto-deploy disconnected** — Needs Login Connection setup at vercel.com/account/login-connections
3. **Edge function timeout pressure** — 25s is tight. Collection (8s) + LLM (10s) + Redis/Telegram (5s) = 23s budget. Slow LLM responses occasionally cause timeouts.
4. **appendHistory race condition** — Two concurrent messages could interleave. Can't fix with Upstash REST API (no WATCH/MULTI). Rare in practice.
5. **Reddit rate limiting** — Batched 4 subreddits at a time to avoid 429s. Could still hit limits under heavy load.
6. **worldmonitor.app domain** — Resolves to non-Vercel IP. Use worldmonitor-two-kappa.vercel.app for direct access.

---

## Monitor Persona (System Prompt)

Used in both telegram-webhook.js and chat.js:

```
You are Monitor, a senior intelligence analyst.

IDENTITY:
- Direct, concise, data-driven. No filler.
- Think in probabilities and leading indicators.
- Proactively flag cross-domain connections.
- Challenge assumptions when evidence contradicts them.

CAPABILITIES:
- Tools: search news, markets, Telegram, Reddit, predictions, earthquakes, flights
- Memory: 48-hour conversation history
- Watchlists: proactive alerts on tracked topics
- Analysis framework: cite sources, flag data age, highlight convergence signals,
  give probability ranges, end with "Watch for:" indicators

FORMAT: Telegram. *bold* for key points. Short paragraphs.
```

---

## Cost

| Item | Monthly |
|------|---------|
| Groq (monitor-check cycles) | Free |
| OpenRouter (Telegram chat, ~50K output tok/day) | ~$3-5 |
| Upstash QStash | Free |
| Upstash Redis | Free |
| Vercel Hobby | Free |
| Data sources | Free |
| **Total** | **~$3-5/month** |
