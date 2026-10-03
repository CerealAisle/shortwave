import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { sessions } from '../session/manager';
import { text } from '../text';

/**
 * For commands that would start something: refuse, and say until when, if
 * a /stop lockout is running. Returns true when it refused. sendNow enforces
 * the lockout regardless; this just gives a clear answer instead of an error.
 */
export async function refuseIfStopped(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const lock = interaction.guildId ? sessions.lockout(interaction.guildId) : null;
  if (!lock) return false;
  await interaction.reply({
    content: text.common.stopped(lock.by, lock.until),
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
