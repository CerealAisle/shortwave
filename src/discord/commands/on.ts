import { MessageFlags, SlashCommandBuilder, channelMention } from 'discord.js';
import { config } from '../../config';
import { makeUid } from '../../lovense/client';
import { sessions } from '../../session/manager';
import { presence } from '../../session/presence';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('on')
    .setDescription('Arm your toy: every message from someone else sends a buzz')
    .addIntegerOption((o) =>
      o
        .setName('intensity')
        .setDescription(`Buzz strength %, default ${config.BUZZ_INTENSITY_PERCENT}`)
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addNumberOption((o) =>
      o
        .setName('duration')
        .setDescription(`Buzz length in seconds, default ${config.BUZZ_DURATION_SEC}`)
        .setMinValue(1)
        .setMaxValue(30),
    )
    .addIntegerOption((o) =>
      o
        .setName('timeout')
        .setDescription(
          `Auto-off after N minutes, default ${config.SESSION_TIMEOUT_MINUTES}`,
        )
        .setMinValue(1)
        .setMaxValue(1440),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const link = store.getByUser(interaction.guildId, interaction.user.id);
    if (!link) {
      await interaction.reply({
        content: 'You have not linked a toy yet. Run `/connect` first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (link.lastSeen === null) {
      await interaction.reply({
        content:
          'Your QR code has not been scanned yet — the bot has not heard from your Lovense app. ' +
          'Scan the code from `/connect`, then try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const status = presence.statusFor(link);

    if (status.presence === 'offline') {
      const since = link.lastSeen
        ? `Last heartbeat was ${Math.round((Date.now() - link.lastSeen) / 1000)}s ago.`
        : '';
      await interaction.reply({
        content:
          `Your toy looks offline, so arming would do nothing. ${since}\n` +
          'Check that Lovense Remote is running, the phone has data, and the toy is connected over Bluetooth.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const intensity = interaction.options.getInteger('intensity') ?? undefined;
    const duration = interaction.options.getNumber('duration') ?? undefined;
    const timeout = interaction.options.getInteger('timeout') ?? undefined;

    const session = sessions.arm({
      uid: makeUid(interaction.guildId, interaction.user.id),
      guildId: interaction.guildId,
      ownerId: interaction.user.id,
      intensityPercent: intensity,
      durationSec: duration,
      timeoutMinutes: timeout,
    });

    const expiresIn = Math.round((session.expiresAt - Date.now()) / 60_000);

    // If we've only ever had the one pairing callback, heartbeats almost
    // certainly aren't enabled — say so once here rather than silently
    // running without liveness detection.
    const heartbeatWarning =
      presence.enabled && !status.heartbeatsWorking
        ? '\n\n*No heartbeats received yet, so the bot cannot tell if your toy drops offline. ' +
          'Enable heartbeat in the Lovense developer dashboard.*'
        : '';

    await interaction.reply({
      content:
        `**Armed.** Messages from anyone else in ${channelMention(config.MAIN_CHANNEL_ID)} ` +
        `will buzz at ${session.intensityPercent}% for ${session.durationSec}s.\n` +
        `Auto-off in ${expiresIn} minutes. Use \`/off\` to stop, or \`/stop\` for an immediate halt.` +
        heartbeatWarning,
    });
  },
};
