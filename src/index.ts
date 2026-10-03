import { Events } from 'discord.js';
import { text } from './text';
import { notify } from './discord/notify';
import { describeTease } from './discord/toy-option';

import { config } from './config';
import { log } from './logger';
import { createClient } from './discord/client';
import { StatusBoard } from './discord/status-board';
import { startCallbackServer } from './http/callback';
import { toyLabel } from './lovense/toys';
import { sessions } from './session/manager';
import { presence } from './session/presence';
import { prober } from './session/prober';
import { store } from './store/store';

async function main() {
  const client = createClient();

  // The pinned post in the command channel: every linked toy, at a glance.
  const board = new StatusBoard(
    () =>
      store.listByGuild(config.DISCORD_GUILD_ID).map((link) => ({
        link,
        status: presence.statusFor(link),
        since: presence.since(link.uid),
        session: sessions.get(link.guildId, link.discordUserId),
      })),
    () => {
      const lock = sessions.lockout(config.DISCORD_GUILD_ID);
      return lock ? text.board.stoppedBanner(lock.by, lock.until) : null;
    },
    { get: store.getSetting, set: store.setSetting },
  );
  client.once(Events.ClientReady, () => board.start(client));

  // Outages, pauses, recoveries and errors are shown on the pinned board, not
  // posted: an iOS app dropping in and out made those a steady stream. The
  // bot still posts a few things to the command channel: tease turning
  // itself off, the tease reminder, a new connection, and /stop (stop.ts).
  sessions.onEvent(({ type, session }) => {
    board.requestUpdate();

    if (type === 'grace-expired') {
      void notify(client, text.channel.teaseOffAfterOutage(session.ownerId));
    }

    if (type === 'reminder') {
      // A fresh post each time, as a visible heartbeat; the pinned board is
      // the quiet view. Doesn't ping, so it doesn't become a notification
      // to tune out.
      const status = presence.statusForUid(session.uid);
      const reach =
        session.state === 'suspended'
          ? text.channel.reminderPaused
          : status?.presence === 'online'
            ? text.channel.reminderReachable(status.lastResult?.ok ? status.lastResult.at : null)
            : status?.presence === 'offline'
              ? text.channel.reminderUnreachable
              : text.channel.reminderUnknown;
      const toys = [...session.toys.values()].map((t) =>
        text.channel.reminderToy(
          t.toyName,
          describeTease(t),
          t.startedBy === session.ownerId ? null : t.startedBy,
        ),
      );
      void notify(client, text.channel.reminder(session.ownerId, session.armedAt, reach, toys), {
        ping: false,
      });
    }
  });
  sessions.onError(() => board.requestUpdate());
  presence.onResult(() => board.requestUpdate());

  // Liveness (probe results first, heartbeats second) drives suspend/resume rather than a hard stop.
  presence.onTransition(({ link, from, to }) => {
    board.requestUpdate();
    if (to === 'offline') {
      sessions.suspend(link.guildId, link.discordUserId);
      return;
    }

    if (to === 'online' && from === 'offline') {
      sessions.resume(link.guildId, link.discordUserId);
    }
  });

  const server = await startCallbackServer(({ uid, toys, firstConnect }) => {
    board.requestUpdate();
    if (!firstConnect) return;
    // The first callback is the QR scan landing.
    const link = store.getByUid(uid);
    if (!link) return;
    const names = toys.map(toyLabel).join(', ') || text.channel.noToysReported;
    void notify(client, text.channel.connected(link.discordUserId, names));
  });

  await client.login(config.DISCORD_TOKEN);
  presence.start();
  prober.start();

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    try {
      board.stop();
      prober.stop();
      presence.stop();
      // Stop every toy before the process goes away.
      await sessions.shutdown();
      await server.close();
      await client.destroy();
      store.close();
    } catch (err) {
      log.error(`Shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${String(reason)}`);
});

main().catch((err) => {
  log.error(`Fatal startup error: ${(err as Error).message}`);
  process.exit(1);
});
