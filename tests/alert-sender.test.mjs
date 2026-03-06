import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildIntelAlertText,
  splitTelegramMessage,
  formatSourceName,
} from '../api/_tools/alert-sender.js';

describe('alert-sender', () => {
  it('formats trigger, confidence, and sources consistently', () => {
    const text = buildIntelAlertText({
      severity: 'breaking',
      title: 'Israel strikes IRGC sites in Syria',
      analysis: 'SITUATION: Israeli aircraft struck IRGC-linked positions near Damascus. ASSESSMENT: This raises the risk of retaliation. IMPLICATIONS: Regional escalation risk is rising.',
      why_matters: 'A direct Israel-Iran exchange path is widening.',
      _whyTriggered: '1 strong source corroborated by 3 total sources · watchlist match: Iran',
      _confidence: 71,
      _scoreBreakdown: { reliability: 40, corroboration: 16, recency: 15, crossDomain: 10 },
      _sourceProfile: { strongSourceCount: 1, verifiedSourceCount: 2 },
      watch_next: ['IRGC response statement', 'Syrian air-defense activation'],
      watchlist_match: 'Iran',
      sources: ['govFeeds', 'telegram:osintdefender', 'headlines'],
    });

    assert.match(text, /WHY IT TRIGGERED/);
    assert.match(text, /WHY IT MATTERS/);
    assert.match(text, /TOP SOURCES/);
    assert.match(text, /HIGH CONFIDENCE/);
    assert.match(text, /Wire Services/);
    assert.match(text, /Google News/);
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
