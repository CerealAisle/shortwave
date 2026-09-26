import { SlashCommandBuilder } from 'discord.js';
import { sessions } from '../../session/manager';
import type { BotCommand } from '../types';

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('off')
    .setDescription('Disarm your toy — messages stop triggering buzzes'),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const session = sessions.disarm(interaction.guildId, interaction.user.id);

    if (!session) {
      await interaction.reply({ content: 'You were not armed. Nothing to do.' });
      return;
    }

    const minutes = Math.max(1, Math.round((Date.now() - session.armedAt) / 60_000));
    const missed = session.missedCount > 0 ? `, ${session.missedCount} missed` : '';
    await interaction.reply({
      content:
        `**Disarmed.** ${session.triggerCount} buzz(es)${missed} over ${minutes} minute(s). ` +
        'A stop command has been sent.',
    });
  },
};
