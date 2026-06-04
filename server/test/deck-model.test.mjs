import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');

test('normalizeDeckConfig fills defaults and clamps cols/rows', () => {
  const c = dm.normalizeDeckConfig(null);
  assert.equal(c.version, 1);
  assert.ok(c.cols >= 1 && c.cols <= 6);
  assert.ok(c.rows >= 1 && c.rows <= 6);
  assert.equal(c.profiles.length, 1);
  assert.equal(c.activeProfile, c.profiles[0].id);
  const page0 = c.profiles[0].root.pages[0];
  assert.equal(page0.keys.length, c.cols * c.rows);
  assert.ok(page0.keys.every(k => k === null));
});

test('normalizeDeckConfig clamps out-of-range cols/rows', () => {
  const c = dm.normalizeDeckConfig({ cols: 99, rows: 0 });
  assert.equal(c.cols, 6);
  assert.equal(c.rows, 1);
});

test('normalizeDeckConfig resizes each page to cols*rows (pad with null, truncate extra)', () => {
  const c = dm.normalizeDeckConfig({
    cols: 2, rows: 2,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [{ id: 'k1', kind: 'action', title: 'A' }] }] } }],
    activeProfile: 'p',
  });
  assert.equal(c.profiles[0].root.pages[0].keys.length, 4);
  assert.equal(c.profiles[0].root.pages[0].keys[0].title, 'A');
  assert.equal(c.profiles[0].root.pages[0].keys[3], null);
});

test('normalizeDeckConfig drops keys with unknown kind', () => {
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [{ id: 'k', kind: 'bogus' }] }] } }],
    activeProfile: 'p',
  });
  assert.equal(c.profiles[0].root.pages[0].keys[0], null);
});

test('nested folder pages are sized to the deck grid', () => {
  const c = dm.normalizeDeckConfig({
    cols: 2, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
      { id: 'f', kind: 'folder', title: 'Sub', folder: { pages: [{ keys: [{ id: 'x', kind: 'action', title: 'X' }] }] } },
      null,
    ] }] } }],
    activeProfile: 'p',
  });
  const folderKey = c.profiles[0].root.pages[0].keys[0];
  assert.equal(folderKey.kind, 'folder');
  assert.equal(folderKey.folder.pages[0].keys.length, 2);
  assert.equal(folderKey.folder.pages[0].keys[0].title, 'X');
});

test('resolveView returns the page at a navigation path', () => {
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
      { id: 'f', kind: 'folder', title: 'Sub', folder: { pages: [
        { keys: [{ id: 'a', kind: 'action', title: 'A' }] },
        { keys: [{ id: 'b', kind: 'action', title: 'B' }] },
      ] } },
    ] }] } }],
    activeProfile: 'p',
  });
  const root = dm.resolveView(c, { profileId: 'p', path: [], pageIndex: 0 });
  assert.equal(root.folder.pages.length, 1);
  assert.equal(root.page.keys[0].kind, 'folder');
  assert.equal(root.pageCount, 1);
  const sub = dm.resolveView(c, { profileId: 'p', path: ['f'], pageIndex: 1 });
  assert.equal(sub.pageCount, 2);
  assert.equal(sub.page.keys[0].title, 'B');
});

test('resolveView clamps an out-of-range pageIndex and bad path to root', () => {
  const c = dm.normalizeDeckConfig({ cols: 1, rows: 1 });
  const v = dm.resolveView(c, { profileId: 'nope', path: ['ghost'], pageIndex: 99 });
  assert.equal(v.pageIndex, 0);
  assert.equal(v.page.keys.length, 1);
});

test('normalizeKey coerces a non-object/array triggers into a plain object copy', () => {
  const shared = { tap: { type: 'media' } };
  const c = dm.normalizeDeckConfig({
    cols: 2, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
      { id: 'a', kind: 'action', title: 'A', triggers: shared },
      { id: 'b', kind: 'action', title: 'B', triggers: ['nope'] },
    ] }] } }],
    activeProfile: 'p',
  });
  const a = c.profiles[0].root.pages[0].keys[0];
  const b = c.profiles[0].root.pages[0].keys[1];
  assert.notEqual(a.triggers, shared);              // copied, not the same reference
  assert.deepEqual(a.triggers, shared);             // but same content
  assert.ok(!Array.isArray(b.triggers));            // array rejected
  assert.deepEqual(b.triggers, {});
});

test('normalizeIcon defaults to an empty emoji icon when absent', () => {
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [{ id: 'a', kind: 'action', title: 'A' }] }] } }],
    activeProfile: 'p',
  });
  assert.deepEqual(c.profiles[0].root.pages[0].keys[0].icon, { type: 'emoji', value: '' });
});

test('normalizeIcon keeps a long image data URL intact (no 256-char truncation)', () => {
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(5000);
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [{ id: 'a', kind: 'action', title: 'A', icon: { type: 'image', value: dataUrl } }] }] } }],
    activeProfile: 'p',
  });
  const icon = c.profiles[0].root.pages[0].keys[0].icon;
  assert.equal(icon.type, 'image');
  assert.equal(icon.value, dataUrl);
});

test('normalizeIcon drops an unsafe (non data/blob/http) image value', () => {
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [{ id: 'a', kind: 'action', title: 'A', icon: { type: 'image', value: 'javascript:alert(1)' } }] }] } }],
    activeProfile: 'p',
  });
  assert.deepEqual(c.profiles[0].root.pages[0].keys[0].icon, { type: 'image', value: '' });
});

test('normalizeIcon preserves a builtin icon id', () => {
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [{ id: 'a', kind: 'action', title: 'A', icon: { type: 'builtin', value: 'play' } }] }] } }],
    activeProfile: 'p',
  });
  assert.deepEqual(c.profiles[0].root.pages[0].keys[0].icon, { type: 'builtin', value: 'play' });
});

test('newKeyId returns a unique-ish k_ prefixed id', () => {
  const a = dm.newKeyId(), b = dm.newKeyId();
  assert.match(a, /^k_/);
  assert.notEqual(a, b);
});

test('setKeyAt places a key at a slot on the resolved page and returns a new config', () => {
  const base = dm.normalizeDeckConfig({ cols: 2, rows: 1 });
  const nav = { profileId: base.activeProfile, path: [], pageIndex: 0 };
  const next = dm.setKeyAt(base, nav, 1, { id: 'k_z', kind: 'action', title: 'Hi' });
  assert.notEqual(next, base);
  assert.equal(base.profiles[0].root.pages[0].keys[1], null);
  assert.equal(next.profiles[0].root.pages[0].keys[1].title, 'Hi');
});

test('setKeyAt with null clears the slot', () => {
  let cfg = dm.normalizeDeckConfig({ cols: 1, rows: 1 });
  const nav = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, nav, 0, { id: 'k_a', kind: 'action', title: 'A' });
  assert.equal(cfg.profiles[0].root.pages[0].keys[0].title, 'A');
  cfg = dm.setKeyAt(cfg, nav, 0, null);
  assert.equal(cfg.profiles[0].root.pages[0].keys[0], null);
});

test('setKeyAt resolves into a folder by path', () => {
  let cfg = dm.normalizeDeckConfig({ cols: 1, rows: 1 });
  const rootNav = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, rootNav, 0, { id: 'f1', kind: 'folder', title: 'F' });
  const subNav = { profileId: cfg.activeProfile, path: ['f1'], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, subNav, 0, { id: 'k_in', kind: 'action', title: 'Inside' });
  const folderKey = cfg.profiles[0].root.pages[0].keys[0];
  assert.equal(folderKey.folder.pages[0].keys[0].title, 'Inside');
});

test('addPageAt appends an empty page; removePageAt deletes one but never below 1', () => {
  let cfg = dm.normalizeDeckConfig({ cols: 1, rows: 1 });
  const nav = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.addPageAt(cfg, nav);
  assert.equal(cfg.profiles[0].root.pages.length, 2);
  cfg = dm.removePageAt(cfg, nav, 1);
  assert.equal(cfg.profiles[0].root.pages.length, 1);
  cfg = dm.removePageAt(cfg, nav, 0);
  assert.equal(cfg.profiles[0].root.pages.length, 1);
});

test('addProfile appends an empty profile, makes it active, and gives it a unique id', () => {
  const base = dm.normalizeDeckConfig({ cols: 2, rows: 1 });
  const next = dm.addProfile(base, 'Streaming');
  assert.equal(next.profiles.length, 2);
  assert.equal(next.profiles[1].name, 'Streaming');
  assert.equal(next.activeProfile, next.profiles[1].id);
  assert.notEqual(next.profiles[1].id, next.profiles[0].id);
  // the new profile starts with one blank, grid-sized page
  assert.equal(next.profiles[1].root.pages.length, 1);
  assert.equal(next.profiles[1].root.pages[0].keys.length, 2);
  assert.ok(next.profiles[1].root.pages[0].keys.every(k => k === null));
  // input is not mutated
  assert.equal(base.profiles.length, 1);
});

test('addProfile falls back to a default name when blank', () => {
  const next = dm.addProfile(dm.normalizeDeckConfig(null), '');
  assert.equal(next.profiles[1].name, 'Profile 2');
});

test('setActiveProfile switches to a known id and ignores an unknown one', () => {
  let cfg = dm.addProfile(dm.normalizeDeckConfig(null), 'B');
  const first = cfg.profiles[0].id;
  cfg = dm.setActiveProfile(cfg, first);
  assert.equal(cfg.activeProfile, first);
  const before = cfg.activeProfile;
  cfg = dm.setActiveProfile(cfg, 'ghost');
  assert.equal(cfg.activeProfile, before);   // unchanged
});

test('renameProfile renames a known profile and ignores blank names / unknown ids', () => {
  let cfg = dm.normalizeDeckConfig(null);
  const id = cfg.profiles[0].id;
  cfg = dm.renameProfile(cfg, id, 'Main');
  assert.equal(cfg.profiles[0].name, 'Main');
  cfg = dm.renameProfile(cfg, id, '   ');     // blank → kept
  assert.equal(cfg.profiles[0].name, 'Main');
  cfg = dm.renameProfile(cfg, 'ghost', 'X');  // unknown id → no-op
  assert.equal(cfg.profiles[0].name, 'Main');
});

test('removeProfile deletes a profile but never the last one', () => {
  let cfg = dm.addProfile(dm.normalizeDeckConfig(null), 'B');  // now 2 profiles, B active
  const idA = cfg.profiles[0].id, idB = cfg.profiles[1].id;
  cfg = dm.removeProfile(cfg, idB);   // removing the active one
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.profiles[0].id, idA);
  assert.equal(cfg.activeProfile, idA);   // active fell back to the survivor
  cfg = dm.removeProfile(cfg, idA);   // would drop below 1 → refused
  assert.equal(cfg.profiles.length, 1);
});

test('removeProfile keeps the active profile when removing a different one', () => {
  let cfg = dm.addProfile(dm.normalizeDeckConfig(null), 'B');  // B active
  const idA = cfg.profiles[0].id, idB = cfg.profiles[1].id;
  cfg = dm.removeProfile(cfg, idA);   // remove the inactive one
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.profiles[0].id, idB);
  assert.equal(cfg.activeProfile, idB);
});

test('newProfileId returns a unique-ish prof_ prefixed id', () => {
  const a = dm.newProfileId(), b = dm.newProfileId();
  assert.match(a, /^prof_/);
  assert.notEqual(a, b);
});

test('DECK_STATE_SOURCES lists the bindable sources', () => {
  assert.ok(Array.isArray(dm.DECK_STATE_SOURCES));
  ['micMuted', 'speakerMuted', 'obsRecording', 'obsStreaming', 'obsScene', 'obsInputMuted'].forEach((s) => assert.ok(dm.DECK_STATE_SOURCES.includes(s)));
});

test('evaluateKeyState handles boolean + parameterised (OBS) sources', () => {
  assert.equal(dm.evaluateKeyState({ source: 'micMuted' }, { micMuted: true }), true);
  assert.equal(dm.evaluateKeyState({ source: 'speakerMuted' }, { micMuted: true }), false);
  assert.equal(dm.evaluateKeyState({ source: 'obsRecording' }, { obsRecording: true }), true);
  assert.equal(dm.evaluateKeyState({ source: 'obsStreaming' }, { obsStreaming: false }), false);
  // obsScene: lit only when the bound scene equals the current OBS scene
  assert.equal(dm.evaluateKeyState({ source: 'obsScene', scene: 'Game' }, { obsScene: 'Game' }), true);
  assert.equal(dm.evaluateKeyState({ source: 'obsScene', scene: 'Game' }, { obsScene: 'BRB' }), false);
  // obsInputMuted: lit when the bound input is muted in OBS
  assert.equal(dm.evaluateKeyState({ source: 'obsInputMuted', input: 'Mic' }, { obsMutes: { Mic: true } }), true);
  assert.equal(dm.evaluateKeyState({ source: 'obsInputMuted', input: 'Mic' }, { obsMutes: { Mic: false } }), false);
  // junk
  assert.equal(dm.evaluateKeyState({ source: 'nope' }, { nope: true }), false);
  assert.equal(dm.evaluateKeyState(null, {}), false);
  assert.equal(dm.evaluateKeyState({ source: 'obsScene', scene: 'X' }, null), false);
});

test('normalizeKey preserves obs state params (scene/input)', () => {
  const c = dm.normalizeDeckConfig({ cols: 1, rows: 1, profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
    { id: 'a', kind: 'action', title: 'A', state: { source: 'obsScene', scene: 'Game' } },
  ] }] } }], activeProfile: 'p' });
  assert.deepEqual(c.profiles[0].root.pages[0].keys[0].state, { source: 'obsScene', scene: 'Game' });
});

test('evaluateKeyState remoteConnected legge lo snapshot', () => {
  assert.equal(dm.evaluateKeyState({ source: 'remoteConnected' }, { remoteConnected: true }), true);
  assert.equal(dm.evaluateKeyState({ source: 'remoteConnected' }, { remoteConnected: false }), false);
});

test('evaluateKeyState remoteActive legge lo snapshot', () => {
  assert.equal(dm.evaluateKeyState({ source: 'remoteActive' }, { remoteActive: true }), true);
  assert.equal(dm.evaluateKeyState({ source: 'remoteActive' }, {}), false);
});

test('DECK_STATE_SOURCES include le sorgenti remote', () => {
  assert.ok(dm.DECK_STATE_SOURCES.includes('remoteConnected'));
  assert.ok(dm.DECK_STATE_SOURCES.includes('remoteActive'));
});

test('normalizeDeckConfig defaults + clamps the presentation prefs', () => {
  const def = dm.normalizeDeckConfig(null);
  assert.equal(def.keySize, 'md');
  assert.equal(def.autoFit, true);
  assert.equal(def.showMedia, false);
  const set = dm.normalizeDeckConfig({ keySize: 'lg', autoFit: false, showMedia: true });
  assert.equal(set.keySize, 'lg');
  assert.equal(set.autoFit, false);
  assert.equal(set.showMedia, true);
  // junk keySize falls back to md
  assert.equal(dm.normalizeDeckConfig({ keySize: 'huge' }).keySize, 'md');
});

test('gridForSize derives a clamped column/row count from pixels + key size', () => {
  const big = dm.gridForSize(1000, 1000, 'sm');
  assert.ok(big.cols >= 1 && big.cols <= dm.DECK_MAX);
  assert.ok(big.rows >= 1 && big.rows <= dm.DECK_MAX);
  // smaller keys fit more columns than larger keys at the same width
  assert.ok(dm.gridForSize(600, 300, 'sm').cols >= dm.gridForSize(600, 300, 'lg').cols);
  // tiny/unknown sizes fall back to a sane 3x2
  assert.deepEqual(dm.gridForSize(0, 0, 'md'), { cols: 3, rows: 2 });
});

test('reshapeDeckConfig grows/shrinks the grid without ever dropping a placed key', () => {
  let cfg = dm.normalizeDeckConfig({ cols: 3, rows: 2 });
  const nav = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, nav, 0, { id: 'a', kind: 'action', title: 'A' });
  cfg = dm.setKeyAt(cfg, nav, 5, { id: 'b', kind: 'action', title: 'B' });
  // shrink request to 1x1 (1 slot) — must grow back to hold the 2 placed keys
  const shrunk = dm.reshapeDeckConfig(cfg, 1, 1, { compact: true });
  assert.equal(shrunk.cols * shrunk.rows >= 2, true);
  const titles = shrunk.profiles[0].root.pages[0].keys.filter(Boolean).map(k => k.title).sort();
  assert.deepEqual(titles, ['A', 'B']);
});

test('reshapeDeckConfig { compact:true } packs keys to the front; reshape keeps prefs', () => {
  let cfg = dm.normalizeDeckConfig({ cols: 3, rows: 2, keySize: 'lg', showMedia: true });
  const nav = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, nav, 4, { id: 'x', kind: 'action', title: 'X' });
  const out = dm.reshapeDeckConfig(cfg, 4, 2, { compact: true });
  assert.equal(out.profiles[0].root.pages[0].keys[0].title, 'X'); // compacted to slot 0
  assert.equal(out.keySize, 'lg');     // presentation prefs survive a reshape
  assert.equal(out.showMedia, true);
});

test('normalizeKey preserves a valid key.light and drops an invalid one', () => {
  const mk = (light) => dm.normalizeDeckConfig({ cols: 1, rows: 1, profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
    { id: 'a', kind: 'action', title: 'A', light },
  ] }] } }], activeProfile: 'p' }).profiles[0].root.pages[0].keys[0];
  // valid → kept verbatim
  assert.deepEqual(mk({ when: 'state', color: '#ff0000', style: 'breathing' }).light, { when: 'state', color: '#ff0000', style: 'breathing' });
  // defaults: when→press, style→solid
  assert.deepEqual(mk({ color: '#00ff00' }).light, { when: 'press', color: '#00ff00', style: 'solid' });
  // bad style → solid; bad when → press
  assert.deepEqual(mk({ color: '#0000ff', style: 'nope', when: 'x' }).light, { when: 'press', color: '#0000ff', style: 'solid' });
  // no/invalid colour → no reaction at all
  assert.equal(mk({ when: 'state' }).light, undefined);
  assert.equal(mk({ color: 'red' }).light, undefined);
});
