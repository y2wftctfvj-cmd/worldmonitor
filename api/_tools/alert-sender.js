/**
 * Alert Sender — formats and sends SITREP-format intelligence alerts via Telegram.
 *
 * Handles MarkdownV2 formatting with fallback to plain text on parse errors.
 * Includes analysis metadata (anomalies, escalation, convergence) inline.
 */

const TELEGRAM_MAX_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Human-readable source display names
// ---------------------------------------------------------------------------

const SOURCE_DISPLAY_NAMES = {
  // System sources
  headlines: 'Google News',
  govFeeds: 'Wire Services',
  earthquakes: 'USGS',
  outages: 'Cloudflare Radar',
  markets: 'Yahoo Finance',
  predictions: 'Polymarket',
  military: 'GDELT Military',
  // Telegram — conflict/geopolitical
  'telegram:intelslava': '@IntelSlava',
  'telegram:militarysummary': '@MilitarySummary',
  'telegram:breakingmash': '@BreakingMash',
  'telegram:legitimniy': '@Legitimniy',
  'telegram:iranintl_en': '@IranIntl',
  'telegram:CIG_telegram': '@CIG',
  'telegram:IntelRepublic': '@IntelRepublic',
  'telegram:combatftg': '@CombatFootage',
  'telegram:osintdefender': '@OSINTDefender',
  'telegram:BellumActaNews': '@BellumActa',
  'telegram:OsintTv': '@OsintTv',
  'telegram:GeneralMCNews': '@GeneralMCNews',
  'telegram:rnintelligence': '@RNIntelligence',
  'telegram:RVvoenkor': '@RVvoenkor',
  'telegram:usaperiodical': '@USAPeriodical',
  // Telegram — mainstream news
  'telegram:Bloomberg': '@Bloomberg',
  'telegram:guardian': '@Guardian',
  'telegram:cnbci': '@CNBC',
  'telegram:AJENews_Official': '@AlJazeeraEN',
  'telegram:ajanews': '@AlJazeeraAR',
  // Telegram — Ukraine/Russia
  'telegram:KyivIndependent_official': '@KyivIndependent',
  'telegram:ukrainenowenglish': '@UkraineNow',
  // Telegram — Israel/Middle East
  'telegram:idfofficial': '@IDF',
  'telegram:ILTVNews': '@ILTV',
  'telegram:TheTimesOfIsrael2022': '@TimesOfIsrael',
  'telegram:barakravid1': '@BarakRavid',
  // Reddit — geopolitics
  'reddit:worldnews': 'r/worldnews',
  'reddit:geopolitics': 'r/geopolitics',
  'reddit:osint': 'r/osint',
  'reddit:CredibleDefense': 'r/CredibleDefense',
  'reddit:internationalsecurity': 'r/internationalsecurity',
  'reddit:middleeastwar': 'r/middleeastwar',
  'reddit:iranpolitics': 'r/iranpolitics',
  // Reddit — military/defense
  'reddit:CombatFootage': 'r/CombatFootage',
  'reddit:WarCollege': 'r/WarCollege',
  // Reddit — cyber
  'reddit:netsec': 'r/netsec',
  'reddit:cybersecurity': 'r/cybersecurity',
  // Reddit — markets
  'reddit:wallstreetbets': 'r/wallstreetbets',
  // Twitter/X OSINT
  'twitter:IntelDoge': '@IntelDoge',
  'twitter:sentdefender': '@sentdefender',
  'twitter:Global_Mil_Info': '@Global_Mil_Info',
  'twitter:NotWoofers': '@NotWoofers',
  'twitter:RALee85': '@RALee85',
  'twitter:Flash_news_ua': '@Flash_news_ua',
  'twitter:Faytuks': '@Faytuks',
  // Bluesky OSINT
  'bluesky:bellingcat': '@bellingcat',
  'bluesky:conflictnews': '@conflictnews',
  'bluesky:baboratorium': '@baboratorium',
  'bluesky:osinttechnical': '@osinttechnical',
  'bluesky:julianroepcke': '@julianroepcke',
  // New intelligence sources
  cisa: 'CISA Cyber',
  travelAdvisory: 'Travel Advisory',
  gpsJamming: 'GPS Jamming',
  sanctions: 'OFAC Sanctions',
  gdacsEnhanced: 'GDACS Alerts',
  mcpNews: 'GDELT Archive',
  mcpEvents: 'GDELT Events',
  'mcp:reddit': 'Reddit Archive',
  'mcp:news': 'News Archive',
  // MCP intelligence sources
  usgsQuake: 'USGS',
  flightTrack: 'ADS-B',
  ofacMcp: 'OFAC SDN',
  polymarketMcp: 'Polymarket',
  maritime: 'Vessel Track',
  'mcp:usgs': 'USGS Archive',
  'mcp:flights': 'ADS-B',
  'mcp:sanctions': 'OFAC',
  'mcp:polymarket': 'Polymarket',
  'mcp:maritime': 'Maritime',
  'mcp:wikidata': 'WikiData',
  acled: 'ACLED',
  'mcp:acled': 'ACLED',
  'multi-cycle analysis': 'Multi-cycle analysis',
};

/**
 * Convert a raw sourceId like "telegram:Bloomberg" to a human-readable name.
 * Falls back to @channel or r/sub format for unknown IDs.
 */
export function formatSourceName(sourceId) {
  if (SOURCE_DISPLAY_NAMES[sourceId]) return SOURCE_DISPLAY_NAMES[sourceId];
  if (sourceId.startsWith('telegram:')) return `@${sourceId.split(':')[1]}`;
  if (sourceId.startsWith('reddit:')) return `r/${sourceId.split(':')[1]}`;
  if (sourceId.startsWith('twitter:')) return `@${sourceId.split(':')[1]}`;
  if (sourceId.startsWith('bluesky:')) return `@${sourceId.split(':')[1]}`;
  if (sourceId.startsWith('mcp:')) return sourceId.replace(/^mcp:/, 'MCP ');
  return sourceId;
}

/**
 * Convert a numeric confidence score into a concise label.
 */
export function getConfidenceLabel(confidence, severity, scoreBreakdown, sources, sourceProfile) {
  const sourceCount = sources ? new Set(sources).size : 0;
  const strongCount = sourceProfile?.strongSourceCount || 0;
  const verifiedCount = sourceProfile?.verifiedSourceCount || 0;

  let level = 'LOW';
  if (confidence >= 68) level = 'HIGH';
  else if (confidence >= 55) level = 'ELEVATED';
  else if (confidence >= 45) level = 'MODERATE';

  const details = [];
  if (sourceCount > 0) details.push(`${sourceCount} sources`);
  if (strongCount > 0) details.push(`${strongCount} strong`);
  else if (verifiedCount > 0) details.push(`${verifiedCount} verified`);
  if (details.length === 0 && severity) details.push(severity);

  return `${level} CONFIDENCE${details.length > 0 ? ` | ${details.join(', ')}` : ''}`;
}

/**
 * Build compact score breakdown string for alert transparency.
 */
export function formatScoreBreakdown(scoreBreakdown, confidence) {
  if (!scoreBreakdown) return '';
  return `Score: rel=${scoreBreakdown.reliability} corr=${scoreBreakdown.corroboration} rec=${scoreBreakdown.recency} xdom=${scoreBreakdown.crossDomain} | ${confidence}/100`;
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
export function escapeMarkdown(text) {
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Build analysis metadata lines for a Telegram alert.
 * Shows anomaly, escalation, and convergence data inline.
 */
export function buildAlertAnalysisMetadata(finding) {
  const lines = [];
  const analysis = finding._analysis || {};
  const entities = finding._entities || [];

  if (!analysis || entities.length === 0) return lines;

  for (const anomaly of (analysis.anomalies || [])) {
    if (entities.some((entity) => entity.toLowerCase().includes(anomaly.entity) || anomaly.entity.includes(entity.toLowerCase()))) {
      lines.push(`ANOMALY: ${anomaly.displayName} frequency ${Math.round(anomaly.ratio * 100)}% above baseline`);
    }
  }

  for (const escalation of (analysis.escalations || [])) {
    if (entities.some((entity) => entity.toLowerCase().includes(escalation.entity) || escalation.entity.includes(entity.toLowerCase()))) {
      lines.push(`ESCALATION: ${escalation.escalationsThisMonth} notable+ events this month`);
    }
  }

  for (const convergence of (analysis.convergences || [])) {
    if (entities.some((entity) => entity.toLowerCase().includes(convergence.entity) || convergence.entity.includes(entity.toLowerCase()))) {
      lines.push(`CONVERGENCE: ${convergence.domains.join(' + ')}`);
    }
  }

  return lines;
}

export function deriveWhyItMatters(finding) {
  if (typeof finding.why_matters === 'string' && finding.why_matters.trim()) {
    return finding.why_matters.trim();
  }

  const analysis = String(finding.analysis || '');
  const implicationMatch = analysis.match(/IMPLICATIONS?:\s*([\s\S]*?)(?:$|\n[A-Z ]+:)/i);
  if (implicationMatch?.[1]?.trim()) return implicationMatch[1].trim();

  const assessmentMatch = analysis.match(/ASSESSMENT:\s*([\s\S]*?)(?:IMPLICATIONS?:|$)/i);
  if (assessmentMatch?.[1]?.trim()) return assessmentMatch[1].trim();

  const sentences = analysis.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences[1] || sentences[0] || 'No implications supplied.';
}

function deriveSituationSummary(finding) {
  if (typeof finding.fact_line === 'string' && finding.fact_line.trim()) {
    return finding.fact_line.trim();
  }

  const analysis = String(finding.analysis || '');
  const situationMatch = analysis.match(/SITUATION:\s*([\s\S]*?)(?:ASSESSMENT:|IMPLICATIONS?:|$)/i);
  if (situationMatch?.[1]?.trim()) return situationMatch[1].trim();
  const firstSentence = analysis.split(/(?<=[.!?])\s+/).find(Boolean);
  return firstSentence || '';
}

function toPlainText(markdownText) {
  return String(markdownText || '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function buildSourceSummary(finding) {
  const displaySources = Array.isArray(finding.sources)
    ? [...new Set(finding.sources.map((sourceId) => formatSourceName(sourceId)))]
    : [];

  return displaySources.slice(0, 5);
}

function formatSupportTime(publishedAt) {
  if (!publishedAt) return '';
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function escapeMarkdownLinkUrl(url) {
  return String(url || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildSupportSummary(finding) {
  const support = Array.isArray(finding.support) ? finding.support : [];
  return support.slice(0, 3).map((item) => {
    const source = item.sourceLabel || formatSourceName(item.sourceId || '');
    const reason = item.reason ? ` (${item.reason})` : '';
    const timeLabel = formatSupportTime(item.publishedAt);
    const suffix = timeLabel ? ` — ${timeLabel}` : '';
    return `${source}${reason}${suffix}: ${item.excerpt || 'Supporting record available.'}`;
  });
}

function buildTopLinks(finding) {
  const support = Array.isArray(finding.support) ? finding.support : [];
  return support
    .filter((item) => item?.link)
    .slice(0, 3)
    .map((item) => {
      const label = item.publishedAt
        ? `${item.sourceLabel || formatSourceName(item.sourceId || '')} ${formatSupportTime(item.publishedAt)}`
        : (item.sourceLabel || formatSourceName(item.sourceId || ''));
      return `\\- [${escapeMarkdown(label)}](${escapeMarkdownLinkUrl(item.link)})`;
    });
}

export function buildIntelAlertText(finding) {
  const severityEmoji = {
    urgent: '\u{1F534}',
    breaking: '\u{1F534}',
    notable: '\u{1F7E1}',
    developing: '\u{1F4E1}',
  };

  const emoji = severityEmoji[finding.severity] || '\u{1F7E1}';
  const confidenceLabel = finding._confidence != null
    ? getConfidenceLabel(
      finding._confidence,
      finding.severity,
      finding._scoreBreakdown,
      finding.sources,
      finding._sourceProfile,
    )
    : String(finding.severity || '').toUpperCase();

  const whyTriggered = finding.why_i_believe || finding._whyTriggered || finding.why_triggered || 'Confidence gate triggered';
  const whyItMatters = deriveWhyItMatters(finding);
  const situationSummary = deriveSituationSummary(finding);
  const supportSummary = buildSupportSummary(finding);
  const topLinks = buildTopLinks(finding);
  const displaySources = buildSourceSummary(finding);

  const parts = [
    `${emoji} *${escapeMarkdown(String(finding.severity || '').toUpperCase())}* \\| ${escapeMarkdown(confidenceLabel)}`,
    '',
    `*${escapeMarkdown(finding.title || 'Untitled alert')}*`,
  ];

  if (situationSummary) {
    parts.push('');
    parts.push('*WHAT HAPPENED*');
    parts.push(escapeMarkdown(situationSummary));
  }

  parts.push('');
  parts.push('*WHY I BELIEVE THIS*');
  parts.push(escapeMarkdown(whyTriggered));

  if (supportSummary.length > 0) {
    for (const line of supportSummary) {
      parts.push(`\\- ${escapeMarkdown(line)}`);
    }
  }

  if (finding.what_changed) {
    parts.push('');
    parts.push('*WHAT CHANGED*');
    parts.push(escapeMarkdown(String(finding.what_changed)));
  }

  parts.push('');
  parts.push('*WHY IT MATTERS*');
  parts.push(escapeMarkdown(whyItMatters));

  if (finding.uncertainty) {
    parts.push('');
    parts.push('*UNCONFIRMED*');
    parts.push(escapeMarkdown(String(finding.uncertainty)));
  }

  if (Array.isArray(finding.watch_next) && finding.watch_next.length > 0) {
    parts.push('');
    parts.push('*WATCH FOR*');
    for (const indicator of finding.watch_next.slice(0, 4)) {
      parts.push(`\\- ${escapeMarkdown(indicator)}`);
    }
  }

  if (topLinks.length > 0) {
    parts.push('');
    parts.push('*TOP LINKS*');
    for (const linkLine of topLinks) {
      parts.push(linkLine);
    }
  } else if (displaySources.length > 0) {
    parts.push('');
    parts.push('*TOP SOURCES*');
    for (const source of displaySources) {
      parts.push(`\\- ${escapeMarkdown(source)}`);
    }
  }

  if (finding.watchlist_match) {
    parts.push('');
    parts.push(`*WATCHLIST* ${escapeMarkdown(String(finding.watchlist_match))}`);
  }

  if (finding._scoreBreakdown && finding._confidence != null) {
    parts.push('');
    parts.push(`_${escapeMarkdown(formatScoreBreakdown(finding._scoreBreakdown, finding._confidence))}_`);
  }

  return parts.join('\n');
}

/**
 * Split a long message into Telegram-safe chunks.
 */
export function splitTelegramMessage(text, maxLen = TELEGRAM_MAX_LENGTH) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    const headerPattern = /\n\*[A-Z]/g;
    let headerMatch;
    while ((headerMatch = headerPattern.exec(remaining)) !== null) {
      if (headerMatch.index > 0 && headerMatch.index <= maxLen) {
        splitAt = headerMatch.index;
      }
      if (headerMatch.index > maxLen) break;
    }

    if (splitAt === -1) {
      const lastDoubleNewline = remaining.lastIndexOf('\n\n', maxLen);
      if (lastDoubleNewline > maxLen * 0.3) splitAt = lastDoubleNewline;
    }

    if (splitAt === -1) {
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.3) splitAt = lastNewline;
    }

    if (splitAt === -1) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(Boolean);
}

async function sendTelegramChunk(botToken, chatId, text) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (resp.ok) return;

  const errBody = await resp.text();
  if (resp.status === 400 && errBody.includes("can't parse")) {
    const plainText = toPlainText(text);
    const retryResp = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: plainText,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (retryResp.ok) return;
    throw new Error(`Telegram retry failed: ${retryResp.status}`);
  }

  throw new Error(`Telegram API error ${resp.status}: ${errBody}`);
}

/**
 * Send a SITREP-format intelligence alert via Telegram.
 * Falls back to plain text if MarkdownV2 parsing fails.
 */
export async function sendIntelAlert(botToken, chatId, finding) {
  const text = buildIntelAlertText(finding);
  const chunks = splitTelegramMessage(text, TELEGRAM_MAX_LENGTH);

  for (const chunk of chunks) {
    await sendTelegramChunk(botToken, chatId, chunk);
  }
}
