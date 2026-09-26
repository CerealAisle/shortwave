import { SlashCommandBuilder } from 'discord.js';
import { makeUid } from '../../lovense/client';
import { sessions } from '../../session/manager';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Unlink your toy and delete its record from the bot'),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const uid = makeUid(interaction.guildId, interaction.user.id);
    const link = store.getByUid(uid);

    if (!link) {
      await interaction.reply({ content: 'You have no toy linked here.' });
      return;
    }

    sessions.disarm(interaction.guildId, interaction.user.id, { silent: true });
    store.deleteLink(uid);

    await interaction.reply({
      content:
        'Unlinked and disarmed. For a full disconnect, also press **Stop** in your Lovense Remote app. ' +
        'Run `/connect` any time to link again.',
    });
  },
};
