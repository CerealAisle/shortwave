import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session, TriggerOutcome } from '../session/manager';
import { MAX_LINES, renderEntry, renderLog } from './tease-log';

/**
 * The tease log is the controller's private view of tease: every message,
 * and whether it buzzed — and if not, why.
 */

const base = { intensityPercent: 50, durationSec: 1.5 };
const entry = (outcome: TriggerOutcome) =>
  renderEntry({ at: 1_000_000, authorId: '222', messageUrl: 'https://discord.com/x', outcome, buzz: 7 });

describe('renderEntry', () => {
  it('a sent buzz shows strength, length and its number', () => {
    const line = entry({ result: 'sent', ...base });
    assert.match(line, /sent\*\* 50% · 1.5s · buzz #7/);
    assert.match(line, /<@222>/);
    assert.match(line, /\[message\]\(https:\/\/discord.com\/x\)/);
  });

  it('says which throttle dropped it', () => {
    assert.match(entry({ result: 'throttled', ...base, throttle: 'interval' }), /since the last buzz/);
    assert.match(entry({ result: 'throttled', ...base, throttle: 'quota' }), /in the last minute/);
  });

  it('gives the reason for every message that was not sent', () => {
    assert.match(entry({ result: 'suspended', ...base }), /paused/);
    assert.match(entry({ result: 'offline', ...base, code: 507 }), /isn't reachable \(507\)/);
    assert.match(entry({ result: 'stopped', ...base }), /\/stop/);
    assert.match(entry({ result: 'unfocused', ...base, focusError: 'no toys are connected' }), /no toys/);
    assert.match(entry({ result: 'failed', ...base, code: undefined }), /failed.*network/);
  });
});

describe('renderLog', () => {
  const session = {
    ownerId: '111',
    intensityPercent: 50,
    durationSec: 1.5,
    triggerCount: 3,
    throttledCount: 2,
    missedCount: 1,
    armedAt: 0,
  } as Session;

  it('shows the counts, and a final line once tease is off', () => {
    const on = renderLog({ session, lines: ['a'], dropped: 0, endedAt: null, focus: 'all connected toys' });
    assert.match(on, /3 sent · 2 throttled · 1 not sent/);
    const off = renderLog({ session, lines: ['a'], dropped: 0, endedAt: 5000, focus: 'all connected toys' });
    assert.match(off, /\*\*Tease off\*\*/);
  });

  it('stays inside Discord\'s 2000 characters, dropping the oldest lines', () => {
    const lines = Array.from({ length: MAX_LINES }, (_, i) => `${i} ${'x'.repeat(300)}`);
    const out = renderLog({ session, lines, dropped: 4, endedAt: null, focus: 'all' });
    assert.ok(out.length <= 2000);
    assert.match(out, new RegExp(`${MAX_LINES - 1} x`), 'the newest line is kept');
    assert.match(out, /earlier/);
  });
});
