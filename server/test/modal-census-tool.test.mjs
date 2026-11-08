// tools/modal-census: one picture of every dialog on the built demo. Pinned here: the arguments, the
// choice of targets, and that every opener it patches still exists in the app, so a renamed function
// fails here instead of leaving a silent "PATCH MISSING" line in a long run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PATCHES, TARGETS, parseArgs, pickTargets } from '../../tools/modal-census/census.mjs';

const script = (file) => readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');

test('a size is a name or WxH, and only the phone name is a touch device', () => {
  assert.deepEqual([parseArgs(['out']).width, parseArgs(['out']).height], [1920, 1080]);
  const phone = parseArgs(['out', '--size', 'phone']);
  assert.deepEqual([phone.width, phone.height, phone.phone], [390, 844, true]);
  const custom = parseArgs(['out', '--size', '667x375']);
  assert.deepEqual([custom.width, custom.height, custom.phone], [667, 375, false]);
});

test('the choices are read with their words', () => {
  const opts = parseArgs(['out', '--light', '--style', 'comic', '--only', 'day,call', '--pre', "setLang('it')"]);
  assert.equal(path.basename(opts.out), 'out');
  assert.equal(opts.light, true);
  assert.equal(opts.style, 'comic');
  assert.deepEqual(opts.only, ['day', 'call']);
  assert.equal(opts.pre, "setLang('it')");
});

test('no out folder, or a size that is not one, stops with the usage', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--light']), /usage/);
  assert.throws(() => parseArgs(['out', '--size', 'big']), /usage/);
});

test('--only keeps the order of the list, and a slip stops the run', () => {
  const names = pickTargets({ a: '1', b: '2', c: '3' }, ['c', 'a']).map(([name]) => name);
  assert.deepEqual(names, ['a', 'c']);
  assert.equal(pickTargets({ a: '1', b: '2' }, []).length, 2);
  assert.throws(() => pickTargets({ a: '1' }, ['a', 'zz']), /not a target: zz/);
});

test('every target is code for the page', () => {
  assert.ok(Object.keys(TARGETS).length > 100);
  for (const [name, code] of Object.entries(TARGETS)) assert.ok(typeof code === 'string' && code.length > 4, name);
});

test('every opener the census patches is still in the app', () => {
  for (const [file, swaps] of Object.entries(PATCHES)) {
    const body = script(file);
    for (const [from] of swaps) assert.ok(body.includes(from), `${file}: ${from}`);
  }
});

test('nothing in the tool points at one machine', () => {
  const tool = readFileSync(new URL('../../tools/modal-census/census.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(tool, /file:\/\/\/|F:\/dev|scratchpad/);
});
