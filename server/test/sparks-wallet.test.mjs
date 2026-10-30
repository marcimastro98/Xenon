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

test('a typed Sparks code buys, is remembered, and the next buy uses it without typing', run(async () => {
  const dir = tmp();
  const calls = hub({ '/buy': { ok: true, cek: 'k'.repeat(43), name: 'Pack', bought: true, balance: 380 } });
  const out = await wallet.buy({ entryId: 'pack', code: SPARKS, kv: 2, dataDir: dir });
  assert.deepEqual(out, { ok: true, cek: 'k'.repeat(43), name: 'Pack', bought: true, balance: 380 });
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
