// The Bit's places beyond the body (bit-wardrobe.js PLACES): a ride under its feet, a prop on the
// floor beside it, its home behind it, a move for its teleports. Each keeps its own rules, comes
// from the hub like any item (server/bit/items.js), and draws where it belongs (bit-look.js, bit.js).
// Every Bit has the little house, put in its place once. Every id, name and seed here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wardrobe = require('../shared/src/bit-wardrobe.js');
const look = require('../shared/src/bit-look.js');
const bit = require('../shared/src/bit.js');
const genome = require('../shared/src/bit-genome.js');
const Model = require('../bit/model.js');
const { itemOf } = require('../bit/items.js');

const SEED = '0123456789abcdef';
const names = { en: 'Test thing' };
const shop = (id, slot, layers, more = {}) => ({ id, slot, source: 'shop', price: 120, layers, names, ...more });
const BOARD = shop('testBoard', 'ride', [{ fill: '#d9603b', cells: [[1, 9, 10]] }, { fill: '#3b4250', cells: [[2, 10], [9, 10]] }]);
const LAMP = shop('testLamp', 'prop', [{ fill: '#ffd77a', cells: [[11, 7, 3, 3]] }, { fill: '#3b4250', cells: [[11, 10, 3]] }]);
const SNOW = shop('testSnow', 'move', [{ fill: '#ffffff', cells: [[2, 0], [1, 1, 3], [2, 2]] }], { params: { base: 'crumble', ms: 700 } });

test('each place keeps its own rules', () => {
  assert.deepEqual(wardrobe.PLACES, ['head', 'face', 'neck', 'back', 'feet', 'hand', 'ride', 'prop', 'home', 'move']);
  for (const it of [BOARD, LAMP, SNOW, wardrobe.item('hut')]) assert.deepEqual(wardrobe.validate(it), [], it.id);
  assert.ok(wardrobe.validate({ ...BOARD, layers: [{ fill: 'body', cells: [[1, 8, 10]] }] }).some((e) => e.startsWith('outside')), 'a ride stays in the two rows under the feet');
  assert.ok(wardrobe.validate({ ...LAMP, layers: [{ fill: 'body', cells: [[5, 9]] }] }).some((e) => e.startsWith('outside')), 'a prop stays off the body');
  assert.ok(wardrobe.validate({ ...SNOW, layers: [{ fill: 'body', cells: [[5, 0]] }] }).some((e) => e.startsWith('outside')), "a move's bits fit 5 by 5");
  for (const params of [undefined, { base: 'download', ms: 700 }, { base: 'beam', ms: 100 }, { base: 'beam', ms: 700.5 }]) {
    assert.ok(wardrobe.validate({ ...SNOW, params }).includes('params'), JSON.stringify(params));
  }
  assert.deepEqual(wardrobe.validate({ ...wardrobe.item('hut'), id: 'testHome', source: 'shop', price: 120 }), [], 'a home sits behind the antenna');
  assert.ok(wardrobe.validate({ ...LAMP, layers: [{ fill: 'body', cells: [[1, 0]] }] }).length === 0);
  assert.deepEqual([wardrobe.maxCells('home'), wardrobe.maxCells('move'), wardrobe.maxCells('head')], [288, 25, 160]);
  assert.equal(wardrobe.birthItem(0.99), wardrobe.birthItem(0.99), 'the gift at birth is still a cheap thing to wear');
  assert.ok(wardrobe.SLOTS.includes(wardrobe.item(wardrobe.birthItem(0.5)).slot));
});

test('the hub sends them like any item; a move keeps only its two numbers', () => {
  const move = itemOf({ ...SNOW, params: { base: 'beam', ms: 900, code: 'x()' } });
  assert.deepEqual(move.params, { base: 'beam', ms: 900 });
  assert.equal(itemOf({ ...SNOW, params: { base: 'nope', ms: 900 } }), null);
  assert.equal(itemOf({ ...BOARD, params: { base: 'beam', ms: 900 } }).params, undefined, 'only a move has params');
  const rows = Array.from({ length: 16 }, (_, i) => [-3, -5 + i, 18]);
  const house = (more) => shop('testHouse', 'home', [{ fill: '#6e4b35', cells: [...rows, ...more] }]);
  assert.ok(itemOf(house([])), 'a home may fill the stage');
  assert.equal(itemOf(house([[0, 0]])), null, 'and no more');
  assert.equal(itemOf({ ...LAMP, layers: [{ fill: '#ffd77a', cells: Array.from({ length: 161 }, () => [0, 0]) }] }), null);
});

function frameOf(clipId, worn, opts = {}, index = 0) {
  wardrobe.addItems([BOARD, LAMP, SNOW]);
  const own = look.lookOf(genome.decode(SEED), { worn: wardrobe.outfit(worn) });
  return bit.renderFrame(clipId, index, { look: own, ...opts }).layers;
}

test('a ride lifts Bit onto it, and on its way a step is a glide', () => {
  const plain = frameOf('idle', []);
  const riding = frameOf('idle', ['testBoard']);
  assert.equal(riding.length, plain.length + 1, 'the ride is one layer');
  const body = riding[riding.length - 1];
  assert.equal(body.transform.dy, -2, 'a ride whose top row is 9 lifts Bit two rows');
  assert.equal(riding[riding.length - 2].rects.length, 12);
  const walk = bit.clip('walk');
  const lifts = walk.frames.map((_, i) => frameOf('walk', ['testBoard'], {}, i).at(-1).transform);
  assert.ok(lifts.every((t) => t.dy === -2 && t.sx === 1 && t.sy === 1), 'no bob, no squash');
  assert.ok(walk.frames.some((f) => f.dy), 'the walk itself bobs');
});

test('a prop stands beside Bit, and stays behind while it travels', () => {
  const still = frameOf('idle', ['testLamp']);
  assert.ok(still.some((l) => !l.transform && l.rects.length === 12), 'the lamp, not moved by the body');
  const walking = frameOf('walk', ['testLamp']);
  assert.ok(!walking.some((l) => l.rects.length === 12));
});

test('its home shows where it sleeps, and always in its room; a move draws nothing on Bit', () => {
  const hut = wardrobe.cellsOf(wardrobe.item('hut')).length;
  assert.ok(frameOf('idle', ['hut']).every((l) => l.rects.length !== hut), 'not while it is about');
  assert.equal(frameOf('sleep', ['hut'])[0].rects.length, hut, 'asleep in its home, behind everything');
  assert.equal(frameOf('idle', ['hut'], { home: true })[0].rects.length, hut);
  assert.deepEqual(frameOf('idle', ['testSnow']).map((l) => l.rects.length), frameOf('idle', []).map((l) => l.rects.length));
});

test('every Bit has the little house, put in its place once', () => {
  const born = { seed: SEED, number: 7, born: '2026-11-01T12:00:00.000Z', sig: '', local: false };
  const old = Model.normalize({ bit: born, worn: ['beanie'], owned: ['beanie'] });
  assert.deepEqual(old.worn, ['beanie', 'hut'], 'a Bit from before gets it once');
  assert.equal(old.homed, true);
  const off = Model.normalize({ ...old, worn: ['beanie'] });
  assert.deepEqual(off.worn, ['beanie'], 'taken off, it stays off');
  assert.ok(Model.view(off, new Date()).owned.includes('hut'));
  const egg = Model.normalize({});
  assert.deepEqual([egg.worn, egg.homed], [[], false], 'an egg has no home yet');
  const hatched = Model.hatched(egg, born, new Date(2026, 10, 1, 12)).model;
  assert.ok(hatched.worn.includes('hut') && hatched.homed);
  const many = Model.normalize({ bit: born, homed: true, worn: ['beanie', 'testBoard', 'testLamp', 'hut', 'testSnow'] });
  assert.equal(many.worn.length, 5, 'one thing in every place');
});
