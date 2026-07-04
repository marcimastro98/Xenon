import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sdk = require('../sdk-widgets.js');

const ROOT = path.join('C:', 'data', 'widgets');

// ── normalizeManifest: hostile input collapses, never spreads ────────────────

test('manifest: valid minimal manifest normalizes', () => {
  const r = sdk.normalizeManifest({ api: 1, name: 'Clock' }, 'clock');
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest, {
    id: 'clock', api: 1, name: 'Clock', version: '0.0.0', author: '',
    description: '', entry: 'index.html', streams: [], actions: [],
  });
});

test('manifest: unknown streams/actions dropped, dupes deduped, extras never survive', () => {
  const r = sdk.normalizeManifest({
    api: 1, name: 'X',
    streams: ['system', 'system', 'settings', 'deck', 'media', 42],
    actions: ['media', 'openApp', 'hotkey', 'webhook', 'media', 'url'],
    __proto__: { evil: true },
    constructor: 'x',
    extraKey: 'must not survive',
  }, 'x0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.streams, ['system', 'media']);
  assert.deepEqual(r.manifest.actions, ['media', 'url']);
  assert.equal('extraKey' in r.manifest, false);
  assert.equal('evil' in r.manifest, false);
});

test('manifest: rejects wrong api, bad id, id spoofing, bad entry', () => {
  assert.equal(sdk.normalizeManifest({ api: 2, name: 'X' }, 'x0').reason, 'unsupported_api');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X' }, '..').reason, 'bad_id');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X' }, 'A B').reason, 'bad_id');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', id: 'other' }, 'x0').reason, 'id_mismatch');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', entry: '../index.html' }, 'x0').reason, 'bad_entry');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', entry: 'app.js' }, 'x0').reason, 'bad_entry');
  assert.equal(sdk.normalizeManifest({ api: 1, name: '' }, 'x0').reason, 'missing_name');
  assert.equal(sdk.normalizeManifest(null, 'x0').reason, 'bad_manifest');
  assert.equal(sdk.normalizeManifest([], 'x0').reason, 'bad_manifest');
});

test('manifest: long strings are capped', () => {
  const r = sdk.normalizeManifest({ api: 1, name: 'N'.repeat(500), description: 'D'.repeat(500) }, 'x0');
  assert.equal(r.manifest.name.length, 60);
  assert.equal(r.manifest.description.length, 200);
});

// ── resolveAsset: the path trust boundary ────────────────────────────────────

test('resolveAsset: happy paths resolve under the package dir', () => {
  const a = sdk.resolveAsset(ROOT, 'clock', 'index.html');
  assert.equal(a, path.join(ROOT, 'clock', 'index.html'));
  const b = sdk.resolveAsset(ROOT, 'clock', 'assets/img.png');
  assert.equal(b, path.join(ROOT, 'clock', 'assets', 'img.png'));
});

test('resolveAsset: traversal and hostile shapes are rejected', () => {
  const bad = [
    ['clock', '../../settings.json'],
    ['clock', '..%2f..%2fsettings.json'],          // decodes to ../..
    ['clock', '%2e%2e/settings.json'],
    ['clock', 'a\\b.js'],
    ['clock', '/abs.js'],
    ['clock', 'a//b.js'],
    ['clock', 'nul\0.js'],
    ['clock', 'file.exe'],
    ['clock', 'file.ps1'],
    ['clock', 'noextension'],
    ['clock', 'manifest.json/'],
    ['..', 'index.html'],
    ['CLOCK', 'index.html'],                        // uppercase id not allowed
    ['clock', '%zz.html'],                          // malformed encoding
    ['clock', 'a/b/c/d/e/f/g/h/i.js'],              // too deep
  ];
  for (const [id, rel] of bad) {
    assert.equal(sdk.resolveAsset(ROOT, id, rel), null, `${id} / ${rel} must be rejected`);
  }
});

// ── The served CSP is the network kill-switch — never weaken it ─────────────

test('CSP: keeps the sandbox and blocks all network', () => {
  assert.match(sdk.WIDGET_CSP, /connect-src 'none'/);
  assert.match(sdk.WIDGET_CSP, /sandbox allow-scripts/);
  assert.match(sdk.WIDGET_CSP, /default-src 'none'/);
  // No allow-same-origin: the widget document must keep an opaque origin.
  assert.doesNotMatch(sdk.WIDGET_CSP, /allow-same-origin/);
});

test('action categories only expose the intended low-risk deck actions', () => {
  const allTypes = Object.values(sdk.SDK_ACTION_CATEGORIES).flat();
  const forbidden = ['openApp', 'openFile', 'openStoreApp', 'hotkey', 'webhook'];
  for (const type of forbidden) {
    assert.equal(allTypes.includes(type), false, `${type} must not be reachable from SDK widgets`);
  }
});
