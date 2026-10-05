import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { LovenseToy } from '../lovense/types';
import type { ToyLink } from '../store/store';
import { store } from '../store/store';
import { focusLabel, focusTargets, getFocus, setFocus } from './focus';

/**
 * Focus decides which of her toys a command reaches. The property that
 * matters most: with focus on one toy, no other toy is ever addressed.
 */

const lush: LovenseToy = { id: 'aa', name: 'lush', nickName: 'Lush 3', status: '1' };
const hush: LovenseToy = { id: 'bb', name: 'hush', status: '1' };
const off = (t: LovenseToy): LovenseToy => ({ ...t, status: '0' });

function link(toys: LovenseToy[]): ToyLink {
  return {
    uid: 'g:u',
    guildId: 'g',
    discordUserId: 'u',
    displayName: 'her',
    toys,
    platform: 'ios',
    lastSeen: Date.now(),
    callbackCount: 5,
    createdAt: 0,
  };
}

describe('focusTargets', () => {
  it('all: one command, with no toy ID, so it reaches whatever is connected', () => {
    const t = focusTargets(link([lush, hush]), { kind: 'all' });
    assert.ok(t.ok);
    assert.equal(t.toyIds, undefined);
  });

  it('all: refused when the app lists toys but none is connected', () => {
    assert.equal(focusTargets(link([off(lush), off(hush)]), { kind: 'all' }).ok, false);
  });

  it('all: still sends when the app has listed no toys at all', () => {
    // Nothing to judge by; Lovense delivers to whatever is there.
    assert.equal(focusTargets(link([]), { kind: 'all' }).ok, true);
  });

  it('one toy: exactly that toy, never the others', () => {
    const t = focusTargets(link([lush, hush]), { kind: 'toy', id: 'bb', label: 'hush' });
    assert.ok(t.ok);
    assert.deepEqual(t.toyIds, ['bb']);
  });

  it('one toy: refused while it is disconnected', () => {
    const t = focusTargets(link([lush, off(hush)]), { kind: 'toy', id: 'bb', label: 'hush' });
    assert.ok(!t.ok);
    assert.match(t.error, /isn't connected/);
  });

  it('one toy: refused once the app stops listing it, naming it by its saved label', () => {
    const t = focusTargets(link([lush]), { kind: 'toy', id: 'bb', label: 'Old Hush' });
    assert.ok(!t.ok);
    assert.match(t.error, /Old Hush/);
  });
});

describe('focusLabel', () => {
  it('prefers the current nickname over the one saved', () => {
    assert.equal(focusLabel({ kind: 'toy', id: 'aa', label: 'old' }, link([lush])), 'Lush 3');
    assert.equal(focusLabel({ kind: 'all' }, null), 'all connected toys');
  });
});

describe('saved focus', () => {
  afterEach(() => store.deleteSetting('focus:g-focus:u'));

  it('defaults to all', () => {
    assert.deepEqual(getFocus('g-focus', 'u'), { kind: 'all' });
  });

  it('survives being read back, as after a restart', () => {
    setFocus('g-focus', 'u', { kind: 'toy', id: 'aa', label: 'Lush 3' });
    assert.deepEqual(getFocus('g-focus', 'u'), { kind: 'toy', id: 'aa', label: 'Lush 3' });
  });

  it('falls back to all if what was saved is unreadable', () => {
    store.setSetting('focus:g-focus:u', '{not json');
    assert.deepEqual(getFocus('g-focus', 'u'), { kind: 'all' });
  });
});
