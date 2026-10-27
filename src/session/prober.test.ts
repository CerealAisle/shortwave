import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../config';
import { makeUid } from '../lovense/client';
import { store } from '../store/store';
import { sessions } from './manager';
import { MIN_RETRY_AFTER_CALLBACK_MS, Prober, nextProbeAt } from './prober';

/**
 * The probe sends Vibrate:0. It moves nothing on its own, but it does replace
 * whatever is running, so "never while busy" is the property that matters
 * most here. The backoff keeps a dead link from filling the log.
 */

const ONLINE = 300_000;
const OFFLINE = 900_000;
const T = 1_000_000_000;

function due(over: Partial<Parameters<typeof nextProbeAt>[0]> = {}) {
  return nextProbeAt({
    lastResult: null,
    lastSeen: T - 10_000,
    busyUntil: 0,
    onlineIntervalMs: ONLINE,
    offlineIntervalMs: OFFLINE,
    ...over,
  });
}

describe('nextProbeAt', () => {
  it('never probes a link whose QR was never scanned', () => {
    assert.equal(due({ lastSeen: null }), null);
  });

  it('never probes when probing is disabled', () => {
    assert.equal(due({ onlineIntervalMs: 0 }), null);
  });

  it('probes straight away when nothing has been sent yet', () => {
    assert.equal(due(), 0);
  });

  it('waits the online interval after a 200 — from any command, not just a probe', () => {
    assert.equal(due({ lastResult: { at: T, ok: true } }), T + ONLINE);
  });

  it('backs off to the offline interval after a failure', () => {
    assert.equal(due({ lastResult: { at: T, ok: false, code: 507 }, lastSeen: T - 1 }), T + OFFLINE);
  });

  it('checks again soon after a callback arrives following a failure', () => {
    // A heartbeat no longer clears a 507 by itself, so this probe is what
    // brings a recovered app back — without waiting out the backoff.
    const result = { at: T, ok: false, code: 507 };
    assert.equal(due({ lastResult: result, lastSeen: T + 90_000 }), T + 90_000);
  });

  it('but not more than once a minute, however often the app heartbeats', () => {
    const result = { at: T, ok: false, code: 507 };
    assert.equal(due({ lastResult: result, lastSeen: T + 5_000 }), T + MIN_RETRY_AFTER_CALLBACK_MS);
  });

  it('never fires while a command is still running on the toy', () => {
    const busyUntil = T + ONLINE + 60_000;
    assert.equal(due({ lastResult: { at: T, ok: true }, busyUntil }), busyUntil);
    assert.equal(due({ busyUntil }), busyUntil);
  });
});

describe('Prober.tick', () => {
  // Probes only go out while tease is on: with it off, nothing depends on
  // the answer, and a probe is a command that can cut into Live Control.
  const GUILD = config.DISCORD_GUILD_ID;
  const USER = 'prober-wearer';
  const UID = makeUid(GUILD, USER);
  const ELSEWHERE = makeUid('another-guild', USER);
  let probed: string[] = [];

  beforeEach(() => {
    probed = [];
    store.createLink(UID, GUILD, USER, 'wearer');
    store.recordCallback(UID, [], 'ios');
    store.createLink(ELSEWHERE, 'another-guild', USER, 'wearer');
    store.recordCallback(ELSEWHERE, [], 'ios');
    mock.method(sessions, 'probe', async (uid: string) => {
      probed.push(uid);
      return 'ok' as const;
    });
  });

  afterEach(async () => {
    sessions.disarm(GUILD, USER, { silent: true });
    sessions.disarm('another-guild', USER, { silent: true });
    mock.restoreAll();
  });

  after(() => {
    store.deleteLink(UID);
    store.deleteLink(ELSEWHERE);
  });

  it('sends nothing while tease is off', () => {
    new Prober().tick();
    assert.deepEqual(probed, []);
  });

  it('probes her while tease is on', () => {
    sessions.arm({ uid: UID, guildId: GUILD, ownerId: USER });
    new Prober().tick();
    assert.deepEqual(probed, [UID]);
  });

  it('never probes a link left behind in another server', () => {
    sessions.arm({ uid: ELSEWHERE, guildId: 'another-guild', ownerId: USER });
    new Prober().tick();
    assert.deepEqual(probed, []);
  });

  it('waits while something is being sent or running', () => {
    sessions.arm({ uid: UID, guildId: GUILD, ownerId: USER });
    mock.method(sessions, 'isBusy', () => true);
    new Prober().tick();
    assert.deepEqual(probed, []);
  });
});
