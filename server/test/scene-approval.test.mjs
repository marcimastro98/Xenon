import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sceneWaiting } = require('../capabilities/desktop-scene.js');
const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const scenes = [{ id: 'night' }];

test('a chosen Store scene waits until it is approved and community widgets are on', () => {
  const hs = (enabled, grants) => ({ ambientMode: { sceneId: 'night' }, sdkWidgets: { enabled, grants } });
  assert.equal(sceneWaiting(hs(false, { night: {} }), scenes), true, 'approved, switch off');
  assert.equal(sceneWaiting(hs(true, {}), scenes), true, 'switch on, never approved');
  assert.equal(sceneWaiting(hs(true, { night: {} }), scenes), false);
});

test('the built-in scene, an own scene or a removed one never wait', () => {
  for (const sceneId of ['builtin', 'canvas:a', 'gone']) assert.equal(sceneWaiting({ ambientMode: { sceneId } }, scenes), false, sceneId);
  assert.equal(sceneWaiting({}, scenes), false);
});

test('Allow turns community widgets on only with the switch off, and the dialog says it first', () => {
  const src = read('../js/custom-widget.js');
  assert.match(src, /turnsOn = stored\.enabled !== true/, 'the stored flag, not the safe-mode mask');
  assert.match(src, /if \(turnsOn\) notes\.push\(t\('cw_perm_turns_on'/);
  assert.match(src, /if \(turnsOn\) patch\.enabled = true;/);
});

test('importing a scene does not also ask for the switch the dialog already turns on', () => {
  assert.match(read('../js/preset-share.js'), /if \(!sdkOn && !setChk\.checked\)/);
});

test('Settings offers the approval while the scene waits', () => {
  assert.match(read('../index.html'), /id="settings-ambient-scene-approve"[^>]*hidden[^>]*onclick="approveAmbientScene\(\)"/);
  const src = read('../js/settings.js');
  assert.match(src, /approve\.hidden = !waiting/);
  assert.match(src, /syncAmbientScenePicker\(cfg\);\s+syncAmbientSceneNote\(cfg\);/, 'the package list arrives after Settings draws');
  assert.match(src, /if \(pkg && ambientSceneWaiting\(next\.sceneId\)\) CustomWidget\.requestGrant\(pkg\)/);
});
