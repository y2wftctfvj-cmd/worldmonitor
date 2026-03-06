/**
 * Tests for evidence-fusion.js — normalize, cluster, score, promote pipeline.
 *
 * Tests the core pipeline functions that transform raw source data into
 * scored, clustered, promoted candidates.
 *
 * normalize() takes a collectResults object (like Promise.allSettled output),
 * NOT an array of records. Each key maps to a source type.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, cluster, score, promote, runFusion } from '../api/_tools/evidence-fusion.js';

// ---------------------------------------------------------------------------
// Test helpers — build mock collectResults structures
// ---------------------------------------------------------------------------

/** Build a minimal collectResults object for testing */
function mockCollectResults({
  headlines = null,
  telegram = null,
  reddit = null,
  military = null,
  govFeeds = null,
  markets = null,
  earthquakes = null,
} = {}) {
  const results = {};

  // Headlines = string with "- headline" lines
  if (headlines) {
    results.headlines = {
      status: 'fulfilled',
      value: headlines.map(h => `- ${h}`).join('\n'),
    };
  }

  // Telegram = array of { channel, text }
  if (telegram) {
    results.telegram = {
      status: 'fulfilled',
      value: telegram,
    };
  }

  // Reddit = array of { sub, title, score, comments }
  if (reddit) {
    results.reddit = {
      status: 'fulfilled',
      value: reddit,
    };
  }

  // Military = { count, articles: string[] }
  if (military) {
    results.military = {
      status: 'fulfilled',
      value: { count: military.length, articles: military },
    };
  }

  // Gov feeds = array of { source, title }
  if (govFeeds) {
    results.govFeeds = {
      status: 'fulfilled',
      value: govFeeds,
    };
  }

  // Markets = string with "- Symbol: price (change)" lines
  if (markets) {
    results.markets = {
      status: 'fulfilled',
      value: markets.map(m => `- ${m}`).join('\n'),
    };
  }

  // Earthquakes = array of { mag, place, time, id }
  if (earthquakes) {
    results.earthquakes = {
      status: 'fulfilled',
      value: earthquakes,
    };
  }

  return results;
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe('normalize', () => {
  it('returns empty array for empty collectResults', () => {
    const result = normalize({});
    assert.deepEqual(result, []);
  });

  it('normalizes headline strings into records', () => {
    const results = mockCollectResults({
      headlines: [
        'Iran nuclear talks resume in Vienna after months of stalemate',
        'China trade deal signed with European partners',
      ],
    });

    const records = normalize(results);
    assert.ok(records.length >= 1, 'should produce records from headlines');

    // Each record should have required fields
    for (const r of records) {
      assert.ok(r.id, 'record should have id');
      assert.equal(r.sourceId, 'headlines');
      assert.ok(r.text, 'record should have text');
      assert.ok(Array.isArray(r.entities), 'record should have entities array');
    }
  });

  it('normalizes telegram posts into records', () => {
    const results = mockCollectResults({
      telegram: [
        { channel: 'intelslava', text: 'Breaking: major military escalation in Ukraine reported by multiple sources' },
      ],
    });

    const records = normalize(results);
    assert.ok(records.length >= 1, 'should produce records from telegram');
    assert.ok(records[0].sourceId.startsWith('telegram:'), 'sourceId should have telegram prefix');
  });

  it('normalizes gov feeds into records', () => {
    const results = mockCollectResults({
      govFeeds: [
        {
          source: 'Reuters',
          title: 'Iran enriches uranium past nuclear deal threshold limits significantly',
          link: 'https://www.reuters.com/example',
          publishedAt: '2026-03-06T03:20:00Z',
        },
      ],
    });

    const records = normalize(results);
    assert.ok(records.length >= 1, 'should produce records from govFeeds');
    assert.equal(records[0].sourceId, 'govFeeds');
    assert.equal(records[0].meta.feedSource, 'Reuters');
    assert.equal(records[0].meta.link, 'https://www.reuters.com/example');
    assert.equal(records[0].timestamp, '2026-03-06T03:20:00Z');
  });

  it('skips short text entries', () => {
    const results = mockCollectResults({
      headlines: ['Short'],  // < 10 chars
    });

    const records = normalize(results);
    assert.equal(records.length, 0, 'should skip short headlines');
  });

  it('handles multiple source types simultaneously', () => {
    const results = mockCollectResults({
      headlines: ['Iran nuclear deal collapses after extended negotiations with world powers'],
      telegram: [{ channel: 'osintdefender', text: 'Reports of military mobilization along Iranian border from multiple OSINT sources' }],
      military: ['Major GDELT escalation detected in Persian Gulf region and surrounding waters'],
    });

    const records = normalize(results);
    // Should have records from all 3 sources
    const sourceIds = new Set(records.map(r => r.sourceId));
    assert.ok(sourceIds.has('headlines'), 'should have headlines source');
    assert.ok([...sourceIds].some(id => id.startsWith('telegram:')), 'should have telegram source');
    assert.ok(sourceIds.has('military'), 'should have military source');
  });

  it('extracts entities from text content', () => {
    const results = mockCollectResults({
      headlines: ['Iran and Israel exchange threats over nuclear program at UN assembly'],
    });

    const records = normalize(results);
    assert.ok(records.length >= 1);
    // Entity extraction should find Iran and Israel
    const allEntities = records.flatMap(r => r.entities.map(e => e.toLowerCase()));
    assert.ok(allEntities.some(e => e.includes('iran')), `should extract Iran from entities: ${allEntities}`);
    assert.ok(allEntities.some(e => e.includes('israel')), `should extract Israel from entities: ${allEntities}`);
  });

  it('assigns deterministic IDs for dedup', () => {
    const results = mockCollectResults({
      headlines: ['Iran nuclear talks resume in Vienna after months of intensive diplomacy'],
    });

    // Same input should produce same ID
    const records1 = normalize(results);
    const records2 = normalize(results);

    assert.ok(records1.length > 0);
    assert.equal(records1[0].id, records2[0].id, 'same text should produce same ID');
  });
});

// ---------------------------------------------------------------------------
// cluster
// ---------------------------------------------------------------------------

describe('cluster', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(cluster([]), []);
  });

  it('groups records with shared entities into clusters', () => {
    const results = mockCollectResults({
      headlines: [
        'Iran nuclear talks resume in Vienna with international negotiators present',
        'Iran sanctions expanded by European Union following nuclear escalation',
      ],
    });

    const records = normalize(results);
    const clusters = cluster(records);
    assert.ok(clusters.length >= 1, 'should create at least 1 cluster');

    // Each cluster has required shape
    for (const c of clusters) {
      assert.ok(c.clusterId, 'cluster should have clusterId');
      assert.ok(Array.isArray(c.entities), 'cluster should have entities');
      assert.ok(Array.isArray(c.records), 'cluster should have records');
      assert.ok(typeof c.confidence === 'number', 'cluster should have confidence');
      assert.ok(c.severity, 'cluster should have severity');
    }
  });

  it('creates separate clusters for unrelated entities', () => {
    const results = mockCollectResults({
      headlines: [
        'Iran nuclear program reaches dangerous threshold according to IAEA watchdog report',
        'Japan earthquake magnitude seven point five hits northern coastal regions today',
      ],
    });

    const records = normalize(results);
    const clusters = cluster(records);
    // Iran and Japan should be in different clusters
    assert.ok(clusters.length >= 2, `expected 2+ clusters for unrelated entities, got ${clusters.length}`);
  });
});

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

describe('score', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(score([]), []);
  });

  it('assigns numeric confidence scores', () => {
    const results = mockCollectResults({
      govFeeds: [
        { source: 'Reuters', title: 'Iran nuclear deal in crisis following enrichment breach reported by inspectors' },
      ],
      headlines: [
        'Iran nuclear crisis deepens as IAEA reports significant violations of agreement',
      ],
    });

    const records = normalize(results);
    const clusters = cluster(records);
    const scored = score(clusters);

    for (const s of scored) {
      assert.ok(typeof s.confidence === 'number', 'should have numeric confidence');
      assert.ok(s.confidence >= 0 && s.confidence <= 100, `confidence ${s.confidence} should be 0-100`);
      assert.ok(s.scoreBreakdown, 'should have scoreBreakdown');
      assert.ok(typeof s.scoreBreakdown.reliability === 'number');
      assert.ok(typeof s.scoreBreakdown.corroboration === 'number');
    }
  });

  it('gives novelty bonus for new records not in previous cycle', () => {
    const results = mockCollectResults({
      headlines: ['Major geopolitical development in Iran nuclear negotiations and sanctions'],
    });

    const records = normalize(results);
    const clusters = cluster(records);

    // Score with empty previous IDs (everything is new)
    const scoredNew = score(clusters, new Set());
    // Score with all record IDs as previous (nothing is new)
    const allIds = new Set(records.map(r => r.id));
    const scoredOld = score(clusters, allIds);

    if (scoredNew.length > 0 && scoredOld.length > 0) {
      assert.ok(
        scoredNew[0].confidence >= scoredOld[0].confidence,
        'new records should score >= old records'
      );
      assert.ok(scoredNew[0].delta.newRecordCount >= 1);
      assert.ok(Array.isArray(scoredNew[0].delta.newSourceIds));
      assert.ok(Array.isArray(scoredNew[0].delta.newSourceLabels));
      assert.equal(scoredOld[0].delta.newRecordCount, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

describe('promote', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(promote([]), []);
  });

  it('assigns valid severity levels', () => {
    const results = mockCollectResults({
      govFeeds: [
        { source: 'Reuters', title: 'Breaking Iran nuclear crisis deepens as IAEA reports serious violations' },
      ],
    });

    const records = normalize(results);
    const clusters = cluster(records);
    const scored = score(clusters);
    const promoted = promote(scored);

    const validSeverities = ['routine', 'developing', 'notable', 'breaking', 'urgent'];
    for (const p of promoted) {
      assert.ok(
        validSeverities.includes(p.severity),
        `severity "${p.severity}" should be one of ${validSeverities.join(', ')}`
      );
    }
  });

  it('keeps single-source candidates as routine', () => {
    const results = mockCollectResults({
      headlines: ['Iran nuclear talks resume in Vienna with international partners gathered'],
    });

    const records = normalize(results);
    const clusters = cluster(records);
    const scored = score(clusters);
    const promoted = promote(scored);

    // Single source = routine, no exceptions
    for (const p of promoted) {
      const distinctSources = new Set(p.records.map(r => r.sourceId)).size;
      if (distinctSources < 2) {
        assert.equal(p.severity, 'routine', 'single-source candidates should stay routine');
      }
    }
  });

  it('keeps social-only chatter as routine even with multiple posts', () => {
    const results = mockCollectResults({
      telegram: [
        { channel: 'breakingmash', text: 'Unconfirmed claims say Iran launched missiles toward Israel overnight without official confirmation' },
        { channel: 'legitimniy', text: 'Anonymous Telegram channels claim Iran launched missiles toward Israel tonight without official confirmation' },
      ],
    });

    const records = normalize(results);
    const clusters = cluster(records);
    const scored = score(clusters);
    const promoted = promote(scored);

    assert.ok(promoted.length > 0, 'should produce at least one candidate');
    for (const candidate of promoted) {
      assert.equal(candidate.severity, 'routine', 'social-only chatter should not promote');
      assert.equal(candidate.sourceProfile?.passesTrustGate, false);
    }
  });

  it('promotes wire plus corroboration', () => {
    const results = mockCollectResults({
      govFeeds: [
        { source: 'Reuters', title: 'Israel strikes Iran-backed sites in Syria after missile launch' },
      ],
      headlines: [
        'Israel strikes Iran-backed sites in Syria after missile launch - BBC News',
      ],
      telegram: [
        { channel: 'osintdefender', text: 'OSINT confirms Israeli strikes on Iran-backed sites in Syria after the overnight missile launch' },
      ],
    });

    const records = normalize(results);
    const clusters = cluster(records);
    const scored = score(clusters);
    const promoted = promote(scored);

    const relevant = promoted.find((candidate) =>
      candidate.entities.some((entity) => ['iran', 'israel', 'syria'].some((term) => entity.toLowerCase().includes(term)))
    );
    assert.ok(relevant, 'expected Iran-related candidate');
    assert.equal(relevant.sourceProfile?.passesTrustGate, true);
    assert.notEqual(relevant.severity, 'routine', 'wire plus corroboration should alert');
  });
});

// ---------------------------------------------------------------------------
// runFusion — full pipeline integration
// ---------------------------------------------------------------------------

describe('runFusion — full pipeline', () => {
  it('processes collectResults through the entire pipeline', () => {
    const results = mockCollectResults({
      headlines: [
        'Iran nuclear deal collapses after extended negotiations and diplomatic breakdown',
        'China trade talks with European Union enter final stage of discussions',
      ],
      govFeeds: [
        { source: 'Reuters', title: 'Iran sanctions expanded by European Union following nuclear violations' },
      ],
      telegram: [
        { channel: 'intelslava', text: 'Reports of Iranian military mobilization near border according to sources' },
      ],
    });

    const { allCandidates, records } = runFusion(results, new Set(), []);
    assert.ok(Array.isArray(allCandidates), 'should return allCandidates array');
    assert.ok(Array.isArray(records), 'should return records array');
    assert.ok(records.length > 0, 'should have records');
  });

  it('tags watchlist matches before promotion', () => {
    const results = mockCollectResults({
      headlines: ['Iran nuclear program developments continue with new enrichment reports'],
    });

    const { allCandidates } = runFusion(results, new Set(), ['iran']);
    const iranCandidates = allCandidates.filter(c =>
      c.entities.some(e => e.toLowerCase().includes('iran'))
    );

    if (iranCandidates.length > 0) {
      assert.ok(iranCandidates[0].watchlistMatch, 'should tag watchlist match for Iran');
    }
  });

  it('sorts candidates by confidence descending', () => {
    const results = mockCollectResults({
      headlines: [
        'Iran nuclear crisis reaches critical point with international response building',
        'Local weather forecast shows mild temperatures for weekend across region',
      ],
      govFeeds: [
        { source: 'Reuters', title: 'Iran nuclear deal collapses as talks break down permanently this week' },
      ],
    });

    const { allCandidates } = runFusion(results, new Set(), []);

    for (let i = 1; i < allCandidates.length; i++) {
      assert.ok(
        allCandidates[i - 1].confidence >= allCandidates[i].confidence,
        `candidates should be sorted by confidence desc: ${allCandidates[i - 1].confidence} >= ${allCandidates[i].confidence}`
      );
    }
  });
});
