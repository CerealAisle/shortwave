import type { Client, Message } from 'discord.js';
import { Events } from 'discord.js';
import { config } from '../../config';
import { log } from '../../logger';
import { sessions } from '../../session/manager';

/**
 * The trigger path. Guards, in order:
 *   - right guild, main channel only (the command channel never triggers)
 *   - never our own messages; other bots only if explicitly enabled
 *   - never the toy owner's own messages
 * Whatever survives becomes one buzz per toy with tease on, subject to the
 * session's rate limiter.
 */
export function registerMessageTrigger(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.guildId !== config.DISCORD_GUILD_ID) return;
    if (message.channelId !== config.MAIN_CHANNEL_ID) return;
    if (message.author.id === client.user?.id) return;
    if (message.author.bot && !config.TRIGGER_ON_BOT_MESSAGES) return;

    const armed = sessions.listForGuild(message.guildId);
    if (armed.length === 0) return;

    for (const session of armed) {
      // The person wearing the toy doesn't set it off by talking.
      if (session.ownerId === message.author.id) continue;

      const result = await sessions.handleTrigger(session, `message:${message.id}`);
      if (result === 'failed') {
        log.warn(`Buzz failed for ${session.ownerId} on message ${message.id}`);
      }
      // 'throttled', 'offline' and 'suspended' are all expected outcomes over
      // a long session and are counted on the session, not logged per message.
    }
  });

  log.info(`Message trigger active on channel ${config.MAIN_CHANNEL_ID}`);
}
