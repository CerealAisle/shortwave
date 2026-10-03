import type { LovenseToy } from './types';

/**
 * Toys are addressed by name in commands. A link (one Lovense Remote app)
 * reports every toy paired to it in its callbacks, so a person's toys are
 * whatever their latest callback listed.
 */

export function isToyConnected(toy: LovenseToy): boolean {
  return String(toy.status) === '1';
}

/** What a person would call it: the nickname they set, else the model. */
export function toyLabel(toy: LovenseToy): string {
  return toy.nickName || toy.name || toy.id;
}

export type ToyResolution = { ok: true; toys: LovenseToy[] } | { ok: false; error: string };

function listing(toys: LovenseToy[]): string {
  return toys.map((t) => `\`${toyLabel(t)}\``).join(', ');
}

/**
 * Turn a `toy` option into the toys it means.
 *
 *  - No option: every connected toy, or every listed toy if none reports
 *    connected (the status may simply be stale).
 *  - Otherwise an exact toy ID (what autocomplete sends), or a nickname or
 *    model name, case-insensitive. A name two toys share is refused rather
 *    than guessed at.
 */
export function resolveToys(toys: LovenseToy[], query: string | null | undefined): ToyResolution {
  if (toys.length === 0) {
    return {
      ok: false,
      error:
        'the Lovense app has not reported any toys yet. Open Lovense Remote with the toy ' +
        'connected and wait for it to check in',
    };
  }

  const q = query?.trim().toLowerCase();
  if (!q) {
    const connected = toys.filter(isToyConnected);
    return { ok: true, toys: connected.length > 0 ? connected : toys };
  }

  const byId = toys.find((t) => t.id.toLowerCase() === q);
  if (byId) return { ok: true, toys: [byId] };

  const byName = toys.filter(
    (t) => toyLabel(t).toLowerCase() === q || t.name?.toLowerCase() === q,
  );
  if (byName.length === 1) return { ok: true, toys: byName };
  if (byName.length > 1) {
    return {
      ok: false,
      error: `more than one toy is called "${query}". Pick it from the suggestions instead`,
    };
  }

  return { ok: false, error: `no toy called "${query}". Toys: ${listing(toys)}` };
}

/** Autocomplete suggestions: label shown, toy ID sent. */
export function toyChoices(toys: LovenseToy[], typed: string): { name: string; value: string }[] {
  const q = typed.trim().toLowerCase();
  return toys
    .filter((t) => !q || toyLabel(t).toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
    .slice(0, 25)
    .map((t) => {
      const battery = t.battery !== undefined ? ` · ${t.battery}%` : '';
      const off = isToyConnected(t) ? '' : ' · disconnected';
      return { name: `${toyLabel(t)}${battery}${off}`.slice(0, 100), value: t.id };
    });
}
