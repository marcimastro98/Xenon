import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const sp = require('../sound-packs.js');
const ps = require('../js/preset-share.js');
const ci = require('../js/content-installs.js');
const sdk = require('../sdk-widgets.js');

// ---------------------------------------------------------------------------
// Magic-byte gate — a renamed non-audio file never lands in the sound library.
// ---------------------------------------------------------------------------

const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 0)]);
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(32, 0)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32, 0)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.alloc(24, 0)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(32, 0)]);

test('clipLooksValid accepts real formats and rejects a renamed exe', () => {
  assert.equal(sp.clipLooksValid('mp3', MP3_ID3), true);
  assert.equal(sp.clipLooksValid('mp3', MP3_FRAME), true);
  assert.equal(sp.clipLooksValid('ogg', OGG), true);
  assert.equal(sp.clipLooksValid('wav', WAV), true);
  assert.equal(sp.clipLooksValid('mp3', EXE), false);
  assert.equal(sp.clipLooksValid('ogg', EXE), false);
  assert.equal(sp.clipLooksValid('wav', EXE), false);
  assert.equal(sp.clipLooksValid('flac', OGG), false); // outside the pack allowlist
});

// ---------------------------------------------------------------------------
// validateSoundPack — payload boundary
// ---------------------------------------------------------------------------

const okPayload = (over = {}) => Object.assign({
  manifest: { id: 'stingers', name: 'Stingers', author: 'Marci', version: '1.0.0' },
  clips: [
    { id: 'airhorn', label: 'Air horn', ext: 'mp3', data: MP3_ID3.toString('base64') },
    { id: 'tada_1', ext: 'wav', data: WAV.toString('base64') },
  ],
}, over);

test('validateSoundPack accepts a clean pack and derives labels', () => {
  const v = sp.validateSoundPack(okPayload());
  assert.equal(v.ok, true);
  assert.equal(v.manifest.id, 'stingers');
  assert.equal(v.clips.length, 2);
  assert.equal(v.clips[1].label, 'tada_1');
});

test('validateSoundPack rejects bad ids, formats, caps and fake audio', () => {
  assert.equal(sp.validateSoundPack(okPayload({ manifest: { id: '../up', name: 'x' } })).error, 'bad_pack_id');
  const badExt = okPayload();
  badExt.clips[0].ext = 'flac';
  assert.equal(sp.validateSoundPack(badExt).error, 'bad_clip_ext');
  const fake = okPayload();
  fake.clips[0].data = EXE.toString('base64');
  const vFake = sp.validateSoundPack(fake);
  assert.equal(vFake.error, 'clip_rejected');
  assert.equal(vFake.clip, 'airhorn');
  const many = okPayload();
  many.clips = Array.from({ length: 25 }, (_, i) => ({ id: 'c' + i, ext: 'mp3', data: MP3_ID3.toString('base64') }));
  assert.equal(sp.validateSoundPack(many).error, 'too_many_clips');
  const fat = okPayload();
  fat.clips[0].data = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(sp.CLIP_MAX_BYTES, 0)]).toString('base64');
  assert.equal(sp.validateSoundPack(fat).error, 'clip_too_large');
});

// ---------------------------------------------------------------------------
// createSoundPacks — filesystem store + the pack-relative reference contract
// ---------------------------------------------------------------------------

test('install → list → resolve → remove; deterministic paths; traversal never resolves', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xenon-soundpacks-'));
  try {
    const store = sp.createSoundPacks({ dir });
    const r = await store.install(okPayload());
    assert.deepEqual(r, { ok: true, id: 'stingers', count: 2 });

    const packs = await store.list();
    assert.equal(packs.length, 1);
    // The clip paths ARE the contract shared Deck profiles rely on.
    assert.deepEqual(packs[0].clips.map((c) => c.path).sort(),
      ['packs/stingers/airhorn.mp3', 'packs/stingers/tada_1.wav']);

    const abs = store.resolve('packs/stingers/airhorn.mp3');
    assert.ok(abs && fs.existsSync(abs));

    // Traversal / non-pack shapes never resolve through the pack resolver.
    assert.equal(store.resolve('packs/../secrets/x.mp3'), null);
    assert.equal(store.resolve('packs/stingers/../../x.mp3'), null);
    assert.equal(store.resolve('packs/stingers/manifest.json'), null);
    assert.equal(store.resolve('C:/Windows/notepad.mp3'), null);
    assert.equal(store.resolve('packs/stingers/airhorn.mp3/..'), null);

    assert.equal(await store.remove('stingers'), true);
    assert.equal((await store.list()).length, 0);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sanitizeDeckProfile — pack-relative playSound files SURVIVE export/import;
// everything else is still blanked (the pre-pack behavior).
// ---------------------------------------------------------------------------

// Real DeckModel/DeckActions pair, same DEPS shape preset-share expects
// (mirrors preset-share-logic.test.mjs).
const DEPS = { model: require('../js/deck-model.js'), actions: require('../js/deck-actions.js') };

function profileWithSound(file) {
  return {
    name: 'Test',
    root: { pages: [{ keys: [{
      kind: 'action', title: 'Horn', icon: { type: 'emoji', value: '🔊' },
      triggers: { tap: { type: 'playSound', file, mode: 'play' } },
    }] }] },
  };
}

test('sanitizeDeckProfile keeps pack-relative playSound files and blanks the rest', () => {
  const keep = ps.sanitizeDeckProfile(profileWithSound('packs/stingers/airhorn.mp3'), DEPS);
  assert.ok(JSON.stringify(keep).includes('packs/stingers/airhorn.mp3'), 'pack ref survives');

  for (const bad of [
    'C:\\Users\\marci\\clip.mp3',
    'packs/../../etc/passwd.mp3',
    'packs/UPPER/clip.mp3',
    'packs/stingers/clip.exe',
    'packs/stingers/sub/clip.mp3',
  ]) {
    const out = ps.sanitizeDeckProfile(profileWithSound(bad), DEPS);
    assert.ok(!JSON.stringify(out).includes(bad.replace(/\\/g, '\\\\')) && !JSON.stringify(out).includes(bad), 'blanked: ' + bad);
  }
});

// ---------------------------------------------------------------------------
// SDK exposure — category present, file shape gated
// ---------------------------------------------------------------------------

test('SDK exposes the soundboard category and the pack-only file regex', () => {
  assert.deepEqual(sdk.SDK_ACTION_CATEGORIES.soundboard, ['playSound', 'soundStopAll']);
  assert.equal(sdk.SDK_SOUND_FILE_RE.test('packs/stingers/airhorn.mp3'), true);
  assert.equal(sdk.SDK_SOUND_FILE_RE.test('C:/clip.mp3'), false);
  assert.equal(sdk.SDK_SOUND_FILE_RE.test('packs/x/../y.mp3'), false);
});

test('a manifest macro playSound must reference a pack clip', () => {
  const base = {
    api: 1, name: 'W', actions: ['soundboard'],
    deck: { actions: [{ id: 'horn', name: 'Horn', steps: [{ action: { type: 'playSound', file: 'packs/stingers/airhorn.mp3', mode: 'play' } }] }] },
  };
  const ok = sdk.normalizeManifest(base, 'w0');
  assert.equal(ok.ok, true, 'pack-relative macro accepted');
  assert.equal(ok.manifest.deck.actions.length, 1);

  const bad = JSON.parse(JSON.stringify(base));
  bad.deck.actions[0].steps[0].action.file = 'C:/Users/x/loud.mp3';
  assert.equal(sdk.normalizeManifest(bad, 'w0').ok, false, 'local-path macro rejected at install');
});

// ---------------------------------------------------------------------------
// Receipts + envelope round-trip
// ---------------------------------------------------------------------------

test('content-install receipts normalize and count soundPackIds', () => {
  const [record] = ci.normalizeContentInstalls([{
    id: 'xi_m5abc123deadbeef',
    name: 'Stingers',
    kind: 'sounds',
    installedAt: 1,
    resources: { soundPackIds: ['stingers', 'stingers', 'BAD ID'] },
  }]);
  assert.equal(record.kind, 'sounds');
  assert.deepEqual(record.resources.soundPackIds, ['stingers']);
  assert.equal(ci.resourceCount({ soundPackIds: ['a-pack'] }), 1);
});

test('preset envelope round-trips the sounds kind', () => {
  const code = ps.encodePreset('sounds', 'Stingers', okPayload(), {});
  const env = ps.decodePreset(code);
  assert.ok(env);
  assert.equal(env.kind, 'sounds');
  assert.equal(env.data.clips.length, 2);
});
