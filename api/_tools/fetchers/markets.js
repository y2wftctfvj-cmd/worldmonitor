/**
 * Market Fetchers — Yahoo Finance quotes for geopolitical indicators.
 *
 * Covers: S&P 500, Oil, Gold, 10Y Yield, VIX, Bitcoin, Defense ETF.
 * Uses Yahoo Finance free APIs (no key needed).
 * Primary: v7/finance/quote. Fallback: v8/finance/chart per-symbol.
 */

/** Market symbols to track */
export const MARKET_SYMBOLS = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: 'CL=F', name: 'Oil (WTI)' },
  { symbol: 'GC=F', name: 'Gold' },
  { symbol: '^TNX', name: '10Y Yield' },
  { symbol: '^VIX', name: 'VIX' },
  { symbol: 'BTC-USD', name: 'Bitcoin' },
  { symbol: 'ITA', name: 'Defense ETF' },  // iShares Aerospace & Defense — spikes before military news breaks
];

/**
 * Fetch key market quotes from Yahoo Finance (free, no key).
 *
 * Uses v7/finance/quote (structured quote data) as primary,
 * with v8/finance/chart per-symbol as fallback.
 */
export async function fetchMarketQuotes() {
  const symbols = MARKET_SYMBOLS.map(s => s.symbol);
  const names = Object.fromEntries(MARKET_SYMBOLS.map(s => [s.symbol, s.name]));

  // Try v7 quote endpoint first — returns structured price data directly
  const lines = await fetchQuotesV7(symbols, names);
  if (lines && lines.length > 0) return lines.join('\n');

  // Fallback: fetch per-symbol from v8 chart endpoint
  const fallbackLines = await fetchQuotesChartFallback(symbols, names);
  if (fallbackLines && fallbackLines.length > 0) return fallbackLines.join('\n');

  return null;
}

/**
 * Primary: Yahoo v7 quote endpoint — returns regularMarketPrice directly.
 */
async function fetchQuotesV7(symbols, names) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const results = data?.quoteResponse?.result;
    if (!Array.isArray(results) || results.length === 0) return null;

    const lines = [];
    for (const quote of results) {
      const name = names[quote.symbol] || quote.shortName || quote.symbol;
      const price = quote.regularMarketPrice;
      if (price == null || isNaN(price)) continue;

      const changePct = quote.regularMarketChangePercent;
      let changeStr = '';
      if (changePct != null && !isNaN(changePct)) {
        changeStr = ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
      }

      lines.push(`- ${name}: ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${changeStr}`);
    }

    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/**
 * Fallback: Yahoo v8 chart endpoint — one request per symbol, but reliable.
 */
async function fetchQuotesChartFallback(symbols, names) {
  const results = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;

      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta || {};
      const price = meta.regularMarketPrice;
      if (price == null || isNaN(price)) return null;

      const prevClose = meta.chartPreviousClose || meta.previousClose;
      let changeStr = '';
      if (prevClose && prevClose !== 0 && !isNaN(prevClose)) {
        const changePct = ((price - prevClose) / prevClose) * 100;
        changeStr = ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
      }

      const name = names[symbol] || symbol;
      return `- ${name}: ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${changeStr}`;
    })
  );

  const lines = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  return lines.length > 0 ? lines : null;
}
