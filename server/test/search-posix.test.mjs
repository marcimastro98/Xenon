// The search's macOS and Linux halves: installed apps (installed-apps.js) and
// the Spotlight catalog query (mdfind.js). Pure parts tested everywhere; the
// enumeration against a temp tree with the platform forced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { parseDesktopEntry, listPosixApps } = require('../installed-apps.js');
const { buildMdfindQuery, createMdfindRunner } = require('../mdfind.js');

test('a .desktop entry: name, local name, and the flags that hide it', () => {
  const d = parseDesktopEntry([
    '# comment', '[Desktop Entry]', 'Type=Application', 'Name=Files', 'Name[it]=File',
    'NoDisplay=false', '[Desktop Action new]', 'Name=New window',
  ].join('\n'), 'it');
  assert.deepEqual(d, { name: 'Files', localName: 'File', type: 'Application', noDisplay: false, hidden: false });
  assert.equal(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=X\nHidden=true').hidden, true);
});

test('Linux apps: user entries win, hidden and non-apps are left out', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'xenon-apps-'));
  const user = path.join(home, '.local', 'share', 'applications');
  const sys = path.join(home, 'sys', 'applications');
  mkdirSync(user, { recursive: true });
  mkdirSync(sys, { recursive: true });
  writeFileSync(path.join(user, 'firefox.desktop'), '[Desktop Entry]\nType=Application\nName=Firefox (mine)\n');
  writeFileSync(path.join(sys, 'firefox.desktop'), '[Desktop Entry]\nType=Application\nName=Firefox\n');
  writeFileSync(path.join(sys, 'helper.desktop'), '[Desktop Entry]\nType=Application\nName=Helper\nNoDisplay=true\n');
  writeFileSync(path.join(sys, 'link.desktop'), '[Desktop Entry]\nType=Link\nName=Docs\n');
  writeFileSync(path.join(sys, 'gimp.desktop'), '[Desktop Entry]\nType=Application\nName=GIMP\n');
  const apps = await listPosixApps({ platform: 'linux', home, env: { XDG_DATA_DIRS: path.join(home, 'sys') } });
  assert.deepEqual(apps.map((a) => a.name).sort(), ['Firefox (mine)', 'GIMP']);
  assert.ok(apps.every((a) => a.kind === 'desktop' && a.target.endsWith('.desktop')));
});

test('an mdfind query: names and content per term, filters, nothing a term can inject', () => {
  const q = buildMdfindQuery({ terms: ['fattura'], content: true, exts: ['pdf'], minBytes: 1024, after: Date.UTC(2026, 0, 1) });
  assert.equal(q, '(kMDItemFSName == "*fattura*"cd || kMDItemTextContent == "fattura*"cdw) && (kMDItemFSName == "*.pdf"c) && kMDItemFSContentChangeDate >= $time.iso(2026-01-01T00:00:00Z) && kMDItemFSSize >= 1024');
  assert.equal(buildMdfindQuery({ terms: ['a"b\\c*d'] }), 'kMDItemFSName == "*abcd*"cd');
  assert.equal(buildMdfindQuery({ terms: [], exts: ['toolongext1', 'p df'] }), '', 'an extension that is not one is dropped');
  assert.equal(buildMdfindQuery({}), '');
});

test('the mdfind runner reads NUL-separated paths, stops at max, and keeps files only', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-mdfind-'));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  writeFileSync(a, 'x'); writeFileSync(b, 'xy');
  let argv = null;
  const fakeSpawn = (cmd, args) => {
    argv = [cmd, ...args];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', a + '\0' + dir + '\0');
      child.stdout.emit('data', b + '\0');
      child.emit('close');
    });
    return child;
  };
  const run = createMdfindRunner({ spawn: fakeSpawn });
  const items = await run({ terms: ['x'], max: 2 });
  assert.equal(argv[0], 'mdfind');
  assert.equal(argv[1], '-0');
  assert.deepEqual(items.map((i) => i.n), ['a.txt'], 'the folder is not a file, and max=2 stopped before b');
});

test('no mdfind means unsupported, not a disabled service', async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {};
    setImmediate(() => child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(createMdfindRunner({ spawn: fakeSpawn })({ terms: ['x'] }), /wds_unsupported/);
});
