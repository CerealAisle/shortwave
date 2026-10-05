import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';
import { log } from '../logger';
import type { LovenseToy } from '../lovense/types';

export interface ToyLink {
  uid: string;
  guildId: string;
  discordUserId: string;
  displayName: string;
  toys: LovenseToy[];
  platform: string | null;
  lastSeen: number | null;
  /** How many callbacks (pairing + heartbeats) we've received for this link. */
  callbackCount: number;
  createdAt: number;
}

interface LinkRow {
  uid: string;
  guild_id: string;
  discord_user_id: string;
  display_name: string;
  toys_json: string;
  platform: string | null;
  last_seen: number | null;
  callback_count: number;
  created_at: number;
}

const dbPath = resolve(config.DATABASE_PATH);
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS toy_links (
    uid              TEXT PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    discord_user_id  TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    toys_json        TEXT NOT NULL DEFAULT '[]',
    platform         TEXT,
    last_seen        INTEGER,
    callback_count   INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_toy_links_guild ON toy_links (guild_id);

  -- Append-only log of every command the bot dispatched. Useful for
  -- debugging rate limits and for seeing exactly what happened when.
  CREATE TABLE IF NOT EXISTS command_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT NOT NULL,
    description TEXT NOT NULL,
    source      TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    error       TEXT,
    created_at  INTEGER NOT NULL
  );

  -- Small key/value state that must survive a restart, such as the ID of
  -- the pinned status post.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Lightweight migration: add columns introduced after the first release.
const columns = new Set(
  (db.prepare('PRAGMA table_info(toy_links)').all() as { name: string }[]).map((c) => c.name),
);
if (!columns.has('callback_count')) {
  db.exec('ALTER TABLE toy_links ADD COLUMN callback_count INTEGER NOT NULL DEFAULT 0');
  log.info('Migrated toy_links: added callback_count');
}

log.info(`Database ready at ${dbPath}`);

function rowToLink(row: LinkRow): ToyLink {
  let toys: LovenseToy[] = [];
  try {
    toys = JSON.parse(row.toys_json);
  } catch {
    toys = [];
  }
  return {
    uid: row.uid,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    displayName: row.display_name,
    toys,
    platform: row.platform,
    lastSeen: row.last_seen,
    callbackCount: row.callback_count ?? 0,
    createdAt: row.created_at,
  };
}

const stmts = {
  upsertLink: db.prepare(`
    INSERT INTO toy_links (uid, guild_id, discord_user_id, display_name, toys_json, created_at)
    VALUES (@uid, @guild_id, @discord_user_id, @display_name, '[]', @created_at)
    ON CONFLICT(uid) DO UPDATE SET display_name = excluded.display_name
  `),
  updateToys: db.prepare(`
    UPDATE toy_links
       SET toys_json      = @toys_json,
           platform       = @platform,
           last_seen      = @last_seen,
           callback_count = callback_count + 1
     WHERE uid = @uid
  `),
  getByUid: db.prepare('SELECT * FROM toy_links WHERE uid = ?'),
  getByUser: db.prepare(
    'SELECT * FROM toy_links WHERE guild_id = ? AND discord_user_id = ?',
  ),
  listByGuild: db.prepare('SELECT * FROM toy_links WHERE guild_id = ?'),
  listAll: db.prepare('SELECT * FROM toy_links'),
  deleteByUid: db.prepare('DELETE FROM toy_links WHERE uid = ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  deleteSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
  listSettings: db.prepare("SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'"),
  insertLog: db.prepare(`
    INSERT INTO command_log (uid, description, source, ok, error, created_at)
    VALUES (@uid, @description, @source, @ok, @error, @created_at)
  `),
};

export const store = {
  /** Create the link row when a QR code is issued (before the callback lands). */
  createLink(uid: string, guildId: string, discordUserId: string, displayName: string): void {
    stmts.upsertLink.run({
      uid,
      guild_id: guildId,
      discord_user_id: discordUserId,
      display_name: displayName,
      created_at: Date.now(),
    });
  },

  /**
   * Called from the Lovense callback handler for both the initial pairing
   * callback and every subsequent heartbeat.
   */
  recordCallback(uid: string, toys: LovenseToy[], platform: string | null): void {
    stmts.updateToys.run({
      uid,
      toys_json: JSON.stringify(toys),
      platform,
      last_seen: Date.now(),
    });
  },

  getByUid(uid: string): ToyLink | null {
    const row = stmts.getByUid.get(uid) as LinkRow | undefined;
    return row ? rowToLink(row) : null;
  },

  getByUser(guildId: string, discordUserId: string): ToyLink | null {
    const row = stmts.getByUser.get(guildId, discordUserId) as LinkRow | undefined;
    return row ? rowToLink(row) : null;
  },

  listByGuild(guildId: string): ToyLink[] {
    return (stmts.listByGuild.all(guildId) as LinkRow[]).map(rowToLink);
  },

  listAll(): ToyLink[] {
    return (stmts.listAll.all() as LinkRow[]).map(rowToLink);
  },

  deleteLink(uid: string): void {
    stmts.deleteByUid.run(uid);
  },

  logCommand(entry: {
    uid: string;
    description: string;
    source: string;
    ok: boolean;
    error?: string;
  }): void {
    stmts.insertLog.run({
      uid: entry.uid,
      description: entry.description,
      source: entry.source,
      ok: entry.ok ? 1 : 0,
      error: entry.error ?? null,
      created_at: Date.now(),
    });
  },

  getSetting(key: string): string | null {
    const row = stmts.getSetting.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  },

  setSetting(key: string, value: string): void {
    stmts.setSetting.run(key, value);
  },

  deleteSetting(key: string): void {
    stmts.deleteSetting.run(key);
  },

  /** Every setting whose key starts with `prefix`. */
  listSettings(prefix: string): { key: string; value: string }[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return stmts.listSettings.all(`${escaped}%`) as { key: string; value: string }[];
  },

  close(): void {
    db.close();
  },
};
