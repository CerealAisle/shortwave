import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import * as actions from '../../lovense/actions';
import { makeUid } from '../../lovense/client';
import { focusTargets, getFocus } from '../../session/focus';
import { sessions } from '../../session/manager';
import { text } from '../../text';
import { failureText } from '../failure';
import { refuseIfStopped } from '../lockout';
import { requireTarget } from '../target';
import type { BotCommand } from '../types';

/**
 * Manual one-off: vibrate her focused toys at X% for X seconds.
 *
 * This file is the template for new commands. The pattern is always:
 *   1. find the target, and the toys the focus means right now
 *   2. build a ToyAction with a builder from lovense/actions
 *   3. hand it to sessions.sendNow() so it gets capped, logged and error-mapped
 *      — once with no toyId for every toy, or once per focused toy
 * Then drop the file in this folder and run `npm run deploy-commands`.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('buzz')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.buzz.describe)
    .addIntegerOption((o) =>
      o
        .setName('intensity')
        .setDescription(text.buzz.describeIntensity)
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .addNumberOption((o) =>
      o
        .setName('seconds')
        .setDescription(text.buzz.describeSeconds)
        .setMinValue(1)
        .setMaxValue(300)
        .setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;
    if (await refuseIfStopped(interaction)) return;

    const target = await requireTarget(interaction);
    if (!target) return;

    const targets = focusTargets(target.link, getFocus(interaction.guildId, target.userId));
    if (!targets.ok) {
      await interaction.reply({ content: text.buzz.cannot(targets.error), flags: MessageFlags.Ephemeral });
      return;
    }

    const intensity = interaction.options.getInteger('intensity', true);
    const seconds = interaction.options.getNumber('seconds', true);

    await interaction.deferReply();

    try {
      for (const toyId of targets.toyIds ?? [undefined]) {
        await sessions.sendNow(
          makeUid(interaction.guildId, target.userId),
          actions.vibrate(intensity, seconds),
          `buzz:${interaction.user.id}`,
          { toyId },
        );
      }
      await interaction.editReply(text.buzz.sent(intensity, seconds, targets.label));
    } catch (err) {
      await interaction.editReply(failureText(err));
    }
  },
};
