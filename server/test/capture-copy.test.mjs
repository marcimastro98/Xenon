// "Copy to a folder": a capture copied into one of the user's own folders by
// name (capture-copy.js), and its Deck/Bit capability (copy-capture.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCaptureCopy, PLACES } = require('../capture-copy.js');
const copyCapture = require('../capabilities/copy-capture.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-copy-'));
  const src = path.join(root, 'gallery');
  fs.mkdirSync(src);
  const clip = path.join(src, 'Clip.mp4');
  fs.writeFileSync(clip, 'video');
  const entries = { c1: { id: 'c1', name: 'Clip.mp4', file: clip } };
  const folders = {};
  const copier = createCaptureCopy({
    store: { get: (id) => entries[id] || null },
    folderOf: async (place) => (folders[place] = path.join(root, place)),
    mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
    exists: (p) => fs.promises.access(p).then(() => true, () => false),
    copyFile: (a, b) => fs.promises.copyFile(a, b),
    rename: (a, b) => fs.promises.rename(a, b),
    unlink: (p) => fs.promises.unlink(p),
  });
  return { root, clip, entries, copier };
}

test('a capture lands in the named folder and a taken name gets a number', async () => {
  const { root, clip, copier } = setup();
  assert.deepEqual(await copier.copy('c1', 'desktop'), { ok: true, name: 'Clip.mp4', folder: 'desktop' });
  assert.deepEqual(await copier.copy('c1', 'Desktop'), { ok: true, name: 'Clip (2).mp4', folder: 'desktop' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'desktop')).sort(), ['Clip (2).mp4', 'Clip.mp4']);
  assert.equal(fs.readFileSync(clip, 'utf8'), 'video', 'the original stays');
});

test('only the five named folders, never a path', async () => {
  const { copier } = setup();
  assert.deepEqual(PLACES, ['desktop', 'downloads', 'documents', 'pictures', 'videos']);
  for (const to of ['C:\\Windows', '../x', '/tmp', '', 'startup']) {
    assert.deepEqual(await copier.copy('c1', to), { ok: false, error: 'bad_place' });
  }
});

test('a missing capture or file answers not_found; a failed copy leaves no .part', async () => {
  const { root, clip, entries, copier } = setup();
  assert.deepEqual(await copier.copy('nope', 'desktop'), { ok: false, error: 'not_found' });
  fs.unlinkSync(clip);
  assert.deepEqual(await copier.copy('c1', 'desktop'), { ok: false, error: 'not_found' });
  fs.writeFileSync(clip, 'video');
  entries.c1 = { ...entries.c1 };
  const failing = createCaptureCopy({
    store: { get: () => entries.c1 },
    folderOf: async () => path.join(root, 'full'),
    mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
    exists: (p) => fs.promises.access(p).then(() => true, () => false),
    copyFile: async (_a, b) => { fs.writeFileSync(b, 'half'); throw Object.assign(new Error('full'), { code: 'ENOSPC' }); },
    rename: (a, b) => fs.promises.rename(a, b),
    unlink: (p) => fs.promises.unlink(p),
  });
  assert.deepEqual(await failing.copy('c1', 'downloads'), { ok: false, error: 'no_space' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'full')), []);
});

test('the capability picks the newest and passes only a folder name', async () => {
  const shot = { id: 's1', name: 'Shot.png', createdAt: 2 };
  const video = { id: 'v1', name: 'Clip.mp4', createdAt: 1 };
  const calls = [];
  const store = {
    last: async (kind) => (kind === 'screenshot' ? shot : kind === 'replay' ? video : null),
    get: (id) => ({ s1: shot, v1: video }[id] || null),
    list: () => [shot, video],
  };
  const d = { capture: { store: () => store, copyTo: async (id, to) => { calls.push([id, to]); return { ok: true, name: id === 's1' ? 'Shot.png' : 'Clip.mp4', folder: to }; } } };
  assert.deepEqual(await copyCapture.run(d, {}), { ok: true, name: 'Shot.png', folder: 'desktop' });
  assert.deepEqual(await copyCapture.run(d, { what: 'video', to: 'downloads' }), { ok: true, name: 'Clip.mp4', folder: 'downloads' });
  assert.deepEqual(calls, [['s1', 'desktop'], ['v1', 'downloads']]);
  const none = { capture: { store: () => ({ last: async () => null, get: () => null, list: () => [] }), copyTo: async () => ({ ok: true }) } };
  assert.deepEqual(await copyCapture.run(none, {}), { ok: false, error: 'no_file' });
  const bad = { capture: { store: () => store, copyTo: async () => ({ ok: false, error: 'EPERM' }) } };
  assert.deepEqual(await copyCapture.run(bad, {}), { ok: false, error: 'write_failed' });
  assert.deepEqual(await copyCapture.run({}, {}), { ok: false, error: 'unavailable' });
});

test('Deck and Bit see it, every folder has a label', () => {
  const c = CAPABILITIES.find((x) => x.type === 'copyCapture');
  assert.ok(c, 'in the catalog');
  assert.equal(c.capability.ai.name, 'copy_capture_to_folder');
  assert.ok(!c.capability.sdk, 'not for widgets: the user decides where files go');
  const to = c.params.find((p) => p.name === 'to');
  assert.deepEqual(to.options, PLACES);
  const i18n = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['deck_act_copyCapture', 'deck_param_copy_to', ...Object.values(to.optionKeys)]) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
});
