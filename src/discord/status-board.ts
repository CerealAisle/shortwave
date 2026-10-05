import {
  ChannelType,
  DiscordAPIError,
  RESTJSONErrorCodes,
  type Client,
  type Message,
  type TextChannel,
} from 'discord.js';
import { config } from '../config';
import { log } from '../logger';
import { toyLabel } from '../lovense/toys';
import { focusLabel, type Focus } from '../session/focus';
import type { Session } from '../session/manager';
import { diagnose, isToyConnected, type PresenceStatus } from '../session/presence';
import type { ToyLink } from '../store/store';
import { explainCode } from '../lovense/client';
import { text } from '../text';
import { describeTease } from './toy-option';

/** Minimum gap between edits. A flapping toy coalesces into one edit. */
const MIN_EDIT_GAP_MS = 15_000;
/** How often to check for changes. The edit gap still applies. */
const CHECK_EVERY_MS = 5_000;
/** Discord's hard limit on message content. */
const MAX_CONTENT = 2000;

export interface BoardRow {
  link: ToyLink;
  status: PresenceStatus;
  /** When the link entered its current presence state, if known. */
  since: number | null;
  session: Session | undefined;
  /** Which of their toys commands reach. */
  focus: Focus;
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function reachability(row: BoardRow): string {
  const { status, since } = row;
  const result = status.lastResult;

  switch (status.presence) {
    case 'online': {
      if (result?.ok) return text.board.reachableProbed(result.at);
      // Online on the strength of check-ins, while the last command failed.
      const failed =
        result && !result.ok
          ? text.board.lastFailed(result.at, explainCode(result.code), result.code)
          : '';
      return text.board.reachableHeartbeat + failed;
    }
    case 'offline': {
      const why = diagnose(status);
      if (!why) return text.board.unreachableSilent(since);
      return (
        text.board.unreachable(since, why.meaning, why.code) +
        (why.hint ? `\n> ${text.board.hint(why.hint)}` : '')
      );
    }
    case 'unknown':
      return row.link.lastSeen === null ? text.board.notScanned : text.board.notChecked;
  }
}

function teaseText(session: Session | undefined, now: number): string {
  if (!session) return text.board.teaseOff;
  const running = formatDuration(now - session.armedAt);
  return session.state === 'suspended'
    ? text.board.teasePaused(describeTease(session), running)
    : text.board.teaseOn(describeTease(session), running);
}

/**
 * The body of the board, without the "updated" header. Kept separate so the
 * board can tell whether anything actually changed: the header timestamp
 * always would.
 */
export function renderBoardBody(
  rows: BoardRow[],
  now = Date.now(),
  banner: string | null = null,
): string {
  const top = banner ? `${banner}\n\n` : '';
  if (rows.length === 0) return `${top}${text.board.noLinks}`;

  return top + rows
    .map((row) => {
      const { link, status, session, focus } = row;
      const dot = { online: '🟢', offline: '🔴', unknown: '⚪' }[status.presence];

      // One line per toy. A toy the app says is disconnected gets its own
      // mark: the phone can be fine while one toy's Bluetooth has dropped.
      const toys = link.toys.map((t) => {
        const connected = isToyConnected(t);
        const focused = focus.kind === 'toy' && focus.id === t.id;
        return text.board.toyLine(connected ? dot : '⚫', toyLabel(t), t.battery, connected, focused);
      });
      if (toys.length === 0) toys.push(text.board.noToys(dot));

      return [
        text.board.person(link.displayName, link.discordUserId),
        ...toys.map((t) => `> ${t}`),
        `> ${text.board.focusAndTease(focusLabel(focus, link), teaseText(session, now))}`,
        `> ${reachability(row)}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function renderBoard(body: string, now = Date.now()): string {
  const content = `${text.board.header(now)}\n\n${body}`;
  return content.length <= MAX_CONTENT ? content : `${content.slice(0, MAX_CONTENT - 1)}…`;
}

/**
 * One message, edited in place. It starts in the command channel; /status
 * moves it to wherever it is run. Its location is persisted, so a restart
 * edits the same post instead of adding another; if the post has been
 * deleted, a fresh one is posted and pinned in the same channel.
 *
 * Updates are poll-and-diff: every few seconds the board is rendered and only
 * edited if the body changed, and never more than once per MIN_EDIT_GAP_MS. `requestUpdate()` brings that forward
 * for events worth showing promptly, without breaking the minimum gap.
 */
/** Where the board lives. Saved, so a restart keeps updating the same post. */
interface BoardLocation {
  channelId: string;
  messageId: string;
}

const LOCATION_KEY = 'status_board';

export class StatusBoard {
  private client: Client | null = null;
  private message: Message | null = null;
  private lastBody: string | null = null;
  private lastEditAt = 0;
  /** Whether pinning worked the last time the board was posted. */
  private lastPinOk = false;
  private interval: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  /** Serialises refreshes and reposts, so they never race to post twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rows: () => BoardRow[],
    /** A line above everything else, e.g. an active /stop lockout. */
    private readonly banner: () => string | null,
    private readonly settings: {
      get(key: string): string | null;
      set(key: string, value: string): void;
    },
  ) {}

  private location(): BoardLocation | null {
    const raw = this.settings.get(LOCATION_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as BoardLocation;
      } catch {
        return null;
      }
    }
    // Saved before the board could move: it was in the command channel.
    const legacy = this.settings.get(`status_board_message:${config.COMMAND_CHANNEL_ID}`);
    return legacy ? { channelId: config.COMMAND_CHANNEL_ID, messageId: legacy } : null;
  }

  private saveLocation(message: Message): void {
    this.settings.set(LOCATION_KEY, JSON.stringify({ channelId: message.channelId, messageId: message.id }));
  }

  start(client: Client): void {
    this.client = client;
    this.interval = setInterval(() => this.enqueue(() => this.refresh()), CHECK_EVERY_MS);
    this.interval.unref?.();
    this.enqueue(() => this.refresh());
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.pending) clearTimeout(this.pending);
    this.interval = null;
    this.pending = null;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Something changed; show it as soon as the edit gap allows. */
  requestUpdate(): void {
    if (!this.client || this.pending) return;
    const wait = Math.max(0, this.lastEditAt + MIN_EDIT_GAP_MS - Date.now());
    this.pending = setTimeout(() => {
      this.pending = null;
      this.enqueue(() => this.refresh());
    }, wait);
    this.pending.unref?.();
  }

  /**
   * Delete the board and post a fresh one in `channelId`, pinned. From then
   * on that copy is the one kept up to date — this is what /status does.
   * Resolves to whether pinning worked.
   */
  repost(channelId: string): Promise<{ pinned: boolean }> {
    return this.enqueue(async () => {
      const old = this.message ?? (await this.fetchSaved());
      if (old) await old.delete().catch(() => {});
      this.message = null;
      const posted = await this.post(channelId);
      if (!posted) throw new Error(`${channelId} is not a text channel`);
      return { pinned: this.lastPinOk };
    });
  }

  private async refresh(): Promise<void> {
    if (!this.client) return;
    if (Date.now() - this.lastEditAt < MIN_EDIT_GAP_MS) return;

    try {
      const body = renderBoardBody(this.rows(), Date.now(), this.banner());
      const message = await this.ensureMessage();
      if (!message || body === this.lastBody) return;

      await message.edit({ content: renderBoard(body), allowedMentions: { parse: [] } });
      this.lastBody = body;
      this.lastEditAt = Date.now();
    } catch (err) {
      if (isUnknownMessage(err)) {
        // Deleted while we were running. Post a fresh one next time.
        log.warn('Status board message was deleted; it will be reposted');
        this.message = null;
        this.lastBody = null;
      } else {
        log.warn(`Status board update failed: ${(err as Error).message}`);
      }
    }
  }

  private async textChannel(channelId: string): Promise<TextChannel | null> {
    const channel = await this.client!.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) {
      log.warn(`Status board: ${channelId} is not a text channel`);
      return null;
    }
    return channel as TextChannel;
  }

  /** The saved board, or null if there isn't one or it has been deleted. */
  private async fetchSaved(): Promise<Message | null> {
    const saved = this.location();
    if (!saved) return null;
    const channel = await this.textChannel(saved.channelId);
    if (!channel) return null;
    try {
      return await channel.messages.fetch(saved.messageId);
    } catch (err) {
      // Anything other than "it's gone" (a network blip, a Discord outage)
      // must not lead to a duplicate. Try again on the next refresh.
      if (!isUnknownMessage(err)) throw err;
      log.info('Status board message is gone; posting a new one');
      return null;
    }
  }

  private async ensureMessage(): Promise<Message | null> {
    if (this.message) return this.message;
    this.message = await this.fetchSaved();
    if (this.message) return this.message;
    // Nothing saved, or deleted: post where it was, else the command channel.
    return this.post(this.location()?.channelId ?? config.COMMAND_CHANNEL_ID);
  }

  private async post(channelId: string): Promise<Message | null> {
    const channel = await this.textChannel(channelId);
    if (!channel) return null;

    const body = renderBoardBody(this.rows(), Date.now(), this.banner());
    const posted = await channel.send({ content: renderBoard(body), allowedMentions: { parse: [] } });
    this.saveLocation(posted);
    this.message = posted;
    this.lastBody = body;
    this.lastEditAt = Date.now();

    try {
      await posted.pin();
      this.lastPinOk = true;
    } catch (err) {
      this.lastPinOk = false;
      log.warn(
        `Could not pin the status board (${(err as Error).message}). ` +
          'Give the bot the Pin Messages permission in that channel.',
      );
    }

    log.info(`Status board posted as ${posted.id} in ${channelId}`);
    return posted;
  }
}

function isUnknownMessage(err: unknown): boolean {
  return err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage;
}
