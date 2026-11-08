// Keys for widgets (capabilities/widget-key.js): one that shows or hides a placed
// widget, and one that runs a Store widget's function from a Deck key of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { setWidgetKey, setHandlerKey, handlerKeyId } = require('../capabilities/widget-key.js');
const LayersModel = require('../js/layers-model.js');
const S = require('../js/deck-shortcuts.js');

const W = (id, over = {}) => ({ id, kind: 'tile', widget: 'perf', surface: 'overlay', rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, ...over });

function fakeLayers(widgets, heldBy = () => '') {
  const state = { layers: LayersModel.normalize({ enabled: true, widgets }) };
  return {
    state,
    deps: {
      heldBy,
      layers: {
        get: () => state.layers,
        catalog: async () => ({ tiles: ['perf', 'clock'], packages: [{ id: 'music.player', name: 'Music Player' }] }),
        update: async (edit) => {
          const res = edit(state.layers);
          if (res && res.layers && !res.error) state.layers = res.layers;
          return res;
        },
      },
    },
  };
}

test('a widget gets a key, pressed by default, held when asked, and loses it with "off"', async () => {
  const { state, deps } = fakeLayers([W('lw_aaaa0001')]);
  const set = await setWidgetKey(deps, { target: 'perf', shortcut: 'Ctrl+Shift+1' });
  assert.deepEqual(set, { ok: true, widget: 'lw_aaaa0001', shortcut: 'Ctrl + Shift + 1', mode: 'toggle' });
  assert.deepEqual(state.layers.widgets[0].key, { combo: 'ctrl+shift+1' });
  const hold = await setWidgetKey(deps, { target: 'lw_aaaa0001', mode: 'hold' });
  assert.equal(hold.mode, 'hold', 'the mode alone changes, the combo stays');
  assert.deepEqual(state.layers.widgets[0].key, { combo: 'ctrl+shift+1', hold: true });
  const off = await setWidgetKey(deps, { target: 'lw_aaaa0001', shortcut: 'off' });
  assert.equal(off.shortcut, '');
  assert.equal(state.layers.widgets[0].key, undefined);
  assert.equal((await setWidgetKey(deps, { target: 'lw_aaaa0001', mode: 'hold' })).error, 'bad_shortcut', 'no combo to keep');
});

test('a widget key is refused when it is not a shortcut, is reserved or is taken', async () => {
  const asked = [];
  const { state, deps } = fakeLayers([W('lw_aaaa0001')], (combo, except) => { asked.push(except); return combo === 'ctrl+shift+2' ? 'widget' : ''; });
  assert.equal((await setWidgetKey(deps, { target: 'perf', shortcut: 'ctrl+c' })).error, 'bad_shortcut');
  assert.deepEqual(await setWidgetKey(deps, { target: 'perf', shortcut: 'alt+f4' }), { ok: false, error: 'reserved', owner: 'system' });
  assert.deepEqual(await setWidgetKey(deps, { target: 'perf', shortcut: 'ctrl+shift+2' }), { ok: false, error: 'in_use', by: 'widget' });
  assert.deepEqual(asked, ['lw_aaaa0001'], 'its own box is never in its way');
  assert.equal(state.layers.widgets[0].key, undefined);
  assert.equal((await setWidgetKey(deps, { target: 'clock', shortcut: 'ctrl+shift+3' })).error, 'not_placed');
});

test('a tab sets the key of its whole box', async () => {
  const start = LayersModel.groupWidgets(LayersModel.normalize({ widgets: [W('lw_aaaa0001'), W('lw_aaaa0002', { widget: 'clock' })] }), 'lw_aaaa0001', 'lw_aaaa0002', () => 0.5).layers;
  const { state, deps } = fakeLayers(start.widgets);
  const res = await setWidgetKey(deps, { target: 'clock', shortcut: 'ctrl+shift+4' });
  assert.equal(res.widget, 'lw_aaaa0001', 'the box goes by its first tab');
  assert.ok(state.layers.widgets.every((w) => w.key && w.key.combo === 'ctrl+shift+4'));
});

function fakeDeck(configs = {}) {
  const state = { configs };
  return {
    state,
    update: async (edit) => {
      const copy = JSON.parse(JSON.stringify(state.configs));
      const out = edit(copy) || {};
      for (const id of out.changed || []) state.configs[id] = copy[id];
      return out.result;
    },
  };
}

const PACKAGES = [
  { id: 'music.player', name: 'Music Player', handlers: [
    { id: 'next', name: 'Next track', params: [], granted: true },
    { id: 'play', name: 'Play a song', params: [{ name: 'song', kind: 'text' }], granted: true },
    { id: 'shuffle', name: 'Shuffle', params: [], granted: false },
  ] },
  { id: 'plain.clock', name: 'Clock', handlers: [] },
];

test('a function of a Store widget gets a key on the menu\'s own Deck, and loses it with "off"', async () => {
  const deck = fakeDeck();
  const deps = { deck, heldBy: () => '', sdkHandlers: async () => PACKAGES };
  const res = await setHandlerKey(deps, { widget: 'Music Player', handler: 'Next track', shortcut: 'ctrl+alt+shift+n' });
  assert.deepEqual(res, { ok: true, shortcut: 'Ctrl + Alt + Shift + N' });
  const list = S.collectShortcuts(deck.state.configs).list;
  assert.deepEqual(list.map((s) => [s.keyId, s.combo]), [[handlerKeyId('music.player', 'next'), 'ctrl+alt+shift+n']]);
  const key = deck.state.configs.keys.profiles[0].root.pages[0].keys.find(Boolean);
  assert.deepEqual(key.triggers.tap, { type: 'sdkHandler', handler: 'music.player/next', args: '' });
  // Again on another combo: the same key moves, never a second one.
  await setHandlerKey(deps, { widget: 'music.player', handler: 'next', shortcut: 'ctrl+alt+shift+m' });
  assert.deepEqual(S.collectShortcuts(deck.state.configs).list.map((s) => s.combo), ['ctrl+alt+shift+m']);
  await setHandlerKey(deps, { widget: 'music.player', handler: 'next', shortcut: 'off' });
  assert.equal(S.collectShortcuts(deck.state.configs).list.length, 0);
});

test('a function key says why it cannot be made', async () => {
  const deps = { deck: fakeDeck(), heldBy: () => '', sdkHandlers: async () => PACKAGES };
  assert.deepEqual(await setHandlerKey(deps, { widget: 'Clock', handler: 'x', shortcut: 'ctrl+shift+5' }), { ok: false, error: 'no_widget', choices: ['Music Player'] });
  assert.deepEqual(await setHandlerKey(deps, { widget: 'Music Player', handler: 'Stop', shortcut: 'ctrl+shift+5' }), { ok: false, error: 'no_function', choices: ['Next track', 'Play a song', 'Shuffle'] });
  assert.equal((await setHandlerKey(deps, { widget: 'Music Player', handler: 'play', shortcut: 'ctrl+shift+5' })).error, 'needs_settings');
  assert.equal((await setHandlerKey(deps, { widget: 'Music Player', handler: 'shuffle', shortcut: 'ctrl+shift+5' })).error, 'not_granted');
  const taken = { ...deps, heldBy: () => 'search' };
  assert.deepEqual(await setHandlerKey(taken, { widget: 'Music Player', handler: 'next', shortcut: 'ctrl+shift+5' }), { ok: false, error: 'in_use', by: 'search' });
});
