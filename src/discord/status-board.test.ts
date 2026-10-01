import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session } from '../session/manager';
import type { PresenceStatus } from '../session/presence';
import { RateLimiter } from '../session/rate-limiter';
import type { ToyLink } from '../store/store';
import { renderBoard, renderBoardBody, type BoardRow } from './status-board';

/**
 * The board is the glanceable answer to "is the toy responding?", so the
 * things worth pinning down are that it never misreports reachability and
 * that its body is stable — the edit debounce relies on an unchanged state
 * rendering to an identical string.
 */

const NOW = 1_800_000_000_000;

function row(over: Partial<BoardRow> = {}, status: Partial<PresenceStatus> = {}): BoardRow {
  const link: ToyLink = {
    uid: 'g:u',
    guildId: 'g',
    discordUserId: '111',
    displayName: 'Daddy',
    toys: [{ id: 't1', name: 'lush', nickName: 'Lush 3', status: '1', battery: 87 }],
    platform: 'ios',
    lastSeen: NOW - 60_000,
    callbackCount: 10,
    createdAt: NOW - 86_400_000,
  };
  return {
    link,
    status: {
      presence: 'online',
      lastSeen: link.lastSeen,
      lastResult: { at: NOW - 120_000, ok: true },
      connectedToys: link.toys,
      heartbeatsWorking: true,
      ...status,
    },
    since: null,
    session: undefined,
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    uid: 'g:u',
    guildId: 'g',
    ownerId: '111',
    startedBy: '222',
    state: 'armed',
    intensityPercent: 50,
    durationSec: 1.5,
    armedAt: NOW - (2 * 60 + 14) * 60_000,
    suspendedAt: null,
    limiter: new RateLimiter(0, 100),
    lastReminderAt: NOW,
    reminderTimer: null,
    graceTimer: null,
    triggerCount: 12,
    missedCount: 0,
    ...over,
  };
}

describe('renderBoardBody', () => {
  it('shows each toy with its battery and a reachable line', () => {
    const body = renderBoardBody([row()], NOW);
    assert.match(body, /\*\*Daddy\*\* · <@111>/);
    assert.match(body, /🟢 Lush 3 · 87%/);
    assert.match(body, /reachable, probed <t:\d+:R>/);
    assert.match(body, /tease off/);
  });

  it('shows how long a toy has been unreachable, and why', () => {
    const body = renderBoardBody(
      [
        row(
          { since: NOW - 18 * 60_000 },
          { presence: 'offline', lastResult: { at: NOW - 60_000, ok: false, code: 507 } },
        ),
      ],
      NOW,
    );
    assert.match(body, /🔴 Lush 3/);
    assert.match(body, /unreachable since <t:\d+:R> \(507\)/);
  });

  it('never calls a toy reachable when presence says otherwise', () => {
    for (const presence of ['offline', 'unknown'] as const) {
      const body = renderBoardBody([row({}, { presence })], NOW);
      assert.doesNotMatch(body, /🟢|reachable,/, `${presence} rendered as reachable`);
    }
  });

  it('summarises tease with count and elapsed time', () => {
    const body = renderBoardBody([row({ session: session() })], NOW);
    assert.match(body, /tease on at 50% \/ 1\.5s · 12 buzz\(es\) · 2h 14m/);
  });

  it('marks paused tease as paused', () => {
    const body = renderBoardBody([row({ session: session({ state: 'suspended' }) })], NOW);
    assert.match(body, /tease paused/);
  });

  it('renders the same state to the same string, so unchanged state is not re-edited', () => {
    assert.equal(renderBoardBody([row()], NOW), renderBoardBody([row()], NOW));
  });

  it('says so when nothing is linked', () => {
    assert.match(renderBoardBody([], NOW), /No toys linked/);
  });
});

describe('renderBoard', () => {
  it('stays inside Discord\'s 2000-character limit', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ link: { ...row().link, uid: `g:${i}`, displayName: `user ${i}` } }),
    );
    assert.ok(renderBoard(renderBoardBody(rows, NOW), NOW).length <= 2000);
  });
});
