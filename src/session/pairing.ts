/**
 * Scans the bot is waiting for. /connect adds one; the next callback for
 * that link is then treated as a fresh pairing — announced, like the very
 * first — rather than as one more heartbeat. Without this, re-pairing (a new
 * phone, after staging) went unannounced, because the link had been seen
 * before. In memory only: a scan that outlives a restart is just a heartbeat.
 */
const expected = new Set<string>();

export function expectScan(uid: string): void {
  expected.add(uid);
}

/** True, once, if a scan was expected for this link. */
export function takeExpectedScan(uid: string): boolean {
  return expected.delete(uid);
}
