import { MessageFlags, time, userMention, type ChatInputCommandInteraction } from 'discord.js';
import { sessions, type Lockout } from '../session/manager';

export function describeLockout(lock: Lockout): string {
  return (
    `Stopped by ${userMention(lock.by)} — nothing can start ` +
    `${time(Math.floor(lock.until / 1000), 'R')}`
  );
}

/**
 * For commands that would start something: refuse, and say until when, if
 * a /stop lockout is running. Returns true when it refused. sendNow enforces
 * the lockout regardless; this just gives a clear answer instead of an error.
 */
export async function refuseIfStopped(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const lock = interaction.guildId ? sessions.lockout(interaction.guildId) : null;
  if (!lock) return false;
  await interaction.reply({
    content: `${describeLockout(lock)}.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
