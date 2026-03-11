/**
 * /anomalies command handler — entities currently above their baseline.
 */

import { normalizeEntity, computeBaselines } from '../event-ledger.js';
import {
  buildMcpHistorySection,
  gatewayConfigured as mcpGatewayConfigured,
} from '../mcp-adapter.js';

/**
 * /anomalies — show entities currently above their baseline.
 */
export async function handleAnomalies({ chatId, botToken, redisUrl, redisToken, sendMessage }) {
  if (!redisUrl || !redisToken) {
    await sendMessage(botToken, chatId, 'Anomaly detection requires Redis.');
    return;
  }

  // Load recent alerts to find active entities
  let recentAlerts = [];
  try {
    const resp = await fetch(`${redisUrl}/get/monitor:recent-alerts`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.result) recentAlerts = JSON.parse(data.result);
    }
  } catch { /* proceed with empty */ }

  if (recentAlerts.length === 0) {
    await sendMessage(botToken, chatId, '*ANOMALY REPORT*\n\nNo recent alerts to analyze. The monitor pipeline may not have produced alerts recently.');
    return;
  }

  // Extract entities from recent alerts
  const allEntities = [...new Set(recentAlerts.flatMap(a => a.entities || []))];
  if (allEntities.length === 0) {
    await sendMessage(botToken, chatId, '*ANOMALY REPORT*\n\nNo entity data in recent alerts.');
    return;
  }

  const baselines = await computeBaselines(allEntities, redisUrl, redisToken);

  const parts = ['*ANOMALY REPORT*', ''];
  let foundAnomalies = 0;
  let topAnomalyEntity = '';
  let topAnomalyRatio = 0;

  for (const [entity, baseline] of baselines) {
    if (baseline.insufficient) continue;
    const recentCount = recentAlerts.filter(a => (a.entities || []).some(e => normalizeEntity(e) === entity)).length;
    if (recentCount >= 3 && baseline.avgDailyMentions > 0) {
      const ratio = Math.round((recentCount / baseline.avgDailyMentions) * 100);
      parts.push(`\u26A1 *${entity}*: ${recentCount} alerts (${ratio}% of daily baseline ${baseline.avgDailyMentions})`);
      foundAnomalies++;
      if (ratio > topAnomalyRatio) {
        topAnomalyRatio = ratio;
        topAnomalyEntity = entity;
      }
    }
  }

  if (foundAnomalies === 0) {
    parts.push('No anomalies detected. All entities are within normal baseline ranges.');
  }

  if (topAnomalyEntity && mcpGatewayConfigured()) {
    const mcpHistory = await buildMcpHistorySection(topAnomalyEntity, { redisUrl, redisToken, timeoutMs: 1200 });
    if (mcpHistory.text) {
      parts.push('');
      parts.push(mcpHistory.text);
    }
  }

  parts.push('');
  parts.push(`_Based on ${allEntities.length} entities from ${recentAlerts.length} recent alerts._`);

  await sendMessage(botToken, chatId, parts.join('\n'));
}
