import { isToyConnected, toyLabel } from '../lovense/toys';
import { store, type ToyLink } from '../store/store';
import { text } from '../text';

/**
 * Which of the target's toys commands reach: all connected toys, or one.
 * Set with /focus, saved so a restart keeps it, and read afresh by every
 * command and every tease trigger — so a change applies straight away,
 * including to tease already running.
 */
export type Focus = { kind: 'all' } | { kind: 'toy'; id: string; label: string };

const ALL: Focus = { kind: 'all' };

function key(guildId: string, userId: string): string {
  return `focus:${guildId}:${userId}`;
}

export function getFocus(guildId: string, userId: string): Focus {
  const raw = store.getSetting(key(guildId, userId));
  if (!raw) return ALL;
  try {
    const parsed = JSON.parse(raw) as Focus;
    return parsed.kind === 'toy' && parsed.id ? parsed : ALL;
  } catch {
    return ALL;
  }
}

export function setFocus(guildId: string, userId: string, focus: Focus): void {
  store.setSetting(key(guildId, userId), JSON.stringify(focus));
}

export type FocusTargets =
  /** `toyIds` undefined means one command to every toy on the app. */
  | { ok: true; toyIds: string[] | undefined; label: string }
  | { ok: false; error: string };

/**
 * The toys a command should reach right now, from the link's latest check-in.
 *
 *  - all: one untargeted command, which Lovense delivers to every toy
 *    connected to the app at that moment. Refused only when the app lists
 *    toys and none of them is connected.
 *  - one toy: that toy by ID, and only if the app reports it connected. A
 *    toy that isn't the focus is never addressed, even if it just connected.
 */
export function focusTargets(link: ToyLink, focus: Focus): FocusTargets {
  if (focus.kind === 'all') {
    if (link.toys.length > 0 && !link.toys.some(isToyConnected)) {
      return { ok: false, error: text.focus.noneConnected };
    }
    return { ok: true, toyIds: undefined, label: text.focus.allLabel };
  }

  const toy = link.toys.find((t) => t.id === focus.id);
  const label = toy ? toyLabel(toy) : focus.label;
  if (!toy) return { ok: false, error: text.focus.focusedGone(label) };
  if (!isToyConnected(toy)) return { ok: false, error: text.focus.focusedDisconnected(label) };
  return { ok: true, toyIds: [toy.id], label };
}

/** How to name the focus, e.g. "all connected toys" or "Lush 3". */
export function focusLabel(focus: Focus, link: ToyLink | null): string {
  if (focus.kind === 'all') return text.focus.allLabel;
  const toy = link?.toys.find((t) => t.id === focus.id);
  return toy ? toyLabel(toy) : focus.label;
}
