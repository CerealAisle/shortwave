import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAppOnline, preview } from './socket';

/**
 * Lovense documents the Socket API's events but not their payloads, so the
 * parser accepts every plausible shape and says "don't know" otherwise,
 * rather than guessing.
 */
describe('parseAppOnline', () => {
  it('reads a status flag', () => {
    assert.equal(parseAppOnline({ status: 1 }), true);
    assert.equal(parseAppOnline({ status: 0 }), false);
  });

  it('reads an online flag', () => {
    assert.equal(parseAppOnline({ online: true }), true);
    assert.equal(parseAppOnline({ online: false }), false);
  });

  it('reads a JSON string, and a body wrapped in data', () => {
    assert.equal(parseAppOnline('{"status":"1"}'), true);
    assert.equal(parseAppOnline({ data: { online: 0 } }), false);
  });

  it("says it doesn't know rather than guess", () => {
    assert.equal(parseAppOnline({ toyList: [] }), null);
    assert.equal(parseAppOnline('not json'), null);
    assert.equal(parseAppOnline(null), null);
    assert.equal(parseAppOnline({ status: 'weird' }), null);
  });
});

describe('preview', () => {
  it('keeps log lines short', () => {
    assert.ok(preview({ x: 'y'.repeat(1000) }).length <= 401);
  });
});
