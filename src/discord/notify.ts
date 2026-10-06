import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { config } from '../config';
import { log } from '../logger';

/**
 * Post in a channel. Best effort: a missing channel or permission is logged,
 * never thrown, so it can't abort whatever triggered it. `mention` lists the
 * users this message may ping; everyone else @-mentioned in it is not.
 * Resolves to whether it was posted.
 */
export async function post(
  client: Client,
  channelId: string,
  content: string,
  opts: { mention?: string[] } = {},
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) return false;
    await (channel as TextChannel).send({
      content,
      ...(opts.mention ? { allowedMentions: { users: opts.mention } } : {}),
    });
    return true;
  } catch (err) {
    log.warn(`Could not post to ${channelId}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Post a bot-initiated message to the command channel: things for the person
 * running the bot, not for the shared conversation. Command replies don't
 * come through here — they answer wherever the command was run.
 */
export async function notify(
  client: Client,
  content: string,
  opts: { ping?: boolean } = {},
): Promise<void> {
  await post(client, config.COMMAND_CHANNEL_ID, content, opts.ping === false ? { mention: [] } : {});
}
