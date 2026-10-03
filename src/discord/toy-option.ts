import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { resolveToys, toyChoices, toyLabel, type ToyResolution } from '../lovense/toys';
import type { LovenseToy } from '../lovense/types';
import type { ToyTease } from '../session/manager';
import { store, type ToyLink } from '../store/store';
import { text } from '../text';

/**
 * The optional `toy` argument shared by /tease, /buzz and /pattern.
 * Its suggestions come from the toys of whoever the command targets, so a
 * new toy shows up as soon as its app reports it — no deploy-commands.
 */
export const TOY_OPTION = 'toy';
export const TOY_OPTION_DESCRIPTION = text.toy.describe;

/**
 * Suggest the target's toys. `userOption` names the command's user option;
 * before one is picked, or for commands without one, it is the caller.
 */
export async function respondWithToys(
  interaction: AutocompleteInteraction,
  userOption?: string,
): Promise<void> {
  const picked = userOption ? interaction.options.get(userOption)?.value : undefined;
  const userId = typeof picked === 'string' ? picked : interaction.user.id;
  const link = interaction.guildId ? store.getByUser(interaction.guildId, userId) : null;
  await interaction.respond(link ? toyChoices(link.toys, interaction.options.getFocused()) : []);
}

/** The toys the command's `toy` option means for this link. */
export function toysFromOption(
  interaction: ChatInputCommandInteraction,
  link: ToyLink,
): ToyResolution {
  return resolveToys(link.toys, interaction.options.getString(TOY_OPTION));
}

/** "50% / 1.5s · 12 buzz(es) · 2 missed" */
export function describeTease(t: ToyTease): string {
  return text.teaseDetail(t.intensityPercent, t.durationSec, t.triggerCount, t.missedCount);
}

/** Bold, comma-separated names of teasing toys. */
export function names(teases: ToyTease[]): string {
  return teases.map((t) => `**${t.toyName}**`).join(', ');
}

/** The same, for toys straight from a link. */
export function toyNames(toys: LovenseToy[]): string {
  return toys.map((t) => `**${toyLabel(t)}**`).join(', ');
}
