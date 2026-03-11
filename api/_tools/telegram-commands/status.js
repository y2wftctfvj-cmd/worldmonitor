/**
 * /status command handler — quick signal summary.
 */

import {
  fetchGoogleNewsHeadlines,
  fetchMarketQuotes,
} from '../monitor-tools.js';

/**
 * /status — show quick signal summary with markets, headlines, and source health.
 */
export async function handleStatus({ chatId, botToken, redisUrl, redisToken, sendMessage }) {
  const [markets, headlines, sourceHealthResp] = await Promise.allSettled([
    fetchMarketQuotes(),
    fetchGoogleNewsHeadlines(),
    redisUrl && redisToken
      ? fetch(`${redisUrl}/get/monitor:source-health`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(2000),
      })
      : null,
  ]);

  const parts = ['*MONITOR STATUS*\n'];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  parts.push(`${now}\n`);

  if (markets.status === 'fulfilled' && markets.value) {
    parts.push('*Markets:*');
    parts.push(markets.value);
    parts.push('');
  }

  if (headlines.status === 'fulfilled' && headlines.value) {
    const topHeadlines = headlines.value.split('\n').slice(0, 3).join('\n');
    parts.push('*Top Headlines:*');
    parts.push(topHeadlines);
  }

  if (sourceHealthResp.status === 'fulfilled' && sourceHealthResp.value?.ok) {
    try {
      const data = await sourceHealthResp.value.json();
      const sourceHealth = data?.result ? JSON.parse(data.result) : null;
      const mcpEntries = Object.entries(sourceHealth || {}).filter(([name]) => name.startsWith('mcp:'));
      if (mcpEntries.length > 0) {
        const summary = mcpEntries.map(([name, value]) => `${name.replace(/^mcp:/, '')}: ${value.status}`).join(', ');
        parts.push('');
        parts.push(`*MCP:* ${summary}`);
      }
    } catch {
      // Non-critical
    }
  }

  parts.push('\n_Use /brief for full analysis._');
  await sendMessage(botToken, chatId, parts.join('\n'));
}
