/**
 * /sitrep command handler — full situation report combining recent alerts + analysis.
 */

/**
 * /sitrep — compile and send a full situation report.
 */
export async function handleSitrep({ chatId, botToken, redisUrl, redisToken, sendMessage }) {
  if (!redisUrl || !redisToken) {
    await sendMessage(botToken, chatId, 'SITREP requires Redis.');
    return;
  }

  await sendMessage(botToken, chatId, 'Compiling situation report...');

  // Load all available data from Redis
  const [recentAlertsResp, sourceHealthResp, cacheResp] = await Promise.allSettled([
    fetch(`${redisUrl}/get/monitor:recent-alerts`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    }),
    fetch(`${redisUrl}/get/monitor:source-health`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    }),
    fetch(`${redisUrl}/get/${encodeURIComponent(`monitor:digest-cache:${new Date().toISOString().slice(0, 10)}`)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(2000),
    }),
  ]);

  let recentAlerts = [];
  let sourceHealth = null;
  let cache = null;

  try {
    if (recentAlertsResp.status === 'fulfilled' && recentAlertsResp.value.ok) {
      const data = await recentAlertsResp.value.json();
      if (data.result) recentAlerts = JSON.parse(data.result);
    }
  } catch { /* proceed */ }

  try {
    if (sourceHealthResp.status === 'fulfilled' && sourceHealthResp.value.ok) {
      const data = await sourceHealthResp.value.json();
      if (data.result) sourceHealth = JSON.parse(data.result);
    }
  } catch { /* proceed */ }

  try {
    if (cacheResp.status === 'fulfilled' && cacheResp.value.ok) {
      const data = await cacheResp.value.json();
      if (data.result) cache = JSON.parse(data.result);
    }
  } catch { /* proceed */ }

  // Build SITREP message
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  const parts = [];
  parts.push(`*SITUATION REPORT*`);
  parts.push(dateStr);
  parts.push('');

  // Recent alerts summary
  if (recentAlerts.length > 0) {
    parts.push('*RECENT ALERTS*');
    const top = recentAlerts.slice(-5);
    for (const alert of top) {
      const title = typeof alert === 'string' ? alert : alert.title;
      const severity = typeof alert === 'object' ? alert.severity : 'unknown';
      parts.push(`- [${severity}] ${title}`);
    }
    parts.push('');
  }

  // Entity activity from cache
  if (cache?.entityCounts) {
    const topEntities = Object.entries(cache.entityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (topEntities.length > 0) {
      parts.push('*ENTITY ACTIVITY*');
      for (const [entity, count] of topEntities) {
        parts.push(`- ${entity}: ${count} mentions`);
      }
      parts.push('');
    }
  }

  // Source health
  if (sourceHealth) {
    const entries = Object.entries(sourceHealth);
    const okCount = entries.filter(([, v]) => v.status === 'ok').length;
    const degraded = entries
      .filter(([, v]) => v.status === 'degraded' || (v.consecutiveDegraded || 0) >= 2)
      .map(([name, value]) => `${name} (${value.detail || `${value.consecutiveDegraded || 0} degraded`})`);
    const failed = entries
      .filter(([, v]) => v.status === 'failed' || (v.consecutiveFailures || 0) >= 2)
      .map(([name, value]) => `${name} (${value.consecutiveFailures || 0} fails)`);
    parts.push('*SOURCE STATUS*');
    parts.push(`${okCount}/${entries.length} healthy`);
    if (degraded.length > 0) {
      parts.push(`Degraded: ${degraded.join(', ')}`);
    }
    if (failed.length > 0) {
      parts.push(`Failed: ${failed.join(', ')}`);
    }
    parts.push('');
  }

  if (Array.isArray(cache?.mcpSignals) && cache.mcpSignals.length > 0) {
    parts.push('*MCP CONTEXT*');
    for (const line of cache.mcpSignals.slice(-5)) {
      parts.push(`- ${line}`);
    }
    parts.push('');
  }

  if (parts.length <= 3) {
    parts.push('No data available for SITREP. The monitor pipeline may not have run recently.');
  }

  await sendMessage(botToken, chatId, parts.join('\n'));
}
