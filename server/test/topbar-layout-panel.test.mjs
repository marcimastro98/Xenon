// Layout mode → "Customize bar" (js/topbar-layout-panel.js). What a user would
// notice if it broke: no way to open it from the Layout dock, a panel that
// stays on screen after "Done", a list that does not follow the one in
// Settings, or words shown as their translation key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PANEL = read('../js/topbar-layout-panel.js');
const LOOK_PAGE = read('../js/topbar-look-settings.js');
const LAYOUT = read('../js/dashboard-layout.js');
const SETTINGS = read('../js/settings.js');
const INDEX = read('../index.html');
const CSS = read('../components/Topbar/TopbarLayoutPanel.css');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function loadI18n() {
  const ctx = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] }, localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en' } };
  vm.createContext(ctx);
  vm.runInContext(read('../js/i18n.js') + '\n;globalThis.__i18n = i18n;', ctx);
  return ctx.__i18n;
}

test('the panel loads after the controls it reuses, with its stylesheet', () => {
  const at = (src) => INDEX.indexOf(`src="${src}"`);
  assert.ok(at('js/topbar-layout-panel.js') > at('js/topbar-look-settings.js'));
  assert.ok(at('js/topbar-layout-panel.js') > at('js/topbar-button-options.js'));
  assert.ok(INDEX.includes('href="components/Topbar/TopbarLayoutPanel.css"'));
});

test('the Layout dock opens it, and leaving Layout mode closes it', () => {
  assert.match(LAYOUT, /createDashboardChip\('tbp_open', 'tbp_open', DASHBOARD_LAYOUT_ICONS\.tune, \(\) => window\.TopbarLayoutPanel\.open\(\)\)/);
  assert.match(LAYOUT, /if \(!dashboardLayoutEditing && window\.TopbarLayoutPanel\) window\.TopbarLayoutPanel\.close\(\);/);
});

test('the button list is drawn in Settings and in the panel from one function', () => {
  assert.match(SETTINGS, /\['topbar-actions-editor', 'tbp-actions-editor'\]\.forEach\(renderTopbarActionsEditorIn\)/);
  assert.match(PANEL, /buttons\.id = 'tbp-actions-editor';/);
});

test('the look controls can be mounted again elsewhere and are dropped when gone', () => {
  assert.match(LOOK_PAGE, /window\.TopbarLookSettings = \{[^}]*mountInto[^}]*\}/);
  assert.match(LOOK_PAGE, /if \(!mounted\[i\]\[0\]\.isConnected\) mounted\.splice\(i, 1\);/);
  assert.match(PANEL, /mountInto\(built\.presets, 'presets'\)/);
});

test('every listener the panel adds is removed on close', () => {
  assert.match(PANEL, /document\.addEventListener\('keydown', onKey\);/);
  const close = PANEL.slice(PANEL.indexOf('function closePanel()'));
  assert.match(close.slice(0, close.indexOf('\n  }\n')), /document\.removeEventListener\('keydown', onKey\);/);
});

test('rails are offered only where they exist (Minimal or None, not on a phone)', () => {
  assert.match(PANEL, /classList\.contains\('is-stacked'\)\) return false;/);
  assert.match(PANEL, /layout\.topbarHidden === true\) \|\| hubSettings\.topbarStyle === 'minimal'/);
});

test('words exist in all 11 languages and the panel builds no markup from strings', () => {
  const i18n = loadI18n();
  const keys = new Set();
  for (const m of PANEL.matchAll(/'((?:tbp|tbl|topbar|settings)_[a-z0-9_]+)'/g)) keys.add(m[1]);
  keys.add('tbp_open');
  for (const lang of LANGS) {
    for (const k of keys) {
      assert.equal(typeof i18n[lang][k], 'string', `${lang}.${k}`);
      assert.doesNotMatch(i18n[lang][k], /[–—]/, `${lang}.${k}`);
    }
  }
  assert.doesNotMatch(PANEL, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('touch targets in the panel are finger-sized, 44px on a phone', () => {
  assert.match(CSS, /@media \(max-width: 560px\) \{\n  \.tbp \.island-edit-side-btn \{ min-height: 44px; \}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\n  \.tbp \{ animation: none; \}/);
});
