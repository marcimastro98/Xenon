// The one-time conversion of the tests that read server.js as text
// (tools/restructure/engine-test-readers.mjs): only the read changes, to
// engineSource(), and only for spellings that mean the engine's own file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { BY_HAND, retarget } from '../../tools/restructure/engine-test-readers.mjs';

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
