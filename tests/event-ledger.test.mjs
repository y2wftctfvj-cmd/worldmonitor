/**
 * Tests for event-ledger.js — entity normalization and baseline computation.
 *
 * Only tests the pure functions (normalizeEntity). The async Redis functions
 * (updateLedger, loadLedgerEntries, etc.) are tested in cycle-replay.test.mjs
 * with mocked fetch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntity } from '../api/_tools/event-ledger.js';

// ---------------------------------------------------------------------------
// normalizeEntity
// ---------------------------------------------------------------------------

describe('normalizeEntity', () => {
  it('returns empty string for null/undefined/non-string', () => {
    assert.equal(normalizeEntity(null), '');
    assert.equal(normalizeEntity(undefined), '');
    assert.equal(normalizeEntity(42), '');
    assert.equal(normalizeEntity(''), '');
  });

  it('lowercases and trims input', () => {
    assert.equal(normalizeEntity('  Iran  '), 'iran');
    assert.equal(normalizeEntity('CHINA'), 'china');
    assert.equal(normalizeEntity('Ukraine '), 'ukraine');
  });

  it('resolves known aliases to canonical names', () => {
    // Iran aliases
    assert.equal(normalizeEntity('Tehran'), 'iran');
    assert.equal(normalizeEntity('Islamic Republic of Iran'), 'iran');
    assert.equal(normalizeEntity('Persian Gulf'), 'iran');

    // China aliases
    assert.equal(normalizeEntity('PRC'), 'china');
    assert.equal(normalizeEntity('Beijing'), 'china');
    assert.equal(normalizeEntity("People's Republic of China"), 'china');

    // Ukraine aliases
    assert.equal(normalizeEntity('Kyiv'), 'ukraine');
    assert.equal(normalizeEntity('Kiev'), 'ukraine');

    // Russia aliases
    assert.equal(normalizeEntity('Moscow'), 'russia');
    assert.equal(normalizeEntity('Kremlin'), 'russia');
    assert.equal(normalizeEntity('Russian Federation'), 'russia');

    // North Korea
    assert.equal(normalizeEntity('DPRK'), 'north korea');
    assert.equal(normalizeEntity('Pyongyang'), 'north korea');

    // US aliases
    assert.equal(normalizeEntity('United States'), 'us');
    assert.equal(normalizeEntity('USA'), 'us');
    assert.equal(normalizeEntity('Washington'), 'us');
    assert.equal(normalizeEntity('Pentagon'), 'us');
    assert.equal(normalizeEntity('White House'), 'us');

    // UK aliases
    assert.equal(normalizeEntity('United Kingdom'), 'uk');
    assert.equal(normalizeEntity('Britain'), 'uk');
    assert.equal(normalizeEntity('Great Britain'), 'uk');
    assert.equal(normalizeEntity('London'), 'uk');
  });

  it('resolves militant/group aliases', () => {
    assert.equal(normalizeEntity('Hezbollah'), 'lebanon');
    assert.equal(normalizeEntity('Houthi'), 'yemen');
    assert.equal(normalizeEntity('Houthis'), 'yemen');
    assert.equal(normalizeEntity('Ansar Allah'), 'yemen');
    assert.equal(normalizeEntity('IDF'), 'israel');
  });

  it('resolves territory aliases', () => {
    assert.equal(normalizeEntity('Gaza Strip'), 'gaza');
    assert.equal(normalizeEntity('Palestinian Territories'), 'palestine');
    assert.equal(normalizeEntity('West Bank'), 'palestine');
    assert.equal(normalizeEntity('Taipei'), 'taiwan');
    assert.equal(normalizeEntity('Republic of China'), 'taiwan');
  });

  it('resolves organization aliases', () => {
    assert.equal(normalizeEntity('EU'), 'european union');
    assert.equal(normalizeEntity('NATO Alliance'), 'nato');
    assert.equal(normalizeEntity('ROK'), 'south korea');
    assert.equal(normalizeEntity('Seoul'), 'south korea');
  });

  it('returns lowercase original for unknown entities', () => {
    assert.equal(normalizeEntity('Japan'), 'japan');
    assert.equal(normalizeEntity('Brazil'), 'brazil');
    assert.equal(normalizeEntity('NATO'), 'nato');
  });

  it('is case-insensitive for alias lookup', () => {
    assert.equal(normalizeEntity('TEHRAN'), 'iran');
    assert.equal(normalizeEntity('prc'), 'china');
    assert.equal(normalizeEntity('DPRK'), 'north korea');
    assert.equal(normalizeEntity('usa'), 'us');
  });
});
