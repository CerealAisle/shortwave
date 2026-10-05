import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { log } from './logger';
import { store } from './store/store';
import { text } from './text';

/**
 * Named reminders for /timer. Each posts in the channel it was set in when
 * it runs out. Saved, so a restart doesn't lose them: one that fell due
 * while the bot was down fires as soon as it is back, marked late.
 */
export interface Timer {
  name: string;
  guildId: string;
  channelId: string;
  /** Who set it; pinged when it goes off. */
  userId: string;
  setAt: number;
  dueAt: number;
}

export const MAX_TIMER_MS = 7 * 24 * 3_600_000;
const MIN_TIMER_MS = 5_000;
/** A timer firing this long after it was due says it is late. */
const LATE_MS = 60_000;

const UNITS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/**
 * "10m", "1h30m", "1h 30m", "45s", "1.5h", or a bare number of minutes.
 * Null if it can't be read. Zero is allowed: /timer uses it to cancel.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60_000);

  const token = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = '';
  for (const match of s.matchAll(token)) {
    const unit = UNITS[match[2]!];
    if (unit === undefined) return null;
    total += Number(match[1]) * unit;
    consumed += match[0];
  }
  // Everything but spaces must have been understood.
  if (!consumed || consumed.replace(/\s/g, '') !== s.replace(/\s/g, '')) return null;
  return Math.round(total);
}

export type SetResult =
  | { ok: true; timer: Timer; replaced: boolean }
  | { ok: false; error: string };

function key(guildId: string, name: string): string {
  return `timer:${guildId}:${name.toLowerCase()}`;
}

export class Timers {
  private client: Client | null = null;
  private handles = new Map<string, NodeJS.Timeout>();

  /** Re-arm every saved timer. Call once Discord is ready. */
  start(client: Client): void {
    this.client = client;
    for (const { key: k, value } of store.listSettings('timer:')) {
      try {
        this.schedule(k, JSON.parse(value) as Timer);
      } catch {
        store.deleteSetting(k);
      }
    }
  }

  stop(): void {
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
  }

  set(params: Omit<Timer, 'setAt' | 'dueAt'>, ms: number, now = Date.now()): SetResult {
    if (ms < MIN_TIMER_MS) return { ok: false, error: text.timer.tooShort };
    if (ms > MAX_TIMER_MS) return { ok: false, error: text.timer.tooLong };

    const k = key(params.guildId, params.name);
    const replaced = this.cancelKey(k);
    const timer: Timer = { ...params, setAt: now, dueAt: now + ms };
    store.setSetting(k, JSON.stringify(timer));
    this.schedule(k, timer);
    return { ok: true, timer, replaced };
  }

  /** Returns whether there was such a timer. */
  cancel(guildId: string, name: string): boolean {
    return this.cancelKey(key(guildId, name));
  }

  private cancelKey(k: string): boolean {
    const handle = this.handles.get(k);
    if (handle) clearTimeout(handle);
    this.handles.delete(k);
    const existed = store.getSetting(k) !== null;
    store.deleteSetting(k);
    return existed;
  }

  private schedule(k: string, timer: Timer): void {
    const wait = Math.max(0, timer.dueAt - Date.now());
    const handle = setTimeout(() => void this.fire(k, timer), wait);
    handle.unref?.();
    this.handles.set(k, handle);
  }

  private async fire(k: string, timer: Timer): Promise<void> {
    this.handles.delete(k);
    store.deleteSetting(k);
    const late = Date.now() - timer.dueAt > LATE_MS;

    try {
      const channel = await this.client?.channels.fetch(timer.channelId);
      if (channel?.type !== ChannelType.GuildText) return;
      await (channel as TextChannel).send({
        content: late
          ? text.timer.expiredLate(timer.name, timer.userId, timer.setAt)
          : text.timer.expired(timer.name, timer.userId, timer.setAt),
        allowedMentions: { users: [timer.userId] },
      });
    } catch (err) {
      log.warn(`Timer "${timer.name}" could not post: ${(err as Error).message}`);
    }
  }
}

export const timers = new Timers();
