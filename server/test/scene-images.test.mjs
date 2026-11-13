// Scene pictures live in files of their own instead of inside settings.json,
// and come back inside the scene for a backup and a share code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const si = require('../scene-images.js');
const SERVER = engineSource();
const SHARE = fs.readFileSync(new URL('../js/preset-share.js', import.meta.url), 'utf8');

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const png = (n = 40000, seed = 'a') => 'data:image/png;base64,' + Buffer.concat([PNG_HEAD, crypto.createHash('sha512').update(seed).digest(), Buffer.alloc(n, seed)]).toString('base64');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-sceneimg-'));
const scene = (bg, pic) => ({ id: 's1', name: 'Mine', bg: { type: 'image', url: bg }, components: [{ type: 'image', props: { url: pic, fit: 'cover' } }, { type: 'clock', props: {} }] });

test('large pictures leave the scene for a file, the scene keeps the path', async () => {
  const up = dir();
  const input = [scene(png(), png(50000, 'b'))];
  const r = await si.externalize(input, up);
  assert.equal(r.changed, true);
  assert.match(r.scenes[0].bg.url, /^\/uploads\/sceneimg-[a-f0-9]{32}\.png$/);
  assert.match(r.scenes[0].components[0].props.url, /^\/uploads\/sceneimg-[a-f0-9]{32}\.png$/);
  assert.notEqual(r.scenes[0].bg.url, r.scenes[0].components[0].props.url);
  assert.match(input[0].bg.url, /^data:/, 'the input is not changed in place');
  const file = path.join(up, r.scenes[0].bg.url.slice('/uploads/'.length));
  assert.equal('data:image/png;base64,' + fs.readFileSync(file).toString('base64'), png());
  assert.ok(JSON.stringify(r.scenes).length < 1000, 'the scene is now a few hundred characters');
});

test('the same picture is one file, and a second pass changes nothing', async () => {
  const up = dir();
  const r = await si.externalize([scene(png(), png())], up);
  assert.equal(r.scenes[0].bg.url, r.scenes[0].components[0].props.url);
  assert.equal(fs.readdirSync(up).length, 1);
  const again = await si.externalize(r.scenes, up);
  assert.equal(again.changed, false);
  assert.equal(again.scenes, r.scenes);
});

test('small pictures, SVG and bytes that are not what they claim stay inside the scene', async () => {
  const up = dir();
  const svg = 'data:image/svg+xml;base64,' + Buffer.alloc(40000, '<svg>').toString('base64');
  const fake = 'data:image/png;base64,' + Buffer.alloc(40000, 'not a png').toString('base64');
  const tiny = png(100);
  const r = await si.externalize([scene(svg, fake), { id: 's2', bg: { type: 'image', url: tiny }, components: [] }], up);
  assert.equal(r.changed, false);
  assert.equal(r.scenes[0].bg.url, svg, 'an SVG served from Xenon\'s own address could run script');
  assert.equal(r.scenes[0].components[0].props.url, fake);
  assert.equal(r.scenes[1].bg.url, tiny);
  assert.deepEqual(fs.readdirSync(up), []);
});

test('a backup carries the pictures inside the scenes again', async () => {
  const up = dir();
  const original = [scene(png(), png(50000, 'b'))];
  const { scenes } = await si.externalize(original, up);
  const back = await si.inlineForBackup(scenes, up);
  assert.deepEqual(back, original);
  // A missing file keeps its path, which the scene schema accepts.
  fs.rmSync(path.join(up, scenes[0].bg.url.slice('/uploads/'.length)));
  const partial = await si.inlineForBackup(scenes, up);
  assert.equal(partial[0].bg.url, scenes[0].bg.url);
  assert.equal(partial[0].components[0].props.url, original[0].components[0].props.url);
});

test('a picture no scene uses is swept only when no daily copy names it either', async () => {
  const up = dir();
  const { scenes } = await si.externalize([scene(png(), png(50000, 'b'))], up);
  const keep = scenes[0].bg.url.slice('/uploads/'.length);
  const drop = scenes[0].components[0].props.url.slice('/uploads/'.length);
  fs.writeFileSync(path.join(up, 'tileasset-1.png'), 'x');          // not ours to sweep
  const still = [{ ...scenes[0], components: [] }];
  si._resetSweepClock();
  assert.deepEqual(await si.sweepUnused(up, still, { now: Date.now() + 1 * 86_400_000 }), [], 'kept for a day, before the day\'s copy names it');
  si._resetSweepClock();
  assert.deepEqual(await si.sweepUnused(up, still, { now: Date.now() + 3 * 86_400_000 }), [drop]);
  assert.deepEqual(fs.readdirSync(up).sort(), [keep, 'tileasset-1.png'].sort());
});

test('a picture named by a daily copy of settings is kept, however old it is', async () => {
  const up = dir();
  const snapDir = dir();
  const { scenes } = await si.externalize([scene(png(), png(50000, 'b'))], up);
  const name = scenes[0].bg.url.slice('/uploads/'.length);
  fs.writeFileSync(path.join(snapDir, 'settings-2026-11-01.json'), JSON.stringify({ ambientScenes: scenes }));
  si._resetSweepClock();
  const removed = await si.sweepUnused(up, [], { now: Date.now() + 365 * 86_400_000, snapshotsDir: snapDir });
  assert.ok(!removed.includes(name), 'putting back that copy finds its picture');
  assert.ok(fs.existsSync(path.join(up, name)));
});

test('a backup carries the pictures up to the size scenes could always hold, never more', async () => {
  const up = dir();
  const original = [scene(png(), png(50000, 'b'))];
  const { scenes } = await si.externalize(original, up);
  const room = png().length + 10;
  const back = await si.inlineForBackup(scenes, up, { maxChars: room });
  assert.equal(back[0].bg.url, original[0].bg.url, 'the first fits');
  assert.equal(back[0].components[0].props.url, scenes[0].components[0].props.url, 'the second keeps its path');
  assert.equal(si.BACKUP_INLINE_MAX_CHARS, 24 * 1024 * 1024);
});

test('pictures leave before the scene limits are checked, so a restored backup is not cut down', () => {
  const w = SERVER.slice(SERVER.indexOf('async function writeHubSettings('), SERVER.indexOf('async function writeHubSettings(') + 1600);
  assert.ok(w.indexOf('sceneImages.externalize(') < w.indexOf('normalizeHubSettings(settings)'));
  assert.match(w, /snapshotsDir: storeSnapshots\.snapshotsDir\(DATA_DIR\)/);
});

test('scene photos are not readable by other websites', () => {
  const cs = require('../cross-site.js');
  const foreign = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };
  assert.equal(cs.refusedCrossSite({ method: 'GET', headers: foreign }, 3030, '/uploads/sceneimg-' + 'a'.repeat(32) + '.png'), true);
  assert.equal(cs.refusedCrossSite({ method: 'GET', headers: foreign }, 3030, '/uploads/wallpaper.jpg'), false, 'other uploads as before');
  assert.equal(cs.refusedCrossSite({ method: 'GET', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors' } }, 3030, '/uploads/sceneimg-' + 'a'.repeat(32) + '.png'), false);
});

test('the server moves pictures on every settings write and puts them back for backups and shares', () => {
  const w = SERVER.slice(SERVER.indexOf('async function writeHubSettings('), SERVER.indexOf('async function writeHubSettings(') + 2000);
  assert.match(w, /await sceneImages\.externalize\(settings\.ambientScenes, UPLOADS_DIR\)/);
  assert.match(w, /if \(moved && moved\.changed\) safe\.rev = \(Number\(safe\.rev\) \|\| 0\) \+ 1;/, 'the saving screen picks up the lighter copy');
  assert.match(w, /await writeFileAtomic\(SETTINGS_FILE, JSON\.stringify\(safe\)\);/, 'compact');
  assert.match(SERVER, /safeSettings\.ambientScenes = await sceneImages\.inlineForBackup\(settings\.ambientScenes, UPLOADS_DIR\);/);
  assert.match(SHARE, /if \(\/\^\\\/uploads\\\/sceneimg-\/\.test\(src\)\) return uri;/);
  // The path the files get is one the scene schema keeps.
  const DI = require('../js/dashboard-instances.js');
  assert.equal(DI.tileImageSrc('/uploads/sceneimg-' + 'a'.repeat(32) + '.png'), '/uploads/sceneimg-' + 'a'.repeat(32) + '.png');
});
