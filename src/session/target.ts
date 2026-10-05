import { config } from '../config';
import { store, type ToyLink } from '../store/store';
import { text } from '../text';

/**
 * Commands act on one person: the wearer. Nobody picks them per command.
 *
 * TARGET_USER_ID names them. Each server runs its own instance with its own
 * .env, so staging can point at a different person. Unset, the target is
 * whoever is linked, as long as that is exactly one person — anything else
 * would be a guess.
 */
export type TargetResult =
  | { ok: true; userId: string; link: ToyLink | null }
  | { ok: false; error: string };

export function resolveTarget(guildId: string): TargetResult {
  if (config.TARGET_USER_ID) {
    return {
      ok: true,
      userId: config.TARGET_USER_ID,
      link: store.getByUser(guildId, config.TARGET_USER_ID),
    };
  }

  const links = store.listByGuild(guildId);
  const only = links.length === 1 ? links[0] : undefined;
  if (only) return { ok: true, userId: only.discordUserId, link: only };

  return { ok: false, error: links.length === 0 ? text.target.noneLinked : text.target.ambiguous };
}
