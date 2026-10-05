import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { store } from './store/store';
import { MAX_TIMER_MS, Timers, parseDuration } from './timers';

describe('parseDuration', () => {
  it('reads the forms people type', () => {
    assert.equal(parseDuration('10m'), 600_000);
    assert.equal(parseDuration('1h30m'), 5_400_000);
    assert.equal(parseDuration('1h 30m'), 5_400_000);
    assert.equal(parseDuration('45s'), 45_000);
    assert.equal(parseDuration('1.5h'), 5_400_000);
    assert.equal(parseDuration('2 hours'), 7_200_000);
    assert.equal(parseDuration('1d'), 86_400_000);
  });

  it('treats a bare number as minutes', () => {
    assert.equal(parseDuration('90'), 5_400_000);
    assert.equal(parseDuration('0'), 0);
  });

  it('refuses anything it only half understands, rather than guessing', () => {
    for (const s of ['', 'soon', '10x', '10m later', 'h', '1h30']) {
      assert.equal(parseDuration(s), null, `"${s}" should not parse`);
    }
  });
});

describe('Timers', () => {
  const GUILD = 'g-timer';
  const params = { name: 'Break', guildId: GUILD, channelId: 'c', userId: 'u' };
  let t: Timers;

  afterEach(() => {
    t?.stop();
    for (const { key } of store.listSettings(`timer:${GUILD}:`)) store.deleteSetting(key);
  });

  it('saves a timer so a restart keeps it', () => {
    t = new Timers();
    const r = t.set(params, 600_000, 1_000);
    assert.ok(r.ok);
    assert.equal(r.timer.dueAt, 601_000);
    assert.equal(store.listSettings(`timer:${GUILD}:`).length, 1);
  });

  it('the same name, in any case, replaces rather than duplicates', () => {
    t = new Timers();
    t.set(params, 600_000);
    const r = t.set({ ...params, name: 'BREAK' }, 60_000);
    assert.ok(r.ok && r.replaced);
    assert.equal(store.listSettings(`timer:${GUILD}:`).length, 1);
  });

  it('cancels by name and says whether there was one', () => {
    t = new Timers();
    t.set(params, 600_000);
    assert.equal(t.cancel(GUILD, 'break'), true);
    assert.equal(t.cancel(GUILD, 'break'), false);
    assert.equal(store.listSettings(`timer:${GUILD}:`).length, 0);
  });

  it('refuses too short and too long', () => {
    t = new Timers();
    assert.equal(t.set(params, 1_000).ok, false);
    assert.equal(t.set(params, MAX_TIMER_MS + 1).ok, false);
  });
});
