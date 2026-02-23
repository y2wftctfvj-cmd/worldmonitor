/**
 * RPC: ListMarketQuotes
 * Fetches stock/index quotes from Finnhub (stocks) and Yahoo Finance (indices/futures).
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  MarketQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { YAHOO_ONLY_SYMBOLS, fetchFinnhubQuote, fetchStooqQuote, fetchYahooQuotesBatch } from './_shared';

const quotesCache = new Map<string, { data: ListMarketQuotesResponse; timestamp: number }>();
const QUOTES_CACHE_TTL = 120_000; // 2 minutes
const DEFAULT_MARKET_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', '^GSPC', '^DJI', '^IXIC', '^VIX', 'GC=F', 'CL=F'];
const NO_FINNHUB_REASON = 'FINNHUB_API_KEY not configured (using Yahoo fallback where available)';

function cacheKey(symbols: readonly string[] | undefined | null): string {
  if (!Array.isArray(symbols)) return '';
  return [...symbols].sort().join(',');
}

function normalizeSymbols(
  input: unknown,
  fallback: readonly string[],
): string[] {
  const sanitized = Array.isArray(input)
    ? input
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    : [];

  const unique = [...new Set(sanitized)];
  return unique.length > 0 ? unique : [...fallback];
}

export async function listMarketQuotes(
  _ctx: ServerContext,
  req: ListMarketQuotesRequest,
): Promise<ListMarketQuotesResponse> {
  const apiKey = process.env.FINNHUB_API_KEY;
  const symbols = normalizeSymbols(
    (req as { symbols?: unknown } | undefined)?.symbols,
    DEFAULT_MARKET_SYMBOLS,
  );

  const now = Date.now();
  const key = cacheKey(symbols);
  const cached = quotesCache.get(key);
  if (cached && now - cached.timestamp < QUOTES_CACHE_TTL) {
    return cached.data;
  }

  try {
    if (!symbols.length) return { quotes: [], finnhubSkipped: !apiKey, skipReason: !apiKey ? NO_FINNHUB_REASON : '' };

    const finnhubSymbols = symbols.filter((s) => !YAHOO_ONLY_SYMBOLS.has(s));
    const yahooOnlySymbols = symbols.filter((s) => YAHOO_ONLY_SYMBOLS.has(s));
    const unresolved = new Set(symbols);
    const quotes: MarketQuote[] = [];

    // Primary source: Finnhub for non-index/futures symbols.
    if (finnhubSymbols.length > 0 && apiKey) {
      const results = await Promise.all(
        finnhubSymbols.map((s) => fetchFinnhubQuote(s, apiKey)),
      );
      for (const r of results) {
        if (r) {
          quotes.push({
            symbol: r.symbol,
            name: r.symbol,
            display: r.symbol,
            price: r.price,
            change: r.changePercent,
            sparkline: [],
          });
          unresolved.delete(r.symbol);
        }
      }
    }

    // Secondary source:
    // 1) Always for Yahoo-only symbols (indices/futures)
    // 2) For any non-index symbols Finnhub failed to resolve
    const yahooSymbols = !apiKey
      ? symbols
      : [...new Set([
        ...yahooOnlySymbols,
        ...finnhubSymbols.filter((s) => unresolved.has(s)),
      ])];

    if (yahooSymbols.length > 0) {
      const batch = await fetchYahooQuotesBatch(yahooSymbols);
      for (const s of yahooSymbols) {
        const yahoo = batch.get(s);
        if (yahoo) {
          quotes.push({
            symbol: s,
            name: s,
            display: s,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          });
          unresolved.delete(s);
        }
      }
    }

    // Last-resort free fallback for any remaining unresolved symbols.
    for (const s of unresolved) {
      const stooq = await fetchStooqQuote(s);
      if (!stooq) continue;
      quotes.push({
        symbol: s,
        name: s,
        display: s,
        price: stooq.price,
        change: stooq.change,
        sparkline: stooq.sparkline,
      });
    }

    // Stale-while-revalidate: if Yahoo rate-limited and no fresh data, serve cached
    if (quotes.length === 0 && cached) {
      return cached.data;
    }

    const result: ListMarketQuotesResponse = { quotes, finnhubSkipped: !apiKey, skipReason: !apiKey ? NO_FINNHUB_REASON : '' };
    if (quotes.length > 0) {
      quotesCache.set(key, { data: result, timestamp: now });
    }
    return result;
  } catch {
    if (cached) return cached.data;
    return { quotes: [], finnhubSkipped: !apiKey, skipReason: !apiKey ? NO_FINNHUB_REASON : '' };
  }
}
