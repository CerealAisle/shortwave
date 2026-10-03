import { Events } from 'discord.js';
import { text } from './text';
import { confirmScan } from './discord/pending-connect';

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

  // The bot posts nothing on its own. Everything it has to say is either
  // the answer to a command, or on the pinned board — which these keep
  // current. Outages, pauses and errors used to post a notice each, and an
  // iOS app dropping in and out made that a steady stream.
  sessions.onEvent(() => board.requestUpdate());
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
    // The first callback is the QR scan landing: answer the /connect that
    // produced it, by editing its private reply.
    if (firstConnect) void confirmScan(uid, text.connect.scanned(toys.map(toyLabel)));
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
