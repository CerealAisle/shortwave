import { SlashCommandBuilder } from 'discord.js';
import { sessions } from '../../session/manager';
import type { BotCommand } from '../types';

/**
 * Never gated: it acts on the caller's own toy whoever started the tease,
 * and has no owner or permission check. See manager.test.ts.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('off')
    .setDescription('Turn tease off on your toy — messages stop triggering buzzes'),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const session = sessions.disarm(interaction.guildId, interaction.user.id);

    if (!session) {
      await interaction.reply({ content: 'Tease was not on. Nothing to do.' });
      return;
    }

    const minutes = Math.max(1, Math.round((Date.now() - session.armedAt) / 60_000));
    const missed = session.missedCount > 0 ? `, ${session.missedCount} missed` : '';
    await interaction.reply({
      content:
        `**Tease off.** ${session.triggerCount} buzz(es)${missed} over ${minutes} minute(s). ` +
        'A stop command has been sent.',
    });
  },
};
