import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CONFIG_KEYS } from './config';

/**
 * Tests load .env.test first, then dotenv fills in whatever is still unset
 * from the host's real .env. So a setting missing from .env.test takes the
 * host's value — on the VM, a real TARGET_USER_ID made the target tests fail.
 * Every setting must be pinned here, even if blank.
 */
describe('.env.test', () => {
  it('pins every setting, so the host .env cannot leak into the tests', () => {
    const pinned = new Set(
      readFileSync('.env.test', 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => line.slice(0, line.indexOf('='))),
    );
    const missing = CONFIG_KEYS.filter((k) => !pinned.has(k));
    assert.deepEqual(missing, [], `add to .env.test: ${missing.join(', ')}`);
  });
});
