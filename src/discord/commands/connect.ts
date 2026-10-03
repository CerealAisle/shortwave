import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { log } from '../../logger';
import { LovenseError, lovense, makeUid } from '../../lovense/client';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Link your Lovense toy to the bot by scanning a QR code'),

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
        .setTitle('Connect your toy')
        .setDescription(
          [
            '1. Open the **Lovense Remote** app and make sure your toy is connected to it.',
            '2. Tap **Me → Scan QR code** and scan the image below.',
            '3. Confirm the connection prompt in the app.',
            '',
            'You stay in control the whole time: pressing **Stop** in the app',
            'ends the link immediately, and `/stop` halts everything from here.',
            code ? `\nUsing Lovense Remote for PC? Enter code: \`${code}\`` : '',
          ].join('\n'),
        )
        .setImage(qr)
        .setFooter({ text: 'This QR code is private — do not share it.' })
        .setColor(0x5865f2);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      const message =
        err instanceof LovenseError ? err.message : (err as Error).message;
      log.error(`QR generation failed for ${uid}: ${message}`);
      await interaction.editReply(
        `Could not generate a QR code: ${message}\n` +
          'Check that `LOVENSE_TOKEN` is correct and that your callback URL is set in the Lovense dashboard.',
      );
    }
  },
};
