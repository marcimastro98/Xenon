// js/theme-tokens.js: the theme as CSS custom properties, shared by the
// dashboard and the light layer page so a widget on the desktop wears the same
// tile as on the dashboard. Checked here on a fake root element.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ThemeTokens = require('../js/theme-tokens.js');
const ThemePalette = require('../js/theme-palette.js');

function fakeRoot() {
  const props = new Map();
  return {
    props,
    dataset: {},
    style: { setProperty: (k, v) => props.set(k, String(v)), removeProperty: (k) => props.delete(k) },
  };
}

const BASE = { appearance: 'dark', panelAlpha: 0.6, panelBorderStrength: 1, tileShadowStrength: 0, uiRoundness: 1, glassBlur: 22, glassSaturate: 160 };
const fixed = (tone) => () => tone;

function paint(s) {
  const root = fakeRoot();
  const skin = ThemeTokens.applySkin(root, s);
  const palette = ThemeTokens.derivePalette(s, { resolve: fixed(s.appearance === 'light' ? 'light' : 'dark') });
  ThemeTokens.applyPalette(root, palette);
  ThemeTokens.applyMaterial(root, s, palette, skin);
  return { root, skin, palette };
}

test('the glass skin sets the panel material, the corners and the glass', () => {
  const { root, skin } = paint(BASE);
  assert.deepEqual(skin, { safe: false, retro: false, comic: false });
  assert.equal(root.dataset.style, undefined);
  assert.equal(root.props.get('--panel-alpha'), '0.60');
  assert.equal(root.props.get('--panel-soft-alpha'), '0.58');
  assert.equal(root.props.get('--panel-shadow-alpha'), '0.000', 'no tile shadow unless asked for');
  assert.equal(root.props.get('--radius-tile'), '16px');
  assert.equal(root.props.get('--glass-blur'), '22px');
  assert.match(root.props.get('--panel-border'), /^rgba\(\d+, \d+, \d+, 0\.093\)$/);
  assert.equal(root.dataset.appearance, 'dark');
});

test('the focus ring is a box-shadow, so focused controls show it', () => {
  const ring = paint(BASE).root.props.get('--focus-ring');
  assert.match(ring, /^0 0 0 2px var\(--bg\), 0 0 0 4px /);
});

test('comic is opaque paper and leaves its geometry to its stylesheet', () => {
  const { root, skin } = paint({ ...BASE, styleMode: 'comic' });
  assert.equal(skin.comic, true);
  assert.equal(root.dataset.style, 'comic');
  assert.equal(root.props.get('--panel-alpha'), '1');
  assert.equal(root.props.get('--panel-soft-alpha'), '1');
  assert.equal(root.props.has('--radius-tile'), false);
});

test('retro pins its CRT palette and drops the inline corners', () => {
  const root = fakeRoot();
  root.style.setProperty('--radius-tile', '30px');   // left over from the glass skin
  const s = { ...BASE, appearance: 'light', styleMode: 'retro', accent: '#00ff00' };
  const skin = ThemeTokens.applySkin(root, s);
  const palette = ThemeTokens.derivePalette(s, { resolve: fixed('light') });
  ThemeTokens.applyMaterial(root, s, palette, skin);
  assert.equal(root.dataset.style, 'retro');
  assert.equal(palette.accent, '#f5c518');
  assert.equal(palette.tone, 'dark', 'a CRT is dark whatever the appearance says');
  assert.equal(root.props.has('--radius-tile'), false);
});

test('safe mode: factory palette and glass, whatever is saved', () => {
  const s = { ...BASE, safeMode: true, styleMode: 'retro', accent: '#ff00ff' };
  const { root, skin, palette } = paint(s);
  assert.equal(skin.safe, true);
  assert.equal(root.dataset.style, undefined);
  assert.deepEqual(palette, ThemePalette.derive({ ...ThemePalette.STOCK.dark }, 'dark'));
  assert.equal(root.props.has('--radius-tile'), false, 'stylesheet defaults are the factory glass');
});

test('the album tint replaces the accent only while that feature is on', () => {
  const on = ThemeTokens.derivePalette({ ...BASE, accent: '#112233' }, { resolve: fixed('dark'), dynamicAccent: '#aa5500' });
  assert.equal(on.accent, '#aa5500');
  const off = ThemeTokens.derivePalette({ ...BASE, accent: '#112233', dynamicAlbumTheme: false }, { resolve: fixed('dark'), dynamicAccent: '#aa5500' });
  assert.equal(off.accent, '#112233');
});

test('a light palette uses the light material and the light drop shadow', () => {
  const { root } = paint({ ...BASE, appearance: 'light', tileShadowStrength: 1.5 });
  assert.equal(root.dataset.appearance, 'light');
  assert.equal(root.props.get('--panel-border-alpha'), '0.100');
  assert.equal(root.props.get('--panel-shadow-alpha'), '0.150');
  assert.equal(root.props.get('--panel-highlight-alpha'), '0.55');
  assert.equal(root.props.get('--panel-drop'), ThemeTokens.PANEL_DROP_CSS.light);
});

test('out-of-range sliders are clamped, never written raw', () => {
  const { root } = paint({ ...BASE, uiRoundness: 9, glassBlur: -5, glassSaturate: 999, panelBorderStrength: 'x' });
  assert.equal(root.props.get('--radius-tile'), '32px');
  assert.equal(root.props.get('--glass-blur'), '0px');
  assert.equal(root.props.get('--glass-saturate'), '220%');
  assert.ok(Object.isFrozen(ThemeTokens.PANEL_DROP_CSS));
});

function fakeDoc() {
  const root = fakeRoot();
  const els = new Map();
  const doc = {
    documentElement: root,
    head: { appendChild: (el) => els.set(el.id, el) },
    getElementById: (id) => els.get(id) || null,
    createElement: () => ({ id: '', textContent: '', remove() { els.delete(this.id); } }),
  };
  return { doc, root, face: () => els.get('user-font-face') || null };
}

test("the user's uploaded font is registered once and turned off cleanly", () => {
  const { doc, root, face } = fakeDoc();
  ThemeTokens.applyFont(doc, { url: '/uploads/font-1.woff2', version: '17' });
  ThemeTokens.applyFont(doc, { url: '/uploads/font-1.woff2', version: '17' });
  assert.equal(face().textContent, "@font-face{font-family:'XenonUserFont';src:url(\"/uploads/font-1.woff2?v=17\") format('woff2');font-display:swap;}");
  assert.equal(root.props.get('--user-font-family'), "'XenonUserFont'");
  ThemeTokens.applyFont(doc, null);
  assert.equal(face(), null);
  assert.equal(root.props.has('--user-font-family'), false);
});

test('a font url that is not one of our uploads never reaches the stylesheet', () => {
  for (const url of ['/uploads/x.woff2");}body{background:url("y.ttf', 'https://evil.example/f.woff2', '/uploads/../x.ttf', '/uploads/x.svg']) {
    const { doc, root, face } = fakeDoc();
    ThemeTokens.applyFont(doc, { url });
    assert.equal(face(), null, url);
    assert.equal(root.props.has('--user-font-family'), false, url);
  }
  assert.equal(ThemeTokens.fontSource({ url: '/uploads/a.ttf', version: '1"x' }), '/uploads/a.ttf?v=1x');
});
