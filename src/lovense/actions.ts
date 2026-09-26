import { config } from '../config';
import type { PresetName, ToyAction } from './types';

/**
 * Lovense strength scale for Vibrate/Rotate is 0-20 (Pump is 0-3).
 * The bot speaks in percentages everywhere and converts here, so all
 * clamping and the global intensity ceiling live in one place.
 */
export const LOVENSE_MAX_LEVEL = 20;

export function percentToLevel(percent: number): number {
  const capped = Math.min(Math.max(percent, 0), config.MAX_INTENSITY_PERCENT);
  const level = Math.round((capped / 100) * LOVENSE_MAX_LEVEL);
  // Never silently turn a non-zero request into a no-op.
  if (capped > 0 && level === 0) return 1;
  return level;
}

export function levelToPercent(level: number): number {
  return Math.round((level / LOVENSE_MAX_LEVEL) * 100);
}

/**
 * Lovense requires timeSec > 1 (0 means "run forever"). We refuse to emit
 * an accidental indefinite command, so anything shorter is floored.
 */
const MIN_TIME_SEC = 1.1;

export function normaliseDuration(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return MIN_TIME_SEC;
  return Math.max(seconds, MIN_TIME_SEC);
}

// ---------------------------------------------------------------------------
// Builders. Add new ones here; every command in the bot goes through these.
// ---------------------------------------------------------------------------

export function vibrate(percent: number, seconds: number): ToyAction {
  return {
    kind: 'function',
    action: `Vibrate:${percentToLevel(percent)}`,
    timeSec: normaliseDuration(seconds),
  };
}

/** The short nudge sent on each qualifying Discord message. */
export function buzz(
  percent = config.BUZZ_INTENSITY_PERCENT,
  seconds = config.BUZZ_DURATION_SEC,
): ToyAction {
  return vibrate(percent, seconds);
}

/** Vibrate `runSec` on, `pauseSec` off, repeating for `totalSec`. */
export function pulse(
  percent: number,
  totalSec: number,
  runSec: number,
  pauseSec: number,
): ToyAction {
  return {
    kind: 'function',
    action: `Vibrate:${percentToLevel(percent)}`,
    timeSec: normaliseDuration(totalSec),
    loopRunningSec: Math.max(runSec, 1.1),
    loopPauseSec: Math.max(pauseSec, 1.1),
  };
}

/** Arbitrary strength sequence; `intervalMs` between steps (min 100). */
export function pattern(
  percents: number[],
  intervalMs: number,
  totalSec: number,
): ToyAction {
  const strengths = percents.slice(0, 50).map(percentToLevel).join(';');
  return {
    kind: 'pattern',
    rule: `V:1;F:v;S:${Math.max(Math.round(intervalMs), 100)}#`,
    strength: strengths,
    timeSec: normaliseDuration(totalSec),
  };
}

/** Ramp from `fromPercent` to `toPercent` over `steps` increments. */
export function ramp(
  fromPercent: number,
  toPercent: number,
  steps: number,
  totalSec: number,
): ToyAction {
  const n = Math.min(Math.max(steps, 2), 50);
  const values = Array.from({ length: n }, (_, i) =>
    fromPercent + ((toPercent - fromPercent) * i) / (n - 1),
  );
  return pattern(values, (totalSec * 1000) / n, totalSec);
}

export function preset(name: PresetName, seconds: number): ToyAction {
  return { kind: 'preset', name, timeSec: normaliseDuration(seconds) };
}

export function stop(): ToyAction {
  return { kind: 'function', action: 'Stop', timeSec: 0 };
}
