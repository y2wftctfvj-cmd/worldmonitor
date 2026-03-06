/**
 * Trust gating for alert promotion and delivery.
 */

import { getReliability, isStrongTier, isVerifiedTier } from './source-reliability.js';

export function buildEvidenceProfile(records) {
  const uniqueSources = [];
  const seen = new Set();

  for (const record of records || []) {
    const sourceId = String(record?.sourceId || '');
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const reliability = getReliability(sourceId, record?.meta);
    uniqueSources.push({
      sourceId,
      sourceType: sourceId.split(':')[0],
      tier: reliability.tier,
      label: reliability.label,
      score: reliability.score,
    });
  }

  const strongSources = uniqueSources.filter((source) => isStrongTier(source.tier));
  const verifiedSources = uniqueSources.filter((source) => isVerifiedTier(source.tier));
  const distinctTypes = new Set(uniqueSources.map((source) => source.sourceType)).size;
  const distinctVerifiedTypes = new Set(verifiedSources.map((source) => source.sourceType)).size;

  const hasStrongPlusCorroboration = strongSources.length >= 1 && uniqueSources.length >= 2;
  const hasIndependentVerified = verifiedSources.length >= 2 && uniqueSources.length >= 2 && (distinctVerifiedTypes >= 2 || verifiedSources.length >= 2);
  const passesTrustGate = hasStrongPlusCorroboration || hasIndependentVerified;

  return {
    uniqueSources,
    strongSources,
    verifiedSources,
    distinctSources: uniqueSources.length,
    distinctTypes,
    distinctVerifiedTypes,
    strongSourceCount: strongSources.length,
    verifiedSourceCount: verifiedSources.length,
    hasStrongPlusCorroboration,
    hasIndependentVerified,
    passesTrustGate,
  };
}

export function buildTriggerExplanation(profile, watchlistMatch) {
  if (!profile) return watchlistMatch ? `Watchlist match: ${watchlistMatch}` : 'Confidence gate triggered';

  const reasons = [];
  if (profile.hasStrongPlusCorroboration) {
    reasons.push(`${profile.strongSourceCount} strong source${profile.strongSourceCount === 1 ? '' : 's'} corroborated by ${profile.distinctSources} total sources`);
  } else if (profile.hasIndependentVerified) {
    reasons.push(`${profile.verifiedSourceCount} verified sources across ${Math.max(profile.distinctVerifiedTypes, 1)} domain${Math.max(profile.distinctVerifiedTypes, 1) === 1 ? '' : 's'}`);
  }

  if (watchlistMatch) {
    reasons.push(`watchlist match: ${watchlistMatch}`);
  }

  return reasons.join(' · ') || 'Confidence gate triggered';
}
