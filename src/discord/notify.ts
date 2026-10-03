import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { config } from '../config';
import { log } from '../logger';

/**
 * Post a bot-initiated message. These always go to the command channel,
 * never the main one: disconnects, errors and stop notices are for the
 * person running the bot, not for the shared conversation. Command replies
 * don't come through here — they answer wherever the command was run.
 */
export async function notify(
  client: Client,
  content: string,
  opts: { ping?: boolean } = {},
): Promise<void> {
  const channelId = config.COMMAND_CHANNEL_ID;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type === ChannelType.GuildText) {
      await (channel as TextChannel).send({
        content,
        ...(opts.ping === false ? { allowedMentions: { parse: [] } } : {}),
      });
    }
  } catch (err) {
    log.warn(`Could not post to ${channelId}: ${(err as Error).message}`);
  }
}
