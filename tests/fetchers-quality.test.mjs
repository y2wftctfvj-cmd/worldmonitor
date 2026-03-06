import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAllowlistedHeadlineSource,
  parseGoogleNewsHeadline,
} from '../api/_tools/fetchers/news.js';
import {
  cleanTelegramHtml,
  parseTelegramChannelHtml,
} from '../api/_tools/fetchers/social.js';

describe('fetcher quality helpers', () => {
  it('parses Google News titles into title and source', () => {
    const parsed = parseGoogleNewsHeadline('Israel strikes convoy near Damascus - Reuters');

    assert.equal(parsed.title, 'Israel strikes convoy near Damascus');
    assert.equal(parsed.source, 'Reuters');
    assert.equal(isAllowlistedHeadlineSource(parsed.source), true);
    assert.equal(isAllowlistedHeadlineSource('Random Blog'), false);
  });

  it('cleans Telegram boilerplate and preserves useful text', () => {
    const cleaned = cleanTelegramHtml('Please open Telegram to view this post<br>IAEA inspectors arrive in Tehran &amp; begin review.<br><a href="https://t.me/foo">VIEW IN TELEGRAM</a>');

    assert.equal(cleaned.includes('Please open Telegram'), false);
    assert.equal(cleaned.includes('VIEW IN TELEGRAM'), false);
    assert.match(cleaned, /IAEA inspectors arrive in Tehran/);
  });

  it('parses Telegram channel HTML into clean posts with timestamps and links', () => {
    const html = `
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message_text">Please open Telegram to view this post<br>OSINT Defender reports missile launches near Haifa &amp; northern Israel.</div>
        <a class="tgme_widget_message_date" href="https://t.me/osintdefender/123"><time datetime="2026-03-05T10:20:00+00:00"></time></a>
        <div class="tgme_widget_message_footer"></div>
      </div>
    `;

    const posts = parseTelegramChannelHtml('osintdefender', html);

    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel, 'osintdefender');
    assert.equal(posts[0].publishedAt, '2026-03-05T10:20:00+00:00');
    assert.equal(posts[0].link, 'https://t.me/osintdefender/123');
    assert.match(posts[0].text, /missile launches near Haifa/);
  });
});
