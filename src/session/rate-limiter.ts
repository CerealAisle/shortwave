/**
 * Two-part throttle:
 *   - a minimum gap between commands (stops a message burst turning into a
 *     stream of overlapping vibrations)
 *   - a sliding per-minute ceiling (stays well inside Lovense's API limits)
 *
 * Requests that don't fit are dropped, not queued. A buzz that arrives four
 * seconds late is worse than no buzz at all.
 */
export class RateLimiter {
  private lastAt = 0;
  private recent: number[] = [];

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxPerMinute: number,
  ) {}

  tryAcquire(now = Date.now()): { allowed: boolean; reason?: 'interval' | 'quota' } {
    if (now - this.lastAt < this.minIntervalMs) {
      return { allowed: false, reason: 'interval' };
    }

    const cutoff = now - 60_000;
    this.recent = this.recent.filter((t) => t > cutoff);

    if (this.recent.length >= this.maxPerMinute) {
      return { allowed: false, reason: 'quota' };
    }

    this.lastAt = now;
    this.recent.push(now);
    return { allowed: true };
  }

  reset(): void {
    this.lastAt = 0;
    this.recent = [];
  }
}
