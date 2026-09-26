import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as actions from './actions';

/**
 * These are the safety-critical tests. Everything here guards a property that,
 * if it broke, would produce a command nobody asked for:
 *
 *  - the intensity ceiling is the only thing between a typo and a toy at 100%
 *  - timeSec: 0 means "run indefinitely" to Lovense, so emitting it by accident
 *    leaves a toy running until something else stops it
 *
 * Run with the env in .env.test, which sets MAX_INTENSITY_PERCENT=100.
 */

describe('percentToLevel', () => {
  it('maps the ends of the range exactly', () => {
    assert.equal(actions.percentToLevel(0), 0);
    assert.equal(actions.percentToLevel(100), actions.LOVENSE_MAX_LEVEL);
  });

  it('maps the midpoint to half strength', () => {
    assert.equal(actions.percentToLevel(50), 10);
  });

  it('clamps above 100 rather than overshooting the device range', () => {
    assert.equal(actions.percentToLevel(150), actions.LOVENSE_MAX_LEVEL);
    assert.equal(actions.percentToLevel(1e9), actions.LOVENSE_MAX_LEVEL);
  });

  it('clamps negatives to zero', () => {
    assert.equal(actions.percentToLevel(-20), 0);
  });

  it('never silently turns a non-zero request into a no-op', () => {
    // 1% rounds to level 0, which would be indistinguishable from "off".
    // A request for *some* vibration must produce at least level 1.
    for (const p of [0.1, 1, 2, 2.4]) {
      assert.ok(
        actions.percentToLevel(p) >= 1,
        `${p}% produced level 0, which reads as off`,
      );
    }
  });

  it('never exceeds the Lovense device range for any input', () => {
    for (let p = -50; p <= 200; p += 0.5) {
      const level = actions.percentToLevel(p);
      assert.ok(
        level >= 0 && level <= actions.LOVENSE_MAX_LEVEL,
        `${p}% produced out-of-range level ${level}`,
      );
    }
  });
});

describe('normaliseDuration', () => {
  it('never returns 0, which Lovense reads as "run indefinitely"', () => {
    for (const s of [0, -1, -1000, Number.NaN, Number.NEGATIVE_INFINITY]) {
      assert.ok(
        actions.normaliseDuration(s) > 1,
        `${s} produced ${actions.normaliseDuration(s)}, which risks an endless command`,
      );
    }
  });

  it('floors values Lovense would reject (must be > 1)', () => {
    assert.ok(actions.normaliseDuration(0.5) > 1);
    assert.ok(actions.normaliseDuration(1) > 1);
  });

  it('passes through durations that are already valid', () => {
    assert.equal(actions.normaliseDuration(9), 9);
    assert.equal(actions.normaliseDuration(300), 300);
  });
});

describe('vibrate', () => {
  it('builds the Function command Lovense expects', () => {
    const a = actions.vibrate(50, 2);
    assert.equal(a.kind, 'function');
    if (a.kind !== 'function') return;
    assert.equal(a.action, 'Vibrate:10');
    assert.equal(a.timeSec, 2);
  });

  it('carries the clamp through to the emitted action string', () => {
    const a = actions.vibrate(500, 2);
    if (a.kind !== 'function') return assert.fail('expected a function action');
    assert.equal(a.action, `Vibrate:${actions.LOVENSE_MAX_LEVEL}`);
  });

  it('never emits an indefinite command, whatever duration it is given', () => {
    for (const s of [0, -5, Number.NaN]) {
      const a = actions.vibrate(50, s);
      if (a.kind !== 'function') return assert.fail('expected a function action');
      assert.notEqual(a.timeSec, 0);
      assert.ok(a.timeSec > 1);
    }
  });
});

describe('stop', () => {
  it('is the one command allowed to use timeSec 0', () => {
    const a = actions.stop();
    if (a.kind !== 'function') return assert.fail('expected a function action');
    assert.equal(a.action, 'Stop');
    assert.equal(a.timeSec, 0);
  });
});

describe('pattern', () => {
  it('respects the 50-value limit the API imposes', () => {
    const a = actions.pattern(new Array(80).fill(50), 1000, 10);
    if (a.kind !== 'pattern') return assert.fail('expected a pattern action');
    assert.equal(a.strength.split(';').length, 50);
  });

  it('floors the interval at the 100ms minimum', () => {
    const a = actions.pattern([10, 20], 5, 10);
    if (a.kind !== 'pattern') return assert.fail('expected a pattern action');
    assert.match(a.rule, /S:100#/);
  });

  it('clamps every step, not just the first', () => {
    const a = actions.pattern([10, 500, 20], 1000, 10);
    if (a.kind !== 'pattern') return assert.fail('expected a pattern action');
    for (const step of a.strength.split(';')) {
      assert.ok(Number(step) <= actions.LOVENSE_MAX_LEVEL, `step ${step} out of range`);
    }
  });
});

describe('ramp', () => {
  it('moves from the start value to the peak', () => {
    const a = actions.ramp(0, 100, 5, 10);
    if (a.kind !== 'pattern') return assert.fail('expected a pattern action');
    const steps = a.strength.split(';').map(Number);
    assert.equal(steps.at(0), 0);
    assert.equal(steps.at(-1), actions.LOVENSE_MAX_LEVEL);
  });

  it('stays within range across the whole ramp', () => {
    const a = actions.ramp(0, 100, 20, 30);
    if (a.kind !== 'pattern') return assert.fail('expected a pattern action');
    for (const step of a.strength.split(';').map(Number)) {
      assert.ok(step >= 0 && step <= actions.LOVENSE_MAX_LEVEL);
    }
  });
});
