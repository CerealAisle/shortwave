import { ChannelType, type Client, type Message, type TextChannel } from 'discord.js';
import { config } from '../config';
import { log } from '../logger';
import { explainCode } from '../lovense/client';
import { focusLabel, getFocus } from '../session/focus';
import type { Session, TriggerOutcome } from '../session/manager';
import { store } from '../store/store';
import { text } from '../text';

/** Lines kept. Older ones are counted, not shown. */
export const MAX_LINES = 12;
/** Gap between edits, so a burst of messages is one edit. */
const EDIT_GAP_MS = 2_000;
/** Discord's hard limit on message content. */
const MAX_CONTENT = 2000;

export interface TriggerEntry {
  at: number;
  authorId: string;
  messageUrl: string;
  outcome: TriggerOutcome;
  /** The buzz number, when it was sent. */
  buzz: number;
}

/** One line for a message that came in during tease. */
export function renderEntry(e: TriggerEntry): string {
  const from = text.teaseLog.from(e.at, e.authorId, e.messageUrl);
  const o = e.outcome;
  switch (o.result) {
    case 'sent':
      return text.teaseLog.sent(from, o.intensityPercent, o.durationSec, e.buzz);
    case 'throttled':
      return o.throttle === 'quota'
        ? text.teaseLog.throttledQuota(from, config.MAX_COMMANDS_PER_MINUTE)
        : text.teaseLog.throttledGap(from, config.MIN_COMMAND_INTERVAL_MS / 1000);
    case 'suspended':
      return text.teaseLog.paused(from);
    case 'offline':
      return text.teaseLog.offline(from, explainCode(o.code), o.code);
    case 'stopped':
      return text.teaseLog.stopped(from);
    case 'unfocused':
      return text.teaseLog.unfocused(from, o.focusError ?? '');
    case 'failed':
      return text.teaseLog.failed(from, explainCode(o.code), o.code);
  }
}

interface LogState {
  session: Session;
  lines: string[];
  /** Lines dropped off the top. */
  dropped: number;
  endedAt: number | null;
  message: Message | null;
  timer: NodeJS.Timeout | null;
  lastEditAt: number;
  focus: string;
}

export function renderLog(state: Pick<LogState, 'session' | 'lines' | 'dropped' | 'endedAt' | 'focus'>): string {
  const s = state.session;
  const notSent = s.missedCount;
  const head = [
    text.teaseLog.header(s.ownerId, s.intensityPercent, s.durationSec, state.focus),
    state.endedAt !== null
      ? text.teaseLog.ended(s.triggerCount, s.throttledCount, notSent, state.endedAt)
      : text.teaseLog.counts(s.triggerCount, s.throttledCount, notSent, s.armedAt),
  ];
  const body = [...(state.dropped > 0 ? [text.teaseLog.older(state.dropped)] : []), ...state.lines];
  let content = [...head, '', ...body].join('\n');
  // Drop the oldest lines rather than cutting the newest off.
  let lines = [...state.lines];
  let dropped = state.dropped;
  while (content.length > MAX_CONTENT && lines.length > 1) {
    lines = lines.slice(1);
    dropped += 1;
    content = [...head, '', text.teaseLog.older(dropped), ...lines].join('\n');
  }
  return content.slice(0, MAX_CONTENT);
}

/**
 * The per-session tease log in the command channel. One message per tease
 * session, posted on the first thing worth logging and edited as messages
 * come in, so it reads as a live feed without adding a post per buzz.
 *
 * Discord can't show a reply to a chat message to only one person, so this
 * is the private view: in the command channel, not under her messages.
 * Mentions in it never ping.
 */
export class TeaseLog {
  private client: Client | null = null;
  private logs = new Map<Session, LogState>();
  /** Serialises posts and edits. */
  private queue: Promise<unknown> = Promise.resolve();

  start(client: Client): void {
    this.client = client;
  }

  /** A message came in while tease was on. */
  trigger(session: Session, entry: Omit<TriggerEntry, 'buzz'>): void {
    this.add(session, renderEntry({ ...entry, buzz: session.triggerCount }));
  }

  /** Something between messages: paused, resumed, check-ins stopped… */
  note(session: Session, what: string, at = Date.now()): void {
    this.add(session, text.teaseLog.note(at, what));
  }

  /** Tease is off. The log gets its final edit and is left as a record. */
  end(session: Session): void {
    const state = this.logs.get(session);
    if (!state) return;
    state.endedAt = Date.now();
    this.schedule(state, 0);
    this.logs.delete(session);
  }

  private add(session: Session, line: string): void {
    let state = this.logs.get(session);
    if (!state) {
      state = {
        session,
        lines: [],
        dropped: 0,
        endedAt: null,
        message: null,
        timer: null,
        lastEditAt: 0,
        focus: currentFocus(session),
      };
      this.logs.set(session, state);
    }
    state.lines.push(line);
    if (state.lines.length > MAX_LINES) {
      state.dropped += state.lines.length - MAX_LINES;
      state.lines = state.lines.slice(-MAX_LINES);
    }
    state.focus = currentFocus(session);
    this.schedule(state, Math.max(0, state.lastEditAt + EDIT_GAP_MS - Date.now()));
  }

  private schedule(state: LogState, wait: number): void {
    if (state.timer) {
      if (wait > 0) return;
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      this.queue = this.queue.then(() => this.flush(state)).catch(() => {});
    }, wait);
    state.timer.unref?.();
  }

  private async flush(state: LogState): Promise<void> {
    if (!this.client || state.lines.length === 0) return;
    const content = renderLog(state);
    try {
      if (state.message) {
        await state.message.edit({ content, allowedMentions: { parse: [] } });
      } else {
        const channel = await this.client.channels.fetch(config.COMMAND_CHANNEL_ID);
        if (channel?.type !== ChannelType.GuildText) return;
        state.message = await (channel as TextChannel).send({
          content,
          allowedMentions: { parse: [] },
        });
      }
      state.lastEditAt = Date.now();
    } catch (err) {
      // Deleted, or a Discord hiccup: start a fresh message next time rather
      // than losing the log.
      log.warn(`Tease log update failed: ${(err as Error).message}`);
      state.message = null;
    }
  }
}

function currentFocus(session: Session): string {
  return focusLabel(getFocus(session.guildId, session.ownerId), store.getByUid(session.uid));
}

export const teaseLog = new TeaseLog();
