import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCycleTelemetry } from '../api/_tools/telemetry.js';

describe('createCycleTelemetry', () => {
  it('records stage timing correctly', async () => {
    const telem = createCycleTelemetry();

    await telem.stage('fast', async () => {
      return { _meta: { count: 5 }, _value: 'result' };
    });

    const result = telem.finish();
    assert.ok(result.stages.fast);
    assert.ok(typeof result.stages.fast.ms === 'number');
    assert.equal(result.stages.fast.meta.count, 5);
  });

  it('returns _value to caller and stores _meta in telemetry', async () => {
    const telem = createCycleTelemetry();

    const value = await telem.stage('collect', async () => {
      return { _meta: { recordCount: 42 }, _value: ['a', 'b', 'c'] };
    });

    assert.deepEqual(value, ['a', 'b', 'c']);
    const result = telem.finish();
    assert.equal(result.stages.collect.meta.recordCount, 42);
  });

  it('passes through raw return when no _value key', async () => {
    const telem = createCycleTelemetry();

    const value = await telem.stage('simple', async () => {
      return 'raw result';
    });

    assert.equal(value, 'raw result');
    const result = telem.finish();
    assert.ok(result.stages.simple);
    assert.equal(result.stages.simple.meta, undefined);
  });

  it('calculates total duration across stages', async () => {
    const telem = createCycleTelemetry();

    await telem.stage('step1', async () => 'a');
    await telem.stage('step2', async () => 'b');

    const result = telem.finish();
    assert.ok(result.totalMs >= 0);
    assert.ok(result.stages.step1);
    assert.ok(result.stages.step2);
  });

  it('preserves stage ordering', async () => {
    const telem = createCycleTelemetry();

    await telem.stage('alpha', async () => 'a');
    await telem.stage('beta', async () => 'b');
    await telem.stage('gamma', async () => 'c');

    const result = telem.finish();
    const stageNames = Object.keys(result.stages);
    assert.deepEqual(stageNames, ['alpha', 'beta', 'gamma']);
  });

  it('generates a valid cycleId timestamp', () => {
    const telem = createCycleTelemetry();
    const result = telem.finish();

    // cycleId should be an ISO timestamp
    assert.ok(result.cycleId);
    assert.ok(!isNaN(Date.parse(result.cycleId)));
  });
});
