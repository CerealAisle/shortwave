import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimiter } from './rate-limiter';

/**
 * RateLimiter takes `now` as a parameter precisely so it can be tested without
 * waiting in real time. That is the general trick: push the clock to the edge
 * of the unit rather than reading it in the middle.
 */

const MIN_INTERVAL = 1500;
const PER_MINUTE = 25;
const T0 = 1_700_000_000_000; // any fixed epoch

describe('RateLimiter', () => {
  it('allows the first request', () => {
    const rl = new RateLimiter(MIN_INTERVAL, PER_MINUTE);
    assert.equal(rl.tryAcquire(T0).allowed, true);
  });

  it('blocks a second request inside the minimum interval', () => {
    const rl = new RateLimiter(MIN_INTERVAL, PER_MINUTE);
    rl.tryAcquire(T0);
    const gate = rl.tryAcquire(T0 + MIN_INTERVAL - 1);
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, 'interval');
  });

  it('allows again once the interval has passed', () => {
    const rl = new RateLimiter(MIN_INTERVAL, PER_MINUTE);
    rl.tryAcquire(T0);
    assert.equal(rl.tryAcquire(T0 + MIN_INTERVAL).allowed, true);
  });

  it('a blocked attempt does not extend the interval', () => {
    // Otherwise a fast talker could starve the limiter indefinitely.
    const rl = new RateLimiter(MIN_INTERVAL, PER_MINUTE);
    rl.tryAcquire(T0);
    rl.tryAcquire(T0 + 100);
    rl.tryAcquire(T0 + 200);
    assert.equal(rl.tryAcquire(T0 + MIN_INTERVAL).allowed, true);
  });

  it('enforces the per-minute quota', () => {
    // No minimum interval, so only the quota is under test.
    const rl = new RateLimiter(0, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.tryAcquire(T0 + i).allowed, true, `request ${i} should pass`);
    }
    const gate = rl.tryAcquire(T0 + 5);
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, 'quota');
  });

  it('slides the quota window rather than resetting on the minute', () => {
    const rl = new RateLimiter(0, 5);
    // Spread the burst out, so entries age out one at a time and the sliding
    // behaviour is actually distinguishable from a fixed-window reset.
    for (let i = 0; i < 5; i++) rl.tryAcquire(T0 + i * 10_000);

    // 50s in, all five are still inside the window.
    assert.equal(rl.tryAcquire(T0 + 50_001).allowed, false);

    // Just past 60s the first has aged out, freeing exactly one slot.
    assert.equal(rl.tryAcquire(T0 + 60_001).allowed, true);

    // Which immediately refills it — a fixed window would have reset to empty
    // here and allowed this through.
    assert.equal(rl.tryAcquire(T0 + 60_002).allowed, false);
  });

  it('reset clears both the interval and the quota', () => {
    const rl = new RateLimiter(MIN_INTERVAL, 2);
    rl.tryAcquire(T0);
    rl.tryAcquire(T0 + MIN_INTERVAL);
    assert.equal(rl.tryAcquire(T0 + MIN_INTERVAL * 2).allowed, false);

    rl.reset();
    assert.equal(rl.tryAcquire(T0 + MIN_INTERVAL * 2).allowed, true);
  });

  it('drops excess rather than queueing it', () => {
    // A buzz that arrives four seconds late is worse than no buzz, so the
    // limiter must refuse rather than defer. Verified by the absence of any
    // backlog: after a burst, the next allowed request is a fresh one.
    const rl = new RateLimiter(MIN_INTERVAL, PER_MINUTE);
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if (rl.tryAcquire(T0 + i * 100).allowed) allowed++;
    }
    // 20 attempts across 2s, with a 1.5s floor, admits exactly 2.
    assert.equal(allowed, 2);
  });
});
