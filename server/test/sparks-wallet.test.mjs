import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const redeemMod = require('../supporter-redeem.js');
const wallet = require('../sparks-wallet.js');

// Buying a drop with Sparks through the local proxy: which code pays, what is
// remembered, what is forgotten, and that only known hub errors reach the UI.
// The hub transport is injected: no network.

const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-sparks-'));
const PASS = 'XS-ABCD-EFGH-JKLM';
const SPARKS = 'XC-ABCD-EFGH-JKLM';
const walletFile = (dir) => path.join(dir, 'sparks-code.json');

// Records every hub call; `answers` maps a hub path to its answer (or a function of the body).
function hub(answers) {
  const calls = [];
  redeemMod._setTransport(async (url, body) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, body });
    const a = answers[p];
    return typeof a === 'function' ? a(body) : (a || { ok: false, error: 'not_found' });
  });
  return calls;
}
const reset = () => { redeemMod._setTransport(null); redeemMod._resetInstallIdCache(); };
const run = (fn) => async () => { try { await fn(); } finally { reset(); } };

test('nothing to pay with: no hub call, and a malformed code or entry is refused locally', run(async () => {
  const dir = tmp();
  const calls = hub({});
  assert.deepEqual(await wallet.buy({ entryId: 'pack', dataDir: dir }), { ok: false, error: 'no_code' });
  assert.equal((await wallet.buy({ entryId: 'pack', code: 'XL-ABCD-EFGH-JKLM', dataDir: dir })).error, 'bad_request');
  assert.equal((await wallet.buy({ entryId: '../x', code: SPARKS, dataDir: dir })).error, 'bad_request');
  assert.equal(calls.length, 0);
}));

test('owned asks the hub with the saved code, and any doubt is a no', run(async () => {
  const dir = tmp();
  assert.deepEqual(await wallet.owned({ entryId: '../x', dataDir: dir }), { ok: false, error: 'bad_request' });
  const none = hub({ '/owned': { ok: true, owned: true } });
  assert.deepEqual(await wallet.owned({ entryId: 'pack', dataDir: dir }), { ok: true, owned: false });
  assert.equal(none.length, 0, 'no saved code, no hub call');
  await wallet.saveTypedWalletCode(dir, SPARKS);
  const calls = hub({ '/owned': { ok: true, owned: true } });
  assert.deepEqual(await wallet.owned({ entryId: 'pack', dataDir: dir }), { ok: true, owned: true });
  assert.deepEqual(calls[0].body, { entryId: 'pack', code: SPARKS.replace(/-/g, '') });
  hub({});
  assert.deepEqual(await wallet.owned({ entryId: 'pack', dataDir: dir }), { ok: true, owned: false });
  redeemMod._setTransport(async () => { throw new Error('down'); });
  assert.deepEqual(await wallet.owned({ entryId: 'pack', dataDir: dir }), { ok: true, owned: false });
}));

test('a typed Sparks code buys, is remembered, and the next buy uses it without typing', run(async () => {
  const dir = tmp();
  const calls = hub({ '/buy': { ok: true, cek: 'k'.repeat(43), name: 'Pack', bought: true, balance: 380 } });
  const out = await wallet.buy({ entryId: 'pack', code: SPARKS, kv: 2, dataDir: dir });
  assert.deepEqual(out, { ok: true, cek: 'k'.repeat(43), name: 'Pack', bought: true, balance: 380, emailed: false });
  assert.equal(calls[0].body.code, 'XCABCDEFGHJKLM');
  assert.equal(calls[0].body.kv, 2);
  assert.match(calls[0].body.scopedId, /^[0-9a-f]{64}$/);
  assert.equal(await wallet.readWalletCode(dir), 'XCABCDEFGHJKLM');
  assert.deepEqual(await wallet.walletStatus(dir), { ok: true, pass: false, wallet: true, canBuy: true });
  await wallet.buy({ entryId: 'pack-2', dataDir: dir });
  assert.equal(calls[1].body.code, 'XCABCDEFGHJKLM');
}));

test('a refused buy remembers nothing, and only the known errors pass, with balance and price', run(async () => {
  const dir = tmp();
  hub({ '/buy': { ok: false, error: 'no_sparks', balance: 40, price: 150, secret: 'x' } });
  assert.deepEqual(await wallet.buy({ entryId: 'pack', code: SPARKS, dataDir: dir }), { ok: false, error: 'no_sparks', balance: 40, price: 150 });
  assert.equal(existsSync(walletFile(dir)), false);
  hub({ '/buy': { ok: false, error: 'something <b>odd</b>' } });
  assert.equal((await wallet.buy({ entryId: 'pack', code: SPARKS, dataDir: dir })).error, 'network');
  hub({ '/buy': { ok: false, error: 'included' } });
  assert.equal((await wallet.buy({ entryId: 'pack', code: SPARKS, dataDir: dir })).error, 'included');
}));

test('the ticked box reaches the hub by version, and a hub that wants it says so', run(async () => {
  const dir = tmp();
  const calls = hub({ '/buy': { ok: false, error: 'consent_required' } });
  assert.equal((await wallet.buy({ entryId: 'pack', code: SPARKS, consent: 'item-2026-11', dataDir: dir })).error, 'consent_required');
  assert.equal(calls[0].body.consent, 'item-2026-11');
  // What is not a version stays here, and the hub then refuses the sale.
  for (const bad of ['Item 2026', 'x'.repeat(41), 7, null, undefined]) {
    await wallet.buy({ entryId: 'pack', code: SPARKS, consent: bad, dataDir: dir });
    assert.equal('consent' in calls.at(-1).body, false, String(bad));
  }
}));

test('a remembered Sparks code the hub no longer knows is forgotten; one that is short of Sparks is kept', run(async () => {
  const dir = tmp();
  await wallet.saveTypedWalletCode(dir, SPARKS);
  hub({ '/buy': { ok: false, error: 'no_sparks', balance: 0, price: 100 } });
  await wallet.buy({ entryId: 'pack', dataDir: dir });
  assert.equal(existsSync(walletFile(dir)), true);
  hub({ '/buy': { ok: false, error: 'bad_code' } });
  await wallet.buy({ entryId: 'pack', dataDir: dir });
  assert.equal(existsSync(walletFile(dir)), false);
}));

test('the app promises an email only when the hub says one went out', run(async () => {
  const dir = tmp();
  const sold = { ok: true, cek: 'k'.repeat(43), name: 'Pack', bought: true, balance: 380 };
  hub({ '/buy': { ...sold, emailed: true } });
  assert.equal((await wallet.buy({ entryId: 'pack', code: SPARKS, dataDir: dir })).emailed, true);
  hub({ '/buy': { ...sold, emailed: 'yes' } });
  assert.equal((await wallet.buy({ entryId: 'pack', code: SPARKS, dataDir: dir })).emailed, false);
}));

test('with a pass and a Sparks code, the Sparks code moves onto the pass once, then the pass pays', run(async () => {
  const dir = tmp();
  await redeemMod.saveTypedCode(dir, PASS);
  const calls = hub({
    '/wallet/merge': { ok: true },
    '/buy': { ok: true, cek: 'c'.repeat(43), name: 'Pack', bought: true, balance: 10 },
  });
  const saved = await wallet.saveTypedWalletCode(dir, SPARKS);
  assert.deepEqual(saved, { ok: true, saved: true });
  assert.deepEqual(calls[0], { path: '/wallet/merge', body: { code: 'XSABCDEFGHJKLM', walletCode: 'XCABCDEFGHJKLM' } });
  assert.equal(existsSync(walletFile(dir)), false, 'the Sparks code is forgotten after the move');
  await wallet.buy({ entryId: 'pack', dataDir: dir });
  assert.equal(calls.at(-1).path, '/buy');
  assert.equal(calls.at(-1).body.code, 'XSABCDEFGHJKLM');
}));

test('a failed move keeps the Sparks code unless the hub says the Sparks code is the dead one', run(async () => {
  const dir = tmp();
  await redeemMod.saveTypedCode(dir, PASS);
  hub({ '/wallet/merge': { ok: false, error: 'bad_code', which: 'pass' } });
  await wallet.saveTypedWalletCode(dir, SPARKS);
  assert.equal(existsSync(walletFile(dir)), true, 'a dead pass never costs the Sparks');
  hub({ '/wallet/merge': async () => { throw new Error('offline'); } });
  assert.equal((await wallet.mergeIfBoth(dir)).error, 'network');
  assert.equal(existsSync(walletFile(dir)), true);
  hub({ '/wallet/merge': { ok: false, error: 'bad_code', which: 'wallet' } });
  await wallet.mergeIfBoth(dir);
  assert.equal(existsSync(walletFile(dir)), false);
}));

test('the Sparks code is saved by shape only and has a reset path', run(async () => {
  const dir = tmp();
  hub({});
  assert.equal((await wallet.saveTypedWalletCode(dir, PASS)).error, 'bad_code');
  assert.deepEqual(await wallet.saveTypedWalletCode(dir, ' xc-abcd-efgh-jklm '), { ok: true, saved: true });
  assert.deepEqual(await wallet.forgetWalletCode(dir), { ok: true, saved: false });
  assert.deepEqual(await wallet.forgetWalletCode(dir), { ok: true, saved: false }, 'twice is fine');
  assert.deepEqual(await wallet.walletStatus(dir), { ok: true, pass: false, wallet: false, canBuy: false });
}));

test('a dead pass does not hide the Sparks code beside it: the purchase goes through on the code', run(async () => {
  const dir = tmp();
  const calls = hub({
    '/wallet/merge': { ok: false, error: 'bad_code', which: 'pass' },
    '/buy': (body) => (body.code.startsWith('XC')
      ? { ok: true, cek: 'k', name: 'Pack', bought: true, balance: 300 }
      : { ok: false, error: 'bad_code' }),
  });
  await redeemMod.saveTypedCode(dir, PASS);
  await wallet.saveTypedWalletCode(dir, SPARKS);
  const out = await wallet.buy({ entryId: 'pack', dataDir: dir });
  assert.equal(out.ok, true);
  assert.deepEqual(calls.filter((c) => c.path === '/buy').map((c) => c.body.code.slice(0, 2)), ['XS', 'XC']);
  assert.ok(await wallet.readWalletCode(dir), 'the code that paid is kept');
}));

test('a typed pass the hub refuses is the buyer\'s answer: no silent payment with the saved Sparks code', run(async () => {
  const dir = tmp();
  await wallet.saveTypedWalletCode(dir, SPARKS);
  const calls = hub({ '/buy': { ok: false, error: 'bad_code' } });
  assert.equal((await wallet.buy({ entryId: 'pack', code: PASS, dataDir: dir })).error, 'bad_code');
  assert.equal(calls.filter((c) => c.path === '/buy').length, 1);
}));

test('the copy number the hub gives a bought copy reaches the dashboard, and junk never does', run(async () => {
  const dir = tmp();
  const sold = { ok: true, cek: 'k'.repeat(43), name: 'Pack', bought: true, balance: 380 };
  hub({ '/buy': { ...sold, copyNo: 42 } });
  assert.equal((await wallet.buy({ entryId: 'pack', code: SPARKS, dataDir: dir })).copyNo, 42);
  for (const junk of [0, -1, 1.5, '42', 1e7, null]) {
    hub({ '/buy': { ...sold, copyNo: junk } });
    assert.equal('copyNo' in (await wallet.buy({ entryId: 'pack', code: SPARKS, dataDir: dir })), false, String(junk));
  }
}));
