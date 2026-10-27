import io = require('socket.io-client');
import { config } from '../config';
import { log } from '../logger';
import { store, type ToyLink } from '../store/store';
import { text } from '../text';
import { deriveUserToken, LovenseError, postJson } from './client';

/**
 * Socket API diagnostics (SOCKET_DIAGNOSTICS).
 *
 * A second connection to Lovense, listen-only, per linked person. Commands
 * still go through the Standard API; nothing is ever sent here. What it adds
 * is Lovense's own view of her app: the Socket API pushes an event when it
 * sees the app come online or go offline, where the Standard API only says
 * "507" when a command happens to be sent.
 *
 * It is an experiment. Lovense documents the events but not their payloads,
 * so every event is logged raw ("Socket ...") for the journal, and the
 * parsing below is deliberately forgiving. Lovense may also only report on
 * apps paired through the Socket API's own QR code; if no app events ever
 * arrive, that is the likely reason.
 */

const API = 'https://api.lovense-api.com/api/basicApi';
/** First wait before reconnecting from scratch with a fresh token. */
const RESTART_MIN_MS = 30_000;
const RESTART_MAX_MS = 15 * 60_000;
/** socket.io's own reconnects that fail in a row before starting over. */
const MAX_CONNECT_ERRORS = 5;
/** Longest payload written to the log. */
const LOG_PAYLOAD_CHARS = 400;

export interface SocketState {
  connected: boolean;
  /** When `connected` last changed. */
  since: number;
  /** Why it isn't connected, when it isn't. */
  reason: string | null;
  /** What Lovense last said about the app, if anything. */
  app: { online: boolean; since: number } | null;
}

export type SocketChangeListener = (payload: { uid: string; what: string }) => void;

/** A payload as text, for the log. */
export function preview(payload: unknown): string {
  let s: string;
  try {
    s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    s = String(payload);
  }
  return s.length > LOG_PAYLOAD_CHARS ? `${s.slice(0, LOG_PAYLOAD_CHARS)}…` : s;
}

function unwrap(payload: unknown): Record<string, unknown> | null {
  let value = payload;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  // Some Lovense events wrap the body in `data`.
  if (obj.data && typeof obj.data === 'object') return obj.data as Record<string, unknown>;
  return obj;
}

function asOnline(v: unknown): boolean | null {
  if (v === true || v === 1 || v === '1' || v === 'online' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'offline' || v === 'false') return false;
  return null;
}

/**
 * Whether an event says the app is online, offline, or neither. Accepts the
 * shapes Lovense might send: `{status: 1}`, `{online: true}`, a JSON string
 * of either, or either wrapped in `data`.
 */
export function parseAppOnline(payload: unknown): boolean | null {
  const obj = unwrap(payload);
  if (!obj) return null;
  for (const key of ['online', 'status', 'appOnline', 'isOnline', 'appStatus']) {
    if (key in obj) {
      const v = asOnline(obj[key]);
      if (v !== null) return v;
    }
  }
  return null;
}

class Connection {
  state: SocketState = { connected: false, since: Date.now(), reason: 'starting', app: null };
  private socket: io.Socket | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = RESTART_MIN_MS;
  private connectErrors = 0;
  private closed = false;

  constructor(
    readonly link: ToyLink,
    private readonly changed: (what: string) => void,
  ) {}

  start(): void {
    void this.open();
  }

  close(): void {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.teardown();
  }

  private teardown(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.close();
    this.socket = null;
  }

  private setConnected(connected: boolean, reason: string | null): void {
    if (this.state.connected === connected && this.state.reason === reason) return;
    const was = this.state.connected;
    this.state = { ...this.state, connected, reason, since: was === connected ? this.state.since : Date.now() };
    if (was !== connected) this.changed(connected ? 'connected' : `disconnected (${reason ?? 'unknown'})`);
  }

  private setApp(online: boolean): void {
    if (this.state.app?.online === online) return;
    this.state = { ...this.state, app: { online, since: Date.now() } };
    log.info(`Socket ${this.link.uid}: Lovense reports the app ${online ? 'online' : 'offline'}`);
    this.changed(online ? 'app online' : 'app offline');
  }

  /** Throw the connection away and start again later with a fresh token. */
  private restart(reason: string): void {
    this.teardown();
    this.setConnected(false, reason);
    if (this.closed || this.restartTimer) return;
    const wait = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    log.warn(`Socket ${this.link.uid}: ${reason}; reconnecting in ${Math.round(wait / 1000)}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.open();
    }, wait);
    this.restartTimer.unref?.();
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    const uid = this.link.uid;
    this.setConnected(false, 'connecting');

    let url: string;
    let path: string;
    try {
      const token = await postJson(`${API}/getToken`, {
        token: config.LOVENSE_TOKEN,
        uid,
        uname: this.link.displayName.slice(0, 32),
        utoken: deriveUserToken(uid),
      });
      const authToken = token?.data?.authToken;
      if (token?.code !== 0 || !authToken) {
        throw new Error(`getToken said ${token?.code}: ${token?.message ?? 'no authToken'}`);
      }

      const where = await postJson(`${API}/getSocketUrl`, {
        platform: config.LOVENSE_PLATFORM,
        authToken,
      });
      url = where?.data?.socketIoUrl;
      path = where?.data?.socketIoPath;
      if (where?.code !== 0 || !url || !path) {
        throw new Error(`getSocketUrl said ${where?.code}: ${where?.message ?? 'no socket URL'}`);
      }
    } catch (err) {
      const msg = err instanceof LovenseError || err instanceof Error ? err.message : String(err);
      this.restart(`could not get a socket address: ${msg}`);
      return;
    }
    if (this.closed) return;

    log.info(`Socket ${uid}: connecting`);
    const socket = io(url, {
      path,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 5_000,
      reconnectionDelayMax: 60_000,
      forceNew: true,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.connectErrors = 0;
      this.restartDelay = RESTART_MIN_MS;
      log.info(`Socket ${uid}: connected`);
      this.setConnected(true, null);
    });

    socket.on('disconnect', (reason: string) => {
      log.warn(`Socket ${uid}: disconnected (${reason})`);
      // The server closed it on purpose: socket.io won't retry by itself, and
      // the token may be what it objected to.
      if (reason === 'io server disconnect') this.restart('closed by Lovense');
      else this.setConnected(false, reason);
    });

    socket.on('connect_error', (err: Error) => {
      this.connectErrors += 1;
      log.debug(`Socket ${uid}: connect error ${this.connectErrors}: ${err?.message ?? err}`);
      if (this.connectErrors >= MAX_CONNECT_ERRORS) {
        this.connectErrors = 0;
        this.restart(`could not connect (${err?.message ?? 'unknown error'})`);
      }
    });

    socket.on('basicapi_update_app_online_tc', (payload: unknown) => {
      log.info(`Socket ${uid}: app_online ${preview(payload)}`);
      const online = parseAppOnline(payload);
      if (online !== null) this.setApp(online);
    });

    socket.on('basicapi_update_app_status_tc', (payload: unknown) => {
      // Documented as "the QR code was scanned". Logged, not interpreted.
      log.info(`Socket ${uid}: app_status ${preview(payload)}`);
    });

    socket.on('basicapi_update_device_info_tc', (payload: unknown) => {
      log.debug(`Socket ${uid}: device_info ${preview(payload)}`);
      const online = parseAppOnline(payload);
      if (online !== null) this.setApp(online);
    });
  }
}

/** One listen-only connection per linked person in this server. */
export class SocketMonitor {
  private connections = new Map<string, Connection>();
  private listeners: SocketChangeListener[] = [];

  get enabled(): boolean {
    return config.SOCKET_DIAGNOSTICS;
  }

  onChange(fn: SocketChangeListener): void {
    this.listeners.push(fn);
  }

  start(): void {
    if (!this.enabled) return;
    log.info('Socket API diagnostics on (listen-only)');
    for (const link of store.listByGuild(config.DISCORD_GUILD_ID)) this.watch(link);
  }

  /** Start watching a link, if it has been scanned and isn't watched already. */
  watch(link: ToyLink): void {
    if (!this.enabled || link.lastSeen === null || this.connections.has(link.uid)) return;
    if (link.guildId !== config.DISCORD_GUILD_ID) return;
    const conn = new Connection(link, (what) => this.emit(link.uid, what));
    this.connections.set(link.uid, conn);
    conn.start();
  }

  unwatch(uid: string): void {
    this.connections.get(uid)?.close();
    this.connections.delete(uid);
  }

  stop(): void {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
  }

  state(uid: string): SocketState | null {
    return this.connections.get(uid)?.state ?? null;
  }

  /** One line for the board and /test, or null when diagnostics are off. */
  describe(uid: string): string | null {
    const s = this.state(uid);
    if (!s) return null;
    if (!s.connected) {
      return s.reason === 'connecting' || s.reason === 'starting'
        ? text.socket.connecting
        : text.socket.down(s.since, s.reason ?? 'unknown');
    }
    if (!s.app) return text.socket.noReport;
    return s.app.online ? text.socket.appOnline(s.app.since) : text.socket.appOffline(s.app.since);
  }

  private emit(uid: string, what: string): void {
    for (const fn of this.listeners) {
      try {
        fn({ uid, what });
      } catch (err) {
        log.error(`Socket listener threw: ${(err as Error).message}`);
      }
    }
  }
}

export const socketMonitor = new SocketMonitor();
