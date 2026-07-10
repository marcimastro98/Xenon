import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ambient = require('../js/ambient-mode.js');

// (idleMinutes clamping lives in normalizeAmbientMode — settings.js/server.js
// mirrors, exercised via the settings round-trip; ambient-mode.js trusts the
// already-normalized value.)

// ── resolveAmbientScene ──────────────────────────────────────────────────────

const scenePkg = { id: 'starfield', surface: 'ambient', name: 'Starfield', entry: 'index.html' };
const tilePkg = { id: 'clock', surface: 'tile', name: 'Clock', entry: 'index.html' };

test('resolveScene: builtin id resolves to builtin', () => {
  assert.deepEqual(ambient.resolveAmbientScene({ sceneId: 'builtin' }, [scenePkg], true), { builtin: true });
});

test('resolveScene: installed ambient package resolves', () => {
  const r = ambient.resolveAmbientScene({ sceneId: 'starfield' }, [tilePkg, scenePkg], true);
  assert.equal(r.builtin, false);
  assert.equal(r.pkg, scenePkg);
});

test('resolveScene: missing package falls back to builtin with reason', () => {
  const r = ambient.resolveAmbientScene({ sceneId: 'gone' }, [scenePkg], true);
  assert.deepEqual(r, { builtin: true, fallback: 'missing' });
});

test('resolveScene: a tile package cannot be a scene', () => {
  const r = ambient.resolveAmbientScene({ sceneId: 'clock' }, [tilePkg], true);
  assert.deepEqual(r, { builtin: true, fallback: 'missing' });
});

test('resolveScene: SDK off falls back to builtin', () => {
  const r = ambient.resolveAmbientScene({ sceneId: 'starfield' }, [scenePkg], false);
  assert.deepEqual(r, { builtin: true, fallback: 'sdk_off' });
});

test('resolveScene: junk config resolves to builtin', () => {
  assert.equal(ambient.resolveAmbientScene(null, [], true).builtin, true);
  assert.equal(ambient.resolveAmbientScene({ sceneId: 42 }, [], true).builtin, true);
  assert.equal(ambient.resolveAmbientScene({}, null, true).builtin, true);
});

// ── ambientIdleSuppressed ────────────────────────────────────────────────────

const idleOk = { enabled: true, idleMinutes: 5, open: false, hidden: false, fullscreen: false, busyBodyClass: false, overlayOpen: false };

test('idle suppression: clean idle state is not suppressed', () => {
  assert.equal(ambient.ambientIdleSuppressed(idleOk), false);
});

test('idle suppression: each blocker suppresses on its own', () => {
  assert.equal(ambient.ambientIdleSuppressed({ ...idleOk, enabled: false }), true);
  assert.equal(ambient.ambientIdleSuppressed({ ...idleOk, idleMinutes: 0 }), true);
  assert.equal(ambient.ambientIdleSuppressed({ ...idleOk, open: true }), true);
  assert.equal(ambient.ambientIdleSuppressed({ ...idleOk, hidden: true }), true);
  assert.equal(ambient.ambientIdleSuppressed({ ...idleOk, fullscreen: true }), true);
  assert.equal(ambient.ambientIdleSuppressed({ ...idleOk, busyBodyClass: true }), true);
  assert.equal(ambient.ambientIdleSuppressed({ ...idleOk, overlayOpen: true }), true);
});

test('idle suppression: null/garbage state suppresses (fail closed)', () => {
  assert.equal(ambient.ambientIdleSuppressed(null), true);
  assert.equal(ambient.ambientIdleSuppressed(undefined), true);
  assert.equal(ambient.ambientIdleSuppressed({}), true);
});
