import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LOVENSE_MAX_LEVEL } from './actions';
import {
  MAX_STEPS,
  listPatternNames,
  loadAllPatterns,
  loadPattern,
  parsePattern,
  patternAction,
  patternsDir,
} from './patterns';

/**
 * Pattern files are hand-written, so these check that a mistake in one is
 * caught here — by `npm test`, before deploy — rather than in Discord, and
 * that no file can produce a command outside the device's range.
 */

const good = { intervalMs: 500, steps: [20, 40, 60] };
const parse = (obj: unknown, name = 'test') => parsePattern(name, JSON.stringify(obj));

describe('the shipped patterns', () => {
  it('every file in patterns/ is valid', () => {
    const all = loadAllPatterns();
    assert.ok(all.length > 0, `no patterns found in ${patternsDir()}`);
    for (const { name, result } of all) {
      assert.ok(result.ok, `patterns/${name}.json: ${result.ok ? '' : result.error}`);
    }
  });

  it('the template is valid, so a copy of it works as-is', () => {
    const json = readFileSync(join(patternsDir(), '_template.json'), 'utf8');
    const result = parsePattern('template', json);
    assert.ok(result.ok, result.ok ? '' : result.error);
  });

  it('the template is not offered as a pattern', () => {
    assert.ok(!listPatternNames().some((n) => n.startsWith('_')));
  });
});

describe('parsePattern', () => {
  it('plays the steps once when no duration is given', () => {
    const r = parse({ intervalMs: 1000, steps: [10, 20, 30, 40] });
    assert.ok(r.ok);
    assert.equal(r.pattern.durationSec, 4);
  });

  it('never produces a duration Lovense would read as "run forever"', () => {
    const r = parse({ intervalMs: 100, steps: [50] });
    assert.ok(r.ok);
    assert.ok(r.pattern.durationSec > 1);
  });

  it('rejects files that would break the command', () => {
    const cases: [string, unknown][] = [
      ['no steps', { intervalMs: 500, steps: [] }],
      ['too many steps', { intervalMs: 500, steps: new Array(MAX_STEPS + 1).fill(10) }],
      ['strength over 100', { intervalMs: 500, steps: [50, 150] }],
      ['negative strength', { intervalMs: 500, steps: [-10] }],
      ['interval under 100ms', { intervalMs: 50, steps: [50] }],
      ['missing interval', { steps: [50] }],
      ['endless duration', { ...good, durationSec: 0 }],
      ['over an hour', { ...good, durationSec: 7200 }],
      ['a misspelt field', { ...good, durationSecs: 10 }],
    ];
    for (const [label, obj] of cases) {
      assert.equal(parse(obj).ok, false, `${label} should be rejected`);
    }
  });

  it('names the field that is wrong', () => {
    const r = parse({ intervalMs: 500, steps: [50, 150] });
    assert.ok(!r.ok);
    assert.match(r.error, /steps/);
  });

  it('rejects malformed JSON with a readable error', () => {
    const r = parsePattern('test', '{ "steps": [1, 2,] }');
    assert.ok(!r.ok);
    assert.match(r.error, /not valid JSON/);
  });

  it('rejects names Discord users could not type or that escape the folder', () => {
    for (const name of ['Has Caps', '../escape', 'a b', '', 'x'.repeat(33)]) {
      assert.equal(parse(good, name).ok, false, `"${name}" should be rejected`);
    }
  });
});

describe('patternAction', () => {
  it('builds a Pattern command with every step inside the device range', () => {
    const r = parse({ intervalMs: 250, steps: [0, 50, 100], durationSec: 12 });
    assert.ok(r.ok);
    const action = patternAction(r.pattern);
    if (action.kind !== 'pattern') return assert.fail('expected a pattern action');
    assert.equal(action.timeSec, 12);
    assert.match(action.rule, /S:250#/);
    for (const step of action.strength.split(';').map(Number)) {
      assert.ok(step >= 0 && step <= LOVENSE_MAX_LEVEL);
    }
  });
});

describe('patternAction with a duration override', () => {
  it('loops the steps for longer than the file says', () => {
    const r = parse({ intervalMs: 500, steps: [20, 80], durationSec: 10 });
    assert.ok(r.ok);
    assert.equal(patternAction(r.pattern, 600).timeSec, 600);
  });

  it('never exceeds the hour cap, whatever is asked', () => {
    const r = parse(good);
    assert.ok(r.ok);
    assert.equal(patternAction(r.pattern, 99_999).timeSec, 3600);
  });
});

describe('loading from a folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patterns-'));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify(good));
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  writeFileSync(join(dir, '_skip.json'), JSON.stringify(good));
  writeFileSync(join(dir, 'notes.txt'), 'not a pattern');
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('lists .json files by name, skipping _ files and everything else', () => {
    assert.deepEqual(listPatternNames(dir), ['broken', 'ok']);
  });

  it('loads a good file and reports a broken one rather than throwing', () => {
    assert.equal(loadPattern('ok', dir).ok, true);
    const broken = loadPattern('broken', dir);
    assert.ok(!broken.ok);
    assert.match(broken.error, /not valid JSON/);
  });

  it('only loads names that are actually in the folder', () => {
    for (const name of ['missing', '_skip', '../ok']) {
      assert.equal(loadPattern(name, dir).ok, false, `"${name}" should not load`);
    }
  });

  it('returns nothing, rather than crashing, when the folder is missing', () => {
    assert.deepEqual(listPatternNames(join(dir, 'nope')), []);
  });
});
