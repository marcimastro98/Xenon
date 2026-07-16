import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  const persistenceFiles = [read('js', 'settings.js'), read('js', 'preset-share.js'), read('server.js')];
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

test('Comic Deck editor uses a paper dialog while preserving the modal backdrop', () => {
  const css = read('styles', 'themes-comic.css');
  assert.match(css, /\.deck-style-dialog[\s\S]*background:\s*var\(--comic-paper-fill\)/);
  assert.match(css, /\.deck-style-modal[\s\S]*color-mix\(in srgb, var\(--comic-ink\)/);
  assert.match(css, /\.deck-seg button\.active[\s\S]*color:\s*var\(--comic-ink\)/);
});
