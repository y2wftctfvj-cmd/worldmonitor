/**
 * /watch and /unwatch command handlers.
 */

import { loadWatchlist, saveWatchlist } from '../redis-helpers.js';
import {
  createWatchlistItem,
  formatWatchlistSummary,
  hydrateWatchlistItems,
  normalizeWatchTerm,
} from '../watchlist-utils.js';

const MAX_WATCHLIST_ITEMS = 20;

/**
 * /watch <term> — add a term to the watchlist.
 */
export async function handleWatch(text, { chatId, botToken, redisUrl, redisToken, sendMessage }) {
  const term = text.slice(7).trim();
  if (!term) {
    await sendMessage(botToken, chatId, 'Usage: /watch <topic>\nExample: /watch Taiwan');
    return;
  }

  if (!redisUrl || !redisToken) {
    await sendMessage(botToken, chatId, 'Watchlist requires Redis. Configure UPSTASH_REDIS_REST_URL.');
    return;
  }

  const item = createWatchlistItem(term);
  if (!item) {
    await sendMessage(botToken, chatId, 'Invalid watchlist term.');
    return;
  }

  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
  const normalized = normalizeWatchTerm(item.term);

  if (watchlist.some((entry) => normalizeWatchTerm(entry.normalized || entry.term) === normalized)) {
    await sendMessage(botToken, chatId, `"${item.term}" is already on your watchlist.`);
    return;
  }

  if (watchlist.length >= MAX_WATCHLIST_ITEMS) {
    await sendMessage(botToken, chatId, `Watchlist full (${MAX_WATCHLIST_ITEMS} max). Remove one first with /unwatch.`);
    return;
  }

  const updated = [...hydrateWatchlistItems(watchlist), item];
  try {
    await saveWatchlist(chatId, updated, redisUrl, redisToken);
    await sendMessage(botToken, chatId, `Added "${item.term}" to watchlist. I'll alert you when it appears in high-trust intel.`);
  } catch (err) {
    console.error('[watch] Watchlist save failed:', err.message);
    await sendMessage(botToken, chatId, `Failed to save "${item.term}" to watchlist. Try again in a moment.`);
  }
}

/**
 * /unwatch <term> — remove a term from the watchlist.
 */
export async function handleUnwatch(text, { chatId, botToken, redisUrl, redisToken, sendMessage }) {
  const term = text.slice(9).trim();
  if (!term) {
    await sendMessage(botToken, chatId, 'Usage: /unwatch <topic>');
    return;
  }

  if (!redisUrl || !redisToken) {
    await sendMessage(botToken, chatId, 'Watchlist requires Redis.');
    return;
  }

  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
  const normalized = normalizeWatchTerm(term);
  const updated = watchlist.filter((entry) => normalizeWatchTerm(entry.normalized || entry.term) !== normalized);

  if (updated.length === watchlist.length) {
    await sendMessage(botToken, chatId, `"${term}" was not on your watchlist.`);
    return;
  }

  try {
    await saveWatchlist(chatId, updated, redisUrl, redisToken);
    await sendMessage(botToken, chatId, `Removed "${term}" from watchlist.`);
  } catch (err) {
    console.error('[watch] Watchlist save failed:', err.message);
    await sendMessage(botToken, chatId, `Failed to remove "${term}". Try again in a moment.`);
  }
}

/**
 * /watches — list active watchlist items.
 */
export async function handleWatches({ chatId, botToken, redisUrl, redisToken, sendMessage }) {
  const watchlist = await loadWatchlist(chatId, redisUrl, redisToken);
  if (watchlist.length === 0) {
    await sendMessage(botToken, chatId, 'No active watches. Use /watch <topic> to add one.');
  } else {
    const list = formatWatchlistSummary(watchlist, MAX_WATCHLIST_ITEMS);
    await sendMessage(botToken, chatId, `*Active Watchlist* (${watchlist.length}/${MAX_WATCHLIST_ITEMS}):\n${list}`);
  }
}
