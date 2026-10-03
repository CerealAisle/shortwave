import type { ChatInputCommandInteraction } from 'discord.js';
import { log } from '../logger';

/**
 * /connect replies privately with a QR code. When the scan lands, that same
 * reply is edited to say it worked — so the confirmation answers the
 * command, rather than appearing in a channel on its own — and the QR code,
 * a credential, disappears with it.
 *
 * Discord only allows editing a reply for 15 minutes, so a scan after that
 * goes unconfirmed here; the status board still shows it.
 */
const EDIT_WINDOW_MS = 14 * 60_000;

const pending = new Map<string, { interaction: ChatInputCommandInteraction; at: number }>();

export function awaitScan(uid: string, interaction: ChatInputCommandInteraction): void {
  pending.set(uid, { interaction, at: Date.now() });
}

export async function confirmScan(uid: string, content: string): Promise<void> {
  const entry = pending.get(uid);
  pending.delete(uid);
  if (!entry || Date.now() - entry.at > EDIT_WINDOW_MS) return;
  try {
    await entry.interaction.editReply({ content, embeds: [] });
  } catch (err) {
    log.warn(`Could not confirm the scan for ${uid}: ${(err as Error).message}`);
  }
}
