import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { webcrypto, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createTrialVault, decryptEnvelope, stubInner } = require('../trial-vault.js');

// The trial vault keeps trial widgets out of DATA_DIR in plaintext and serves
// them only while the trial runs. These tests seal a drop exactly as the hub's
// publisher does (WebCrypto AES-GCM, tag at the end) and play the trial state.

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const SECRET = 'SECRET-WIDGET-SOURCE-1234';
const widget = (id) => ({
  id, name: 'Wall Plate', version: '1.0.0',
  payload: { id, files: [
    { path: 'manifest.json', data: b64(JSON.stringify({ api: 1, name: 'Wall Plate', version: '1.0.0', entry: 'index.html' })) },
    { path: 'index.html', data: b64('<!doctype html><body>' + SECRET) },
    { path: 'img/a.png', data: b64('png-bytes') },
  ] },
});

async function seal(preset) {
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const inner = Buffer.from(JSON.stringify(preset), 'utf8').toString('base64url');
  const key = await webcrypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(inner)));
  return { enc: { iv: iv.toString('base64'), ct: ct.toString('base64') }, cek: cek.toString('base64') };
}
const singleWidget = (id = 'wall-plate') => ({ xenonPreset: 1, kind: 'widget', name: 'Wall Plate', data: widget(id) });

function setup({ state = 'active', cek = '', redeemAnswer = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-vault-'));
  const t = { dir, state, redeems: [], installs: [], changes: 0 };
  t.make = () => createTrialVault({
    dataDir: dir,
    trialPass: { status: async () => ({ state: t.state }) },
    redeem: async (opts) => { t.redeems.push(opts); return redeemAnswer || { ok: true, cek: t.cek || cek }; },
    installPayload: async (payload, catalogVersion) => { t.installs.push({ payload, catalogVersion }); return { ok: true }; },
    onChange: () => { t.changes++; },
  });
  t.vault = t.make();
  return t;
}
const vaultFiles = (dir) => (existsSync(path.join(dir, 'trial-vault')) ? readdirSync(path.join(dir, 'trial-vault')) : []);

test('decryptEnvelope opens a WebCrypto-sealed drop and refuses a wrong key', async () => {
  const s = await seal(singleWidget());
  assert.ok(decryptEnvelope(s.enc, s.cek));
  assert.equal(decryptEnvelope(s.enc, randomBytes(32).toString('base64')), null);
  assert.equal(decryptEnvelope(s.enc, 'short'), null);
  assert.equal(decryptEnvelope({ iv: s.enc.iv, ct: 'AAAA' }, s.cek), null);
});

test('stubInner keeps the preset and replaces every package with a vault marker', () => {
  const inner = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'bundle', data: { widgets: [widget('one-w'), widget('two-w')], theme: { a: 1 } } })).toString('base64url');
  const out = JSON.parse(Buffer.from(stubInner(inner), 'base64url').toString('utf8'));
  assert.deepEqual(out.data.widgets.map((w) => w.payload), [{ trialVault: true, id: 'one-w' }, { trialVault: true, id: 'two-w' }]);
  assert.deepEqual(out.data.theme, { a: 1 });
  assert.ok(!JSON.stringify(out).includes(b64('<!doctype html><body>' + SECRET)));
});

test('open keeps ciphertext only on disk and hands back markers, not files', async () => {
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek });
  const r = await t.vault.open({ entryId: 'wall-plate', kv: 2, enc: s.enc, cek: s.cek });
  assert.equal(r.ok, true);
  assert.ok(!Buffer.from(r.inner, 'base64url').toString('utf8').includes(b64('<!doctype html><body>' + SECRET)));
  const files = vaultFiles(t.dir);
  assert.deepEqual(files, ['wall-plate.json']);
  const onDisk = readFileSync(path.join(t.dir, 'trial-vault', files[0]), 'utf8');
  assert.ok(!onDisk.includes(SECRET) && !onDisk.includes(b64('<!doctype html><body>' + SECRET)));
  assert.ok(!onDisk.includes(s.cek), 'the key is never written');
  // Not listed until the import flow confirms it.
  assert.deepEqual(await t.vault.packages(), []);
  assert.equal(t.vault.has('wall-plate'), false);
});

test('an accepted package is listed and served while the trial runs, and not after', async () => {
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek });
  await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  const a = await t.vault.accept('wall-plate');
  assert.equal(a.ok, true);
  assert.equal(t.vault.has('wall-plate'), true);
  assert.deepEqual((await t.vault.packages()).map((p) => p.id), ['wall-plate']);
  const html = await t.vault.asset('wall-plate', 'index.html');
  assert.ok(html.bytes.toString('utf8').includes(SECRET));
  assert.match(html.mime, /^text\/html/);
  assert.equal(await t.vault.asset('wall-plate', '../x.html'), null);
  assert.equal(await t.vault.asset('wall-plate', 'nope.html'), null);
  for (const state of ['ended', 'unverified', 'none']) {
    t.state = state;
    assert.equal(await t.vault.asset('wall-plate', 'index.html'), null, state);
    assert.deepEqual(await t.vault.packages(), [], state);
  }
});

test('accept refuses an unknown id or a trial that is not running', async () => {
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek });
  await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  assert.equal((await t.vault.accept('other-w')).ok, false);
  t.state = 'ended';
  assert.equal((await t.vault.accept('wall-plate')).ok, false);
});

test('after a restart the key comes from the hub through the trial, never from disk', async () => {
  const s = await seal(singleWidget());
  const t = setup();
  t.cek = s.cek;
  await t.vault.open({ entryId: 'wall-plate', kv: 3, enc: s.enc, cek: s.cek });
  await t.vault.accept('wall-plate');
  const fresh = t.make();
  await fresh.init();
  assert.equal(fresh.has('wall-plate'), true);
  await fresh.sync();
  assert.deepEqual(t.redeems.at(-1), { entryId: 'wall-plate', kv: 3, viaTrial: true });
  assert.ok((await fresh.asset('wall-plate', 'index.html')).bytes.toString('utf8').includes(SECRET));
});

test('the end of the trial deletes the vault', async () => {
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek });
  await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  await t.vault.accept('wall-plate');
  t.state = 'ended';
  await t.vault.sync();
  assert.deepEqual(vaultFiles(t.dir), []);
  assert.equal(t.vault.has('wall-plate'), false);
  assert.ok(t.changes > 0);
});

test('a conversion redeems with the pass and installs what was in use for good', async () => {
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek });
  await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek, catalogVersion: '1.0.2' });
  await t.vault.accept('wall-plate');
  t.state = 'converted';
  // Still served until it is installed: the user is a supporter now.
  assert.ok(await t.vault.asset('wall-plate', 'index.html'));
  await t.vault.sync();
  assert.deepEqual(t.redeems.at(-1), { entryId: 'wall-plate', kv: 1 });
  assert.equal(t.installs.length, 1);
  assert.equal(t.installs[0].payload.id, 'wall-plate');
  assert.equal(t.installs[0].catalogVersion, '1.0.2');
  assert.deepEqual(vaultFiles(t.dir), []);
});

test('a conversion keeps the record on a network failure and drops it on a final refusal', async () => {
  const s = await seal(singleWidget());
  const net = setup({ cek: s.cek, redeemAnswer: { ok: false, error: 'network' } });
  await net.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  await net.vault.accept('wall-plate');
  net.state = 'converted';
  await net.vault.sync();
  assert.deepEqual(vaultFiles(net.dir), ['wall-plate.json']);

  const fin = setup({ cek: s.cek, redeemAnswer: { ok: false, error: 'expired' } });
  await fin.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  fin.state = 'converted';
  await fin.vault.sync();
  assert.deepEqual(vaultFiles(fin.dir), []);
  assert.equal(fin.installs.length, 0);
});

test('removing a trial package unlists it; the last one deletes the record', async () => {
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek });
  await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  await t.vault.accept('wall-plate');
  await t.vault.remove('wall-plate');
  assert.equal(t.vault.has('wall-plate'), false);
  assert.deepEqual(vaultFiles(t.dir), []);
});

test('a drop without widgets writes nothing and still returns its inner code', async () => {
  const s = await seal({ xenonPreset: 1, kind: 'theme', name: 'T', data: { accent: '#fff' } });
  const t = setup({ cek: s.cek });
  const r = await t.vault.open({ entryId: 'theme-x', kv: 1, enc: s.enc, cek: s.cek });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(Buffer.from(r.inner, 'base64url').toString('utf8')).data.accent, '#fff');
  assert.deepEqual(vaultFiles(t.dir), []);
});

test('server wiring: trial packages are served from memory, the key never reaches the page', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /if \(r && r\.ok && r\.trial === true\) \{\s+const \{ cek, trial, \.\.\.answer \} = r;/);
  assert.match(src, /trialVault\.asset\(m\[1\], m\[2\]\)/);
  assert.match(src, /if \(!rec && trialVault\.has\(id\)\) return 'trial';/);
  assert.match(src, /allowTrial: false/);
  const client = readFileSync(new URL('../js/preset-share.js', import.meta.url), 'utf8');
  assert.match(client, /w\.payload\.trialVault === true/);
  assert.match(client, /enc: locked\.enc/);
});

test('a refused key never loops: a dead drop is dropped, a busy hub waits for the retry gap', async () => {
  const s = await seal(singleWidget());
  for (const [error, kept] of [['bad_entry', false], ['rate_limited', true]]) {
    const t = setup({ redeemAnswer: { ok: false, error } });
    await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
    await t.vault.accept('wall-plate');
    const fresh = t.make();
    await fresh.init();
    // A refusal makes the trial check the hub, which syncs the vault again.
    await fresh.sync(); await fresh.sync(); await fresh.sync();
    assert.equal(t.redeems.length, 1, error);
    assert.deepEqual(vaultFiles(t.dir), kept ? ['wall-plate.json'] : [], error);
  }
});

test('a conversion that failed is retried by the next request for its files; a full device limit keeps the copy', async () => {
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek, redeemAnswer: { ok: false, error: 'limit' } });
  await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  await t.vault.accept('wall-plate');
  t.state = 'converted';
  await t.vault.sync();
  assert.deepEqual(vaultFiles(t.dir), ['wall-plate.json']);
  const fresh = t.make();
  await fresh.init();
  t.redeems.length = 0;
  await fresh.asset('wall-plate', 'index.html');
  assert.deepEqual(t.redeems, [{ entryId: 'wall-plate', kv: 1 }]);
  await fresh.asset('wall-plate', 'index.html');
  assert.equal(t.redeems.length, 1, 'not more often than the retry gap');
});

test('odd drops: a bundle with a broken and a duplicate widget, a deck and a canvas scene', async () => {
  const broken = { id: 'broken-w', payload: { id: 'broken-w', files: [{ path: 'index.html', data: b64('x') }] } };
  const presets = [
    { xenonPreset: 1, kind: 'bundle', data: { widgets: [widget('one-w'), broken, widget('one-w'), null, 'junk'], theme: { a: 1 } } },
    { xenonPreset: 1, kind: 'deck', data: { profile: {}, widgets: [widget('deck-w')] } },
    { xenonPreset: 1, kind: 'ambient-layout', data: { layout: {}, widgets: [widget('scene-w')] } },
  ];
  const t = setup();
  for (const [i, p] of presets.entries()) {
    const s = await seal(p);
    const r = await t.vault.open({ entryId: 'drop-' + i, kv: 1, enc: s.enc, cek: s.cek });
    assert.equal(r.ok, true, p.kind);
    const out = JSON.parse(Buffer.from(r.inner, 'base64url').toString('utf8'));
    for (const w of out.data.widgets.filter((x) => x && typeof x === 'object')) {
      assert.ok(w.payload === null || (w.payload.trialVault === true && !w.payload.files), p.kind);
    }
  }
  assert.equal((await t.vault.accept('one-w')).ok, true);
  assert.equal((await t.vault.accept('broken-w')).ok, false, 'a package that does not validate is never opened');
  assert.equal((await t.vault.accept('deck-w')).ok, true);
  assert.equal((await t.vault.accept('scene-w')).ok, true);
  assert.deepEqual((await t.vault.packages()).map((p) => p.id).sort(), ['deck-w', 'one-w', 'scene-w']);
});

test('odd requests: no locked content, garbage content, a preset that is not one', async () => {
  const t = setup();
  const good = await seal(singleWidget());
  assert.deepEqual(await t.vault.open({ entryId: 'x', kv: 1, enc: undefined, cek: good.cek }), { ok: false, error: 'bad_request' });
  assert.deepEqual(await t.vault.open({ entryId: 'x', kv: 1, enc: 'str', cek: good.cek }), { ok: false, error: 'bad_request' });
  assert.deepEqual(await t.vault.open({ entryId: 'x', kv: 1, enc: { iv: 1, ct: [] }, cek: good.cek }), { ok: false, error: 'bad_request' });
  const notPreset = await seal({ hello: 'world' });
  assert.deepEqual(await t.vault.open({ entryId: 'x', kv: 1, enc: notPreset.enc, cek: notPreset.cek }), { ok: false, error: 'bad_request' });
  assert.deepEqual(vaultFiles(t.dir), []);
});

test('damaged vault files on disk unlock nothing, crash nothing, and go at the end', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const s = await seal(singleWidget());
  const t = setup({ cek: s.cek });
  await t.vault.open({ entryId: 'wall-plate', kv: 1, enc: s.enc, cek: s.cek });
  await t.vault.accept('wall-plate');
  const vd = path.join(t.dir, 'trial-vault');
  mkdirSync(vd, { recursive: true });
  writeFileSync(path.join(vd, 'garbage.json'), '{not json');
  writeFileSync(path.join(vd, 'other.json'), JSON.stringify({ entryId: 'wall-plate', enc: s.enc, widgets: [] }));
  writeFileSync(path.join(vd, 'evil.json'), JSON.stringify({ entryId: 'evil', enc: { iv: '../..', ct: s.enc.ct }, widgets: [{ id: 'x-x', accepted: true }] }));
  const fresh = t.make();
  await fresh.init();
  assert.equal(fresh.has('wall-plate'), true);
  assert.equal(fresh.has('x-x'), false);
  t.state = 'ended';
  await fresh.sync();
  assert.deepEqual(vaultFiles(t.dir), [], 'the whole vault folder goes, damaged files included');
});
