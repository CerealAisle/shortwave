import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../config';
import { command as tease } from '../discord/commands/tease';
import { command as stop } from '../discord/commands/stop';
import { loadCommands } from '../discord/registry';
import * as actions from '../lovense/actions';
import { LovenseError, lovense, makeUid } from '../lovense/client';
import type { ToyAction } from '../lovense/types';
import { store } from '../store/store';
import {
  StopLockoutError,
  isZeroAction,
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
    // other person, then turned off by the wearer.
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

describe('who can see which command', () => {
  // The wearer sees exactly three commands. /stop is the one that matters
  // here: it must never carry a permission gate, because it is how anyone —
  // the wearer above all — ends everything. Turning tease off is part of the
  // controller's /tease and is hidden, which is safe only because /stop
  // covers it.
  const commands = loadCommands();
  const isHidden = (name: string) => {
    const perms = commands.get(name)!.data.toJSON().default_member_permissions;
    return perms !== undefined && perms !== null;
  };

  it('/stop has no owner check and no permission gate', () => {
    assert.ok(!stop.ownerOnly);
    assert.equal(isHidden('stop'), false);
  });

  it('everyone sees only /connect, /test and /stop', () => {
    const visible = [...commands.keys()].filter((name) => !isHidden(name)).sort();
    assert.deepEqual(visible, ['connect', 'stop', 'test']);
  });

  it('/tease, which also turns tease off, is hidden but has no runtime owner check', () => {
    assert.equal(isHidden(tease.data.name), true);
    assert.ok(!tease.ownerOnly);
  });

  it('there is no /off any more: /tease off:True replaced it', () => {
    assert.equal(commands.has('off'), false);
    const off = tease.data.toJSON().options?.find((o) => o.name === 'off');
    assert.ok(off, '/tease needs an off option');
  });
});

describe('the /stop lockout', () => {
  const vibrate = { kind: 'function', action: 'Vibrate:10', timeSec: 2 } as const;
  const T = 2_000_000_000_000;

  afterEach(() => {
    mock.timers.reset();
    store.deleteSetting(`stop_lockout:${GUILD}`);
    // Drop the cached copy too.
    (sessions as unknown as { lockouts: Map<string, unknown> }).lockouts.delete(GUILD);
  });

  it('blocks anything that moves, and sends nothing', async () => {
    sessions.lockOut(GUILD, 180_000, WEARER);
    await assert.rejects(sessions.sendNow(WEARER_UID, vibrate, 'test'), StopLockoutError);
    assert.equal(vibrations().length, 0);
  });

  it('still lets through Stop and 0% commands, so /test and the probe work', async () => {
    sessions.lockOut(GUILD, 180_000, WEARER);
    await sessions.sendNow(WEARER_UID, actions.stop(), 'test');
    await sessions.sendNow(WEARER_UID, actions.probe(), 'test');
    assert.equal(sent.length, 2);
  });

  it('turns tease triggers into misses rather than buzzes', async () => {
    const { session } = armWearer([LUSH]);
    sessions.lockOut(GUILD, 180_000, WEARER);
    assert.equal(await sessions.handleTrigger(session, 'test'), 'stopped');
    assert.equal(vibrations().length, 0);
  });

  it('a later /stop replaces it, shorter or longer', () => {
    // Either person can shorten it. When that is OK is agreed between them.
    sessions.lockOut(GUILD, 30 * 60_000, WEARER, T);
    const shorter = sessions.lockOut(GUILD, 5 * 60_000, OTHER, T + 60_000);
    assert.equal(shorter?.until, T + 6 * 60_000);
    assert.equal(shorter?.by, OTHER);
    assert.equal(sessions.lockOut(GUILD, 60 * 60_000, WEARER, T)?.until, T + 60 * 60_000);
  });

  it('a zero-minute /stop lifts a running lockout', () => {
    sessions.lockOut(GUILD, 30 * 60_000, WEARER);
    assert.equal(sessions.lockOut(GUILD, 0, OTHER), null);
    assert.equal(sessions.lockout(GUILD), null);
  });

  it('a lifted lockout stays lifted after a restart', () => {
    sessions.lockOut(GUILD, 30 * 60_000, WEARER);
    sessions.lockOut(GUILD, 0, WEARER);
    (sessions as unknown as { lockouts: Map<string, unknown> }).lockouts.delete(GUILD);
    assert.equal(sessions.lockout(GUILD), null);
  });

  it('runs out by itself', () => {
    sessions.lockOut(GUILD, 60_000, WEARER, T);
    assert.ok(sessions.lockout(GUILD, T + 59_000));
    assert.equal(sessions.lockout(GUILD, T + 60_000), null);
  });

  it('survives a restart', () => {
    sessions.lockOut(GUILD, 60_000, WEARER, T);
    (sessions as unknown as { lockouts: Map<string, unknown> }).lockouts.delete(GUILD);
    assert.equal(sessions.lockout(GUILD, T + 1_000)?.by, WEARER);
  });

  it('a zero-minute /stop halts but locks nothing out', () => {
    assert.equal(sessions.lockOut(GUILD, 0, WEARER), null);
    assert.equal(sessions.lockout(GUILD), null);
  });
});

describe('isZeroAction', () => {
  it('passes Stop and level-0 commands', () => {
    assert.ok(isZeroAction(actions.stop()));
    assert.ok(isZeroAction(actions.probe()));
    assert.ok(isZeroAction({ kind: 'function', action: 'Vibrate:0,Rotate:0', timeSec: 2 }));
    assert.ok(isZeroAction(actions.pattern([0, 0, 0], 500, 5)));
  });

  it('blocks anything with movement in it, however small', () => {
    assert.ok(!isZeroAction(actions.vibrate(1, 2)));
    assert.ok(!isZeroAction({ kind: 'function', action: 'Vibrate:0,Rotate:3', timeSec: 2 }));
    assert.ok(!isZeroAction(actions.pattern([0, 5, 0], 500, 5)));
    assert.ok(!isZeroAction(actions.preset('pulse', 5)));
  });
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
