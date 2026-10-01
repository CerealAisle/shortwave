import {
  ChannelType,
  DiscordAPIError,
  RESTJSONErrorCodes,
  time,
  userMention,
  type Client,
  type Message,
  type TextChannel,
} from 'discord.js';
import { config } from '../config';
import { log } from '../logger';
import type { Session } from '../session/manager';
import { isToyConnected, type PresenceStatus } from '../session/presence';
import type { ToyLink } from '../store/store';

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
}

const rel = (ms: number) => time(Math.floor(ms / 1000), 'R');

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
    case 'online':
      return result?.ok ? `reachable, probed ${rel(result.at)}` : 'reachable (heartbeat)';
    case 'offline': {
      const code = result && !result.ok && result.code ? ` (${result.code})` : '';
      return since ? `unreachable since ${rel(since)}${code}` : `unreachable${code}`;
    }
    case 'unknown':
      return row.link.lastSeen === null ? 'QR not scanned yet' : 'unknown — not probed yet';
  }
}

function sessionLine(session: Session | undefined, now: number): string {
  if (!session) return 'off';
  const label = session.state === 'suspended' ? 'paused (toy offline)' : 'armed';
  const missed = session.missedCount > 0 ? ` · ${session.missedCount} missed` : '';
  return (
    `${label} at ${session.intensityPercent}% / ${session.durationSec}s · ` +
    `${session.triggerCount} buzz(es)${missed} · ${formatDuration(now - session.armedAt)}`
  );
}

/**
 * The body of the board, without the "updated" header. Kept separate so the
 * board can tell whether anything actually changed: the header timestamp
 * always would.
 */
export function renderBoardBody(rows: BoardRow[], now = Date.now()): string {
  if (rows.length === 0) return '*No toys linked. Run `/connect` to link one.*';

  return rows
    .map((row) => {
      const { link, status } = row;
      const dot = { online: '🟢', offline: '🔴', unknown: '⚪' }[status.presence];
      const toys =
        link.toys.length > 0
          ? link.toys.map((t) => {
              const battery = t.battery !== undefined ? ` · ${t.battery}%` : '';
              const mark = isToyConnected(t) ? '' : ' · disconnected';
              return `${dot} ${t.nickName || t.name}${battery}${mark}`;
            })
          : [`${dot} no toys reported`];

      return [
        `**${link.displayName}** · ${userMention(link.discordUserId)}`,
        ...toys.map((t) => `> ${t}`),
        `> ${reachability(row)}`,
        `> session ${sessionLine(row.session, now)}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function renderBoard(body: string, now = Date.now()): string {
  const content = `**Shortwave — live status** · updated ${rel(now)}\n\n${body}`;
  return content.length <= MAX_CONTENT ? content : `${content.slice(0, MAX_CONTENT - 1)}…`;
}

/**
 * One message in the command channel, edited in place. Its ID is persisted,
 * so a restart edits the same post instead of adding another; if the post
 * has been deleted, a fresh one is posted and pinned.
 *
 * Updates are poll-and-diff: every few seconds the board is rendered and only
 * edited if the body changed, and never more than once per MIN_EDIT_GAP_MS. `requestUpdate()` brings that forward
 * for events worth showing promptly, without breaking the minimum gap.
 */
export class StatusBoard {
  private client: Client | null = null;
  private message: Message | null = null;
  private lastBody: string | null = null;
  private lastEditAt = 0;
  private interval: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly rows: () => BoardRow[],
    private readonly settings: {
      get(key: string): string | null;
      set(key: string, value: string): void;
    },
  ) {}

  /** Keyed by channel, so pointing the bot at a new channel starts a new post. */
  private get settingKey(): string {
    return `status_board_message:${config.COMMAND_CHANNEL_ID}`;
  }

  start(client: Client): void {
    this.client = client;
    this.interval = setInterval(() => void this.refresh(), CHECK_EVERY_MS);
    this.interval.unref?.();
    void this.refresh();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.pending) clearTimeout(this.pending);
    this.interval = null;
    this.pending = null;
  }

  /** Something changed; show it as soon as the edit gap allows. */
  requestUpdate(): void {
    if (!this.client || this.pending) return;
    const wait = Math.max(0, this.lastEditAt + MIN_EDIT_GAP_MS - Date.now());
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.refresh();
    }, wait);
    this.pending.unref?.();
  }

  private async refresh(): Promise<void> {
    if (!this.client || this.running) return;
    if (Date.now() - this.lastEditAt < MIN_EDIT_GAP_MS) return;
    this.running = true;

    try {
      const body = renderBoardBody(this.rows());
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
    } finally {
      this.running = false;
    }
  }

  private async ensureMessage(): Promise<Message | null> {
    if (this.message) return this.message;

    const channel = await this.client!.channels.fetch(config.COMMAND_CHANNEL_ID);
    if (channel?.type !== ChannelType.GuildText) {
      log.warn(`Status board: ${config.COMMAND_CHANNEL_ID} is not a text channel`);
      return null;
    }
    const text = channel as TextChannel;

    const storedId = this.settings.get(this.settingKey);
    if (storedId) {
      try {
        this.message = await text.messages.fetch(storedId);
        return this.message;
      } catch (err) {
        // Anything other than "it's gone" (a network blip, a Discord outage)
        // must not post a duplicate. Try again on the next refresh.
        if (!isUnknownMessage(err)) throw err;
        log.info('Status board message is gone; posting a new one');
      }
    }

    const body = renderBoardBody(this.rows());
    const posted = await text.send({ content: renderBoard(body), allowedMentions: { parse: [] } });
    this.settings.set(this.settingKey, posted.id);
    this.message = posted;
    this.lastBody = body;
    this.lastEditAt = Date.now();

    try {
      await posted.pin();
    } catch (err) {
      log.warn(
        `Could not pin the status board (${(err as Error).message}). ` +
          'Give the bot the Pin Messages permission in the command channel.',
      );
    }

    log.info(`Status board posted as ${posted.id}`);
    return posted;
  }
}

function isUnknownMessage(err: unknown): boolean {
  return err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage;
}
