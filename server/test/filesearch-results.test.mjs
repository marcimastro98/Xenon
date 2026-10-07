// The search engine's newer half (filesearch.js + search-rank.js): answering
// without waiting for Windows Search, folders and path words, the usage pool
// with typo tolerance, app frequency, and the empty-search recents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createFileSearch } = require('../filesearch.js');
const SearchRank = require('../search-rank.js');

const NOW = new Date(2026, 6, 23, 12, 0, 0).getTime();
const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-fsearch2-'));
// A path in this platform's own spelling: filesearch.js splits real paths with
// `path`, so a Windows path in a test run on Linux would have no folders.
const P = (...parts) => path.join(path.sep === '/' ? '/' : 'C:' + path.sep, ...parts);

test('ranker: a word in a folder above counts, but one word must be in the name', () => {
  const dir = 'C:\\Users\\u\\Download';
  assert.ok(SearchRank.scoreName('fattura.pdf', ['download', 'fattura'], { dir }) > 0);
  assert.equal(SearchRank.scoreName('fattura.pdf', ['download', 'fattura']), 0, 'no dir, no path match');
  assert.equal(SearchRank.scoreName('altro.txt', ['download'], { dir }), 0, 'the path alone is not a match');
  assert.ok(SearchRank.scoreName('fattura.pdf', ['fattura'], { dir }) > SearchRank.scoreName('fattura.pdf', ['download', 'fattura'], { dir }),
    'a path word scores below a name word');
});

test('ranker: words together and in order beat the same words apart', () => {
  const together = SearchRank.scoreName('nuovo contratto.pdf', ['nuovo', 'contratto']);
  const apart = SearchRank.scoreName('contratto nuovo.pdf', ['nuovo', 'contratto']);
  assert.ok(together > apart);
});

test('ranker: a typo is tolerated only when asked, and below a real match', () => {
  const plain = SearchRank.scoreName('Spotify', ['spotfy']);
  const typo = SearchRank.scoreName('Spotify', ['spotfy'], { typos: true });
  assert.ok(typo > plain, 'a typo beats the letters-in-order reading');
  assert.ok(typo < SearchRank.scoreName('Spotify', ['spot']), 'and stays below a real match');
  assert.equal(SearchRank.scoreName('Spotify', ['xqzw'], { typos: true }), 0);
  assert.equal(SearchRank.scoreName('Spotify', ['spa'], { typos: true }), 0, 'short words get no typo slack');
  assert.ok(SearchRank.scoreName('dichiarazione-redditi.pdf', ['dichiaraizone'], { typos: true }) > 0, 'two typos in a long word');
});

test('ranker: zones also work on macOS and Linux paths', () => {
  assert.ok(SearchRank.zoneFactor('/home/u/documenti') > 1, 'a localised user folder');
  assert.ok(SearchRank.zoneFactor('/users/u/library/caches/x') < 1);
  assert.ok(SearchRank.zoneFactor('/applications/foo.app/contents') < 1);
  assert.equal(SearchRank.zoneFactor('/home/u/progetti'), 1);
});

test('search answers without waiting for Windows Search, and catalog() collects it', async () => {
  const fsr = createFileSearch({
    dataDir: tmp(),
    livingIndex: { available: () => true, query: async () => ({ items: [{ p: 'C:\\a\\report.pdf', n: 'report.pdf', s: 1, m: NOW }], dirs: [], building: false }) },
  });
  let release;
  const slow = new Promise((r) => { release = r; });
  let calls = 0;
  fsr._setHostRunner(() => { calls++; return slow; });
  const t0 = Date.now();
  const out = await fsr.search('report', { now: NOW, catalogWaitMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(out.wds, 'pending');
  assert.deepEqual(out.results.map((r) => r.name), ['report.pdf']);
  release([{ p: 'C:\\b\\report-old.docx', n: 'report-old.docx', s: 1, m: NOW - 1000 }]);
  const more = await fsr.catalog('report', { now: NOW });
  assert.equal(calls, 1, 'the follow-up shares the query already running');
  assert.equal(more.wds, 'ok');
  assert.deepEqual(more.results.map((r) => [r.name, r.source]), [['report-old.docx', 'catalog']]);
  fsr.stop();
});

test('folders come back as folder results, and path matches are marked', async () => {
  const fsr = createFileSearch({
    dataDir: tmp(),
    livingIndex: {
      available: () => true,
      query: async (q) => {
        assert.equal(q.dirs, 8, 'a plain name query asks for folders');
        assert.equal(q.pathTerms, true);
        return {
          items: [{ p: P('Users', 'u', 'Download', 'fattura.pdf'), n: 'fattura.pdf', s: 1, m: NOW, pt: 1 }],
          dirs: [{ p: P('Users', 'u', 'Download'), n: 'Download', s: 50, m: NOW, f: 9 }],
          building: false,
        };
      },
    },
  });
  fsr._setHostRunner(async () => []);
  const out = await fsr.search('download fattura', { now: NOW, catalogWaitMs: 1000 });
  const file = out.results.find((r) => r.name === 'fattura.pdf');
  assert.equal(file.kind, 'file');
  assert.equal(file.viaPath, true);
  fsr.stop();

  const one = createFileSearch({
    dataDir: tmp(),
    livingIndex: { available: () => true, query: async () => ({ items: [], dirs: [{ p: 'C:\\Fatture', n: 'Fatture', s: 50, m: NOW, f: 9 }], building: false }) },
  });
  one._setHostRunner(async () => []);
  const folders = await one.search('fatture', { now: NOW, catalogWaitMs: 1000 });
  assert.deepEqual(folders.results.map((r) => [r.name, r.kind, r.files, r.ext]), [['Fatture', 'folder', 9, '']]);
  one.stop();
});

test('a file opened before is found with a typo even when no backend returns it', async () => {
  const dataDir = tmp();
  const docs = path.join(dataDir, 'docs');
  mkdirSync(docs);
  const file = path.join(docs, 'Dichiarazione redditi 2025.pdf');
  writeFileSync(file, 'x');
  const fsr = createFileSearch({ dataDir, openExternal: async () => {} });
  fsr._setHostRunner(async (q) => (q.terms[0] === 'dichiarazione' ? [{ p: file, n: path.basename(file), s: 1, m: NOW }] : []));
  const first = await fsr.search('dichiarazione', { now: NOW });
  assert.equal((await fsr.open(first.results[0].id)).ok, true);
  const out = await fsr.search('dichiarazone', { now: NOW });
  assert.deepEqual(out.results.map((r) => r.name), ['Dichiarazione redditi 2025.pdf']);
  await fsr.stop();
});

test('recent() lists files opened from here that still exist, and their folders', async () => {
  const dataDir = tmp();
  const a = path.join(dataDir, 'a.txt');
  const b = path.join(dataDir, 'b.txt');
  writeFileSync(a, 'x'); writeFileSync(b, 'x');
  const fsr = createFileSearch({ dataDir, openExternal: async () => {} });
  fsr._setHostRunner(async (q) => [{ p: q.terms[0] === 'a' ? a : b, n: q.terms[0] + '.txt', s: 1, m: NOW }]);
  const ra = await fsr.search('a.txt', { now: NOW });
  await fsr.open(ra.results[0].id);
  const rb = await fsr.search('b.txt', { now: NOW });
  await fsr.open(rb.results[0].id);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(a);
  const out = await fsr.recent();
  assert.deepEqual(out.files.map((r) => r.name), ['b.txt'], 'a vanished file is not offered');
  assert.equal(out.folders.length, 1);
  assert.equal(out.folders[0].kind, 'folder');
  assert.match(out.files[0].id, /^r[0-9a-f]{16}$/);
  await fsr.stop();
});

test('an app launched from here comes first among equal matches', async () => {
  const apps = [{ name: 'Spotify', kind: 'lnk', target: 'C:\\s.lnk' }, { name: 'Spot Check', kind: 'lnk', target: 'C:\\c.lnk' }];
  const fsr = createFileSearch({ dataDir: tmp(), appsProvider: () => apps, launchApp: async () => {} });
  fsr._setHostRunner(async () => []);
  const before = await fsr.search('spot', { now: NOW });
  const spotify = before.apps.find((a) => a.name === 'Spotify');
  await fsr.open(spotify.id);
  await fsr.open((await fsr.search('spot', { now: NOW })).apps.find((a) => a.name === 'Spotify').id);
  const typo = await fsr.search('spotfy', { now: NOW });
  assert.deepEqual(typo.apps.map((a) => a.name), ['Spotify'], 'a typo still finds the app');
  await fsr.stop();
});

test('thumbTarget only answers raster images', async () => {
  const dataDir = tmp();
  const img = path.join(dataDir, 'shot.png');
  const doc = path.join(dataDir, 'note.html');
  writeFileSync(img, 'x'); writeFileSync(doc, 'x');
  const fsr = createFileSearch({ dataDir });
  fsr._setHostRunner(async () => [{ p: img, n: 'shot.png', s: 1, m: NOW }, { p: doc, n: 'note.html', s: 1, m: NOW }]);
  const r1 = await fsr.search('shot', { now: NOW });
  const r2 = await fsr.search('note', { now: NOW });
  assert.equal((await fsr.thumbTarget(r1.results.find((r) => r.name === 'shot.png').id)).ext, 'png');
  assert.equal(await fsr.thumbTarget(r2.results.find((r) => r.name === 'note.html').id), null);
  assert.equal(await fsr.thumbTarget('r0000000000000000'), null);
  await fsr.stop();
});
