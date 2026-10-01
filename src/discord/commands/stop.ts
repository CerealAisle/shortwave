import { SlashCommandBuilder } from 'discord.js';
import { sessions } from '../../session/manager';
import type { BotCommand } from '../types';

/**
 * The panic button. Usable by anyone in the server, not just toy owners —
 * either person needs to be able to stop everything without argument.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Immediately stop all toys and turn tease off for everyone'),

  async execute(interaction) {
    if (!interaction.guildId) return;

    await interaction.deferReply();
    const count = await sessions.stopAll(interaction.guildId);

    await interaction.editReply(
      `**Stopped.** All toys halted and tease turned off for ${count} toy(s). ` +
        'Start again with `/tease` when you want to continue.',
    );
  },
};
