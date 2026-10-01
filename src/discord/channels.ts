import { config } from '../config';

/**
 * The bot works in exactly two channels:
 *
 *   main    - shared conversation. Messages here are what drive triggers.
 *             The bot stays close to silent in it.
 *   command - the bot's home. Every bot-initiated message lands here.
 *
 * Slash commands work in either and reply where they were run, which is what
 * lets someone who can only see the main channel still use /stop and see
 * that it worked. Anywhere else is refused.
 */
export type ChannelRole = 'main' | 'command';

export function channelRole(channelId: string | null | undefined): ChannelRole | null {
  if (channelId === config.MAIN_CHANNEL_ID) return 'main';
  if (channelId === config.COMMAND_CHANNEL_ID) return 'command';
  return null;
}
