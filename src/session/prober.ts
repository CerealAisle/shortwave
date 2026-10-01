import { config } from '../config';
import { log } from '../logger';
import { store } from '../store/store';
import { sessions } from './manager';
import { presence, type CommandResult } from './presence';

/**
 * When a link is next due a probe, or null if it never should be.
 *
 *  - Never-scanned links have no app to reach.
 *  - Any command result counts, not just probes: a buzz that got a 200 a
 *    minute ago already answered the question.
 *  - Unreachable links back off to the longer interval, unless a callback
 *    has arrived since — the app re-registered, so check again now.
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
    if (!lastResult.ok && lastSeen > lastResult.at) due = Math.min(due, lastSeen);
  }

  return Math.max(due, busyUntil);
}

/**
 * Sends every linked toy a Vibrate:0 on an interval, so presence rests on a
 * test of the real command path rather than on heartbeats alone.
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
      `Prober running (every ${config.PROBE_INTERVAL_SEC}s, ` +
        `${config.PROBE_OFFLINE_INTERVAL_SEC}s while unreachable)`,
    );
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(now = Date.now()): void {
    for (const link of store.listAll()) {
      if (this.inFlight.has(link.uid)) continue;

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
