import { config } from '../config';
import { log } from '../logger';
import { LovenseError, lovense } from '../lovense/client';
import * as actions from '../lovense/actions';
import { describeAction, type ToyAction } from '../lovense/types';
import { store } from '../store/store';
import { focusTargets, getFocus } from './focus';
import { presence } from './presence';
import { RateLimiter } from './rate-limiter';

/**
 * A session is tease mode for one person: while it exists, messages from
 * anyone else in the main channel buzz their toys.
 *
 * Which toys is not stored here. Every trigger asks the focus (/focus) at
 * that moment: with focus on all, every toy connected right then; on one
 * toy, just that one. So a toy connected mid-session joins in, and changing
 * the focus redirects tease already running.
 *
 * `armed`     - triggers fire.
 * `suspended` - the app went offline; triggers are ignored, but the session
 *               is intact and resumes by itself if it comes back inside
 *               OFFLINE_GRACE_SEC. Only when that window closes is the
 *               session disarmed for real. One Lovense Remote app carries
 *               all of a person's toys, so this is per person, not per toy.
 *
 * The suspended state exists because iOS suspends background apps. Over a
 * multi-hour session a few minutes of silence is normal, and ending the
 * session on the first gap would mean re-running `/tease` over and over.
 */
export type SessionState = 'armed' | 'suspended';

export interface Session {
  uid: string;
  guildId: string;
  /** Discord user who owns the toys. Their own messages never trigger them. */
  ownerId: string;
  /** Who ran `/tease`. */
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
  /** Triggers dropped: app offline, session suspended, or focus not connected. */
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
 * A command that moves nothing: Stop, or every motor at level 0 (the probe,
 * /test). These are the only commands allowed through a /stop lockout.
 */
export function isZeroAction(action: ToyAction): boolean {
  switch (action.kind) {
    case 'function':
      return (
        action.action === 'Stop' ||
        action.action.split(',').every((part) => Number(part.split(':')[1]) === 0)
      );
    case 'pattern':
      return action.strength.split(';').every((s) => Number(s) === 0);
    case 'preset':
      return false;
  }
}

/** After /stop, nothing that moves may start until `until`. */
export interface Lockout {
  until: number;
  /** Who ran /stop. */
  by: string;
}

export class StopLockoutError extends Error {
  constructor(readonly lockout: Lockout) {
    super('Stopped — nothing new can start until the /stop timer runs out');
    this.name = 'StopLockoutError';
  }
}

export type TestResult = { ok: true } | { ok: false; code: number | undefined; message: string };

/**
 * Whether a due reminder should be posted. The one case it is skipped: the
 * session was already paused when this interval began, so the whole interval
 * was spent unreachable and the reminder would only repeat what the pinned
 * board already shows.
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
  /** Read-through cache of the persisted /stop lockout, per guild. */
  private lockouts = new Map<string, Lockout | null>();
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

  /**
   * Start tease for a person. Already on: only the strength and length given
   * change, and the count, elapsed time and reminder schedule carry on — so
   * running /tease again adjusts rather than restarts.
   */
  arm(params: {
    uid: string;
    guildId: string;
    ownerId: string;
    startedBy?: string;
    intensityPercent?: number;
    durationSec?: number;
  }): { session: Session; created: boolean } {
    const key = this.key(params.guildId, params.ownerId);
    const existing = this.sessions.get(key);

    if (existing) {
      if (params.intensityPercent !== undefined) existing.intensityPercent = params.intensityPercent;
      if (params.durationSec !== undefined) existing.durationSec = params.durationSec;
      log.info(
        `Tease retuned for ${params.ownerId}: ${existing.intensityPercent}% / ${existing.durationSec}s`,
      );
      return { session: existing, created: false };
    }

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
      lastReminderAt: now,
      reminderTimer: null,
      graceTimer: null,
      triggerCount: 0,
      missedCount: 0,
    };

    this.sessions.set(key, session);
    this.scheduleReminder(session);
    log.info(`Tease on for ${params.ownerId} (started by ${session.startedBy})`);
    return { session, created: true };
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

    if (session.reminderTimer) clearTimeout(session.reminderTimer);
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.reminderTimer = null;
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

  /** Turn tease off and send a Stop to every toy. Always safe to call. */
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
      log.info(`Tease off for ${ownerId} (${session.triggerCount} triggers)`);
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

  private lockoutKey(guildId: string): string {
    return `stop_lockout:${guildId}`;
  }

  /**
   * The /stop lockout in force for this guild, or null. Persisted, so a
   * restart part-way through can't cut it short.
   */
  lockout(guildId: string, now = Date.now()): Lockout | null {
    if (!this.lockouts.has(guildId)) {
      const raw = store.getSetting(this.lockoutKey(guildId));
      let parsed: Lockout | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as Lockout) : null;
      } catch {
        parsed = null;
      }
      this.lockouts.set(guildId, parsed);
    }
    const current = this.lockouts.get(guildId) ?? null;
    return current && current.until > now ? current : null;
  }

  /**
   * Block anything that moves for `ms` from now, replacing any lockout
   * already running — so a later /stop can shorten one as well as extend
   * it, and `ms` of 0 lifts it. Either person can; the agreement about when
   * that is OK lives between them, not in the bot.
   */
  lockOut(guildId: string, ms: number, by: string, now = Date.now()): Lockout | null {
    if (ms <= 0) {
      if (this.lockout(guildId, now)) log.warn(`Stop lockout for guild ${guildId} lifted by ${by}`);
      this.lockouts.set(guildId, null);
      store.deleteSetting(this.lockoutKey(guildId));
      return null;
    }

    const next: Lockout = { until: now + ms, by };
    this.lockouts.set(guildId, next);
    store.setSetting(this.lockoutKey(guildId), JSON.stringify(next));
    log.warn(`Stop lockout for guild ${guildId} until ${new Date(next.until).toISOString()}`);
    return next;
  }

  /**
   * A Discord message qualified as a trigger. The return value says what
   * happened, so the caller can log it without spamming the channel.
   */
  async handleTrigger(
    session: Session,
    source: string,
  ): Promise<'sent' | 'throttled' | 'suspended' | 'offline' | 'stopped' | 'unfocused' | 'failed'> {
    // /stop turns tease off, so this is a backstop, not the main guard.
    if (this.lockout(session.guildId)) {
      session.missedCount += 1;
      return 'stopped';
    }

    if (session.state === 'suspended') {
      session.missedCount += 1;
      return 'suspended';
    }

    // Skip known-offline apps before spending a rate-limit slot or an API
    // call. The presence sweep will suspend the session shortly; this avoids
    // doomed requests in the meantime.
    const status = presence.statusForUid(session.uid);
    if (status?.presence === 'offline') {
      session.missedCount += 1;
      log.debug(`Trigger skipped for ${session.ownerId}: app offline`);
      return 'offline';
    }

    // Which toys, decided now from the latest check-in: a toy that connected
    // since tease started is included, a focused toy that dropped is not.
    const link = store.getByUid(session.uid);
    const targets = link
      ? focusTargets(link, getFocus(session.guildId, session.ownerId))
      : ({ ok: true, toyIds: undefined, label: '' } as const);
    if (!targets.ok) {
      session.missedCount += 1;
      log.debug(`Trigger skipped for ${session.ownerId}: ${targets.error}`);
      return 'unfocused';
    }

    // One slot per message, however many toys it buzzes.
    const gate = session.limiter.tryAcquire();
    if (!gate.allowed) {
      log.debug(`Trigger throttled (${gate.reason}) for ${session.ownerId}`);
      return 'throttled';
    }

    const action = actions.vibrate(session.intensityPercent, session.durationSec);
    try {
      for (const toyId of targets.toyIds ?? [undefined]) {
        await this.sendWithWakeRetry(session.uid, action, source, toyId);
      }
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
    toyId?: string,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= config.WAKE_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.sendNow(uid, action, attempt === 0 ? source : `${source}:retry${attempt}`, {
          deferOfflineReport: true,
          toyId,
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
    // would suspend the session, only for the retry to land a
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
    return (await this.test(uid, { source: 'probe' })).ok;
  }

  /**
   * Send Vibrate:0 — nothing moves — and report what Lovense said. The probe
   * uses it for every toy at once; /test for one toy at a time. Either way
   * the result feeds presence, so a successful /test also ends an outage.
   */
  async test(uid: string, opts: { toyId?: string; source?: string } = {}): Promise<TestResult> {
    try {
      await this.sendWithWakeRetry(uid, actions.probe(), opts.source ?? 'test', opts.toyId);
      return { ok: true };
    } catch (err) {
      const code = err instanceof LovenseError ? err.code : undefined;
      if (code !== undefined) presence.markReportedOffline(uid, code);
      else presence.noteFailed(uid, undefined);
      return { ok: false, code, message: (err as Error).message };
    }
  }

  /**
   * The one place commands leave the process. Manual commands go through here
   * too, so they get the same logging and error mapping.
   *
   * `toyId` addresses one toy; without it, every toy on the link.
   */
  async sendNow(
    uid: string,
    action: ToyAction,
    source: string,
    opts: { deferOfflineReport?: boolean; toyId?: string } = {},
  ): Promise<void> {
    const description = describeAction(action) + (opts.toyId ? ` [toy ${opts.toyId}]` : '');
    const isProbe = source.startsWith('probe');

    // The /stop lockout is enforced here, at the one choke point, so no
    // command — current or future — can move a toy while it lasts.
    if (!isZeroAction(action)) {
      const guildId = store.getByUid(uid)?.guildId;
      const lock = guildId ? this.lockout(guildId) : null;
      if (lock) {
        store.logCommand({ uid, description, source, ok: false, error: 'blocked: /stop lockout' });
        throw new StopLockoutError(lock);
      }
    }
    const previousRunningUntil = this.runningUntil.get(uid);

    // Marked before the request goes out, so a probe can't slip in while
    // this one is still in flight. Tracked per link, not per toy, because
    // the probe goes to every toy: stopping one toy says nothing about the
    // others, so only a Stop to all of them clears it.
    if (action.kind === 'function' && action.action === 'Stop') {
      if (!opts.toyId) this.runningUntil.delete(uid);
    } else {
      this.runningUntil.set(
        uid,
        Math.max(previousRunningUntil ?? 0, Date.now() + action.timeSec * 1000),
      );
    }

    try {
      await lovense.send(uid, action, opts.toyId);
      store.logCommand({ uid, description, source, ok: true });
      // Any 200 is proof the path works, whatever the command was.
      presence.noteReachable(uid);
    } catch (err) {
      // It never reached the toy, so nothing new is running on it.
      if (previousRunningUntil === undefined) this.runningUntil.delete(uid);
      else this.runningUntil.set(uid, previousRunningUntil);

      const message = err instanceof LovenseError ? err.message : (err as Error).message;
      store.logCommand({ uid, description, source, ok: false, error: message });
      // Recorded so the status board can show the last failure and what it
      // means. Teardown Stops to a toy that is already gone don't count.
      if (!TEARDOWN_SOURCES.includes(source)) {
        presence.noteFailed(uid, err instanceof LovenseError ? err.code : undefined);
      }
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
