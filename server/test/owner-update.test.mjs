import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url);
const redeemMod = require('../supporter-redeem.js');
const { ownedUpdateOutcome, encodePreset } = require('../js/preset-share.js');
const ra = require('../remote-access.js');

// The owner update: "I already unlocked this on this install, is there a newer
// version, and may I have its key?" Two halves tested here with nothing but
// injected transports and real envelopes:
//   - the local proxy (supporter-redeem.js update): what it sends, what it lets
//     through, that nothing is ever written to disk;
//   - what the browser does with the answer (ownedUpdateOutcome): the key must
//     open a file made for the entry that was asked about.

const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-update-'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

function withTransport(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    finally { redeemMod._setTransport(null); redeemMod._resetInstallIdCache(); }
  };
}

// A sealed v2 file for `entryId` under a fresh key; mirrors the packager.
async function seal(entryId, { kv, kind = 'theme' } = {}) {
  const subtle = webcrypto.subtle;
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const raw = new Uint8Array(await subtle.exportKey('raw', key));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const inner = encodePreset(kind, 'Pack', { accent: '#5865f2' }, {});
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(inner)));
  const env = {
    xenonLocked: 2, kind, name: 'Pack', appVersion: '4.11.11', exportedAt: '',
    enc: { iv: b64(iv), ct: b64(ct) },
    redeem: kv ? { entryId, kv } : { entryId },
  };
  return { code: b64url(JSON.stringify(env)), cek: b64(raw), inner };
}

// ── the proxy ────────────────────────────────────────────────────────────────

test('update sends the entry, the HASHED device id and the versions, never a code', withTransport(async () => {
  const dir = tmp();
  const sent = [];
  redeemMod._setTransport(async (url, body, max) => { sent.push({ url, body, max }); return { ok: true, upToDate: true }; });
  const out = await redeemMod.update({ entryId: 'vanguard-50-01', have: '3.0.0', kv: 2, dataDir: dir });
  assert.deepEqual(out, { ok: true, upToDate: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, redeemMod.HUB_BASE + '/update');
  const device = await redeemMod.getScopedId(dir, redeemMod.SCOPE_DEVICES);
  assert.deepEqual(sent[0].body, { entryId: 'vanguard-50-01', scopedId: device, have: '3.0.0', kv: 2 });
  assert.ok(!('code' in sent[0].body), 'no code of any kind');
  const raw = await redeemMod.getInstallId(dir);
  assert.ok(!JSON.stringify(sent[0].body).includes(raw), 'the raw install id never leaves the PC');
  assert.ok(sent[0].max > 2 * 1024 * 1024, 'room for a private bundle in the answer');
}));

test('update drops a malformed version or key version instead of forwarding it', withTransport(async () => {
  const sent = [];
  redeemMod._setTransport(async (_url, body) => { sent.push(body); return { ok: true, upToDate: true }; });
  await redeemMod.update({ entryId: 'pack-a', have: '1.0-beta; DROP', kv: 'two', dataDir: tmp() });
  await redeemMod.update({ entryId: 'pack-a', have: '1.0.0', kv: 0, dataDir: tmp() });
  await redeemMod.update({ entryId: 'pack-a', kv: 5000, dataDir: tmp() });
  for (const body of sent) {
    assert.ok(!('kv' in body));
  }
  assert.ok(!('have' in sent[0]));
  assert.equal(sent[1].have, '1.0.0');
}));

test('update refuses a malformed entry id before any network', withTransport(async () => {
  let called = false;
  redeemMod._setTransport(async () => { called = true; return {}; });
  for (const entryId of ['', 'BAD ID', '../x', null, undefined, 'a'.repeat(80)]) {
    assert.deepEqual(await redeemMod.update({ entryId, dataDir: tmp() }), { ok: false, error: 'bad_request' });
  }
  assert.equal(called, false);
}));

test('update lets a complete answer through, bounded, and nothing the hub did not promise', withTransport(async () => {
  redeemMod._setTransport(async () => ({
    ok: true, version: '3.1.0', kv: 2, cek: 'KEY', changelog: 'x'.repeat(500), name: 'N'.repeat(500),
    bundle: 'BUNDLE', extra: '<script>', admin: true,
  }));
  const out = await redeemMod.update({ entryId: 'pack-a', have: '3.0.0', dataDir: tmp() });
  assert.deepEqual(Object.keys(out).sort(), ['bundle', 'cek', 'changelog', 'kv', 'name', 'ok', 'version']);
  assert.equal(out.changelog.length, 300);
  assert.equal(out.name.length, 120);
  assert.equal(out.bundle, 'BUNDLE');
}));

test('update never lets an oversized bundle through, and rejects an answer that is not complete', withTransport(async () => {
  redeemMod._setTransport(async () => ({ ok: true, version: '3.1.0', kv: 2, cek: 'KEY', bundle: 'x'.repeat(3 * 1024 * 1024) }));
  const big = await redeemMod.update({ entryId: 'pack-a', dataDir: tmp() });
  assert.equal(big.ok, true);
  assert.equal(big.bundle, undefined, 'dropped, not truncated');

  for (const answer of [
    { ok: true, cek: 'KEY' },                                        // no version
    { ok: true, cek: 'KEY', version: 'v3', kv: 2 },                  // version is not dotted digits
    { ok: true, cek: 'KEY', version: '3.1.0', kv: 0 },               // key version out of range
    { ok: true, version: '3.1.0', kv: 2 },                           // no key
    { ok: true },
    null,
    'text',
  ]) {
    redeemMod._setTransport(async () => answer);
    const out = await redeemMod.update({ entryId: 'pack-a', dataDir: tmp() });
    assert.deepEqual(out, { ok: false, error: 'network' }, JSON.stringify(answer));
  }
}));

test('update passes the hub refusals the app knows, and turns anything else into network', withTransport(async () => {
  for (const error of ['not_owner', 'bad_entry', 'rate_limited', 'bad_request', 'unavailable']) {
    redeemMod._setTransport(async () => ({ ok: false, error }));
    assert.deepEqual(await redeemMod.update({ entryId: 'pack-a', dataDir: tmp() }), { ok: false, error });
  }
  for (const error of ['internal', '<img src=x>', 'bad_code', undefined]) {
    redeemMod._setTransport(async () => ({ ok: false, error }));
    assert.deepEqual(await redeemMod.update({ entryId: 'pack-a', dataDir: tmp() }), { ok: false, error: 'network' });
  }
  redeemMod._setTransport(async () => { throw new Error('boom'); });
  assert.deepEqual(await redeemMod.update({ entryId: 'pack-a', dataDir: tmp() }), { ok: false, error: 'network' });
}));

test('the key and the file an update returns are never written to disk', withTransport(async () => {
  const dir = tmp();
  redeemMod._setTransport(async () => ({ ok: true, version: '3.1.0', kv: 2, cek: 'SECRET-KEY-VALUE', bundle: 'SECRET-BUNDLE-VALUE' }));
  await redeemMod.update({ entryId: 'pack-a', dataDir: dir });
  for (const f of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!text.includes('SECRET-KEY-VALUE') && !text.includes('SECRET-BUNDLE-VALUE'), f);
  }
}));

test('redeem forwards the key version the file names, and ignores a junk one', withTransport(async () => {
  const sent = [];
  redeemMod._setTransport(async (_url, body) => { sent.push(body); return { ok: false, error: 'bad_code' }; });
  const code = 'XS-ABCD-EFGH-JKLM';
  await redeemMod.redeem({ entryId: 'pack-a', code, kv: 3, dataDir: tmp() });
  await redeemMod.redeem({ entryId: 'pack-a', code, kv: 'x', dataDir: tmp() });
  await redeemMod.redeem({ entryId: 'pack-a', code, dataDir: tmp() });
  assert.equal(sent[0].kv, 3);
  assert.ok(!('kv' in sent[1]) && !('kv' in sent[2]));
}));

// ── what the browser does with the answer ────────────────────────────────────

test('an owner answer for a PUBLIC file opens the new version without any code', async () => {
  const { code, cek, inner } = await seal('pack-a', { kv: 2 });
  const out = await ownedUpdateOutcome('pack-a', code, { ok: true, cek, version: '1.1.0', kv: 2 });
  assert.deepEqual(out, { kind: 'open', inner, version: '1.1.0' });
});

test('an owner answer for a PRIVATE (limited) copy uses the bundle in the answer, not the file we hold', async () => {
  const { code: bundle, cek, inner } = await seal('vanguard-50-01', { kv: 2 });
  const out = await ownedUpdateOutcome('vanguard-50-01', '', { ok: true, cek, version: '3.1.0', kv: 2, bundle });
  assert.equal(out.kind, 'open');
  assert.equal(out.inner, inner);
});

test('a key never opens a file made for a different entry', async () => {
  const mine = await seal('pack-a');
  const other = await seal('pack-b');
  // The hub (or anything in between) hands back pack-b's file with pack-a's key — or the reverse.
  assert.deepEqual(
    await ownedUpdateOutcome('pack-a', '', { ok: true, cek: mine.cek, version: '1.1.0', kv: 2, bundle: other.code }),
    { kind: 'unreadable' },
  );
  assert.deepEqual(
    await ownedUpdateOutcome('pack-a', other.code, { ok: true, cek: other.cek, version: '1.1.0', kv: 2 }),
    { kind: 'unreadable' },
    'the right key for the wrong entry is still refused',
  );
});

test('a wrong key, a missing file and a file that is not locked are all unreadable, never an exception', async () => {
  const { code } = await seal('pack-a');
  const wrongKey = b64(new Uint8Array(32).fill(9));
  assert.deepEqual(await ownedUpdateOutcome('pack-a', code, { ok: true, cek: wrongKey, version: '1.0.1', kv: 2 }), { kind: 'unreadable' });
  assert.deepEqual(await ownedUpdateOutcome('pack-a', '', { ok: true, cek: wrongKey, version: '1.0.1', kv: 2 }), { kind: 'unreadable' });
  assert.deepEqual(await ownedUpdateOutcome('pack-a', 'not a code', { ok: true, cek: wrongKey, version: '1.0.1', kv: 2 }), { kind: 'unreadable' });
});

test('up to date, not an owner and no answer are three different outcomes', async () => {
  assert.deepEqual(await ownedUpdateOutcome('pack-a', 'x', { ok: true, upToDate: true }), { kind: 'current' });
  assert.deepEqual(await ownedUpdateOutcome('pack-a', 'x', { ok: false, error: 'not_owner' }), { kind: 'not_linked' });
  assert.deepEqual(await ownedUpdateOutcome('pack-a', 'x', { ok: false, error: 'rate_limited' }), { kind: 'not_linked' });
  assert.deepEqual(await ownedUpdateOutcome('pack-a', 'x', { ok: false, error: 'network' }), { kind: 'offline' });
  assert.deepEqual(await ownedUpdateOutcome('pack-a', 'x', null), { kind: 'offline' });
  assert.deepEqual(await ownedUpdateOutcome('pack-a', 'x', 'garbage'), { kind: 'offline' });
});

// ── a file with no key version is sealed under the FIRST key ────────────────

test('the unlock dialog asks for key version 1 when the file names none', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/preset-share.js', import.meta.url), 'utf8');
  // Sent nothing, the hub answers with its LATEST key, which stops opening the
  // original download the day a newer version is published.
  assert.match(src, /JSON\.stringify\(\{ entryId: locked\.entryId, code: unlockField\.value, kv: locked\.kv \|\| 1 \}\)/);
});

test('peekLocked reports no key version for a file that predates versions, and the named one otherwise', async () => {
  const old = await seal('pack-a');
  const newer = await seal('pack-a', { kv: 3 });
  assert.equal(require('../js/preset-share.js').peekLocked(old.code).kv, null);
  assert.equal(require('../js/preset-share.js').peekLocked(newer.code).kv, 3);
});

// ── the paired-device door ───────────────────────────────────────────────────

test('a paired phone can update what it owns by POST, and a navigation (GET) cannot', () => {
  assert.equal(ra.remotePathAllowed('/api/community/update', 'POST'), true);
  assert.equal(ra.remotePathAllowed('/api/community/update', 'GET'), false);
  assert.equal(ra.remotePathAllowed('/api/community/update', 'HEAD'), false);
});
