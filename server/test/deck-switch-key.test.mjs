// Switch keys, confirm keys and the richer lit face: what the model keeps, and
// which state a switch with no binding follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const M = require('../js/deck-model.js');

function keyFrom(raw) {
  const c = M.normalizeDeckConfig({ cols: 1, rows: 1, profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [raw] }] } }], activeProfile: 'p' });
  return c.profiles[0].root.pages[0].keys[0];
}

test('switch, confirm and dim-off survive normalization; anything else is dropped', () => {
  const k = keyFrom({ id: 'k_ab', kind: 'action', title: 'Live', toggle: true, confirm: true, dimOff: true, triggers: { tap: { type: 'micMute', mode: 'mute' }, tapOff: { type: 'micMute', mode: 'unmute' } } });
  assert.equal(k.toggle, true);
  assert.equal(k.confirm, true);
  assert.equal(k.dimOff, true);
  assert.deepEqual(k.triggers.tapOff, { type: 'micMute', mode: 'unmute' });
  const plain = keyFrom({ id: 'k_cd', kind: 'action', toggle: 'yes', confirm: 1 });
  assert.equal(plain.toggle, undefined);
  assert.equal(plain.confirm, undefined);
});

test('the lit face keeps icon/label colours, a second colour, a ring and an on-only motion', () => {
  const k = keyFrom({ id: 'k_ef', kind: 'action', stateStyle: { color: '#FF0000', color2: '#00ff00', iconColor: '#ffffff', labelColor: '#111111', ring: true, anim: 'pulse' } });
  assert.deepEqual(k.stateStyle, { color: '#FF0000', iconColor: '#ffffff', labelColor: '#111111', color2: '#00ff00', ring: true, anim: 'pulse' });
  const bad = keyFrom({ id: 'k_gh', kind: 'action', stateStyle: { ring: 'on', anim: 'spin', iconColor: 'red', color2: 'green' } });
  assert.equal(bad.stateStyle, undefined, 'junk is dropped');
  const fade = keyFrom({ id: 'k_ij', kind: 'action', stateStyle: { color2: '#00ff00' } });
  assert.deepEqual(fade.stateStyle, { color2: '#00ff00' }, 'a second colour alone fades from the key colour');
});

test('a switch with no binding follows its own named Deck state', () => {
  assert.deepEqual(M.keyStateBinding({ id: 'k_ab', toggle: true }), { source: 'scriptState', name: 'deck.k_ab' });
  assert.deepEqual(M.keyStateBinding({ id: 'k_ab', toggle: true, state: { source: 'micMuted' } }), { source: 'micMuted' }, 'a bound state wins');
  assert.equal(M.keyStateBinding({ id: 'k_ab' }), null);
  assert.equal(M.toggleStateName({ id: 'k/../x' }), 'deck.k..x', 'only characters a state name accepts');
  assert.ok(M.toggleStateName({ id: 'x'.repeat(64) }).length <= 64);
  const name = M.toggleStateName({ id: 'k_ab' });
  assert.equal(M.evaluateKeyState(M.keyStateBinding({ id: 'k_ab', toggle: true }), { scriptStates: { [name]: 'on' } }), true);
  assert.equal(M.evaluateKeyState(M.keyStateBinding({ id: 'k_ab', toggle: true }), { scriptStates: {} }), false);
});

test('the lit-face layer stops with every other dashboard motion', () => {
  const css = readFileSync(new URL('../components/DeckPanel/DeckPanel.css', import.meta.url), 'utf8');
  ['perf-mode', 'overlay-frozen', 'ambient-idle', 'game-mode', 'low-power-gpu'].forEach((b) => {
    assert.match(css, new RegExp(`body\\.${b} \\.deck-key\\.is-on \\.deck-key-onfx`), b);
  });
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.deck-key\.is-on \.deck-key-onfx \{ animation: none; \} \}/);
});

test('the deck-wide lit cues are a per-profile look choice, off unless set', () => {
  const base = M.normalizeDeckConfig({ profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [] }] } }], activeProfile: 'p' });
  assert.equal(M.effectiveDeckLook(base, 'p').litRing, false);
  assert.equal(M.effectiveDeckLook(base, 'p').dimOff, false);
  const lit = M.setProfileLook(base, 'p', { litRing: true, dimOff: true });
  assert.equal(M.effectiveDeckLook(lit, 'p').litRing, true);
  assert.equal(M.effectiveDeckLook(lit, 'p').dimOff, true);
  const back = M.setProfileLook(lit, 'p', { litRing: false });
  assert.equal(M.effectiveDeckLook(back, 'p').litRing, false, 'turning it off drops it');
  assert.equal(M.effectiveDeckLook(back, 'p').dimOff, true);
  assert.equal(M.normalizeDeckLook({ capStyle: 'lcd', litRing: 'yes', dimOff: 1 }).litRing, undefined, 'only a real true is kept');
});

test('the deck-wide cues reach every state-following key', () => {
  const css = readFileSync(new URL('../components/DeckPanel/DeckPanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.deck-root\[data-dimoff="1"\] \.deck-key\.is-stateful:not\(\.is-on\)/);
  assert.match(css, /\.deck-root\[data-litring="1"\] \.deck-key \.deck-key-onfx/);
  const js = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
  assert.match(js, /btn\.classList\.add\('is-stateful'\)/);
  assert.equal((js.match(/stampDeckLitCues\(root, look\);/g) || []).length, 3, 'deck, style preview and key preview');
});
