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
    focus: { kind: 'all' },
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
    assert.match(body, /reachable, checked <t:\d+:R>/);
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
    assert.match(body, /unreachable since <t:\d+:R> — Lovense Remote isn't reachable \(507\)/);
  });

  it('names a backgrounded app: heartbeats arriving but commands refused', () => {
    // The flapping case. Saying what it is, and what fixes it, is the point.
    const body = renderBoardBody(
      [
        row(
          {},
          {
            presence: 'offline',
            lastSeen: Date.now() - 30_000,
            lastResult: { at: Date.now() - 10_000, ok: false, code: 507 },
          },
        ),
      ],
      NOW,
    );
    assert.match(body, /looks backgrounded/i);
    assert.match(body, /Force-quit Lovense Remote/);
  });

  it('explains a code that is not about the app', () => {
    const body = renderBoardBody(
      [row({}, { presence: 'offline', lastResult: { at: NOW, ok: false, code: 503 } })],
      NOW,
    );
    assert.match(body, /doesn't know this link — run \/connect again \(503\)/);
  });

  it('shows the last failed command while the app is still checking in', () => {
    // Online on check-ins alone, so the failure would otherwise go unseen —
    // and the bot no longer posts errors to the channel.
    const body = renderBoardBody(
      [row({}, { presence: 'online', lastResult: { at: NOW - 30_000, ok: false, code: 400 } })],
      NOW,
    );
    assert.match(body, /reachable \(app checking in\) · last command failed <t:\d+:R>: Lovense rejected/);
  });

  it('puts a banner, such as a /stop lockout, above everything', () => {
    const body = renderBoardBody([row()], NOW, '🛑 Stopped');
    assert.ok(body.startsWith('🛑 Stopped\n\n'));
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
    assert.match(renderBoardBody([], NOW), /No Lovense Remote app is linked/);
  });
});

describe('renderBoardBody with two toys', () => {
  const two = (sess?: Session) =>
    row({
      link: {
        ...row().link,
        toys: [
          { id: 't1', name: 'lush', nickName: 'Lush 3', status: '1', battery: 87 },
          { id: 't2', name: 'hush', nickName: 'Hush 2', status: '0', battery: 41 },
        ],
      },
      session: sess,
    });

  it('gives each toy its own line, and shows the focus and tease under them', () => {
    const body = renderBoardBody([two(session())], NOW);
    assert.match(body, /🟢 Lush 3 · 87%/);
    assert.match(body, /Hush 2 · 41% · disconnected/);
    assert.match(body, /focus: all connected toys · tease on at 50%/);
  });

  it('marks a disconnected toy even while the phone is reachable', () => {
    const body = renderBoardBody([two()], NOW);
    assert.match(body, /⚫ Hush 2/);
    assert.doesNotMatch(body, /🟢 Hush 2/);
  });

  it('marks the focused toy, and names it in the focus line', () => {
    const body = renderBoardBody(
      [{ ...two(), focus: { kind: 'toy', id: 't2', label: 'Hush 2' } }],
      NOW,
    );
    assert.match(body, /Hush 2 · 41% · disconnected ◀ focus/);
    assert.doesNotMatch(body, /Lush 3 · 87% ◀ focus/);
    assert.match(body, /focus: Hush 2 · tease off/);
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
