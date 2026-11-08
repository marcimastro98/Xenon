// Keys for widgets in the Xenon menu (server/menu-widget-keys.js): the Keys rows of a
// widget's card, the Widgets group of the Keys section, and the words a widget its
// own key hid gets in the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Menu = require('../xenon-menu.js');
const { handlerKeyId } = require('../capabilities/widget-key.js');

const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const dict = (() => {
  const text = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const ctx = {};
  vm.runInNewContext(text.slice(0, text.search(/^function /m)) + '\nthis.i18n = i18n;', ctx);
  return ctx.i18n;
})();

const CLOCK = { id: 'lw_clck01', kind: 'sdk', pkg: 'com.x.clock', surface: 'desktop', rect: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 } };
const WEATHER = { id: 'lw_wthr01', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 } };
const PKG = {
  id: 'com.x.clock', name: 'Clock X', key: { combo: 'ctrl+shift+k', mode: 'hold' },
  handlers: [
    { id: 'lap', name: 'Lap', params: [], granted: true, key: { combo: 'ctrl+shift+l' } },
    { id: 'alarm', name: 'Set an alarm', params: [{ name: 'at', kind: 'text' }], granted: true },
    { id: 'reset', name: 'Reset', params: [], granted: false },
  ],
};
const state = ({ layers, ...over } = {}) => ({
  probes: { layers: true, shortcuts: true },
  layers: { enabled: true, widgets: [CLOCK, WEATHER], ...layers },
  packages: [{ id: 'com.x.clock', name: 'Clock X' }],
  widgetKeys: [PKG],
  keyStates: {}, deck: [],
  ...over,
});
const compose = (over) => Menu.compose(state(over));
const section = (out, id) => out.sections.find((s) => s.id === id);
const widgetRow = (out, id) => section(out, 'widgets').rows.find((r) => r.id === id);
const tune = (out, id, name) => widgetRow(out, id).tune.find((r) => r.id === id + ':' + name);

test('a widget card has a key that shows it, unset, and the suggestion its creator made as one tap', () => {
  const out = compose();
  const key = tune(out, 'lw_clck01', 'key');
  assert.equal(key.kind, 'key');
  assert.equal(key.combo, '');
  assert.deepEqual(key.record, { action: { type: 'layerWidgetKey', target: 'lw_clck01' }, param: 'shortcut' });
  const offer = tune(out, 'lw_clck01', 'keyoffer');
  assert.deepEqual(offer.act, { run: { type: 'layerWidgetKey', target: 'lw_clck01', shortcut: 'ctrl+shift+k', mode: 'hold' } });
  assert.equal(tune(out, 'lw_clck01', 'keymode'), undefined, 'no way of working before there is a key');
  assert.equal(tune(out, 'lw_wthr01', 'keyoffer'), undefined, 'a built-in tile suggests nothing');
});

test('a suggestion that is reserved or no combination is never offered', () => {
  for (const combo of ['alt+f4', 'ctrl+c', '']) {
    const out = compose({ widgetKeys: [{ ...PKG, key: { combo } }] });
    assert.equal(tune(out, 'lw_clck01', 'keyoffer'), undefined, combo);
  }
});

test('with a key set the card offers press or hold, and says what each does', () => {
  const keyed = (key, layerNow) => compose({ layers: { widgets: [{ ...CLOCK, key }, WEATHER] }, keyStates: { 'widget-lw_clck01': 'listening' }, layerNow });
  const out = keyed({ combo: 'ctrl+shift+k' });
  const key = tune(out, 'lw_clck01', 'key');
  assert.equal(key.combo, 'Ctrl + Shift + K');
  assert.deepEqual(key.note, { key: 'xmenu_key_ok' });
  assert.deepEqual(key.sub, { key: 'xmenu_wkey_toggle_sub' });
  const mode = tune(out, 'lw_clck01', 'keymode');
  assert.equal(mode.value, 'toggle');
  assert.deepEqual(mode.options.find((o) => o.value === 'hold').act, { run: { type: 'layerWidgetKey', target: 'lw_clck01', mode: 'hold' } });
  assert.equal(tune(out, 'lw_clck01', 'keyoffer'), undefined, 'set already: nothing to offer');
  assert.deepEqual(tune(keyed({ combo: 'ctrl+shift+k', hold: true }), 'lw_clck01', 'key').sub, { key: 'xmenu_wkey_hold_sub' });
  const peek = keyed({ combo: 'ctrl+shift+k', hold: true }, { keyPeek: true });
  assert.deepEqual(tune(peek, 'lw_clck01', 'key').sub, { key: 'xmenu_wkey_peek_sub' }, 'no release here: it shows for a while');
});

test('a Store widget lists only the functions a key can run, with their suggestion as a hint', () => {
  const out = compose();
  const fns = widgetRow(out, 'lw_clck01').tune.filter((r) => r.id.includes(':fn-'));
  assert.deepEqual(fns.map((r) => r.id), ['lw_clck01:fn-lap'], 'settings to fill or not allowed: on the Deck');
  assert.deepEqual(fns[0].record, { action: { type: 'widgetHandlerKey', widget: 'com.x.clock', handler: 'lap' }, param: 'shortcut' });
  assert.deepEqual(fns[0].sub, { key: 'xmenu_wkey_suggested', vars: { key: 'Ctrl + Shift + L' } });
  const set = compose({ deck: [{ keyId: handlerKeyId('com.x.clock', 'lap'), combo: 'ctrl+alt+l', title: 'Clock X · Lap', state: 'listening' }] });
  const lap = tune(set, 'lw_clck01', 'fn-lap');
  assert.equal(lap.combo, 'Ctrl + Alt + L');
  assert.equal(lap.sub, undefined);
});

test('no global shortcuts on this machine: no Keys rows in the card', () => {
  const out = compose({ probes: { layers: true } });
  assert.equal(widgetRow(out, 'lw_clck01').tune.some((r) => r.id.endsWith(':h-keys')), false);
});

test('the Keys section has a Widgets group, and a function key is not listed again with the other keys', () => {
  const fnKey = { keyId: handlerKeyId('com.x.clock', 'lap'), combo: 'ctrl+alt+l', title: 'Clock X · Lap', state: 'listening' };
  const other = { keyId: 'k1', title: 'Foto', combo: 'ctrl+alt+f7', state: 'listening' };
  const out = compose({ layers: { widgets: [{ ...CLOCK, key: { combo: 'ctrl+shift+k', hold: true } }, WEATHER] }, deck: [fnKey, other], keyStates: { 'widget-lw_clck01': 'clash' } });
  const rows = section(out, 'keys').rows;
  const at = (id) => rows.findIndex((r) => r.id === id);
  assert.ok(at('h-keys-widgets') >= 0);
  const show = rows[at('wkey-lw_clck01')];
  assert.deepEqual(show.label, { text: 'Clock X' });
  assert.deepEqual(show.note, { key: 'xmenu_key_dup' });
  assert.deepEqual(show.record, { action: { type: 'layerWidgetKey', target: 'lw_clck01' }, param: 'shortcut' });
  assert.ok(at('deck-' + fnKey.keyId) > at('h-keys-widgets'));
  assert.equal(rows.filter((r) => r.id === 'deck-' + fnKey.keyId).length, 1);
  assert.ok(at('deck-k1') > at('h-keys-deck'), 'the other keys stay where they were');
  assert.equal(section(compose(), 'keys').rows.some((r) => r.id === 'h-keys-widgets'), false, 'no widget keys: no group');
});

test('a widget its own key hid says which key brings it back', () => {
  const out = (key) => widgetRow(Menu.compose(state({ layers: { widgets: [{ ...CLOCK, key }, WEATHER] }, layerNow: { keyOff: ['lw_clck01'] } })), 'lw_clck01');
  const pressed = out({ combo: 'ctrl+shift+k' });
  assert.equal(pressed.shown, false);
  assert.deepEqual(pressed.now, { key: 'see_off_key', vars: { key: 'Ctrl + Shift + K' } });
  assert.deepEqual(out({ combo: 'ctrl+shift+k', hold: true }).now, { key: 'see_off_hold', vars: { key: 'Ctrl + Shift + K' } });
});

test('every word of the widget keys exists in all 11 languages', () => {
  const keys = ['xmenu_tune_keys', 'xmenu_wkey_show', 'xmenu_wkey_mode', 'xmenu_wkey_toggle', 'xmenu_wkey_hold', 'xmenu_wkey_toggle_sub',
    'xmenu_wkey_hold_sub', 'xmenu_wkey_peek_sub', 'xmenu_wkey_offer', 'xmenu_wkey_offer_sub', 'xmenu_wkey_use', 'xmenu_wkey_suggested',
    'xmenu_group_widget_keys', 'see_off_key', 'see_off_hold', 'deck_act_layerWidgetKey', 'deck_act_widgetHandlerKey',
    'deck_err_not_placed', 'deck_err_no_widget', 'deck_err_no_function', 'deck_err_needs_settings', 'deck_err_not_granted'];
  for (const lang of LANGS) {
    for (const key of keys) assert.ok(typeof dict[lang][key] === 'string' && dict[lang][key], lang + ' ' + key);
    for (const key of ['xmenu_wkey_offer', 'xmenu_wkey_suggested', 'see_off_key', 'see_off_hold']) assert.ok(dict[lang][key].includes('{key}'), lang + ' ' + key);
  }
});
