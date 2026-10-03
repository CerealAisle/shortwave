import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { resolveToys } from '../../lovense/toys';
import { sessionTotals, sessions } from '../../session/manager';
import { store } from '../../store/store';
import {
  TOY_OPTION,
  names,
  respondWithToys,
} from '../toy-option';
import type { BotCommand } from '../types';

/**
 * Never gated: it acts on the caller's own toys whoever started the tease,
 * and has no owner or permission check. See manager.test.ts.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('off')
    .setDescription('Turn tease off on your toys — messages stop triggering buzzes')
    .addStringOption((o) =>
      o
        .setName(TOY_OPTION)
        .setDescription('Just this toy (defaults to all of yours)')
        .setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    await respondWithToys(interaction);
  },

  async execute(interaction) {
    if (!interaction.guildId) return;

    const query = interaction.options.getString(TOY_OPTION);
    let toyIds: string[] | undefined;

    if (query) {
      const link = store.getByUser(interaction.guildId, interaction.user.id);
      const resolved = resolveToys(link?.toys ?? [], query);
      if (!resolved.ok) {
        await interaction.reply({
          content: `Cannot turn that off: ${resolved.error}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      toyIds = resolved.toys.map((t) => t.id);
    }

    const result = sessions.disarm(interaction.guildId, interaction.user.id, { toyIds });

    if (!result || result.removed.length === 0) {
      await interaction.reply({
        content: query ? 'Tease was not on for that toy. Nothing to do.' : 'Tease was not on. Nothing to do.',
      });
      return;
    }

    const { session, removed, ended } = result;
    const buzzes = removed.reduce((n, t) => n + t.triggerCount, 0);
    const missed = removed.reduce((n, t) => n + t.missedCount, 0);
    const minutes = Math.max(
      1,
      Math.round((Date.now() - Math.min(...removed.map((t) => t.armedAt))) / 60_000),
    );
    const still = ended
      ? ''
      : `\nStill on: ${names([...session.toys.values()])} (${sessionTotals(session).buzzes} buzz(es)).`;

    await interaction.reply({
      content:
        `**Tease off** for ${names(removed)}. ${buzzes} buzz(es)` +
        `${missed > 0 ? `, ${missed} missed` : ''} over ${minutes} minute(s). ` +
        'A stop command has been sent.' +
        still,
    });
  },
};
