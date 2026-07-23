// Local file search orchestrator (server/filesearch.js) — merge of the two
// backends, the opaque-id contract (paths travel out, never in), the openFile
// blocklist on open, and the usage-log persistence. The Windows Search host
// is replaced by an injected runner: no PowerShell in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createFileSearch } = require('../filesearch.js');

const NOW = new Date(2026, 6, 23, 12, 0, 0).getTime();
const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-fsearch-'));

function make(hostItems, opts = {}) {
  const dataDir = tmp();
  const opened = [];
  const fsr = createFileSearch({
    dataDir,
    openExternal: async (p) => { opened.push(p); },
    ...opts,
  });
  fsr._setHostRunner(async () => hostItems);
  return { fsr, dataDir, opened };
}

test('search: merges backends, ranks, and returns opaque ids with paths as display only', async () => {
  const dataDir = tmp();
  // The Living Index answers one matching file.
  const livingIndex = {
    available: () => true,
    query: async () => ({ items: [{ p: 'D:\\Archivio\\contratto-vecchio.pdf', n: 'contratto-vecchio.pdf', s: 500, m: NOW - 86400000 * 400 }], building: false }),
  };
  const fsr = createFileSearch({ dataDir, livingIndex, openExternal: async () => {} });
  fsr._setHostRunner(async (q) => {
    assert.deepEqual(q.terms, ['contratto']);
    assert.equal(q.content, true);
    return [{ p: 'C:\\Users\\u\\Documents\\contratto.pdf', n: 'contratto.pdf', s: 1000, m: NOW - 86400000 }];
  });
  const out = await fsr.search('contratto', { now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.wds, 'ok');
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].name, 'contratto.pdf', 'fresher exact-word match first');
  for (const r of out.results) {
    assert.match(r.id, /^r[0-9a-f]{16}$/);
    assert.equal(typeof r.path, 'string');
  }
  fsr.stop();
});

test('search: no filters at all returns inert result, host never called', async () => {
  let called = 0;
  const { fsr } = make([]);
  fsr._setHostRunner(async () => { called++; return []; });
  const out = await fsr.search('   ', { now: NOW });
  assert.deepEqual(out.results, []);
  assert.equal(called, 0);
  fsr.stop();
});

test('search: wds_unavailable is a recognizable state, Living-Index results still flow', async () => {
  const dataDir = tmp();
  const livingIndex = {
    available: () => true,
    query: async () => ({ items: [{ p: 'D:\\foto\\mare.jpg', n: 'mare.jpg', s: 100, m: NOW }], building: false }),
  };
  const fsr = createFileSearch({ dataDir, livingIndex, openExternal: async () => {} });
  fsr._setHostRunner(async () => { throw new Error('wds_unavailable'); });
  const out = await fsr.search('mare', { now: NOW });
  assert.equal(out.wds, 'unavailable');
  assert.equal(out.index, 'ready');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].name, 'mare.jpg');
  fsr.stop();
});

test('search: kind filter reaches the host as concrete extensions', async () => {
  const { fsr } = make([]);
  let seen = null;
  fsr._setHostRunner(async (q) => { seen = q; return []; });
  await fsr.search('foto mare', { now: NOW });
  assert.ok(seen.exts.includes('jpg') && seen.exts.includes('png'));
  fsr.stop();
});

test('open: resolves the id, opens, and records usage atomically', async () => {
  const dataDir = tmp();
  const real = path.join(dataDir, 'nota.txt');
  writeFileSync(real, 'x');
  const opened = [];
  const fsr = createFileSearch({ dataDir, openExternal: async (p) => { opened.push(p); } });
  fsr._setHostRunner(async () => [{ p: real, n: 'nota.txt', s: 1, m: NOW }]);
  const out = await fsr.search('nota', { now: NOW });
  const res = await fsr.open(out.results[0].id);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(opened, [real]);
  // Usage flushes on stop() and next search ranks it via frequency.
  await fsr.stop();
  const usage = JSON.parse(readFileSync(path.join(dataDir, 'search-usage.json'), 'utf8'));
  assert.equal(usage.opens[real.toLowerCase()].n, 1);
});

test('open: unknown ids and raw paths refuse — the id cache is the only resolver', async () => {
  const { fsr } = make([]);
  assert.deepEqual(await fsr.open('rdeadbeefdeadbeef'), { ok: false, error: 'unknown_id' });
  assert.deepEqual(await fsr.open('C:\\Windows\\System32\\cmd.exe'), { ok: false, error: 'unknown_id' });
  assert.deepEqual(await fsr.open(''), { ok: false, error: 'unknown_id' });
  fsr.stop();
});

test('open: executable results refuse with revealable, openExternal never called', async () => {
  const dataDir = tmp();
  const exe = path.join(dataDir, 'setup.exe');
  writeFileSync(exe, 'MZ');
  const opened = [];
  const fsr = createFileSearch({ dataDir, openExternal: async (p) => { opened.push(p); } });
  fsr._setHostRunner(async () => [{ p: exe, n: 'setup.exe', s: 2, m: NOW }]);
  const out = await fsr.search('setup', { now: NOW });
  const res = await fsr.open(out.results[0].id);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'blocked_ext');
  assert.equal(res.revealable, true);
  assert.deepEqual(opened, [], 'nothing was launched');
  fsr.stop();
});

test('open: a result deleted after the search refuses cleanly', async () => {
  const dataDir = tmp();
  const gone = path.join(dataDir, 'temp.txt');
  writeFileSync(gone, 'x');
  const fsr = createFileSearch({ dataDir, openExternal: async () => {} });
  fsr._setHostRunner(async () => [{ p: gone, n: 'temp.txt', s: 1, m: NOW }]);
  const out = await fsr.search('temp', { now: NOW });
  const { rmSync } = await import('node:fs');
  rmSync(gone);
  assert.deepEqual(await fsr.open(out.results[0].id), { ok: false, error: 'not_found' });
  fsr.stop();
});

test('result-id cache is bounded', async () => {
  const { fsr } = make(Array.from({ length: 60 }, (_, i) => ({ p: `C:\\x\\f${i}-nota.txt`, n: `f${i}-nota.txt`, s: 1, m: NOW })));
  for (let i = 0; i < 25; i++) await fsr.search('nota', { now: NOW, max: 60 });
  assert.ok(fsr._resultsCacheSize() <= 1000);
  fsr.stop();
});

test('chip disable is honored end to end', async () => {
  const { fsr } = make([]);
  let seen = null;
  fsr._setHostRunner(async (q) => { seen = q; return []; });
  const out = await fsr.search('foto di dicembre', { now: NOW, disable: { date: true } });
  assert.equal(seen.after, null);
  assert.deepEqual(seen.terms, ['dicembre']);
  assert.ok(!out.chips.some((c) => c.type === 'date'));
  fsr.stop();
});

test('a corrupt usage file or a throwing Living Index never breaks a search', async () => {
  const dataDir = tmp();
  writeFileSync(path.join(dataDir, 'search-usage.json'), '{{{{');
  const fsr = createFileSearch({ dataDir, openExternal: async () => {} });
  fsr._setHostRunner(async () => [{ p: 'C:\\x\\nota.txt', n: 'nota.txt', s: 1, m: NOW }]);
  const out = await fsr.search('nota', { now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1);
  fsr.stop();
});

test('applications tier: name-matching apps pinned, launched via launchApp, never revealed', async () => {
  const launched = [];
  const { fsr } = make([], {
    appsProvider: async () => [
      { name: 'WhatsApp', kind: 'store', target: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
      { name: 'Steam', kind: 'lnk', target: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Steam.lnk' },
    ],
    launchApp: async (rec) => { launched.push(rec.kind + ':' + rec.target); },
  });
  const out = await fsr.search('whatsapp', { now: NOW });
  assert.equal(out.apps.length, 1);
  assert.equal(out.apps[0].name, 'WhatsApp');
  const opened = await fsr.open(out.apps[0].id);
  assert.equal(opened.ok, true);
  assert.equal(launched.length, 1);
  assert.match(launched[0], /^store:/);
  // Reveal makes no sense for an app entry — refused like an unknown id.
  const rev = await fsr.reveal(out.apps[0].id);
  assert.equal(rev.ok, false);
  // The icon endpoint sees the app shape, never a filesystem path.
  const t = fsr.iconTarget(out.apps[0].id);
  assert.equal(t.app, true);
  assert.equal(t.kind, 'store');
  // A kind-filtered query is about FILES: the apps tier stays out.
  const out2 = await fsr.search('foto whatsapp', { now: NOW });
  assert.equal((out2.apps || []).length, 0);
  fsr.stop();
});

test('searchStructured: validates untrusted AI output at the boundary, then runs the engine', async () => {
  const { fsr } = make([]);
  let seen = null;
  fsr._setHostRunner(async (q) => {
    seen = q;
    return [{ p: 'C:\\Users\\u\\Documents\\contratto.pdf', n: 'contratto.pdf', s: 1000, m: NOW }];
  });
  const out = await fsr.searchStructured({
    terms: ['contratto', 42, '  x  '],   // non-string and too-short entries drop
    kind: 'document',
    exts: null,
    after: '2026-01-01',
    before: '2026-02-01',
    minBytes: 'lots',                    // garbage drops to null, never throws
    maxBytes: -5,
    unknownField: 'ignored',
  }, { now: NOW });
  assert.equal(out.ok, true);
  assert.deepEqual(seen.terms, ['contratto']);
  assert.ok(seen.exts.includes('pdf'), 'kind resolved to its extension set');
  assert.equal(seen.after, new Date(2026, 0, 1).getTime(), 'YYYY-MM-DD is local midnight');
  assert.equal(seen.before, new Date(2026, 1, 1).getTime() + 86400000, 'a date-string before means through that day');
  assert.equal(seen.minBytes, null);
  assert.equal(seen.maxBytes, null);
  assert.ok(out.chips.some((c) => c.type === 'kind' && c.kind === 'document'));
  assert.ok(out.chips.some((c) => c.type === 'date' && c.key === 'range'));
  assert.deepEqual(out.terms, ['contratto'], 'the surviving terms travel back for highlighting');
  assert.equal(out.results.length, 1);
  assert.equal((out.apps || []).length, 0, 'a kind filter keeps the apps tier out');
  fsr.stop();
});

test('searchStructured: app:true forces the Applications tier past an exts filter', async () => {
  const { fsr } = make([], {
    appsProvider: async () => [{ name: 'Xenon', kind: 'lnk', target: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Xenon.lnk' }],
    launchApp: async () => {},
  });
  // "the executable of the xenon app": exts would normally read as
  // files-only, but the AI marked it as an application request.
  const out = await fsr.searchStructured({ terms: ['xenon'], exts: ['exe'], app: true }, { now: NOW });
  assert.equal(out.apps.length, 1);
  assert.equal(out.apps[0].name, 'Xenon');
  // Anything other than boolean true never flips the tier on.
  const out2 = await fsr.searchStructured({ terms: ['xenon'], exts: ['exe'], app: 'yes' }, { now: NOW });
  assert.equal((out2.apps || []).length, 0);
  fsr.stop();
});

test('searchStructured: garbage specs are inert, host never called', async () => {
  let called = 0;
  const { fsr } = make([]);
  fsr._setHostRunner(async () => { called++; return []; });
  for (const spec of ['not an object', null, [], { kind: 'nonsense', exts: [123, '.!!'], terms: 'string-not-array' }]) {
    const out = await fsr.searchStructured(spec, { now: NOW });
    assert.equal(out.ok, true);
    assert.deepEqual(out.results, []);
  }
  assert.equal(called, 0);
  fsr.stop();
});

test('iconTarget: resolves only known opaque ids, exposing path + ext read-only', async () => {
  const { fsr } = make([
    { p: 'C:\\Program Files (x86)\\Steam\\steam.exe', n: 'steam.exe', s: 5_500_000, m: NOW },
    { p: 'C:\\Users\\u\\Documents\\nota.txt', n: 'nota.txt', s: 100, m: NOW },
  ]);
  const out = await fsr.search('steam', { now: NOW });
  assert.equal(out.results[0].name, 'steam.exe', 'name match above the content hit');
  const t = fsr.iconTarget(out.results[0].id);
  assert.equal(t.path, 'C:\\Program Files (x86)\\Steam\\steam.exe');
  assert.equal(t.ext, 'exe');
  assert.equal(fsr.iconTarget('r0000000000000000'), null);
  assert.equal(fsr.iconTarget(undefined), null);
  fsr.stop();
});
