// A path pasted into Spotlight finds that item (search-pasted-path.js +
// filesearch.js): recognised on each platform, stat'ed, answered as one
// ordinary result with an opaque id; a missing path searches its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pastedPath } = require('../search-pasted-path.js');
const { createFileSearch } = require('../filesearch.js');

const win = { platform: 'win32', home: 'C:\\Users\\me' };
const mac = { platform: 'darwin', home: '/Users/me' };

test('Windows paths: plain, quoted, forward slashes, ~ and file:// URLs', () => {
  assert.equal(pastedPath('C:\\Users\\me\\Desktop\\a.pdf', win), 'C:\\Users\\me\\Desktop\\a.pdf');
  assert.equal(pastedPath('"C:\\Users\\me\\My Files\\a b.pdf"', win), 'C:\\Users\\me\\My Files\\a b.pdf');
  assert.equal(pastedPath('  c:/Users/me/x.txt ', win), 'c:\\Users\\me\\x.txt');
  assert.equal(pastedPath('~\\Desktop\\Marci Progetti', win), 'C:\\Users\\me\\Desktop\\Marci Progetti');
  assert.equal(pastedPath('file:///C:/Users/me/a%20b.txt', win), 'C:\\Users\\me\\a b.txt');
});

test('macOS and Linux paths', () => {
  assert.equal(pastedPath('/Users/me/Documents/a.pdf', mac), '/Users/me/Documents/a.pdf');
  assert.equal(pastedPath('~/Documents', mac), '/Users/me/Documents');
  assert.equal(pastedPath("'/tmp/with space/x'", mac), '/tmp/with space/x');
});

test('words, network paths and roots are not pasted paths', () => {
  assert.equal(pastedPath('fattura marzo', win), null);
  assert.equal(pastedPath('\\\\server\\share\\a.txt', win), null);
  assert.equal(pastedPath('/Users/me/a.txt', win), null);
  assert.equal(pastedPath('C:\\Users\\me', mac), null);
  assert.equal(pastedPath('C:\\', win), null);
  assert.equal(pastedPath('/', mac), null);
  assert.equal(pastedPath('C:\\a\nb', win), null);
  assert.equal(pastedPath('', win), null);
});

function make() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xenon-paste-'));
  const fsr = createFileSearch({ dataDir, openExternal: async () => {} });
  let asked = null;
  fsr._setHostRunner(async (q) => { asked = q; return []; });
  return { fsr, dataDir, asked: () => asked };
}

test('an existing file comes back as the one result, with an opaque id', async () => {
  const { fsr, dataDir, asked } = make();
  const file = path.join(dataDir, 'deep folder', 'report final.pdf');
  mkdirSync(path.dirname(file));
  writeFileSync(file, 'x'.repeat(42));
  const out = await fsr.search('"' + file + '"');
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].path, file);
  assert.equal(out.results[0].kind, 'file');
  assert.equal(out.results[0].size, 42);
  assert.match(out.results[0].id, /^r[0-9a-f]{16}$/);
  assert.equal(asked(), null, 'the catalog is not asked');
  const more = await fsr.catalog(file);
  assert.deepEqual(more.results, []);
  fsr.stop();
});

test('an existing folder comes back as a folder', async () => {
  const { fsr, dataDir } = make();
  const out = await fsr.search(dataDir);
  assert.equal(out.results[0].kind, 'folder');
  fsr.stop();
});

test('a path that is not there searches its name', async () => {
  const { fsr, dataDir, asked } = make();
  await fsr.search(path.join(dataDir, 'moved', 'contratto.pdf'));
  assert.ok(asked(), 'the name search ran');
  assert.ok(asked().terms.join(' ').includes('contratto'));
  fsr.stop();
});
