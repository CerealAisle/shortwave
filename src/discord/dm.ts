import type { Client } from 'discord.js';
import { log } from '../logger';

/**
 * DM a user. Best effort: Discord refuses DMs from bots to people who have
 * them disabled, and that must not abort the command that sent it.
 * Resolves to whether it was delivered.
 */
export async function dm(client: Client, userId: string, content: string): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(content);
    log.debug(`DM sent to ${userId}`);
    return true;
  } catch (err) {
    log.warn(
      `Could not DM ${userId} (${(err as Error).message}). ` +
        'They may have DMs from server members turned off.',
    );
    return false;
  }
}
