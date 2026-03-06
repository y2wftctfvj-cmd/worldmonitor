import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCandidateSupport,
  buildCandidateChangeSummary,
  buildCandidateFactLine,
  buildCandidateUncertaintySummary,
  buildEvidenceNarrative,
} from '../api/_tools/alert-enrichment.js';

describe('alert-enrichment', () => {
  it('builds ranked support items with source labels and links', () => {
    const support = buildCandidateSupport({
      records: [
        {
          sourceId: 'telegram:osintdefender',
          text: 'OSINT channels reported explosions near Isfahan overnight.',
          timestamp: '2026-03-06T03:24:00Z',
          meta: { link: 'https://t.me/osintdefender/123', publishedAt: '2026-03-06T03:24:00Z' },
        },
        {
          sourceId: 'govFeeds',
          text: '[Reuters] Explosions were reported near Isfahan in central Iran.',
          timestamp: '2026-03-06T03:20:00Z',
          meta: {
            feedSource: 'Reuters',
            link: 'https://www.reuters.com/example',
            publishedAt: '2026-03-06T03:20:00Z',
          },
        },
      ],
    });

    assert.equal(support[0].sourceLabel, 'Reuters');
    assert.equal(support[0].reason, 'Strong-source confirmation');
    assert.ok(support[0].link.includes('reuters.com'));
    assert.equal(support[1].sourceLabel, '@OSINTDefender');
  });

  it('summarizes what changed using new strong-source labels', () => {
    const summary = buildCandidateChangeSummary({
      delta: {
        newRecordCount: 2,
        newStrongSourceLabels: ['Reuters', 'BBC World'],
      },
    });

    assert.match(summary, /Reuters/);
    assert.match(summary, /BBC World/);
  });

  it('derives fact, uncertainty, and evidence narrative from candidate data', () => {
    const candidate = {
      sourceProfile: { strongSourceCount: 1, verifiedSourceCount: 2, distinctSources: 3 },
      records: [
        {
          sourceId: 'govFeeds',
          text: '[Reuters] Israel struck targets near Isfahan in central Iran overnight.',
          timestamp: '2026-03-06T03:20:00Z',
          meta: { feedSource: 'Reuters', publishedAt: '2026-03-06T03:20:00Z' },
        },
        {
          sourceId: 'telegram:osintdefender',
          text: 'OSINT Defender reported secondary explosions and air-defense activity near Isfahan.',
          timestamp: '2026-03-06T03:25:00Z',
          meta: { publishedAt: '2026-03-06T03:25:00Z' },
        },
      ],
    };

    const support = buildCandidateSupport(candidate);
    const factLine = buildCandidateFactLine(candidate);
    const uncertainty = buildCandidateUncertaintySummary({
      ...candidate,
      records: [
        ...candidate.records,
        {
          sourceId: 'telegram:breakingmash',
          text: 'Preliminary reports suggest additional damage is possible but unconfirmed.',
          timestamp: '2026-03-06T03:26:00Z',
          meta: {},
        },
      ],
    });
    const narrative = buildEvidenceNarrative({ support, _sourceProfile: candidate.sourceProfile });

    assert.match(factLine, /Israel struck targets near Isfahan/);
    assert.match(uncertainty, /unconfirmed|unclear/i);
    assert.match(narrative, /Reuters/);
  });
});
