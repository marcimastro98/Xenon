// A Store widget may suggest key combinations in its manifest: one to show or hide
// the placed widget (`key`) and one per function (`deck.handlers[].key`). They are
// only offered in the Xenon menu, so a bad one is dropped, never a refused package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeManifest, normalizeKeySuggestion } = require('../sdk-widgets.js');

const base = (over = {}) => ({ api: 1, name: 'Clock X', ...over });

test('a suggestion is a real combination, lowercased, pressed unless it says hold', () => {
  assert.deepEqual(normalizeKeySuggestion({ combo: 'Ctrl+Shift+K' }), { combo: 'ctrl+shift+k', mode: 'toggle' });
  assert.deepEqual(normalizeKeySuggestion({ combo: 'ctrl+alt+f3', mode: 'hold' }), { combo: 'ctrl+alt+f3', mode: 'hold' });
  assert.equal(normalizeKeySuggestion({ combo: 'ctrl+c' }), null, 'one modifier and a letter is not a Xenon combination');
  assert.equal(normalizeKeySuggestion({ combo: 'alt+f4' }), null, 'reserved by the system');
  for (const bad of [null, 'ctrl+shift+k', ['ctrl+shift+k'], { combo: 7 }, {}]) assert.equal(normalizeKeySuggestion(bad), null);
});

test('the manifest keeps a good suggestion and drops a bad one without refusing the package', () => {
  const good = normalizeManifest(base({ key: { combo: 'ctrl+shift+k', mode: 'hold' } }), 'clock');
  assert.equal(good.ok, true);
  assert.deepEqual(good.manifest.key, { combo: 'ctrl+shift+k', mode: 'hold' });
  const bad = normalizeManifest(base({ key: { combo: 'alt+f4' } }), 'clock');
  assert.equal(bad.ok, true);
  assert.equal(bad.manifest.key, null);
  assert.equal(normalizeManifest(base(), 'clock').manifest.key, null);
  assert.equal(normalizeManifest(base({ surface: 'ambient', key: { combo: 'ctrl+shift+k' } }), 'scene').manifest.key, null, 'a scene is never placed');
});

test('a function may suggest its own combination; a bad one is dropped with the function kept', () => {
  const res = normalizeManifest(base({ deck: { handlers: [
    { id: 'lap', name: 'Lap', key: { combo: 'Ctrl+Shift+L', mode: 'hold' } },
    { id: 'reset', name: 'Reset', key: { combo: 'win+l' } },
    { id: 'stop', name: 'Stop' },
  ] } }), 'clock');
  assert.equal(res.ok, true);
  assert.deepEqual(res.manifest.deck.handlers.map((h) => [h.id, h.key]), [['lap', { combo: 'ctrl+shift+l' }], ['reset', undefined], ['stop', undefined]]);
});
