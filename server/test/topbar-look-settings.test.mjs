// Settings → Top bar (js/topbar-look-settings.js, js/topbar-button-options.js)
// and the side rails' part of the look. What a user would notice if it broke: a
// control that shows its translation key instead of a word, a page that never
// mounts, a reset that leaves the look behind, and above all a look that takes
// away the rail holding Settings or Layout, which would leave the dashboard with
// no way back into either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const L = require('../js/topbar-look.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('../js/topbar-look-settings.js');
const BUTTON = read('../js/topbar-button-options.js');
const INDEX = read('../index.html');
const SETTINGS = read('../js/settings.js');
const MINIMAL = read('../js/topbar-minimal.js');
const CSS = read('../components/Topbar/TopbarLook.css');
const MINIMAL_CSS = read('../components/TopbarMinimal/TopbarMinimal.css');

const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
function loadI18n() {
  const ctx = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] }, localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en' } };
  vm.createContext(ctx);
  vm.runInContext(read('../js/i18n.js') + '\n;globalThis.__i18n = i18n;', ctx);
  return ctx.__i18n;
}

// Every key the two files can put on screen: the literal ones, and the ones
// seg() builds from the model's choices (prefix + value, '-' as '_').
function usedKeys() {
  const keys = new Set();
  for (const src of [PAGE, BUTTON]) for (const m of src.matchAll(/'((?:tbl|topbar_btn)_[a-z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of PAGE.matchAll(/seg\('([a-z_]+)', L\.CHOICES\.([a-zA-Z]+)\)/g)) {
    for (const v of L.CHOICES[m[2]]) keys.add(m[1] + v.replace(/-/g, '_'));
  }
  if (PAGE.includes("'tbl_preset_' + id")) for (const id of L.PRESET_IDS) keys.add('tbl_preset_' + id);
  for (const mode of ['auto', 'always', 'never']) keys.add('tbl_labels_' + mode);
  for (const [, key] of INDEX.matchAll(/data-i18n="(tbl_[a-z0-9_]+)"/g)) keys.add(key);
  return [...keys].filter((k) => !k.endsWith('_'));
}

test('every word on the page exists in all 11 languages', () => {
  const i18n = loadI18n();
  const keys = usedKeys();
  assert.ok(keys.length > 80, 'found the keys: ' + keys.length);
  for (const lang of LANGS) {
    const missing = keys.filter((k) => typeof i18n[lang][k] !== 'string' || !i18n[lang][k].trim());
    assert.deepEqual(missing, [], lang);
  }
  for (const lang of LANGS) {
    for (const k of keys) assert.doesNotMatch(i18n[lang][k], /[–—]/, `${lang}.${k} has a dash`);
  }
  assert.equal(i18n.it.settings_cat_island, 'Barra superiore');
  assert.equal(i18n.en.settings_cat_island, 'Top bar');
  assert.doesNotMatch(i18n.it.settings_topbar_autohide_hint, /10 secondi/, 'the delay is a setting now');
});

test('the page has every host it fills, and loads after settings.js', () => {
  for (const id of ['settings-topbar-look', 'tbl-presets', 'tbl-custom', 'tbl-custom-state', 'tbl-custom-rows',
    'topbar-rails-personalize', 'tbl-rail-rows', 'settings-rails-autohide', 'settings-topbar-notify', 'tbl-notify-rows', 'tbl-clock-rows']) {
    assert.equal(INDEX.split(`id="${id}"`).length, 2, id);
  }
  for (const src of ['js/topbar-look-settings.js', 'js/topbar-button-options.js']) {
    assert.ok(INDEX.indexOf(`src="${src}"`) > INDEX.indexOf('src="js/settings.js"'), src);
  }
  assert.ok(INDEX.includes('href="components/Topbar/TopbarLookSettings.css"'));
  // The rails group is the one settings.js hides in Full.
  assert.match(SETTINGS, /getElementById\('topbar-rails-personalize'\);\n\s+if \(railsRow\) railsRow\.hidden = style === 'full';/);
});

test('settings sync, the button list and the reset all reach the look', () => {
  assert.match(SETTINGS, /buildOptions: \(id\) => \(window\.TopbarButtonOptions \? TopbarButtonOptions\.panel\(id\) : null\)/);
  const sync = SETTINGS.slice(SETTINGS.indexOf('function syncTopbarClockControls()'));
  assert.match(sync.slice(0, sync.indexOf('\n}\n')), /TopbarLookSettings\.sync\(\)/);
  const reset = SETTINGS.slice(SETTINGS.indexOf('async function resetDynamicIslandSettings()'));
  const body = reset.slice(0, reset.indexOf('\n}\n'));
  assert.match(body, /topbarLook: DEFAULT_HUB_SETTINGS\.topbarLook,/);
  assert.match(body, /TopbarLook\.apply\(hubSettings\.topbarLook\)/);
});

test('a preset changes only the bar-wide look, never the rails or the buttons', () => {
  const mine = L.normalize({ railLeft: 'off', railAlign: 'top', railDelay: 25, accent: 'search', buttons: { lock: { label: 'Chiudi' } } });
  for (const id of L.PRESET_IDS) {
    const next = L.withPreset(mine, id);
    assert.equal(next.railLeft, 'off', id);
    assert.equal(next.railAlign, 'top', id);
    assert.equal(next.railDelay, 25, id);
    assert.equal(next.accent, 'search', id);
    assert.equal(next.buttons.lock.label, 'Chiudi', id);
    assert.equal(L.presetOf(next), id);
  }
});

test('the hide delay is kept between 3 and 60 seconds and reaches the countdown', () => {
  assert.equal(L.normalize({}).railDelay, 10);
  assert.equal(L.normalize({ railDelay: 1 }).railDelay, 3);
  assert.equal(L.normalize({ railDelay: 999 }).railDelay, 60);
  assert.equal(L.normalize({ railDelay: 'x' }).railDelay, 10);
  assert.match(MINIMAL, /setRailsHidden\(true\); \}, autoHideMs\(\)\);/);
  assert.doesNotMatch(MINIMAL, /AUTO_HIDE_MS\b/);
});

// The promise that matters most: whatever the look says, the rail holding
// Settings or Layout stays on screen. Checked by :has() in CSS, so it holds for
// a share code or a hand-edited settings file as much as for the page.
test('a rail holding Settings or Layout can never be switched off', () => {
  assert.deepEqual([...L.RAIL_KEEPERS], ['settings', 'layout']);
  const keepers = L.RAIL_KEEPERS.map((id) => L.BUTTON_SELECTORS[id]);
  for (const side of ['left', 'right']) {
    const rule = CSS.split('\n').find((line) => line.includes(`[data-tb-rail-${side}="off"]`));
    assert.ok(rule, side);
    assert.ok(rule.includes(`.edge-rail-${side}:not(:has(${keepers.join(', ')}))`), rule);
  }
  // And the off rule is the only one that hides a rail.
  const hides = CSS.split('}').filter((r) => /edge-rail[^{]*\{[^}]*display:\s*none/.test(r) && !r.includes('edge-rail-body'));
  assert.equal(hides.length, 1);
});

test('the page says when a side cannot be switched off', () => {
  assert.match(PAGE, /keeperNote\('left'\)/);
  assert.match(PAGE, /keeperNote\('right'\)/);
  assert.match(PAGE, /L\.RAIL_KEEPERS\.includes\(a\.id\)/);
});

test('the rail transforms keep their old values until a look sets them', () => {
  assert.match(MINIMAL_CSS, /transform: translateY\(var\(--rail-y, -50%\)\);/);
  assert.match(MINIMAL_CSS, /\.edge-rail-left\.is-collapsed  \{ transform: translate\(calc\(-100% \+ 22px\), var\(--rail-y, -50%\)\); \}/);
  assert.match(MINIMAL_CSS, /\.edge-rail-left\.is-auto-hidden  \{ transform: translate\(calc\(-100% \+ var\(--rail-hide-peek, 22px\)\), var\(--rail-y, -50%\)\); \}/);
  // Only a rail that hid itself may lose its handle: one the user closed by hand
  // has no other way to open again.
  assert.match(CSS, /\[data-tb-rail-peek="edge"\] body\.topbar-minimal \.edge-rail\.is-auto-hidden \{ --rail-hide-peek: 0px; \}/);
  assert.doesNotMatch(CSS, /is-collapsed[^{]*\{[^}]*--rail-hide-peek/);
});

test('page text is set with textContent, never as markup', () => {
  for (const src of [PAGE, BUTTON]) {
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  }
});

// The icon picker draws the Deck's shapes, whose paths carry no fill of their
// own: without currentColor they render black on the dark panel.
test('the icon picker shows the icons in the panel text colour, by group', () => {
  const css = read('../components/Topbar/TopbarLookSettings.css');
  assert.match(css, /\.tbo-icon-cell svg \{[^}]*fill: currentColor;/);
  assert.match(css, /\.tbo-icon-cell \{[^}]*color: var\(--text\);/);
  assert.match(BUTTON, /lib\.CATEGORIES/);
  assert.match(BUTTON, /'tbo-icon-cat'/);
  assert.match(BUTTON, /!seen\.has\(name\)/, 'an icon in two groups is shown once');
});

test('on the side that must stay, "Off" is greyed out instead of doing nothing', () => {
  assert.match(PAGE, /b\.disabled = locked && b\.dataset\.tbValue === 'off';/);
  assert.match(read('../components/Topbar/TopbarLookSettings.css'), /\.tbl-seg \.settings-segment-btn:disabled/);
});

test('an empty colour says what it means', () => {
  assert.match(PAGE, /text\('span', 'tbl_preset_theme', 'settings-hint tbl-color-state'\)/);
  assert.match(BUTTON, /text\('span', 'tbl_btn_default', 'settings-hint tbl-color-state'\)/);
});

test('a first label on an "Automatic" button turns the label on', () => {
  assert.match(BUTTON, /const first = !current\(id\)\.label && input\.value\.trim\(\) && current\(id\)\.labelMode === 'auto';/);
  assert.match(BUTTON, /first \? \{ label: input\.value, labelMode: 'always' \} : \{ label: input\.value \}/);
});
