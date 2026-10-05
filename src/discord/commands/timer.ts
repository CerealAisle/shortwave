import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { text } from '../../text';
import { parseDuration, timers } from '../../timers';
import type { BotCommand } from '../types';

/**
 * A named timer. When it runs out, the bot posts in this channel and pings
 * whoever set it. Same name again replaces it; `duration:0` cancels it.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('timer')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.timer.describe)
    .addStringOption((o) =>
      o.setName('name').setDescription(text.timer.describeName).setRequired(true).setMaxLength(50),
    )
    .addStringOption((o) =>
      o.setName('duration').setDescription(text.timer.describeDuration).setRequired(true).setMaxLength(20),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const name = interaction.options.getString('name', true).trim();
    const raw = interaction.options.getString('duration', true);
    const ms = parseDuration(raw);

    if (ms === null) {
      await interaction.reply({ content: text.timer.badDuration(raw), flags: MessageFlags.Ephemeral });
      return;
    }

    if (ms === 0) {
      const existed = timers.cancel(interaction.guildId, name);
      await interaction.reply({
        content: existed ? text.timer.cancelled(name) : text.timer.notFound(name),
        flags: existed ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    const result = timers.set(
      { name, guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id },
      ms,
    );
    if (!result.ok) {
      await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply(
      result.replaced ? text.timer.replaced(name, result.timer.dueAt) : text.timer.set(name, result.timer.dueAt),
    );
  },
};
