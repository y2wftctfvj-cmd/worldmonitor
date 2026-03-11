/**
 * /history command handler — 7-day entity timeline from the ledger.
 */

import { getEntityHistory } from '../event-ledger.js';
import {
  buildMcpHistorySection,
  gatewayConfigured as mcpGatewayConfigured,
} from '../mcp-adapter.js';

/**
 * /history <entity> — show 7-day timeline from the ledger.
 */
export async function handleHistory(text, { chatId, botToken, redisUrl, redisToken, sendMessage }) {
  const entity = text.slice(9).trim();
  if (!entity) {
    await sendMessage(botToken, chatId, 'Usage: /history <entity>\nExample: /history Iran');
    return;
  }

  const ledger = await getEntityHistory(entity, redisUrl, redisToken);
  const canUseMcp = mcpGatewayConfigured();

  if (!ledger) {
    if (canUseMcp) {
      const mcpHistory = await buildMcpHistorySection(entity, { redisUrl, redisToken, timeoutMs: 1200 });
      if (mcpHistory.text) {
        await sendMessage(botToken, chatId, [`*ENTITY HISTORY: ${entity}*`, '', mcpHistory.text].join('\n'));
        return;
      }
    }
    await sendMessage(botToken, chatId, `No history found for "${entity}". The entity may not have appeared in recent monitoring cycles, or the ledger hasn't accumulated enough data yet.`);
    return;
  }

  const observations = ledger.observations || [];
  const baseline = ledger.baseline || {};

  const parts = [];
  parts.push(`*ENTITY HISTORY: ${ledger.displayName || entity}*`);
  parts.push(`Normalized: ${ledger.entity}`);
  parts.push(`Observations: ${observations.length} over ${Math.round((Date.now() - (observations[0]?.ts || Date.now())) / 86400000)} days`);
  parts.push('');

  // Baseline stats
  if (baseline.observationCount >= 5) {
    parts.push('*Baseline (7-day)*');
    parts.push(`Avg daily mentions: ${baseline.avgDailyMentions}`);
    parts.push(`Avg confidence: ${baseline.avgConfidence}`);
    parts.push(`Avg source count: ${baseline.avgSourceCount}`);
    parts.push('');
  }

  // Recent observations (last 10)
  const recentObs = observations.slice(-10);
  if (recentObs.length > 0) {
    parts.push('*Recent Activity*');
    for (const obs of recentObs) {
      const date = new Date(obs.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      const sources = obs.sourceCount || 1;
      parts.push(`- ${date} UTC | ${obs.severity} | conf: ${obs.confidence} | ${sources} sources`);
    }
    parts.push('');
  }

  // Severity distribution
  const severityCounts = {};
  for (const obs of observations) {
    severityCounts[obs.severity] = (severityCounts[obs.severity] || 0) + 1;
  }
  parts.push('*Severity Distribution*');
  for (const [sev, count] of Object.entries(severityCounts).sort((a, b) => b[1] - a[1])) {
    parts.push(`${sev}: ${count}`);
  }

  if (canUseMcp) {
    const mcpHistory = await buildMcpHistorySection(entity, { redisUrl, redisToken, timeoutMs: 1200 });
    if (mcpHistory.text) {
      parts.push('');
      parts.push(mcpHistory.text);
    }
  }

  await sendMessage(botToken, chatId, parts.join('\n'));
}
