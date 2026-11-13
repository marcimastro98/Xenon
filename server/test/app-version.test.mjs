// The build's version lives in server/updates/app-version.js since server.js
// stopped working it out itself. It must be the value server.js had: read from
// the same package.json, with the same trimming, and empty when the file cannot
// be read. /version, the update check and the helper install all compare it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, '..', 'updates', 'app-version.js');
const PACKAGE = path.join(HERE, '..', '..', 'package.json');
const text = readFileSync(MODULE, 'utf8');

// The module's own code, run with a `require` of the test's choosing.
function versionWith(requireStub) {
  const module = { exports: {} };
  vm.runInNewContext(text, { module, exports: module.exports, require: requireStub });
  return module.exports.APP_VERSION;
}

test('the version the engine reports is the one in package.json, as server.js worked it out', () => {
  // The expression server.js had on its own line before the move, applied to the same file.
  const before = String(JSON.parse(readFileSync(PACKAGE, 'utf8')).version || '').trim().replace(/^v/i, '');
  assert.equal(require(MODULE).APP_VERSION, before);
  assert.match(before, /^\d+\.\d+\.\d+/, 'a plain version, no leading v');
});

test('the module holds the two statements server.js had, and reads the same file', () => {
  assert.ok(text.includes("\nlet APP_VERSION = '';\n"));
  assert.ok(text.includes("\ntry { APP_VERSION = String(require('../../package.json').version || '').trim().replace(/^v/i, ''); } catch {}\n"));
  const asked = [];
  versionWith((spec) => { asked.push(spec); return { version: '1.0.0' }; });
  assert.deepEqual(asked.map((spec) => path.resolve(path.dirname(MODULE), spec)), [PACKAGE], 'one read, of the package.json at the root');

  // The engine, server.js and every module taken out of it, asks for the value once from server.js
  // and gives it a value nowhere but in those two statements.
  const engine = engineSource();
  assert.equal(engine.split("const { APP_VERSION } = require('./updates/app-version.js');").length, 2);
  assert.equal((engine.match(/\bAPP_VERSION\s*(?:[-+*/|&?]{0,2}=(?!=)|\+\+|--)/g) ?? []).length, 2);
});

test('an unreadable or odd package.json gives what it gave before', () => {
  assert.equal(versionWith(() => { throw new Error('ENOENT'); }), '', 'no file: the empty version, no throw');
  assert.equal(versionWith(() => ({})), '');
  assert.equal(versionWith(() => ({ version: null })), '');
  assert.equal(versionWith(() => ({ version: ' v5.1.0 ' })), '5.1.0');
  assert.equal(versionWith(() => ({ version: 'V5.1.0' })), '5.1.0');
  assert.equal(versionWith(() => ({ version: '5.1.0-beta.1' })), '5.1.0-beta.1');
  assert.equal(versionWith(() => ({ version: 5 })), '5');
});
