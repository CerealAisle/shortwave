import { SlashCommandBuilder } from 'discord.js';
import { config } from '../../config';
import { sessions } from '../../session/manager';
import { text } from '../../text';
import { notify } from '../notify';
import type { BotCommand } from '../types';

/**
 * The safeword. Halts every toy, turns tease off for everyone, and then
 * holds everything still for `duration` minutes: no buzz, pattern or tease
 * can start, from anyone, until it runs out.
 *
 * Never gated: no owner check, no permission, no confirmation. It is one of
 * the three commands everyone sees. A later /stop replaces the timer, so
 * either person can shorten it — `duration:0` lifts it.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription(text.stop.describe)
    .addNumberOption((o) =>
      o
        .setName('duration')
        .setDescription(text.stop.describeDuration(config.STOP_LOCKOUT_MINUTES))
        .setMinValue(0)
        .setMaxValue(120),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    await interaction.deferReply();

    const minutes = interaction.options.getNumber('duration') ?? config.STOP_LOCKOUT_MINUTES;
    const wasLocked = sessions.lockout(interaction.guildId) !== null;
    const count = await sessions.stopAll(interaction.guildId);
    const lock = sessions.lockOut(interaction.guildId, minutes * 60_000, interaction.user.id);

    await interaction.editReply(
      lock
        ? text.stop.stoppedUntil(lock.until)
        : wasLocked
          ? text.stop.stoppedAndLifted
          : text.stop.stoppedNoLock,
    );

    // Whoever runs the bot needs to know, even if they're only watching the
    // command channel.
    if (interaction.channelId !== config.COMMAND_CHANNEL_ID) {
      void notify(
        interaction.client,
        text.channel.stopRun(
          interaction.user.id,
          interaction.channelId,
          count,
          lock?.until ?? null,
          wasLocked && !lock,
        ),
      );
    }
  },
};
