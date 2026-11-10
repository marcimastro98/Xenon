// Deck appearance: a Glass faceplate (clear body, no blur), and a preview that
// shows Ring on lit keys / Dim keys that are off even on a page with no key
// following a state, where those switches used to change nothing on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../js/deck-model.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Glass is a faceplate kept per profile, the default is unchanged', () => {
  assert.ok(M.PLATE_STYLES.includes('glass'));
  assert.equal(M.PLATE_STYLES[0], 'graphite');
  const cfg = M.normalizeDeckConfig({ profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [] }] } }], activeProfile: 'p' });
  assert.equal(M.effectiveDeckLook(M.setProfileLook(cfg, 'p', { plate: 'glass' }), 'p').plate, 'glass');
  assert.match(read('../js/deck.js'), /'midnight', 'glass', 'theme', 'none'\]/, 'the fallback list knows it too');
});

test('the Glass faceplate draws a clear body without a backdrop blur', () => {
  const css = read('../components/DeckPanel/DeckPanel.css');
  const start = css.indexOf('.deck-root[data-plate="glass"]');
  assert.ok(start > 0);
  const block = css.slice(start, css.indexOf('/* Theme: the body', start));
  assert.match(block, /\.deck-root\[data-plate="glass"\] \.deck-device::after \{/);
  assert.match(block, /\.deck-root\[data-plate="glass"\] \.deck-well \{/);
  assert.doesNotMatch(block, /backdrop-filter/, 'a per-frame GPU cost on every screen');
});

test('the preview demonstrates the lit-key switches on any page', () => {
  const js = read('../js/deck.js');
  const fn = js.slice(js.indexOf('  function showLitCues(grid, look) {'), js.indexOf('  function buildDeckStylePreview('));
  assert.ok(fn.length > 100);
  assert.match(fn, /if \(!look\.litRing && !look\.dimOff\) return;/, 'nothing changes while both are off');
  assert.match(fn, /evaluateKeyState\(k\._deckState, stateSnapshot\)/, 'real stateful keys show their live state');
  assert.match(fn, /keys\.slice\(0, 2\)/, 'otherwise two keys stand in, one on and one off');
  const preview = js.slice(js.indexOf('  function buildDeckStylePreview('));
  assert.match(preview.slice(0, 4000), /showLitCues\(grid, look\);/);
  assert.equal((js.match(/showLitCues\(/g) || []).length, 2, 'preview only, never the live Deck');
});

test('the Glass label is in all 11 languages', () => {
  assert.equal((read('../js/i18n.js').match(/^ +deck_plate_glass: /gm) || []).length, 11);
});

test('a chosen label colour beats the Comic ink, on both faces', () => {
  const comic = read('../styles/themes-comic.css');
  assert.match(comic, /\.deck-root\[data-capstyle="vivid"\] \.deck-key \.deck-label \{[^}]*color: var\(--key-label-color, var\(--comic-ink\)\) !important;/);
  const js = read('../js/deck.js');
  assert.match(js, /label\.style\.setProperty\('--key-label-color', c\)/);
  assert.match(js, /if \(key\.labelColor\) setLabelColor\(label, key\.labelColor\);/, 'the normal face');
  assert.match(js, /if \(ss\.labelColor\) setLabelColor\(base\.labelEl, on \? ss\.labelColor : base\.labelColor\);/, 'the lit face');
});
