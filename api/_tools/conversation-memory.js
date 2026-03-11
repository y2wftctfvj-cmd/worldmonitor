/**
 * Conversation Memory — Redis-backed chat history for Telegram webhook.
 *
 * Stores conversation turns with 48h TTL, capped at 30 messages.
 * Each entry has {role, content, ts} structure.
 */

const MAX_HISTORY_MESSAGES = 30;
const HISTORY_TTL_SECONDS = 48 * 60 * 60; // 48 hours

/**
 * Load conversation history from Redis.
 * Returns array of {role, content} messages (max 30).
 *
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function loadHistory(chatId, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return [];

  try {
    const key = `chat:${chatId}:history`;
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    if (!data.result) return [];

    const history = JSON.parse(data.result);
    if (!Array.isArray(history)) return [];

    // Validate each entry — only allow user/assistant roles with string content
    const validRoles = new Set(['user', 'assistant']);
    return history.filter(
      (entry) => validRoles.has(entry?.role) && typeof entry?.content === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * Append a message to conversation history.
 * Trims to 30 messages, resets TTL to 48 hours.
 *
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - Message content
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 */
export async function appendHistory(chatId, role, content, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;

  try {
    // Load current history
    const history = await loadHistory(chatId, redisUrl, redisToken);

    // Append new message and trim to most recent 30
    const updated = [...history, { role, content, ts: Date.now() }];
    const trimmed = updated.slice(-MAX_HISTORY_MESSAGES);

    // Save with 48h TTL — use pipeline POST body (safe for large values)
    const key = `chat:${chatId}:history`;
    const value = JSON.stringify(trimmed);
    await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['SET', key, value, 'EX', String(HISTORY_TTL_SECONDS)]]),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    console.error('[conversation-memory] Failed to save history:', err.message);
  }
}

/**
 * Clear conversation history for a chat.
 *
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} redisUrl - Upstash Redis REST URL
 * @param {string} redisToken - Upstash Redis REST token
 */
export async function clearHistory(chatId, redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return;

  try {
    const key = `chat:${chatId}:history`;
    await fetch(`${redisUrl}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Non-critical
  }
}
