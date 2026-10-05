import { SlashCommandBuilder } from 'discord.js';
import { makeUid } from '../../lovense/client';
import { sessions } from '../../session/manager';
import { presence } from '../../session/presence';
import { store } from '../../store/store';
import { text } from '../../text';
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
    .setDescription(text.disconnect.describe)
    .addUserOption((o) =>
      o.setName('target').setDescription(text.disconnect.describeTarget).setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const target = interaction.options.getUser('target', true);
    const self = target.id === interaction.user.id;
    const uid = makeUid(interaction.guildId, target.id);

    if (!store.getByUid(uid)) {
      await interaction.reply(text.disconnect.nothingLinked(self, target.displayName));
      return;
    }

    sessions.disarm(interaction.guildId, target.id, { silent: true });
    store.deleteLink(uid);
    presence.forget(uid);

    await interaction.reply(text.disconnect.done(self, target.displayName));
  },
};
