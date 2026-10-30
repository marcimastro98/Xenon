// The SDK `capture` category: a widget may START a screenshot, a recording, a
// replay save or a text copy from an area the user drags, nothing else. Pinned here: the three types and their limits on
// the server, the same limits in the bridge (js/custom-widget.js, where bridge
// actions are gated), 'reveal' / replay on-off / the microphone refused on both
// doors (bridge and manifest macro), a field left out allowed, the permission
// line in all 11 languages, and the docs section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = require('../sdk-widgets.js');
const CW = readFileSync(path.join(ROOT, 'js', 'custom-widget.js'), 'utf8');

// The bridge's own gate, run as it is written: its two tables and actionAllowed.
function bridgeGate() {
  const grab = (re) => { const m = CW.match(re); assert.ok(m, String(re)); return m[0]; };
  const cats = grab(/const ACTION_CATEGORIES = \{[\s\S]*?\n {2}\};/);
  const limits = grab(/const ACTION_LIMITS = \{[\s\S]*?\n {2}\};/);
  const fn = grab(/function actionAllowed\(grant, action\) \{[\s\S]*?\n {2}\}/);
  const box = {};
  vm.createContext(box);
  vm.runInContext(`${cats}\n${limits}\n${fn}\nthis.allowed = actionAllowed; this.limits = ACTION_LIMITS;`, box);
  return box;
}

const REFUSED = [
  { type: 'screenshot', mode: 'reveal' },
  { type: 'record', mode: 'reveal' },
  { type: 'record', audio: 'sound_mic' },
  // A widget never turns the webcam on either.
  { type: 'record', webcam: 'br' },
  { type: 'replay', mode: 'toggle' },
  { type: 'replay', mode: 'on' },
  { type: 'replay', mode: 'reveal' },
  // Text from a window or the whole screen would land on the clipboard with no
  // gesture: only the area the user drags.
  { type: 'screenText', target: 'window' },
  { type: 'screenText', target: 'screen' },
  // Pinning: only an area the user drags now, never a saved capture by id.
  { type: 'screenPin', source: 'last' },
  { type: 'screenPin', id: 'aaaaaaaaaaaaaaaa' },
];
const ALLOWED = [
  { type: 'screenshot' },
  { type: 'screenshot', target: 'region' },
  { type: 'record', mode: 'start', target: 'window', audio: 'silent' },
  { type: 'record' },
  { type: 'record', webcam: 'off' },
  { type: 'replay', seconds: '30' },
  { type: 'screenText' },
  { type: 'screenText', target: 'region' },
  { type: 'screenPin' },
  { type: 'screenPin', source: 'region', surface: 'desktop' },
  { type: 'screenColor', format: 'hsl' },
  { type: 'screenMeasure' },
];

test('server: the category is the capture keys, and the limits keep out what is not a start', () => {
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.capture], ['screenshot', 'record', 'replay', 'screenText', 'screenPin', 'screenColor', 'screenMeasure', 'captureMarker']);
  for (const a of REFUSED) assert.equal(sdk.sdkActionWithinLimits(a), false, JSON.stringify(a));
  for (const a of ALLOWED) assert.equal(sdk.sdkActionWithinLimits(a), true, JSON.stringify(a));
  assert.equal(sdk.sdkActionWithinLimits({ type: 'media', mode: 'anything' }), true);
  // Nothing else from the capture group leaks in (opening the gallery is its own
  // category, see sdk-safe-actions.test.mjs).
  for (const t of ['replayOptions', 'recordingOptions', 'galleryList']) {
    assert.equal(Object.values(sdk.SDK_ACTION_CATEGORIES).flat().includes(t), false, t);
  }
  assert.equal(sdk.SDK_ACTION_CATEGORIES.capture.includes('gallery'), false);
});

test('bridge: the same categories and limits as the server, and the same answers', () => {
  const box = bridgeGate();
  assert.deepEqual(JSON.parse(JSON.stringify(box.limits)), JSON.parse(JSON.stringify(sdk.SDK_ACTION_LIMITS)));
  const grant = { actions: ['capture'] };
  for (const a of REFUSED) assert.equal(box.allowed(grant, a), false, JSON.stringify(a));
  for (const a of ALLOWED) assert.equal(box.allowed(grant, a), true, JSON.stringify(a));
  // Without the grant, nothing.
  assert.equal(box.allowed({ actions: ['media'] }, { type: 'screenshot' }), false);
});

test('manifest macros: a capture step installs, a reveal or a microphone step fails the install', () => {
  const manifest = (action) => ({
    api: 1, name: 'Clip button', actions: ['capture'],
    deck: { actions: [{ id: 'clip', name: 'Clip', steps: [{ action }] }] },
  });
  assert.equal(sdk.normalizeManifest(manifest({ type: 'replay' }), 'clip-button').ok, true);
  assert.equal(sdk.normalizeManifest(manifest({ type: 'screenshot', target: 'window' }), 'clip-button').ok, true);
  for (const a of REFUSED) assert.equal(sdk.normalizeManifest(manifest(a), 'clip-button').ok, false, JSON.stringify(a));
  // And not without declaring the category.
  const undeclared = manifest({ type: 'screenshot' });
  undeclared.actions = [];
  assert.equal(sdk.normalizeManifest(undeclared, 'clip-button').ok, false);
});

test('the permission line in 11 languages, wired in the dialog; the docs say what it never sees', () => {
  assert.match(CW, /capture: \['cw_act_capture', /);
  assert.match(CW, /pages: \['cw_act_pages', /);
  const i18n = readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8');
  assert.equal((i18n.match(/\bcw_act_capture:/g) || []).length, 11);
  const docs = readFileSync(path.join(ROOT, '..', 'docs', 'WIDGET_SDK.md'), 'utf8');
  const i = docs.indexOf('`capture` (v4.12.0)');
  assert.ok(i > 0);
  const sec = docs.slice(i, docs.indexOf('\n### ', i));
  assert.match(sec, /never sees one/);
  assert.match(sec, /not_allowed/);
  assert.match(sec, /screenText/);
});
