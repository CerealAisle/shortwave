import { SlashCommandBuilder, channelMention, time, userMention } from 'discord.js';
import { config } from '../../config';
import { sessions } from '../../session/manager';
import { notify } from '../notify';
import type { BotCommand } from '../types';

/**
 * The safeword. Halts every toy, turns tease off for everyone, and then
 * holds everything still for `duration` minutes: no buzz, pattern or tease
 * can start, from anyone, until it runs out.
 *
 * Never gated: no owner check, no permission, no confirmation. It is one of
 * the three commands everyone sees. A later /stop can extend the lockout but
 * never shorten it.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop everything now, and keep it stopped for a while')
    .addNumberOption((o) =>
      o
        .setName('duration')
        .setDescription(`Minutes to keep everything stopped (default ${config.STOP_LOCKOUT_MINUTES})`)
        .setMinValue(0)
        .setMaxValue(120),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    await interaction.deferReply();

    const minutes = interaction.options.getNumber('duration') ?? config.STOP_LOCKOUT_MINUTES;
    const count = await sessions.stopAll(interaction.guildId);
    const lock = sessions.lockOut(interaction.guildId, minutes * 60_000, interaction.user.id);

    const held = lock
      ? `Nothing can start again ${time(Math.floor(lock.until / 1000), 'R')}.`
      : 'You can start again whenever you like.';
    await interaction.editReply(`**Stopped.** Every toy has been halted. ${held}`);

    // Whoever runs the bot needs to know, even if they're only watching the
    // command channel.
    if (interaction.channelId !== config.COMMAND_CHANNEL_ID) {
      void notify(
        interaction.client,
        `🛑 ${userMention(interaction.user.id)} ran \`/stop\` in ${channelMention(interaction.channelId)}. ` +
          `All toys halted${count > 0 ? ` and tease turned off for ${count} person(s)` : ''}. ` +
          (lock ? `Locked until ${time(Math.floor(lock.until / 1000), 'R')}.` : 'No lockout.'),
      );
    }
  },
};
