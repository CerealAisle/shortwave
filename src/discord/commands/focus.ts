import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isToyConnected, resolveToys, toyLabel } from '../../lovense/toys';
import { setFocus } from '../../session/focus';
import { text } from '../../text';
import { requireTarget } from '../target';
import { ALL_TOYS, respondWithFocusChoices } from '../toy-option';
import type { BotCommand } from '../types';

/**
 * Which of her toys /tease, /buzz and /pattern reach: all connected toys,
 * or one. Saved, and read afresh by every command and every tease buzz, so
 * it applies straight away — including to tease already running.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('focus')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.focus.describe)
    .addStringOption((o) =>
      o.setName('toy').setDescription(text.focus.describeToy).setRequired(true).setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    await respondWithFocusChoices(interaction);
  },

  async execute(interaction) {
    if (!interaction.guildId) return;
    const target = await requireTarget(interaction);
    if (!target) return;

    const choice = interaction.options.getString('toy', true).trim();

    if (choice.toLowerCase() === ALL_TOYS || choice.toLowerCase() === text.focus.allChoice.toLowerCase()) {
      setFocus(interaction.guildId, target.userId, { kind: 'all' });
      await interaction.reply(text.focus.setAll(target.name));
      return;
    }

    const resolved = resolveToys(target.link.toys, choice);
    const toy = resolved.ok ? resolved.toys[0] : undefined;
    if (!resolved.ok || !toy) {
      await interaction.reply({
        content: text.focus.badToy(resolved.ok ? text.toy.noneReported : resolved.error),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const label = toyLabel(toy);
    setFocus(interaction.guildId, target.userId, { kind: 'toy', id: toy.id, label });
    await interaction.reply(
      text.focus.setToy(label) + (isToyConnected(toy) ? '' : text.focus.setToyDisconnected(label)),
    );
  },
};
