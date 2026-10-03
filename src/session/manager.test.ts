import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../config';
import { command as off } from '../discord/commands/off';
import { command as stop } from '../discord/commands/stop';
import { LovenseError, lovense, makeUid } from '../lovense/client';
import type { ToyAction } from '../lovense/types';
import { store } from '../store/store';
import {
  planTriggerSends,
  sessions,
  shouldPostReminder,
  type Session,
  type ToyTease,
} from './manager';

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

const LUSH = { id: 'lush1', name: 'Lush' };
const HUSH = { id: 'hush1', name: 'Hush' };

let sent: { uid: string; action: ToyAction; toyId?: string }[] = [];
let failWith: Error | null = null;

const flush = () => new Promise((resolve) => setImmediate(resolve));
const isStop = (a: ToyAction) => a.kind === 'function' && a.action === 'Stop';
const stopsTo = (uid: string) => sent.filter((c) => c.uid === uid && isStop(c.action));
const vibrations = () => sent.filter((c) => !isStop(c.action));

beforeEach(() => {
  sent = [];
  failWith = null;
  mock.method(lovense, 'send', async (uid: string, action: ToyAction, toyId?: string) => {
    sent.push({ uid, action, toyId });
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

function armWearer(toys = [LUSH], extra: { startedBy?: string; intensityPercent?: number } = {}) {
  return sessions.arm({ uid: WEARER_UID, guildId: GUILD, ownerId: WEARER, toys, ...extra });
}

describe('the wearer can always stop', () => {
  it('ends tease someone else started on their toy', async () => {
    // The case this whole file exists for: /tease user:<wearer> run by the
    // other person, then /off by the wearer.
    armWearer([LUSH, HUSH], { startedBy: OTHER });
    const result = sessions.disarm(GUILD, WEARER);
    await flush();

    assert.deepEqual(result?.removed.map((t) => t.startedBy), [OTHER, OTHER]);
    assert.equal(sessions.get(GUILD, WEARER), undefined);
    // One Stop to every toy, not one per toy that might miss one.
    assert.equal(stopsTo(WEARER_UID).length, 1);
    assert.equal(stopsTo(WEARER_UID)[0]!.toyId, undefined);
  });

  it('ends tease on one toy without touching the other', async () => {
    armWearer([LUSH, HUSH], { startedBy: OTHER });
    const result = sessions.disarm(GUILD, WEARER, { toyIds: [HUSH.id] });
    await flush();

    assert.equal(result?.ended, false);
    assert.deepEqual([...sessions.get(GUILD, WEARER)!.toys.keys()], [LUSH.id]);
    assert.deepEqual(stopsTo(WEARER_UID).map((c) => c.toyId), [HUSH.id]);
  });

  it('ends the session when its last toy is turned off', async () => {
    armWearer([LUSH]);
    const result = sessions.disarm(GUILD, WEARER, { toyIds: [LUSH.id] });
    await flush();

    assert.equal(result?.ended, true);
    assert.equal(sessions.get(GUILD, WEARER), undefined);
  });

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

describe('tease', () => {
  afterEach(() => mock.timers.reset());

  it('has no expiry, and reminds on an even interval instead', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const reminders: Session[] = [];
    sessions.onEvent(({ type, session }) => {
      if (type === 'reminder' && session.ownerId === WEARER) reminders.push(session);
    });

    armWearer();
    const intervalMs = config.TEASE_REMINDER_MINUTES * 60_000;

    mock.timers.tick(intervalMs - 1);
    assert.equal(reminders.length, 0, 'no reminder before the first interval');

    mock.timers.tick(1);
    assert.equal(reminders.length, 1);

    // Eight hours on: still running, and exactly one reminder per interval.
    // Stepped an interval at a time; one big tick moves the mocked clock to
    // the end before the callbacks run.
    const steps = Math.floor((8 * 3_600_000) / intervalMs);
    for (let i = 0; i < steps; i++) mock.timers.tick(intervalMs);
    assert.ok(sessions.get(GUILD, WEARER), 'tease must not expire by itself');
    assert.equal(reminders.length, 1 + steps);
  });

  it('stops reminding once it is turned off', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    let count = 0;
    sessions.onEvent(({ type, session }) => {
      if (type === 'reminder' && session.ownerId === WEARER) count++;
    });

    armWearer();
    sessions.disarm(GUILD, WEARER);
    mock.timers.tick(config.TEASE_REMINDER_MINUTES * 60_000 * 3);
    assert.equal(count, 0);
  });

  it('running it again retunes a toy without resetting its count', () => {
    const { session } = armWearer([LUSH]);
    session.toys.get(LUSH.id)!.triggerCount = 7;
    const { added, updated } = armWearer([LUSH], { intensityPercent: 80 });

    const lush = sessions.get(GUILD, WEARER)!.toys.get(LUSH.id)!;
    assert.equal(added.length, 0);
    assert.equal(updated.length, 1);
    assert.equal(lush.intensityPercent, 80);
    assert.equal(lush.durationSec, config.BUZZ_DURATION_SEC);
    assert.equal(lush.triggerCount, 7);
  });

  it('adding a second toy leaves the first one as it was', () => {
    armWearer([LUSH], { intensityPercent: 30 });
    const { session, added } = armWearer([HUSH], { intensityPercent: 90 });

    assert.deepEqual(added.map((t) => t.toyId), [HUSH.id]);
    assert.equal(session.toys.get(LUSH.id)!.intensityPercent, 30);
    assert.equal(session.toys.get(HUSH.id)!.intensityPercent, 90);
  });
});

describe('shouldPostReminder', () => {
  const T = 1_000_000;

  it('posts while tease is running normally', () => {
    assert.equal(shouldPostReminder({ state: 'armed', suspendedAt: null, lastReminderAt: T }), true);
  });

  it('posts when the toy dropped during this interval — that is news', () => {
    assert.equal(
      shouldPostReminder({ state: 'suspended', suspendedAt: T + 1, lastReminderAt: T }),
      true,
    );
  });

  it('skips when the toy was already paused for the whole interval', () => {
    // The "paused" notice already said so. One message about a dead link.
    assert.equal(
      shouldPostReminder({ state: 'suspended', suspendedAt: T - 1, lastReminderAt: T }),
      false,
    );
  });
});

describe('triggers with more than one toy', () => {
  beforeEach(() => {
    // The app reports both toys, connected.
    store.recordCallback(
      WEARER_UID,
      [
        { id: LUSH.id, name: 'lush', status: 1 },
        { id: HUSH.id, name: 'hush', status: 1 },
      ],
      'ios',
    );
  });

  it('sends one command to every toy when they share settings', async () => {
    // Exactly what a one-toy setup has always sent: no toy ID at all.
    const { session } = armWearer([LUSH, HUSH]);
    assert.equal(await sessions.handleTrigger(session, 'test'), 'sent');

    assert.deepEqual(vibrations().map((c) => c.toyId), [undefined]);
    assert.equal(session.toys.get(LUSH.id)!.triggerCount, 1);
    assert.equal(session.toys.get(HUSH.id)!.triggerCount, 1);
  });

  it('sends each toy its own strength when they differ', async () => {
    armWearer([LUSH], { intensityPercent: 20 });
    const { session } = armWearer([HUSH], { intensityPercent: 80 });
    await sessions.handleTrigger(session, 'test');

    const byToy = new Map(vibrations().map((c) => [c.toyId, c.action]));
    assert.deepEqual([...byToy.keys()].sort(), [HUSH.id, LUSH.id].sort());
    const lush = byToy.get(LUSH.id)!;
    const hush = byToy.get(HUSH.id)!;
    if (lush.kind !== 'function' || hush.kind !== 'function') return assert.fail();
    assert.equal(lush.action, 'Vibrate:4');
    assert.equal(hush.action, 'Vibrate:16');
  });

  it('only buzzes the toys that are teasing', async () => {
    const { session } = armWearer([HUSH]);
    await sessions.handleTrigger(session, 'test');
    assert.deepEqual(vibrations().map((c) => c.toyId), [HUSH.id]);
  });

  it('uses one rate-limit slot per message, however many toys it buzzes', async () => {
    armWearer([LUSH], { intensityPercent: 20 });
    const { session } = armWearer([HUSH], { intensityPercent: 80 });
    assert.equal(await sessions.handleTrigger(session, 'first'), 'sent');
    assert.equal(await sessions.handleTrigger(session, 'second'), 'throttled');
  });
});

describe('planTriggerSends', () => {
  const tease = (toyId: string, intensityPercent = 50): ToyTease => ({
    toyId,
    toyName: toyId,
    startedBy: 'x',
    intensityPercent,
    durationSec: 1.5,
    armedAt: 0,
    triggerCount: 0,
    missedCount: 0,
  });

  it('collapses to one untargeted command when it can', () => {
    const plan = planTriggerSends([tease('a'), tease('b')], ['a', 'b']);
    assert.deepEqual(plan.map((p) => p.toyId), [undefined]);
  });

  it('targets each toy when only some of the link\'s toys are teasing', () => {
    const plan = planTriggerSends([tease('a')], ['a', 'b']);
    assert.deepEqual(plan.map((p) => p.toyId), ['a']);
  });

  it('targets each toy when settings differ', () => {
    const plan = planTriggerSends([tease('a', 20), tease('b', 80)], ['a', 'b']);
    assert.deepEqual(plan.map((p) => p.toyId), ['a', 'b']);
  });

  it('targets each toy when the app has not said what toys it has', () => {
    const plan = planTriggerSends([tease('a')], []);
    assert.deepEqual(plan.map((p) => p.toyId), ['a']);
  });
});
