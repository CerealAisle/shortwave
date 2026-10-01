import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../config';
import { channelRole } from './channels';

describe('channelRole', () => {
  it('recognises the main channel', () => {
    assert.equal(channelRole(config.MAIN_CHANNEL_ID), 'main');
  });

  it('recognises the command channel', () => {
    assert.equal(channelRole(config.COMMAND_CHANNEL_ID), 'command');
  });

  it('refuses every other channel, including none at all', () => {
    for (const id of ['999', '', null, undefined]) {
      assert.equal(channelRole(id), null, `${String(id)} should have no role`);
    }
  });
});
