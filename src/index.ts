import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { config } from './config';
import { log } from './logger';
import { createClient } from './discord/client';
import { startCallbackServer } from './http/callback';
import { LovenseError } from './lovense/client';
import { sessions } from './session/manager';
import { presence } from './session/presence';
import { prober } from './session/prober';
import { store } from './store/store';

/**
 * Post a bot-initiated message. These always go to the command channel,
 * never the main one: disconnects, resumes and errors are for the person
 * running the bot, not for the shared conversation. Command replies don't
 * come through here — they answer wherever the command was run.
 */
async function notify(client: Client, content: string): Promise<void> {
  const channelId = config.COMMAND_CHANNEL_ID;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type === ChannelType.GuildText) {
      await (channel as TextChannel).send(content);
    }
  } catch (err) {
    log.warn(`Could not post to ${channelId}: ${(err as Error).message}`);
  }
}

/**
 * DM a user. Best effort: Discord refuses DMs from bots to people who have
 * them disabled, and that must not take the bot down or abort the caller.
 */
async function dm(client: Client, userId: string, content: string): Promise<void> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(content);
    log.debug(`DM sent to ${userId}`);
  } catch (err) {
    log.warn(
      `Could not DM ${userId} (${(err as Error).message}). ` +
        'They may have DMs from server members turned off.',
    );
  }
}

async function main() {
  const client = createClient();

  // Session lifecycle notices. Everything the command channel needs to know about a
  // session ending, pausing or picking back up comes through here.
  // Disconnect DMs are rate limited per person: a phone that flaps between
  // online and offline would otherwise generate a notification each time.
  const lastDisconnectDm = new Map<string, number>();

  function dmDisconnect(session: { uid: string; ownerId: string }, content: string): void {
    if (!config.DM_ON_DISCONNECT) return;
    const last = lastDisconnectDm.get(session.uid) ?? 0;
    if (Date.now() - last < config.DM_COOLDOWN_SEC * 1000) return;
    lastDisconnectDm.set(session.uid, Date.now());
    void dm(client, session.ownerId, content);
  }

  sessions.onEvent(({ type, session }) => {
    const who = `<@${session.ownerId}>`;

    switch (type) {
      case 'expired': {
        const hours = ((Date.now() - session.armedAt) / 3_600_000).toFixed(1);
        void notify(
          client,
          `${who}'s session hit its auto-off timer after ${hours}h and has been disarmed. ` +
            `${session.triggerCount} buzz(es) total.`,
        );
        break;
      }
      case 'suspended': {
        const graceMin = Math.round(config.OFFLINE_GRACE_SEC / 60);
        void notify(
          client,
          `${who}'s toy went quiet — session **paused**, not ended. It resumes by itself ` +
            `if the toy is back within ${graceMin} minutes.\n` +
            `*If the Lovense app looks fine but nothing reaches the toy, force-quit and ` +
            `reopen it — reopening from the background is often not enough.*`,
        );
        // The channel message is easy to miss on a phone. A DM raises a push
        // notification, which is the only reliable way to reach the person
        // who has to perform the fix by hand.
        dmDisconnect(
          session,
          '**Your toy has gone offline** — the session is paused, not ended.\n\n' +
            'To fix it:\n' +
            '1. **Force-quit** Lovense Remote (swipe up from the bottom, then ' +
            'swipe the app away). Just reopening it usually is not enough.\n' +
            '2. Open it again and wait for the toy to reconnect.\n\n' +
            `The session resumes on its own if that happens within ${graceMin} minutes. ` +
            'After that it disarms and you will need `/on` again.',
        );
        break;
      }
      case 'resumed':
        void notify(
          client,
          `${who}'s toy is back — session **resumed**.` +
            (session.missedCount > 0 ? ` ${session.missedCount} message(s) missed.` : ''),
        );
        break;
      case 'grace-expired':
        void notify(
          client,
          `${who}'s toy did not come back in time — session disarmed. ` +
            'Reconnect in Lovense Remote, then `/on` again.',
        );
        // Deliberately bypasses the cooldown: the session has actually ended
        // now, which is worth interrupting for even if a pause DM just went
        // out a few minutes ago.
        if (config.DM_ON_DISCONNECT) {
          void dm(
            client,
            session.ownerId,
            '**Session disarmed** — your toy did not come back within the grace window.\n\n' +
              'Force-quit and reopen Lovense Remote, check the toy is connected, ' +
              'then run `/on` to start a new session.',
          );
        }
        break;
    }
  });

  // Only surface a command failure once per session rather than per message;
  // a phone that has gone away would otherwise generate a notice per trigger.
  const notifiedErrors = new Set<string>();
  sessions.onError(({ session, error }) => {
    // A 507 already triggers an immediate suspend, and the "paused" notice
    // that follows says the same thing more usefully. Don't post both.
    if (error instanceof LovenseError && error.code === 507) return;

    if (notifiedErrors.has(session.uid)) return;
    notifiedErrors.add(session.uid);
    setTimeout(() => notifiedErrors.delete(session.uid), 120_000).unref?.();
    void notify(
      client,
      `Could not reach <@${session.ownerId}>'s toy: ${error.message}`,
    );
  });

  // Liveness (probe results first, heartbeats second) drives suspend/resume rather than a hard stop.
  presence.onTransition(({ link, from, to }) => {
    if (to === 'offline') {
      sessions.suspend(link.guildId, link.discordUserId);
      return;
    }

    if (to === 'online' && from === 'offline') {
      sessions.resume(link.guildId, link.discordUserId);
    }
  });

  const server = await startCallbackServer(({ uid, toys, firstConnect }) => {
    if (!firstConnect) return;
    const link = store.getByUid(uid);
    if (!link) return;
    const names = toys.map((t) => t.nickName || t.name).join(', ') || 'no toys reported';
    void notify(
      client,
      `<@${link.discordUserId}> connected successfully (${names}). Use \`/on\` when ready.`,
    );
  });

  await client.login(config.DISCORD_TOKEN);
  presence.start();
  prober.start();

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    try {
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
