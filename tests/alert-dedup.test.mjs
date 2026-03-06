/**
 * Tests for alert dedup logic — Jaccard similarity and entity overlap.
 *
 * Since jaccardSimilarity is a private function in monitor-check.js,
 * we replicate the algorithm here and test it directly. This validates
 * the dedup thresholds and edge cases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasEntityOverlap, isDuplicateAlert, jaccardSimilarity } from '../api/_tools/alert-dedup.js';

// ---------------------------------------------------------------------------
// Jaccard similarity tests
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    const sim = jaccardSimilarity(
      'Iran nuclear talks resume in Vienna',
      'Iran nuclear talks resume in Vienna'
    );
    assert.equal(sim, 1.0);
  });

  it('returns 0 for completely different strings', () => {
    const sim = jaccardSimilarity(
      'Iran nuclear talks resume',
      'Japan earthquake hits coastal region'
    );
    assert.equal(sim, 0);
  });

  it('returns partial overlap for related headlines', () => {
    const sim = jaccardSimilarity(
      'Iran nuclear deal collapses after talks fail',
      'Iran nuclear negotiations break down today'
    );
    // "iran", "nuclear" overlap, other words differ
    assert.ok(sim > 0, 'should have some overlap');
    assert.ok(sim < 1, 'should not be identical');
  });

  it('is case-insensitive', () => {
    const sim1 = jaccardSimilarity('Iran Nuclear', 'iran nuclear');
    const sim2 = jaccardSimilarity('BREAKING NEWS', 'breaking news');
    assert.equal(sim1, 1.0);
    assert.equal(sim2, 1.0);
  });

  it('ignores short words (<=2 chars)', () => {
    // "in", "at", "to" should be filtered out
    const sim = jaccardSimilarity(
      'Iran in crisis at the UN',
      'Iran in trouble at the summit'
    );
    // "iran" matches, "crisis"/"trouble" don't, "the" matches
    assert.ok(sim > 0, 'should have some match');
  });

  it('strips punctuation before comparison', () => {
    const sim = jaccardSimilarity(
      'Iran: nuclear talks resume!',
      'Iran — nuclear talks resume.'
    );
    assert.equal(sim, 1.0);
  });

  it('returns 0 for empty strings', () => {
    assert.equal(jaccardSimilarity('', ''), 0);
    assert.equal(jaccardSimilarity('test', ''), 0);
    assert.equal(jaccardSimilarity('', 'test'), 0);
  });

  it('handles strings with only short words', () => {
    assert.equal(jaccardSimilarity('in at to', 'on by of'), 0);
  });
});

// ---------------------------------------------------------------------------
// Entity overlap tests
// ---------------------------------------------------------------------------

describe('hasEntityOverlap', () => {
  it('returns true for 2+ shared entities', () => {
    assert.ok(hasEntityOverlap(['Iran', 'Israel'], ['Iran', 'Israel', 'Nuclear']));
  });

  it('returns true for 1 shared entity when sets are small', () => {
    assert.ok(hasEntityOverlap(['Iran'], ['Iran', 'Nuclear']));
  });

  it('returns false for no overlap', () => {
    assert.ok(!hasEntityOverlap(['Iran'], ['Japan']));
  });

  it('returns false for empty arrays', () => {
    assert.ok(!hasEntityOverlap([], ['Iran']));
    assert.ok(!hasEntityOverlap(['Iran'], []));
    assert.ok(!hasEntityOverlap([], []));
  });

  it('returns false for null/undefined', () => {
    assert.ok(!hasEntityOverlap(null, ['Iran']));
    assert.ok(!hasEntityOverlap(['Iran'], null));
  });

  it('is case-insensitive', () => {
    assert.ok(hasEntityOverlap(['iran'], ['Iran']));
    assert.ok(hasEntityOverlap(['IRAN', 'ISRAEL'], ['iran', 'israel']));
  });
});

// ---------------------------------------------------------------------------
// Combined dedup logic tests
// ---------------------------------------------------------------------------

describe('isDuplicate', () => {
  const recentAlerts = [
    { title: 'Iran nuclear talks resume in Vienna after months of stalemate', entities: ['Iran', 'Nuclear'] },
    { title: 'China trade deal signed with European Union partners today', entities: ['China', 'EU'] },
    { title: 'Russia Ukraine conflict escalates with new missile strikes reported', entities: ['Russia', 'Ukraine'] },
  ];

  it('detects duplicate by high title similarity (>0.4)', () => {
    assert.ok(isDuplicate(
      'Iran nuclear talks resume in Vienna following extended delay',
      ['Iran'],
      recentAlerts
    ));
  });

  it('does not flag unrelated alerts', () => {
    assert.ok(!isDuplicate(
      'Japan earthquake magnitude seven hits northern coast region',
      ['Japan'],
      recentAlerts
    ));
  });

  it('detects duplicate by entity overlap + moderate title similarity', () => {
    // Needs Jaccard > 0.25 AND entity overlap
    // "Iran nuclear talks resume in Vienna" vs "Iran nuclear talks stall in Vienna"
    // Shared words: iran, nuclear, talks, resume/stall, vienna → high overlap
    assert.ok(isDuplicate(
      'Iran nuclear talks stall in Vienna after setback',
      ['Iran', 'Nuclear'],
      recentAlerts
    ));
  });

  it('allows alerts about same entity but different topic', () => {
    // Same entity (Iran) but completely different topic = not duplicate
    const result = isDuplicate(
      'Iran earthquake kills dozens in southern province this morning',
      ['Iran'],
      recentAlerts
    );
    // This should not match because title similarity is very low
    // even though entity overlaps — Jaccard < 0.25
    assert.ok(!result, 'different topic about same entity should not be duplicate');
  });

  it('returns false for empty recent alerts', () => {
    assert.ok(!isDuplicate('Any headline here about anything', ['Iran'], []));
  });
});

// ---------------------------------------------------------------------------
// Dedup threshold validation
// ---------------------------------------------------------------------------

describe('dedup thresholds', () => {
  it('0.4 Jaccard threshold catches near-identical headlines', () => {
    // Same story, minor word changes — high Jaccard
    const sim = jaccardSimilarity(
      'Iran launches ballistic missiles toward Israel overnight',
      'Iran launches ballistic missiles toward Israel today'
    );
    // Shared: iran, launches, ballistic, missiles, toward, israel = 6/7
    assert.ok(sim > 0.4, `sim ${sim} should be >0.4 for near-identical headline`);
  });

  it('0.4 threshold allows genuinely different stories', () => {
    const sim = jaccardSimilarity(
      'Iran launches ballistic missiles toward Israel',
      'China announces new semiconductor export controls on technology'
    );
    assert.ok(sim <= 0.4, `sim ${sim} should be <=0.4 for different stories`);
  });

  it('0.25 threshold with entity overlap catches related updates', () => {
    // Related topic with moderate word overlap
    const sim = jaccardSimilarity(
      'Iran nuclear enrichment reaches critical levels',
      'Iran nuclear enrichment exceeds critical threshold'
    );
    // Shared: iran, nuclear, enrichment, critical = 4/7
    assert.ok(sim > 0.25, `sim ${sim} should be >0.25 for related update`);
  });
});

function isDuplicate(newTitle, newEntities, recentAlerts, severity = 'notable') {
  return isDuplicateAlert({ title: newTitle, _entities: newEntities, severity }, recentAlerts);
}
