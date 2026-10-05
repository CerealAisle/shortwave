import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { store } from '../store/store';
import { resolveTarget } from './target';

/**
 * .env.test leaves TARGET_USER_ID unset, so these exercise the fallback:
 * use whoever is linked, but only when that can't be a guess.
 */

const GUILD = 'g-target';

describe('resolveTarget without TARGET_USER_ID', () => {
  afterEach(() => {
    store.deleteLink(`${GUILD}:a`);
    store.deleteLink(`${GUILD}:b`);
  });

  it('refuses when nobody is linked', () => {
    assert.equal(resolveTarget(GUILD).ok, false);
  });

  it('uses the one person who is linked', () => {
    store.createLink(`${GUILD}:a`, GUILD, 'a', 'A');
    const t = resolveTarget(GUILD);
    assert.ok(t.ok);
    assert.equal(t.userId, 'a');
  });

  it('refuses to guess between two', () => {
    store.createLink(`${GUILD}:a`, GUILD, 'a', 'A');
    store.createLink(`${GUILD}:b`, GUILD, 'b', 'B');
    const t = resolveTarget(GUILD);
    assert.ok(!t.ok);
    assert.match(t.error, /TARGET_USER_ID/);
  });
});
