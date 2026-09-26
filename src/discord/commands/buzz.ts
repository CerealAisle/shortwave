import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import * as actions from '../../lovense/actions';
import { LovenseError, makeUid } from '../../lovense/client';
import { sessions } from '../../session/manager';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

/**
 * Manual one-off: vibrate at X% for X seconds.
 *
 * This file is the template for new commands. The pattern is always:
 *   1. resolve the target link from the store
 *   2. build a ToyAction with a builder from lovense/actions
 *   3. hand it to sessions.sendNow() so it gets capped, logged and error-mapped
 * Then drop the file in this folder and run `npm run deploy-commands`.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('buzz')
    .setDescription('Vibrate a linked toy at a given strength for a given time')
    .addIntegerOption((o) =>
      o
        .setName('intensity')
        .setDescription('Strength as a percentage')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .addNumberOption((o) =>
      o
        .setName('seconds')
        .setDescription('How long to run')
        .setMinValue(1)
        .setMaxValue(300)
        .setRequired(true),
    )
    .addUserOption((o) =>
      o.setName('target').setDescription('Whose toy (defaults to yours)'),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const target = interaction.options.getUser('target') ?? interaction.user;
    const link = store.getByUser(interaction.guildId, target.id);

    if (!link) {
      await interaction.reply({
        content: `${target.displayName} has no toy linked in this server.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const intensity = interaction.options.getInteger('intensity', true);
    const seconds = interaction.options.getNumber('seconds', true);

    await interaction.deferReply();

    try {
      await sessions.sendNow(
        makeUid(interaction.guildId, target.id),
        actions.vibrate(intensity, seconds),
        `buzz:${interaction.user.id}`,
      );
      await interaction.editReply(
        `Sent: ${intensity}% for ${seconds}s. Use \`/stop\` to end it early.`,
      );
    } catch (err) {
      const message = err instanceof LovenseError ? err.message : (err as Error).message;
      await interaction.editReply(`Command failed: ${message}`);
    }
  },
};
