import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAlarmTime } from './alarm-time';

/**
 * Times are checked as instants (UTC) so the tests don't depend on the
 * machine's own timezone. Denver is UTC-6 in summer (MDT), UTC-7 in winter.
 */

const DENVER = 'America/Denver';
// Monday 2026-10-05, 14:00 in Denver (20:00 UTC).
const NOW = Date.UTC(2026, 9, 5, 20, 0);
const iso = (s: string, now = NOW, zone = DENVER) => {
  const r = parseAlarmTime(s, zone, now);
  return r.ok ? new Date(r.at).toISOString() : `error: ${r.error}`;
};

describe('parseAlarmTime', () => {
  it('reads a plain time as later today', () => {
    assert.equal(iso('9pm'), '2026-10-06T03:00:00.000Z');
    assert.equal(iso('9:30pm'), '2026-10-06T03:30:00.000Z');
    assert.equal(iso('9:30 PM'), '2026-10-06T03:30:00.000Z');
    assert.equal(iso('21:30'), '2026-10-06T03:30:00.000Z');
  });

  it('moves a time already passed today to tomorrow', () => {
    assert.equal(iso('9am'), '2026-10-06T15:00:00.000Z');
    assert.equal(iso('noon'), '2026-10-06T18:00:00.000Z');
  });

  it('reads today, tomorrow, weekdays and dates', () => {
    assert.equal(iso('tomorrow 7am'), '2026-10-06T13:00:00.000Z');
    assert.equal(iso('fri 9pm'), '2026-10-10T03:00:00.000Z');
    assert.equal(iso('friday at 9pm'), '2026-10-10T03:00:00.000Z');
    assert.equal(iso('10/31 8pm'), '2026-11-01T02:00:00.000Z');
    assert.equal(iso('2026-12-25 07:00'), '2026-12-25T14:00:00.000Z');
  });

  it('a weekday that is today, but already past, means next week', () => {
    assert.equal(iso('mon 9am'), '2026-10-12T15:00:00.000Z');
  });

  it('honours a zone given in the time', () => {
    assert.equal(iso('9pm ET'), '2026-10-06T01:00:00.000Z');
    assert.equal(iso('9pm PST'), '2026-10-06T04:00:00.000Z');
    assert.equal(iso('9pm America/New_York'), '2026-10-06T01:00:00.000Z');
    assert.equal(iso('21:00 UTC'), '2026-10-05T21:00:00.000Z');
  });

  it('lands correctly across both daylight-saving changes', () => {
    // US clocks go back on 2026-11-01: 9pm that night is MST, UTC-7.
    assert.equal(iso('2026-11-01 21:00'), '2026-11-02T04:00:00.000Z');
    // And forward on 2027-03-14: 9pm that night is MDT, UTC-6.
    assert.equal(iso('2027-03-14 21:00', Date.UTC(2027, 2, 13, 12)), '2027-03-15T03:00:00.000Z');
  });

  it('wraps a month/day already passed this year into next year', () => {
    assert.equal(iso('1/5 9am'), '2027-01-05T16:00:00.000Z');
  });

  it('refuses what it cannot read, rather than guessing', () => {
    for (const s of ['', 'soon', '9', '25:00', '13pm', '9:75pm', '9pm Mars/Base', 'blursday 9pm']) {
      assert.match(iso(s), /^error/, `"${s}" should be refused`);
    }
  });

  it('refuses a full date that has already passed', () => {
    assert.match(iso('2026-10-01 9am'), /already passed/);
  });
});
