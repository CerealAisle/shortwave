import { config } from '../config';
import { log } from '../logger';
import { isToyConnected } from '../lovense/toys';
import type { LovenseToy } from '../lovense/types';
import { store, type ToyLink } from '../store/store';

/**
 * Presence comes from two sources, strongest first:
 *
 *  1. Command results. Every command Lovense answers — a real one or the
 *     prober's Vibrate:0 — is a direct test of the exact path a buzz takes.
 *     A 200 means reachable right now; a 507/501/503 means it isn't.
 *  2. Heartbeat callbacks, the fallback when no recent result exists.
 *     Passive, up to HEARTBEAT_TIMEOUT_SEC stale, and known to lie: the app
 *     can keep heartbeating while its command channel is dead.
 *
 * `unknown` is a deliberate third state, not a failure mode. With no recent
 * command result and heartbeats not enabled in the Lovense dashboard, a link
 * gets exactly one callback (at pairing) and would look permanently stale.
 * Treating that as "offline" would block `/tease` forever with a misleading
 * message, so it stays `unknown`: usable, but with a warning attached.
 */
export type Presence = 'online' | 'offline' | 'unknown';

/** What Lovense said the last time the bot sent this link anything. */
export interface CommandResult {
  at: number;
  ok: boolean;
  /** Lovense error code when !ok; undefined for a transport failure. */
  code?: number;
}

export interface PresenceStatus {
  presence: Presence;
  lastSeen: number | null;
  lastResult: CommandResult | null;
  /** Toys the app currently reports as connected (status 1). */
  connectedToys: LovenseToy[];
  /** True once we've seen enough callbacks to trust the signal. */
  heartbeatsWorking: boolean;
}

export type PresenceTransitionListener = (payload: {
  link: ToyLink;
  from: Presence;
  to: Presence;
}) => void;

// Lives with the other toy helpers; re-exported for existing callers.
export { isToyConnected };

export class PresenceMonitor {
  private lastKnown = new Map<string, Presence>();
  /** When each link entered its current state, for "unreachable since". */
  private changedAt = new Map<string, number>();
  private listeners: PresenceTransitionListener[] = [];
  private timer: NodeJS.Timeout | null = null;

  /**
   * Links the Lovense API has told us are unreachable (507, or a 501/503 from
   * the prober), before the heartbeat timeout would have noticed. Cleared by
   * the next callback or the next successful command.
   */
  private reportedOffline = new Set<string>();

  private results = new Map<string, CommandResult>();

  /** Whether heartbeat-based liveness is on. */
  get enabled(): boolean {
    return config.HEARTBEAT_TIMEOUT_SEC > 0;
  }

  /**
   * How long a 200 keeps a link online without another. Two probe intervals,
   * so one late probe doesn't flap it; without probing, as long as a
   * heartbeat would count for.
   */
  private get resultFreshMs(): number {
    const sec =
      config.PROBE_INTERVAL_SEC > 0 ? config.PROBE_INTERVAL_SEC * 2 : config.HEARTBEAT_TIMEOUT_SEC;
    return sec * 1000;
  }

  onTransition(fn: PresenceTransitionListener): void {
    this.listeners.push(fn);
  }

  /**
   * Lovense answered a command with 507 "Lovense APP is offline". That is a
   * direct statement from the server that it has no live connection to the
   * app, which is far better evidence than heartbeat silence and arrives
   * minutes sooner. Trust it immediately instead of waiting out
   * HEARTBEAT_TIMEOUT_SEC.
   *
   * Cleared by the next callback, so a cold launch of the app resumes the
   * session by itself.
   */
  markReportedOffline(uid: string, code = 507): void {
    this.results.set(uid, { at: Date.now(), ok: false, code });
    if (this.reportedOffline.has(uid)) return;
    this.reportedOffline.add(uid);
    log.info(`Lovense reported ${uid} unreachable (${code}); marking it offline`);
    this.evaluate(uid);
  }

  /**
   * Lovense accepted a command for this link. That is proof the whole path
   * works right now, so it also clears any earlier 507.
   */
  noteReachable(uid: string): void {
    this.results.set(uid, { at: Date.now(), ok: true });
    this.reportedOffline.delete(uid);
    this.evaluate(uid);
  }

  /** Record a failure that says nothing about reachability (e.g. network). */
  noteInconclusive(uid: string): void {
    this.results.set(uid, { at: Date.now(), ok: false });
  }

  lastResult(uid: string): CommandResult | null {
    return this.results.get(uid) ?? null;
  }

  /** Drop everything held for a link — it was unlinked. */
  forget(uid: string): void {
    this.reportedOffline.delete(uid);
    this.results.delete(uid);
    this.lastKnown.delete(uid);
    this.changedAt.delete(uid);
  }

  /**
   * When the link entered its current presence state, or null if it hasn't
   * changed since startup — the bot can't know how long it was already so.
   */
  since(uid: string): number | null {
    return this.changedAt.get(uid) ?? null;
  }

  /**
   * Presence is derived from the store rather than held in memory, so it
   * survives a restart: if a heartbeat landed 20 seconds before the process
   * came back up, the link is still online.
   */
  statusFor(link: ToyLink, now = Date.now()): PresenceStatus {
    const connectedToys = link.toys.filter(isToyConnected);
    // The pairing callback counts as one; anything beyond it is a heartbeat.
    const heartbeatsWorking = link.callbackCount > 1;
    const lastResult = this.results.get(link.uid) ?? null;
    const base = { lastSeen: link.lastSeen, lastResult, connectedToys, heartbeatsWorking };

    // A 507 from Lovense outranks everything below, including a heartbeat
    // that arrived seconds ago: the app can be sending heartbeats while its
    // command channel is dead, which is exactly the iOS-suspend case.
    if (this.reportedOffline.has(link.uid)) {
      return { presence: 'offline', ...base };
    }

    const heartbeatFresh =
      this.enabled &&
      link.lastSeen !== null &&
      now - link.lastSeen <= config.HEARTBEAT_TIMEOUT_SEC * 1000;

    // A recent 200 is the strongest evidence there is, and outranks heartbeat
    // silence. The one thing that overrides it is a fresh heartbeat saying
    // no toy is attached: Lovense accepts commands for the app either way.
    if (lastResult?.ok && now - lastResult.at <= this.resultFreshMs) {
      const detached = heartbeatsWorking && heartbeatFresh && connectedToys.length === 0;
      return { presence: detached ? 'offline' : 'online', ...base };
    }

    let presence: Presence;

    if (!this.enabled || link.lastSeen === null) {
      presence = 'unknown';
    } else if (!heartbeatsWorking) {
      // One callback only — can't distinguish "quiet" from "gone".
      presence = 'unknown';
    } else if (!heartbeatFresh) {
      presence = 'offline';
    } else if (connectedToys.length === 0) {
      // The app is talking to us, but no toy is attached to it.
      presence = 'offline';
    } else {
      presence = 'online';
    }

    return { presence, ...base };
  }

  statusForUid(uid: string): PresenceStatus | null {
    const link = store.getByUid(uid);
    return link ? this.statusFor(link) : null;
  }

  /**
   * Called from the callback handler on every pairing callback and heartbeat.
   * A fresh callback clears a 507 report — the app has re-registered with
   * Lovense, so it is worth trying again.
   */
  noteCallback(uid: string): void {
    this.reportedOffline.delete(uid);
    this.evaluate(uid);
  }

  /**
   * Poll for links whose evidence has gone stale — no callback or command
   * result arrives to tell us.
   */
  start(): void {
    if (!this.enabled && config.PROBE_INTERVAL_SEC === 0) {
      log.warn(
        'Heartbeat monitoring and probing both disabled ' +
          '(HEARTBEAT_TIMEOUT_SEC=0, PROBE_INTERVAL_SEC=0). Toy liveness will not be tracked.',
      );
      return;
    }

    this.timer = setInterval(() => {
      for (const link of store.listAll()) this.evaluate(link.uid);
    }, config.PRESENCE_POLL_SEC * 1000);

    // Don't keep the process alive purely for this timer.
    this.timer.unref?.();
    log.info(
      `Presence monitor running (timeout ${config.HEARTBEAT_TIMEOUT_SEC}s, ` +
        `poll ${config.PRESENCE_POLL_SEC}s)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private evaluate(uid: string): void {
    const link = store.getByUid(uid);
    if (!link) {
      this.lastKnown.delete(uid);
      this.changedAt.delete(uid);
      return;
    }

    const { presence } = this.statusFor(link);
    const previous = this.lastKnown.get(uid);

    if (previous === presence) return;
    this.lastKnown.set(uid, presence);

    // First observation after startup isn't a transition worth announcing.
    if (previous === undefined) return;
    this.changedAt.set(uid, Date.now());

    log.info(`Presence for ${uid}: ${previous} -> ${presence}`);
    for (const fn of this.listeners) {
      try {
        fn({ link, from: previous, to: presence });
      } catch (err) {
        log.error(`Presence listener threw: ${(err as Error).message}`);
      }
    }
  }
}

export const presence = new PresenceMonitor();
