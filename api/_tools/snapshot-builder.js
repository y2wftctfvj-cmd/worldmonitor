/**
 * Snapshot Builder — assembles collected data into a text snapshot
 * for /brief and other features that need the full picture.
 */

import { redisSet } from './redis-helpers.js';

/**
 * Build a text snapshot from all collected results.
 * Used by /brief command and stored in Redis for between-cycle access.
 */
export function buildSnapshot(results, options = {}) {
  const sections = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  sections.push(`TIMESTAMP: ${now}`);

  // Headlines
  if (results.headlines.status === 'fulfilled' && results.headlines.value) {
    sections.push(`HEADLINES:\n${results.headlines.value}`);
  }

  // Markets
  if (results.markets.status === 'fulfilled' && results.markets.value) {
    sections.push(`MARKETS:\n${results.markets.value}`);
  }

  // Telegram OSINT
  if (results.telegram.status === 'fulfilled' && results.telegram.value?.length > 0) {
    const posts = results.telegram.value.slice(-20);
    sections.push(`TELEGRAM OSINT (${posts.length} posts from ${new Set(posts.map(p => p.channel)).size} channels):\n${posts.map(p => `- [${p.channel}] ${p.text}`).join('\n')}`);
  }

  // Reddit OSINT
  if (results.reddit.status === 'fulfilled' && results.reddit.value?.length > 0) {
    const posts = results.reddit.value.slice(0, 15);
    sections.push(`REDDIT OSINT (${posts.length} posts):\n${posts.map(p => `- [r/${p.sub}, ${p.score}pts] ${p.title}`).join('\n')}`);
  }

  // Prediction markets
  if (results.predictions.status === 'fulfilled' && results.predictions.value?.length > 0) {
    const markets = results.predictions.value.slice(0, 10);
    sections.push(`PREDICTION MARKETS (Polymarket):\n${markets.map(m => `- ${m.title}: ${m.probability ?? 'N/A'}% (vol: $${Math.round(m.volume || 0).toLocaleString('en-US')})`).join('\n')}`);
  }

  // Earthquakes
  if (results.earthquakes.status === 'fulfilled' && results.earthquakes.value?.length > 0) {
    sections.push(`EARTHQUAKES:\n${results.earthquakes.value.map(eq => `- M${(eq.mag || 0).toFixed(1)} — ${eq.place} (${eq.time})`).join('\n')}`);
  }

  // Internet outages
  if (results.outages.status === 'fulfilled' && results.outages.value?.length > 0) {
    sections.push(`INTERNET OUTAGES:\n${results.outages.value.map(o => `- ${o.country}: ${o.description}`).join('\n')}`);
  }

  // Military news
  if (results.military.status === 'fulfilled' && results.military.value) {
    const mil = results.military.value;
    sections.push(`MILITARY NEWS (${mil.count} articles in last 2h):\n${mil.articles.map(a => `- ${a}`).join('\n')}`);
  }

  // Government/wire feeds
  if (results.govFeeds.status === 'fulfilled' && results.govFeeds.value?.length > 0) {
    sections.push(`WIRE SERVICES:\n${results.govFeeds.value.map(f => `- [${f.source}] ${f.title}`).join('\n')}`);
  }

  if (options.mcpSection) {
    sections.push(options.mcpSection);
  }

  return sections.join('\n\n');
}

/**
 * Store snapshot in Redis for /brief command.
 * Truncates if too large for Redis free tier (~1MB).
 */
export async function storeSnapshot(redisUrl, redisToken, snapshot, ttl) {
  if (!redisUrl || !redisToken) return;

  try {
    if (snapshot.length > 500000) {
      console.warn(`[snapshot-builder] Snapshot truncated: ${snapshot.length} → 500000 chars`);
    }
    const truncated = snapshot.length > 500000 ? snapshot.slice(0, 500000) : snapshot;
    await redisSet(redisUrl, redisToken, 'monitor:snapshot', truncated, ttl);
  } catch (err) {
    console.error('[snapshot-builder] Failed to store snapshot:', err.message);
  }
}
