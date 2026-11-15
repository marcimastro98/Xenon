// The proof for a Rust function cut by hand into smaller ones (tools/restructure/native-body-proof.mjs):
// the new functions put back where they are named must give the old lines in the old order.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareOrder, expand, fnBody, topFns } from '../../tools/restructure/native-body-proof.mjs';

const OLD = [
  '/// Opens the lamp.',
  'pub fn glow() {',
  '    warm_up();',
  '    let lamp = Lamp::new()',
  '        .on_tick(|tick| {',
  '            // Each tick dims a little.',
  '            dim(tick);',
  '        })',
  '        .build();',
  '    #[cfg(windows)]',
  '    pin(&lamp);',
  '    shine(&lamp);',
  '}',
  '',
  'fn other() {',
  '    shine(&Lamp::new().build());',
  '}',
  '',
].join('\n');

const NOW = [
  '/// Opens the lamp.',
  'pub fn glow() {',
  '    warm_up();',
  '    let lamp = Lamp::new()',
  '        .on_tick(ticks::on_tick)',
  '        .build();',
  '    lit::after(lamp);',
  '}',
  '',
].join('\n');

const TICKS = ['// What a tick does.', '', 'pub(super) fn on_tick(tick: u32) {', '    // Each tick dims a little.', '    dim(tick);', '}', ''].join('\n');
const LIT = ['use crate::*;', '', 'pub(super) fn after(lamp: Lamp) {', '    #[cfg(windows)]', '    pin(&lamp);', '    shine(&lamp);', '}', ''].join('\n');

const partsOf = (files) => {
  const parts = new Map();
  for (const [module, text] of Object.entries(files)) for (const name of topFns(text)) parts.set(`${module}::${name}`, fnBody(text, name));
  return parts;
};

test('the body of a function is what sits between its braces, whatever its visibility', () => {
  assert.deepEqual(fnBody(OLD, 'other'), ['    shine(&Lamp::new().build());']);
  assert.equal(fnBody(OLD, 'glow')?.length, 10);
  assert.equal(fnBody(TICKS, 'on_tick')?.length, 2);
  assert.equal(fnBody(OLD, 'absent'), null);
  assert.deepEqual(topFns(OLD), ['glow', 'other']);
});

test('a body cut into functions reads as before once they are put back', () => {
  const used = new Map();
  const whole = expand(fnBody(NOW, 'glow') ?? [], partsOf({ ticks: TICKS, lit: LIT }), used);
  const { same, gone, added, moved } = compareOrder(fnBody(OLD, 'glow') ?? [], whole);
  assert.equal(same, 8);
  assert.deepEqual(gone, ['.on_tick(|tick| {', '})']);
  assert.deepEqual(added, ['.on_tick(ticks::on_tick)', 'lit::after(lamp);']);
  assert.deepEqual(moved, []);
  assert.deepEqual([...used], [['ticks::on_tick', 1], ['lit::after', 1]]);
});

test('a line that changed place is told apart from a line that changed', () => {
  const swapped = LIT.replace('    #[cfg(windows)]\n    pin(&lamp);\n    shine(&lamp);', '    shine(&lamp);\n    #[cfg(windows)]\n    pin(&lamp);');
  const whole = expand(fnBody(NOW, 'glow') ?? [], partsOf({ ticks: TICKS, lit: swapped }), new Map());
  const { moved } = compareOrder(fnBody(OLD, 'glow') ?? [], whole);
  assert.equal(moved.length > 0, true);
  assert.equal(moved.every((line) => ['shine(&lamp);', '#[cfg(windows)]', 'pin(&lamp);'].includes(line)), true);
});

test('a function is put back only where its file is named with it, and never from a use line', () => {
  const used = new Map();
  const parts = partsOf({ lit: LIT });
  const out = expand(['use lit::after;', 'split::after(lamp);', 'unlit::after(lamp);', 'lit::after_all(lamp);'], parts, used);
  assert.equal(out.length, 4);
  assert.equal(used.size, 0);
});
