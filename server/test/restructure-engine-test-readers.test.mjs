// The conversion of the tests that read an engine file as text
// (tools/restructure/engine-test-readers.mjs): only the read changes, to
// engineSource(), and only for spellings that mean that file. Without --source
// the file is server.js; with it, any engine file a module was taken out of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BY_HAND, nameIsItsOwn, readsOf, retarget, stillNames } from '../../tools/restructure/engine-test-readers.mjs';

const TOOL = fileURLToPath(new URL('../../tools/restructure/engine-test-readers.mjs', import.meta.url));
const LEDGER = new URL('../../tools/restructure/extracted.json', import.meta.url);

const HEAD = ["import { test } from 'node:test';", "import { readFileSync } from 'node:fs';", ''].join('\n');
const WITH_IMPORT = ["import { test } from 'node:test';", "import { readFileSync } from 'node:fs';",
  "import { engineSource } from './engine-source.mjs';", ''].join('\n');

test('every spelling of "read server.js as text" becomes engineSource()', () => {
  const spellings = [
    "readFileSync(new URL('../server.js', import.meta.url), 'utf8')",
    "fs.readFileSync(new URL('../server.js', import.meta.url), 'utf-8')",
    "readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8')",
    "readFileSync(join(HERE, '..', 'server.js'), 'utf8')",
    "fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8')",
    "readFileSync(join(SERVER_DIR, 'server.js'), 'utf8')",
    "read('../server.js')", "read('server.js')", "read('server/server.js')", "read('server', 'server.js')",
    "src('server.js')", "source('server.js')", "readLf('../server.js')",
  ];
  for (const spelling of spellings) {
    assert.equal(retarget(`${HEAD}const SERVER = ${spelling};\n`), `${WITH_IMPORT}const SERVER = engineSource();\n`, spelling);
  }
});

test('what follows the read stays, and so does every other line', () => {
  const before = `${HEAD}const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');\n`
    + "const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\\r\\n/g, '\\n');\n"
    + "test('x', () => { assert.match(read('../server.js'), /a/); assert.match(read('../js/settings.js'), /a/); });\n";
  const after = retarget(before);
  assert.equal(after, `${WITH_IMPORT}const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');\n`
    + "const SERVER = engineSource().replace(/\\r\\n/g, '\\n');\n"
    + "test('x', () => { assert.match(engineSource(), /a/); assert.match(read('../js/settings.js'), /a/); });\n");
  assert.equal(retarget(after), after, 'running it again changes nothing');
});

test('other files, bytes and lists of files are left for a person', () => {
  const kept = [
    "const ap = require('../codex-appserver.js');",
    "const local = read('../ai-local-server.js');",
    "const BYTES = readFileSync(new URL('../server.js', import.meta.url));",
    "for (const file of ['../server.js', '../js/settings.js']) check(read(file));",
    "const worker = read('../../widget/server.js.txt');",
  ];
  for (const line of kept) assert.equal(retarget(`${HEAD}${line}\n`), `${HEAD}${line}\n`, line);
});

test('a test that already takes a reader from the helper gains the name on that line', () => {
  const before = `${HEAD}import { declarationSource } from './engine-source.mjs';\nconst S = read('server.js');\n`;
  assert.equal(retarget(before), `${HEAD}import { declarationSource, engineSource } from './engine-source.mjs';\nconst S = engineSource();\n`);
});

test('the conversion has been run: no test outside the by-hand list still matches', () => {
  const dir = new URL('./', import.meta.url);
  const left = readdirSync(dir).filter((name) => name.endsWith('.mjs') && !BY_HAND.has(name))
    .filter((name) => { const text = readFileSync(new URL(name, dir), 'utf8'); return retarget(text) !== text; });
  assert.deepEqual(left, [], 'run: node tools/restructure/engine-test-readers.mjs --write');
});

test('--source: every spelling of "read that file as text" becomes engineSource(<its path>)', () => {
  const spellings = [
    "readFileSync(new URL('../lighting.js', import.meta.url), 'utf8')",
    "fs.readFileSync(new URL('../lighting.js', import.meta.url), 'utf-8')",
    "readFileSync(fileURLToPath(new URL('../lighting.js', import.meta.url)), 'utf8')",
    "readFileSync(join(HERE, '..', 'lighting.js'), 'utf8')",
    "fs.readFileSync(path.join(ROOT, 'server', 'lighting.js'), 'utf8')",
    "readFileSync(join(SERVER_DIR, 'lighting.js'), 'utf8')",
    "readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lighting.js'), 'utf8')",
    "readFileSync(join(import.meta.dirname, '..', 'lighting.js'), 'utf8')",
    "require('node:fs').readFileSync(new URL('../lighting.js', import.meta.url), 'utf8')",
    "require('fs').readFileSync(path.join(ROOT, 'server', 'lighting.js'), 'utf8')",
    "read('../lighting.js')", "read('lighting.js')", "read('server/lighting.js')", "read('server', 'lighting.js')",
    "src('lighting.js')", "source('lighting.js')", "readLf('../lighting.js')",
  ];
  for (const spelling of spellings) {
    assert.equal(retarget(`${HEAD}const TEXT = ${spelling};\n`, 'server/lighting.js'),
      `${WITH_IMPORT}const TEXT = engineSource('server/lighting.js');\n`, spelling);
  }
});

test('--source: a file in a folder is found whether its path is given whole or folder by folder', () => {
  const spellings = [
    "readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8')",
    "readFileSync(join(HERE, '..', 'actions', 'registry.js'), 'utf8')",
    "readFileSync(join(HERE, '..', 'actions/registry.js'), 'utf8')",
    "readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'actions', 'registry.js'), 'utf8')",
    "readFileSync(path.join(ROOT, 'server', 'actions', 'registry.js'), 'utf8')",
    "read('../actions/registry.js')", "read('actions/registry.js')", "read('server/actions/registry.js')",
    "read('server', 'actions', 'registry.js')", "read('server', 'actions/registry.js')",
  ];
  for (const spelling of spellings) {
    assert.equal(retarget(`${HEAD}const TEXT = ${spelling};\n`, 'server/actions/registry.js'),
      `${WITH_IMPORT}const TEXT = engineSource('server/actions/registry.js');\n`, spelling);
  }
  // The name alone would be server/registry.js: another file.
  const alone = `${HEAD}const TEXT = read('registry.js');\n`;
  assert.equal(retarget(alone, 'server/actions/registry.js'), alone);
});

test('--source: reads of every other file stay, server.js included', () => {
  const kept = [
    "const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');",
    "const page = read('../js/lighting.js');",
    "const driver = read('../js/driver-lighting.js');",
    "const other = readFileSync(join(HERE, '..', 'lighting-effects.js'), 'utf8');",
    "const lighting = require('../lighting.js');",
    "const BYTES = readFileSync(new URL('../lighting.js', import.meta.url));",
    "for (const file of ['../lighting.js', '../js/settings.js']) check(read(file));",
  ];
  for (const line of kept) assert.equal(retarget(`${HEAD}${line}\n`, 'server/lighting.js'), `${HEAD}${line}\n`, line);
  const both = `${HEAD}const A = read('../server.js');\nconst B = read('../lighting.js');\n`;
  assert.equal(retarget(retarget(both), 'server/lighting.js'),
    `${WITH_IMPORT}const A = engineSource();\nconst B = engineSource('server/lighting.js');\n`, 'one import line serves both');
  const once = retarget(both, 'server/lighting.js');
  assert.equal(retarget(once, 'server/lighting.js'), once, 'running it again changes nothing');
});

test('--source: a name two scripts share is changed only where the read says which one', () => {
  const text = `${HEAD}const A = read('ai-local.js');\nconst B = read('../ai-local.js');\n`;
  assert.equal(retarget(text, 'server/ai-local.js', { bare: false }),
    `${WITH_IMPORT}const A = read('ai-local.js');\nconst B = engineSource('server/ai-local.js');\n`);
  const root = mkdtempSync(join(tmpdir(), 'xenon-readers-'));
  try {
    for (const dir of ['server/js/settings', 'server/test', 'server/node_modules/pkg']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['server/ai-local.js', 'server/js/settings/ai-local.js', 'server/lighting.js', 'server/test/lighting.js',
      'server/node_modules/pkg/lighting.js']) writeFileSync(join(root, file), '');
    assert.equal(nameIsItsOwn('server/ai-local.js', root), false, 'the browser has a script of the same name');
    assert.equal(nameIsItsOwn('server/lighting.js', root), true, 'tests and installed packages do not count');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--source: a test that still names the file in a string is listed for a person', () => {
  const source = 'server/lighting.js';
  assert.equal(stillNames("const files = ['lighting.js', 'server.js'];\n", source), true);
  assert.equal(stillNames("const text = readFileSync(repoFile('server/lighting.js'), 'utf8');\n", source), true);
  assert.equal(stillNames("const text = engineSource('server/lighting.js');\n", source), false);
  assert.equal(stillNames("const lighting = require('../lighting.js');\n", source), false);
  assert.equal(stillNames("import * as lighting from '../lighting.js';\n", source), false);
  assert.equal(stillNames("const lighting = await import('../lighting.js');\n", source), false);
  // import.meta.url loads nothing: a read built on it that the tool did not change is one a person looks at.
  assert.equal(stillNames("const BYTES = readFileSync(new URL('../lighting.js', import.meta.url));\n", source), true);
  assert.equal(stillNames("const text = readText(join(dirname(fileURLToPath(import.meta.url)), '..', 'lighting.js'));\n", source), true);
  assert.equal(stillNames("// read('../lighting.js') was here\n", source), false);
  assert.equal(stillNames("const page = read('../js/driver-lighting.js');\n", source), false);
});

test('--source: only a script under server/ can be named, and the tool says so', () => {
  assert.throws(() => readsOf('tools/restructure/cli.mjs'), /is not a script under server/);
  assert.throws(() => readsOf('server/install.ps1'), /is not a script under server/);
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 60000 });
  const missing = run('--source', 'server/no-such-file.js');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /server\/no-such-file\.js is not a file of this repo/);
  const bare = run('--source');
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--source needs a path/);
});

test('a test that builds a repo of its own keeps reading the files of that copy', () => {
  // Its read is spelled like a read of this repo, so only the by-hand list can keep it.
  const line = "assert.match(readFileSync(path.join(root, 'server', 'fpsmon.js'), 'utf8'), /XenonFps/);";
  assert.notEqual(retarget(line, 'server/fpsmon.js'), line);
  assert.ok(BY_HAND.has('restructure-side-copy.test.mjs'));
});

test('the conversion has been run for every file a module was taken out of', () => {
  const dir = new URL('./', import.meta.url);
  const sources = Object.keys(JSON.parse(readFileSync(LEDGER, 'utf8')).sources).filter((source) => source !== 'server/server.js');
  const tests = readdirSync(dir).filter((name) => name.endsWith('.mjs') && !BY_HAND.has(name))
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));
  for (const source of sources) {
    const how = { bare: nameIsItsOwn(source) };
    const left = tests.filter(({ text }) => retarget(text, source, how) !== text).map(({ name }) => name);
    assert.deepEqual(left, [], `run: node tools/restructure/engine-test-readers.mjs --source ${source} --write`);
  }
});
