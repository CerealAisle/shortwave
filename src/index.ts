import { Events, time, type Client } from 'discord.js';
import { describeLockout } from './discord/lockout';
import { notify } from './discord/notify';
import { config } from './config';
import { log } from './logger';
import { createClient } from './discord/client';
import { StatusBoard } from './discord/status-board';
import { startCallbackServer } from './http/callback';
import { LovenseError, explainCode } from './lovense/client';
import { sessions } from './session/manager';
import { describeTease } from './discord/toy-option';
import { diagnose, presence } from './session/presence';
import { prober } from './session/prober';
import { store } from './store/store';

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
      return lock ? `🛑 **${describeLockout(lock)}.**` : null;
    },
    { get: store.getSetting, set: store.setSetting },
  );
  client.once(Events.ClientReady, () => board.start(client));

  // Outage notices: one per outage, then silence until a command actually
  // gets through. A backgrounded iOS app can drop and recover every minute
  // or so, and a notice for each of those was noise. The pinned board shows
  // the live state, including what the error code means.
  const outageNotified = new Set<string>();
  presence.onResult(({ uid, ok }) => {
    if (ok) outageNotified.delete(uid);
  });

  /** Runs `post` only for the first notice of an outage. */
  function oncePerOutage(uid: string, post: () => void): void {
    if (outageNotified.has(uid)) return;
    outageNotified.add(uid);
    post();
  }

  // The disconnect DM follows the same rule, and keeps its own cooldown on
  // top so separate outages close together don't each raise a notification.
  const lastDisconnectDm = new Map<string, number>();
  function dmDisconnect(session: { uid: string; ownerId: string }, content: string): void {
    if (!config.DM_ON_DISCONNECT) return;
    const last = lastDisconnectDm.get(session.uid) ?? 0;
    if (Date.now() - last < config.DM_COOLDOWN_SEC * 1000) return;
    lastDisconnectDm.set(session.uid, Date.now());
    void dm(client, session.ownerId, content);
  }

  sessions.onEvent(({ type, session }) => {
    board.requestUpdate();
    const who = `<@${session.ownerId}>`;

    switch (type) {
      case 'reminder': {
        // A fresh post each time, as a visible heartbeat; the pinned board is
        // the quiet view. Carries enough state to be worth reading, and
        // doesn't ping, so it doesn't become a notification to tune out.
        const status = presence.statusForUid(session.uid);
        const reach =
          session.state === 'suspended'
            ? '⏸️ paused — toy unreachable'
            : status?.presence === 'online'
              ? `🟢 reachable${
                  status.lastResult?.ok
                    ? `, probed ${time(Math.floor(status.lastResult.at / 1000), 'R')}`
                    : ''
                }`
              : status?.presence === 'offline'
                ? '🔴 unreachable'
                : '⚪ reachability unknown';
        const toys = [...session.toys.values()].map((t) => {
          const by = t.startedBy === session.ownerId ? '' : ` · started by <@${t.startedBy}>`;
          return `• ${t.toyName}: ${describeTease(t)}${by}`;
        });
        void notify(
          client,
          `**Tease still on** for ${who} — since ${time(Math.floor(session.armedAt / 1000), 'R')} · ${reach}\n` +
            toys.join('\n'),
          { ping: false },
        );
        break;
      }
      case 'suspended': {
        const graceMin = Math.round(config.OFFLINE_GRACE_SEC / 60);
        const status = presence.statusForUid(session.uid);
        const why = status ? diagnose(status) : null;
        oncePerOutage(session.uid, () => {
          void notify(
            client,
            `⚠️ ${who}'s toy isn't responding` +
              (why ? ` — ${why.meaning}${why.code !== undefined ? ` (${why.code})` : ''}` : '') +
              '.\n' +
              (why?.hint ? `${why.hint[0]!.toUpperCase()}${why.hint.slice(1)}.\n` : '') +
              `Tease is paused and picks up by itself when a command gets through; if that ` +
              `takes more than ${graceMin} minutes it turns off. No more notices until it's ` +
              'back — the pinned status shows the live state.',
          );
          // The channel message is easy to miss on a phone. A DM raises a
          // push notification, which is the only reliable way to reach the
          // person who has to perform the fix by hand.
          dmDisconnect(
            session,
            '**Your toy has stopped responding.**\n\n' +
              'To fix it:\n' +
              '1. **Force-quit** Lovense Remote (swipe up from the bottom, then ' +
              'swipe the app away). Just reopening it usually is not enough.\n' +
              '2. Open it again and wait for the toy to reconnect.\n\n' +
              'Run `/test` to check it is working again.',
          );
        });
        break;
      }
      case 'resumed':
        // Deliberately silent: the board shows it, and the outage notice
        // already said it would pick up by itself.
        break;
      case 'grace-expired':
        // Normally covered by the outage notice, which said this would
        // happen. Only posts when it is the first word on the outage — with
        // OFFLINE_GRACE_SEC=0 there is no pause first.
        oncePerOutage(session.uid, () => {
          void notify(
            client,
            `⚠️ ${who}'s toy stopped responding, so tease has been turned off. ` +
              'No more notices until it is back — the pinned status shows the live state.',
          );
        });
        break;
    }
  });

  sessions.onError(({ session, error }) => {
    // A 507 already suspends the session, and that notice says it better.
    if (error instanceof LovenseError && error.code === 507) return;
    oncePerOutage(session.uid, () => {
      void notify(
        client,
        `⚠️ Could not reach <@${session.ownerId}>'s toy — ` +
          `${error instanceof LovenseError ? explainCode(error.code) : error.message}` +
          `${error instanceof LovenseError && error.code !== undefined ? ` (${error.code})` : ''}. ` +
          'No more notices until a command gets through.',
      );
    });
  });

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
    if (!firstConnect) return;
    board.requestUpdate();
    const link = store.getByUid(uid);
    if (!link) return;
    const names = toys.map((t) => t.nickName || t.name).join(', ') || 'no toys reported';
    void notify(
      client,
      `<@${link.discordUserId}> connected successfully (${names}). Use \`/tease\` when ready.`,
    );
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
