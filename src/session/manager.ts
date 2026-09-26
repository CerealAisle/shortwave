import { config } from '../config';
import { log } from '../logger';
import { LovenseError, lovense } from '../lovense/client';
import * as actions from '../lovense/actions';
import { describeAction, type ToyAction } from '../lovense/types';
import { store } from '../store/store';
import { presence } from './presence';
import { RateLimiter } from './rate-limiter';

/**
 * `armed`     - triggers fire.
 * `suspended` - the toy went offline; triggers are ignored, but the session
 *               is intact and resumes by itself if the toy comes back inside
 *               OFFLINE_GRACE_SEC. Only when that window closes is the
 *               session disarmed for real.
 *
 * The suspended state exists because iOS suspends background apps. Over a
 * multi-hour session a few minutes of silence is normal, and ending the
 * session on the first gap would mean re-running `/on` over and over.
 */
export type SessionState = 'armed' | 'suspended';

export interface Session {
  uid: string;
  guildId: string;
  /** Discord user who owns the toy. Their own messages never trigger it. */
  ownerId: string;
  channelId: string;
  state: SessionState;
  intensityPercent: number;
  durationSec: number;
  armedAt: number;
  expiresAt: number;
  suspendedAt: number | null;
  limiter: RateLimiter;
  timer: NodeJS.Timeout;
  graceTimer: NodeJS.Timeout | null;
  triggerCount: number;
  /** Triggers dropped because the toy was offline or the session suspended. */
  missedCount: number;
}

export type SessionEventType = 'expired' | 'suspended' | 'resumed' | 'grace-expired';

export type SessionEventListener = (payload: {
  type: SessionEventType;
  session: Session;
}) => void;

export type ErrorListener = (payload: { session: Session; error: Error }) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Owns all sessions and is the only path to the toy.
 *
 * Deliberate design choices:
 *  - Session state lives in memory only. A restart comes back disarmed.
 *    Failing closed is the only safe default here.
 *  - Every session has an expiry timer, so a forgotten session turns itself
 *    off instead of running indefinitely.
 *  - `sendNow` is the single choke point, so the intensity cap, the rate
 *    limit and the audit log can't be bypassed by a new command.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
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

  arm(params: {
    uid: string;
    guildId: string;
    ownerId: string;
    channelId: string;
    intensityPercent?: number;
    durationSec?: number;
    timeoutMinutes?: number;
  }): Session {
    // Re-arming replaces the old session rather than stacking on it.
    this.disarm(params.guildId, params.ownerId, { silent: true });

    const timeoutMs = (params.timeoutMinutes ?? config.SESSION_TIMEOUT_MINUTES) * 60_000;
    const now = Date.now();

    const session: Session = {
      uid: params.uid,
      guildId: params.guildId,
      ownerId: params.ownerId,
      channelId: params.channelId,
      state: 'armed',
      intensityPercent: params.intensityPercent ?? config.BUZZ_INTENSITY_PERCENT,
      durationSec: params.durationSec ?? config.BUZZ_DURATION_SEC,
      armedAt: now,
      expiresAt: now + timeoutMs,
      suspendedAt: null,
      limiter: new RateLimiter(config.MIN_COMMAND_INTERVAL_MS, config.MAX_COMMANDS_PER_MINUTE),
      triggerCount: 0,
      missedCount: 0,
      timer: setTimeout(() => this.handleExpiry(params.guildId, params.ownerId), timeoutMs),
      graceTimer: null,
    };

    this.sessions.set(this.key(params.guildId, params.ownerId), session);
    log.info(
      `Session armed for ${params.ownerId} (expires in ${Math.round(timeoutMs / 60_000)}m)`,
    );
    return session;
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

    clearTimeout(session.timer);
    if (session.graceTimer) clearTimeout(session.graceTimer);
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
      clearTimeout(s.timer);
      if (s.graceTimer) clearTimeout(s.graceTimer);
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
        await this.sendNow(uid, action, attempt === 0 ? source : `${source}:retry${attempt}`);
        return;
      } catch (err) {
        lastError = err;
        const retryable = err instanceof LovenseError ? err.retryable : false;
        if (!retryable || attempt === config.WAKE_RETRY_ATTEMPTS) break;
        await sleep(config.WAKE_RETRY_DELAY_MS * (attempt + 1));
      }
    }

    throw lastError;
  }

  /**
   * The one place commands leave the process. Manual commands go through here
   * too, so they get the same logging and error mapping.
   */
  async sendNow(uid: string, action: ToyAction, source: string): Promise<void> {
    const description = describeAction(action);
    try {
      await lovense.send(uid, action);
      store.logCommand({ uid, description, source, ok: true });
    } catch (err) {
      const message = err instanceof LovenseError ? err.message : (err as Error).message;
      store.logCommand({ uid, description, source, ok: false, error: message });
      log.warn(`Lovense command failed (${source}): ${message}`);

      // 507 means Lovense has no live connection to the app. Tell the
      // presence monitor at once rather than letting every later message
      // fail the same way until the heartbeat timeout expires. The transition
      // that follows suspends the session, and the next callback resumes it.
      // Skipped for 'suspend'/'disarm'/'shutdown', which are already
      // teardown paths and would otherwise re-enter suspension.
      if (
        err instanceof LovenseError &&
        err.code === 507 &&
        !['suspend', 'disarm', 'shutdown', 'stop-all'].includes(source)
      ) {
        presence.markReportedOffline(uid);
      }

      throw err;
    }
  }

  private handleExpiry(guildId: string, ownerId: string): void {
    const session = this.sessions.get(this.key(guildId, ownerId));
    if (!session) return;
    this.disarm(guildId, ownerId, { silent: true });
    log.info(`Session expired for ${ownerId}`);
    this.emit('expired', session);
  }

  /** Called on shutdown so nothing is left running on the toy. */
  async shutdown(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const s of all) {
      clearTimeout(s.timer);
      if (s.graceTimer) clearTimeout(s.graceTimer);
    }
    this.sessions.clear();
    await Promise.allSettled(
      all.map((s) => this.sendNow(s.uid, actions.stop(), 'shutdown')),
    );
  }
}

export const sessions = new SessionManager();
