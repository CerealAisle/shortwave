import { config } from '../config';
import { log } from '../logger';
import { LovenseError, lovense } from '../lovense/client';
import * as actions from '../lovense/actions';
import { describeAction, type ToyAction } from '../lovense/types';
import { store } from '../store/store';
import { presence } from './presence';
import { RateLimiter } from './rate-limiter';

/**
 * A session is tease mode for one person: while it exists, messages from
 * anyone else in the main channel buzz the toys it lists.
 *
 * Two levels, because two things vary at different grains:
 *  - The session (per guild + owner) holds what is true of the phone:
 *    paused or not, the grace window, the rate limit and the reminder. One
 *    Lovense Remote app carries all of a person's toys, so when it drops,
 *    they all drop together.
 *  - Each ToyTease (per toy within it) holds what can differ between toys:
 *    strength, length, who started it, and its counts.
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

export interface ToyTease {
  toyId: string;
  /** Label at the time tease started, for messages if the toy later vanishes. */
  toyName: string;
  /** Who ran `/tease` for this toy. Often not the owner. */
  startedBy: string;
  intensityPercent: number;
  durationSec: number;
  armedAt: number;
  triggerCount: number;
  /** Triggers dropped because the toy was offline or the session suspended. */
  missedCount: number;
}

export interface Session {
  uid: string;
  guildId: string;
  /** Discord user who owns the toys. Their own messages never trigger them. */
  ownerId: string;
  state: SessionState;
  /** When the first toy in this session started. */
  armedAt: number;
  suspendedAt: number | null;
  limiter: RateLimiter;
  /** When the last reminder was due, posted or skipped. Starts at armedAt. */
  lastReminderAt: number;
  reminderTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  /** Keyed by toy ID, in the order tease started on them. Never empty. */
  toys: Map<string, ToyTease>;
}

/** Buzzes and misses summed over every toy in the session. */
export function sessionTotals(session: Session): { buzzes: number; missed: number } {
  let buzzes = 0;
  let missed = 0;
  for (const t of session.toys.values()) {
    buzzes += t.triggerCount;
    missed += t.missedCount;
  }
  return { buzzes, missed };
}

export interface ToyRef {
  id: string;
  name: string;
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
 * Which commands a trigger turns into. When every teased toy shares one
 * strength and length and they are all of the link's toys, that is a single
 * command with no toy ID — exactly what a one-toy setup has always sent.
 * Otherwise one command per toy, each at its own settings.
 */
export function planTriggerSends(
  teases: ToyTease[],
  linkToyIds: string[],
): { toyId: string | undefined; teases: ToyTease[] }[] {
  const first = teases[0];
  if (!first) return [];

  const uniform = teases.every(
    (t) => t.intensityPercent === first.intensityPercent && t.durationSec === first.durationSec,
  );
  const teased = new Set(teases.map((t) => t.toyId));
  const coversLink =
    linkToyIds.length > 0 &&
    linkToyIds.length === teased.size &&
    linkToyIds.every((id) => teased.has(id));

  if (uniform && coversLink) return [{ toyId: undefined, teases }];
  return teases.map((t) => ({ toyId: t.toyId, teases: [t] }));
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

  /**
   * Start tease on some of a person's toys. Toys already teasing are retuned
   * in place — only the strength and length given change, and their counts
   * carry on — so running /tease again adjusts rather than restarts.
   */
  arm(params: {
    uid: string;
    guildId: string;
    ownerId: string;
    toys: ToyRef[];
    startedBy?: string;
    intensityPercent?: number;
    durationSec?: number;
  }): { session: Session; added: ToyTease[]; updated: ToyTease[] } {
    if (params.toys.length === 0) throw new Error('arm needs at least one toy');

    const now = Date.now();
    const key = this.key(params.guildId, params.ownerId);
    let session = this.sessions.get(key);

    if (!session) {
      session = {
        uid: params.uid,
        guildId: params.guildId,
        ownerId: params.ownerId,
        state: 'armed',
        armedAt: now,
        suspendedAt: null,
        limiter: new RateLimiter(config.MIN_COMMAND_INTERVAL_MS, config.MAX_COMMANDS_PER_MINUTE),
        lastReminderAt: now,
        reminderTimer: null,
        graceTimer: null,
        toys: new Map(),
      };
      this.sessions.set(key, session);
      this.scheduleReminder(session);
    }

    const added: ToyTease[] = [];
    const updated: ToyTease[] = [];

    for (const toy of params.toys) {
      const existing = session.toys.get(toy.id);
      if (existing) {
        if (params.intensityPercent !== undefined) existing.intensityPercent = params.intensityPercent;
        if (params.durationSec !== undefined) existing.durationSec = params.durationSec;
        updated.push(existing);
        continue;
      }
      const tease: ToyTease = {
        toyId: toy.id,
        toyName: toy.name,
        startedBy: params.startedBy ?? params.ownerId,
        intensityPercent: params.intensityPercent ?? config.BUZZ_INTENSITY_PERCENT,
        durationSec: params.durationSec ?? config.BUZZ_DURATION_SEC,
        armedAt: now,
        triggerCount: 0,
        missedCount: 0,
      };
      session.toys.set(toy.id, tease);
      added.push(tease);
    }

    log.info(
      `Tease for ${params.ownerId}: ${added.length} toy(s) on, ${updated.length} retuned ` +
        `(by ${params.startedBy ?? params.ownerId})`,
    );
    return { session, added, updated };
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

  /**
   * Turn tease off and send a Stop. Always safe to call, armed or not.
   *
   * With `toyIds`, only those toys stop and the rest keep teasing; the
   * session ends when its last toy does. Without, every toy stops.
   */
  disarm(
    guildId: string,
    ownerId: string,
    opts: { silent?: boolean; toyIds?: string[] } = {},
  ): { session: Session; removed: ToyTease[]; ended: boolean } | undefined {
    const key = this.key(guildId, ownerId);
    const session = this.sessions.get(key);
    if (!session) return undefined;

    const all = opts.toyIds === undefined;
    const removed: ToyTease[] = [];
    for (const [id, tease] of session.toys) {
      if (all || opts.toyIds!.includes(id)) removed.push(tease);
    }
    for (const t of removed) session.toys.delete(t.toyId);

    const ended = session.toys.size === 0;
    if (ended) {
      this.clearTimers(session);
      this.sessions.delete(key);
    }

    if (!opts.silent && removed.length > 0) {
      log.info(`Tease off for ${ownerId}: ${removed.length} toy(s)${ended ? ', session ended' : ''}`);
    }

    const onStopFailed = (err: Error) => log.warn(`Stop after disarm failed: ${err.message}`);
    if (all) {
      void this.sendNow(session.uid, actions.stop(), 'disarm').catch(onStopFailed);
    } else {
      for (const t of removed) {
        void this.sendNow(session.uid, actions.stop(), 'disarm', { toyId: t.toyId }).catch(
          onStopFailed,
        );
      }
    }

    return { session, removed, ended };
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
    const teases = [...session.toys.values()];
    const missAll = () => teases.forEach((t) => (t.missedCount += 1));

    if (session.state === 'suspended') {
      missAll();
      return 'suspended';
    }

    // Skip known-offline toys before spending a rate-limit slot or an API
    // call. The presence sweep will suspend the session shortly; this avoids
    // doomed requests in the meantime.
    const status = presence.statusForUid(session.uid);
    if (status?.presence === 'offline') {
      missAll();
      log.debug(`Trigger skipped for ${session.ownerId}: toy offline`);
      return 'offline';
    }

    // One slot per message, however many toys it buzzes.
    const gate = session.limiter.tryAcquire();
    if (!gate.allowed) {
      log.debug(`Trigger throttled (${gate.reason}) for ${session.ownerId}`);
      return 'throttled';
    }

    const linkToyIds = store.getByUid(session.uid)?.toys.map((t) => t.id) ?? [];
    const results = await Promise.allSettled(
      planTriggerSends(teases, linkToyIds).map(async ({ toyId, teases: group }) => {
        const action = actions.vibrate(group[0]!.intensityPercent, group[0]!.durationSec);
        try {
          await this.sendWithWakeRetry(session.uid, action, source, toyId);
          group.forEach((t) => (t.triggerCount += 1));
        } catch (err) {
          group.forEach((t) => (t.missedCount += 1));
          throw err;
        }
      }),
    );

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // One notice per trigger, not one per toy.
    if (failures.length > 0) this.emitError(session, failures[0]!.reason as Error);
    return failures.length < results.length ? 'sent' : 'failed';
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
