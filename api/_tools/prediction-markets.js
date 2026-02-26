/**
 * Polymarket Prediction Markets Integration
 *
 * Fetches geopolitical prediction market data from Polymarket's Gamma API.
 * Returns market titles, probabilities, 24h changes, and volume.
 *
 * API: https://gamma-api.polymarket.com/markets
 * Free, no key needed. Rate limits are generous.
 * Cache: 5 minutes (module-level).
 */

// --- Cache ---
let cachedMarkets = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch top geopolitical prediction markets by volume.
 * Returns up to 20 markets with title, probability, 24h change, and volume.
 */
export async function fetchGeopoliticalMarkets() {
  const now = Date.now();
  if (cachedMarkets && now - cachedAt < CACHE_TTL_MS) {
    return cachedMarkets;
  }

  try {
    // Gamma API — fetch active geopolitical markets sorted by volume
    const url = 'https://gamma-api.polymarket.com/events?tag=politics&limit=30&active=true&closed=false&order=volume&ascending=false';
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      console.error('[prediction-markets] Gamma API returned', resp.status);
      return cachedMarkets || [];
    }

    const events = await resp.json();
    if (!Array.isArray(events)) return cachedMarkets || [];

    // Extract markets from events — each event can have multiple markets
    const markets = [];
    for (const event of events) {
      if (!event.markets || !Array.isArray(event.markets)) continue;

      for (const market of event.markets) {
        // Only include markets with meaningful data
        const probability = parseFloat(market.outcomePrices?.[0] || market.bestAsk || '0');
        if (isNaN(probability) || probability <= 0 || probability >= 1) continue;

        const volume = parseFloat(market.volume || '0');
        markets.push({
          title: market.question || event.title || 'Unknown',
          probability: Math.round(probability * 100),
          volume: isNaN(volume) ? 0 : volume,
          // TODO: Polymarket doesn't expose 24h change — need to store
          // prices in Redis each cycle and compute deltas ourselves
          slug: market.slug || event.slug || '',
        });
      }
    }

    // Sort by volume, keep top 20
    const topMarkets = markets
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 20);

    cachedMarkets = topMarkets;
    cachedAt = now;
    return topMarkets;
  } catch (err) {
    console.error('[prediction-markets] Fetch failed:', err.message || err);
    return cachedMarkets || [];
  }
}

/**
 * Search prediction markets by keyword.
 * Used by Monitor's tool-calling to answer questions about specific predictions.
 */
export async function searchPredictionMarkets(query) {
  if (!query || query.length < 2) return [];

  try {
    const url = `https://gamma-api.polymarket.com/events?title=${encodeURIComponent(query)}&limit=10&active=true&closed=false`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return [];

    const events = await resp.json();
    if (!Array.isArray(events)) return [];

    const results = [];
    for (const event of events) {
      if (!event.markets || !Array.isArray(event.markets)) continue;

      for (const market of event.markets) {
        const probability = parseFloat(market.outcomePrices?.[0] || market.bestAsk || '0');
        const volume = parseFloat(market.volume || '0');
        results.push({
          title: market.question || event.title || 'Unknown',
          probability: !isNaN(probability) && probability > 0 && probability < 1 ? Math.round(probability * 100) : null,
          volume: isNaN(volume) ? 0 : volume,
          slug: market.slug || event.slug || '',
        });
      }
    }

    return results.slice(0, 10);
  } catch (err) {
    console.error('[prediction-markets] Search failed:', err.message || err);
    return [];
  }
}
