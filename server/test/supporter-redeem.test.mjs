import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const redeemMod = require('../supporter-redeem.js');

// Local proxy for the supporter hub: input shape-gating, install-id
// persistence, and the error whitelist that keeps hub responses from leaking
// arbitrary strings into client toasts. The transport is injected — no network.

const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-redeem-'));
const GOOD = { entryId: 'july-drop', code: 'XS-ABCD-EFGH-JKLM' };

function withTransport(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    finally { redeemMod._setTransport(null); redeemMod._resetInstallIdCache(); }
  };
}

test('installId: generated once, persisted, and reused', withTransport(async () => {
  const dir = tmp();
  const id1 = await redeemMod.getInstallId(dir);
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'install-id.json'), 'utf8'));
  assert.equal(onDisk.installId, id1);
  redeemMod._resetInstallIdCache();
  const id2 = await redeemMod.getInstallId(dir);
  assert.equal(id2, id1, 'reloaded from disk, not regenerated');
}));

test('scoped ids: one install, two values, neither of them the install id', withTransport(async () => {
  const dir = tmp();
  const raw = await redeemMod.getInstallId(dir);
  const device = await redeemMod.getScopedId(dir, redeemMod.SCOPE_DEVICES);
  const voter = await redeemMod.getScopedId(dir, redeemMod.SCOPE_RATINGS);

  assert.match(device, /^[0-9a-f]{64}$/);
  assert.match(voter, /^[0-9a-f]{64}$/);
  // The whole point: the hub stores these in two tables, and they must not be
  // the same value, or a supporter's activations name the votes they cast.
  assert.notEqual(device, voter);
  assert.notEqual(device, raw);
  assert.notEqual(voter, raw);

  // Stable across calls, and derived from the id on disk (not the cache), so an
  // upgraded install keeps its vote and its device slot.
  redeemMod._resetInstallIdCache();
  assert.equal(await redeemMod.getScopedId(dir, redeemMod.SCOPE_DEVICES), device);

  const { createHash } = await import('node:crypto');
  assert.equal(device, createHash('sha256').update(raw.toLowerCase() + '|activations').digest('hex'));
  assert.equal(voter, createHash('sha256').update(raw.toLowerCase() + '|ratings').digest('hex'));
}));

test('installId: corrupt file is replaced, not fatal', withTransport(async () => {
  const dir = tmp();
  const file = path.join(dir, 'install-id.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, 'not json at all', 'utf8');
  const id = await redeemMod.getInstallId(dir);
  assert.match(id, /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).installId, id);
}));

test('redeem: shape gate rejects bad entryId / code before any network', withTransport(async () => {
  let called = 0;
  redeemMod._setTransport(async () => { called++; return { ok: true, cek: 'x' }; });
  const dir = tmp();
  for (const body of [
    { entryId: 'BAD ID', code: GOOD.code },
    { entryId: '', code: GOOD.code },
    { entryId: GOOD.entryId, code: 'XN-ABCD-EFGH-JKLM' }, // offline code, not a hub code
    { entryId: GOOD.entryId, code: 'XS-SHORT' },
    { entryId: GOOD.entryId, code: '' },
  ]) {
    const out = await redeemMod.redeem({ ...body, dataDir: dir });
    assert.deepEqual(out, { ok: false, error: 'bad_request' });
  }
  assert.equal(called, 0, 'transport never reached');
  assert.ok(!existsSync(path.join(dir, 'install-id.json')), 'no id minted for rejected input');
}));

test('redeem: XL item codes pass the shape gate like XS supporter codes', withTransport(async () => {
  const dir = tmp();
  let seen = null;
  redeemMod._setTransport(async (url, body) => { seen = body; return { ok: true, cek: 'Q0VLLWJhc2U2NA==', name: 'Limited' }; });
  const out = await redeemMod.redeem({ entryId: GOOD.entryId, code: 'xl-abcd efgh_jklm', dataDir: dir });
  assert.equal(out.ok, true);
  assert.equal(seen.code, 'XLABCDEFGHJKLM', 'canonical XL form travels');
}));

test('redeem: happy path forwards canonical code + device id and passes the cek through', withTransport(async () => {
  const dir = tmp();
  let seen = null;
  redeemMod._setTransport(async (url, body) => {
    seen = { url, body };
    return { ok: true, cek: 'Q0VLLWJhc2U2NA==', name: 'July Drop', extra: 'dropped' };
  });
  const out = await redeemMod.redeem({ entryId: GOOD.entryId, code: 'xs-abcd efgh_jklm', dataDir: dir });
  assert.equal(out.ok, true);
  assert.equal(out.cek, 'Q0VLLWJhc2U2NA==');
  assert.equal(out.name, 'July Drop');
  assert.equal(out.extra, undefined, 'response is rebuilt, not spread');
  assert.equal(seen.url, redeemMod.HUB_BASE + '/redeem');
  assert.equal(seen.body.code, 'XSABCDEFGHJKLM', 'canonical form travels');
  assert.equal(seen.body.entryId, GOOD.entryId);
  assert.match(seen.body.scopedId, /^[0-9a-f]{64}$/);
  assert.equal(seen.body.installId, undefined, 'the raw install id never leaves this machine');
}));

test('redeem: whitelisted errors pass through, unknown ones map to network', withTransport(async () => {
  const dir = tmp();
  for (const err of ['bad_code', 'bad_entry', 'expired', 'limit', 'rate_limited', 'bad_request', 'wrong_code']) {
    redeemMod._setTransport(async () => ({ ok: false, error: err }));
    assert.deepEqual(await redeemMod.redeem({ ...GOOD, dataDir: dir }), { ok: false, error: err });
  }
  for (const weird of [{ ok: false, error: 'internal <script>' }, { ok: false }, null, undefined, { ok: true }, { ok: true, cek: '' }]) {
    redeemMod._setTransport(async () => weird);
    assert.deepEqual(await redeemMod.redeem({ ...GOOD, dataDir: dir }), { ok: false, error: 'network' });
  }
}));

test('saved pass: an XS code is remembered after it works, and reused when the field is empty', withTransport(async () => {
  const dir = tmp();
  let seen = null;
  redeemMod._setTransport(async (url, body) => { seen = body; return { ok: true, cek: 'Q0VL', name: 'July' }; });

  assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: false });

  const first = await redeemMod.redeem({ ...GOOD, dataDir: dir });
  assert.equal(first.ok, true);
  assert.equal(first.saved, true, 'the client is told it was remembered');
  assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: true });
  // Canonical form on disk, and the file holds nothing else about the user.
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, 'supporter-code.json'), 'utf8')),
    { code: 'XSABCDEFGHJKLM' },
  );

  // Second drop, empty code: the pass comes off disk and travels canonicalised.
  seen = null;
  const second = await redeemMod.redeem({ entryId: 'august-drop', code: '', dataDir: dir });
  assert.equal(second.ok, true);
  assert.equal(second.saved, false, 'nothing new was learned');
  assert.equal(seen.code, 'XSABCDEFGHJKLM');
  assert.equal(seen.entryId, 'august-drop');
}));

test('saved pass: XL item codes are never remembered', withTransport(async () => {
  const dir = tmp();
  redeemMod._setTransport(async () => ({ ok: true, cek: 'Q0VL' }));
  const out = await redeemMod.redeem({ entryId: GOOD.entryId, code: 'XL-ABCD-EFGH-JKLM', dataDir: dir });
  assert.equal(out.ok, true);
  assert.equal(out.saved, false);
  // An XL code opens exactly one drop: reusing it elsewhere would answer
  // 'wrong_code' at a user who typed nothing.
  assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: false });
  assert.ok(!existsSync(path.join(dir, 'supporter-code.json')));
}));

test('saved pass: a failed redeem is not remembered', withTransport(async () => {
  const dir = tmp();
  redeemMod._setTransport(async () => ({ ok: false, error: 'expired' }));
  assert.deepEqual(await redeemMod.redeem({ ...GOOD, dataDir: dir }), { ok: false, error: 'expired' });
  assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: false });
}));

test('saved pass: forget removes it, and forgetting nothing still succeeds', withTransport(async () => {
  const dir = tmp();
  redeemMod._setTransport(async () => ({ ok: true, cek: 'Q0VL' }));
  await redeemMod.redeem({ ...GOOD, dataDir: dir });
  assert.deepEqual(await redeemMod.forgetCode(dir), { ok: true, saved: false });
  assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: false });
  assert.deepEqual(await redeemMod.forgetCode(dir), { ok: true, saved: false }, 'idempotent');
}));

test('saved pass: a code typed in Settings is stored on shape alone', withTransport(async () => {
  const dir = tmp();
  assert.deepEqual(await redeemMod.saveTypedCode(dir, 'xs-abcd efgh_jklm'), { ok: true, saved: true });
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, 'supporter-code.json'), 'utf8')),
    { code: 'XSABCDEFGHJKLM' },
    'canonicalised on the way in, so the field is forgiving about spacing',
  );
  // Whether it WORKS is a question only the hub answers, and it answers it
  // against a specific entry — there is nothing to check against here.
  for (const bad of ['', 'XS-SHORT', 'XL-ABCD-EFGH-JKLM', 'nonsense', null, undefined]) {
    assert.deepEqual(await redeemMod.saveTypedCode(tmp(), bad), { ok: false, error: 'bad_code' }, String(bad));
  }
}));

test('saved pass: bad_code from the hub drops it, the other errors keep it', withTransport(async () => {
  // A reissue hub-side deactivates the previous code, so a saved pass that had
  // already worked and now answers bad_code is dead, not mistyped.
  const dir = tmp();
  await redeemMod.saveTypedCode(dir, GOOD.code);
  redeemMod._setTransport(async () => ({ ok: false, error: 'bad_code' }));
  assert.deepEqual(
    await redeemMod.redeem({ entryId: GOOD.entryId, code: '', dataDir: dir }),
    { ok: false, error: 'bad_code', forgot: true },
  );
  assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: false });

  // 'expired' above all must NOT clear it: the hub extends the SAME code on
  // renewal, so the saved pass comes back to life on its own.
  for (const err of ['expired', 'limit', 'wrong_code', 'rate_limited', 'network']) {
    const d = tmp();
    await redeemMod.saveTypedCode(d, GOOD.code);
    redeemMod._setTransport(async () => ({ ok: false, error: err }));
    const out = await redeemMod.redeem({ entryId: GOOD.entryId, code: '', dataDir: d });
    assert.equal(out.forgot, undefined, err);
    assert.deepEqual(await redeemMod.savedStatus(d), { ok: true, saved: true }, err + ' kept the pass');
  }
}));

test('saved pass: a TYPED code that answers bad_code never touches the saved one', withTransport(async () => {
  const dir = tmp();
  await redeemMod.saveTypedCode(dir, GOOD.code);
  redeemMod._setTransport(async () => ({ ok: false, error: 'bad_code' }));
  // Someone pasting a wrong code for one drop must not lose the pass that works.
  const out = await redeemMod.redeem({ entryId: GOOD.entryId, code: 'XS-ZZZZ-ZZZZ-ZZZZ', dataDir: dir });
  assert.deepEqual(out, { ok: false, error: 'bad_code' });
  assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: true });
}));

test('saved pass: an empty code with nothing saved is still bad_request, with no network', withTransport(async () => {
  const dir = tmp();
  let called = 0;
  redeemMod._setTransport(async () => { called++; return { ok: true, cek: 'x' }; });
  assert.deepEqual(
    await redeemMod.redeem({ entryId: GOOD.entryId, code: '', dataDir: dir }),
    { ok: false, error: 'bad_request' },
  );
  assert.equal(called, 0);
}));

test('saved pass: a corrupt or tampered store reads as "nothing saved"', withTransport(async () => {
  const dir = tmp();
  const file = path.join(dir, 'supporter-code.json');
  const { writeFileSync } = await import('node:fs');
  for (const junk of ['not json', '{"code":"nope"}', '{"code":"XL-ABCD-EFGH-JKLM"}', '{}']) {
    writeFileSync(file, junk, 'utf8');
    assert.deepEqual(await redeemMod.savedStatus(dir), { ok: true, saved: false }, junk);
    let called = 0;
    redeemMod._setTransport(async () => { called++; return { ok: true, cek: 'x' }; });
    assert.deepEqual(
      await redeemMod.redeem({ entryId: GOOD.entryId, code: '', dataDir: dir }),
      { ok: false, error: 'bad_request' },
    );
    assert.equal(called, 0, 'a junk store never reaches the hub');
  }
}));

test('redeem: transport rejection maps to network, never throws', withTransport(async () => {
  const dir = tmp();
  redeemMod._setTransport(async () => { throw new Error('boom'); });
  const out = await redeemMod.redeem({ ...GOOD, dataDir: dir }).catch(() => 'threw');
  assert.notEqual(out, 'threw', 'redeem must not throw');
  assert.deepEqual(out, { ok: false, error: 'network' });
}));
