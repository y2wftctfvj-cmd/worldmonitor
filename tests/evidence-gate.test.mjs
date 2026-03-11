import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildEvidenceProfile, buildTriggerExplanation } from '../api/_tools/evidence-gate.js';

describe('buildEvidenceProfile', () => {
  it('passes trust gate with 3+ sources including a strong one', () => {
    const profile = buildEvidenceProfile([
      { sourceId: 'headlines', meta: {} },
      { sourceId: 'telegram:intelslava', meta: {} },
      { sourceId: 'reddit:worldnews', meta: { score: 50 } },
    ]);

    assert.equal(profile.passesTrustGate, true);
    assert.equal(profile.hasStrongPlusCorroboration, true);
    assert.equal(profile.distinctSources, 3);
    assert.equal(profile.strongSourceCount, 1); // headlines = mainstream = strong
  });

  it('fails trust gate with a single social source', () => {
    const profile = buildEvidenceProfile([
      { sourceId: 'reddit:worldnews', meta: { score: 30 } },
    ]);

    assert.equal(profile.passesTrustGate, false);
    assert.equal(profile.distinctSources, 1);
    assert.equal(profile.strongSourceCount, 0);
    assert.equal(profile.verifiedSourceCount, 0);
  });

  it('counts strong and verified sources correctly', () => {
    const profile = buildEvidenceProfile([
      { sourceId: 'govFeeds', meta: {} },           // wire = strong + verified
      { sourceId: 'headlines', meta: {} },           // mainstream = strong + verified
      { sourceId: 'twitter', meta: {} },             // osint_verified = verified (not strong)
      { sourceId: 'reddit:worldnews', meta: { score: 200 } }, // social_verified (not verified tier)
    ]);

    assert.equal(profile.strongSourceCount, 2);     // govFeeds + headlines
    assert.equal(profile.verifiedSourceCount, 3);    // govFeeds + headlines + twitter
    assert.equal(profile.distinctSources, 4);
    assert.equal(profile.passesTrustGate, true);
  });

  it('passes trust gate via independent verified path', () => {
    // 2 verified sources from different types, no strong sources
    const profile = buildEvidenceProfile([
      { sourceId: 'twitter', meta: {} },             // osint_verified
      { sourceId: 'military', meta: {} },            // domain = verified
    ]);

    assert.equal(profile.hasStrongPlusCorroboration, false);
    assert.equal(profile.hasIndependentVerified, true);
    assert.equal(profile.passesTrustGate, true);
  });

  it('deduplicates sources by sourceId', () => {
    const profile = buildEvidenceProfile([
      { sourceId: 'headlines', meta: {} },
      { sourceId: 'headlines', meta: {} },
      { sourceId: 'headlines', meta: {} },
    ]);

    assert.equal(profile.distinctSources, 1);
    assert.equal(profile.passesTrustGate, false); // only 1 unique source
  });

  it('handles null/empty input gracefully', () => {
    assert.equal(buildEvidenceProfile(null).distinctSources, 0);
    assert.equal(buildEvidenceProfile([]).distinctSources, 0);
    assert.equal(buildEvidenceProfile(undefined).passesTrustGate, false);
  });
});

describe('buildTriggerExplanation', () => {
  it('formats strong corroboration explanation', () => {
    const profile = {
      hasStrongPlusCorroboration: true,
      hasIndependentVerified: false,
      strongSourceCount: 2,
      distinctSources: 4,
      verifiedSourceCount: 3,
      distinctVerifiedTypes: 2,
    };

    const result = buildTriggerExplanation(profile, null);
    assert.ok(result.includes('2 strong sources'));
    assert.ok(result.includes('4 total sources'));
  });

  it('formats verified sources explanation when no strong corroboration', () => {
    const profile = {
      hasStrongPlusCorroboration: false,
      hasIndependentVerified: true,
      strongSourceCount: 0,
      distinctSources: 3,
      verifiedSourceCount: 2,
      distinctVerifiedTypes: 2,
    };

    const result = buildTriggerExplanation(profile, null);
    assert.ok(result.includes('2 verified sources'));
    assert.ok(result.includes('2 domains'));
  });

  it('includes watchlist match when provided', () => {
    const profile = {
      hasStrongPlusCorroboration: true,
      strongSourceCount: 1,
      distinctSources: 2,
    };

    const result = buildTriggerExplanation(profile, 'Iran');
    assert.ok(result.includes('watchlist match: Iran'));
  });

  it('returns watchlist-only message when profile is null', () => {
    const result = buildTriggerExplanation(null, 'Taiwan');
    assert.equal(result, 'Watchlist match: Taiwan');
  });

  it('returns default message when no profile and no watchlist', () => {
    const result = buildTriggerExplanation(null, null);
    assert.equal(result, 'Confidence gate triggered');
  });
});
