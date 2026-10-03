import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { LovenseError, makeUid } from '../../lovense/client';
import { listPatternNames, loadAllPatterns, loadPattern, patternAction } from '../../lovense/patterns';
import { sessions } from '../../session/manager';
import { resolveToys } from '../../lovense/toys';
import { store } from '../../store/store';
import {
  TOY_OPTION,
  TOY_OPTION_DESCRIPTION,
  respondWithToys,
  toyNames,
} from '../toy-option';
import { refuseIfStopped } from '../lockout';
import type { BotCommand } from '../types';

/**
 * Play a named pattern from the patterns directory. One-shot: it runs for the
 * pattern's duration and then stops on the toy by itself. `/stop` ends it
 * sooner; it goes through sendNow like everything else, so the intensity cap
 * and the command log apply.
 *
 * The name autocompletes from the directory, so a new pattern file shows up
 * here without re-running deploy-commands.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('pattern')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription('Play a named pattern on a linked toy')
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('Which pattern (from the patterns folder)')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addUserOption((o) =>
      o.setName('target').setDescription('Whose toy (defaults to yours)'),
    )
    .addStringOption((o) =>
      o.setName(TOY_OPTION).setDescription(TOY_OPTION_DESCRIPTION).setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    if (interaction.options.getFocused(true).name === TOY_OPTION) {
      await respondWithToys(interaction, 'target');
      return;
    }

    const typed = interaction.options.getFocused().toLowerCase();
    const choices = loadAllPatterns()
      .filter(({ name }) => name.includes(typed))
      .slice(0, 25)
      .map(({ name, result }) => {
        const detail = result.ok
          ? `${result.pattern.durationSec}s${result.pattern.description ? ` · ${result.pattern.description}` : ''}`
          : 'invalid file — see /pattern';
        return { name: `${name} — ${detail}`.slice(0, 100), value: name };
      });
    await interaction.respond(choices);
  },

  async execute(interaction) {
    if (!interaction.guildId) return;
    if (await refuseIfStopped(interaction)) return;

    const name = interaction.options.getString('name', true);
    const loaded = loadPattern(name);

    if (!loaded.ok) {
      const available = listPatternNames();
      await interaction.reply({
        content:
          `Cannot play "${name}": ${loaded.error}.\n` +
          (available.length > 0
            ? `Available: ${available.map((n) => `\`${n}\``).join(', ')}`
            : 'There are no patterns yet. Copy `patterns/_template.json` to add one.'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const target = interaction.options.getUser('target') ?? interaction.user;
    const link = store.getByUser(interaction.guildId, target.id);
    if (!link) {
      await interaction.reply({
        content: `${target.displayName} has no toy linked in this server.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // No toy named: one command to every toy. Named: just that one.
    const query = interaction.options.getString(TOY_OPTION);
    const resolved = query ? resolveToys(link.toys, query) : null;
    if (resolved && !resolved.ok) {
      await interaction.reply({
        content: `Cannot play "${name}": ${resolved.error}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const toyIds = resolved?.ok ? resolved.toys.map((t) => t.id) : [undefined];
    const which = resolved?.ok ? ` on ${toyNames(resolved.toys)}` : '';

    const { pattern } = loaded;
    await interaction.deferReply();

    try {
      for (const toyId of toyIds) {
        await sessions.sendNow(
          makeUid(interaction.guildId, target.id),
          patternAction(pattern),
          `pattern:${pattern.name}:${interaction.user.id}`,
          { toyId },
        );
      }
      await interaction.editReply(
        `Playing **${pattern.name}** for ${pattern.durationSec}s${which}. Use \`/stop\` to end it early.`,
      );
    } catch (err) {
      const message = err instanceof LovenseError ? err.message : (err as Error).message;
      await interaction.editReply(`Command failed: ${message}`);
    }
  },
};
