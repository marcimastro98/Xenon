import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url);
const {
  encodePreset, decodePreset, lockPreset, unlockPreset, unlockWithCek, peekLocked, LOCK_FORMAT_REMOTE,
} = require('../js/preset-share.js');

// v2 "remote-locked" envelope: ciphertext + redeem target only — the content
// key is delivered by the supporter hub after a one-time code redemption
// (POST /api/community/redeem). These tests build v2 envelopes the same way
// the xenon-creator packager does and drive peekLocked/unlockWithCek on them.

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Mirror of the packager's lockInnerCodeRemote (build-preset.mjs).
async function makeRemoteLocked(innerCode, { kind = 'theme', name = 'Drop', entryId = 'july-drop' } = {}) {
  const subtle = webcrypto.subtle;
  const cek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawCek = new Uint8Array(await subtle.exportKey('raw', cek));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, cek, new TextEncoder().encode(String(innerCode))));
  const env = {
    xenonLocked: 2, kind, name, appVersion: '4.5.1', exportedAt: '',
    enc: { iv: b64(iv), ct: b64(ct) },
    redeem: { entryId },
  };
  return { code: b64url(JSON.stringify(env)), cekB64: b64(rawCek), env };
}

test('LOCK_FORMAT_REMOTE is exported as 2', () => {
  assert.equal(LOCK_FORMAT_REMOTE, 2);
});

test('peekLocked recognises a v2 envelope and exposes the redeem target', async () => {
  const inner = encodePreset('theme', 'Nebula', { accent: '#1ed760' }, {});
  const { code } = await makeRemoteLocked(inner, { entryId: 'nebula-drop', name: 'Nebula' });
  const locked = peekLocked(code);
  assert.ok(locked);
  assert.equal(locked.remote, true);
  assert.equal(locked.entryId, 'nebula-drop');
  assert.equal(locked.kind, 'theme');
  assert.equal(locked.name, 'Nebula');
  assert.ok(locked.enc && locked.enc.iv && locked.enc.ct);
  assert.equal(locked.keys, undefined, 'no offline key list on v2');
});

test('peekLocked rejects malformed v2 envelopes', async () => {
  const inner = encodePreset('theme', 'X', { accent: '#fff' }, {});
  const { env } = await makeRemoteLocked(inner);
  const mutations = [
    { ...env, redeem: undefined },                              // no redeem target
    { ...env, redeem: { entryId: 'BAD ID!' } },                 // invalid entry id
    { ...env, redeem: { entryId: '' } },
    { ...env, enc: undefined },                                 // no ciphertext
    { ...env, enc: { iv: env.enc.iv } },                        // missing ct
    { ...env, kind: 'not-a-kind' },                             // unknown kind
    { ...env, xenonLocked: 3 },                                 // unknown format
  ];
  for (const m of mutations) {
    assert.equal(peekLocked(b64url(JSON.stringify(m))), null, JSON.stringify(Object.keys(m)));
  }
});

test('unlockWithCek round-trips: hub key decrypts back to the exact inner preset', async () => {
  const data = { accent: '#ff7eb6', background: '#16101a', appearance: 'dark' };
  const inner = encodePreset('theme', 'Supporter drop · 테마', data, { appVersion: '4.5.1' });
  const { code, cekB64 } = await makeRemoteLocked(inner, { entryId: 'drop-1' });
  const locked = peekLocked(code);
  const out = await unlockWithCek(locked, cekB64);
  assert.equal(out, inner, 'byte-identical inner code');
  const env = decodePreset(out);
  assert.equal(env.kind, 'theme');
  assert.deepEqual(env.data, data);
});

test('unlockWithCek rejects a wrong or malformed key', async () => {
  const inner = encodePreset('theme', 'X', { accent: '#fff' }, {});
  const { code } = await makeRemoteLocked(inner);
  const locked = peekLocked(code);
  const wrong = b64(webcrypto.getRandomValues(new Uint8Array(32)));
  assert.equal(await unlockWithCek(locked, wrong), null, 'wrong 32-byte key fails AES-GCM auth');
  assert.equal(await unlockWithCek(locked, 'dG9vc2hvcnQ'), null, 'short key rejected');
  assert.equal(await unlockWithCek(locked, ''), null);
  assert.equal(await unlockWithCek(null, 'x'), null);
});

test('v1 offline lock path is unchanged by the v2 addition', async () => {
  const inner = encodePreset('theme', 'Legacy', { accent: '#8fb2ff' }, {});
  const { code, codes } = await lockPreset(inner, { kind: 'theme', name: 'Legacy' }, 2);
  const locked = peekLocked(code);
  assert.ok(locked);
  assert.equal(locked.remote, undefined, 'v1 result has no remote flag');
  assert.equal(locked.keys.length, 2);
  assert.equal(await unlockPreset(locked, codes[1]), inner);
  assert.equal(await unlockPreset(locked, 'XN-WRON-GCOD-E222'), null);
});

// The hub answering "too many attempts" is not the hub being unreachable: the
// import dialog must say "try again in a few minutes", not send the user off to
// debug a network that works. Every other hub error keeps its own message.
test('redeem: rate_limited gets its own message, before the offline fallback', () => {
  const src = require('node:fs').readFileSync(require.resolve('../js/preset-share.js'), 'utf8');
  const start = src.indexOf("fetch('/api/community/redeem'");
  assert.ok(start > 0, 'redeem call found');
  const chain = src.slice(start, src.indexOf('preset_redeem_offline', start));
  assert.match(chain, /err === 'rate_limited'\)\s*\{[^}]*devclean_unlock_rate/);
});

test('skipsPasteStep: a whole code goes straight to review, locked or flagged ones wait', async () => {
  const { skipsPasteStep } = require('../js/preset-share.js');
  const inner = encodePreset('theme', 'Nebula', { accent: '#1ed760' }, {});
  const { code: locked } = await makeRemoteLocked(inner);
  assert.equal(skipsPasteStep(inner, false), true);
  assert.equal(skipsPasteStep(inner, true), false, 'performance note is read first');
  assert.equal(skipsPasteStep(locked, false), false, 'a protected code asks for its unlock code');
  assert.equal(skipsPasteStep('', false), false);
  assert.equal(skipsPasteStep(undefined, false), false);
});

test('makeDraftTracker: a new draft closes the dialogs of the previous one, nothing else', () => {
  const { makeDraftTracker } = require('../js/preset-share.js');
  const drafts = makeDraftTracker();
  const closed = [];
  const dialog = (name) => { const close = () => { closed.push(name); drafts.forget(close); }; drafts.track(close); return close; };
  dialog('outside before');
  drafts.open(() => { dialog('draft 1 import'); dialog('draft 1 review'); });
  const userOwn = dialog('opened by the user after');
  assert.deepEqual(closed, [], 'opening a draft closes nothing that is not a draft');
  drafts.open(() => dialog('draft 2 review'));
  assert.deepEqual(closed, ['draft 1 import', 'draft 1 review'], 'the previous draft is replaced');
  userOwn();
  drafts.open(() => dialog('draft 3 review'));
  assert.deepEqual(closed, ['draft 1 import', 'draft 1 review', 'opened by the user after', 'draft 2 review']);
  assert.throws(() => drafts.open(() => { throw new Error('boom'); }));
  dialog('after a failed draft');
  drafts.open(() => {});
  assert.equal(closed.includes('after a failed draft'), false, 'a failed draft stops tracking');
});
