import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterLowSignalRecords, isLowSignalText } from '../api/_tools/intel-noise.js';

describe('intel-noise', () => {
  it('filters broad domestic political churn', () => {
    assert.equal(
      isLowSignalText('Trump campaign polling tightens in key senate races as budget fight continues'),
      true,
    );
  });

  it('keeps globally relevant security terms', () => {
    assert.equal(
      isLowSignalText('White House discusses new Iran sanctions after missile launch in the Gulf'),
      false,
    );
  });

  it('keeps watchlist overrides', () => {
    assert.equal(
      isLowSignalText('Biden campaign event planned in Taiwan', ['Taiwan']),
      false,
    );
  });

  it('filters only low-signal record types', () => {
    const records = filterLowSignalRecords([
      { sourceId: 'headlines', text: 'Trump campaign polling tightens in key senate races' },
      { sourceId: 'govFeeds', text: 'OFAC sanctions new shipping network tied to Iran' },
    ]);

    assert.equal(records.length, 1);
    assert.equal(records[0].sourceId, 'govFeeds');
  });
});
