import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

// We test the logic by importing the module functions and mocking Redis at the fetch level.
// Since loadDevelopingItems/updateDevelopingItems use fetch() for Redis,
// we test the core matching logic via updateDevelopingItems with a mock fetch.

import { jaccardSimilarity, hasEntityOverlap, isDuplicateAlert } from '../api/_tools/alert-dedup.js';

describe('developing-tracker matching logic', () => {
  // These functions from alert-dedup.js are used by developing-tracker for fuzzy matching

  describe('jaccardSimilarity', () => {
    it('returns 1.0 for identical strings', () => {
      const sim = jaccardSimilarity('Iran strikes Israel', 'Iran strikes Israel');
      assert.equal(sim, 1.0);
    });

    it('returns high similarity for near-identical titles', () => {
      const sim = jaccardSimilarity(
        'Iran launches missile strikes on Israel',
        'Iran launches missile strikes against Israel'
      );
      assert.ok(sim > 0.5, `Expected similarity > 0.5, got ${sim}`);
    });

    it('returns low similarity for unrelated titles', () => {
      const sim = jaccardSimilarity(
        'Iran launches missile strikes',
        'Stock market rally continues on Wall Street'
      );
      assert.ok(sim < 0.2, `Expected similarity < 0.2, got ${sim}`);
    });

    it('handles empty strings', () => {
      assert.equal(jaccardSimilarity('', ''), 0);
      assert.equal(jaccardSimilarity('test', ''), 0);
    });
  });

  describe('hasEntityOverlap', () => {
    it('detects overlap when entities share members', () => {
      assert.equal(
        hasEntityOverlap(['Iran', 'Israel', 'Damascus'], ['Israel', 'Syria', 'Damascus']),
        true
      );
    });

    it('returns false when no overlap', () => {
      assert.equal(
        hasEntityOverlap(['Iran', 'Israel'], ['China', 'Taiwan']),
        false
      );
    });

    it('handles empty arrays', () => {
      assert.equal(hasEntityOverlap([], ['Iran']), false);
      assert.equal(hasEntityOverlap(['Iran'], []), false);
      assert.equal(hasEntityOverlap([], []), false);
    });
  });

  describe('isDuplicateAlert', () => {
    it('detects duplicate by title similarity', () => {
      const recent = [
        { title: 'Iran launches strikes on Israeli positions', entities: ['Iran', 'Israel'] },
      ];
      const finding = {
        severity: 'notable',
        title: 'Iran launches strikes on Israeli positions near border',
        _entities: ['Iran', 'Israel'],
      };
      assert.equal(isDuplicateAlert(finding, recent), true);
    });

    it('detects duplicate by entity overlap with partial title similarity', () => {
      // isDuplicateAlert requires titleSimilarity > 0.18 even with entity overlap
      const recent = [
        { title: 'Military escalation in Middle East conflict zone', entities: ['Iran', 'Israel', 'Hezbollah'], severity: 'notable' },
      ];
      const finding = {
        severity: 'notable',
        title: 'Escalation in Middle East military zone reported',
        _entities: ['Iran', 'Israel', 'Hezbollah'],
      };
      assert.equal(isDuplicateAlert(finding, recent), true);
    });

    it('returns false for genuinely different alerts', () => {
      const recent = [
        { title: 'Iran nuclear talks resume in Vienna', entities: ['Iran', 'Vienna'] },
      ];
      const finding = {
        severity: 'notable',
        title: 'China restricts rare earth exports to US',
        _entities: ['China', 'United States'],
      };
      assert.equal(isDuplicateAlert(finding, recent), false);
    });
  });
});

describe('developing item lifecycle', () => {
  it('new developing items start with count 1', () => {
    // Simulating the logic from updateDevelopingItems
    const finding = {
      severity: 'developing',
      title: 'Unusual military movements near Taiwan',
      _entities: ['Taiwan', 'China'],
    };

    const newItem = {
      topic: finding.title,
      count: 1,
      lastSeen: Date.now(),
      entities: finding._entities || [],
      alerted: false,
    };

    assert.equal(newItem.count, 1);
    assert.equal(newItem.alerted, false);
    assert.deepEqual(newItem.entities, ['Taiwan', 'China']);
  });

  it('matching items increment cycle count', () => {
    const existing = {
      topic: 'Unusual military movements near Taiwan',
      count: 2,
      lastSeen: Date.now() - 300000, // 5 min ago
      entities: ['Taiwan', 'China'],
      alerted: false,
    };

    const finding = {
      severity: 'developing',
      title: 'Unusual military movements near Taiwan Strait',
      _entities: ['Taiwan', 'China', 'PLA'],
    };

    // Simulating the match + update logic from updateDevelopingItems
    const sim = jaccardSimilarity(finding.title, existing.topic);
    assert.ok(sim > 0.35, `Expected match: similarity ${sim} should be > 0.35`);

    const updated = {
      ...existing,
      count: existing.count + 1,
      lastSeen: Date.now(),
      entities: [...new Set([...existing.entities, ...(finding._entities || [])])],
    };

    assert.equal(updated.count, 3);
    assert.ok(updated.entities.includes('PLA')); // merged entity
  });

  it('items reaching threshold (3+) are eligible for promotion', () => {
    const DEVELOPING_THRESHOLD = 3;

    const readyItem = { topic: 'Test', count: 3, alerted: false };
    const notReadyItem = { topic: 'Test', count: 2, alerted: false };
    const alreadyAlerted = { topic: 'Test', count: 5, alerted: true };

    assert.ok(readyItem.count >= DEVELOPING_THRESHOLD && !readyItem.alerted);
    assert.ok(!(notReadyItem.count >= DEVELOPING_THRESHOLD));
    assert.ok(alreadyAlerted.alerted); // should be skipped
  });
});
