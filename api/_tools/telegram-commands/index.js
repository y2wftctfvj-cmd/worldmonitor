/**
 * Telegram Command Router — maps slash commands to their handlers.
 *
 * Each handler receives (text, ctx) where ctx contains:
 *   { chatId, botToken, redisUrl, redisToken, openRouterKey, groqKey, sendMessage }
 */

import { handleWatch, handleUnwatch, handleWatches } from './watch.js';
import { handleBrief } from './brief.js';
import { handleStatus } from './status.js';
import { handleHistory } from './history.js';
import { handleAnomalies } from './anomalies.js';
import { handleConvergence } from './convergence.js';
import { handleSitrep } from './sitrep.js';

/**
 * Route a slash command to its handler.
 * Returns true if a command was processed, false otherwise.
 *
 * @param {string} text - User message text
 * @param {Object} ctx - Command context
 * @returns {Promise<boolean>} Whether a command was handled
 */
export async function routeCommand(text, ctx) {
  const lower = text.toLowerCase().trim();

  if (lower.startsWith('/watch ') && !lower.startsWith('/watches')) {
    await handleWatch(text, ctx);
    return true;
  }

  if (lower.startsWith('/unwatch ')) {
    await handleUnwatch(text, ctx);
    return true;
  }

  if (lower === '/watches') {
    await handleWatches(ctx);
    return true;
  }

  if (lower === '/brief') {
    await handleBrief(ctx);
    return true;
  }

  if (lower === '/status') {
    await handleStatus(ctx);
    return true;
  }

  if (lower === '/clear') {
    // Handled inline since it's a one-liner
    return false;
  }

  if (lower.startsWith('/history ')) {
    await handleHistory(text, ctx);
    return true;
  }

  if (lower === '/anomalies') {
    await handleAnomalies(ctx);
    return true;
  }

  if (lower === '/convergence') {
    await handleConvergence(ctx);
    return true;
  }

  if (lower === '/sitrep') {
    await handleSitrep(ctx);
    return true;
  }

  return false;
}
