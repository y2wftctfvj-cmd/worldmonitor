import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyWatchlistMatchStats,
  createWatchlistItem,
  findCandidateWatchlistMatches,
  formatWatchlistSummary,
  hydrateWatchlistItems,
  normalizeWatchTerm,
} from '../api/_tools/watchlist-utils.js';

describe('watchlist-utils', () => {
  it('hydrates legacy string watchlists into structured items', () => {
    const items = hydrateWatchlistItems(['Taiwan', { term: 'Red Sea', addedAt: 1000 }]);

    assert.equal(items.length, 2);
    assert.ok(items.every((item) => item.normalized === normalizeWatchTerm(item.term)));
    assert.ok(items.some((item) => item.term === 'Taiwan'));
    assert.ok(items.some((item) => item.term === 'Red Sea' && item.hitCount === 0));
  });

  it('matches normalized entities and strong phrases', () => {
    const candidate = {
      entities: ['Taiwan', 'Taipei'],
      records: [
        { text: 'Taiwan election authorities report emergency cyber activity around Taipei.' },
      ],
    };

    const watchlists = [{
      chatId: '123',
      items: [
        createWatchlistItem('Taiwan'),
        createWatchlistItem('emergency cyber activity'),
      ],
    }];

    const matches = findCandidateWatchlistMatches(candidate, watchlists);

    assert.equal(matches.length, 2);
    assert.ok(matches.some((match) => match.term === 'Taiwan' && match.matchType === 'entity'));
    assert.ok(matches.some((match) => match.term === 'emergency cyber activity'));
  });

  it('updates hit counts and last matched timestamps', () => {
    const now = Date.UTC(2026, 2, 5, 12, 0, 0);
    const watchlist = hydrateWatchlistItems([
      { term: 'Taiwan', addedAt: now - 1000 },
      { term: 'Red Sea', addedAt: now - 1000, hitCount: 2 },
    ]);

    const updated = applyWatchlistMatchStats(watchlist, [
      { normalized: 'taiwan', chatId: '1' },
      { term: 'Red Sea', chatId: '1' },
    ], now);

    assert.equal(updated[0].hitCount, 1);
    assert.equal(updated[0].lastMatchedAt, now);
    assert.equal(updated[1].hitCount, 3);
    assert.equal(updated[1].lastMatchedAt, now);
  });

  it('formats watchlist summaries with hits and last match info', () => {
    const now = Date.now();
    const summary = formatWatchlistSummary([
      { term: 'Taiwan', normalized: 'taiwan', addedAt: now - 86_400_000, hitCount: 2, lastMatchedAt: now - 3_600_000 },
    ]);

    assert.match(summary, /Taiwan/);
    assert.match(summary, /2 hits/);
    assert.match(summary, /last match 1h ago/);
  });
});
