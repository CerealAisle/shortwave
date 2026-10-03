import { SlashCommandBuilder } from 'discord.js';
import { makeUid } from '../../lovense/client';
import { sessions } from '../../session/manager';
import { presence } from '../../session/presence';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

/**
 * Unlink a toy and delete its record. Controller only: a wearer disconnects
 * from the Lovense app itself, which severs the link out of band.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('disconnect')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription('Unlink a toy and delete its record from the bot')
    .addUserOption((o) =>
      o.setName('target').setDescription('Whose toy to unlink (defaults to yours)'),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const target = interaction.options.getUser('target') ?? interaction.user;
    const self = target.id === interaction.user.id;
    const uid = makeUid(interaction.guildId, target.id);
    const link = store.getByUid(uid);

    if (!link) {
      await interaction.reply({
        content: self ? 'You have no toy linked here.' : `${target.displayName} has no toy linked here.`,
      });
      return;
    }

    sessions.disarm(interaction.guildId, target.id, { silent: true });
    store.deleteLink(uid);
    presence.forget(uid);

    await interaction.reply({
      content:
        `Unlinked ${self ? 'your toy' : `${target.displayName}'s toy`} and turned tease off. ` +
        'For a full disconnect, also press **Stop** in the Lovense Remote app. ' +
        '`/connect` links again.',
    });
  },
};
