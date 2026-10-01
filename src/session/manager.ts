import { config } from '../config';
import { log } from '../logger';
import { LovenseError, lovense } from '../lovense/client';
import * as actions from '../lovense/actions';
import { describeAction, type ToyAction } from '../lovense/types';
import { store } from '../store/store';
import { presence } from './presence';
import { RateLimiter } from './rate-limiter';

/**
 * A session is tease mode: while it exists, messages from anyone else in the
 * main channel buzz the owner's toy.
 *
 * `armed`     - triggers fire.
 * `suspended` - the toy went offline; triggers are ignored, but the session
 *               is intact and resumes by itself if the toy comes back inside
 *               OFFLINE_GRACE_SEC. Only when that window closes is the
 *               session disarmed for real.
 *
 * The suspended state exists because iOS suspends background apps. Over a
 * multi-hour session a few minutes of silence is normal, and ending the
 * session on the first gap would mean re-running `/tease` over and over.
 */
export type SessionState = 'armed' | 'suspended';

export interface Session {
  uid: string;
  guildId: string;
  /** Discord user who owns the toy. Their own messages never trigger it. */
  ownerId: string;
  /** Who ran `/tease`. Often not the owner. */
  startedBy: string;
  state: SessionState;
  intensityPercent: number;
  durationSec: number;
  armedAt: number;
  suspendedAt: number | null;
  limiter: RateLimiter;
  /** When the last reminder was due, posted or skipped. Starts at armedAt. */
  lastReminderAt: number;
  reminderTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  triggerCount: number;
  /** Triggers dropped because the toy was offline or the session suspended. */
  missedCount: number;
}

export type SessionEventType = 'suspended' | 'resumed' | 'grace-expired' | 'reminder';

export type SessionEventListener = (payload: {
  type: SessionEventType;
  session: Session;
}) => void;

export type ErrorListener = (payload: { session: Session; error: Error }) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a due reminder should be posted. The one case it is skipped: the
 * session was already paused when this interval began, so the "paused"
 * notice has gone out and the whole interval was spent unreachable. One
 * message about a dead link is enough.
 */
export function shouldPostReminder(
  session: Pick<Session, 'state' | 'suspendedAt' | 'lastReminderAt'>,
): boolean {
  return !(
    session.state === 'suspended' &&
    session.suspendedAt !== null &&
    session.suspendedAt <= session.lastReminderAt
  );
}

/**
 * Teardown paths send Stop to a toy that is often already gone. Their
 * failures are expected and must not feed back into presence, or suspending
 * a session would re-trigger suspension.
 */
const TEARDOWN_SOURCES = ['suspend', 'disarm', 'shutdown', 'stop-all'];

/**
 * Owns all sessions and is the only path to the toy.
 *
 * Deliberate design choices:
 *  - Session state lives in memory only. A restart comes back disarmed.
 *    Failing closed is the only safe default here.
 *  - No expiry. Tease is driven by the other person's messages, so a
 *    session nobody is paying attention to produces nothing by itself. A
 *    timeout could only cut a quiet session short. Instead, a reminder posts
 *    to the command channel every TEASE_REMINDER_MINUTES, so it can't be
 *    lost track of.
 *  - `sendNow` is the single choke point, so the intensity cap, the rate
 *    limit and the audit log can't be bypassed by a new command.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  /** When whatever was last sent to each uid stops running on the toy. */
  private runningUntil = new Map<string, number>();
  private eventListeners: SessionEventListener[] = [];
  private errorListeners: ErrorListener[] = [];

  onEvent(fn: SessionEventListener): void {
    this.eventListeners.push(fn);
  }

  onError(fn: ErrorListener): void {
    this.errorListeners.push(fn);
  }

  private emit(type: SessionEventType, session: Session): void {
    for (const fn of this.eventListeners) {
      try {
        fn({ type, session });
      } catch (err) {
        log.error(`Session event listener threw: ${(err as Error).message}`);
      }
    }
  }

  private emitError(session: Session, error: Error): void {
    for (const fn of this.errorListeners) {
      try {
        fn({ session, error });
      } catch (err) {
        log.error(`Error listener threw: ${(err as Error).message}`);
      }
    }
  }

  private key(guildId: string, ownerId: string): string {
    return `${guildId}:${ownerId}`;
  }

  get(guildId: string, ownerId: string): Session | undefined {
    return this.sessions.get(this.key(guildId, ownerId));
  }

  listForGuild(guildId: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.guildId === guildId);
  }

  /** Start tease. Re-arming replaces the old session rather than stacking on it. */
  arm(params: {
    uid: string;
    guildId: string;
    ownerId: string;
    startedBy?: string;
    intensityPercent?: number;
    durationSec?: number;
  }): Session {
    this.disarm(params.guildId, params.ownerId, { silent: true });

    const now = Date.now();

    const session: Session = {
      uid: params.uid,
      guildId: params.guildId,
      ownerId: params.ownerId,
      startedBy: params.startedBy ?? params.ownerId,
      state: 'armed',
      intensityPercent: params.intensityPercent ?? config.BUZZ_INTENSITY_PERCENT,
      durationSec: params.durationSec ?? config.BUZZ_DURATION_SEC,
      armedAt: now,
      suspendedAt: null,
      limiter: new RateLimiter(config.MIN_COMMAND_INTERVAL_MS, config.MAX_COMMANDS_PER_MINUTE),
      triggerCount: 0,
      missedCount: 0,
      lastReminderAt: now,
      reminderTimer: null,
      graceTimer: null,
    };

    this.sessions.set(this.key(params.guildId, params.ownerId), session);
    this.scheduleReminder(session);
    log.info(`Tease on for ${params.ownerId} (started by ${session.startedBy})`);
    return session;
  }

  /**
   * Change a running tease's strength or length without resetting it: the
   * buzz count, elapsed time and reminder schedule all carry on.
   */
  retune(
    guildId: string,
    ownerId: string,
    params: { intensityPercent?: number; durationSec?: number },
  ): Session | undefined {
    const session = this.sessions.get(this.key(guildId, ownerId));
    if (!session) return undefined;
    if (params.intensityPercent !== undefined) session.intensityPercent = params.intensityPercent;
    if (params.durationSec !== undefined) session.durationSec = params.durationSec;
    log.info(
      `Tease retuned for ${ownerId}: ${session.intensityPercent}% / ${session.durationSec}s`,
    );
    return session;
  }

  /**
   * Each reminder is scheduled from the previous one, not from arm time, so
   * the interval stays even however long the session runs.
   */
  private scheduleReminder(session: Session): void {
    if (config.TEASE_REMINDER_MINUTES <= 0) return;
    const intervalMs = config.TEASE_REMINDER_MINUTES * 60_000;
    const wait = Math.max(0, session.lastReminderAt + intervalMs - Date.now());

    session.reminderTimer = setTimeout(() => {
      const current = this.sessions.get(this.key(session.guildId, session.ownerId));
      if (current !== session) return;

      if (shouldPostReminder(session)) this.emit('reminder', session);
      else log.debug(`Reminder for ${session.ownerId} skipped: paused all interval`);

      session.lastReminderAt = Date.now();
      this.scheduleReminder(session);
    }, wait);
    session.reminderTimer.unref?.();
  }

  private clearTimers(session: Session): void {
    if (session.reminderTimer) clearTimeout(session.reminderTimer);
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.reminderTimer = null;
    session.graceTimer = null;
  }

  /**
   * The toy dropped offline. Keep the session, stop triggering, and start the
   * grace countdown.
   */
  suspend(guildId: string, ownerId: string): Session | undefined {
    const session = this.sessions.get(this.key(guildId, ownerId));
    if (!session || session.state === 'suspended') return undefined;

    session.state = 'suspended';
    session.suspendedAt = Date.now();

    // Best effort - this will usually fail, because the toy is gone. That is
    // acceptable: every command carries its own timeSec expiry, so nothing is
    // left running on the toy regardless.
    void this.sendNow(session.uid, actions.stop(), 'suspend').catch(() => {});

    if (config.OFFLINE_GRACE_SEC === 0) {
      this.disarm(guildId, ownerId, { silent: true });
      log.info(`Grace window disabled; disarmed ${ownerId} on offline`);
      this.emit('grace-expired', session);
      return session;
    }

    session.graceTimer = setTimeout(() => {
      const current = this.sessions.get(this.key(guildId, ownerId));
      if (!current || current.state !== 'suspended') return;
      this.disarm(guildId, ownerId, { silent: true });
      log.info(`Grace window closed for ${ownerId}; session disarmed`);
      this.emit('grace-expired', current);
    }, config.OFFLINE_GRACE_SEC * 1000);
    session.graceTimer.unref?.();

    log.info(`Session suspended for ${ownerId} (grace ${config.OFFLINE_GRACE_SEC}s)`);
    this.emit('suspended', session);
    return session;
  }

  /** The toy came back inside the grace window. */
  resume(guildId: string, ownerId: string): Session | undefined {
    const session = this.sessions.get(this.key(guildId, ownerId));
    if (!session || session.state !== 'suspended') return undefined;

    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = null;
    session.state = 'armed';
    session.suspendedAt = null;

    // Messages that arrived while offline are gone, not queued. Reset the
    // limiter so the first message after reconnection isn't throttled.
    session.limiter.reset();

    log.info(`Session resumed for ${ownerId}`);
    this.emit('resumed', session);
    return session;
  }

  /** Disarm and send a Stop. Always safe to call, armed or not. */
  disarm(
    guildId: string,
    ownerId: string,
    opts: { silent?: boolean } = {},
  ): Session | undefined {
    const session = this.sessions.get(this.key(guildId, ownerId));
    if (!session) return undefined;

    this.clearTimers(session);
    this.sessions.delete(this.key(guildId, ownerId));

    if (!opts.silent) {
      log.info(`Session disarmed for ${ownerId} (${session.triggerCount} triggers)`);
    }

    void this.sendNow(session.uid, actions.stop(), 'disarm').catch((err) => {
      log.warn(`Stop after disarm failed: ${(err as Error).message}`);
    });

    return session;
  }

  /** Panic path: disarm every session in the guild and stop every toy. */
  async stopAll(guildId: string): Promise<number> {
    const active = this.listForGuild(guildId);
    for (const s of active) {
      this.clearTimers(s);
      this.sessions.delete(this.key(s.guildId, s.ownerId));
    }

    // Stop every linked toy, not just the armed ones - a manual /buzz may
    // still be running on a toy that was never armed.
    const links = store.listByGuild(guildId);
    await Promise.allSettled(
      links.map((link) => this.sendNow(link.uid, actions.stop(), 'stop-all')),
    );

    log.warn(`stopAll invoked for guild ${guildId} (${active.length} sessions)`);
    return active.length;
  }

  /**
   * A Discord message qualified as a trigger. The return value says what
   * happened, so the caller can log it without spamming the channel.
   */
  async handleTrigger(
    session: Session,
    source: string,
  ): Promise<'sent' | 'throttled' | 'suspended' | 'offline' | 'failed'> {
    if (session.state === 'suspended') {
      session.missedCount += 1;
      return 'suspended';
    }

    // Skip known-offline toys before spending a rate-limit slot or an API
    // call. The presence sweep will suspend the session shortly; this avoids
    // doomed requests in the meantime.
    const status = presence.statusForUid(session.uid);
    if (status?.presence === 'offline') {
      session.missedCount += 1;
      log.debug(`Trigger skipped for ${session.ownerId}: toy offline`);
      return 'offline';
    }

    const gate = session.limiter.tryAcquire();
    if (!gate.allowed) {
      log.debug(`Trigger throttled (${gate.reason}) for ${session.ownerId}`);
      return 'throttled';
    }

    const action = actions.vibrate(session.intensityPercent, session.durationSec);

    try {
      await this.sendWithWakeRetry(session.uid, action, source);
      session.triggerCount += 1;
      return 'sent';
    } catch (err) {
      session.missedCount += 1;
      this.emitError(session, err as Error);
      return 'failed';
    }
  }

  /**
   * iOS suspends background apps, and the first command sent to a
   * freshly-woken Lovense Remote is the one most likely to come back 507.
   * A short retry turns that into a slightly late buzz instead of a miss.
   *
   * Only retryable errors (507 / transport) are retried; a bad token fails
   * once rather than three times.
   */
  private async sendWithWakeRetry(
    uid: string,
    action: ToyAction,
    source: string,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= config.WAKE_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.sendNow(uid, action, attempt === 0 ? source : `${source}:retry${attempt}`, {
          deferOfflineReport: true,
        });
        return;
      } catch (err) {
        lastError = err;
        const retryable = err instanceof LovenseError ? err.retryable : false;
        if (!retryable || attempt === config.WAKE_RETRY_ATTEMPTS) break;
        await sleep(config.WAKE_RETRY_DELAY_MS * (attempt + 1));
      }
    }

    // Reported only once every attempt has failed. Reporting the first 507
    // would suspend the session and send a DM, only for the retry to land a
    // second later and resume it.
    if (lastError instanceof LovenseError && lastError.code === 507) {
      presence.markReportedOffline(uid);
    }
    throw lastError;
  }

  /**
   * Whether something is still running on the toy. The probe's Vibrate:0
   * would cut it short, so the prober waits until this has passed.
   */
  busyUntil(uid: string): number {
    return this.runningUntil.get(uid) ?? 0;
  }

  /**
   * Liveness probe: Vibrate:0, through the same wake retry a real trigger
   * gets, so a sleeping iOS app that answers the second attempt counts as
   * reachable rather than raising a false "paused" notice. Only the final
   * outcome is reported to presence.
   */
  async probe(uid: string): Promise<boolean> {
    try {
      await this.sendWithWakeRetry(uid, actions.probe(), 'probe');
      return true;
    } catch (err) {
      if (err instanceof LovenseError && err.code !== undefined) {
        presence.markReportedOffline(uid, err.code);
      } else {
        presence.noteInconclusive(uid);
      }
      return false;
    }
  }

  /**
   * The one place commands leave the process. Manual commands go through here
   * too, so they get the same logging and error mapping.
   */
  async sendNow(
    uid: string,
    action: ToyAction,
    source: string,
    opts: { deferOfflineReport?: boolean } = {},
  ): Promise<void> {
    const description = describeAction(action);
    const isProbe = source.startsWith('probe');
    const previousRunningUntil = this.runningUntil.get(uid);

    // Marked before the request goes out, so a probe can't slip in while
    // this one is still in flight.
    if (action.kind === 'function' && action.action === 'Stop') {
      this.runningUntil.delete(uid);
    } else {
      this.runningUntil.set(
        uid,
        Math.max(previousRunningUntil ?? 0, Date.now() + action.timeSec * 1000),
      );
    }

    try {
      await lovense.send(uid, action);
      store.logCommand({ uid, description, source, ok: true });
      // Any 200 is proof the path works, whatever the command was.
      presence.noteReachable(uid);
    } catch (err) {
      // It never reached the toy, so nothing new is running on it.
      if (previousRunningUntil === undefined) this.runningUntil.delete(uid);
      else this.runningUntil.set(uid, previousRunningUntil);

      const message = err instanceof LovenseError ? err.message : (err as Error).message;
      store.logCommand({ uid, description, source, ok: false, error: message });
      // A dead link would otherwise log a probe failure every interval; the
      // presence transition already says it once.
      (isProbe ? log.debug : log.warn)(`Lovense command failed (${source}): ${message}`);

      // 507 means Lovense has no live connection to the app. Tell the
      // presence monitor at once rather than letting every later message
      // fail the same way until the heartbeat timeout expires. The transition
      // that follows suspends the session, and the next callback or
      // successful command resumes it. The retry path reports after its
      // last attempt instead.
      if (
        err instanceof LovenseError &&
        err.code === 507 &&
        !opts.deferOfflineReport &&
        !TEARDOWN_SOURCES.includes(source)
      ) {
        presence.markReportedOffline(uid);
      }

      throw err;
    }
  }

  /** Called on shutdown so nothing is left running on the toy. */
  async shutdown(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const s of all) this.clearTimers(s);
    this.sessions.clear();
    await Promise.allSettled(
      all.map((s) => this.sendNow(s.uid, actions.stop(), 'shutdown')),
    );
  }
}

export const sessions = new SessionManager();
