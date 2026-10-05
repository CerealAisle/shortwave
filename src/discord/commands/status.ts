import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { log } from '../../logger';
import { text } from '../../text';
import { getBoard } from '../board-ref';
import type { BotCommand } from '../types';

/**
 * Bring the status board here: delete the old post, and post a fresh,
 * pinned one in this channel, which the bot then keeps up to date. Works in
 * either channel commands are allowed in.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.status.describe),

  async execute(interaction) {
    const board = getBoard();
    if (!interaction.guildId || !board) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { pinned } = await board.repost(interaction.channelId);
      await interaction.editReply(pinned ? text.status.reposted : text.status.repostedUnpinned);
    } catch (err) {
      log.warn(`/status repost failed: ${(err as Error).message}`);
      await interaction.editReply(text.status.repostFailed);
    }
  },
};
