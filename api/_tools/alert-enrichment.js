import { formatSourceName } from './alert-sender.js';
import { getReliability, isStrongTier, isVerifiedTier } from './source-reliability.js';
import { buildEvidenceProfile, buildTriggerExplanation } from './evidence-gate.js';

const SUPPORT_EXCERPT_MAX = 120;

function trimExcerpt(text) {
  const cleaned = String(text || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+-\s+(Reuters|AP News|Associated Press|BBC News|Bloomberg|The Guardian|Guardian|CNN|CNBC|CBS News|NBC News)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= SUPPORT_EXCERPT_MAX) return cleaned;
  return `${cleaned.slice(0, SUPPORT_EXCERPT_MAX - 3).trim()}...`;
}

function scoreSupportRecord(record) {
  const reliability = getReliability(record?.sourceId || '', record?.meta);
  const publishedAt = record?.meta?.publishedAt || record?.timestamp || null;
  const timestamp = publishedAt ? new Date(publishedAt).getTime() : 0;
  const hasLink = Boolean(record?.meta?.link);

  return {
    record,
    reliability,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    priority: reliability.score + (hasLink ? 4 : 0),
  };
}

function getSupportReason(entry, index, seenTypes) {
  const { reliability, record } = entry;
  const sourceType = String(record?.sourceId || '').split(':')[0];

  if (index === 0 && isStrongTier(reliability.tier)) return 'Strong-source confirmation';
  if (index === 0 && isVerifiedTier(reliability.tier)) return 'Best available confirmation';
  if (!seenTypes.has(sourceType)) return 'Independent corroboration';
  if (isStrongTier(reliability.tier)) return 'Strong corroboration';
  if (isVerifiedTier(reliability.tier)) return 'Verified corroboration';
  if (record?.meta?.link) return 'Direct-source detail';
  return 'Additional corroboration';
}

export function buildCandidateSupport(candidate, limit = 3) {
  const ranked = (candidate?.records || [])
    .filter((record) => record?.text)
    .map(scoreSupportRecord)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.timestamp - a.timestamp;
    });

  const supports = [];
  const seenSources = new Set();
  const seenTypes = new Set();

  for (const entry of ranked) {
    const sourceId = String(entry.record?.sourceId || '');
    if (!sourceId || seenSources.has(sourceId)) continue;

    const sourceType = sourceId.split(':')[0];
    const reason = getSupportReason(entry, supports.length, seenTypes);

    supports.push({
      sourceId,
      sourceLabel: entry.record?.meta?.feedSource || formatSourceName(sourceId),
      reason,
      excerpt: trimExcerpt(entry.record.text),
      link: entry.record?.meta?.link || null,
      publishedAt: entry.record?.meta?.publishedAt || entry.record?.timestamp || null,
      tier: entry.reliability.tier,
    });

    seenSources.add(sourceId);
    seenTypes.add(sourceType);
    if (supports.length >= limit) break;
  }

  return supports;
}

function formatSourceList(sourceIds) {
  const labels = [...new Set((sourceIds || []).map((sourceId) => formatSourceName(sourceId)))];
  if (labels.length === 0) return 'supporting sources';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more`;
}

export function buildCandidateChangeSummary(candidate) {
  const delta = candidate?.delta || {};
  const newRecordCount = Number(delta.newRecordCount || 0);
  const newSourceIds = Array.isArray(delta.newSourceLabels) && delta.newSourceLabels.length > 0
    ? delta.newSourceLabels
    : (Array.isArray(delta.newSourceIds) ? delta.newSourceIds : []);
  const newStrongSourceIds = Array.isArray(delta.newStrongSourceLabels) && delta.newStrongSourceLabels.length > 0
    ? delta.newStrongSourceLabels
    : (Array.isArray(delta.newStrongSourceIds) ? delta.newStrongSourceIds : []);

  if (newStrongSourceIds.length > 0) {
    return `New strong-source confirmation arrived this cycle from ${formatSourceList(newStrongSourceIds)}.`;
  }

  if (newSourceIds.length > 0) {
    const recordLabel = newRecordCount === 1 ? 'record' : 'records';
    return `This cycle added ${newRecordCount || newSourceIds.length} new supporting ${recordLabel} from ${formatSourceList(newSourceIds)}.`;
  }

  if (candidate?.watchlistMatch) {
    return 'The event remains active on your watchlist, but the source mix is largely unchanged from the prior cycle.';
  }

  return 'No materially new corroboration appeared in the latest cycle.';
}

export function buildCandidateUncertaintySummary(candidate, providedUncertainty = '') {
  if (typeof providedUncertainty === 'string' && providedUncertainty.trim()) {
    return providedUncertainty.trim();
  }

  const recordText = (candidate?.records || [])
    .map((record) => String(record?.text || '').toLowerCase())
    .join(' ');

  const profile = candidate?.sourceProfile || {};

  if (/\b(unconfirmed|reportedly|claims|claim|possible|suspected|preliminary)\b/.test(recordText)) {
    return 'The core event is corroborated, but damage, casualties, and full attribution remain unclear.';
  }

  if ((profile.strongSourceCount || 0) === 0 && (profile.verifiedSourceCount || 0) > 0) {
    return 'Independent reporting exists, but official or strong-source confirmation is still limited.';
  }

  if ((profile.distinctSources || 0) <= 2) {
    return 'The core event is credible, but scope, downstream effects, and official responses remain unclear.';
  }

  return 'Follow-on actions, damage scope, and official responses remain unclear.';
}

export function buildCandidateFactLine(candidate, providedFactLine = '') {
  if (typeof providedFactLine === 'string' && providedFactLine.trim()) {
    return providedFactLine.trim();
  }

  const bestRecord = (candidate?.records || [])
    .filter((record) => record?.text)
    .map(scoreSupportRecord)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.timestamp - a.timestamp;
    })[0];

  return bestRecord ? trimExcerpt(bestRecord.record.text) : 'No fact line available.';
}

export function buildEvidenceNarrative(finding) {
  const support = Array.isArray(finding?.support) ? finding.support : [];
  const supportLabels = [...new Set(
    support.map((item) => item.sourceLabel || formatSourceName(item.sourceId)).filter(Boolean)
  )];

  if (supportLabels.length >= 3) {
    return `${formatSourceList(supportLabels)} align on the core event.`;
  }

  if (supportLabels.length === 2) {
    return `${formatSourceList(supportLabels)} independently corroborate the core event.`;
  }

  if (supportLabels.length === 1) {
    return `${formatSourceList(supportLabels)} provides the strongest current confirmation.`;
  }

  const profile = finding?._sourceProfile || {};
  if ((profile.strongSourceCount || 0) > 0) {
    return `Strong-source confirmation is present with ${profile.distinctSources || 0} total sources.`;
  }

  return 'Multiple supporting sources align on the core event.';
}

/**
 * Derive a grounded title from the highest-reliability source record.
 * Strips RSS feed prefixes and trailing mainstream source suffixes.
 *
 * @param {Object} candidate - Fusion candidate with records
 * @returns {string} Clean, grounded title (max 110 chars)
 */
export function deriveGroundedTitle(candidate) {
  const bestRecord = candidate?.records
    ?.filter((record) => record.text && record.text.length > 15)
    .sort((a, b) => {
      const relA = getReliability(a.sourceId, a.meta);
      const relB = getReliability(b.sourceId, b.meta);
      return (relB?.score || 0) - (relA?.score || 0);
    })[0];

  if (!bestRecord?.text) {
    return candidate?.entities?.slice(0, 3).join(', ') + ': developing situation';
  }

  return bestRecord.text
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+-\s+(Reuters|AP News|Associated Press|BBC News|Bloomberg|The Guardian|Guardian|CNN|CNBC|CBS News|NBC News)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

/**
 * Build a structured finding by merging fusion candidate data with LLM output.
 * Combines evidence profile, support records, change summary, and analysis.
 *
 * @param {Object} candidate - Fusion candidate
 * @param {Object} [llmFinding={}] - LLM-generated fields (analysis, watch_next, etc.)
 * @param {Object} [analysisResults={}] - Deterministic analysis results
 * @returns {Object} Structured finding ready for alert delivery
 */
export function buildStructuredFinding(candidate, llmFinding = {}, analysisResults = {}) {
  const sources = [...new Set(candidate.records.map((record) => record.sourceId))];
  const sourceProfile = candidate.sourceProfile || buildEvidenceProfile(candidate.records);
  const whyTriggered = buildTriggerExplanation(sourceProfile, candidate.watchlistMatch);
  const support = buildCandidateSupport(candidate);

  return {
    severity: candidate.severity,
    title: deriveGroundedTitle(candidate),
    fact_line: buildCandidateFactLine(candidate, llmFinding.fact_line || ''),
    analysis: llmFinding.analysis || '',
    why_matters: llmFinding.why_matters || llmFinding.why_now || '',
    why_i_believe: buildEvidenceNarrative({ support, _sourceProfile: sourceProfile }),
    what_changed: buildCandidateChangeSummary(candidate),
    uncertainty: buildCandidateUncertaintySummary(candidate, llmFinding.uncertainty || ''),
    sources,
    support,
    watchlist_match: candidate.watchlistMatch,
    watch_next: Array.isArray(llmFinding.watch_next)
      ? llmFinding.watch_next.filter((item) => typeof item === 'string' && item.trim()).slice(0, 4)
      : [],
    _confidence: candidate.confidence,
    _scoreBreakdown: candidate.scoreBreakdown,
    _entities: candidate.entities,
    _analysis: analysisResults || {},
    _sourceProfile: sourceProfile,
    _whyTriggered: whyTriggered,
  };
}
