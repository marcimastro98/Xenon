// The look of a new install (Liquid Glass over the Dusk wallpaper), and the promise
// that came with it: whoever already has Xenon keeps the look they have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadServerSettingsSlice } from './server-settings-slice.mjs';
import { WALLPAPERS } from '../../tools/wallpapers/scenes.mjs';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..');
const read = (...p) => readFileSync(path.join(SERVER, ...p), 'utf8').replace(/\r\n/g, '\n'); // LF on a CRLF checkout too

const SETTINGS = read('js', 'settings.js');
const SERVER_JS = engineSource();
const INDEX = read('index.html');
const LIQUID_CSS = read('styles', 'themes-liquid.css');
const PresetShare = require('../js/preset-share.js');
const Palette = require('../js/theme-palette.js');
const { remotePathAllowed } = require('../remote-access.js');
const normalizeOnServer = loadServerSettingsSlice();

function defaultsOf(source) {
  const at = source.indexOf('const DEFAULT_HUB_SETTINGS = Object.freeze({');
  assert.notEqual(at, -1, 'DEFAULT_HUB_SETTINGS is gone');
  return source.slice(at, source.indexOf('\n});\n', at));
}

function valueOf(block, key) {
  const m = block.match(new RegExp(`\\n {2}${key}: (.+?),?(?:\\s*//.*)?\\n`));
  assert.ok(m, 'no default for ' + key);
  return m[1];
}

test('the app and the server start a new install on the same look', () => {
  const client = defaultsOf(SETTINGS);
  const server = defaultsOf(SERVER_JS);
  for (const key of ['styleMode', 'topbarStyle', 'accent', 'background', 'panelAlpha', 'clockDateFormat', 'bgStatic', 'bgAurora', 'bgGrid']) {
    assert.equal(valueOf(server, key), valueOf(client, key), key);
  }
  assert.equal(valueOf(client, 'styleMode'), `'liquid'`);
  assert.equal(valueOf(client, 'bgStatic'), `Object.freeze({ style: 'dusk', intensity: 100 })`);
});

test('settings saved before 5.0.0 stay as they are on the server', () => {
  const old = normalizeOnServer({});
  assert.equal(old.styleMode, 'glass');
  assert.equal(old.topbarStyle, 'full');
  assert.equal(old.bgStatic.style, 'none');
  assert.match(SERVER_JS, /clockDateFormat: \['full', 'medium', 'short'\]\.includes\(source\.clockDateFormat\) \? source\.clockDateFormat : 'full'/);
});

test('the server keeps the new look once it is saved, and refuses what it does not know', () => {
  const saved = normalizeOnServer({ styleMode: 'liquid', topbarStyle: 'minimal', bgStatic: { style: 'dusk', intensity: 100 } });
  assert.equal(saved.styleMode, 'liquid');
  assert.equal(saved.topbarStyle, 'minimal');
  assert.deepEqual({ ...saved.bgStatic }, { style: 'dusk', intensity: 100 });
  assert.equal(normalizeOnServer({ styleMode: 'neon' }).styleMode, 'glass');
  assert.equal(normalizeOnServer({ bgStatic: { style: 'neon' } }).bgStatic.style, 'none');
});

function builtinCard(id) {
  const at = SETTINGS.indexOf(`id: '${id}', nameKey: 'settings_style_`);
  assert.notEqual(at, -1, `the ${id} card is gone`);
  return SETTINGS.slice(at, SETTINGS.indexOf('}),\n', at));
}

test('Classic gives back every value that used to be the factory default', () => {
  const at = SETTINGS.indexOf('const CLASSIC_BACKDROP = Object.freeze({');
  assert.notEqual(at, -1, 'the old backdrop is gone');
  const backdrop = SETTINGS.slice(at, SETTINGS.indexOf('\n});\n', at));
  for (const line of [`panelAlpha: 0.94`, `style: 'none'`]) assert.ok(backdrop.includes(line), line);
  assert.match(backdrop, /bgAurora: Object\.freeze\(\{ enabled: true/);
  assert.match(backdrop, /bgGrid: Object\.freeze\(\{ enabled: true, color: '#1ed760'/);
  const card = builtinCard('glass');
  for (const line of [`accent: '#1ed760'`, `background: '#070808'`, '...CLASSIC_BACKDROP']) assert.ok(card.includes(line), line);
});

test('Pixel Retro stays on the backdrop it was drawn for, not on the new wallpaper', () => {
  assert.ok(builtinCard('retro').includes('...CLASSIC_BACKDROP'));
});

test('deleting the theme in use lands on the factory look, not on a fixed style', () => {
  assert.match(SETTINGS, /applyThemeById\(DEFAULT_HUB_SETTINGS\.styleMode\);/);
});

test('a theme code with colours and no wallpaper turns the wallpaper off', () => {
  const colours = { accent: '#123456', background: '#000000', text: '#ffffff' };
  assert.equal(PresetShare.themeImportPatch(colours).bgStatic.style, 'none');
  const own = PresetShare.themeImportPatch({ ...colours, bgStatic: { style: 'halo', intensity: 40 } });
  assert.equal(own.bgStatic.style, 'halo');
  assert.ok(!('bgStatic' in PresetShare.themeImportPatch({ styleMode: 'retro' })), 'a code with no colours says nothing about it');
});

test('a saved theme that says nothing of its backdrop keeps the old one, not the new wallpaper', () => {
  const at = SETTINGS.indexOf('function normalizeCustomThemes(list) {');
  assert.notEqual(at, -1, 'the saved themes normalizer is gone');
  const body = SETTINGS.slice(at, SETTINGS.indexOf('\n}\n', at) + 2);
  const same = (v) => v;
  const context = {
    DEFAULT_HUB_SETTINGS: { panelAlpha: 'new', bgAurora: 'new', bgGrid: 'new', bgStatic: 'new' },
    CLASSIC_BACKDROP: { panelAlpha: 'old', bgAurora: 'old', bgGrid: 'old', bgStatic: 'old' },
    SETTINGS_MIN_PANEL_ALPHA: 0,
    clampNumber: (v, min, max, fallback) => v ?? fallback,
    normalizeHex: same, normStyleMode: same, normalizePaletteVariants: same, sanitizeUiFont: same,
    normalizeBgAurora: same, normalizeBgGrid: same, normalizeBgStatic: same, normalizeBgCustom: same,
    TopbarLook: { themePart: () => null },
  };
  vm.createContext(context);
  const normalize = vm.runInContext(`(${body})`, context);
  const [bare, full] = normalize([{ id: 'bare' }, { id: 'full', panelAlpha: 0.7, bgAurora: 'mine', bgGrid: 'mine', bgStatic: 'mine' }]);
  for (const key of ['panelAlpha', 'bgAurora', 'bgGrid', 'bgStatic']) assert.equal(bare[key], 'old', key);
  assert.equal(full.panelAlpha, 0.7);
  for (const key of ['bgAurora', 'bgGrid', 'bgStatic']) assert.equal(full[key], 'mine', key);
});

test('a theme code can switch its backdrop with a plain yes or no', () => {
  // Deep Ocean, the catalog's most installed theme, is written like this. Read as
  // nothing, it fell on the factory values: no aurora, and the new wallpaper behind it.
  const patch = PresetShare.themeImportPatch({ accent: '#4cc3ff', background: '#050d16', text: '#eaf4fb', bgAurora: true, bgGrid: false, bgStatic: false });
  assert.equal(patch.bgAurora.enabled, true);
  assert.equal(patch.bgGrid.enabled, false);
  assert.equal(patch.bgStatic.style, 'none');
  assert.equal(PresetShare.themeImportPatch({ bgStatic: false }).bgStatic.style, 'none', 'a code with no colours can say it too');
  const full = { enabled: true, intensity: 20, speed: 10 };
  assert.deepEqual(PresetShare.themeImportPatch({ bgAurora: full }).bgAurora, full);
});

test('every wallpaper is shipped, small, and reachable from a paired device', () => {
  const css = read('styles', 'backgroundfx.css');
  for (const name of Object.keys(WALLPAPERS)) {
    const file = path.join(SERVER, 'assets', 'wallpapers', `${name}.webp`);
    assert.ok(existsSync(file), name);
    const head = readFileSync(file).subarray(0, 12).toString('latin1');
    assert.ok(head.startsWith('RIFF') && head.endsWith('WEBP'), name + ' is not a WebP');
    assert.ok(statSync(file).size <= 64 * 1024, name + ' is over 64 KB');
    assert.ok(css.includes(`assets/wallpapers/${name}.webp`), name + ' is not used');
    assert.ok(remotePathAllowed(`/assets/wallpapers/${name}.webp`, 'GET'), name + ' is out of a phone\'s reach');
  }
  assert.ok(remotePathAllowed('/styles/themes-liquid.css', 'GET'));
  const ignored = read('..', '.gitattributes').split('\n').filter((l) => l.includes('export-ignore') && l.startsWith('server/'));
  assert.ok(!ignored.some((l) => /^server\/(assets|styles)/.test(l)), 'the update zip would leave them out');
});

test('the wallpaper can be picked in Settings, and the card shows it', () => {
  assert.match(INDEX, /data-bgstatic="dusk"/);
  assert.match(INDEX, /<link[^>]+styles\/themes-liquid\.css/);
  const modal = read('components', 'SettingsModal', 'SettingsModal.css');
  assert.match(modal, /\.bgstatic-prev\.dusk/);
  assert.match(modal, /\.theme-card--liquid \.theme-card-preview/);
});

test('the three new names exist in all 11 languages', () => {
  const i18n = appStringsSource();
  for (const key of ['settings_style_liquid', 'settings_style_glass', 'settings_bg_static_dusk']) {
    const found = i18n.match(new RegExp(`["']?${key}["']?:`, 'g')) || [];
    assert.equal(found.length, 11, key);
  }
});

// From the start of `selector` to the end of its rule.
function ruleFrom(selector, from = 0) {
  const at = LIQUID_CSS.indexOf(selector, from);
  assert.notEqual(at, -1, 'no rule for ' + selector);
  return LIQUID_CSS.slice(at, LIQUID_CSS.indexOf('}', at));
}

const SHEET_TOKENS = ['--panel: rgba(', '--panel-soft: rgba(', '--card-surface: var(--panel-soft)'];

test('glass gives way where the machine or the person asks for it', () => {
  assert.match(ruleFrom(':root[data-style="liquid"] body.low-power-gpu { --panel-alpha'), /--panel-alpha: 0\.86;/);
  const media = LIQUID_CSS.indexOf('prefers-reduced-transparency');
  assert.match(ruleFrom('body.low-power-gpu', media), /--panel-alpha: 0\.92;/, 'a low-power machine still gets what the person asked for');
  assert.match(LIQUID_CSS.slice(media), /backdrop-filter: none/);
});

test('a widget window goes solid: no wallpaper and no blur behind the words', () => {
  const rule = ruleFrom(':root[data-style="liquid"][data-layer] body { --panel-alpha');
  assert.match(rule, /--panel-alpha: 0\.94;/);
  assert.match(rule, /--panel-soft-alpha: 0\.92;/);
  assert.ok(LIQUID_CSS.indexOf('[data-layer] body { --panel-alpha') > LIQUID_CSS.indexOf('prefers-reduced-transparency'),
    'it comes last: on a low-power machine it still has to win');
});

test('a thicker sheet reaches the cards inside a tile as well', () => {
  // These tokens resolve where they are declared: a rule that only moved the alpha
  // would leave them on the thin value set at :root.
  const shared = ruleFrom(':root[data-style="liquid"] body.low-power-gpu,\n:root[data-style="liquid"][data-layer] body');
  const reduced = ruleFrom('body.low-power-gpu', LIQUID_CSS.indexOf('prefers-reduced-transparency'));
  for (const token of SHEET_TOKENS) {
    assert.ok(shared.includes(token), token);
    assert.ok(reduced.includes(token), token);
  }
});

test('the music tile shows the wallpaper through it, not a picture of the cover', () => {
  assert.match(LIQUID_CSS, /\.media-overlay,\s*:root\[data-style="liquid"\] \.media-bg,\s*:root\[data-style="liquid"\] \.media-bg-fallback \{ display: none; \}/);
});

test('with no cover behind them the words take the ink of the sheet, in light mode too', () => {
  assert.match(LIQUID_CSS, /\.media-title \{ color: var\(--text\); text-shadow: none; \}/);
  assert.match(LIQUID_CSS, /\.media-artist \{ color: var\(--muted-text\); text-shadow: none; \}/);
  const light = read('styles', 'themes-light.css');
  assert.ok(!/:root\[data-appearance="light"\] \.media-panel \{/.test(light), 'the dark island reached Liquid Glass');
  assert.match(light, /:root\[data-appearance="light"\]:not\(\[data-style="liquid"\]\) \.media-panel \{/);
});

test('only dashboard tiles take the glass, and a tile can say no', () => {
  const src = read('js', 'dashboard-layout.js');
  const at = src.indexOf('function tileTakesStyleGlass(');
  assert.notEqual(at, -1);
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const context = { document: { documentElement: { dataset: { style: 'liquid' } } } };
  vm.createContext(context);
  const takes = vm.runInContext(`(${body})`, context);
  const tile = (...attrs) => ({ hasAttribute: (a) => attrs.includes(a) });
  assert.equal(takes(tile('gs-id')), true);
  assert.equal(takes(tile('gs-id'), { glassBlur: 22 }), true);
  assert.equal(takes(tile('gs-id'), { glassBlur: 0 }), false);
  assert.equal(takes(tile('gs-id', 'data-tile-plain')), false);
  assert.equal(takes(tile()), false, 'an ambient scene is not a dashboard tile');
  context.document.documentElement.dataset.style = undefined;
  assert.equal(takes(tile('gs-id')), false, 'Classic has no glass on its tiles');
});

test('grey text is lighter under Liquid Glass, where the tile is brighter than its colour', () => {
  const colours = { background: '#14181c', text: '#f0f3f1', accent: '#6ee787' };
  const glass = Palette.derive({ ...colours, styleMode: 'liquid' }, 'dark');
  const classic = Palette.derive({ ...colours, styleMode: 'glass' }, 'dark');
  assert.ok(Palette.contrast(glass.muted, glass.surface) > Palette.contrast(classic.muted, classic.surface));
  assert.ok(Palette.contrast(glass.dim, glass.surface) > Palette.contrast(classic.dim, classic.surface));
});

test('widgets keep reading the skin they know', () => {
  assert.match(read('js', 'custom-widget.js'), /return hs\.styleMode === 'retro' \? 'retro' : 'glass';/);
});

test('Bit knows the styles and the wallpaper', () => {
  assert.match(SERVER_JS, /"liquid" \(Liquid Glass/);
  assert.match(SERVER_JS, /"glass" \(Classic\)/);
  const reference = read('ai-preset-reference.js');
  assert.match(reference, /'liquid'/);
  assert.match(reference, /'dusk'/);
});

test('the Network card draws its graph from the download speed', () => {
  assert.match(INDEX, /class="stat-fill net-down" id="net-down-fill" data-sf="net-down-fill"/);
  assert.ok(!INDEX.includes('net-bw-iface'), 'nothing fills that label');
  assert.match(read('js', 'network.js'), /setFill\(downFill, Math\.log10\(1 \+ \(Number\(data\.downloadBps\) \|\| 0\)\) \* 10\)/);
  assert.match(read('js', 'utils.js'), /c\.includes\('net-down'\)\) return 'var\(--cyan\)'/);
});

test('a cover never wraps its picture into its own border', () => {
  const css = read('components', 'MediaPanel', 'MediaPanel.css');
  const at = css.indexOf('border-radius: var(--radius);\n  background: #101516;');
  const rule = css.slice(at >= 0 ? at : css.indexOf('background: #101516;'), css.indexOf('}', at));
  assert.match(rule, /background-repeat: no-repeat/);
  assert.match(rule, /background-origin: border-box/);
});

test('the light widget window loads the look too, after the skins it overrides', () => {
  const lite = read('layer-lite.html');
  const sheet = lite.indexOf('styles/themes-liquid.css');
  assert.ok(sheet > -1, 'layer-lite.html has no Liquid Glass sheet: its tiles stay on the thin fill');
  assert.ok(sheet > lite.indexOf('styles/theme-contract.css'));
  assert.ok(sheet > lite.indexOf('styles/themes-comic.css'));
});

test('a new Deck wears the tile of the look, a saved one keeps its faceplate', () => {
  const Deck = require('../js/deck-model.js');
  assert.equal(Deck.normalizeDeckConfig(undefined).plate, 'theme');
  assert.equal(Deck.normalizeDeckConfig({ profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [] }] } }] }).plate, 'graphite');
  assert.equal(Deck.normalizeDeckConfig({ plate: 'carbon' }).plate, 'carbon');
});

test('gains and losses follow the appearance of Xenon, not the one of the system', () => {
  const global = read('styles', 'global.css');
  const light = read('styles', 'themes-light.css');
  assert.doesNotMatch(read('components', 'Ticker', 'Ticker.css'), /prefers-color-scheme/, 'a dark Xenon on a light Windows got the colours made for a white page');
  assert.match(global, /--xe-stock-up:\s*var\(--color-success\)/);
  assert.match(global, /--xe-stock-down:\s*var\(--color-danger\)/);
  assert.match(light, /:root\[data-appearance="light"\]\s*\{[^}]*--xe-stock-up:[^}]*--xe-stock-down:/);
});
