// The Deck can match the dashboard: a Theme faceplate drawn with the tiles' own
// surface, and theme colours for keys without one, the key well and the music bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../js/deck-model.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const base = () => M.normalizeDeckConfig({ profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [] }] } }], activeProfile: 'p' });

test('the Theme faceplate and theme colours are kept per profile, off unless set', () => {
  assert.ok(M.PLATE_STYLES.includes('theme'));
  assert.equal(M.PLATE_STYLES[0], 'graphite', 'the default faceplate is unchanged');
  const cfg = base();
  assert.equal(M.effectiveDeckLook(cfg, 'p').themeColors, false);
  const themed = M.setProfileLook(cfg, 'p', { plate: 'theme', themeColors: true });
  assert.equal(M.effectiveDeckLook(themed, 'p').plate, 'theme');
  assert.equal(M.effectiveDeckLook(themed, 'p').themeColors, true);
  assert.equal(M.effectiveDeckLook(M.setProfileLook(themed, 'p', { themeColors: false }), 'p').themeColors, false);
  assert.equal(M.normalizeDeckLook({ plate: 'theme', themeColors: 'yes' }).themeColors, undefined, 'only a real true is kept');
});

test('the Theme faceplate paints with the tile tokens and gives way inside a tab group', () => {
  const css = read('../components/DeckPanel/DeckPanel.css');
  const rule = css.slice(css.indexOf('.deck-root[data-plate="theme"] .deck-device::after {'));
  assert.match(rule.slice(0, 400), /var\(--panel\)/);
  assert.match(rule.slice(0, 400), /var\(--panel-border\)/);
  assert.match(rule.slice(0, 400), /var\(--panel-drop\)/);
  assert.match(css, /\.tabgroup-body > \.deck-panel \.deck-root\[data-plate="theme"\] \.deck-device::after/);
  // Every graphite mount rule, in every skin, skips a group showing a Theme Deck.
  for (const f of ['../components/DeckPanel/DeckPanel.css', '../styles/themes-comic.css', '../styles/themes-retro.css']) {
    const src = read(f);
    const all = src.match(/\.panel\.tabgroup\.deck-tab-active[^\s{,]*/g) || [];
    assert.ok(all.length > 0, f);
    for (const sel of all) assert.match(sel, /:not\(\[data-deck-themeplate\]\)/, f + ': ' + sel);
  }
  assert.match(read('../js/dashboard-tabgroups.js'), /toggleAttribute\('data-deck-themeplate'/);
  assert.match(read('../js/deck.js'), /mount\.toggleAttribute\('data-deck-themeplate'/);
});

test('theme colours reach keys without a colour, the music bar and the key well', () => {
  const js = read('../js/deck.js');
  assert.match(js, /const themeAccent = !key\.bg && !!\(opts && opts\.themeColors\)/);
  assert.match(js, /accent: key\.bg \|\| \(themeAccent \? THEME_ACCENT : ''\)/, 'a lit face restores the theme accent when it turns off');
  assert.match(js, /function buildNowPlaying\(mediaStyle, themeColors\)/);
  assert.equal((js.match(/buildNowPlaying\(look\.mediaStyle, look\.themeColors\)/g) || []).length, 2);
  assert.equal((js.match(/renderKey\(key, \{ themeColors: look\.themeColors \}\)/g) || []).length, 2);
  const css = read('../components/DeckPanel/DeckPanel.css');
  assert.match(css, /\.deck-root\[data-themecolors="1"\]:not\(\[data-plate="none"\]\):not\(\[data-capstyle="vivid"\]\) \.deck-well/);
});
