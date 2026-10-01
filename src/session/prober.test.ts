import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextProbeAt } from './prober';

/**
 * The probe sends Vibrate:0. It moves nothing on its own, but it does replace
 * whatever is running, so "never while busy" is the property that matters
 * most here. The backoff keeps a dead link from filling the log.
 */

const ONLINE = 300_000;
const OFFLINE = 900_000;
const T = 1_000_000_000;

function due(over: Partial<Parameters<typeof nextProbeAt>[0]> = {}) {
  return nextProbeAt({
    lastResult: null,
    lastSeen: T - 10_000,
    busyUntil: 0,
    onlineIntervalMs: ONLINE,
    offlineIntervalMs: OFFLINE,
    ...over,
  });
}

describe('nextProbeAt', () => {
  it('never probes a link whose QR was never scanned', () => {
    assert.equal(due({ lastSeen: null }), null);
  });

  it('never probes when probing is disabled', () => {
    assert.equal(due({ onlineIntervalMs: 0 }), null);
  });

  it('probes straight away when nothing has been sent yet', () => {
    assert.equal(due(), 0);
  });

  it('waits the online interval after a 200 — from any command, not just a probe', () => {
    assert.equal(due({ lastResult: { at: T, ok: true } }), T + ONLINE);
  });

  it('backs off to the offline interval after a failure', () => {
    assert.equal(due({ lastResult: { at: T, ok: false, code: 507 }, lastSeen: T - 1 }), T + OFFLINE);
  });

  it('checks again as soon as a callback arrives after a failure', () => {
    // The app re-registered with Lovense; waiting out the backoff would leave
    // the session paused for no reason.
    const result = { at: T, ok: false, code: 507 };
    assert.equal(due({ lastResult: result, lastSeen: T + 5_000 }), T + 5_000);
  });

  it('never fires while a command is still running on the toy', () => {
    const busyUntil = T + ONLINE + 60_000;
    assert.equal(due({ lastResult: { at: T, ok: true }, busyUntil }), busyUntil);
    assert.equal(due({ busyUntil }), busyUntil);
  });
});
