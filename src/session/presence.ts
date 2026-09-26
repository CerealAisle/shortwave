import { config } from '../config';
import { log } from '../logger';
import type { LovenseToy } from '../lovense/types';
import { store, type ToyLink } from '../store/store';

/**
 * `unknown` is a deliberate third state, not a failure mode.
 *
 * Lovense only sends repeat callbacks if heartbeats are enabled in the
 * developer dashboard. If they aren't, a link gets exactly one callback (at
 * pairing) and would look permanently stale afterwards. Treating that as
 * "offline" would block `/on` forever with a misleading message, so a link
 * that has only ever produced one callback stays `unknown`: usable, but with
 * a warning attached.
 */
export type Presence = 'online' | 'offline' | 'unknown';

export interface PresenceStatus {
  presence: Presence;
  lastSeen: number | null;
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

export function isToyConnected(toy: LovenseToy): boolean {
  return String(toy.status) === '1';
}

export class PresenceMonitor {
  private lastKnown = new Map<string, Presence>();
  private listeners: PresenceTransitionListener[] = [];
  private timer: NodeJS.Timeout | null = null;

  /**
   * Links the Lovense API has told us are unreachable (error 507), before the
   * heartbeat timeout would have noticed. Cleared by the next callback.
   */
  private reportedOffline = new Set<string>();

  get enabled(): boolean {
    return config.HEARTBEAT_TIMEOUT_SEC > 0;
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
  markReportedOffline(uid: string): void {
    if (this.reportedOffline.has(uid)) return;
    this.reportedOffline.add(uid);
    log.info(`Lovense reported ${uid} offline; marking it so without waiting for heartbeat timeout`);
    this.evaluate(uid);
  }

  /**
   * Presence is derived from the store rather than held in memory, so it
   * survives a restart: if a heartbeat landed 20 seconds before the process
   * came back up, the link is still online.
   */
  statusFor(link: ToyLink): PresenceStatus {
    const connectedToys = link.toys.filter(isToyConnected);
    // The pairing callback counts as one; anything beyond it is a heartbeat.
    const heartbeatsWorking = link.callbackCount > 1;

    // A 507 from Lovense outranks everything below, including a heartbeat
    // that arrived seconds ago: the app can be sending heartbeats while its
    // command channel is dead, which is exactly the iOS-suspend case.
    if (this.reportedOffline.has(link.uid)) {
      return { presence: 'offline', lastSeen: link.lastSeen, connectedToys, heartbeatsWorking };
    }

    let presence: Presence;

    if (!this.enabled || link.lastSeen === null) {
      presence = 'unknown';
    } else if (!heartbeatsWorking) {
      // One callback only — can't distinguish "quiet" from "gone".
      presence = 'unknown';
    } else if (Date.now() - link.lastSeen > config.HEARTBEAT_TIMEOUT_SEC * 1000) {
      presence = 'offline';
    } else if (connectedToys.length === 0) {
      // The app is talking to us, but no toy is attached to it.
      presence = 'offline';
    } else {
      presence = 'online';
    }

    return { presence, lastSeen: link.lastSeen, connectedToys, heartbeatsWorking };
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

  /** Poll for links that have gone quiet — no callback arrives to tell us. */
  start(): void {
    if (!this.enabled) {
      log.warn(
        'Heartbeat monitoring disabled (HEARTBEAT_TIMEOUT_SEC=0). ' +
          'Toy liveness will not be tracked.',
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
      return;
    }

    const { presence } = this.statusFor(link);
    const previous = this.lastKnown.get(uid);

    if (previous === presence) return;
    this.lastKnown.set(uid, presence);

    // First observation after startup isn't a transition worth announcing.
    if (previous === undefined) return;

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
