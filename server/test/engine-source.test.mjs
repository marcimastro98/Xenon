// The readers that find engine code wherever it lives now (engine-source.mjs),
// and the list of moves they follow: every module on the list is there, loads
// without running anything, and gives out the names the list says it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { declarationSource, engineSource, extractedFrom, fileDeclaring, oldDeclarations, oldNames, stateRewrites } from './engine-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const entries = extractedFrom();
// Variables that became properties of an object in a module of their own: the readers hand out the old names.
const rewrites = stateRewrites();
const asWritten = (file) => oldNames(readFileSync(join(ROOT, file), 'utf8'), rewrites);

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
      assert.ok(asWritten(file).includes(text), `${name} is read from ${file}`);
      const escaped = name.replace(/[$]/g, '\\$&');
      assert.ok(!new RegExp(`^(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${escaped}\\b`, 'm').test(engine),
        `${name} is not declared in server.js any more`);
    }
  }
  assert.equal(fileDeclaring('handleRequest'), 'server/server.js', 'what did not move is still read from server.js');
  assert.match(declarationSource('isAllowedRequest'), /^function isAllowedRequest\(/);
});

test('a value written on the lines after its = is read to the line that ends it, and no further', () => {
  const text = declarationSource('nativeMedia');
  assert.match(text, /^const nativeMedia =\n {2}process\.platform === 'darwin'\n/);
  assert.match(text, /\n {6}: null;$/, 'the last indented line, with its semicolon');
  assert.ok(!text.includes('\n\n') && !/\n\S/.test(text), 'nothing at the margin, no blank line: one statement');
  assert.equal(text.split('\n').length, 9);
});

test('a value that got a module of its own is required by server.js once, on one line, under its own name', () => {
  const engine = readFileSync(join(ROOT, 'server', 'server.js'), 'utf8');
  const lifted = entries.filter((entry) => entry.lift);
  for (const { file, names } of lifted) {
    assert.equal(names.length, 1, file);
    const spec = `./${file.replace(/^server\//, '')}`;
    assert.equal(engine.split(`require('${spec}')`).length - 1, 1, `server.js requires ${file} once`);
    assert.ok(engine.includes(`\nconst { ${names[0]} } = require('${spec}');\n`), `${names[0]} is what that require gives`);
    assert.ok(readFileSync(join(ROOT, file), 'utf8').endsWith(`\nmodule.exports = { ${names[0]} };\n`));
  }
  assert.ok(lifted.some((entry) => entry.names[0] === 'APP_VERSION'), 'the version is one of them');
});

test('a text written over several lines is read to its closing backtick, and no further', () => {
  const text = declarationSource('VOLUME_DETAILS_COMMAND');
  assert.match(text, /^const VOLUME_DETAILS_COMMAND = `\n[\s\S]+\n`;$/);
  assert.ok(!text.includes('DISK_MODELS_COMMAND'), 'the next declaration is not part of it');
});

test('the joined text holds the old file and every module, each once', () => {
  const text = engineSource();
  assert.ok(text.startsWith(asWritten('server/server.js')));
  for (const { file } of entries) {
    const body = asWritten(file);
    assert.equal(text.split(body).length - 1, 1, file);
  }
  assert.deepEqual(extractedFrom('server/a-file-nothing-left.js'), []);
  assert.throws(() => declarationSource('aNameNobodyDeclares'), /is not declared at the top level of server\/server\.js/);
});

test('a module that holds shared variables is one object and nothing else, and the old names are gone from the code', () => {
  const engine = readFileSync(join(ROOT, 'server', 'server.js'), 'utf8');
  const seen = new Set(entries.map((entry) => entry.file));
  // The code that uses the variables: the file and every module moved out of it, not the modules that hold them.
  const code = ['server/server.js', ...entries.map((entry) => entry.file)].map(asWritten).join('\n');
  for (const entry of rewrites) {
    const { file, about, names, state } = entry;
    assert.match(file, /^server\/[a-z0-9-]+\/[a-z0-9-]+\.js$/, file);
    assert.ok(!seen.has(file), `${file} is listed once`);
    seen.add(file);
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!text.includes('\r'), `${file} has LF line endings`);
    assert.ok(text.split('\n').length - 1 <= 300, `${file} stays under 300 lines`);
    assert.equal(text.slice(0, text.indexOf('\n\n')).split('\n').map((line) => line.replace(/^\/\/ ?/, '')).join(' '), about, `${file} opens by saying what it does`);
    assert.ok(text.endsWith(`\nmodule.exports = { ${state.object} };\n`), `${file} ends by exporting its one object`);
    assert.ok(!/\brequire\(/.test(text), `${file} loads nothing`);
    const made = require(join(ROOT, file));
    assert.deepEqual(Object.keys(made), [state.object]);
    assert.deepEqual(Object.keys(made[state.object]), Object.values(state.props), `${file} holds one property for each variable, in the order of the list`);
    assert.deepEqual(names, Object.keys(state.props));
    for (const name of names) {
      const escaped = name.replace(/[$]/g, '\\$&');
      assert.ok(!new RegExp(`^(?:const|let|var)\\s+${escaped}\\b`, 'm').test(engine), `${name} is not declared in server.js any more`);
      assert.match(code, new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`), `the readers still hand ${name} out by its old name`);
      if (state.kept.includes(name)) assert.match(declarationSource(name), new RegExp(`^let ${escaped} = `), `${name} gets its first value in server.js`);
      else {
        assert.equal(fileDeclaring(name), file);
        assert.match(declarationSource(name), new RegExp(`^let ${escaped}(?: = |;)`));
        assert.ok(oldDeclarations(text, entry).includes(declarationSource(name)));
      }
    }
  }
});
