// Auto light/dark keeps following the OS after the user picks their own state
// colours (success / warning / danger / info). Before, any colour edit turned
// Auto's palette off, so the dashboard stayed on the tone it had (GitHub #160).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const ThemeTokens = require('../js/look/theme-tokens.js');
const ThemePalette = require('../js/look/theme-palette.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('on Auto the neutral palette flips with the OS and the state colours stay the user\'s', () => {
  const s = { appearance: 'auto', autoPalette: true, contrastGuard: false, accent: '#3366ff', successColor: '#ff00aa', infoColor: '#00aaff' };
  const light = ThemeTokens.derivePalette(s, { resolve: () => 'light' });
  const dark = ThemeTokens.derivePalette(s, { resolve: () => 'dark' });
  assert.equal(light.tone, 'light');
  assert.equal(dark.tone, 'dark');
  for (const p of [light, dark]) {
    assert.equal(p.success, '#ff00aa');
    assert.equal(p.info, '#00aaff');
  }
  assert.equal(light.warning, ThemePalette.STATE.light.warning, 'an untouched role keeps the tone default');
  assert.equal(dark.warning, ThemePalette.STATE.dark.warning);
});

function settingsPage(initial) {
  const ctx = {
    hubSettings: initial,
    _osPrefersDark: true,
    ThemePalette,
    SETTINGS_PRESETS: [],
    normalizeHex: ThemePalette.normalizeHex,
    normalizeSettings: (v) => ({ ...v }),
    saveHubSettings() {}, applyHubSettings() {}, syncSettingsControls() {},
    renderThemeGallery() {}, renderSettingsModal() {}, setSettingsStatus() {}, refreshOsTheme() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('../js/settings/appearance.js'), ctx);
  vm.runInContext(read('../js/settings/colors.js'), ctx);
  return ctx;
}

test('editing a state colour or the accent leaves Auto on; any other role turns it off', () => {
  const page = settingsPage({ appearance: 'auto', autoPalette: true });
  for (const key of ['successColor', 'warningColor', 'dangerColor', 'infoColor', 'accent']) {
    page.updateSettingsColor(key, '#ff00aa');
    assert.equal(page.hubSettings.autoPalette, true, key);
  }
  page.clearSettingsColor('dangerColor');
  assert.equal(page.hubSettings.autoPalette, true, 'resetting a state colour keeps Auto too');
  page.updateSettingsColor('background', '#102030');
  assert.equal(page.hubSettings.autoPalette, false);
  page.updateSettingsColor('successColor', '#00ff00');
  assert.equal(page.hubSettings.autoPalette, false, 'a frozen palette stays frozen');
});

test('choosing Auto again turns it back on and keeps the state colours', () => {
  const page = settingsPage({ appearance: 'dark', autoPalette: false, background: '#102030', successColor: '#ff00aa', mutedText: '#888888' });
  page.setAppearance('auto');
  assert.equal(page.hubSettings.autoPalette, true);
  assert.equal(page.hubSettings.successColor, '#ff00aa');
  assert.equal(page.hubSettings.mutedText, null, 'neutral roles still reset to the stock start');
});
