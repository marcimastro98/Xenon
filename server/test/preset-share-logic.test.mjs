import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encodePreset, decodePreset, sanitizeDeckProfile, profileActionSummary, stripProfileImages, countProfileKeys, lockPreset, unlockPreset, peekLocked, canonCode } = require('../js/preset-share.js');
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

test('theme code round-trips an embedded custom font payload', () => {
  // A shared theme may carry the custom typeface as a base64 blob so the code is
  // self-contained; encode/decode must preserve it intact for the import side to
  // write it back through POST /font.
  const data = {
    accent: '#1ed760', appearance: 'dark',
    fontData: { data: 'T1RUTwABAAA', ext: 'woff2', name: 'MyFont.woff2' },
  };
  const env = decodePreset(encodePreset('theme', 'Fonted', data));
  assert.ok(env);
  assert.deepEqual(env.data.fontData, data.fontData);
});

test('ambient kind round-trips its widget-shaped payload', () => {
  const data = {
    id: 'starfield', name: 'Starfield', surface: 'ambient',
    streams: ['media', 'weather'], actions: [], hosts: [], hooks: [],
    payload: { id: 'starfield', files: [{ path: 'manifest.json', data: 'e30' }] },
  };
  const env = decodePreset(encodePreset('ambient', 'Starfield', data));
  assert.ok(env);
  assert.equal(env.kind, 'ambient');
  assert.deepEqual(env.data, data);
});

test('ambient-layout kind round-trips a native canvas scene + bundled widgets', () => {
  const data = {
    scene: {
      id: 'nocturne', v: 1, name: 'Nocturne',
      bg: { type: 'gradient', color: '#05060a', grad: { from: '#0b1020', to: '#05060a', angle: 200 }, dim: 10, blur: 0 },
      components: [
        { id: 'cmp1', type: 'clock', x: 25, y: 30, w: 50, h: 32, rot: 0, z: 0, props: { format: '24', seconds: false } },
        { id: 'cmp2', type: 'sdk', x: 60, y: 6, w: 30, h: 30, rot: 0, z: 1, props: { pkgId: 'my-widget', entry: 'index.html' } },
      ],
    },
    widgets: [{ id: 'my-widget', payload: { id: 'my-widget', files: [{ path: 'manifest.json', data: 'e30' }] } }],
  };
  const env = decodePreset(encodePreset('ambient-layout', 'Nocturne', data));
  assert.ok(env);
  assert.equal(env.kind, 'ambient-layout');
  assert.deepEqual(env.data, data);
});

test('ambient kind survives the locked-code round trip', async () => {
  const inner = encodePreset('ambient', 'Locked scene', { id: 's1', payload: { id: 's1', files: [] } });
  const { code, codes } = await lockPreset(inner, { kind: 'ambient', name: 'Locked scene' }, 2);
  assert.equal(codes.length, 2);
  const locked = peekLocked(code);
  assert.ok(locked);
  assert.equal(locked.kind, 'ambient');
  const unlocked = await unlockPreset(locked, codes[0]);
  assert.ok(unlocked);
  assert.equal(decodePreset(unlocked).kind, 'ambient');
  assert.equal(await unlockPreset(locked, 'XN-WRON-GCOD-E222'), null);
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
  const badKind = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'malware', name: 'x', data: {} }), 'utf8').toString('base64url');
  assert.equal(decodePreset(badKind), null);
  // missing data object
  const noData = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'theme', name: 'x' }), 'utf8').toString('base64url');
  assert.equal(decodePreset(noData), null);
});

test('name is bounded to 60 chars on encode', () => {
  const env = decodePreset(encodePreset('theme', 'x'.repeat(200), { accent: '#000' }));
  assert.equal(env.name.length, 60);
});

test('encode stamps gridCols=24 and decode passes it through (legacy codes → 0)', () => {
  const env = decodePreset(encodePreset('page', 'P', { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6 }] }));
  assert.equal(env.gridCols, 24);
  // a pre-24-column code has no gridCols field → importers scale it ×2
  const legacy = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'page', name: 'old', data: { items: [] } }), 'utf8').toString('base64url');
  assert.equal(decodePreset(legacy).gridCols, 0);
});

// ── Bundle ("Pacchetto Xenon") format ────────────────────────────────────────

test('bundle kind round-trips theme + pages + widget payloads', () => {
  const data = {
    theme: { accent: '#35e08e', appearance: 'dark' },
    pages: [{ name: 'Gaming', data: { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6 }] } }],
    widgets: [{
      id: 'hello-xenon', name: 'Hello', actions: ['media'], hosts: ['api.example.com'], streams: [], hooks: [],
      payload: { id: 'hello-xenon', files: [{ path: 'manifest.json', data: 'e30=' }] },
    }],
  };
  const env = decodePreset(encodePreset('bundle', 'My pack', data, { appVersion: '4.1.0' }));
  assert.ok(env);
  assert.equal(env.kind, 'bundle');
  assert.equal(env.name, 'My pack');
  assert.equal(env.data.theme.accent, '#35e08e');
  assert.equal(env.data.pages.length, 1);
  assert.equal(env.data.pages[0].name, 'Gaming');
  assert.equal(env.data.widgets[0].id, 'hello-xenon');
  assert.equal(env.data.widgets[0].payload.files[0].path, 'manifest.json');
});

test('a bundle with only a theme still decodes', () => {
  const env = decodePreset(encodePreset('bundle', 'Just colours', { theme: { accent: '#000' } }));
  assert.equal(env.kind, 'bundle');
  assert.deepEqual(env.data, { theme: { accent: '#000' } });
});

test('bg kind round-trips a code-defined animated background', () => {
  const data = { name: 'Starfield', code: 'function draw(ctx, t, w, h) { ctx.clearRect(0, 0, w, h); }' };
  const env = decodePreset(encodePreset('bg', 'Starfield', data, { appVersion: '4.1.0' }));
  assert.ok(env);
  assert.equal(env.kind, 'bg');
  assert.equal(env.name, 'Starfield');
  assert.equal(env.data.name, 'Starfield');
  assert.match(env.data.code, /function draw\(ctx, t, w, h\)/);
});

test('widget kind round-trips a single community-widget payload', () => {
  const data = {
    id: 'hello-xenon', name: 'Hello', actions: ['media'], hosts: [], streams: [], hooks: [],
    payload: { id: 'hello-xenon', files: [{ path: 'manifest.json', data: 'e30=' }] },
  };
  const env = decodePreset(encodePreset('widget', 'Hello', data, { appVersion: '4.1.0' }));
  assert.ok(env);
  assert.equal(env.kind, 'widget');
  assert.equal(env.data.id, 'hello-xenon');
  assert.equal(env.data.payload.files[0].path, 'manifest.json');
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

test('sanitize carries a validated device LOOK (well + music) with the profile', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const prof = sanitizeDeckProfile(rawProfile({}, {
    look: {
      wellImage: { grad: { c1: '#1ED760', c2: '#0A0D12', angle: 90 }, dim: 30 },
      mediaStyle: { src: png, accent: '#FF0000', dim: 40 },
    },
  }), DEPS);
  assert.ok(prof.look);
  assert.deepEqual(prof.look.wellImage.grad, { c1: '#1ED760', c2: '#0A0D12', angle: 90 });
  assert.equal(prof.look.mediaStyle.accent, '#FF0000');
  assert.equal(prof.look.mediaStyle.src, png);
});

test('sanitize rejects a remote/uploads image inside a shared LOOK', () => {
  const prof = sanitizeDeckProfile(rawProfile({}, {
    look: { wellImage: { src: 'http://evil/x.png' }, mediaStyle: { src: '/uploads/x.png' } },
  }), DEPS);
  assert.equal(prof.look, undefined, 'no valid look survives → field omitted');
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

test('sanitize strips runScript (local-only) from a shared profile but keeps other actions', () => {
  const prof = sanitizeDeckProfile(rawProfile({
    triggers: {
      tap: { type: 'runScript', path: 'C:/Users/victim/Downloads/evil.ps1' }, // must never travel
      hold: { steps: [
        { action: { type: 'volume', mode: 'up' }, delayMs: 0 },
        { action: { type: 'runScript', path: 'C:/x/pwn.bat' } },              // dropped from the sequence
        { action: { type: 'micMute', mode: 'toggle' }, delayMs: 100 },
      ] },
    },
  }), DEPS);
  const key = firstKey(prof);
  assert.equal(key.triggers.tap, undefined, 'a lone runScript trigger is dropped entirely');
  assert.equal(key.triggers.hold.steps.length, 2, 'the runScript step is removed from the multi-action');
  assert.ok(key.triggers.hold.steps.every((s) => s.action.type !== 'runScript'), 'no runScript survives');
  assert.deepEqual(key.triggers.hold.steps[0].action, { type: 'volume', mode: 'up' });
  assert.deepEqual(key.triggers.hold.steps[1].action, { type: 'micMute', mode: 'toggle' });
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

// ── Code-locked presets (envelope encryption) ───────────────────────────────

test('lock → unlock round-trips the inner preset with any of the generated codes', async () => {
  const inner = encodePreset('theme', 'Nebula', { accent: '#7c5cff', appearance: 'dark' });
  const { code, codes } = await lockPreset(inner, { kind: 'theme', name: 'Nebula' }, 4);
  assert.equal(codes.length, 4);

  const locked = peekLocked(code);
  assert.ok(locked);
  assert.equal(locked.kind, 'theme');
  assert.equal(locked.keys.length, 4);

  // Every code must unwrap to the SAME inner preset.
  for (const c of codes) {
    const inner2 = await unlockPreset(locked, c);
    assert.equal(inner2, inner, 'each code recovers the exact inner preset');
    const env = decodePreset(inner2);
    assert.equal(env.name, 'Nebula');
    assert.equal(env.data.accent, '#7c5cff');
  }
});

test('unlock is robust to case, dashes and spacing in the entered code', async () => {
  const inner = encodePreset('theme', 'X', { accent: '#000' });
  const { code, codes } = await lockPreset(inner, { kind: 'theme', name: 'X' }, 2);
  const locked = peekLocked(code);
  const messy = ' ' + codes[0].toLowerCase().replace(/-/g, ' ') + ' ';
  assert.equal(await unlockPreset(locked, messy), inner, 'canonical form ignores case/dashes/spaces');
  assert.equal(canonCode('xn-abcd'), 'XNABCD');
});

test('unlock rejects a wrong code and an empty code', async () => {
  const inner = encodePreset('theme', 'X', { accent: '#000' });
  const { code } = await lockPreset(inner, { kind: 'theme', name: 'X' }, 3);
  const locked = peekLocked(code);
  assert.equal(await unlockPreset(locked, 'XN-0000-0000-0000'), null, 'a code that wrapped nothing fails');
  assert.equal(await unlockPreset(locked, ''), null);
  assert.equal(await unlockPreset(locked, '   '), null);
});

test('a tampered ciphertext fails authentication (returns null, never throws)', async () => {
  const inner = encodePreset('theme', 'X', { accent: '#000' });
  const { code, codes } = await lockPreset(inner, { kind: 'theme', name: 'X' }, 1);
  const env = JSON.parse(Buffer.from(code.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  // Flip a character in the encrypted payload — AES-GCM must reject it.
  env.enc.ct = (env.enc.ct[0] === 'A' ? 'B' : 'A') + env.enc.ct.slice(1);
  const tampered = Buffer.from(JSON.stringify(env), 'utf8').toString('base64url');
  const locked = peekLocked(tampered);
  assert.equal(await unlockPreset(locked, codes[0]), null);
});

test('peekLocked rejects a normal (unlocked) preset and malformed envelopes', () => {
  assert.equal(peekLocked(encodePreset('theme', 'X', { accent: '#000' })), null, 'a plain preset is not "locked"');
  assert.equal(peekLocked('garbage'), null);
  const noKeys = Buffer.from(JSON.stringify({ xenonLocked: 1, kind: 'theme', enc: { iv: 'a', ct: 'b' }, keys: [], kdf: { iterations: 1000 } }), 'utf8').toString('base64url');
  assert.equal(peekLocked(noKeys), null, 'empty keys list rejected');
  const badIter = Buffer.from(JSON.stringify({ xenonLocked: 1, kind: 'theme', enc: { iv: 'a', ct: 'b' }, keys: [{ salt: 's', iv: 'i', wrapped: 'w' }], kdf: { iterations: 0 } }), 'utf8').toString('base64url');
  assert.equal(peekLocked(badIter), null, 'non-positive iteration count rejected');
});

test('locking the raw envelope JSON (not the re-encoded code) round-trips', async () => {
  // The browser locks b64urlDecode(code) — the JSON form — to avoid double-
  // base64 inflating a font-embedded theme past MAX_CODE_BYTES. decodePreset
  // must accept the unlocked JSON directly.
  const code = encodePreset('theme', 'J', { accent: '#123456', appearance: 'dark' });
  const json = Buffer.from(code.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.equal(json[0], '{');
  const { code: bundle, codes } = await lockPreset(json, { kind: 'theme', name: 'J' }, 1);
  const got = await unlockPreset(peekLocked(bundle), codes[0]);
  assert.equal(got, json);
  assert.equal(decodePreset(got).data.accent, '#123456');
});

test('locked bundle survives the link / raw-code / JSON input forms', async () => {
  const inner = encodePreset('theme', 'Link', { accent: '#abc' });
  const { code, codes } = await lockPreset(inner, { kind: 'theme', name: 'Link' }, 1);
  const viaLink = peekLocked('http://127.0.0.1:3030/#preset=' + code);
  assert.ok(viaLink);
  assert.equal(await unlockPreset(viaLink, codes[0]), inner);
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

test('sanitize strips the imported marker — exported codes never carry provenance', () => {
  const prof = sanitizeDeckProfile(rawProfile({}, { imported: true }), DEPS);
  assert.ok(prof);
  assert.equal('imported' in prof, false);
});
