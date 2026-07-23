// Local search ranking (server/search-rank.js) — the ordering signals that
// beat the Windows search box: name-match quality tiers, recency decay, open
// frequency and folder affinity, all deterministic under an injected clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SR = require('../search-rank.js');

const NOW = new Date(2026, 6, 23, 12, 0, 0).getTime();
const DAY = 86400000;
const item = (over = {}) => ({
  path: 'C:\\Users\\u\\Documents\\file.txt', name: 'file.txt',
  dir: 'C:\\Users\\u\\Documents', mtime: NOW - DAY, size: 1000, ...over,
});

test('scoreName tiers: exact > complete word > glued prefix > substring > subsequence', () => {
  const s = (name, terms) => SR.scoreName(name, terms);
  const exact = s('contratto.pdf', ['contratto']);
  const word = s('nuovo contratto.pdf', ['contratto']);
  const wordAtStart = s('contratto-affitto.pdf', ['contratto']);
  const gluedPrefix = s('contrattofusione-report.pdf', ['contratto']);
  const sub = s('ricontrattodue.pdf', ['contratto']);
  const subseq = s('canottiera.pdf', ['ctt']);
  assert.equal(exact, 1);
  assert.equal(word, wordAtStart, 'a complete word scores the same wherever it sits');
  assert.ok(word > gluedPrefix && gluedPrefix > sub && sub > subseq && subseq > 0,
    `${word} > ${gluedPrefix} > ${sub} > ${subseq}`);
});

test('scoreName: every term must match somewhere; accents normalized', () => {
  assert.equal(SR.scoreName('contratto affitto.pdf', ['contratto', 'zebra']), 0);
  assert.ok(SR.scoreName('perché.txt', ['perche']) > 0);
  assert.ok(SR.scoreName('perche.txt', ['perché']) > 0);
});

test('scoreName: no terms is neutral (filter-only queries rank by recency)', () => {
  assert.equal(SR.scoreName('whatever.bin', []), 0.5);
});

test('rankResults: name quality dominates recency', () => {
  const out = SR.rankResults([
    item({ path: 'C:\\a\\nuovo contratto.pdf', name: 'nuovo contratto.pdf', mtime: NOW - 300 * DAY }),
    item({ path: 'C:\\b\\report.pdf', name: 'contrattofusione-report.pdf', mtime: NOW }),
  ], ['contratto'], null, NOW);
  assert.equal(out[0].name, 'nuovo contratto.pdf');
});

test('rankResults: fresher file wins at equal name quality', () => {
  const out = SR.rankResults([
    item({ path: 'C:\\a\\contratto.pdf', name: 'contratto.pdf', mtime: NOW - 400 * DAY }),
    item({ path: 'C:\\b\\contratto.pdf', name: 'contratto.pdf', mtime: NOW - DAY }),
  ], ['contratto'], null, NOW);
  assert.equal(out[0].path, 'C:\\b\\contratto.pdf');
});

test('rankResults: a frequently opened result outranks a fresher stranger', () => {
  let usage = { opens: {}, folders: {} };
  for (let i = 0; i < 8; i++) usage = SR.foldOpen(usage, 'C:\\a\\contratto.pdf', 'C:\\a', NOW - DAY);
  const out = SR.rankResults([
    item({ path: 'C:\\a\\contratto.pdf', name: 'contratto.pdf', mtime: NOW - 60 * DAY }),
    item({ path: 'C:\\b\\contratto.pdf', name: 'contratto.pdf', mtime: NOW - 30 * DAY }),
  ], ['contratto'], usage, NOW);
  assert.equal(out[0].path, 'C:\\a\\contratto.pdf');
});

test('rankResults: folder affinity nudges same-folder results up', () => {
  let usage = { opens: {}, folders: {} };
  for (let i = 0; i < 5; i++) usage = SR.foldOpen(usage, `C:\\work\\f${i}.txt`, 'C:\\work', NOW);
  const out = SR.rankResults([
    item({ path: 'C:\\other\\contratto.pdf', name: 'contratto.pdf', dir: 'C:\\other', mtime: NOW - DAY }),
    item({ path: 'C:\\work\\contratto.pdf', name: 'contratto.pdf', dir: 'C:\\work', mtime: NOW - DAY }),
  ], ['contratto'], usage, NOW);
  assert.equal(out[0].dir, 'C:\\work');
});

test('rankResults: content-only hits survive with a floor, never beat name hits', () => {
  const out = SR.rankResults([
    item({ path: 'C:\\a\\notes.docx', name: 'notes.docx', contentHit: true, mtime: NOW }),
    item({ path: 'C:\\b\\contratto.pdf', name: 'contratto.pdf', mtime: NOW - 200 * DAY }),
    item({ path: 'C:\\c\\noise.bin', name: 'noise.bin' }), // no match, no contentHit → dropped
  ], ['contratto'], null, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'contratto.pdf');
  assert.equal(out[1].name, 'notes.docx');
});

test('rankResults is deterministic: ties break by mtime then path', () => {
  const a = item({ path: 'C:\\a\\x.txt', name: 'x.txt', mtime: 5 });
  const b = item({ path: 'C:\\b\\x.txt', name: 'x.txt', mtime: 5 });
  const out1 = SR.rankResults([a, b], ['x.txt'], null, NOW).map((r) => r.path);
  const out2 = SR.rankResults([b, a], ['x.txt'], null, NOW).map((r) => r.path);
  assert.deepEqual(out1, out2);
});

test('foldOpen bounds the usage log', () => {
  let usage = { opens: {}, folders: {} };
  for (let i = 0; i < 600; i++) usage = SR.foldOpen(usage, `C:\\f\\${i}.txt`, `C:\\d${i % 300}`, NOW - (600 - i) * 1000);
  assert.ok(Object.keys(usage.opens).length <= 500);
  assert.ok(Object.keys(usage.folders).length <= 200);
  // The most recent open survived the trim.
  assert.ok(usage.opens['c:\\f\\599.txt']);
});

test('rankResults tolerates garbage items and missing usage', () => {
  const out = SR.rankResults([null, {}, item()], ['file'], undefined, NOW);
  assert.equal(out.length, 1);
});

test('zoneFactor: OS litter is noise, user folders boost, rest neutral', () => {
  const z = (d) => SR.zoneFactor(d.toLowerCase());
  assert.ok(z('c:\\windows\\prefetch') < 1);
  assert.ok(z('c:\\users\\u\\appdata\\roaming\\microsoft\\windows\\recent') < 1);
  assert.ok(z('c:\\program files\\windowsapps\\some.app_1.0\\assets') < 1);
  assert.ok(z('c:\\users\\u\\desktop\\proj\\target\\release') < 1, 'build output is noise even under Desktop');
  assert.ok(z('c:\\users\\u\\desktop\\proj\\.git\\objects') < 1, 'dot-dirs are noise even under Desktop');
  assert.ok(z('c:\\users\\u\\downloads') > 1);
  assert.ok(z('c:\\users\\u\\desktop\\marci progetti') > 1);
  const pf = z('c:\\program files (x86)\\steam\\resource\\styles');
  assert.ok(pf < 1 && pf > z('c:\\windows\\prefetch'), 'Program Files sits between noise and neutral');
  assert.equal(z('d:\\archivio\\fatture'), 1);
  assert.ok(z('c:\\users\\u\\pictures\\windows') >= 1, 'a user folder named "windows" is not OS noise');
});

test('rankResults: a user-zone word match beats OS-noise matches of any name quality', () => {
  const out = SR.rankResults([
    item({ path: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\xenon.lnk', name: 'xenon.lnk',
           dir: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Recent', mtime: NOW - DAY }),
    item({ path: 'C:\\Windows\\Prefetch\\XENON-NATIVE.EXE-D26C3B5E.pf', name: 'XENON-NATIVE.EXE-D26C3B5E.pf',
           dir: 'C:\\Windows\\Prefetch', mtime: NOW }),
    item({ path: 'C:\\Users\\u\\Downloads\\xenon-lakeside.zip', name: 'xenon-lakeside.zip',
           dir: 'C:\\Users\\u\\Downloads', mtime: NOW - 30 * DAY }),
  ], ['xenon'], null, NOW);
  assert.equal(out[0].name, 'xenon-lakeside.zip');
  assert.equal(out.length, 3, 'noise is demoted, never dropped');
});

test('rankResults: within the same zone the zone factor changes nothing', () => {
  const out = SR.rankResults([
    item({ path: 'C:\\Users\\u\\Documents\\a\\nuovo contratto.pdf', name: 'nuovo contratto.pdf',
           dir: 'C:\\Users\\u\\Documents\\a', mtime: NOW - 300 * DAY }),
    item({ path: 'C:\\Users\\u\\Documents\\b\\contrattofusione.pdf', name: 'contrattofusione.pdf',
           dir: 'C:\\Users\\u\\Documents\\b', mtime: NOW }),
  ], ['contratto'], null, NOW);
  assert.equal(out[0].name, 'nuovo contratto.pdf');
});
