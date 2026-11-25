import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAll, setDowns, clipsLeaving } from '../../tools/bit-lab/checks.mjs';
import { labSeeds, bitTile, grid, THEMES } from '../../tools/bit-lab/lab.mjs';
import { buildSheets, PEOPLE } from '../../tools/bit-lab/sheets.mjs';
import { parseCli, runCheck } from '../../tools/bit-lab/cli.mjs';

test('every personal Bit rule holds', () => {
  assert.deepEqual(checkAll(), []);
  for (const { clips } of setDowns()) assert.ok(clips.length <= 3);
});

test('a cell far off the body is caught leaving the stage', () => {
  assert.ok(clipsLeaving([[14, 5]]).length > 0);
  assert.deepEqual(clipsLeaving([[5, 5]]), []);
});

test('the same seed word draws the same Bits', () => {
  assert.deepEqual(labSeeds(4, 'x'), labSeeds(4, 'x'));
  assert.notDeepEqual(labSeeds(4, 'x'), labSeeds(4, 'y'));
  for (const s of labSeeds(4, 'x')) assert.match(s, /^[0-9a-f]{16}$/);
});

test('sheets are real images of the right size', () => {
  const tile = bitTile(labSeeds(1, 'size')[0], { scale: 4 });
  assert.equal(tile.width, 18 * 4);
  const g = grid([tile, tile, tile], 2, 3, THEMES.dark);
  assert.equal(g.width, 2 * tile.width + 3 * 3);
  assert.equal(g.height, 2 * tile.height + 3 * 3);
  const files = new Map(buildSheets('test'));
  assert.equal(PEOPLE.length, 6);
  for (const name of ['random-dark.png', 'random-light.png', 'people.png', 'tips.png', 'patterns.png', 'wardrobe.png', 'moods.png']) {
    assert.deepEqual([...files.get(name).subarray(1, 4)], [0x50, 0x4e, 0x47], name);
  }
  assert.equal(files.get('hatch.gif').subarray(0, 6).toString('ascii'), 'GIF89a');
});

test('the command line', () => {
  assert.equal(parseCli([]).help, true);
  assert.equal(parseCli(['nope']).help, true);
  assert.equal(parseCli(['check']).command, 'check');
  assert.equal(parseCli(['sheets', '--out', 'o', '--seed', 's']).out, 'o');
  const lines = [];
  assert.equal(runCheck((l) => lines.push(l)), 0);
  assert.match(lines.at(-1), /^ok: /);
});
