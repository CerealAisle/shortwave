import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { log } from '../logger';
import * as actions from './actions';
import type { ToyAction } from './types';

/**
 * Named vibration patterns, one JSON file each in PATTERNS_DIR. The filename
 * is the name: `patterns/slow-build.json` is `/pattern name:slow-build`.
 * Files starting with `_` (the template) are ignored.
 *
 * Files are read when the command runs, not at startup, so adding or editing
 * a pattern needs neither a restart nor `deploy-commands`.
 */

/** Lovense plays at most 50 strength values per pattern. */
export const MAX_STEPS = 50;
/** Lovense's floor for the gap between steps. */
export const MIN_INTERVAL_MS = 100;
/** Longest a pattern may run. /stop ends it sooner. */
export const MAX_DURATION_SEC = 3600;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const schema = z
  .object({
    description: z.string().max(80).optional(),
    intervalMs: z.number().int().min(MIN_INTERVAL_MS).max(60_000),
    steps: z.array(z.number().min(0).max(100)).min(1).max(MAX_STEPS),
    durationSec: z.number().min(1).max(MAX_DURATION_SEC).optional(),
  })
  .strict();

export interface Pattern {
  name: string;
  description: string;
  intervalMs: number;
  /** Strength of each step, as a percentage. */
  steps: number[];
  /** How long it plays. The steps loop until this runs out. */
  durationSec: number;
}

export type ParseResult = { ok: true; pattern: Pattern } | { ok: false; error: string };

/** One pass through the steps, which is the default length. */
export function onePassSec(intervalMs: number, steps: number): number {
  return (intervalMs * steps) / 1000;
}

export function parsePattern(name: string, json: string): ParseResult {
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: 'filename must be lowercase letters, digits, - or _, and at most 32 characters',
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return { ok: false, error: `${where}${issue?.message ?? 'invalid pattern'}` };
  }

  const { description, intervalMs, steps, durationSec } = parsed.data;
  return {
    ok: true,
    pattern: {
      name,
      description: description ?? '',
      intervalMs,
      steps,
      durationSec: actions.normaliseDuration(durationSec ?? onePassSec(intervalMs, steps.length)),
    },
  };
}

export function patternsDir(): string {
  return resolve(config.PATTERNS_DIR);
}

/** Pattern names available in `dir`, sorted. Ignores `_` files and non-JSON. */
export function listPatternNames(dir = patternsDir()): string[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    log.warn(`Cannot read patterns directory ${dir}: ${(err as Error).message}`);
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => basename(f, '.json'))
    .sort();
}

export function loadPattern(name: string, dir = patternsDir()): ParseResult {
  // Only ever names from the listing, so a crafted name can't reach outside
  // the directory.
  if (!listPatternNames(dir).includes(name)) {
    return { ok: false, error: `no pattern called "${name}"` };
  }
  return parsePattern(name, readFileSync(join(dir, `${name}.json`), 'utf8'));
}

/** Every pattern in `dir`, valid or not, for listings and tests. */
export function loadAllPatterns(dir = patternsDir()): { name: string; result: ParseResult }[] {
  return listPatternNames(dir).map((name) => ({ name, result: loadPattern(name, dir) }));
}

export function patternAction(pattern: Pattern): ToyAction {
  return actions.pattern(pattern.steps, pattern.intervalMs, pattern.durationSec);
}
