// Reading the author's widget folder into a payload and writing one back:
// Xenon's own limits up front, nothing outside the folder, no overwriting
// someone's work by surprise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const F = require('../src/folder.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-mcp-'));
const put = (root, rel, data = 'x') => {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
};

test('widgetId: the folder name, or the id given, in Xenon\'s charset', () => {
  assert.equal(F.widgetId('/a/b/gpu-temp'), 'gpu-temp');
  assert.equal(F.widgetId('/a/b/GPU-Temp'), 'gpu-temp');
  assert.equal(F.widgetId('/a/b/My Widget'), null);
  assert.equal(F.widgetId('/a/b/My Widget', 'clock'), 'clock');
  assert.equal(F.widgetId('/a/b/x', '../etc'), null);
});

test('read: sends widget files, skips tooling and says what else it left out', async () => {
  const root = tmp();
  put(root, 'manifest.json', '{}');
  put(root, 'index.html');
  put(root, 'img/logo.png');
  put(root, '.git/config');
  put(root, 'node_modules/a/index.js');
  put(root, 'notes.psd');
  put(root, 'bad name.js');
  const r = await F.readWidgetFolder(root);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['img/logo.png', 'index.html', 'manifest.json']);
  assert.equal(Buffer.from(r.files.find((f) => f.path === 'manifest.json').data, 'base64').toString(), '{}');
  assert.deepEqual(r.skipped.map((s) => s.path).sort(), ['bad name.js', 'notes.psd']);
});

test('read: clear errors for a missing folder, a file, no manifest and the limits', async () => {
  const root = tmp();
  assert.equal((await F.readWidgetFolder(path.join(root, 'nope'))).error, 'no_folder');
  put(root, 'file.txt');
  assert.equal((await F.readWidgetFolder(path.join(root, 'file.txt'))).error, 'not_a_folder');
  assert.equal((await F.readWidgetFolder(root)).error, 'missing_manifest');
  put(root, 'manifest.json', '{}');
  put(root, 'big.js', Buffer.alloc(F.MAX_FILE_BYTES + 1));
  assert.equal((await F.readWidgetFolder(root)).error, 'file_too_large');
  fs.rmSync(path.join(root, 'big.js'));
  for (let i = 0; i < F.MAX_FILES; i++) put(root, `f${i}.js`);
  assert.equal((await F.readWidgetFolder(root)).error, 'too_many_files');
});

test('read: the total size limit', async () => {
  const root = tmp();
  put(root, 'manifest.json', '{}');
  for (let i = 0; i < 7; i++) put(root, `a${i}.png`, Buffer.alloc(F.MAX_FILE_BYTES));
  assert.equal((await F.readWidgetFolder(root)).error, 'too_large');
});

test('targetPath: nothing leaves the folder', () => {
  const root = path.resolve(tmp());
  assert.equal(F.targetPath(root, 'img/a.png'), path.join(root, 'img', 'a.png'));
  for (const bad of ['../a.js', 'a/../../b.js', '/etc/passwd.txt', 'C:/x.js', 'a\\b.js', '', 'a.exe', '..a/b.js']) {
    assert.equal(F.targetPath(root, bad), null, bad);
  }
});

test('write: into a new folder, never over files unless asked', async () => {
  const root = path.join(tmp(), 'clock');
  const files = [{ path: 'manifest.json', data: Buffer.from('{"a":1}').toString('base64') }, { path: 'js/main.js', data: '' }];
  const r = await F.writeWidgetFolder(root, files);
  assert.equal(r.ok, true);
  assert.deepEqual(r.written, ['manifest.json', 'js/main.js']);
  assert.equal(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), '{"a":1}');
  assert.equal((await F.writeWidgetFolder(root, files)).error, 'folder_not_empty');
  assert.equal((await F.writeWidgetFolder(root, files, { overwrite: true })).ok, true);
});

test('write: a bad path from the wire writes nothing at all', async () => {
  const root = path.join(tmp(), 'clock');
  const r = await F.writeWidgetFolder(root, [{ path: 'ok.js', data: '' }, { path: '../evil.js', data: '' }]);
  assert.equal(r.error, 'bad_path');
  assert.equal(fs.existsSync(path.join(root, 'ok.js')), false);
  assert.equal(fs.existsSync(path.join(root, '..', 'evil.js')), false);
});
