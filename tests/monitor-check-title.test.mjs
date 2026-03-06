import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveGroundedTitle } from '../api/monitor-check.js';

describe('deriveGroundedTitle', () => {
  it('prefers the highest-reliability source text and strips feed prefixes', () => {
    const title = deriveGroundedTitle({
      entities: ['Iran', 'Israel'],
      records: [
        { sourceId: 'telegram:osintdefender', text: 'OSINT Defender claims Israel struck Iranian positions near Damascus overnight', meta: {} },
        { sourceId: 'govFeeds', text: '[Reuters] Israel strikes Iranian positions near Damascus after overnight launch', meta: { feedSource: 'Reuters' } },
      ],
    });

    assert.equal(title, 'Israel strikes Iranian positions near Damascus after overnight launch');
  });

  it('removes trailing mainstream source suffixes from headlines', () => {
    const title = deriveGroundedTitle({
      entities: ['Taiwan'],
      records: [
        { sourceId: 'headlines', text: 'Taiwan raises alert level after military incursion - Reuters', meta: {} },
      ],
    });

    assert.equal(title, 'Taiwan raises alert level after military incursion');
  });
});
