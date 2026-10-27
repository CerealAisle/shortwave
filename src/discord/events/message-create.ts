import type { Client, Message } from 'discord.js';
import { Events } from 'discord.js';
import { config } from '../../config';
import { log } from '../../logger';
import { sessions } from '../../session/manager';
import { teaseLog } from '../tease-log';

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

      const outcome = await sessions.handleTrigger(session, `message:${message.id}`);
      if (outcome.result === 'failed') {
        log.warn(`Buzz failed for ${session.ownerId} on message ${message.id}: ${outcome.error}`);
      }
      // Every outcome, including the expected ones, goes in the tease log in
      // the command channel, with why it wasn't sent.
      teaseLog.trigger(session, {
        at: message.createdTimestamp,
        authorId: message.author.id,
        messageUrl: message.url,
        outcome,
      });
    }
  });

  log.info(`Message trigger active on channel ${config.MAIN_CHANNEL_ID}`);
}
