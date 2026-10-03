import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveToys, toyChoices, toyLabel } from './toys';
import type { LovenseToy } from './types';

/**
 * Commands name toys loosely — by nickname, by model, or by the ID that
 * autocomplete fills in. Getting this wrong means buzzing the wrong toy, so
 * ambiguity is refused rather than resolved by guessing.
 */

const lush: LovenseToy = { id: 'aa11', name: 'lush', nickName: 'Lush 3', status: '1', battery: 87 };
const hush: LovenseToy = { id: 'bb22', name: 'hush', status: '1', battery: 41 };
const lush2: LovenseToy = { id: 'cc33', name: 'lush', status: '0' };

const ids = (r: ReturnType<typeof resolveToys>) => (r.ok ? r.toys.map((t) => t.id) : r.error);

describe('resolveToys', () => {
  it('means every connected toy when no toy is named', () => {
    assert.deepEqual(ids(resolveToys([lush, hush, lush2], null)), ['aa11', 'bb22']);
  });

  it('falls back to every listed toy if none reports connected', () => {
    // The status may be stale; refusing outright would lock tease out.
    assert.deepEqual(ids(resolveToys([lush2], undefined)), ['cc33']);
  });

  it('finds a toy by the ID autocomplete sends', () => {
    assert.deepEqual(ids(resolveToys([lush, hush], 'bb22')), ['bb22']);
  });

  it('finds a toy by nickname or model, ignoring case', () => {
    assert.deepEqual(ids(resolveToys([lush, hush], 'lush 3')), ['aa11']);
    assert.deepEqual(ids(resolveToys([lush, hush], 'HUSH')), ['bb22']);
  });

  it('refuses a name two toys share rather than guessing', () => {
    const r = resolveToys([lush, lush2], 'lush');
    assert.ok(!r.ok);
    assert.match(r.error, /more than one/);
  });

  it('says what toys there are when the name matches none', () => {
    const r = resolveToys([lush, hush], 'gravity');
    assert.ok(!r.ok);
    assert.match(r.error, /Lush 3/);
    assert.match(r.error, /hush/);
  });

  it('refuses when the app has reported no toys at all', () => {
    assert.equal(resolveToys([], null).ok, false);
  });
});

describe('toyChoices', () => {
  it('shows the label, battery and connection, and sends the ID', () => {
    assert.deepEqual(toyChoices([lush, lush2], ''), [
      { name: 'Lush 3 · 87%', value: 'aa11' },
      { name: 'lush · disconnected', value: 'cc33' },
    ]);
  });

  it('filters by what has been typed', () => {
    assert.deepEqual(toyChoices([lush, hush], 'hu').map((c) => c.value), ['bb22']);
  });
});

describe('toyLabel', () => {
  it('prefers the nickname set in the app', () => {
    assert.equal(toyLabel(lush), 'Lush 3');
    assert.equal(toyLabel(hush), 'hush');
  });
});
