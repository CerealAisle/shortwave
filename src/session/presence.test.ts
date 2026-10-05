import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { config } from '../config';
import type { LovenseToy } from '../lovense/types';
import type { ToyLink } from '../store/store';
import { diagnose, isToyConnected, presence } from './presence';

/**
 * The presence state machine decides whether a session fires, pauses or ends,
 * so its edges matter more than most things here. `unknown` is a deliberate
 * third state: without heartbeats enabled in the Lovense dashboard we cannot
 * tell "asleep" from "quiet", and guessing either way is worse than saying so.
 *
 * These tests assume .env.test's HEARTBEAT_TIMEOUT_SEC.
 */

const NOW = Date.now();
const TIMEOUT_MS = config.HEARTBEAT_TIMEOUT_SEC * 1000;

const connectedToy: LovenseToy = { id: 'abc', name: 'hush', status: '1' };
const disconnectedToy: LovenseToy = { id: 'abc', name: 'hush', status: '0' };

function link(over: Partial<ToyLink> = {}): ToyLink {
  return {
    uid: 'guild:user',
    guildId: 'guild',
    discordUserId: 'user',
    displayName: 'tester',
    toys: [connectedToy],
    platform: 'ios',
    lastSeen: NOW - 5_000,
    callbackCount: 20,
    createdAt: NOW - 86_400_000,
    ...over,
  };
}

describe('isToyConnected', () => {
  it('accepts status as both string and number, as Lovense sends both', () => {
    assert.equal(isToyConnected({ ...connectedToy, status: '1' }), true);
    assert.equal(isToyConnected({ ...connectedToy, status: 1 }), true);
    assert.equal(isToyConnected({ ...connectedToy, status: '0' }), false);
    assert.equal(isToyConnected({ ...connectedToy, status: 0 }), false);
  });
});

describe('presence.statusFor', () => {
  beforeEach(() => {
    // Clear any 507 flag or command result left by a previous test.
    presence.forget('guild:user');
  });

  it('is online for a heartbeating link with a connected toy', () => {
    assert.equal(presence.statusFor(link()).presence, 'online');
  });

  it('is unknown before the QR has ever been scanned', () => {
    assert.equal(
      presence.statusFor(link({ lastSeen: null, callbackCount: 0 })).presence,
      'unknown',
    );
  });

  it('is unknown after pairing but before any heartbeat', () => {
    // One callback is the pairing callback. Without a second we cannot tell
    // whether heartbeats are enabled at all, so we must not claim "offline".
    const status = presence.statusFor(link({ callbackCount: 1 }));
    assert.equal(status.presence, 'unknown');
    assert.equal(status.heartbeatsWorking, false);
  });

  it('is offline once heartbeats have gone quiet past the timeout', () => {
    assert.equal(
      presence.statusFor(link({ lastSeen: NOW - TIMEOUT_MS - 1_000 })).presence,
      'offline',
    );
  });

  it('is still online just inside the timeout', () => {
    assert.equal(
      presence.statusFor(link({ lastSeen: NOW - TIMEOUT_MS + 5_000 })).presence,
      'online',
    );
  });

  it('is offline when the app is talking but no toy is attached', () => {
    // Phone fine, Bluetooth dropped. The timeout would never catch this.
    assert.equal(presence.statusFor(link({ toys: [disconnectedToy] })).presence, 'offline');
    assert.equal(presence.statusFor(link({ toys: [] })).presence, 'offline');
  });

  it('reports only the toys that are actually connected', () => {
    const status = presence.statusFor(link({ toys: [connectedToy, disconnectedToy] }));
    assert.equal(status.connectedToys.length, 1);
  });
});

describe('presence 507 handling', () => {
  beforeEach(() => {
    presence.forget('guild:user');
  });

  it('a 507 outranks a heartbeat that arrived seconds ago', () => {
    // This is the iOS-suspend case: the app keeps heartbeating while its
    // command channel is dead. Trusting the heartbeat here would keep firing
    // commands into a void for the whole timeout window.
    const fresh = link({ lastSeen: NOW - 1_000 });
    assert.equal(presence.statusFor(fresh).presence, 'online');

    presence.markReportedOffline('guild:user');
    assert.equal(presence.statusFor(fresh).presence, 'offline');
  });

  it('a heartbeat does not clear it — that is what made sessions flap', () => {
    // A backgrounded iOS app keeps heartbeating while refusing commands.
    // Each heartbeat used to clear the 507, resume the session, and the next
    // buzz failed again: a paused/resumed notice pair every minute or so.
    presence.markReportedOffline('guild:user');
    presence.noteCallback('guild:user');
    assert.equal(presence.statusFor(link()).presence, 'offline');
  });

  it('a command that gets through clears it, so a cold app launch recovers', () => {
    // The prober re-tests soon after a heartbeat; its 200 is what does this.
    presence.markReportedOffline('guild:user');
    presence.noteReachable('guild:user');
    assert.equal(presence.statusFor(link()).presence, 'online');
  });

  it('cannot leave a link stuck offline forever', () => {
    for (let i = 0; i < 5; i++) {
      presence.markReportedOffline('guild:user');
      presence.noteReachable('guild:user');
    }
    assert.equal(presence.statusFor(link()).presence, 'online');
  });

  it('tells listeners about every result, so an outage notice can be reset', () => {
    const seen: boolean[] = [];
    presence.onResult(({ uid, ok }) => uid === 'guild:user' && seen.push(ok));
    presence.markReportedOffline('guild:user');
    presence.noteReachable('guild:user');
    assert.deepEqual(seen, [false, true]);
  });

  it('does not leak across links', () => {
    presence.markReportedOffline('guild:user');
    const other = link({ uid: 'guild:other', discordUserId: 'other' });
    assert.equal(presence.statusFor(other).presence, 'online');
    presence.noteCallback('guild:user');
  });

  it('does not resurrect a genuinely stale link', () => {
    const stale = link({ lastSeen: NOW - TIMEOUT_MS - 60_000 });
    presence.markReportedOffline('guild:user');
    presence.noteCallback('guild:user');
    assert.equal(presence.statusFor(stale).presence, 'offline');
  });
});

describe('presence from command results', () => {
  const PROBE_MS = config.PROBE_INTERVAL_SEC * 1000;

  beforeEach(() => {
    presence.forget('guild:user');
    presence.forget('guild:other');
  });

  it('a recent 200 is online even when heartbeats have gone quiet', () => {
    // The whole point of probing: iOS stops heartbeating long before the
    // command path actually dies.
    presence.noteReachable('guild:user');
    const quiet = link({ lastSeen: Date.now() - TIMEOUT_MS - 60_000 });
    assert.equal(presence.statusFor(quiet).presence, 'online');
  });

  it('a recent 200 is online without heartbeats enabled at all', () => {
    presence.noteReachable('guild:user');
    assert.equal(presence.statusFor(link({ callbackCount: 1 })).presence, 'online');
  });

  it('a fresh heartbeat reporting no toy attached still wins over a 200', () => {
    // Lovense accepts commands for the app whether or not a toy is paired to
    // it, so a 200 can't speak for Bluetooth.
    presence.noteReachable('guild:user');
    const detached = link({ lastSeen: Date.now() - 1_000, toys: [disconnectedToy] });
    assert.equal(presence.statusFor(detached).presence, 'offline');
  });

  it('a stale 200 falls back to the heartbeat signal', () => {
    presence.noteReachable('guild:user');
    const later = Date.now() + PROBE_MS * 2 + 1_000;
    const stale = link({ lastSeen: later - TIMEOUT_MS - 1_000 });
    assert.equal(presence.statusFor(stale, later).presence, 'offline');
  });

  it('a 200 clears an earlier 507', () => {
    presence.markReportedOffline('guild:user');
    assert.equal(presence.statusFor(link()).presence, 'offline');
    presence.noteReachable('guild:user');
    assert.equal(presence.statusFor(link()).presence, 'online');
  });

  it('a link or token error from the probe is offline, and keeps its code', () => {
    presence.markReportedOffline('guild:user', 503);
    const status = presence.statusFor(link());
    assert.equal(status.presence, 'offline');
    assert.equal(status.lastResult?.code, 503);
  });

  it('a network failure says nothing either way', () => {
    presence.noteFailed('guild:user', undefined);
    assert.equal(presence.statusFor(link()).presence, 'online');
  });

  it('a failed command after a success does not cost the link its reachability', () => {
    // Heartbeats long gone, as on iOS: only the earlier 200 keeps it online.
    presence.noteReachable('guild:user');
    presence.noteFailed('guild:user', undefined);
    const quiet = link({ lastSeen: Date.now() - TIMEOUT_MS - 60_000 });
    assert.equal(presence.statusFor(quiet).presence, 'online');
  });

  it('a failed command is recorded without marking the link offline', () => {
    // A 400 is about the command, not the app; the board shows it instead.
    presence.noteFailed('guild:user', 400);
    const status = presence.statusFor(link());
    assert.equal(status.presence, 'online');
    assert.equal(status.lastResult?.code, 400);
  });

  it('forget drops everything held for a link', () => {
    presence.markReportedOffline('guild:user');
    presence.forget('guild:user');
    assert.equal(presence.lastResult('guild:user'), null);
    assert.equal(presence.statusFor(link()).presence, 'online');
  });
});

describe('diagnose', () => {
  const offline = (over: Partial<ReturnType<typeof presence.statusFor>>) => ({
    presence: 'offline' as const,
    lastSeen: NOW - 30_000,
    lastResult: { at: NOW, ok: false, code: 507 },
    connectedToys: [connectedToy],
    heartbeatsWorking: true,
    ...over,
  });

  it('calls a 507 with fresh heartbeats a backgrounded app', () => {
    const d = diagnose(offline({}), NOW);
    assert.equal(d?.backgrounded, true);
    assert.match(d?.hint ?? '', /Force-quit/);
  });

  it('calls a 507 with no recent heartbeat a closed app or offline phone', () => {
    const d = diagnose(offline({ lastSeen: NOW - TIMEOUT_MS - 60_000 }), NOW);
    assert.equal(d?.backgrounded, false);
    assert.match(d?.hint ?? '', /closed or the phone is offline/);
  });

  it('explains other codes without guessing at a fix', () => {
    const d = diagnose(offline({ lastResult: { at: NOW, ok: false, code: 501 } }), NOW);
    assert.match(d?.meaning ?? '', /developer token/);
    assert.equal(d?.hint, null);
  });

  it('says nothing for a link that is online', () => {
    assert.equal(diagnose(offline({ presence: 'online' }), NOW), null);
  });
});
