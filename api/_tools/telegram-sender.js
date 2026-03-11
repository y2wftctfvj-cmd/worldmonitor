/**
 * Telegram message sending — handles splitting, markdown fallback, and delivery.
 *
 * Extracted from telegram-webhook.js for reuse across command handlers.
 */

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Send a message to Telegram, splitting into multiple messages if needed.
 * Splits on section headers (*HEADER*) first, then on paragraph breaks.
 * Each chunk stays under TELEGRAM_MAX_LENGTH.
 */
export async function sendTelegramMessage(botToken, chatId, text) {
  const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH);

  for (const chunk of chunks) {
    await sendSingleTelegramMessage(botToken, chatId, chunk);
  }
}

/**
 * Split a long message into chunks that fit within the Telegram limit.
 * Prefers splitting on section headers (*BOLD HEADER*), then double newlines,
 * then single newlines, as a last resort mid-text.
 */
export function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point within the max length
    let splitAt = -1;

    // Prefer splitting before a section header line (*SOMETHING*)
    const headerPattern = /\n\*[A-Z]/g;
    let headerMatch;
    while ((headerMatch = headerPattern.exec(remaining)) !== null) {
      if (headerMatch.index > 0 && headerMatch.index <= maxLen) {
        splitAt = headerMatch.index;
      }
      if (headerMatch.index > maxLen) break;
    }

    // If no header split found, try double newline
    if (splitAt === -1) {
      const lastDoubleNewline = remaining.lastIndexOf('\n\n', maxLen);
      if (lastDoubleNewline > maxLen * 0.3) splitAt = lastDoubleNewline;
    }

    // If still nothing, try single newline
    if (splitAt === -1) {
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.3) splitAt = lastNewline;
    }

    // Last resort: hard cut
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Send a single Telegram message (must be under 4096 chars).
 * Falls back to plain text if Markdown parsing fails.
 */
export async function sendSingleTelegramMessage(botToken, chatId, text) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    // If Markdown parsing fails, retry without parse_mode
    if (resp.status === 400 && errBody.includes("can't parse")) {
      const retryResp = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!retryResp.ok) {
        throw new Error(`Telegram retry failed: ${retryResp.status}`);
      }
      return;
    }
    throw new Error(`Telegram API error ${resp.status}: ${errBody}`);
  }
}
