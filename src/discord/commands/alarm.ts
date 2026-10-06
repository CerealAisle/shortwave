import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { parseAlarmTime } from '../../alarm-time';
import { config } from '../../config';
import { text } from '../../text';
import { timers } from '../../timers';
import type { BotCommand } from '../types';

/**
 * A named alarm at a clock time. When it goes off, the bot posts in this
 * channel and pings whoever set it. Times are read in TIMEZONE unless they
 * name a zone; the reply shows the result as a Discord timestamp, which each
 * viewer sees in their own local time. Same name again moves it; `off`
 * cancels it.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('alarm')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.alarm.describe)
    .addStringOption((o) =>
      o.setName('name').setDescription(text.alarm.describeName).setRequired(true).setMaxLength(50),
    )
    .addStringOption((o) =>
      o
        .setName('time')
        .setDescription(text.alarm.describeTime(config.TIMEZONE))
        .setRequired(true)
        .setMaxLength(60),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const name = interaction.options.getString('name', true).trim();
    const raw = interaction.options.getString('time', true).trim();

    if (['off', 'cancel', 'stop', '0'].includes(raw.toLowerCase())) {
      const existed = timers.cancel(interaction.guildId, name, 'alarm');
      await interaction.reply({
        content: existed ? text.alarm.cancelled(name) : text.alarm.notFound(name),
        flags: existed ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    const parsed = parseAlarmTime(raw, config.TIMEZONE);
    if (!parsed.ok) {
      await interaction.reply({
        content: text.alarm.badTime(raw, parsed.error),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = timers.setAlarm(
      { name, guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id },
      parsed.at,
    );
    if (!result.ok) {
      await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply(
      result.replaced ? text.alarm.replaced(name, parsed.at) : text.alarm.set(name, parsed.at),
    );
  },
};
