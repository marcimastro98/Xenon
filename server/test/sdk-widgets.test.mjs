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
    hosts: [], hooks: [], deck: { actions: [], states: [] },
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

// ── manifest hosts: the proxy allowlist boundary ─────────────────────────────

test('hosts: valid hosts normalize (lowercased, deduped); loopback rejects the manifest', () => {
  const r = sdk.normalizeManifest({ api: 1, name: 'X', hosts: ['API.Example.com', 'api.example.com', '192.168.1.5'] }, 'x0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.hosts, ['api.example.com', '192.168.1.5']);
  const bad = [
    ['localhost'], ['sub.localhost'], ['127.0.0.1'], ['127.9.9.9'], ['0.0.0.0'],
    ['169.254.1.1'], ['::1'], ['[::1]'], ['api.example.com/path'], ['http://x.com'],
    ['a'.repeat(300)], ['-bad.com'], [''], [42], 'not-an-array',
    ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com'],  // > 8
  ];
  for (const hosts of bad) {
    assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', hosts }, 'x0').reason, 'bad_hosts', JSON.stringify(hosts));
  }
});

test('isPrivateNetworkHost: LAN literals/.local/single-label yes, public no', () => {
  for (const h of ['192.168.0.10', '10.1.2.3', '172.16.0.1', '172.31.9.9', 'nas.local', 'printer']) {
    assert.equal(sdk.isPrivateNetworkHost(h), true, h);
  }
  for (const h of ['172.32.0.1', '8.8.8.8', 'api.example.com', 'local.example.com']) {
    assert.equal(sdk.isPrivateNetworkHost(h), false, h);
  }
});

// ── validateProxyRequest: every rule the /sdk/fetch route relies on ──────────

const MANIFEST = sdk.normalizeManifest({
  api: 1, name: 'X', hosts: ['api.example.com', '192.168.1.5'],
}, 'x0').manifest;

test('proxy: allowed https request passes with rebuilt headers', () => {
  const r = sdk.validateProxyRequest(MANIFEST, {
    url: 'https://api.example.com/v1?q=1',
    method: 'post',
    headers: { Accept: 'application/json', 'X-Api-Key': 'k', Cookie: undefined },
    body: '{"a":1}',
  });
  assert.equal(r.ok, false);   // Cookie is not an allowlisted header name
  const ok = sdk.validateProxyRequest(MANIFEST, {
    url: 'https://api.example.com/v1?q=1',
    method: 'post',
    headers: { Accept: 'application/json', 'X-Api-Key': 'k' },
    body: '{"a":1}',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.method, 'POST');
  assert.deepEqual(ok.headers, { accept: 'application/json', 'x-api-key': 'k' });
});

test('proxy: scheme/host/injection rules', () => {
  const err = (raw) => sdk.validateProxyRequest(MANIFEST, raw).error;
  assert.equal(err({ url: 'https://other.example.com/' }), 'host_not_allowed');
  assert.equal(err({ url: 'https://127.0.0.1:3030/settings' }), 'host_not_allowed');
  assert.equal(err({ url: 'http://api.example.com/' }), 'https_required');      // public host → https only
  assert.equal(sdk.validateProxyRequest(MANIFEST, { url: 'http://192.168.1.5/api' }).ok, true);  // LAN → http fine
  assert.equal(err({ url: 'ftp://api.example.com/' }), 'bad_scheme');
  assert.equal(err({ url: 'https://user:pw@api.example.com/' }), 'bad_url');
  assert.equal(err({ url: 'https://api.example.com/', headers: { accept: 'x\r\nHost: evil' } }), 'bad_headers');
  assert.equal(err({ url: 'https://api.example.com/', method: 'TRACE' }), 'bad_method');
  assert.equal(err({ url: 'https://api.example.com/', method: 'GET', body: 'x' }), 'bad_body');
  assert.equal(err({ url: 'https://api.example.com/', method: 'POST', body: 'x'.repeat(300000) }), 'body_too_large');
});

// ── manifest hooks + deck extras ─────────────────────────────────────────────

test('hooks: valid ids pass; bad ids/overflow reject the manifest', () => {
  const r = sdk.normalizeManifest({ api: 1, name: 'X', hooks: ['my-event', 'other'] }, 'x0');
  assert.deepEqual(r.manifest.hooks, ['my-event', 'other']);
  for (const hooks of [['UPPER'], ['a b'], ['../x'], [''], 'nope']) {
    assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', hooks }, 'x0').reason, 'bad_hooks', JSON.stringify(hooks));
  }
});

test('deck: macros rebuilt through the catalog validator; forbidden step types reject', () => {
  const good = sdk.normalizeManifest({
    api: 1, name: 'X', actions: ['volume', 'mic'],
    deck: {
      actions: [{ id: 'quiet', name: 'Quiet', steps: [
        { action: { type: 'volume', mode: 'mute', extra: 'dropped' }, delayMs: 999999 },
        { action: { type: 'micMute', mode: 'mute' } },
      ] }],
      states: [{ id: 'alert', name: 'Alert' }],
    },
  }, 'x0');
  assert.equal(good.ok, true);
  const macro = good.manifest.deck.actions[0];
  assert.deepEqual(macro.steps[0].action, { type: 'volume', mode: 'mute' });   // extras never survive
  assert.equal(macro.steps[0].delayMs, 5000);                                  // clamped to the SDK macro-step cap
  assert.deepEqual(sdk.macroCategories(macro), ['volume', 'mic']);
  const badDecks = [
    { actions: [{ id: 'x', name: 'X', steps: [{ action: { type: 'openApp', path: 'C:/evil.exe' } }] }] },
    { actions: [{ id: 'x', name: 'X', steps: [{ action: { type: 'hotkey', keys: 'ctrl+a' } }] }] },
    { actions: [{ id: 'x', name: 'X', steps: [{ action: { type: 'sdkMacro', macro: 'x/x' } }] }] },  // no nesting
    { actions: [{ id: 'x', name: 'X', steps: [] }] },
    { actions: [{ id: 'x', name: 'X', steps: new Array(11).fill({ action: { type: 'media', cmd: 'next' } }) }] },
    { actions: [{ id: 'x', name: '', steps: [{ action: { type: 'media', cmd: 'next' } }] }] },
    { actions: [{ id: 'BAD ID', name: 'X', steps: [{ action: { type: 'media', cmd: 'next' } }] }] },
    { states: [{ id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }] },
    { states: 'nope' },
  ];
  for (const deck of badDecks) {
    assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', actions: ['media'], deck }, 'x0').reason, 'bad_deck', JSON.stringify(deck));
  }
  // A macro whose step category is NOT in the manifest's declared `actions` is
  // rejected (otherwise the user is never asked to grant it → macro_unavailable).
  const undeclared = sdk.normalizeManifest({
    api: 1, name: 'X', actions: ['media'],
    deck: { actions: [{ id: 'q', name: 'Q', steps: [{ action: { type: 'micMute', mode: 'mute' } }] }] },
  }, 'x0');
  assert.equal(undeclared.reason, 'bad_deck');
});

// ── validateWidgetPayload: the bundle-install boundary (files over the wire) ──
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const goodManifest = () => b64(JSON.stringify({ api: 1, name: 'Hi', entry: 'index.html', actions: ['media'] }));
const goodPayload = () => ({ id: 'hi-widget', files: [
  { path: 'manifest.json', data: goodManifest() },
  { path: 'index.html', data: b64('<!doctype html><body>hi') },
  { path: 'assets/logo.png', data: b64('x') },
] });

test('payload: a well-formed package validates and rebuilds its manifest', () => {
  const r = sdk.validateWidgetPayload(goodPayload());
  assert.equal(r.ok, true);
  assert.equal(r.id, 'hi-widget');
  assert.equal(r.manifest.name, 'Hi');
  assert.equal(r.files.length, 3);
  assert.ok(r.files.every(f => Buffer.isBuffer(f.bytes)));
});

test('payload: rejects bad id, missing manifest, missing entry', () => {
  assert.equal(sdk.validateWidgetPayload({ id: 'BAD ID', files: [{ path: 'manifest.json', data: goodManifest() }] }).reason, 'bad_id');
  assert.equal(sdk.validateWidgetPayload({ id: 'hi-widget', files: [{ path: 'index.html', data: b64('x') }] }).reason, 'missing_manifest');
  assert.equal(sdk.validateWidgetPayload({ id: 'hi-widget', files: [{ path: 'manifest.json', data: goodManifest() }] }).reason, 'missing_entry');
});

test('payload: rejects traversal, backslash, absolute paths and disallowed extensions', () => {
  for (const p of ['../evil.js', 'a/../b.js', '..\\evil.js', '/etc/passwd', 'run.exe', 'x.php']) {
    const r = sdk.validateWidgetPayload({ id: 'hi-widget', files: [
      { path: 'manifest.json', data: goodManifest() },
      { path: 'index.html', data: b64('x') },
      { path: p, data: b64('x') },
    ] });
    assert.equal(r.reason, 'bad_path', `must reject ${p}`);
  }
});

test('payload: rejects duplicate paths and an over-large file', () => {
  assert.equal(sdk.validateWidgetPayload({ id: 'hi-widget', files: [
    { path: 'manifest.json', data: goodManifest() },
    { path: 'index.html', data: b64('x') },
    { path: 'index.html', data: b64('y') },
  ] }).reason, 'bad_path');
  assert.equal(sdk.validateWidgetPayload({ id: 'hi-widget', files: [
    { path: 'manifest.json', data: goodManifest() },
    { path: 'index.html', data: b64('x') },
    { path: 'big.txt', data: b64('A'.repeat(600 * 1024)) },
  ] }).reason, 'file_too_large');
});

test('payload: a manifest whose id spoofs another folder is rejected', () => {
  const spoof = b64(JSON.stringify({ api: 1, id: 'other-pkg', name: 'X', entry: 'index.html' }));
  const r = sdk.validateWidgetPayload({ id: 'hi-widget', files: [
    { path: 'manifest.json', data: spoof },
    { path: 'index.html', data: b64('x') },
  ] });
  assert.equal(r.reason, 'id_mismatch');
});
