import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifySourceResult, mergeSourceHealth } from '../api/_tools/source-health.js';

describe('source-health', () => {
  it('classifies non-empty payloads as ok', () => {
    const result = classifySourceResult('telegram', {
      status: 'fulfilled',
      value: [{ text: 'Israel announces military response after missile interception' }],
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.sampleSize, 1);
  });

  it('classifies empty fulfilled payloads as degraded', () => {
    const result = classifySourceResult('twitter', {
      status: 'fulfilled',
      value: [],
    });

    assert.equal(result.status, 'degraded');
    assert.equal(result.reason, 'no_items');
  });

  it('classifies rejected payloads as failed', () => {
    const result = classifySourceResult('reddit', {
      status: 'rejected',
      reason: new Error('timeout'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'timeout');
  });

  it('merges health state with degraded and failed counters', () => {
    const merged = mergeSourceHealth({
      twitter: {
        status: 'ok',
        lastSuccessAt: 100,
        lastNonEmptyAt: 100,
        consecutiveDegraded: 0,
        consecutiveFailures: 0,
      },
      military: {
        status: 'degraded',
        lastSuccessAt: 50,
        lastNonEmptyAt: 20,
        consecutiveDegraded: 2,
        consecutiveFailures: 0,
      },
    }, {
      twitter: { status: 'degraded', sampleSize: 0, reason: 'disabled_by_default' },
      military: { status: 'failed', sampleSize: 0, reason: 'timeout' },
      headlines: { status: 'ok', sampleSize: 4 },
    }, 200);

    assert.deepEqual(merged.twitter, {
      status: 'degraded',
      sampleSize: 0,
      detail: 'disabled_by_default',
      lastSuccessAt: 200,
      lastNonEmptyAt: 100,
      consecutiveDegraded: 1,
      consecutiveFailures: 0,
    });
    assert.equal(merged.military.status, 'failed');
    assert.equal(merged.military.consecutiveFailures, 1);
    assert.equal(merged.military.lastNonEmptyAt, 20);
    assert.equal(merged.headlines.status, 'ok');
    assert.equal(merged.headlines.lastSuccessAt, 200);
  });
});
