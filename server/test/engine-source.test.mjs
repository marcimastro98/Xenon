// The readers that find engine code wherever it lives now (engine-source.mjs),
// and the list of moves they follow: every module on the list is there, loads
// without running anything, and gives out the names the list says it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { declarationSource, engineSource, extractedFrom, fileDeclaring } from './engine-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const entries = extractedFrom();

test('every module on the list exists, under the line limit, in a feature folder', () => {
  const seen = new Set();
  for (const { file, about, names } of entries) {
    assert.match(file, /^server\/[a-z0-9-]+\/[a-z0-9-]+\.js$/, file);
    assert.ok(!seen.has(file), `${file} is listed once`);
    seen.add(file);
    assert.ok(existsSync(join(ROOT, file)), `${file} is on disk`);
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!text.includes('\r'), `${file} has LF line endings`);
    assert.ok(text.split('\n').length - 1 <= 300, `${file} stays under 300 lines`);
    const opening = text.slice(0, text.indexOf('\n\n')).split('\n').map((line) => line.replace(/^\/\/ ?/, '')).join(' ');
    assert.equal(opening, about, `${file} opens by saying what it does`);
    assert.ok(names.length > 0, `${file} holds something`);
  }
});

test('a moved module loads without starting anything and gives out its names', () => {
  for (const { file, names } of entries) {
    const made = require(join(ROOT, file));
    const text = readFileSync(join(ROOT, file), 'utf8');
    const exported = /\nmodule\.exports = \{([^}]*)\};\n$/.exec(text);
    assert.ok(exported, `${file} ends with one module.exports`);
    const list = exported[1].split(',').map((name) => name.trim()).filter(Boolean);
    assert.deepEqual(Object.keys(made), list, `${file} exports what its last line says`);
    for (const name of list) assert.ok(names.includes(name), `${file} exports only what was moved into it (${name})`);
    assert.ok(!/require\('\.\.\/server\.js'\)/.test(text), `${file} never requires the file it came from`);
  }
});

test('a name is declared in one place, and the readers find it there', () => {
  const engine = readFileSync(join(ROOT, 'server', 'server.js'), 'utf8');
  for (const { file, names } of entries) {
    for (const name of names) {
      assert.equal(fileDeclaring(name), file);
      const text = declarationSource(name);
      assert.ok(readFileSync(join(ROOT, file), 'utf8').includes(text), `${name} is read from ${file}`);
      const escaped = name.replace(/[$]/g, '\\$&');
      assert.ok(!new RegExp(`^(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${escaped}\\b`, 'm').test(engine),
        `${name} is not declared in server.js any more`);
    }
  }
  assert.equal(fileDeclaring('handleRequest'), 'server/server.js', 'what did not move is still read from server.js');
  assert.match(declarationSource('isAllowedRequest'), /^function isAllowedRequest\(/);
});

test('a text written over several lines is read to its closing backtick, and no further', () => {
  const text = declarationSource('VOLUME_DETAILS_COMMAND');
  assert.match(text, /^const VOLUME_DETAILS_COMMAND = `\n[\s\S]+\n`;$/);
  assert.ok(!text.includes('DISK_MODELS_COMMAND'), 'the next declaration is not part of it');
});

test('the joined text holds the old file and every module, each once', () => {
  const text = engineSource();
  assert.ok(text.startsWith(readFileSync(join(ROOT, 'server', 'server.js'), 'utf8')));
  for (const { file } of entries) {
    const body = readFileSync(join(ROOT, file), 'utf8');
    assert.equal(text.split(body).length - 1, 1, file);
  }
  assert.deepEqual(extractedFrom('server/a-file-nothing-left.js'), []);
  assert.throws(() => declarationSource('aNameNobodyDeclares'), /is not declared at the top level of server\/server\.js/);
});
