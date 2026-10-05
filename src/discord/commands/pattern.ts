import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { makeUid } from '../../lovense/client';
import {
  MAX_DURATION_SEC,
  listPatternNames,
  loadAllPatterns,
  loadPattern,
  patternAction,
} from '../../lovense/patterns';
import { focusTargets, getFocus } from '../../session/focus';
import { sessions } from '../../session/manager';
import { text } from '../../text';
import { failureText } from '../failure';
import { refuseIfStopped } from '../lockout';
import { requireTarget } from '../target';
import type { BotCommand } from '../types';

/**
 * Play a named pattern from the patterns directory on her focused toys.
 * `minutes` overrides how long it plays — Lovense loops the steps — so a
 * short pattern can run for a while. One-shot: it runs for that long and then stops on the toy by
 * itself. `/stop` ends it sooner; it goes through sendNow like everything
 * else, so the intensity cap and the command log apply.
 *
 * The name autocompletes from the directory, so a new pattern file shows up
 * here without re-running deploy-commands.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('pattern')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.pattern.describe)
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription(text.pattern.describeName)
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addNumberOption((o) =>
      o
        .setName('minutes')
        .setDescription(text.pattern.describeMinutes(MAX_DURATION_SEC / 60))
        .setMinValue(0.1)
        .setMaxValue(MAX_DURATION_SEC / 60),
    ),

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const choices = loadAllPatterns()
      .filter(({ name }) => name.includes(typed))
      .slice(0, 25)
      .map(({ name, result }) => {
        const detail = result.ok
          ? `${result.pattern.durationSec}s${result.pattern.description ? ` · ${result.pattern.description}` : ''}`
          : text.pattern.invalidSuggestion;
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
          `${text.pattern.cannotPlay(name, loaded.error)}\n` +
          (available.length > 0
            ? text.pattern.available(available.map((n) => `\`${n}\``).join(', '))
            : text.pattern.noPatterns),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const target = await requireTarget(interaction);
    if (!target) return;

    const targets = focusTargets(target.link, getFocus(interaction.guildId, target.userId));
    if (!targets.ok) {
      await interaction.reply({
        content: text.pattern.cannot(name, targets.error),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { pattern } = loaded;
    const minutes = interaction.options.getNumber('minutes');
    const durationSec = minutes !== null ? Math.round(minutes * 60) : pattern.durationSec;
    await interaction.deferReply();

    try {
      for (const toyId of targets.toyIds ?? [undefined]) {
        await sessions.sendNow(
          makeUid(interaction.guildId, target.userId),
          patternAction(pattern, durationSec),
          `pattern:${pattern.name}:${interaction.user.id}`,
          { toyId },
        );
      }
      await interaction.editReply(
        text.pattern.playing(pattern.name, durationSec, targets.label, Date.now() + durationSec * 1000),
      );
    } catch (err) {
      await interaction.editReply(failureText(err));
    }
  },
};
