import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { log } from '../../logger';
import { LovenseError, lovense, makeUid } from '../../lovense/client';
import { store } from '../../store/store';
import { text } from '../../text';
import type { BotCommand } from '../types';

export const command: BotCommand = {
  data: new SlashCommandBuilder().setName('connect').setDescription(text.connect.describe),

  async execute(interaction) {
    if (!interaction.guildId) return;

    // Ephemeral: the QR code is a control credential for your toy.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const uid = makeUid(interaction.guildId, interaction.user.id);
    const displayName = interaction.user.displayName ?? interaction.user.username;

    store.createLink(uid, interaction.guildId, interaction.user.id, displayName);

    try {
      const { qr, code } = await lovense.getQrCode(uid, displayName);

      const embed = new EmbedBuilder()
        .setTitle(text.connect.embedTitle)
        .setDescription([...text.connect.embedSteps, code ? text.connect.pcCode(code) : ''].join('\n'))
        .setImage(qr)
        .setFooter({ text: text.connect.embedFooter })
        .setColor(0x5865f2);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      const message = err instanceof LovenseError ? err.message : (err as Error).message;
      log.error(`QR generation failed for ${uid}: ${message}`);
      await interaction.editReply(text.connect.qrFailed(message));
    }
  },
};
