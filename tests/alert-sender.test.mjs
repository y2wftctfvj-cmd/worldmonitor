import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildIntelAlertText,
  splitTelegramMessage,
  formatSourceName,
} from '../api/_tools/alert-sender.js';

describe('alert-sender', () => {
  it('formats evidence, uncertainty, and links consistently', () => {
    const text = buildIntelAlertText({
      severity: 'breaking',
      title: 'Israel strikes IRGC sites in Syria',
      fact_line: 'Israeli aircraft struck IRGC-linked positions near Damascus overnight.',
      analysis: 'SITUATION: Israeli aircraft struck IRGC-linked positions near Damascus. ASSESSMENT: This raises the risk of retaliation. IMPLICATIONS: Regional escalation risk is rising.',
      why_matters: 'A direct Israel-Iran exchange path is widening.',
      why_i_believe: 'Reuters, BBC, and @OSINTDefender align on the core event.',
      what_changed: 'New strong-source confirmation arrived this cycle from Reuters and BBC.',
      uncertainty: 'Damage level and casualty count remain unconfirmed.',
      _confidence: 71,
      _scoreBreakdown: { reliability: 40, corroboration: 16, recency: 15, crossDomain: 10 },
      _sourceProfile: { strongSourceCount: 1, verifiedSourceCount: 2 },
      watch_next: ['IRGC response statement', 'Syrian air-defense activation'],
      watchlist_match: 'Iran',
      sources: ['govFeeds', 'telegram:osintdefender', 'headlines'],
      support: [
        {
          sourceId: 'govFeeds',
          sourceLabel: 'Reuters',
          reason: 'Strong-source confirmation',
          excerpt: 'Israeli aircraft struck IRGC-linked positions near Damascus overnight.',
          link: 'https://www.reuters.com/world/middle-east/example-story',
          publishedAt: '2026-03-06T03:20:00Z',
        },
        {
          sourceId: 'telegram:osintdefender',
          sourceLabel: '@OSINTDefender',
          reason: 'Independent corroboration',
          excerpt: 'OSINT channels also reported strikes near Damascus.',
          link: 'https://t.me/osintdefender/12345',
          publishedAt: '2026-03-06T03:24:00Z',
        },
      ],
    });

    assert.match(text, /WHAT HAPPENED/);
    assert.match(text, /WHY I BELIEVE THIS/);
    assert.match(text, /WHAT CHANGED/);
    assert.match(text, /WHY IT MATTERS/);
    assert.match(text, /UNCONFIRMED/);
    assert.match(text, /TOP LINKS/);
    assert.match(text, /HIGH CONFIDENCE/);
    assert.match(text, /Reuters/);
    assert.match(text, /03:20 UTC/);
  });

  it('splits oversized alerts into Telegram-safe chunks', () => {
    const longText = ['*HEADER*', ''].concat(Array.from({ length: 500 }, (_, index) => `Line ${index} — ${'x'.repeat(20)}`)).join('\n');
    const chunks = splitTelegramMessage(longText, 500);

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 500));
  });

  it('formats unknown source ids safely', () => {
    assert.equal(formatSourceName('telegram:customchannel'), '@customchannel');
    assert.equal(formatSourceName('reddit:news'), 'r/news');
  });
});
