import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { engineSource } from './engine-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..');
const read = (...parts) => readFileSync(join(server, ...parts), 'utf8');

test('semantic contract loads after light compatibility and before visual skins', () => {
  const html = read('index.html');
  const light = html.indexOf('styles/themes-light.css');
  const contract = html.indexOf('styles/theme-contract.css');
  const retro = html.indexOf('styles/themes-retro.css');
  const comic = html.indexOf('styles/themes-comic.css');
  assert.equal(light >= 0 && light < contract, true);
  assert.equal(contract < retro && retro < comic, true);
  assert.equal(
    html.indexOf('<script src="js/theme-palette.js"') < html.indexOf('<script src="js/settings.js"'),
    true,
  );
});

test('components use the active appearance attribute, not the retired theme flag', () => {
  const files = [
    ['components', 'DiscordInvite', 'DiscordInvite.css'],
    ['components', 'FootballWidget', 'FootballWidget.css'],
    ['components', 'NewsWidget', 'NewsWidget.css'],
    ['components', 'StockWidget', 'StockWidget.css'],
    ['components', 'Ticker', 'Ticker.css'],
  ];
  for (const parts of files) assert.doesNotMatch(read(...parts), /data-theme=/, parts.join('/'));
});

test('Comic does not create a muted-text custom-property cycle', () => {
  const css = read('styles', 'themes-comic.css');
  assert.match(css, /--comic-muted:\s*var\(--muted-text\)/);
  assert.doesNotMatch(css, /--muted-text:\s*var\(--comic-muted\)/);
  assert.doesNotMatch(css, /--text-muted:\s*var\(--comic-muted\)/);
});

test('semantic theme roles are carried by client, server and preset persistence', () => {
  const roles = [
    'surface', 'surfaceAlt', 'controlColor', 'mutedText', 'lineColor', 'accentText',
    'successColor', 'warningColor', 'dangerColor', 'infoColor', 'contrastGuard',
  ];
  const persistenceFiles = [read('js', 'settings.js'), read('js', 'preset-share.js'), engineSource()];
  for (const role of roles) {
    for (const source of persistenceFiles) assert.match(source, new RegExp(`\\b${role}\\b`), role);
  }

  const tileSource = read('js', 'dashboard-instances.js');
  for (const role of roles.filter((role) => role !== 'surface')) {
    const tileRole = role === 'surfaceAlt' ? 'surfaceAlt' : role;
    assert.match(tileSource, new RegExp(`\\b${tileRole}\\b`), `tile ${tileRole}`);
  }
  assert.match(tileSource, /\bpanel\b/, 'tile panel surface');
});

// A dual-palette theme is only useful if the pair survives a restart, another
// dashboard surface and a re-import, so all three persistence layers must carry
// the field — and both normalizers must route through the shared engine rather
// than growing a second copy of the rules that can drift.
test('paletteVariants is carried by client, server and preset persistence', () => {
  for (const parts of [['js', 'settings.js'], ['js', 'preset-share.js'], ['server.js']]) {
    assert.match(read(...parts), /\bpaletteVariants\b/, parts.join('/'));
  }
  assert.match(read('js', 'settings.js'), /ThemePalette\.normalizeVariants/);
  assert.match(engineSource(), /themePalette\.normalizeVariants/);
});

test('per-widget palettes rebuild material aliases at tile scope', () => {
  const source = read('js', 'dashboard-layout.js');
  for (const token of ['--panel', '--panel-soft', '--panel-border', '--glass-bg', '--slider-fill', '--slider-track']) {
    assert.match(source, new RegExp(`['\"]${token}['\"]\\s*:`), token);
  }
  assert.match(read('js', 'theme-palette.js'), /'--line-rgb'/);
});

test('Vitals portals and Bit pixel surfaces consume semantic theme roles', () => {
  const vitals = read('components', 'VitalsWidget', 'VitalsWidget.css');
  const pet = read('components', 'VitalsPet', 'VitalsPet.css');
  const contract = read('styles', 'theme-contract.css');
  const comic = read('styles', 'themes-comic.css');

  assert.match(vitals, /\.vt-card[\s\S]*background:\s*var\(--surface\)/);
  assert.match(vitals, /\.vt-card[\s\S]*color:\s*var\(--text\)/);
  assert.match(vitals, /\.vt-overlay[\s\S]*color-mix\(in srgb, var\(--bg\)/);
  assert.doesNotMatch(vitals, /rgba\(18,\s*22,\s*26/);
  assert.match(contract, /Vitals opens its detail view through a body-level portal/);

  assert.match(pet, /--vpet-surface:\s*var\(--surface\)/);
  assert.match(pet, /--vpet-text:\s*var\(--text\)/);
  assert.match(pet, /\.vpet-menu-head[\s\S]*color:\s*var\(--vpet-text\)/);
  assert.match(pet, /\.vpet-menu-act[^\{]*\{[^}]*color:\s*var\(--vpet-text\)/);
  assert.doesNotMatch(pet, /#0d1117|#e8f4ff/);

  assert.match(comic, /:root\[data-style="comic"\] \.vt-card/);
  assert.match(comic, /:root\[data-style="comic"\] \.vt-overlay/);
});

test('Vivid redraws only opted-in Deck profiles with paper-backed icon and label contrast', () => {
  const css = read('styles', 'themes-comic.css');
  const start = css.indexOf('/* ── Deck cap theme: Vivid / Fumetto');
  const end = css.indexOf('/* The profile menu', start);
  const deck = css.slice(start, end);

  assert.equal(start >= 0 && end > start, true);
  assert.match(deck, /\.deck-root\[data-capstyle="vivid"\]/);
  assert.doesNotMatch(deck, /:root\[data-style="comic"\]/, 'dashboard Comic must not force every Deck profile');
  assert.match(deck, /\.deck-device[\s\S]*var\(--deck-comic-board\)/);
  assert.match(deck, /\.deck-key:not\(\.has-image\):not\(\.is-slider\) \.deck-ico/);
  assert.match(deck, /\.deck-key \.deck-label[\s\S]*color:\s*var\(--comic-ink\)\s*!important/);
  assert.match(deck, /drop-shadow\(1px 0 0 var\(--comic-ink\)\)/);
  assert.match(deck, /drop-shadow\(-1px 0 0 var\(--comic-ink\)\)/);
  assert.match(deck, /\.deck-key\.has-accent[\s\S]*color-mix\(in srgb, var\(--key-accent/);
  assert.match(deck, /--comic-paper:\s*#[0-9a-f]{6}/i, 'standalone Deck theme needs its own palette');
});

test('Comic Deck ambient motion is transform-only and has reduced-motion exits', () => {
  const css = read('styles', 'themes-comic.css');
  assert.match(css, /@keyframes comic-deck-rays[\s\S]*transform:/);
  assert.match(css, /@keyframes comic-deck-halftone[\s\S]*translate3d/);
  assert.match(css, /\.deck-well::before,[\s\S]*\.deck-well::after[\s\S]*will-change:\s*transform/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.deck-well::before/);
  assert.match(css, /body\.perf-mode[\s\S]*\.deck-well::before/);
  for (const name of ['comic-deck-rays', 'comic-deck-halftone']) {
    const body = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
    assert.notEqual(body, '', name);
    assert.doesNotMatch(body, /(?:background-position|box-shadow|filter)\s*:/, name);
  }
});

test('Comic Deck windows are paper, with the theme Text on them and the backdrop of the other windows', () => {
  const css = read('styles', 'themes-comic.css');
  assert.match(css, /\.deck-style-dialog[\s\S]*background:\s*var\(--comic-paper-fill\)/);
  const skin = css.slice(0, css.indexOf('.deck-root[data-capstyle="vivid"]'));
  assert.ok(!skin.includes('--text: var(--comic-ink)'), 'the ink is Lines & borders, dim on Auto: words stay the theme Text');
  assert.doesNotMatch(css, /\.deck-style-modal/, 'the overlay stays the one every Deck window has');
  assert.match(css, /\.deck-seg button\.active \{\s*color:\s*var\(--text\)/);
});

test('on Comic the ink stays on the lines: words and key marks are the theme Text', () => {
  const css = read('styles', 'themes-comic.css');
  const rule = (selector) => css.slice(css.indexOf(selector)).match(/\{[^}]*\}/)?.[0] || '';
  for (const selector of [
    ':root[data-style="comic"] :is(.deck-tools, .deck-seg) {',
    ':root[data-style="comic"] .deck-seg button {',
    ':root[data-style="comic"] :is(.control-btn, .msp-ctl, .msp-pill, .media-vol-mute) {',
    ':root[data-style="comic"] .deck-pmenu {',
    ':root[data-style="comic"] .deck-pmenu-add {',
  ]) {
    assert.match(rule(selector), /[^-]color: var\(--text\);/, selector);
  }
  assert.match(rule(':root[data-style="comic"] .control-btn.primary {'), /[^-]color: var\(--on-accent\);/, 'the line on the accent measured 1.9 to 1');
  assert.doesNotMatch(css, /\.deck-pmenu-(?:pick|input) \{\s*color: var\(--comic-ink\)/);
});

test('the first question has one main key: the quiet one is not painted as primary', () => {
  const js = read('js', 'surface-picker.js');
  assert.match(js, /go\.className = 'settings-btn primary sp-go';/);
  assert.match(js, /go\.className = 'settings-btn sp-go sp-go-quiet';/, 'Comic paints every .settings-btn.primary alike');
});

test('on a light Comic theme the music keys keep the dark paper of their tile', () => {
  assert.ok(read('styles', 'themes-light.css').includes(':root[data-appearance="light"]:not([data-style="liquid"]) .media-panel {\n  --text: #f3f7f5;'));
  assert.ok(read('styles', 'themes-comic.css').includes(':root[data-style="comic"][data-appearance="light"] .media-panel { --comic-paper-soft: rgba(15, 20, 19, 0.55); }'), 'light marks on the page paper measured 1:1');
});

test('the weather window follows the theme like the tile', () => {
  const wx = read('components', 'WeatherModal', 'WeatherModal.css');
  const tile = read('components', 'WeatherTile', 'WeatherTile.css');
  const contract = read('styles', 'theme-contract.css');

  // It used to be a dark island with a painted sky under every palette. It is a sheet now, so
  // nothing may fix the colour of its words: the theme's surface list paints it.
  assert.doesNotMatch(wx, /--text:\s*#/);
  assert.doesNotMatch(wx, /\.weather-metric|\.weather-hero/);
  assert.doesNotMatch(read('styles', 'themes-light.css'), /\.weather-panel/);
  assert.match(contract, /\.perf-sheet, \.weather-panel/);
  assert.match(tile, /\n\.weather-fc-max \{[^}]*color:\s*var\(--text\)/, 'the tile sits on the widget panel\'s paper');
});
