import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encodePreset, decodePreset, sanitizeDeckProfile, profileActionSummary, stripProfileImages, countProfileKeys } = require('../js/preset-share.js');
const DeckModel = require('../js/deck-model.js');
const DeckActions = require('../js/deck-actions.js');

// Portable-preset format: encode → decode round-trip + rejection of junk, plus
// the deck-profile sanitization boundary (untrusted profiles are rebuilt, and
// every action re-validated, before anything is stored). The browser
// dialogs/apply layer is skipped under node (no window).

const DEPS = { model: DeckModel, actions: DeckActions };

// A raw profile with one action key; overrides let each test poison a field.
function rawProfile(keyOverrides, profileOverrides) {
  const key = Object.assign({
    kind: 'action', title: 'Mute',
    icon: { type: 'emoji', value: '🎙' },
    triggers: { tap: { type: 'micMute', mode: 'toggle' } },
  }, keyOverrides || {});
  return Object.assign({ name: 'Stream', root: { pages: [{ keys: [key] }] } }, profileOverrides || {});
}
const firstKey = (prof) => prof.root.pages[0].keys.find(Boolean);

test('encode → decode round-trips kind, name and data (incl. non-ASCII)', () => {
  const data = { accent: '#ff7eb6', background: '#16101a', appearance: 'dark' };
  const code = encodePreset('theme', '테마 · 私の', data, { exportedAt: '2026-07-03', appVersion: '4.0.0' });
  const env = decodePreset(code);
  assert.ok(env);
  assert.equal(env.kind, 'theme');
  assert.equal(env.name, '테마 · 私の');
  assert.deepEqual(env.data, data);
});

test('decode accepts a full link, a bare code and raw JSON', () => {
  const code = encodePreset('page', 'Gaming', { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 4, h: 3 }] });
  assert.equal(decodePreset('http://127.0.0.1:3030/#preset=' + code).kind, 'page');
  assert.equal(decodePreset(code).name, 'Gaming');
  const rawJson = JSON.stringify({ xenonPreset: 1, kind: 'theme', name: 'x', data: { accent: '#000' } });
  assert.equal(decodePreset(rawJson).kind, 'theme');
});

test('decode rejects malformed / wrong-format / wrong-kind input', () => {
  assert.equal(decodePreset(''), null);
  assert.equal(decodePreset('not base64 @@@ !!!'), null);
  assert.equal(decodePreset(null), null);
  // wrong format version
  const badVer = Buffer.from(JSON.stringify({ xenonPreset: 2, kind: 'theme', name: 'x', data: {} }), 'utf8').toString('base64url');
  assert.equal(decodePreset(badVer), null);
  // unknown kind
  const badKind = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'widget', name: 'x', data: {} }), 'utf8').toString('base64url');
  assert.equal(decodePreset(badKind), null);
  // missing data object
  const noData = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'theme', name: 'x' }), 'utf8').toString('base64url');
  assert.equal(decodePreset(noData), null);
});

test('name is bounded to 60 chars on encode', () => {
  const env = decodePreset(encodePreset('theme', 'x'.repeat(200), { accent: '#000' }));
  assert.equal(env.name.length, 60);
});

// ── Deck-profile sharing (the security boundary) ─────────────────────────────

test('deck kind round-trips through encode → decode', () => {
  const env = decodePreset(encodePreset('deck', 'Stream', rawProfile()));
  assert.equal(env.kind, 'deck');
  assert.equal(env.name, 'Stream');
  assert.equal(env.data.root.pages[0].keys[0].triggers.tap.type, 'micMute');
});

test('sanitize keeps a valid profile intact (name, key, validated trigger)', () => {
  const prof = sanitizeDeckProfile(rawProfile(), DEPS);
  assert.ok(prof);
  assert.equal(prof.name, 'Stream');
  assert.equal(prof.id, undefined, 'no id — the importer assigns a fresh one');
  const key = firstKey(prof);
  assert.deepEqual(key.triggers.tap, { type: 'micMute', mode: 'toggle' });
  assert.equal(countProfileKeys(prof), 1);
});

test('sanitize drops unknown action types and unknown trigger names', () => {
  const prof = sanitizeDeckProfile(rawProfile({
    triggers: {
      tap: { type: 'runShellCommand', cmd: 'evil.exe' },   // no such action type
      hold: { type: 'micMute', mode: 'toggle' },
      onload: { type: 'micMute', mode: 'toggle' },          // no such trigger — could never auto-fire
    },
  }), DEPS);
  const key = firstKey(prof);
  assert.equal(key.triggers.tap, undefined, 'unknown action type dropped');
  assert.equal(key.triggers.onload, undefined, 'unknown trigger name dropped');
  assert.deepEqual(key.triggers.hold, { type: 'micMute', mode: 'toggle' });
});

test('sanitize rebuilds actions onto the catalog spec (params coerced, extras dropped)', () => {
  const prof = sanitizeDeckProfile(rawProfile({
    triggers: { tap: { type: 'media', cmd: 'format-c', __proto__evil: 1, extra: 'smuggled' } },
  }), DEPS);
  const tap = firstKey(prof).triggers.tap;
  assert.deepEqual(tap, { type: 'media', cmd: 'playpause' }, 'off-catalog select coerced to the first option; extra keys gone');
});

test('sanitize validates multi-action steps and drops the invalid ones', () => {
  const prof = sanitizeDeckProfile(rawProfile({
    triggers: { tap: { steps: [
      { action: { type: 'volume', mode: 'up' }, delayMs: 250 },
      { action: { type: 'nope' } },
      { action: { type: 'openUrl', url: 'https://example.com' }, delayMs: 999999 },
    ] } },
  }), DEPS);
  const tap = firstKey(prof).triggers.tap;
  assert.equal(tap.steps.length, 2, 'invalid step dropped');
  assert.equal(tap.steps[1].delayMs, 10000, 'delay clamped');
});

test('sanitize restricts state bindings to the known read-only sources', () => {
  const ok = sanitizeDeckProfile(rawProfile({ state: { source: 'micMuted' } }), DEPS);
  assert.equal(firstKey(ok).state.source, 'micMuted');
  const bad = sanitizeDeckProfile(rawProfile({ state: { source: 'evalJs' } }), DEPS);
  assert.equal(firstKey(bad).state, undefined, 'unknown state source dropped');
});

test('sanitize clears blob: images (session-local, dead on another machine)', () => {
  const prof = sanitizeDeckProfile(rawProfile({
    icon: { type: 'image', value: 'blob:http://127.0.0.1:3030/xyz' },
    bgImage: { value: 'blob:http://127.0.0.1:3030/abc', dim: 30 },
  }), DEPS);
  const key = firstKey(prof);
  assert.equal(key.icon.value, '');
  assert.equal(key.bgImage, undefined);
});

test('sanitize survives a hostile deeply-nested folder payload (depth-capped, no throw)', () => {
  let key = { kind: 'action', title: 'leaf', icon: { type: 'emoji', value: 'x' }, triggers: {} };
  for (let i = 0; i < 5000; i++) {
    key = { kind: 'folder', title: 'f' + i, icon: { type: 'emoji', value: '' }, folder: { pages: [{ keys: [key] }] } };
  }
  const prof = sanitizeDeckProfile({ name: 'deep', root: { pages: [{ keys: [key] }] } }, DEPS);
  assert.ok(prof, 'sanitize returns a profile instead of blowing the stack');
  assert.ok(countProfileKeys(prof) >= 1);
});

test('sanitize rejects non-objects and profiles without a root', () => {
  assert.equal(sanitizeDeckProfile(null, DEPS), null);
  assert.equal(sanitizeDeckProfile('x', DEPS), null);
  assert.equal(sanitizeDeckProfile({ name: 'x' }, DEPS), null);
});

test('profileActionSummary counts action types across triggers, steps and folders', () => {
  const folderKey = {
    kind: 'folder', title: 'more', icon: { type: 'emoji', value: '' },
    folder: { pages: [{ keys: [{ kind: 'action', title: 'in', icon: { type: 'emoji', value: '' }, triggers: { tap: { type: 'micMute', mode: 'toggle' } } }] }] },
  };
  const raw = rawProfile({ triggers: { tap: { steps: [
    { action: { type: 'micMute', mode: 'toggle' } },
    { action: { type: 'volume', mode: 'up' } },
  ] } } });
  raw.root.pages[0].keys.push(folderKey);
  const prof = sanitizeDeckProfile(raw, DEPS);
  const summary = profileActionSummary(prof, DEPS);
  assert.deepEqual(summary, [{ type: 'micMute', count: 2 }, { type: 'volume', count: 1 }]);
});

test('stripProfileImages removes photo faces and image icons, keeps everything else', () => {
  const prof = sanitizeDeckProfile(rawProfile({
    icon: { type: 'image', value: 'data:image/png;base64,AAAA' },
    bgImage: { value: 'data:image/png;base64,BBBB', dim: 30 },
  }), DEPS);
  const slim = stripProfileImages(prof);
  const key = firstKey(slim);
  assert.equal(key.bgImage, undefined);
  assert.equal(key.icon.type, 'emoji');
  assert.deepEqual(key.triggers.tap, { type: 'micMute', mode: 'toggle' }, 'actions untouched');
  assert.ok(firstKey(prof).bgImage, 'original profile not mutated');
});
