// configure_deck makes switches, held keys and confirmed keys, and sets the
// profile's lit-key cues (js/deck.js applyAiDeck → aiKeyBehavior / aiLookPatch).
// The model keeps them through normalizeDeckConfig, which is what applyAiDeck
// saves through; the wiring is checked in the sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const step = (action) => ({ steps: [{ action, delayMs: 0 }] });

function keyThrough(raw) {
  const c = dm.normalizeDeckConfig({ cols: 1, rows: 1, profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [raw] }] } }], activeProfile: 'p' });
  return c.profiles[0].root.pages[0].keys[0];
}

test('the shapes applyAiDeck builds survive the model', () => {
  const sw = keyThrough({ id: 'a', kind: 'action', toggle: true, triggers: { tap: step({ type: 'micMute', mode: 'on' }), tapOff: step({ type: 'micMute', mode: 'off' }) } });
  assert.equal(sw.toggle, true);
  assert.deepEqual(Object.keys(sw.triggers).sort(), ['tap', 'tapOff']);
  const ptt = keyThrough({ id: 'b', kind: 'action', mode: 'momentary', triggers: { press: step({ type: 'discordPtt', mode: 'on' }), release: step({ type: 'discordPtt', mode: 'off' }) } });
  assert.equal(ptt.mode, 'momentary');
  assert.deepEqual(Object.keys(ptt.triggers).sort(), ['press', 'release']);
  const end = keyThrough({ id: 'c', kind: 'action', confirm: true, triggers: { tap: step({ type: 'obsStream', mode: 'stop' }) } });
  assert.equal(end.confirm, true);
});

test('the lit-key cues land on the profile look', () => {
  const cfg = dm.normalizeDeckConfig({ cols: 1, rows: 1, profiles: [{ id: 'p', name: 'P' }], activeProfile: 'p' });
  const next = dm.setProfileLook(cfg, 'p', { litRing: true, dimOff: true });
  const look = dm.effectiveDeckLook(next, 'p');
  assert.equal(look.litRing, true);
  assert.equal(look.dimOff, true);
});

test('wiring: applyAiDeck reads the new fields, the tool offers them', () => {
  const deck = read('../js/deck.js');
  assert.ok(deck.includes("const AI_KEY_MODES = ['momentary', 'repeat'];"));
  assert.ok(deck.includes('const extra = { tapOff: k.off, press: k.press, release: k.release };'));
  assert.ok(deck.includes('        aiKeyBehavior(k, key, trig, toSteps);\n        if (!Object.keys(trig).length) continue;'));
  assert.ok(deck.includes("const AI_LOOK_FIELDS = ['litRing', 'dimOff'];"));
  assert.ok(deck.includes('saveConfig(instanceId, M.setProfileLook(cfg, cfg.activeProfile, look));'));
  const server = read('../server.js');
  for (const f of ["toggle: { type: 'BOOLEAN'", "off: { type: 'ARRAY'", "mode: { type: 'STRING', description: 'Optional: \"momentary\"", "press: { type: 'ARRAY'", "release: { type: 'ARRAY'", "confirm: { type: 'BOOLEAN'", "look: { type: 'OBJECT', description: 'Optional, the on/off cues"]) {
    assert.ok(server.includes(f), f);
  }
});
