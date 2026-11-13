// The settings a new install starts with are written in eight parts
// (server/settings/defaults-*.js) and put together in server/settings/defaults.js.
// Together they have to be the one list they were cut from: every key once, in the
// written order, frozen. The order matters: it is the order settings are saved in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { cutObjects, declarationSource, engineSource, fileDeclaring } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const fromRepo = (file) => require(`../../${file}`);
const cut = cutObjects().find((entry) => entry.name === 'DEFAULT_HUB_SETTINGS');
const { DEFAULT_HUB_SETTINGS } = fromRepo(fileDeclaring('DEFAULT_HUB_SETTINGS'));
const parts = cut.parts.map((part) => ({ ...part, value: fromRepo(fileDeclaring(part.name))[part.name] }));

test('the parts put together are the whole list: every key once, in the order they are written', () => {
  const keys = parts.flatMap((part) => Object.keys(part.value));
  assert.equal(new Set(keys).size, keys.length, 'no key is in two parts');
  assert.deepEqual(Object.keys(DEFAULT_HUB_SETTINGS), keys);
  for (const part of parts) {
    assert.equal(Object.keys(part.value)[0], part.first, `${part.name} starts at the key the list of moves names`);
    for (const key of Object.keys(part.value)) assert.equal(DEFAULT_HUB_SETTINGS[key], part.value[key], `${key} is the part's own value, not a copy`);
  }
  assert.ok(keys.length >= 173, 'the list had 173 keys when it was cut');
});

test('the list and every part are frozen, so no code can change what a new install starts with', () => {
  assert.ok(Object.isFrozen(DEFAULT_HUB_SETTINGS));
  for (const part of parts) assert.ok(Object.isFrozen(part.value), part.name);
  assert.throws(() => { DEFAULT_HUB_SETTINGS.appearance = 'light'; }, TypeError);
});

test('read as text, the list is one piece with every key in the order the engine has them', () => {
  const text = declarationSource('DEFAULT_HUB_SETTINGS');
  assert.ok(text.startsWith('const DEFAULT_HUB_SETTINGS = Object.freeze({\n') && text.endsWith('\n});'));
  // A key of the list itself starts two spaces in; the keys of nested objects are further in.
  const written = [...text.matchAll(/^ {2}(?:'([^']+)'|([A-Za-z_$][\w$]*)):/gm)].map((found) => found[1] ?? found[2]);
  assert.deepEqual(written, Object.keys(DEFAULT_HUB_SETTINGS));
  assert.doesNotMatch(text, /\.\.\.HUB_DEFAULTS_/, 'no part is named in it');
  const engine = engineSource();
  for (const part of parts) assert.ok(!engine.includes(`const ${part.name} = `), `${part.name} is not handed out a second time`);
  assert.equal(engine.split(text).length - 1, 1, 'the list is in the engine text once');
});
