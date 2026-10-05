import type { AutocompleteInteraction } from 'discord.js';
import { toyChoices } from '../lovense/toys';
import type { Session } from '../session/manager';
import { resolveTarget } from '../session/target';
import { text } from '../text';

/** The value the "All connected toys" suggestion sends. */
export const ALL_TOYS = 'all';

/**
 * Suggestions for /focus: "All connected toys" first, then each of the
 * target's toys. New toys appear as soon as Lovense Remote reports them.
 */
export async function respondWithFocusChoices(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused();
  const target = interaction.guildId ? resolveTarget(interaction.guildId) : null;
  const toys = target?.ok && target.link ? toyChoices(target.link.toys, typed) : [];
  const showAll = !typed.trim() || text.focus.allChoice.toLowerCase().includes(typed.trim().toLowerCase());
  await interaction.respond(
    [...(showAll ? [{ name: text.focus.allChoice, value: ALL_TOYS }] : []), ...toys].slice(0, 25),
  );
}

/** "50% / 1.5s · 12 buzz(es) · 2 missed" */
export function describeTease(s: Session): string {
  return text.teaseDetail(s.intensityPercent, s.durationSec, s.triggerCount, s.missedCount);
}
