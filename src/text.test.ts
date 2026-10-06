import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixStepsFor } from './discord/commands/test';
import { loadCommands } from './discord/registry';
import { text } from './text';

/**
 * text.ts is meant to be edited by hand. These catch the edits Discord
 * would otherwise reject at `deploy-commands` time, or that would leave a
 * message empty.
 */

describe('command text', () => {
  const commands = [...loadCommands().values()].map((c) => c.data.toJSON());

  it('every command and option description fits Discord\'s 100-character limit', () => {
    for (const cmd of commands) {
      assert.ok(cmd.description.length <= 100, `/${cmd.name}: ${cmd.description.length} chars`);
      for (const opt of cmd.options ?? []) {
        assert.ok(
          opt.description.length <= 100,
          `/${cmd.name} ${opt.name}: ${opt.description.length} chars`,
        );
      }
    }
  });

  it('no description is empty', () => {
    for (const cmd of commands) {
      assert.ok(cmd.description.trim(), `/${cmd.name} has no description`);
      for (const opt of cmd.options ?? []) {
        assert.ok(opt.description.trim(), `/${cmd.name} ${opt.name} has no description`);
      }
    }
  });
});

describe('fix-it steps', () => {
  it('every set of steps is written, and @s the person it is for', () => {
    for (const [kind, steps] of Object.entries(text.fixSteps)) {
      const body = steps('123');
      assert.ok(body.length > 40, `text.fixSteps.${kind} looks empty`);
      assert.ok(body.startsWith('<@123>'), `text.fixSteps.${kind} should start with the @mention`);
    }
  });

  it('a backgrounded app gets the force-quit steps', () => {
    assert.equal(fixStepsFor({ ok: false, code: 507, message: '' }, true), 'backgrounded');
    assert.match(text.fixSteps.backgrounded('1'), /Force-quit/);
  });

  it('a closed app, a lost link and a network failure each get their own steps', () => {
    assert.equal(fixStepsFor({ ok: false, code: 507, message: '' }, false), 'appClosed');
    assert.equal(fixStepsFor({ ok: false, code: 503, message: '' }, false), 'unlinked');
    assert.equal(fixStepsFor({ ok: false, code: undefined, message: '' }, false), 'network');
  });

  it('sends nothing for problems only the controller can fix', () => {
    // A bad developer token or a bot bug: nothing for the wearer to do.
    for (const code of [400, 404, 501, 502]) {
      assert.equal(fixStepsFor({ ok: false, code, message: '' }, false), null, `${code}`);
    }
  });

  it('sends nothing when the test passed', () => {
    assert.equal(fixStepsFor({ ok: true }, true), null);
  });
});
