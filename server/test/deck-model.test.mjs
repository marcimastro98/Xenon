import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');

test('normalizeDeckConfig fills defaults and clamps cols/rows', () => {
  const c = dm.normalizeDeckConfig(null);
  assert.equal(c.version, 1);
  assert.ok(c.cols >= 1 && c.cols <= dm.DECK_MAX);
  assert.ok(c.rows >= 1 && c.rows <= dm.DECK_MAX);
  assert.equal(c.profiles.length, 1);
  assert.equal(c.activeProfile, c.profiles[0].id);
  const page0 = c.profiles[0].root.pages[0];
  assert.equal(page0.keys.length, c.cols * c.rows);
  assert.ok(page0.keys.every(k => k === null));
});

test('normalizeDeckConfig clamps out-of-range cols/rows', () => {
  const c = dm.normalizeDeckConfig({ cols: 99, rows: 0 });
  assert.equal(c.cols, dm.DECK_MAX);
  assert.equal(c.rows, 1);
});

test('normalizeDeckConfig defaults decoration fields to null (classic look)', () => {
  const c = dm.normalizeDeckConfig(null);
  assert.equal(c.wellImage, null);
  assert.equal(c.mediaStyle, null);
});

test('normalizeDeckConfig keeps a valid well image and clamps its fit/dim/blur', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const c = dm.normalizeDeckConfig({ wellImage: { src: png, fit: 'contain', dim: 200, blur: 99 } });
  assert.deepEqual(c.wellImage, { src: png, fit: 'contain', dim: 85, blur: 20 });
});

test('normalizeDeckConfig rejects non-image / remote well/media srcs', () => {
  assert.equal(dm.normalizeDeckConfig({ wellImage: { src: 'http://evil/x.png' } }).wellImage, null);
  assert.equal(dm.normalizeDeckConfig({ wellImage: { src: 'javascript:alert(1)' } }).wellImage, null);
  // /assets/decor (bundled) is allowed; /uploads is NOT (deck decor rides inline).
  assert.ok(dm.normalizeDeckConfig({ wellImage: { src: '/assets/decor/frame-neon.svg' } }).wellImage);
  assert.equal(dm.normalizeDeckConfig({ wellImage: { src: '/uploads/tileasset-1.png' } }).wellImage, null);
});

test('normalizeDeckConfig media style keeps accent and/or backdrop, drops empty', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(dm.normalizeDeckConfig({ mediaStyle: { accent: '#FF0000' } }).mediaStyle, { accent: '#FF0000' });
  const withBg = dm.normalizeDeckConfig({ mediaStyle: { src: png, dim: 50 } }).mediaStyle;
  assert.equal(withBg.src, png);
  assert.equal(withBg.dim, 50);
  assert.equal(dm.normalizeDeckConfig({ mediaStyle: { src: 'nope', accent: 'bad' } }).mediaStyle, null);
});

test('normalizeDeckConfig accepts a gradient well (with or without an image)', () => {
  const g = dm.normalizeDeckConfig({ wellImage: { grad: { c1: '#1ED760', c2: '#0A0D12', angle: 400 } } }).wellImage;
  assert.deepEqual(g.grad, { c1: '#1ED760', c2: '#0A0D12', angle: 360 });   // angle clamped
  assert.equal('src' in g, false);                                          // gradient alone is valid
  assert.equal(dm.normalizeDeckConfig({ wellImage: { grad: { c1: '#fff' } } }).wellImage, null); // needs both stops
});

test('normalizeDeckConfig media style accepts a gradient and drops a half one', () => {
  const ms = dm.normalizeDeckConfig({ mediaStyle: { grad: { c1: '#111111', c2: '#222222' } } }).mediaStyle;
  assert.deepEqual(ms.grad, { c1: '#111111', c2: '#222222', angle: 135 });   // default angle
  assert.equal(dm.normalizeDeckConfig({ mediaStyle: { grad: { c2: '#222222' } } }).mediaStyle, null);
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
  assert.deepEqual(c.profiles[0].root.pages[0].keys[0].icon, { type: 'image', value: '', fit: 'cover' });
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

test('evaluateKeyState sbGlobal: truthy semantics + exact-value match', () => {
  const snap = (globals) => ({ sbGlobals: globals });
  // Truthy: booleans/numbers literal; off-ish strings read as OFF.
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({ g: true })), true);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({ g: false })), false);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({ g: 1 })), true);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({ g: 0 })), false);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({ g: 'on' })), true);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({ g: 'false' })), false);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({ g: 'off' })), false);
  // Missing global (undefined) → off; missing name → off.
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'g' }, snap({})), false);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal' }, snap({ g: true })), false);
  // Exact-value match wins over truthiness.
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'mode', value: 'live' }, snap({ mode: 'live' })), true);
  assert.equal(dm.evaluateKeyState({ source: 'sbGlobal', name: 'mode', value: 'live' }, snap({ mode: 'brb' })), false);
});

test('normalizeDeckConfig keeps an sbGlobal state binding (name + value)', () => {
  const cfg = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
      { id: 'k', kind: 'action', title: 'X', state: { source: 'sbGlobal', name: 'toggle', value: 'on' } },
    ] }] } }],
  });
  const key = cfg.profiles[0].root.pages[0].keys[0];
  assert.deepEqual(key.state, { source: 'sbGlobal', name: 'toggle', value: 'on' });
});

test('DECK_STATE_SOURCES includes sbGlobal', () => {
  assert.ok(dm.DECK_STATE_SOURCES.includes('sbGlobal'));
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

test('reshapeDeckConfig { compact:false } preserves a key\'s slot (auto-fit must not pack gaps away)', () => {
  let cfg = dm.normalizeDeckConfig({ cols: 3, rows: 2 });
  const nav = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, nav, 0, { id: 'a', kind: 'action', title: 'A' });
  cfg = dm.setKeyAt(cfg, nav, 4, { id: 'x', kind: 'action', title: 'X' }); // a gap at 1,2,3
  // Reshape to a grid that still holds slot 4 (8 slots): the key stays put, the
  // gap is kept — this is what lets a user's intentional layout survive a re-fit.
  const out = dm.reshapeDeckConfig(cfg, 4, 2, { compact: false });
  const keys = out.profiles[0].root.pages[0].keys;
  assert.equal(keys[0].title, 'A');
  assert.equal(keys[4].title, 'X'); // NOT packed to slot 1
  assert.equal(keys[1], null);
  assert.equal(keys[2], null);
  assert.equal(keys[3], null);
});

test('reshapeDeckConfig { preserve:true } grows to fit a high slot instead of compacting', () => {
  // Reproduces the auto-fit data-loss: a key at slot 7 (4×2 grid with gaps) must
  // NOT be repacked when a transient/smaller measurement asks for fewer slots.
  let cfg = dm.normalizeDeckConfig({ cols: 4, rows: 2 });
  const nav = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, nav, 0, { id: 'a', kind: 'action', title: 'A' });
  cfg = dm.setKeyAt(cfg, nav, 7, { id: 'z', kind: 'action', title: 'Z' }); // last slot
  // Ask for a 3×2 (6-slot) grid — too small for slot 7. preserve grows it back.
  const out = dm.reshapeDeckConfig(cfg, 3, 2, { preserve: true });
  assert.ok(out.cols * out.rows >= 8, `grew to hold slot 7, got ${out.cols}x${out.rows}`);
  const keys = out.profiles[0].root.pages[0].keys;
  assert.equal(keys[0].title, 'A');
  assert.equal(keys[7].title, 'Z'); // still at slot 7, not compacted to slot 1
});

test('reshape is linear: canonical → fitted → edit → back to canonical keeps every slot', () => {
  // Models the saveConfig fix. A deck saved as 5×2 is shown in a narrow tab tile
  // where auto-fit folds it to 4×2 (DISPLAY only). The user replaces a key ON the
  // fitted grid; saveConfig must fold that edit back onto the canonical 5×2 grid
  // WITHOUT reshuffling or losing keys — which only holds because reshape preserves
  // linear slot order. Guards against the cross-instance grid-drift / lost-key bug.
  let canonical = dm.normalizeDeckConfig({ cols: 5, rows: 2 });
  const nav = { profileId: canonical.activeProfile, path: [], pageIndex: 0 };
  const labels = ['Spotify', 'WhatsApp', 'Discord', 'Claude', 'OBS', 'Desktop', 'Rec', 'Mute'];
  labels.forEach((title, i) => { canonical = dm.setKeyAt(canonical, nav, i, { id: 'k' + i, kind: 'action', title }); });

  // Auto-fit re-flows the canonical 5×2 to a 4×2 display grid (8 slots, same keys).
  const fitted = dm.reshapeDeckConfig(canonical, 4, 2, { preserve: true });
  assert.equal(fitted.cols, 4);
  assert.deepEqual(fitted.profiles[0].root.pages[0].keys.map(k => k && k.title), labels);

  // User replaces the key at fitted slot 6 ('Rec' → 'Pause') on the displayed grid.
  const edited = dm.setKeyAt(fitted, nav, 6, { id: 'k6', kind: 'action', title: 'Pause' });

  // saveConfig folds the edit back onto the canonical 5×2 grid.
  const saved = dm.reshapeDeckConfig(edited, 5, 2, { preserve: true });
  assert.equal(saved.cols, 5);
  assert.equal(saved.rows, 2);
  const keys = saved.profiles[0].root.pages[0].keys;
  // The edit landed at the SAME linear slot; nothing else moved or vanished.
  assert.equal(keys[6].title, 'Pause');
  assert.deepEqual(keys.map(k => k && k.title),
    ['Spotify', 'WhatsApp', 'Discord', 'Claude', 'OBS', 'Desktop', 'Pause', 'Mute', null, null]);
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

test('swapKeysAt swaps two slots and moves a key into an empty one', () => {
  const nav = { profileId: 'p', path: [], pageIndex: 0 };
  const mk = (keys) => dm.normalizeDeckConfig({ cols: 2, rows: 1, profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys }] } }] });
  // swap two placed keys
  let s = dm.swapKeysAt(mk([{ id: 'a', kind: 'action', title: 'A' }, { id: 'b', kind: 'action', title: 'B' }]), nav, 0, 1);
  let k = s.profiles[0].root.pages[0].keys;
  assert.equal(k[0].title, 'B'); assert.equal(k[1].title, 'A');
  // move into an empty slot: [A, null] swap 0<->1 → [null, A]
  let s2 = dm.swapKeysAt(mk([{ id: 'a', kind: 'action', title: 'A' }, null]), nav, 0, 1);
  let k2 = s2.profiles[0].root.pages[0].keys;
  assert.equal(k2[0], null); assert.equal(k2[1].title, 'A');
  // out-of-range / equal indices are no-ops
  let s3 = dm.swapKeysAt(mk([{ id: 'a', kind: 'action', title: 'A' }, { id: 'b', kind: 'action', title: 'B' }]), nav, 0, 9);
  assert.equal(s3.profiles[0].root.pages[0].keys[0].title, 'A');
});

test('addProfileFromTemplate grows the grid so a richer template never loses keys', () => {
  // Source profile: 8 keys laid out on a 4x2 grid (slots 0..7).
  const titles = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  let src = dm.normalizeDeckConfig({ cols: 4, rows: 2, profiles: [{ id: 'p0', name: 'Utility', root: { pages: [{ keys: [] }] } }], activeProfile: 'p0' });
  const nav = { profileId: 'p0', path: [], pageIndex: 0 };
  titles.forEach((tt, i) => { src = dm.setKeyAt(src, nav, i, { id: 'k' + i, kind: 'action', title: tt }); });
  const template = src.profiles[0];

  // Target: a brand-new deck at the default 3x2 = 6 slots (smaller than the template).
  const target = dm.normalizeDeckConfig(null);
  assert.ok(target.cols * target.rows < 8);

  const out = dm.addProfileFromTemplate(target, template);
  const added = out.profiles[out.profiles.length - 1];
  assert.equal(out.activeProfile, added.id);
  // Grid grew to hold all 8 keys, and every key survived (no truncation to 6).
  assert.ok(out.cols * out.rows >= 8, 'grid should grow to fit the template');
  const placed = added.root.pages[0].keys.filter(Boolean).map(k => k.title).sort();
  assert.deepEqual(placed, titles.slice().sort());
});

test('addProfileFromTemplate keeps the existing grid when the template already fits', () => {
  const big = dm.normalizeDeckConfig({ cols: 5, rows: 3 }); // 15 slots
  let src = dm.normalizeDeckConfig({ cols: 2, rows: 2, profiles: [{ id: 'p0', name: 'Small', root: { pages: [{ keys: [] }] } }], activeProfile: 'p0' });
  src = dm.setKeyAt(src, { profileId: 'p0', path: [], pageIndex: 0 }, 0, { id: 'k0', kind: 'action', title: 'X' });
  const out = dm.addProfileFromTemplate(big, src.profiles[0]);
  assert.equal(out.cols, 5); assert.equal(out.rows, 3); // unchanged
});

// ── Per-key styling (v3.5: gradients, backdrop image, icon/label styling) ──

const styleCfg = (key) => dm.normalizeDeckConfig({
  cols: 2, rows: 1,
  profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [key, null] }] } }],
  activeProfile: 'p',
});
const firstKey = (c) => c.profiles[0].root.pages[0].keys[0];

test('normalizeKey keeps a valid gradient (bg2 + bgDir) and drops invalid pieces', () => {
  const k = firstKey(styleCfg({ id: 'k', kind: 'action', bg: '#ff0000', bg2: '#00ff00', bgDir: 'v' }));
  assert.equal(k.bg, '#ff0000');
  assert.equal(k.bg2, '#00ff00');
  assert.equal(k.bgDir, 'v');
  // Default direction is omitted; junk directions are dropped.
  const kd = firstKey(styleCfg({ id: 'k', kind: 'action', bg: '#ff0000', bg2: '#00ff00', bgDir: 'zig' }));
  assert.equal(kd.bgDir, undefined);
  // bg2 without a primary bg is meaningless and dropped.
  const k2 = firstKey(styleCfg({ id: 'k', kind: 'action', bg2: '#00ff00' }));
  assert.equal(k2.bg2, undefined);
  // Non-hex colours are dropped.
  const k3 = firstKey(styleCfg({ id: 'k', kind: 'action', bg: 'red', bg2: 'javascript:x' }));
  assert.equal(k3.bg, undefined);
  assert.equal(k3.bg2, undefined);
});

test('normalizeKey validates the backdrop image and clamps its dim/blur', () => {
  const ok = firstKey(styleCfg({ id: 'k', kind: 'action', bgImage: { value: 'data:image/png;base64,AAA', dim: 200, blur: 99 } }));
  assert.equal(ok.bgImage.value, 'data:image/png;base64,AAA');
  assert.equal(ok.bgImage.dim, 85); // clamped to the max
  assert.equal(ok.bgImage.blur, 20); // clamped to the max
  const dflt = firstKey(styleCfg({ id: 'k', kind: 'action', bgImage: { value: 'https://x/y.png' } }));
  assert.equal(dflt.bgImage.dim, 35); // default scrim
  assert.equal(dflt.bgImage.blur, 0); // no blur by default
  // Unsafe schemes are rejected outright.
  const bad = firstKey(styleCfg({ id: 'k', kind: 'action', bgImage: { value: 'javascript:alert(1)' } }));
  assert.equal(bad.bgImage, undefined);
});

test('normalizeKey keeps icon/label styling and drops junk values', () => {
  const k = firstKey(styleCfg({
    id: 'k', kind: 'action',
    iconColor: '#ffcc00', labelColor: '#fff', labelPos: 'top', labelSize: 'lg', labelBold: true, iconSize: 'sm', anim: 'breathe',
  }));
  assert.equal(k.iconColor, '#ffcc00');
  assert.equal(k.labelColor, '#fff');
  assert.equal(k.labelPos, 'top');
  assert.equal(k.labelSize, 'lg');
  assert.equal(k.labelBold, true);
  assert.equal(k.iconSize, 'sm');
  assert.equal(k.anim, 'breathe');
  const bad = firstKey(styleCfg({
    id: 'k', kind: 'action',
    iconColor: 'url(x)', labelPos: 'floating', labelSize: 'xxl', labelBold: 'yes', iconSize: 'huge', anim: 'spin',
  }));
  assert.equal(bad.iconColor, undefined);
  assert.equal(bad.labelPos, undefined);
  assert.equal(bad.labelSize, undefined);
  assert.equal(bad.labelBold, undefined);
  assert.equal(bad.iconSize, undefined);
  assert.equal(bad.anim, undefined);
  // Defaults are omitted, not stored.
  const dflt = firstKey(styleCfg({ id: 'k', kind: 'action', labelPos: 'bottom', labelSize: 'md', iconSize: 'md', anim: 'none' }));
  assert.equal(dflt.labelPos, undefined);
  assert.equal(dflt.labelSize, undefined);
  assert.equal(dflt.iconSize, undefined);
  assert.equal(dflt.anim, undefined);
});

test('normalizeDeckConfig validates the whole-device look enums', () => {
  const c = dm.normalizeDeckConfig({ capStyle: 'neon', keyShape: 'circle', plate: 'carbon' });
  assert.equal(c.capStyle, 'neon');
  assert.equal(c.keyShape, 'circle');
  assert.equal(c.plate, 'carbon');
  const d = dm.normalizeDeckConfig({ capStyle: 'chrome', keyShape: 'hex', plate: 'wood' });
  assert.equal(d.capStyle, 'lcd');
  assert.equal(d.keyShape, 'rounded');
  assert.equal(d.plate, 'graphite');
});

test('keyStyleOf extracts only style fields; applyStyleToPage repaints every placed key', () => {
  const src = { id: 'k', kind: 'action', title: 'T', triggers: {}, bg: '#ff0000', bg2: '#00ff00', labelBold: true, press: 'flash' };
  const style = dm.keyStyleOf(src);
  assert.deepEqual(Object.keys(style).sort(), ['bg', 'bg2', 'labelBold', 'press'].sort());
  assert.equal(style.title, undefined);

  let cfg = dm.normalizeDeckConfig({
    cols: 2, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
      { id: 'a', kind: 'action', title: 'A', bg: '#0000ff', iconColor: '#123456' },
      { id: 'b', kind: 'folder', title: 'B' },
    ] }] } }],
    activeProfile: 'p',
  });
  cfg = dm.applyStyleToPage(cfg, { profileId: 'p', path: [], pageIndex: 0 }, style);
  const [a, b] = cfg.profiles[0].root.pages[0].keys;
  // Both keys got the new look; fields NOT in the style were cleared.
  for (const k of [a, b]) {
    assert.equal(k.bg, '#ff0000');
    assert.equal(k.bg2, '#00ff00');
    assert.equal(k.labelBold, true);
    assert.equal(k.press, 'flash');
    assert.equal(k.iconColor, undefined);
  }
  // Identity and content survive untouched.
  assert.equal(a.title, 'A');
  assert.equal(a.id, 'a');
  assert.equal(b.kind, 'folder');
});

// ── Live value binding (key.live) + formatLiveValue ──────────────────────────

function keyThrough(raw) {
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [raw] }] } }],
    activeProfile: 'p',
  });
  return c.profiles[0].root.pages[0].keys[0];
}

test('normalizeKey keeps a valid live binding and drops unknown sources', () => {
  const good = keyThrough({ id: 'k', kind: 'action', live: { source: 'timer', name: 'Pasta' } });
  assert.deepEqual(good.live, { source: 'timer', name: 'Pasta' });
  const unnamed = keyThrough({ id: 'k', kind: 'action', live: { source: 'sdkState' } });
  assert.deepEqual(unnamed.live, { source: 'sdkState' });
  assert.equal(keyThrough({ id: 'k', kind: 'action', live: { source: 'evil' } }).live, undefined);
  assert.equal(keyThrough({ id: 'k', kind: 'action', live: 'timer' }).live, undefined);
  // Hostile name is clamped, never markup.
  const long = keyThrough({ id: 'k', kind: 'action', live: { source: 'timer', name: 'x'.repeat(500) } });
  assert.equal(long.live.name.length, 200);
});

test('formatLiveValue: timer countdown from endsAt, paused freeze, soonest-running fallback', () => {
  const now = 1_000_000;
  // Snapshot keys are LOWERCASED (timersByLabel) — lookups must match the
  // server's case-insensitive label handling.
  const snapshot = { timers: {
    pasta: { status: 'running', endsAt: now + 95_000 },
    tea: { status: 'running', endsAt: now + 30_000 },
    frozen: { status: 'paused', remainingSecs: 3670 },
  } };
  assert.deepEqual(dm.formatLiveValue({ source: 'timer', name: 'Pasta' }, snapshot, now), { text: '1:35' });
  // Paused → frozen remaining, h:mm:ss over an hour.
  assert.deepEqual(dm.formatLiveValue({ source: 'timer', name: 'FROZEN' }, snapshot, now), { text: '1:01:10' });
  // Unnamed → the running timer ending soonest.
  assert.deepEqual(dm.formatLiveValue({ source: 'timer' }, snapshot, now), { text: '0:30' });
  // Overdue clamps at zero; unknown name yields empty text.
  assert.deepEqual(dm.formatLiveValue({ source: 'timer', name: 'Pasta' }, snapshot, now + 200_000), { text: '0:00' });
  assert.deepEqual(dm.formatLiveValue({ source: 'timer', name: 'Nope' }, snapshot, now), { text: '' });
});

test('timersByLabel lowercases its keys so tile-created labels match key bindings in any case', () => {
  const now = Date.now();
  const bag = dm.timersByLabel([
    { label: 'Tea', status: 'running', durationSecs: 60, pausedElapsed: 0, startedAt: now },
    { label: 'PASTA', status: 'paused', durationSecs: 90, pausedElapsed: 30 },
    { label: '', status: 'running' },          // unlabeled → skipped
  ]);
  assert.deepEqual(Object.keys(bag).sort(), ['pasta', 'tea']);
  assert.equal(bag.tea.status, 'running');
  assert.equal(bag.pasta.remainingSecs, 60);
});

test('formatLiveValue: sdkState uses published meta label + validated color', () => {
  const snapshot = {
    sdkStates: { viewers: '1.2k', raw: 42 },
    sdkStateMeta: { viewers: { label: 'LIVE 1.2k', color: '#ff3355' }, raw: { color: 'javascript:alert(1)' } },
  };
  assert.deepEqual(dm.formatLiveValue({ source: 'sdkState', name: 'viewers' }, snapshot, 0), { text: 'LIVE 1.2k', color: '#ff3355' });
  // No meta label → the raw value as text; hostile color dropped.
  assert.deepEqual(dm.formatLiveValue({ source: 'sdkState', name: 'raw' }, snapshot, 0), { text: '42' });
  assert.deepEqual(dm.formatLiveValue({ source: 'sdkState', name: 'missing' }, snapshot, 0), { text: '' });
  assert.deepEqual(dm.formatLiveValue(null, snapshot, 0), { text: '' });
  assert.deepEqual(dm.formatLiveValue({ source: 'timer' }, null, 0), { text: '' });
});

// ── Generalized state sources (discord / media / HA / timer) + stateStyle ────

test('evaluateKeyState: discord, media and spotify sources read snapshot flags', () => {
  const snap = { discordMuted: true, discordDeafened: false, mediaPlaying: true, mediaSource: 'Spotify' };
  assert.equal(dm.evaluateKeyState({ source: 'discordMuted' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'discordDeafened' }, snap), false);
  assert.equal(dm.evaluateKeyState({ source: 'mediaPlaying' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'spotifyPlaying' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'spotifyPlaying' }, { mediaPlaying: true, mediaSource: 'YouTube' }), false);
  assert.equal(dm.evaluateKeyState({ source: 'spotifyPlaying' }, { mediaPlaying: false, mediaSource: 'Spotify' }), false);
});

test('evaluateKeyState: haEntity follows the on-set or an exact value', () => {
  const snap = { haStates: {
    'light.desk': { state: 'on', brightness: 128 },
    'climate.living': { state: 'heat' },
    'lock.front': { state: 'locked' },
  } };
  assert.equal(dm.evaluateKeyState({ source: 'haEntity', entity: 'light.desk' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'haEntity', entity: 'lock.front' }, snap), false);       // locked ∉ on-set
  assert.equal(dm.evaluateKeyState({ source: 'haEntity', entity: 'climate.living', value: 'heat' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'haEntity', entity: 'climate.living', value: 'cool' }, snap), false);
  assert.equal(dm.evaluateKeyState({ source: 'haEntity', entity: 'light.missing' }, snap), false);
  assert.equal(dm.evaluateKeyState({ source: 'haEntity' }, snap), false);                              // no entity bound
});

test('evaluateKeyState: timerRunning matches by label (case-insensitively) or any running timer', () => {
  // Snapshot keys are lowercased by timersByLabel; the binding may be typed in any case.
  const snap = { timers: { pasta: { status: 'running', endsAt: 99 }, tea: { status: 'paused', remainingSecs: 5 } } };
  assert.equal(dm.evaluateKeyState({ source: 'timerRunning', name: 'Pasta' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'timerRunning', name: 'Tea' }, snap), false);
  assert.equal(dm.evaluateKeyState({ source: 'timerRunning' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'timerRunning' }, { timers: {} }), false);
});

test('normalizeKey keeps state.entity and a validated stateStyle, drops hostile values', () => {
  const key = keyThrough({
    id: 'k', kind: 'action',
    state: { source: 'haEntity', entity: 'light.desk' },
    stateStyle: { icon: '🔴', label: 'ON AIR', color: '#ff3355', evil: 'x' },
  });
  assert.equal(key.state.entity, 'light.desk');
  assert.deepEqual(key.stateStyle, { icon: '🔴', label: 'ON AIR', color: '#ff3355' });
  const bad = keyThrough({ id: 'k', kind: 'action', stateStyle: { color: 'javascript:alert(1)' } });
  assert.equal(bad.stateStyle, undefined);   // no valid field survives → the whole block drops
});

// ── Smart Profiles (autoSwitch) normalization ────────────────────────────────

test('normalizeDeckConfig: autoSwitch defaults off and rebuilds rules safely', () => {
  const off = dm.normalizeDeckConfig(null);
  assert.deepEqual(off.autoSwitch, { enabled: false, revert: 'default', rules: [] });
  const c = dm.normalizeDeckConfig({ autoSwitch: {
    enabled: true, revert: 'stay',
    rules: [
      { exe: 'OBS64.EXE', profile: 'Streaming' },
      { exe: 'obs64', profile: 'Duplicate of first is dropped' },
      { exe: '', profile: 'NoExe' },
      { exe: 'code', profile: '' },
      { exe: 'x'.repeat(200), profile: 'y'.repeat(200) },
      'junk',
    ],
  } });
  assert.equal(c.autoSwitch.enabled, true);
  assert.equal(c.autoSwitch.revert, 'stay');
  assert.deepEqual(c.autoSwitch.rules[0], { exe: 'obs64', profile: 'Streaming' });   // lowercased, .exe stripped
  assert.equal(c.autoSwitch.rules.length, 2);                                        // dupes/empties/junk dropped
  assert.equal(c.autoSwitch.rules[1].exe.length, 60);                                // caps applied
  assert.equal(c.autoSwitch.rules[1].profile.length, 40);
  // Hostile revert collapses to default; >16 rules truncated.
  const many = dm.normalizeDeckConfig({ autoSwitch: { enabled: true, revert: 'evil', rules: new Array(30).fill(null).map((_, i) => ({ exe: 'app' + i, profile: 'P' })) } });
  assert.equal(many.autoSwitch.revert, 'default');
  assert.equal(many.autoSwitch.rules.length, 16);
});

// ── Slider keys (touch faders) ───────────────────────────────────────────────

test('normalizeKey: slider kind keeps a valid target config, drops invalid ones', () => {
  const vol = keyThrough({ id: 'k', kind: 'slider', slider: { target: 'volume', orient: 'h' } });
  assert.deepEqual(vol.slider, { target: 'volume', orient: 'h' });
  const app = keyThrough({ id: 'k', kind: 'slider', slider: { target: 'appVolume', app: 'spotify.exe' } });
  assert.deepEqual(app.slider, { target: 'appVolume', orient: 'v', app: 'spotify.exe' });
  const ha = keyThrough({ id: 'k', kind: 'slider', slider: { target: 'haLight', entity: 'light.desk' } });
  assert.equal(ha.slider.entity, 'light.desk');
  // Target-specific required field missing → the whole key drops.
  assert.equal(keyThrough({ id: 'k', kind: 'slider', slider: { target: 'appVolume' } }), null);
  assert.equal(keyThrough({ id: 'k', kind: 'slider', slider: { target: 'evil' } }), null);
  assert.equal(keyThrough({ id: 'k', kind: 'slider' }), null);
});

// ── Imported-profile marker (redistribution policy) ─────────────────────────

test('normalizeProfile preserves the imported marker and never invents it', () => {
  const cfg = dm.normalizeDeckConfig({
    cols: 2, rows: 1,
    profiles: [
      { id: 'a', name: 'Mine', root: { pages: [{ keys: [] }] } },
      { id: 'b', name: 'Theirs', imported: true, root: { pages: [{ keys: [] }] } },
      { id: 'c', name: 'Hostile', imported: 'yes', root: { pages: [{ keys: [] }] } },
    ],
    activeProfile: 'a',
  });
  assert.equal('imported' in cfg.profiles[0], false);
  assert.equal(cfg.profiles[1].imported, true);
  assert.equal('imported' in cfg.profiles[2], false);   // only literal true survives
});

test('addProfileFromTemplate threads the imported marker through', () => {
  const target = dm.normalizeDeckConfig(null);
  const out = dm.addProfileFromTemplate(target, { name: 'Shared', imported: true, root: { pages: [{ keys: [{ id: 'k0', kind: 'action', title: 'X' }] }] } });
  const added = out.profiles[out.profiles.length - 1];
  assert.equal(added.imported, true);
  // …and an own template stays unmarked.
  const out2 = dm.addProfileFromTemplate(target, { name: 'Own', root: { pages: [{ keys: [{ id: 'k0', kind: 'action', title: 'X' }] }] } });
  assert.equal('imported' in out2.profiles[out2.profiles.length - 1], false);
});
