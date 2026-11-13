// A Deck key placed on the screen: the button runs what the person agreed to and
// nothing else. These are the promises server/deck-press.js makes: a capability never
// stores an agreement, a changed key stops, and only `accept` with what the sheet
// showed lets it run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { createDeckPress, fingerprint, stepsOf, describeSteps, lookOf } = require('../deck-press.js');
const { createDeckShortcutRunner } = require('../deck-shortcut-runner.js');
const { triggerSteps } = require('../js/deck-actions.js');
const LayersModel = require('../js/layers-model.js');
const LayerKey = require('../capabilities/layer-key.js');
const { remoteMayRun } = require('../remote-actions.js');

const URL_A = { type: 'openUrl', url: 'https://x.test/a' };
const URL_B = { type: 'openUrl', url: 'https://x.test/b' };
const tapOf = (...actions) => ({ steps: actions.map((action) => ({ action, delayMs: 0 })) });

function deckKey(id, tap, extra = {}) {
  return { kind: 'action', id, title: 'T ' + id, triggers: { tap }, ...extra };
}

const storeOf = (...keys) => ({ main: { profiles: [{ root: { pages: [{ keys }] } }] } });

function harness(keys) {
  const state = { store: storeOf(...keys), layers: LayersModel.normalize({}) };
  const ran = [];
  const layers = {
    get: () => state.layers,
    update: async (edit) => {
      const res = edit(state.layers);
      if (res && res.layers) state.layers = res.layers;
      return res;
    },
    catalog: async () => ({ tiles: [], packages: [] }),
  };
  const readConfigs = async () => state.store;
  const runner = createDeckShortcutRunner({
    readConfigs, steps: triggerSteps,
    run: async (a) => { ran.push(a); return { ok: true }; },
    broadcast: () => {},
    claimMs: 50,
  });
  const press = createDeckPress({ layers, readConfigs, runner });
  const deps = { layers, deck: { configs: readConfigs }, host: {} };
  const place = (key = 'k1', more = {}) => LayerKey.place(deps, { key, surface: 'overlay', position: 'top-right', ...more });
  return { state, ran, press, place, deps };
}

test('a fingerprint is what a key does and when', () => {
  const one = stepsOf(deckKey('k', tapOf(URL_A)));
  assert.equal(fingerprint(one), fingerprint(stepsOf(deckKey('other', tapOf(URL_A)))), 'the id and title are not what it does');
  assert.notEqual(fingerprint(one), fingerprint(stepsOf(deckKey('k', tapOf(URL_B)))));
  assert.notEqual(fingerprint(one), fingerprint(stepsOf(deckKey('k', tapOf(URL_A, URL_A)))));
  const later = stepsOf(deckKey('k', { steps: [{ action: URL_A, delayMs: 500 }] }));
  assert.notEqual(fingerprint(one), fingerprint(later), 'a delay changes the key');
});

test('placing a key never stores an agreement, and it runs nothing', async () => {
  const h = harness([deckKey('k1', tapOf(URL_A))]);
  const res = await h.place();
  assert.equal(res.ok, true);
  const w = h.state.layers.widgets.find((x) => x.id === res.id);
  assert.equal(w.widget, LayersModel.KEY);
  assert.equal(w.instance, 'k1');
  assert.equal(w.keyFp, undefined);
  assert.deepEqual(await h.press.press(res.id), { ok: false, error: 'key_changed' });
  assert.deepEqual(h.ran, []);
});

test('a key answers ready only after the person accepted what the sheet showed', async () => {
  const h = harness([deckKey('k1', tapOf(URL_A))]);
  const { id } = await h.place();
  const shown = await h.press.read(id);
  assert.equal(shown.state, 'confirm');
  assert.deepEqual(shown.does.map((s) => s.detail), ['https://x.test/a']);
  assert.deepEqual(await h.press.accept(id, shown.fp), { ok: true });
  assert.deepEqual(h.ran, [], 'agreeing runs nothing');
  assert.equal((await h.press.read(id)).state, 'ready');
  assert.equal((await h.press.press(id)).ok, true);
  assert.deepEqual(h.ran.map((a) => a.url), ['https://x.test/a']);
});

test('a key edited after the agreement stops and asks again', async () => {
  const h = harness([deckKey('k1', tapOf(URL_A))]);
  const { id, fp } = await h.place();
  await h.press.accept(id, fp);
  h.state.store = storeOf(deckKey('k1', tapOf(URL_B)));
  assert.deepEqual(await h.press.press(id), { ok: false, error: 'key_changed' });
  assert.deepEqual(h.ran, []);
  assert.equal((await h.press.read(id)).state, 'confirm');
});

test('an agreement names what was shown: a key edited meanwhile is refused', async () => {
  const h = harness([deckKey('k1', tapOf(URL_A))]);
  const { id } = await h.place();
  const shown = await h.press.read(id);
  h.state.store = storeOf(deckKey('k1', tapOf(URL_B)));
  assert.deepEqual(await h.press.accept(id, shown.fp), { ok: false, error: 'key_changed' });
  assert.equal(h.state.layers.widgets.find((x) => x.id === id).keyFp, undefined);
  assert.deepEqual(await h.press.accept(id, 'f'.repeat(32)), { ok: false, error: 'key_changed' });
  assert.deepEqual(await h.press.accept(id, '<script>'), { ok: false, error: 'key_changed' });
});

test('a key taken out of the Deck, or with nothing to do, reads as gone', async () => {
  const h = harness([deckKey('k1', tapOf(URL_A))]);
  const { id, fp } = await h.place();
  await h.press.accept(id, fp);
  h.state.store = storeOf();
  assert.deepEqual(await h.press.read(id), { ok: true, state: 'gone' });
  assert.equal((await h.press.press(id)).ok, false);
  assert.deepEqual(await h.press.accept(id, fp), { ok: false, error: 'gone' });
  h.state.store = storeOf(deckKey('k1', tapOf()));
  assert.deepEqual(await h.press.read(id), { ok: true, state: 'gone' });
  assert.deepEqual(h.ran, []);
});

test('only a placed key can be pressed: another widget or a made-up id is gone', async () => {
  const h = harness([deckKey('k1', tapOf(URL_A))]);
  await h.place();
  const other = LayersModel.addWidget(h.state.layers, { kind: 'tile', widget: 'weather', surface: 'overlay', position: 'top-right' });
  h.state.layers = other.layers;
  for (const id of [other.widget.id, 'nope', 'k1']) {
    assert.deepEqual(await h.press.read(id), { ok: false, error: 'gone' });
    assert.deepEqual(await h.press.press(id), { ok: false, error: 'gone' });
    assert.deepEqual(await h.press.accept(id, 'a'.repeat(32)), { ok: false, error: 'gone' });
  }
  assert.deepEqual(h.ran, []);
});

test('the sheet shows every step, with every text the action was told', () => {
  const list = stepsOf(deckKey('k', tapOf(
    { type: 'openUrl', url: 'https://x.test/a' },
    { type: 'typeText', text: 'hello there' },
  )));
  const does = describeSteps(list);
  assert.equal(does.length, 2);
  assert.deepEqual(does.map((s) => s.type), ['openUrl', 'typeText']);
  assert.equal(does[1].detail, 'hello there');
  assert.ok(does.every((s) => s.label), 'each step has a name to translate');
  const long = describeSteps(stepsOf(deckKey('k', tapOf({ type: 'typeText', text: 'x'.repeat(900) }))));
  assert.ok(long[0].detail.length <= 403);
});

test('a key\'s look keeps only what the page can draw', () => {
  assert.deepEqual(lookOf({ title: ' Lights ', bg: '#112233', icon: { type: 'emoji', value: 'x' } }),
    { title: 'Lights', icon: { type: 'emoji', value: 'x' }, bg: '#112233' });
  assert.deepEqual(lookOf({ title: 'x', bg: 'url(evil)', icon: { type: 'html', value: '<b>' } }), { title: 'x' });
  assert.equal(lookOf({ title: 'y'.repeat(200) }).title.length, 80);
});

test('placing answers what a person can fix', async () => {
  const h = harness([deckKey('k1', tapOf(URL_A)), deckKey('k2', tapOf()), { ...deckKey('k3', tapOf(URL_A)), title: 'Same' }, { ...deckKey('k4', tapOf(URL_B)), title: 'Same' }]);
  assert.equal((await h.place('nothing')).error, 'no_key');
  assert.equal((await h.place('k2')).error, 'no_action');
  assert.equal((await h.place('Same')).error, 'ambiguous');
  assert.equal((await h.place('k1', { screen: 'second' })).error, 'no_second_screen');
  assert.equal((await LayerKey.place({ ...h.deps, deck: null }, { key: 'k1' })).error, 'unavailable');
});

test('the Add list offers only keys that can go on the screen', () => {
  const list = LayerKey.choices(storeOf(deckKey('k1', tapOf(URL_A)), deckKey('k2', tapOf()), deckKey('bad id!', tapOf(URL_A))));
  assert.deepEqual(list.map((c) => c.id), ['k1']);
  assert.ok(list[0].labelKey);
});

test('the model keeps an agreement only on a key, and only a well formed one', () => {
  const fp = 'a'.repeat(32);
  const added = LayersModel.addWidget(LayersModel.normalize({}), { kind: 'tile', widget: LayersModel.KEY, instance: 'k1', surface: 'overlay', position: 'top-right', size: 'button' });
  assert.equal(added.widget.keyFp, undefined);
  assert.equal(LayersModel.setKeyFp(added.layers, added.widget.id, 'not hex').error, 'failed');
  assert.equal(LayersModel.setKeyFp(added.layers, 'nope', fp).error, 'gone');
  const set = LayersModel.setKeyFp(added.layers, added.widget.id, fp);
  const kept = LayersModel.normalize(set.layers).widgets[0];
  assert.equal(kept.keyFp, fp);
  const weather = LayersModel.addWidget(LayersModel.normalize({}), { kind: 'tile', widget: 'weather', surface: 'overlay', position: 'top-right' });
  const forged = { ...weather.layers, widgets: weather.layers.widgets.map((w) => ({ ...w, keyFp: fp })) };
  assert.equal(LayersModel.normalize(forged).widgets[0].keyFp, undefined);
  assert.equal(LayersModel.setKeyFp(weather.layers, weather.widget.id, fp).error, 'gone');
});

test('a phone cannot place a key, and neither /deck/press route reaches it', () => {
  assert.equal(remoteMayRun({ type: 'layerKey', key: 'k1' }, {}).error, 'needs_pc');
  const ra = engineSource('server/remote-access.js');
  assert.equal((ra.match(/'\/deck\/press'/g) || []).length, 2, 'in both deny lists');
});

test('POST /deck/press is CSRF guarded and takes only an id and an agreement', () => {
  const src = engineSource();
  assert.match(src, /CSRF_MUTATION_PATHS[\s\S]{0,4000}'\/deck\/press'/);
});

test('no widget can press or place a key', () => {
  const sdk = readFileSync(new URL('../sdk-widgets.js', import.meta.url), 'utf8');
  const bridge = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
  for (const src of [sdk, bridge]) {
    assert.doesNotMatch(src, /layerKey/);
    assert.doesNotMatch(src, /deck\/press/);
  }
});
