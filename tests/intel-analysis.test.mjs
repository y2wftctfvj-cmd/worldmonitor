/**
 * Tests for intel-analysis.js — anomaly detection, escalation, convergence, historical context.
 *
 * These are pure functions (no Redis, no LLM) so we can test them directly
 * with mock data structures.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAnomalies,
  detectEscalation,
  detectConvergence,
  generateHistoricalContext,
} from '../api/_tools/intel-analysis.js';

// ---------------------------------------------------------------------------
// Test helpers — build mock data structures
// ---------------------------------------------------------------------------

/** Build a mock EventCandidate with entities, records, and severity */
function mockCandidate({ entities = ['Iran'], sourceIds = ['headlines'], severity = 'notable', confidence = 60, clusterId = 'c1' } = {}) {
  return {
    entities,
    records: sourceIds.map(id => ({ sourceId: id })),
    severity,
    confidence,
    clusterId,
  };
}

/** Build a mock baseline object */
function mockBaseline({ avgDailyMentions = 2, insufficient = false } = {}) {
  if (insufficient) return { insufficient: true, observationCount: 1 };
  return {
    avgDailyMentions,
    avgConfidence: 50,
    avgSourceCount: 2,
    observationCount: 10,
    lastUpdated: Date.now(),
  };
}

/** Build a mock ledger entry with observations */
function mockLedger({ entity = 'iran', observations = [] } = {}) {
  return {
    entity,
    displayName: entity.charAt(0).toUpperCase() + entity.slice(1),
    observations,
    baseline: { avgDailyMentions: 5, observationCount: observations.length },
  };
}

// ---------------------------------------------------------------------------
// 1. detectAnomalies
// ---------------------------------------------------------------------------

describe('detectAnomalies', () => {
  it('returns empty array for null/empty inputs', () => {
    assert.deepEqual(detectAnomalies(null, new Map()), []);
    assert.deepEqual(detectAnomalies([], new Map()), []);
    assert.deepEqual(detectAnomalies([mockCandidate()], null), []);
  });

  it('flags entity with frequency 3x+ above baseline and 3+ sources', () => {
    // Baseline: 2 mentions/day → 2/288 per cycle ≈ 0.0069
    // Current: 5 mentions from 4 sources → ratio ≈ 5 / 0.0069 ≈ 720
    const candidates = [
      mockCandidate({ entities: ['Iran'], sourceIds: ['headlines'], clusterId: 'c1' }),
      mockCandidate({ entities: ['Iran'], sourceIds: ['telegram:intelslava'], clusterId: 'c2' }),
      mockCandidate({ entities: ['Iran'], sourceIds: ['military'], clusterId: 'c3' }),
      mockCandidate({ entities: ['Iran'], sourceIds: ['markets'], clusterId: 'c4' }),
      mockCandidate({ entities: ['Iran'], sourceIds: ['reddit'], clusterId: 'c5' }),
    ];

    const baselines = new Map([['iran', mockBaseline({ avgDailyMentions: 2 })]]);

    const result = detectAnomalies(candidates, baselines);

    assert.equal(result.length, 1);
    assert.equal(result[0].entity, 'iran');
    assert.ok(result[0].ratio >= 3, `ratio ${result[0].ratio} should be >= 3`);
    assert.ok(result[0].currentSources >= 3, `sources ${result[0].currentSources} should be >= 3`);
  });

  it('skips entities with insufficient baselines', () => {
    const candidates = [
      mockCandidate({ entities: ['Iran'], sourceIds: ['headlines', 'military', 'markets'] }),
    ];

    const baselines = new Map([['iran', mockBaseline({ insufficient: true })]]);

    const result = detectAnomalies(candidates, baselines);
    assert.equal(result.length, 0);
  });

  it('skips entities with fewer than 3 sources even if ratio is high', () => {
    // Only 1 source, even with high ratio
    const candidates = [
      mockCandidate({ entities: ['Iran'], sourceIds: ['headlines'] }),
    ];

    const baselines = new Map([['iran', mockBaseline({ avgDailyMentions: 0.1 })]]);

    const result = detectAnomalies(candidates, baselines);
    assert.equal(result.length, 0);
  });

  it('normalizes entity aliases before comparison', () => {
    // "Tehran" should normalize to "iran" and match baseline
    const candidates = [
      mockCandidate({ entities: ['Tehran'], sourceIds: ['headlines'], clusterId: 'c1' }),
      mockCandidate({ entities: ['Tehran'], sourceIds: ['military'], clusterId: 'c2' }),
      mockCandidate({ entities: ['Tehran'], sourceIds: ['markets'], clusterId: 'c3' }),
      mockCandidate({ entities: ['Tehran'], sourceIds: ['reddit'], clusterId: 'c4' }),
    ];

    const baselines = new Map([['iran', mockBaseline({ avgDailyMentions: 1 })]]);

    const result = detectAnomalies(candidates, baselines);
    assert.equal(result.length, 1);
    assert.equal(result[0].entity, 'iran');
  });

  it('assigns correct severity tiers', () => {
    // With avgDailyMentions = 0.5, and many candidates, ratio should be very high
    const candidates = Array.from({ length: 10 }, (_, i) =>
      mockCandidate({ entities: ['Iran'], sourceIds: [`source${i}`], clusterId: `c${i}` })
    );

    const baselines = new Map([['iran', mockBaseline({ avgDailyMentions: 0.1 })]]);

    const result = detectAnomalies(candidates, baselines);
    assert.equal(result.length, 1);
    // With 10 mentions and 0.1/day baseline, ratio should be massive → critical
    assert.equal(result[0].severity, 'critical');
  });

  it('sorts anomalies by ratio descending', () => {
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) =>
        mockCandidate({ entities: ['Iran'], sourceIds: [`s${i}`], clusterId: `ir${i}` })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        mockCandidate({ entities: ['China'], sourceIds: [`s${i + 10}`], clusterId: `cn${i}` })
      ),
    ];

    const baselines = new Map([
      ['iran', mockBaseline({ avgDailyMentions: 0.5 })],
      ['china', mockBaseline({ avgDailyMentions: 10 })],
    ]);

    const result = detectAnomalies(candidates, baselines);
    // Iran has higher ratio (fewer baseline mentions) so should be first
    if (result.length >= 2) {
      assert.ok(result[0].ratio >= result[1].ratio, 'should sort by ratio descending');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. detectEscalation
// ---------------------------------------------------------------------------

describe('detectEscalation', () => {
  it('returns empty array for null/empty inputs', () => {
    assert.deepEqual(detectEscalation(null), []);
    assert.deepEqual(detectEscalation(new Map()), []);
  });

  it('detects escalation when recent severity is higher than earlier', () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const thirtyMinAgo = now - 30 * 60 * 1000;

    const ledger = new Map([
      ['iran', mockLedger({
        entity: 'iran',
        observations: [
          // Earlier observations — low severity
          { ts: twoHoursAgo, severity: 'routine' },
          { ts: twoHoursAgo + 5000, severity: 'developing' },
          // Recent observations — high severity
          { ts: thirtyMinAgo, severity: 'breaking' },
          { ts: thirtyMinAgo + 5000, severity: 'urgent' },
        ],
      })],
    ]);

    const result = detectEscalation(ledger);
    assert.equal(result.length, 1);
    assert.equal(result[0].entity, 'iran');
    assert.equal(result[0].trend, 'escalating');
    assert.ok(result[0].severityDelta >= 0.5, `delta ${result[0].severityDelta} should be >= 0.5`);
  });

  it('does not flag de-escalation', () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const thirtyMinAgo = now - 30 * 60 * 1000;

    const ledger = new Map([
      ['iran', mockLedger({
        entity: 'iran',
        observations: [
          // Earlier — high severity
          { ts: twoHoursAgo, severity: 'urgent' },
          { ts: twoHoursAgo + 5000, severity: 'breaking' },
          // Recent — low severity
          { ts: thirtyMinAgo, severity: 'routine' },
          { ts: thirtyMinAgo + 5000, severity: 'developing' },
        ],
      })],
    ]);

    const result = detectEscalation(ledger);
    assert.equal(result.length, 0);
  });

  it('requires at least 4 observations', () => {
    const now = Date.now();
    const ledger = new Map([
      ['iran', mockLedger({
        entity: 'iran',
        observations: [
          { ts: now - 3600000, severity: 'routine' },
          { ts: now, severity: 'urgent' },
        ],
      })],
    ]);

    const result = detectEscalation(ledger);
    assert.equal(result.length, 0);
  });

  it('requires at least 2 observations in each time window', () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    // 3 earlier, only 1 recent — should skip
    const ledger = new Map([
      ['iran', mockLedger({
        entity: 'iran',
        observations: [
          { ts: twoHoursAgo, severity: 'routine' },
          { ts: twoHoursAgo + 1000, severity: 'routine' },
          { ts: twoHoursAgo + 2000, severity: 'routine' },
          { ts: now - 30 * 60 * 1000, severity: 'urgent' },
        ],
      })],
    ]);

    const result = detectEscalation(ledger);
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. detectConvergence
// ---------------------------------------------------------------------------

describe('detectConvergence', () => {
  it('returns empty array for null/empty inputs', () => {
    assert.deepEqual(detectConvergence(null), []);
    assert.deepEqual(detectConvergence([]), []);
  });

  it('detects entity appearing across 3+ domains', () => {
    const candidates = [
      // DIPLOMATIC (govFeeds)
      mockCandidate({ entities: ['Iran'], sourceIds: ['govFeeds'] }),
      // MILITARY
      mockCandidate({ entities: ['Iran'], sourceIds: ['military'] }),
      // ECONOMIC
      mockCandidate({ entities: ['Iran'], sourceIds: ['markets'] }),
    ];

    const result = detectConvergence(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].entity, 'iran');
    assert.equal(result[0].domainCount, 3);
    assert.deepEqual(result[0].domains, ['DIPLOMATIC', 'ECONOMIC', 'MILITARY']);
    assert.equal(result[0].significance, 'moderate');
  });

  it('assigns correct significance levels', () => {
    const candidates = [
      mockCandidate({ entities: ['Iran'], sourceIds: ['govFeeds'] }),    // DIPLOMATIC
      mockCandidate({ entities: ['Iran'], sourceIds: ['military'] }),     // MILITARY
      mockCandidate({ entities: ['Iran'], sourceIds: ['markets'] }),      // ECONOMIC
      mockCandidate({ entities: ['Iran'], sourceIds: ['telegram:x'] }),   // OSINT
      mockCandidate({ entities: ['Iran'], sourceIds: ['cisa'] }),         // CYBER
    ];

    const result = detectConvergence(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].domainCount, 5);
    assert.equal(result[0].significance, 'critical');
  });

  it('does not flag entities with fewer than 3 domains', () => {
    const candidates = [
      mockCandidate({ entities: ['Iran'], sourceIds: ['govFeeds'] }),     // DIPLOMATIC
      mockCandidate({ entities: ['Iran'], sourceIds: ['headlines'] }),    // also DIPLOMATIC
    ];

    const result = detectConvergence(candidates);
    assert.equal(result.length, 0);
  });

  it('normalizes entity aliases for convergence counting', () => {
    const candidates = [
      mockCandidate({ entities: ['Tehran'], sourceIds: ['govFeeds'] }),       // DIPLOMATIC → iran
      mockCandidate({ entities: ['Iran'], sourceIds: ['military'] }),         // MILITARY → iran
      mockCandidate({ entities: ['Islamic Republic of Iran'], sourceIds: ['markets'] }), // ECONOMIC → iran
    ];

    const result = detectConvergence(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].entity, 'iran');
    assert.equal(result[0].domainCount, 3);
  });

  it('handles telegram source IDs with prefix parsing', () => {
    // "telegram:intelslava" should extract prefix "telegram" → OSINT
    const candidates = [
      mockCandidate({ entities: ['Ukraine'], sourceIds: ['telegram:intelslava'] }),  // OSINT
      mockCandidate({ entities: ['Ukraine'], sourceIds: ['military'] }),              // MILITARY
      mockCandidate({ entities: ['Ukraine'], sourceIds: ['govFeeds'] }),              // DIPLOMATIC
    ];

    const result = detectConvergence(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].entity, 'ukraine');
    assert.ok(result[0].domains.includes('OSINT'));
    assert.ok(result[0].domains.includes('MILITARY'));
    assert.ok(result[0].domains.includes('DIPLOMATIC'));
  });

  it('sorts by domain count descending', () => {
    const candidates = [
      // Iran: 3 domains
      mockCandidate({ entities: ['Iran'], sourceIds: ['govFeeds'] }),
      mockCandidate({ entities: ['Iran'], sourceIds: ['military'] }),
      mockCandidate({ entities: ['Iran'], sourceIds: ['markets'] }),
      // China: 4 domains
      mockCandidate({ entities: ['China'], sourceIds: ['govFeeds'] }),
      mockCandidate({ entities: ['China'], sourceIds: ['military'] }),
      mockCandidate({ entities: ['China'], sourceIds: ['markets'] }),
      mockCandidate({ entities: ['China'], sourceIds: ['cisa'] }),
    ];

    const result = detectConvergence(candidates);
    assert.equal(result.length, 2);
    assert.equal(result[0].entity, 'china');   // 4 domains first
    assert.equal(result[1].entity, 'iran');    // 3 domains second
  });
});

// ---------------------------------------------------------------------------
// 4. generateHistoricalContext
// ---------------------------------------------------------------------------

describe('generateHistoricalContext', () => {
  it('returns empty array for null/empty inputs', () => {
    assert.deepEqual(generateHistoricalContext(null, new Map(), new Map()), []);
    assert.deepEqual(generateHistoricalContext([], new Map(), new Map()), []);
  });

  it('skips routine-severity candidates', () => {
    const candidates = [mockCandidate({ severity: 'routine' })];
    const result = generateHistoricalContext(candidates, new Map(), new Map());
    assert.equal(result.length, 0);
  });

  it('generates frequency-above-baseline context', () => {
    const candidates = [mockCandidate({ entities: ['Iran'], severity: 'notable' })];
    // Baseline: 0.5/day → 0.5/288 per cycle → ratio = 1/(0.5/288) = 576 → way above 2x
    const baselines = new Map([['iran', mockBaseline({ avgDailyMentions: 0.5 })]]);

    const result = generateHistoricalContext(candidates, new Map(), baselines);
    assert.ok(result.some(line => line.includes('frequency') && line.includes('baseline')));
  });

  it('generates consecutive-notable context', () => {
    const now = Date.now();
    const observations = Array.from({ length: 5 }, (_, i) => ({
      ts: now - (5 - i) * 300000, // 5 consecutive cycles
      severity: 'notable',
    }));

    const ledgerEntries = new Map([['iran', mockLedger({ entity: 'iran', observations })]]);
    const candidates = [mockCandidate({ entities: ['Iran'], severity: 'notable' })];

    const result = generateHistoricalContext(candidates, ledgerEntries, new Map());
    assert.ok(result.some(line => line.includes('consecutive cycles')));
  });

  it('generates notable-this-month context when 2+ notable events', () => {
    const now = Date.now();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const observations = [
      { ts: monthStart.getTime() + 86400000, severity: 'notable' },  // Day 2 of month
      { ts: monthStart.getTime() + 172800000, severity: 'breaking' }, // Day 3 of month
    ];

    const ledgerEntries = new Map([['iran', mockLedger({ entity: 'iran', observations })]]);
    const candidates = [mockCandidate({ entities: ['Iran'], severity: 'notable' })];

    const result = generateHistoricalContext(candidates, ledgerEntries, new Map());
    assert.ok(result.some(line => line.includes('notable+ event this month')));
  });

  it('deduplicates context lines for same entity across candidates', () => {
    const candidates = [
      mockCandidate({ entities: ['Iran'], severity: 'notable', clusterId: 'c1' }),
      mockCandidate({ entities: ['Iran'], severity: 'notable', clusterId: 'c2' }),
    ];
    const baselines = new Map([['iran', mockBaseline({ avgDailyMentions: 0.5 })]]);

    const result = generateHistoricalContext(candidates, new Map(), baselines);
    // Should not have duplicate lines for the same entity
    const uniqueLines = new Set(result);
    assert.equal(result.length, uniqueLines.size);
  });
});
