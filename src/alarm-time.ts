/**
 * Reads the `time` given to /alarm. Discord doesn't tell a bot what timezone
 * someone is in, so a time is read in TIMEZONE unless it names a zone
 * itself. The reply shows the result as a Discord timestamp, which every
 * viewer sees in their own local time — so a wrong reading is obvious.
 *
 *   [day] time [zone]
 *
 *   day   today · tomorrow · mon … sun (the next one) · 10/31 · 2026-10-31
 *         (left out: the next time that clock time comes round)
 *   time  9pm · 9:30pm · 9:30 pm · 21:30 · noon · midnight
 *   zone  PT · MT · CT · ET (and PST, MDT…) · UTC · America/New_York
 */

/** US abbreviations people actually type. Standard and daylight both map to
 * the region, so "PST" in July still means Pacific time. */
const ZONE_ABBREVIATIONS: Record<string, string> = {
  pt: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  mt: 'America/Denver',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  ct: 'America/Chicago',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  et: 'America/New_York',
  est: 'America/New_York',
  edt: 'America/New_York',
  utc: 'UTC',
  gmt: 'UTC',
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export type AlarmTime = { ok: true; at: number; zone: string } | { ok: false; error: string };

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock date and time in `zone` at instant `ms`. */
function wallClock(ms: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS.indexOf(get('weekday').toLowerCase().slice(0, 3)),
  };
}

/**
 * The instant at which it is `y-m-d h:mi` on the wall clock in `zone`.
 * Guess UTC, measure how far the zone is from it, correct, and check again
 * so a guess that straddles a daylight-saving change still lands right.
 */
function instantFor(y: number, m: number, d: number, h: number, mi: number, zone: string): number {
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(guess, zone);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const diff = target - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function parseClock(s: string): { h: number; m: number } | null {
  if (s === 'noon') return { h: 12, m: 0 };
  if (s === 'midnight') return { h: 0, m: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(s);
  if (!match) return null;
  let h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  const half = match[3]?.[0];
  if (m > 59) return null;
  if (half) {
    if (h < 1 || h > 12) return null;
    if (half === 'a') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else {
    // A bare "9" is too ambiguous to guess at; 24-hour needs the minutes.
    if (!match[2] || h > 23) return null;
  }
  return { h, m };
}

export function parseAlarmTime(input: string, defaultZone: string, now = Date.now()): AlarmTime {
  let rest = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!rest) return { ok: false, error: 'empty' };

  // Zone: an abbreviation, or an IANA name like America/New_York, at the end.
  let zone = defaultZone;
  const zoneMatch = /\s([a-z]+(?:\/[a-z_+-]+)+|[a-z]{2,4})$/.exec(rest);
  if (zoneMatch) {
    const word = zoneMatch[1]!;
    const fromAbbrev = ZONE_ABBREVIATIONS[word];
    const iana = word.includes('/') ? input.trim().split(/\s+/).pop()! : undefined;
    if (fromAbbrev) {
      zone = fromAbbrev;
      rest = rest.slice(0, zoneMatch.index).trim();
    } else if (iana && isValidZone(iana)) {
      zone = iana;
      rest = rest.slice(0, zoneMatch.index).trim();
    } else if (iana) {
      return { ok: false, error: `unknown timezone "${iana}"` };
    }
  }

  // Day, at the front.
  const today = wallClock(now, zone);
  let date: { y: number; m: number; d: number } | null = null;
  let explicitDay = true;
  const first = rest.split(' ')[0]!;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(first);
  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(first);
  const weekday = WEEKDAYS.indexOf(first.slice(0, 3));

  if (first === 'today') {
    date = { y: today.year, m: today.month, d: today.day };
  } else if (first === 'tomorrow' || first === 'tmrw') {
    const t = wallClock(now + 86_400_000, zone);
    date = { y: t.year, m: t.month, d: t.day };
  } else if (iso) {
    date = { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  } else if (slash) {
    date = { y: today.year, m: Number(slash[1]), d: Number(slash[2]) };
  } else if (weekday >= 0 && /^[a-z]+$/.test(first) && first.length >= 3) {
    const ahead = (weekday - today.weekday + 7) % 7;
    const t = wallClock(now + ahead * 86_400_000, zone);
    date = { y: t.year, m: t.month, d: t.day };
  } else {
    explicitDay = false;
    date = { y: today.year, m: today.month, d: today.day };
  }
  if (explicitDay) rest = rest.slice(first.length).trim();
  rest = rest.replace(/^at /, '');

  const clock = parseClock(rest);
  if (!clock) return { ok: false, error: `couldn't read the time "${rest || input}"` };

  let at = instantFor(date.y, date.m, date.d, clock.h, clock.m, zone);

  if (at <= now) {
    if (!explicitDay) {
      // Just a time that has passed today: the next one, tomorrow.
      const t = wallClock(now + 86_400_000, zone);
      at = instantFor(t.year, t.month, t.day, clock.h, clock.m, zone);
    } else if (weekday >= 0 && !iso && !slash) {
      // "fri 9pm" on a Friday after 9pm: next Friday.
      const t = wallClock(now + 7 * 86_400_000, zone);
      at = instantFor(t.year, t.month, t.day, clock.h, clock.m, zone);
    } else if (slash) {
      // "1/5" in December: next January.
      at = instantFor(date.y + 1, date.m, date.d, clock.h, clock.m, zone);
    } else {
      return { ok: false, error: 'that time has already passed' };
    }
  }

  return { ok: true, at, zone };
}
