# Wave 2: Smarter AI + OSINT Intelligence Layer

**Date:** 2026-02-23
**Status:** Approved
**Goal:** Transform World Monitor from a data dashboard into an intelligent analyst that proactively surfaces insights, detects patterns, and delivers intelligence via Telegram.

---

## 1. Monitor Chat (Upgraded)

### Current State
- Browser T5-small only (3/10 quality)
- Single-turn, no conversation history
- No persona or structured behavior

### Target State
- Groq LLM (8/10 quality) with OpenRouter + browser T5 fallback
- Multi-turn (last 5 exchanges in context)
- "Monitor" persona: senior intelligence analyst

### Persona Rules
- Every claim cites dashboard data
- Flags stale data (>2h old)
- Leads with answer, then evidence
- Proactively flags cross-domain connections
- Gives probability ranges when uncertain

### Capabilities
- Ask about any region/topic (pulls all signals for context)
- Compare regions (CII scores, signal counts side-by-side)
- Explain market moves (correlates with news + signals)
- Scenario analysis (historical patterns + cascade model)
- Quick briefing on demand
- Watchlist management ("watch China-Taiwan for me")

### Files
- **Create:** `api/chat.js` — Vercel Edge Function, Groq-first with fallback
- **Modify:** `src/components/ChatPanel.ts` — API integration, multi-turn history, richer UI

---

## 2. Event-Driven Intelligent Alerts

### Trigger Thresholds
- CII delta > 5 points in 2 hours
- Market move > 2% in 30 minutes
- New critical/high threat classification
- Convergence score > 60 in any region
- Watchlist entity match

### Behavior
- 15-minute check cycle (lightweight threshold scan)
- Only sends Telegram when threshold breached
- Adaptive detail: quiet day = silence, hot day = full context
- Includes "what this means" AI-generated context line

### Files
- **Create:** `api/cron/monitor-check.js` — Vercel Cron, 15-min interval

---

## 3. Daily Digest

### Format
- Fires once daily (8:00 PM ET)
- Covers delta from last 24h: risk shifts, top events, market summary
- AI-generated insight paragraph via Groq
- Skippable: sends "All quiet" one-liner on truly dead days

### Files
- **Create:** `api/cron/daily-digest.js` — Vercel Cron, daily schedule

---

## 4. Named Patterns + Explanations

### Current State
- 13 correlation signal types detected (convergence, triangulation, cascade, etc.)
- Logged to console, not surfaced to user

### Target State
- Each pattern gets a plain-English name and explanation template
- Surfaced in AlertCenter + Telegram
- Example: "Red Sea Convergence — 4 signal types in 6h: military vessels, shipping disruption, oil spike, Houthi news"

### Files
- **Modify:** `src/services/analysis-core.ts` — pattern naming + explanation generator

---

## 5. Historical Pattern Matching

### Approach
- Extend IndexedDB snapshot history from 7 days to 90 days
- Store daily snapshots: CII scores, convergence zones, signal counts by region
- On new pattern detection, compare against 90-day archive
- Report: "This pattern matches [date] which preceded [event]"

### Files
- **Create:** `src/services/pattern-memory.ts` — storage, comparison, similarity scoring
- **Modify:** `src/services/storage.ts` — extend retention to 90 days

---

## 6. Predictive Alerts

### Approach
- Define precursor checklists for common scenarios (e.g., strait disruption, military escalation, market crash)
- When 3+/5 precursors present, generate prediction with confidence score
- Evidence checklist format: checked/unchecked precursors
- Cite historical precedent count

### Files
- **Create:** `src/services/prediction-engine.ts` — precursor definitions, scoring, alert generation

---

## 7. Watchlist Service

### Approach
- User sets watches via chat ("watch Taiwan", "watch oil above $90")
- Stored in localStorage (persistent across sessions)
- Checked every 15 minutes by monitor-check cron (via dashboard context)
- Triggers Telegram alert on match

### Files
- **Create:** `src/services/watchlist.ts` — CRUD, matching, persistence

---

## 8. OSINT: Cyber Intelligence (Tier 1)

### HIBP Breach Monitor
- Check entities on watchlist against HIBP breach database
- Alert on new breaches affecting watched companies/domains
- API: HIBP v3 (free for breach search)

### VirusTotal Campaign Tracking
- Query VT for campaigns targeting specific countries/sectors
- Integrate with existing cyber/index.ts IOC feeds
- API: VT v3 (free tier, 4 req/min)

### AbuseIPDB Country Heatmap
- Already partially connected
- Add geographic aggregation: attacks by source country
- Feed into signal aggregator as cyber_origin signals

### Files
- **Create:** `src/services/osint/breach-monitor.ts`
- **Modify:** `src/services/cyber/index.ts` — add VT campaign + AbuseIPDB geo

---

## 9. OSINT: Social & Human Intelligence (Tier 4)

### Reddit Intelligence
- Monitor: r/worldnews, r/geopolitics, r/osint, r/ukraine, r/middleeast
- API: Reddit JSON (append .json to any subreddit URL, no auth needed)
- Extract: top posts, comment sentiment, velocity of discussion
- Feed trending topics into signal aggregator

### Telegram Public Channels
- Monitor OSINT community channels (Intel Slava Z, Ukraine NOW, etc.)
- Via Telegram Bot API (already have bot configured)
- Extract: message text, media presence, forward counts
- Feed into news/intelligence pipeline

### Flight Anomaly Detection
- Use existing OpenSky data
- Detect: circling patterns (>2 orbits), unusual squawk codes (7500/7600/7700), diversions
- Generate alerts: "Military aircraft circling over [location] for 45 minutes"

### AIS Dark Zone Detection
- Use existing AIS stream
- Detect: vessels that stop transmitting in known smuggling/sanctions zones
- Map dark zones on globe as heat layer
- Alert: "12 vessels went dark near Strait of Hormuz in last 6h"

### Files
- **Create:** `src/services/osint/reddit.ts`
- **Create:** `src/services/osint/telegram-channels.ts`
- **Create:** `src/services/osint/flight-anomalies.ts`
- **Create:** `src/services/osint/ais-dark-zones.ts`

---

## Dependencies

- **Groq API key** — already in .env.example (free tier: 14,400 req/day)
- **Telegram bot** — already configured (beaconGallery_bot)
- **Upstash Redis** — already in .env.example (for cron state)
- **No new paid services** — all OSINT sources are free

## Risk Mitigation

- Groq rate limits: deduplication cache prevents redundant calls
- Reddit rate limits: 60 req/min unauthenticated, cache 5-min TTL
- Telegram channel access: only public channels, no auth needed
- VT rate limits: 4 req/min, batch + cache aggressively
- Pattern matching false positives: require 3+ precursors minimum, human-readable confidence
