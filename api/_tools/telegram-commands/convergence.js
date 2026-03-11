/**
 * /convergence command handler — cross-domain convergence signals.
 */

import { normalizeEntity } from '../event-ledger.js';
import {
  buildMcpHistorySection,
  gatewayConfigured as mcpGatewayConfigured,
} from '../mcp-adapter.js';

/**
 * /convergence — show cross-domain convergence signals from the latest digest cache.
 */
export async function handleConvergence({ chatId, botToken, redisUrl, redisToken, sendMessage }) {
  if (!redisUrl || !redisToken) {
    await sendMessage(botToken, chatId, 'Convergence detection requires Redis.');
    return;
  }

  // Load today's digest cache for entity activity data
  let cache = null;
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent(`monitor:digest-cache:${dateStr}`)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.result) cache = JSON.parse(data.result);
    }
  } catch { /* proceed without cache */ }

  const parts = ['*CROSS-DOMAIN CONVERGENCE*', ''];

  if (!cache || !cache.topAlerts || cache.topAlerts.length === 0) {
    parts.push('No convergence data available. The monitor pipeline needs to accumulate cycle data first.');
    await sendMessage(botToken, chatId, parts.join('\n'));
    return;
  }

  // Look for entities that appear across multiple source types
  const entitySourceTypes = new Map();
  for (const alert of cache.topAlerts) {
    const sourceTypes = alert.sourceTypes || [];
    for (const entity of (alert.entities || [])) {
      const normalized = normalizeEntity(entity);
      if (!entitySourceTypes.has(normalized)) {
        entitySourceTypes.set(normalized, { types: new Set(), displayName: entity });
      }
      for (const type of sourceTypes) {
        entitySourceTypes.get(normalized).types.add(type);
      }
    }
  }

  // Show entities with 3+ source types (proxy for cross-domain)
  let found = 0;
  let topEntity = '';
  const sorted = [...entitySourceTypes.entries()].sort((a, b) => b[1].types.size - a[1].types.size);
  for (const [, data] of sorted) {
    if (data.types.size >= 3) {
      parts.push(`\u{1F500} *${data.displayName}*: ${[...data.types].join(' + ')} (${data.types.size} source types)`);
      found++;
      if (!topEntity) topEntity = data.displayName;
    }
    if (found >= 10) break;
  }

  if (found === 0) {
    parts.push('No multi-domain convergence detected in today\'s data.');
  }

  if (Array.isArray(cache.mcpSignals) && cache.mcpSignals.length > 0) {
    parts.push('');
    parts.push('*MCP CONTEXT*');
    for (const line of cache.mcpSignals.slice(-3)) {
      parts.push(`- ${line}`);
    }
  } else if (topEntity && mcpGatewayConfigured()) {
    const mcpHistory = await buildMcpHistorySection(topEntity, { redisUrl, redisToken, timeoutMs: 1200 });
    if (mcpHistory.text) {
      parts.push('');
      parts.push(mcpHistory.text);
    }
  }

  parts.push('');
  parts.push(`_Based on ${cache.topAlerts.length} promoted events today._`);

  await sendMessage(botToken, chatId, parts.join('\n'));
}
