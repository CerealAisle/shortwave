import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { command as off } from '../discord/commands/off';
import { command as stop } from '../discord/commands/stop';
import { LovenseError, lovense, makeUid } from '../lovense/client';
import type { ToyAction } from '../lovense/types';
import { store } from '../store/store';
import { sessions } from './manager';

/**
 * The rule these guard: commands that increase stimulation may be
 * restricted; commands that reduce or stop it never are. The person wearing
 * the toy can always end what is running on it, whoever started it.
 *
 * `lovense.send` is stubbed on the exported singleton, so nothing leaves the
 * process. Each call is recorded so the tests can check a Stop really went
 * out, not just that local state was cleared.
 */

const GUILD = 'guild-invariant';
const WEARER = 'wearer';
const OTHER = 'other';
const WEARER_UID = makeUid(GUILD, WEARER);
const OTHER_UID = makeUid(GUILD, OTHER);

let sent: { uid: string; action: ToyAction }[] = [];
let failWith: Error | null = null;

const flush = () => new Promise((resolve) => setImmediate(resolve));
const stopsTo = (uid: string) =>
  sent.filter((c) => c.uid === uid && c.action.kind === 'function' && c.action.action === 'Stop');

beforeEach(() => {
  sent = [];
  failWith = null;
  mock.method(lovense, 'send', async (uid: string, action: ToyAction) => {
    sent.push({ uid, action });
    if (failWith) throw failWith;
  });
  store.createLink(WEARER_UID, GUILD, WEARER, 'wearer');
  store.createLink(OTHER_UID, GUILD, OTHER, 'other');
});

afterEach(async () => {
  await sessions.stopAll(GUILD);
  mock.restoreAll();
});

after(() => {
  store.deleteLink(WEARER_UID);
  store.deleteLink(OTHER_UID);
});

function armWearer() {
  return sessions.arm({ uid: WEARER_UID, guildId: GUILD, ownerId: WEARER });
}

describe('the wearer can always stop', () => {
  it('disarm by the wearer ends their session and sends a Stop', async () => {
    armWearer();
    const ended = sessions.disarm(GUILD, WEARER);
    await flush();

    assert.ok(ended, 'disarm should return the session it ended');
    assert.equal(sessions.get(GUILD, WEARER), undefined);
    assert.equal(stopsTo(WEARER_UID).length, 1);
  });

  it('disarm works on a paused session', async () => {
    armWearer();
    sessions.suspend(GUILD, WEARER);
    sessions.disarm(GUILD, WEARER);
    await flush();

    assert.equal(sessions.get(GUILD, WEARER), undefined);
  });

  it('disarm clears local state even when Lovense refuses the Stop', async () => {
    // The toy's own timeSec expiry ends the buzz; what must not happen is the
    // session surviving and firing the next trigger.
    armWearer();
    failWith = new LovenseError('offline', 507, true);
    sessions.disarm(GUILD, WEARER);
    await flush();

    assert.equal(sessions.get(GUILD, WEARER), undefined);
  });

  it('stopAll ends every session and stops every linked toy, armed or not', async () => {
    // A one-off /buzz can be running on a toy that has no session at all.
    armWearer();
    const count = await sessions.stopAll(GUILD);

    assert.equal(count, 1);
    assert.equal(sessions.listForGuild(GUILD).length, 0);
    assert.equal(stopsTo(WEARER_UID).length, 1);
    assert.equal(stopsTo(OTHER_UID).length, 1);
  });

  it('stopAll still clears every session when every Stop fails', async () => {
    armWearer();
    failWith = new LovenseError('offline', 507, true);
    await sessions.stopAll(GUILD);

    assert.equal(sessions.listForGuild(GUILD).length, 0);
  });
});

describe('the stop commands are never gated', () => {
  for (const cmd of [off, stop]) {
    it(`/${cmd.data.name} has no owner check and no default permission gate`, () => {
      assert.ok(!cmd.ownerOnly, 'must not be owner-only');
      const json = cmd.data.toJSON();
      assert.ok(
        json.default_member_permissions === undefined || json.default_member_permissions === null,
        'must not require a Discord permission',
      );
    });
  }
});
