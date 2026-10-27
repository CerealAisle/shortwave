import { config } from '../config';
import { log } from '../logger';
import { store } from '../store/store';
import { sessions } from './manager';
import { presence, type CommandResult } from './presence';

/**
 * After a failure, a heartbeat brings the next probe forward — but never
 * sooner than this, so an app heartbeating every few seconds while refusing
 * commands isn't probed at the same rate.
 */
export const MIN_RETRY_AFTER_CALLBACK_MS = 60_000;

/**
 * When a link is next due a probe, or null if it never should be.
 *
 *  - Never-scanned links have no app to reach.
 *  - Any command result counts, not just probes: a buzz that got a 200 a
 *    minute ago already answered the question.
 *  - Unreachable links back off to the longer interval, unless a callback
 *    has arrived since — the app may be back, so check again soon. A
 *    heartbeat no longer clears a 507 by itself; this probe is what does.
 *  - Nothing is sent while a command is still running on the toy.
 */
export function nextProbeAt(input: {
  lastResult: CommandResult | null;
  lastSeen: number | null;
  busyUntil: number;
  onlineIntervalMs: number;
  offlineIntervalMs: number;
}): number | null {
  const { lastResult, lastSeen, busyUntil, onlineIntervalMs, offlineIntervalMs } = input;
  if (lastSeen === null || onlineIntervalMs <= 0) return null;

  let due = 0;
  if (lastResult) {
    due = lastResult.at + (lastResult.ok ? onlineIntervalMs : offlineIntervalMs);
    if (!lastResult.ok && lastSeen > lastResult.at) {
      due = Math.min(due, Math.max(lastSeen, lastResult.at + MIN_RETRY_AFTER_CALLBACK_MS));
    }
  }

  return Math.max(due, busyUntil);
}

/**
 * While tease is on, sends her toys a Vibrate:0 on an interval, so a session
 * pauses and resumes on a test of the real command path rather than on
 * heartbeats alone.
 *
 * Only while tease is on. With tease off nothing depends on knowing, and a
 * probe every few minutes is a command that can cut into Live Control from
 * Lovense Remote. Presence then rests on check-ins and on whatever commands
 * are actually sent, and /tease checks for itself before it starts.
 *
 * Only links in this server: a link left behind in another guild would
 * otherwise be probed, and fail, forever.
 */
export class Prober {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();

  start(): void {
    if (config.PROBE_INTERVAL_SEC <= 0) {
      log.warn('Active probing disabled (PROBE_INTERVAL_SEC=0). Presence relies on heartbeats.');
      return;
    }

    // Checked on the presence poll: cheap, and fine-grained enough that a
    // probe goes out within seconds of falling due.
    this.timer = setInterval(() => this.tick(), config.PRESENCE_POLL_SEC * 1000);
    this.timer.unref?.();
    log.info(
      `Prober running while tease is on (every ${config.PROBE_INTERVAL_SEC}s, ` +
        `${config.PROBE_OFFLINE_INTERVAL_SEC}s while unreachable)`,
    );
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Public for tests. */
  tick(now = Date.now()): void {
    for (const link of store.listByGuild(config.DISCORD_GUILD_ID)) {
      if (this.inFlight.has(link.uid)) continue;
      if (!sessions.hasSession(link.uid)) continue;
      // Something is being sent right now. Its answer is as good as a probe.
      if (sessions.isBusy(link.uid, now)) continue;

      const due = nextProbeAt({
        lastResult: presence.lastResult(link.uid),
        lastSeen: link.lastSeen,
        busyUntil: sessions.busyUntil(link.uid),
        onlineIntervalMs: config.PROBE_INTERVAL_SEC * 1000,
        offlineIntervalMs: config.PROBE_OFFLINE_INTERVAL_SEC * 1000,
      });
      if (due === null || now < due) continue;

      this.inFlight.add(link.uid);
      void sessions.probe(link.uid).finally(() => this.inFlight.delete(link.uid));
    }
  }
}

export const prober = new Prober();
