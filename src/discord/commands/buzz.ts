import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import * as actions from '../../lovense/actions';
import { makeUid } from '../../lovense/client';
import { failureText } from '../failure';
import { sessions } from '../../session/manager';
import { store } from '../../store/store';
import { resolveToys } from '../../lovense/toys';
import {
  TOY_OPTION,
  TOY_OPTION_DESCRIPTION,
  respondWithToys,
  toyNames,
} from '../toy-option';
import { refuseIfStopped } from '../lockout';
import { text } from '../../text';
import type { BotCommand } from '../types';

/**
 * Manual one-off: vibrate at X% for X seconds.
 *
 * This file is the template for new commands. The pattern is always:
 *   1. resolve the target link from the store, and the toy if one was named
 *   2. build a ToyAction with a builder from lovense/actions
 *   3. hand it to sessions.sendNow() so it gets capped, logged and error-mapped
 *      — once with no toyId for every toy, or once per named toy
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
    )
    .addUserOption((o) =>
      o.setName('target').setDescription(text.buzz.describeTarget),
    )
    .addStringOption((o) =>
      o.setName(TOY_OPTION).setDescription(TOY_OPTION_DESCRIPTION).setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    await respondWithToys(interaction, 'target');
  },

  async execute(interaction) {
    if (!interaction.guildId) return;
    if (await refuseIfStopped(interaction)) return;

    const target = interaction.options.getUser('target') ?? interaction.user;
    const link = store.getByUser(interaction.guildId, target.id);

    if (!link) {
      await interaction.reply({
        content: text.common.noToy(target.id === interaction.user.id, target.displayName),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // No toy named: one command to every toy, as before. Named: just that one.
    const query = interaction.options.getString(TOY_OPTION);
    const resolved = query ? resolveToys(link.toys, query) : null;
    if (resolved && !resolved.ok) {
      await interaction.reply({
        content: text.buzz.badToy(resolved.error),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const toyIds = resolved?.ok ? resolved.toys.map((t) => t.id) : [undefined];
    const which = resolved?.ok ? toyNames(resolved.toys) : null;

    const intensity = interaction.options.getInteger('intensity', true);
    const seconds = interaction.options.getNumber('seconds', true);

    await interaction.deferReply();

    try {
      for (const toyId of toyIds) {
        await sessions.sendNow(
          makeUid(interaction.guildId, target.id),
          actions.vibrate(intensity, seconds),
          `buzz:${interaction.user.id}`,
          { toyId },
        );
      }
      await interaction.editReply(text.buzz.sent(intensity, seconds, which));
    } catch (err) {
      await interaction.editReply(failureText(err));
    }
  },
};
