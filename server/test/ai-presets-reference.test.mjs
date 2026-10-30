// preset_reference: every list the import code enumerates appears in the
// reference the model reads, and the few values the reference holds by hand
// still match what the normalizers accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadServerSettingsSlice, serverDashboardWidgets } from './server-settings-slice.mjs';

const require = createRequire(import.meta.url);
const R = require('../ai-preset-reference.js');
const PresetShare = require('../js/preset-share.js');
const TopbarLook = require('../js/topbar-look.js');
const DeckModel = require('../js/deck-model.js');
const AmbientScene = require('../js/ambient-scene.js');
const DashboardInstances = require('../js/dashboard-instances.js');

const deps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
const ref = (kind) => R.presetReference(kind, deps);
const text = (value) => JSON.stringify(value);

test('every share code kind is covered, sounds only as "not available"', () => {
  const buildable = PresetShare.PRESET_KINDS.filter((k) => k !== 'sounds');
  assert.deepEqual([...R.REF_KINDS].sort(), [...buildable].sort());
  assert.deepEqual(Object.keys(R.KIND_SUMMARY).sort(), [...PresetShare.PRESET_KINDS].sort());
  assert.match(R.KIND_SUMMARY.sounds, /NOT available/);
  const index = R.presetReference('', deps);
  assert.equal(index.ok, true);
  assert.deepEqual(index.kinds, R.KIND_SUMMARY);
  assert.equal(R.presetReference('sounds', deps).ok, false);
  for (const kind of buildable) {
    const r = ref(kind);
    assert.equal(r.ok, true, kind);
    assert.equal(r.kind, kind);
    assert.ok(r.example && typeof r.example === 'object', kind + ' example');
  }
});

test('theme lists every theme key and every bar look key a theme carries', () => {
  const r = ref('theme');
  assert.deepEqual(Object.keys(r.keys).sort(), [...PresetShare.THEME_KEYS].sort());
  assert.deepEqual(Object.keys(r.topbarLook).sort(), [...TopbarLook.THEME_KEYS].sort());
  assert.match(r.keys.panelAlpha, /^number [\d.]+-[\d.]+ \(default [\d.]+\)$/);
});

test('top bar lists every look field, island item and button id', () => {
  const r = ref('topbar');
  const lookKeys = Object.keys(TopbarLook.DEFAULTS).filter((k) => k !== 'version');
  assert.deepEqual(Object.keys(r.fields.look).sort(), lookKeys.sort());
  for (const [key, choices] of Object.entries(TopbarLook.CHOICES)) {
    if (lookKeys.includes(key)) assert.equal(r.fields.look[key], choices.join('|'), key);
  }
  const clock = deps.normalizeSettings({}).topbarClock;
  for (const item of clock.items) assert.ok(r.fields.clock.items.includes(item.id), 'item ' + item.id);
  for (const action of clock.actions) assert.ok(r.fields.clock.actions.includes(action.id), 'button ' + action.id);
});

test('deck lists every key style field, trigger slot, slider target and look choice', () => {
  const r = ref('deck');
  for (const field of DeckModel.KEY_STYLE_FIELDS) assert.ok(field in r.key, 'style ' + field);
  for (const slot of DeckModel.KEY_TRIGGERS) assert.ok(r.key.triggers.includes(slot), 'slot ' + slot);
  for (const target of DeckModel.SLIDER_TARGETS) assert.ok(r.key.slider.includes(target), 'slider ' + target);
  assert.equal(r.look.capStyle, DeckModel.CAP_STYLES.join('|'));
  assert.equal(r.look.keyShape, DeckModel.KEY_SHAPES.join('|'));
  assert.equal(r.look.plate, DeckModel.PLATE_STYLES.join('|'));
});

test('ambient layout lists every element type with all its props, and its choices survive', () => {
  const r = ref('ambient-layout');
  const types = [...AmbientScene.COMPONENT_TYPES];
  for (const type of types) assert.ok(r.component.type.split('|').includes(type), 'type ' + type);
  for (const type of Object.keys(r.props)) {
    const defaults = AmbientScene.normalizeProps(type, {});
    assert.deepEqual(Object.keys(r.props[type]).sort(), Object.keys(defaults).sort(), type);
    for (const [key, value] of Object.entries(r.props[type])) {
      if (typeof value !== 'string' || !value.includes('|')) continue;
      for (const choice of value.split('|')) {
        assert.equal(AmbientScene.normalizeProps(type, { [key]: choice })[key], choice, type + '.' + key + '=' + choice);
      }
    }
  }
  // Types with props the normalizer knows are all described.
  for (const type of types) {
    if (Object.keys(AmbientScene.normalizeProps(type, {})).length) assert.ok(type in r.props, 'props of ' + type);
  }
});

test('page lists every built-in widget id with its default size', () => {
  const r = ref('page');
  for (const w of deps.dashboardWidgets) assert.equal(r.widgets[w.id], w.w + 'x' + w.h, w.id);
  assert.equal(r.style.font, DashboardInstances.TILE_FONTS.join('|'));
});

test('the values held by hand still match the normalizers', () => {
  for (const [key, values] of Object.entries(R.THEME_ENUMS)) {
    for (const v of values) assert.equal(deps.normalizeSettings({ [key]: v })[key], v, key + '=' + v);
    assert.notEqual(deps.normalizeSettings({ [key]: 'zz-not-a-value' })[key], 'zz-not-a-value', key);
  }
  for (const style of R.BG_STATIC_STYLES) assert.equal(deps.normalizeSettings({ bgStatic: { style } }).bgStatic.style, style);
  for (const align of R.ISLAND_ALIGNS) {
    assert.equal(deps.normalizeSettings({ topbarClock: { align } }).topbarClock.align, align);
  }
  const alignTypes = Object.keys(ref('ambient-layout').props).filter((t) => 'align' in AmbientScene.normalizeProps(t, {}));
  assert.ok(alignTypes.length, 'some element has align');
  for (const type of alignTypes) {
    for (const align of R.SCENE_ALIGNS) assert.equal(AmbientScene.normalizeProps(type, { align }).align, align, type);
  }
  for (const key of R.TILE_STYLE_COLORS) {
    assert.equal(DashboardInstances.normalizeTileStyle({ mode: 'custom', [key]: '#123456' })[key], '#123456', key);
  }
  for (const [key, [lo, hi]] of Object.entries(R.TILE_STYLE_RANGES)) {
    const keep = (v) => DashboardInstances.normalizeTileStyle({ mode: 'custom', [key]: v })[key];
    assert.equal(keep(lo), lo, key + ' low');
    assert.equal(keep(hi), hi, key + ' high');
    assert.equal(keep(hi + 1), undefined, key + ' over');
  }
});

test('each reference stays small enough for one tool result', () => {
  for (const kind of R.REF_KINDS) assert.ok(text(ref(kind)).length < 6000, kind + ' ' + text(ref(kind)).length);
});
