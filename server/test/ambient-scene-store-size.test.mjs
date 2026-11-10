// An Ambient scene shared with its pictures inlined could be a few MB (the
// export inlines up to ~3.2 MB under a 4 MB code), but the server dropped any
// scene over 400 KB on save, without a word: the import said "imported", and
// the scene was gone after the next restart. Store, server and import now read
// one rule (AmbientScene.fitScenes / sceneFits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AS = require('../js/ambient-scene.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const SHARE = readFileSync(new URL('../js/preset-share.js', import.meta.url), 'utf8');

// A scene of about `chars` JSON characters, as an inlined picture makes it.
const sceneOf = (chars, id = 'big-scene') => ({ id, name: 'Big', components: [], bg: { type: 'image', url: 'data:image/png;base64,' + 'A'.repeat(chars) } });

test('a scene as large as a share code can carry is kept', () => {
  const big = sceneOf(3.2 * 1024 * 1024);
  assert.equal(AS.fitScenes([big]).length, 1);
  assert.equal(AS.sceneFits(big, []), true);
});

test('the per-scene cap is the share code cap', () => {
  const m = /const MAX_CODE_BYTES = ([^;]+);/.exec(SHARE);
  assert.ok(m);
  assert.equal(AS.SCENE_MAX_CHARS, Function('return ' + m[1])());
  assert.equal(AS.fitScenes([sceneOf(AS.SCENE_MAX_CHARS)]).length, 0);
});

test('all scenes together stay under the settings save body', () => {
  const m = /const READ_BODY_MAX_BYTES = ([^;]+);/.exec(SERVER);
  assert.ok(m);
  assert.ok(AS.SCENES_TOTAL_MAX_CHARS * 2 <= Function('return ' + m[1])());
  const three = sceneOf(3.5 * 1024 * 1024);
  const list = Array.from({ length: 8 }, (_, i) => ({ ...three, id: 's' + i }));
  const kept = AS.fitScenes(list);
  assert.ok(kept.length < list.length);
  assert.deepEqual(kept, list.slice(0, kept.length), 'kept in order');
  assert.equal(AS.sceneFits(three, kept), false);
});

test('the count cap holds', () => {
  const list = Array.from({ length: AS.MAX_SCENES + 3 }, (_, i) => sceneOf(10, 's' + i));
  assert.equal(AS.fitScenes(list).length, AS.MAX_SCENES);
  assert.equal(AS.sceneFits(sceneOf(10), list.slice(0, AS.MAX_SCENES)), false);
});

test('the server keeps scenes by the shared rule', () => {
  const fn = /function sanitizeAmbientScenes\(value\) \{[\s\S]*?\r?\n\}/.exec(SERVER);
  assert.ok(fn);
  assert.match(fn[0], /AmbientScene\.fitScenes\(value\)/);
  assert.doesNotMatch(fn[0], /400000/);
});

test('the import says there is no room before the Import button, and never installs past it', () => {
  const dialog = /function openAmbientLayoutImport[\s\S]*?\r?\n    \}\r?\n/.exec(SHARE);
  assert.ok(dialog);
  const check = dialog[0].indexOf('AS.sceneFits(scene, stored)');
  assert.ok(check > 0);
  assert.ok(check < dialog[0].indexOf('previewApplyRow('));
  assert.match(dialog[0], /preset_ambient_no_room/);
  const apply = /async function applyAmbientLayout[\s\S]*?\r?\n    \}\r?\n/.exec(SHARE);
  assert.ok(apply);
  const guard = apply[0].indexOf('if (!AS.sceneFits(norm, list)) return false;');
  assert.ok(guard > 0);
  assert.ok(guard < apply[0].indexOf('list.push(norm)'));
});
