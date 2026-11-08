// "When do you see it?" over what is stored: both ways, and old mixes left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayerSee = require('../js/layer-see.js');
const LayerWhen = require('../js/layer-when.js');

const music = LayerWhen.parse('music');

test('each stored widget reads as one answer', () => {
  assert.equal(LayerSee.seeOf({ surface: 'overlay', show: 'always' }), 'always');
  assert.equal(LayerSee.seeOf({ surface: 'desktop', show: 'always' }), 'desktop');
  assert.equal(LayerSee.seeOf({ surface: 'overlay', show: 'gaming' }), 'game');
  assert.equal(LayerSee.seeOf({ surface: 'anchor', show: 'always' }), 'app');
  assert.equal(LayerSee.seeOf({ surface: 'overlay', show: 'always', when: music }), 'other');
  assert.equal(LayerSee.seeOf({ surface: 'desktop', show: 'always', when: music }), 'other');
});

test('a mix the answers cannot say is custom, not rewritten', () => {
  const w = { surface: 'desktop', show: 'gaming' };
  assert.equal(LayerSee.seeOf(w), 'custom');
  assert.deepEqual(w, { surface: 'desktop', show: 'gaming' });
});

test('every answer writes back to itself', () => {
  for (const see of ['always', 'desktop', 'game']) {
    const change = LayerSee.changeFor(see);
    assert.equal(LayerSee.seeOf({ when: undefined, ...change }), see);
  }
  assert.equal(LayerSee.changeFor('app'), null);
});

test('a view holds its own widgets, "now" what the screen shows', () => {
  const game = { surface: 'overlay', show: 'gaming' };
  assert.equal(LayerSee.inView(game, 'game', false), true);
  assert.equal(LayerSee.inView(game, 'desktop', true), false);
  assert.equal(LayerSee.inView(game, 'now', false), false);
  assert.equal(LayerSee.inView(game, 'now', true), true);
  const always = { surface: 'overlay', show: 'always' };
  assert.equal(LayerSee.inView(always, 'game', false), true, 'always means in a game too');
  assert.equal(LayerSee.inView(always, 'desktop', false), true);
  assert.equal(LayerSee.inView(always, 'always', false), true);
  assert.equal(LayerSee.inView({ surface: 'overlay', when: music }, 'game', true), false);
});

test('the list keeps a mix with the other situations', () => {
  assert.equal(LayerSee.groupOf({ surface: 'desktop', show: 'gaming' }), 'other');
  assert.equal(LayerSee.groupOf({ surface: 'overlay', when: music }), 'other');
  assert.equal(LayerSee.groupOf({ surface: 'anchor' }), 'app');
  assert.ok(LayerSee.GROUPS.includes('other'));
});

test('a new widget starts with the answer that suits it', () => {
  assert.deepEqual(LayerSee.firstFor('perf'), { surface: 'overlay', show: 'gaming' });
  assert.deepEqual(LayerSee.firstFor('media'), { surface: 'overlay', when: 'music' });
  assert.deepEqual(LayerSee.firstFor('weather'), { surface: 'overlay', show: 'always' });
  assert.deepEqual(LayerSee.firstLabel('perf'), { key: 'see_game' });
  assert.deepEqual(LayerSee.firstLabel('media'), { key: 'xmenu_sit_music' });
  assert.deepEqual(LayerSee.firstLabel('weather'), { key: 'see_always' });
});

test('each answer has its words, and a mix never pretends to be one', () => {
  const label = LayerSee.labelOf;
  assert.deepEqual(label({ surface: 'overlay', show: 'always' }), { key: 'see_always' });
  assert.deepEqual(label({ surface: 'overlay', show: 'gaming' }), { key: 'see_game' });
  assert.deepEqual(label({ surface: 'desktop', show: 'gaming' }), { key: 'see_custom' });
  assert.deepEqual(label({ surface: 'anchor', anchor: { app: 'spotify' } }), { key: 'see_on_app', vars: { app: 'Spotify' } });
  assert.deepEqual(label({ surface: 'overlay', when: music }), { key: 'xmenu_sit_music' });
  assert.deepEqual(label({ surface: 'overlay', when: LayerWhen.parse('app:obs64') }), { text: 'Obs64' });
  assert.deepEqual(label({ surface: 'overlay', when: LayerWhen.parse('hide:music') }), { key: 'see_custom' });
  assert.deepEqual(label({ surface: 'overlay', when: LayerWhen.parse('music,live') }), { key: 'xmenu_when_many', vars: { n: 2 } });
});
