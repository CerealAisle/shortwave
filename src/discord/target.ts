import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { resolveTarget } from '../session/target';
import type { ToyLink } from '../store/store';
import { text } from '../text';

export interface Target {
  userId: string;
  link: ToyLink;
  /** Their display name, as stored when they linked. */
  name: string;
  /** Whether the person running the command is the target. */
  self: boolean;
}

/**
 * The person this command acts on, or null after replying with why there
 * isn't one: no target configured or guessable, not linked, or (with
 * `scanned`) linked but the QR code never scanned.
 */
export async function requireTarget(
  interaction: ChatInputCommandInteraction,
  opts: { scanned?: boolean } = {},
): Promise<Target | null> {
  const refuse = async (content: string) => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return null;
  };

  const resolved = resolveTarget(interaction.guildId!);
  if (!resolved.ok) return refuse(resolved.error);

  const self = resolved.userId === interaction.user.id;
  if (!resolved.link) {
    const name = (await interaction.guild?.members.fetch(resolved.userId).catch(() => null))?.displayName;
    return refuse(text.common.noToy(self, name ?? 'They'));
  }

  const target = { userId: resolved.userId, link: resolved.link, name: resolved.link.displayName, self };
  if (opts.scanned && target.link.lastSeen === null) return refuse(text.common.notScanned(self, target.name));
  return target;
}
