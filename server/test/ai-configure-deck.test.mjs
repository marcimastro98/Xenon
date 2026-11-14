// configure_deck makes switches, held keys and confirmed keys, and sets the
// profile's lit-key cues (js/deck.js applyAiDeck → aiKeyBehavior / aiLookPatch).
// The model keeps them through normalizeDeckConfig, which is what applyAiDeck
// saves through; the wiring is checked in the sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

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
  const server = engineSource();
  for (const f of ["toggle: { type: 'BOOLEAN'", "off: { type: 'ARRAY'", "mode: { type: 'STRING', description: 'Optional: \"momentary\"", "press: { type: 'ARRAY'", "release: { type: 'ARRAY'", "confirm: { type: 'BOOLEAN'", "look: { type: 'OBJECT', description: 'Optional, the on/off cues"]) {
    assert.ok(server.includes(f), f);
  }
});

// "Add a key to my Deck": the keys go in the free slots of the profile in use.
// The function runs as written in js/deck.js, on the real model, with the store stubbed.
function addToCurrent(cfg, keys) {
  const deck = read('../js/deck.js');
  const at = deck.indexOf('  function addAiKeysToCurrent(');
  const src = deck.slice(at, deck.indexOf('  function applyAiDeck(', at));
  const out = { saved: null, nav: { path: ['x'], pageIndex: 0 }, toast: '' };
  const ctx = {
    window: { DeckModel: dm },
    durableConfig: () => cfg,
    saveConfig: (_, c) => { out.saved = c; },
    navOf: () => out.nav,
    renderAll() {},
    showDeckToast: (t) => { out.toast = t; },
  };
  const vm = require('node:vm');
  vm.runInNewContext(src + '; this.ok = addAiKeysToCurrent("deck", keys);', Object.assign(ctx, { keys }));
  return Object.assign(out, { ok: ctx.ok });
}
const replayKey = { kind: 'action', title: 'Replay', triggers: { tap: { type: 'replay', mode: 'save', seconds: 300 } }, unlit: true };

test('a key added to the Deck in use takes its first free slot and keeps the rest', () => {
  const mine = { id: 'm', kind: 'action', title: 'Mic', triggers: { tap: { type: 'micMute' } } };
  const cfg = dm.normalizeDeckConfig({ profiles: [{ id: 'p', name: 'Mio', cols: 2, rows: 1, root: { pages: [{ keys: [mine, null] }] } }, { id: 'q', name: 'Altro' }], activeProfile: 'p' });
  const r = addToCurrent(cfg, [replayKey]);
  assert.equal(r.ok, true);
  const prof = r.saved.profiles.find((p) => p.id === 'p');
  assert.equal(r.saved.profiles.length, 2, 'no new profile');
  assert.equal(prof.cols, 2);
  assert.equal(prof.root.pages[0].keys[0].title, 'Mic');
  assert.equal(prof.root.pages[0].keys[1].title, 'Replay');
  assert.equal(prof.root.pages[0].keys[1].unlit, true, 'one face survives');
  assert.deepEqual([r.nav.path.length, r.nav.pageIndex], [0, 0]);
  assert.equal(r.toast, '✦ Mio');
});

test('a full Deck gets a new page for the added key', () => {
  const k = (t) => ({ kind: 'action', title: t, triggers: { tap: { type: 'micMute' } } });
  const cfg = dm.normalizeDeckConfig({ profiles: [{ id: 'p', name: 'Mio', cols: 1, rows: 1, root: { pages: [{ keys: [k('A')] }] } }], activeProfile: 'p' });
  const r = addToCurrent(cfg, [replayKey]);
  const pages = r.saved.profiles[0].root.pages;
  assert.equal(pages.length, 2);
  assert.equal(pages[1].keys[0].title, 'Replay');
  assert.equal(r.nav.pageIndex, 1);
});

test('wiring: the tool can add to the Deck in use and make one-face keys', () => {
  const deck = read('../js/deck.js');
  assert.ok(deck.includes("if (keys.length && spec.addTo === 'current') {"));
  assert.ok(deck.includes('if (k.unlit === true) key.unlit = true;'));
  const server = engineSource();
  assert.ok(server.includes("addTo: { type: 'STRING', description: 'Optional \"current\""));
  assert.ok(server.includes("unlit: { type: 'BOOLEAN'"));
});

// Bit names icons from the Deck's own library, so its keys look like the rest.
test('the Deck icon library has capture icons and is named to the assistant', () => {
  const icons = require('../js/deck-icons.js');
  for (const id of ['replay', 'screenshot', 'timelapse', 'image']) assert.ok(icons.has(id), id);
  const cap = icons.CATEGORIES.find((c) => c.key === 'capture');
  assert.ok(cap && cap.ids.every((id) => icons.has(id)));
  const server = engineSource();
  assert.equal((server.match(/require\('\.\/js\/deck-icons\.js'\)\.ids\(\)\.join\(', '\)/g) || []).length, 2, 'configure_deck and genesis_setup_deck');
});

test('an icon name from the library becomes a drawn icon, anything else an emoji', () => {
  const deck = read('../js/deck.js');
  const at = deck.indexOf('  function aiIcon(');
  const src = deck.slice(at, deck.indexOf('\n  }\n', at) + 4);
  const vm = require('node:vm');
  const ctx = { window: { DeckIcons: require('../js/deck-icons.js') } };
  vm.runInNewContext(src + '; this.iconJson = (v) => JSON.stringify(aiIcon(v));', ctx);
  assert.equal(ctx.iconJson('replay'), '{"type":"builtin","value":"replay"}');
  assert.equal(ctx.iconJson('⏪'), '{"type":"emoji","value":"⏪"}');
  assert.equal(ctx.iconJson(''), 'null');
  assert.match(ctx.iconJson('constructor'), /emoji/);
  assert.ok(deck.includes('icon: aiIcon(k.stateStyle.icon) || undefined'), 'the lit face too');
  assert.ok(read('../js/genesis.js').includes("window.DeckIcons.has(v)) return { type: 'builtin', value: v };"));
});
