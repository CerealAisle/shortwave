import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { LovenseError, makeUid } from '../../lovense/client';
import { listPatternNames, loadAllPatterns, loadPattern, patternAction } from '../../lovense/patterns';
import { sessions } from '../../session/manager';
import { store } from '../../store/store';
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
    ),

  async autocomplete(interaction) {
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

    const { pattern } = loaded;
    await interaction.deferReply();

    try {
      await sessions.sendNow(
        makeUid(interaction.guildId, target.id),
        patternAction(pattern),
        `pattern:${pattern.name}:${interaction.user.id}`,
      );
      await interaction.editReply(
        `Playing **${pattern.name}** for ${pattern.durationSec}s. Use \`/stop\` to end it early.`,
      );
    } catch (err) {
      const message = err instanceof LovenseError ? err.message : (err as Error).message;
      await interaction.editReply(`Command failed: ${message}`);
    }
  },
};
