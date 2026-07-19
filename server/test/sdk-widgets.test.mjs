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
    description: '', surface: 'tile', background: false, island: false, badge: false,
    clipboard: false, storage: false, storageGroup: '', secrets: false,
    entry: 'index.html', streams: [], actions: [],
    hosts: [], userHosts: [], hooks: [], deck: { actions: [], states: [], handlers: [] },
  });
});

test('manifest: storage/secrets default off, opt in with booleans', () => {
  const off = sdk.normalizeManifest({ api: 1, name: 'X' }, 'x0').manifest;
  assert.equal(off.storage, false);
  assert.equal(off.secrets, false);
  assert.equal(off.storageGroup, '');
  const on = sdk.normalizeManifest({ api: 1, name: 'X', storage: true, secrets: true }, 'x0').manifest;
  assert.equal(on.storage, true);
  assert.equal(on.secrets, true);
  // Only the exact `true` literal opts in — truthy junk stays off.
  const junk = sdk.normalizeManifest({ api: 1, name: 'X', storage: 1, secrets: 'yes' }, 'x0').manifest;
  assert.equal(junk.storage, false);
  assert.equal(junk.secrets, false);
});

test('manifest: island defaults off, opts in only on the exact true literal', () => {
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X' }, 'x0').manifest.island, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', island: true }, 'x0').manifest.island, true);
  // Truthy junk stays off — same rule as storage/secrets.
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', island: 1 }, 'x0').manifest.island, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', island: 'yes' }, 'x0').manifest.island, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', island: {} }, 'x0').manifest.island, false);
});

test('manifest: badge defaults off, opts in only on the exact true literal', () => {
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X' }, 'x0').manifest.badge, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', badge: true }, 'x0').manifest.badge, true);
  // Truthy junk stays off — same rule as storage/secrets/island.
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', badge: 1 }, 'x0').manifest.badge, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', badge: 'yes' }, 'x0').manifest.badge, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', badge: {} }, 'x0').manifest.badge, false);
});

test('manifest: clipboard defaults off, opts in only on the exact true literal', () => {
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X' }, 'x0').manifest.clipboard, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', clipboard: true }, 'x0').manifest.clipboard, true);
  // Truthy junk stays off — same rule as storage/secrets/island/badge.
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', clipboard: 1 }, 'x0').manifest.clipboard, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', clipboard: 'yes' }, 'x0').manifest.clipboard, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', clipboard: {} }, 'x0').manifest.clipboard, false);
});

test('manifest: storageGroup implies storage and must be a valid id', () => {
  const g = sdk.normalizeManifest({ api: 1, name: 'X', storageGroup: 'dgm' }, 'x0').manifest;
  assert.equal(g.storageGroup, 'dgm');
  assert.equal(g.storage, true);   // group implies storage even without the flag
  // A malformed group id rejects the whole manifest (loud, like hosts/hooks).
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', storageGroup: 'Bad Group!' }, 'x0').ok, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', storageGroup: 42 }, 'x0').ok, false);
});

test('manifest: surface defaults to tile, keeps only the ambient literal', () => {
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X' }, 'x0').manifest.surface, 'tile');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', surface: 'ambient' }, 'x0').manifest.surface, 'ambient');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', surface: 'AMBIENT' }, 'x0').manifest.surface, 'tile');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', surface: 'fullscreen' }, 'x0').manifest.surface, 'tile');
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', surface: { evil: 1 } }, 'x0').manifest.surface, 'tile');
});

test('streams: weather is a declarable stream', () => {
  const r = sdk.normalizeManifest({ api: 1, name: 'X', streams: ['weather'] }, 'x0');
  assert.deepEqual(r.manifest.streams, ['weather']);
});

test('streams: rich Discord surfaces are independently declarable', () => {
  const streams = ['discord', 'discordChannels', 'discordSoundboard', 'discordNotifications'];
  const r = sdk.normalizeManifest({ api: 1, name: 'X', streams }, 'x0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.streams, streams);
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

// The `browser` category (v4.8) is dispatched in the browser, like `soundboard`:
// custom-widget.js hands browserOpen to browser-tile.js and it never reaches the
// server action registry. What must hold server-side is that the category exists,
// carries exactly one type, and is grantable through a manifest — the host-side
// dispatch is what makes it work, and the grant list lockstep is pinned by
// sdk-grant-cats-sync.test.mjs.
test('browser category: browserOpen is declarable and normalizes, and stays a lone type', () => {
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.browser], ['browserOpen']);
  const r = sdk.normalizeManifest({ api: 1, name: 'Maps', actions: ['browser'] }, 'maps');
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.actions, ['browser']);
});

// browserOpen navigates a surface the user is looking at, so it must not be
// reachable from a manifest Deck macro: the Deck validator doesn't know the type,
// and the manifest is rejected outright rather than installing a key that would
// silently do nothing when pressed.
test('browser category: a manifest deck macro using browserOpen is rejected at install', () => {
  const deck = { actions: [{ id: 'm', name: 'M', steps: [{ action: { type: 'browserOpen', url: 'https://example.com' } }] }] };
  const r = sdk.normalizeManifest({ api: 1, name: 'Maps', actions: ['browser'], deck }, 'maps');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_deck');
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

// ── userHosts: the blanks the USER fills in ─────────────────────────────────
// The author declares a labelled slot, the user types the address. The security
// claim being tested: a slot can only ever resolve to a host the manifest could
// have declared itself — so it widens WHO chooses the address, never WHAT is
// reachable. Loopback stays unreachable through a slot even when the stored
// value says otherwise (a hand-edited settings blob).

test('userHosts: valid slots normalize; malformed ones reject the manifest', () => {
  const r = sdk.normalizeManifest({
    api: 1, name: 'X',
    userHosts: [{ id: 'nas', label: 'NAS address' }, { id: 'plex', label: 'Plex server', scope: 'any' }],
  }, 'x0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.userHosts, [
    { id: 'nas', label: 'NAS address', scope: 'private' },   // scope defaults to LAN-only
    { id: 'plex', label: 'Plex server', scope: 'any' },
  ]);
  assert.deepEqual(sdk.normalizeManifest({ api: 1, name: 'X' }, 'x0').manifest.userHosts, []);
  const bad = [
    'not-an-array',
    [{ label: 'No id' }],                              // missing id
    [{ id: 'Bad Id', label: 'x' }],                    // id charset
    [{ id: 'nas' }],                                   // missing label
    [{ id: 'nas', label: '' }],
    [{ id: 'nas', label: 'x', scope: 'anything' }],    // unknown scope
    [{ id: 'nas', label: 'x' }, { id: 'nas', label: 'y' }],   // duplicate id
    ['nas'],                                           // not an object
    [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' },
      { id: 'd', label: 'd' }, { id: 'e', label: 'e' }],      // > 4
  ];
  for (const userHosts of bad) {
    assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', userHosts }, 'x0').reason, 'bad_user_hosts', JSON.stringify(userHosts));
  }
});

const SLOTTED = sdk.normalizeManifest({
  api: 1, name: 'X', hosts: ['api.example.com'],
  userHosts: [{ id: 'nas', label: 'NAS' }, { id: 'srv', label: 'Server', scope: 'any' }],
}, 'x0').manifest;

test('userHosts: resolve keeps good values, drops what the manifest would never allow', () => {
  const r = sdk.resolveUserHosts(SLOTTED, {
    nas: { host: '192.168.1.50', port: 32400, scheme: 'http' },
    srv: { host: 'plex.example.com', port: 0, scheme: 'https' },
  });
  assert.deepEqual(r.hosts, ['192.168.1.50', 'plex.example.com']);
  assert.equal(r.byId.nas.base, 'http://192.168.1.50:32400');
  assert.equal(r.byId.srv.base, 'https://plex.example.com');

  // Every value a tampered grant could carry that the manifest itself could not
  // legally declare. Each must vanish — no host, no slot.
  const rejected = {
    loopback: { nas: { host: '127.0.0.1' } },
    localhost: { nas: { host: 'localhost' } },
    linkLocal: { nas: { host: '169.254.1.1' } },
    unspecified: { nas: { host: '0.0.0.0' } },
    // 'private' scope pins the slot to LAN space: a public host can't sneak in.
    publicInPrivateSlot: { nas: { host: 'evil.example.com' } },
    badCharset: { nas: { host: 'not a host' } },
    ipv6: { nas: { host: '::1' } },
    notAnObject: { nas: 'evil.example.com' },
    // A slot the manifest never declared can't be conjured by the grant.
    undeclared: { ghost: { host: '192.168.1.9' } },
  };
  for (const [why, granted] of Object.entries(rejected)) {
    const out = sdk.resolveUserHosts(SLOTTED, granted);
    assert.deepEqual(out.hosts, [], why);
    assert.deepEqual(Object.keys(out.byId), [], why);
  }
});

test('userHosts: base mirrors the proxy https rule and clamps the port', () => {
  const base = (id, v) => (sdk.resolveUserHosts(SLOTTED, { [id]: v }).byId[id] || {}).base;
  // Public host in an 'any' slot: always https, whatever was stored.
  assert.equal(base('srv', { host: 'plex.example.com', scheme: 'http' }), 'https://plex.example.com');
  // LAN keeps the user's choice, defaulting to http (LAN gear rarely has TLS).
  assert.equal(base('nas', { host: 'nas.local' }), 'http://nas.local');
  assert.equal(base('nas', { host: 'nas.local', scheme: 'https' }), 'https://nas.local');
  // Out-of-range / junk ports collapse to "no port", never into the base string.
  for (const port of [0, -1, 70000, 1.5, '8080', null]) {
    assert.equal(base('nas', { host: 'nas.local', port }), 'http://nas.local', String(port));
  }
  assert.equal(base('nas', { host: 'nas.local', port: 65535 }), 'http://nas.local:65535');
});

test('proxy: a filled slot is reachable, an empty one is not', () => {
  const filled = sdk.resolveUserHosts(SLOTTED, { nas: { host: '192.168.1.50', port: 32400 } });
  // The manifest's own declared host still works, with or without slots.
  assert.equal(sdk.validateProxyRequest(SLOTTED, { url: 'https://api.example.com/' }, filled.hosts).ok, true);
  // The address the user typed is reachable — over plain http, it's LAN.
  assert.equal(sdk.validateProxyRequest(SLOTTED, { url: 'http://192.168.1.50:32400/library' }, filled.hosts).ok, true);
  // Same package, no address filled in → the host is not allowed.
  assert.equal(sdk.validateProxyRequest(SLOTTED, { url: 'http://192.168.1.50:32400/library' }, []).error, 'host_not_allowed');
  // A slot NEVER re-opens the kill-switch, even if extraHosts is lied to.
  assert.equal(sdk.validateProxyRequest(SLOTTED, { url: 'http://127.0.0.1:3030/settings' }, ['127.0.0.1']).error, 'host_not_allowed');
  // An omitted extraHosts argument must behave exactly like the old two-arg call.
  assert.equal(sdk.validateProxyRequest(SLOTTED, { url: 'http://192.168.1.50/x' }).error, 'host_not_allowed');
  assert.equal(sdk.validateProxyRequest(SLOTTED, { url: 'https://api.example.com/' }).ok, true);
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

// ── manifest handlers (code-run deck keys) + background flag ─────────────────

test('handlers: valid handlers with declared params normalize; params coerced key-by-key', () => {
  const r = sdk.normalizeManifest({
    api: 1, name: 'X',
    deck: { handlers: [
      { id: 'ping', name: 'Ping' },
      { id: 'post', name: 'Post message', params: [
        { name: 'text', label: 'Messaggio', kind: 'text', extra: 'dropped' },
        { name: 'channel', kind: 'select', options: ['general', 'alerts'] },
        { name: 'count', kind: 'number', min: 1, max: 10 },
      ] },
    ] },
  }, 'x0');
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.deck.handlers[0], { id: 'ping', name: 'Ping', params: [] });
  const post = r.manifest.deck.handlers[1];
  assert.deepEqual(post.params[0], { name: 'text', label: 'Messaggio', kind: 'text' });
  assert.deepEqual(post.params[1], { name: 'channel', label: 'channel', kind: 'select', options: ['general', 'alerts'] });
  assert.deepEqual(post.params[2], { name: 'count', label: 'count', kind: 'number', min: 1, max: 10 });
});

test('handlers: hostile shapes reject the whole manifest', () => {
  const badHandlerSets = [
    [{ id: 'BAD ID', name: 'X' }],
    [{ id: 'x', name: '' }],
    [{ id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }],
    new Array(9).fill(null).map((_, i) => ({ id: `h${i}`, name: 'H' })),          // > MAX_HANDLERS
    [{ id: 'x', name: 'X', params: 'nope' }],
    [{ id: 'x', name: 'X', params: [{ name: 'BAD NAME', kind: 'text' }] }],
    [{ id: 'x', name: 'X', params: [{ name: 'a', kind: 'evil' }] }],
    [{ id: 'x', name: 'X', params: [{ name: 'a', kind: 'select', options: [] }] }],
    [{ id: 'x', name: 'X', params: [{ name: 'a', kind: 'select' }] }],
    [{ id: 'x', name: 'X', params: [{ name: 'a', kind: 'number', min: 10, max: 1 }] }],
    [{ id: 'x', name: 'X', params: new Array(5).fill(null).map((_, i) => ({ name: `p${i}`, kind: 'text' })) }],  // > MAX_HANDLER_PARAMS
  ];
  for (const handlers of badHandlerSets) {
    assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', deck: { handlers } }, 'x0').reason, 'bad_deck', JSON.stringify(handlers));
  }
});

// Only handlers and badges outlive a tile, so only they justify a headless
// service frame — background without either is meaningless and normalizes off.
test('background: true only survives alongside declared handlers or a badge', () => {
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', background: true }, 'x0').manifest.background, false);
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', background: 'yes' }, 'x0').manifest.background, false);
  const withHandlers = sdk.normalizeManifest({
    api: 1, name: 'X', background: true,
    deck: { handlers: [{ id: 'go', name: 'Go' }] },
  }, 'x0');
  assert.equal(withHandlers.manifest.background, true);
  // A badge-only package: the chip must keep refreshing with no tile on screen.
  const withBadge = sdk.normalizeManifest({ api: 1, name: 'X', background: true, badge: true }, 'x0');
  assert.equal(withBadge.manifest.background, true);
  // …but the badge must be the real literal, not truthy junk.
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'X', background: true, badge: 1 }, 'x0').manifest.background, false);
});

test('validateHandlerArgs: coerces declared params, rejects unparseable input, drops undeclared keys', () => {
  const handler = { id: 'post', name: 'Post', params: [
    { name: 'text', label: 'Text', kind: 'text' },
    { name: 'channel', label: 'Ch', kind: 'select', options: ['general', 'alerts'] },
    { name: 'count', label: 'N', kind: 'number', min: 1, max: 10 },
  ] };
  assert.deepEqual(sdk.validateHandlerArgs(handler, '{"text":"hi","channel":"alerts","count":99,"evil":"x"}'),
    { text: 'hi', channel: 'alerts', count: 10 });
  // Missing/invalid values fall back to defaults; empty args still fire.
  assert.deepEqual(sdk.validateHandlerArgs(handler, ''), { text: '', channel: 'general', count: 1 });
  assert.deepEqual(sdk.validateHandlerArgs(handler, { channel: 'nope', count: 'NaN' }), { text: '', channel: 'general', count: 1 });
  // Long text capped, unparseable JSON / non-object input rejected loud.
  assert.equal(sdk.validateHandlerArgs(handler, '{"text":"' + 'a'.repeat(500) + '"}').text.length, 200);
  assert.equal(sdk.validateHandlerArgs(handler, '{broken'), null);
  assert.equal(sdk.validateHandlerArgs(handler, '[1,2]'), null);
  // A handler with no params always yields an empty map.
  assert.deepEqual(sdk.validateHandlerArgs({ id: 'ping', name: 'P', params: [] }, '{"a":1}'), {});
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

// ── Origin policy: only the user's own work is re-exportable ─────────────────

test('origin: mergeOrigin keeps ownership sticky and defaults hostile input to import', () => {
  // Fresh id (no prior record): the install's own origin wins.
  assert.equal(sdk.mergeOrigin(null, 'import'), 'import');
  assert.equal(sdk.mergeOrigin(null, 'creator'), 'creator');
  assert.equal(sdk.mergeOrigin(null, 'builtin'), 'builtin');
  // Ownership is never demoted: the author updating their own widget from the
  // catalog (import path) stays the author; a local dev folder stays local.
  assert.equal(sdk.mergeOrigin('creator', 'import'), 'creator');
  assert.equal(sdk.mergeOrigin('local', 'import'), 'local');
  // An import is sticky too: a later 'creator' claim can NOT launder an already
  // imported package into "your own work" (the replayable /sdk/install trick).
  assert.equal(sdk.mergeOrigin('import', 'creator'), 'import');
  // A creator claim still wins over the bundled example / a fresh id.
  assert.equal(sdk.mergeOrigin('builtin', 'creator'), 'creator');
  // Imports stay imports.
  assert.equal(sdk.mergeOrigin('import', 'import'), 'import');
  // Hostile/unknown next origin collapses to import (fail-closed).
  assert.equal(sdk.mergeOrigin(null, 'owner'), 'import');
  assert.equal(sdk.mergeOrigin(null, { evil: 1 }), 'import');
  assert.equal(sdk.mergeOrigin('nonsense', 'import'), 'import');
});

test('origin: originExportable allows only the user\'s own creations (fail-closed)', () => {
  assert.equal(sdk.originExportable('creator'), true);
  assert.equal(sdk.originExportable('local'), true);    // dev folder explicitly claimed
  assert.equal(sdk.originExportable('import'), false);
  assert.equal(sdk.originExportable('builtin'), false);
  // Anything unattributed defaults to NOT exportable — never leak others' work.
  assert.equal(sdk.originExportable('unknown'), false);
  assert.equal(sdk.originExportable(null), false);
  assert.equal(sdk.originExportable(undefined), false);
});

// ── Performance probe: reserved asset + HTML injection ───────────────────────

test('probe: the reserved filename is never resolvable from a package on disk', () => {
  assert.equal(sdk.resolveAsset(ROOT, 'clock', sdk.PERF_PROBE_FILENAME), null);
  assert.equal(sdk.resolveAsset(ROOT, 'clock', 'assets/' + sdk.PERF_PROBE_FILENAME), null);
});

test('probe: a bundled file under the reserved name is dropped, the rest installs', () => {
  const r = sdk.validateWidgetPayload({ id: 'hi-widget', files: [
    { path: 'manifest.json', data: goodManifest() },
    { path: 'index.html', data: b64('<!doctype html><body>hi') },
    { path: sdk.PERF_PROBE_FILENAME, data: b64('evil()') },
    { path: 'assets/' + sdk.PERF_PROBE_FILENAME, data: b64('evil()') },
  ] });
  assert.equal(r.ok, true);
  assert.ok(!r.files.some(f => f.relPath.endsWith(sdk.PERF_PROBE_FILENAME)));
  assert.equal(r.files.length, 2);
});

test('probe: injectPerfProbe lands right after <head>, exactly once', () => {
  const tag = `<script src="${sdk.PERF_PROBE_FILENAME}" defer></script>`;
  const out = sdk.injectPerfProbe('<!doctype html><html><head lang="en"><title>x</title></head><body></body></html>');
  assert.ok(out.includes('<head lang="en">' + tag));
  assert.equal(out.split(tag).length - 1, 1);
});

test('probe: injectPerfProbe falls back before </body>, then to append', () => {
  const tag = `<script src="${sdk.PERF_PROBE_FILENAME}" defer></script>`;
  assert.ok(sdk.injectPerfProbe('<body>hi</body>').includes(tag + '</body>'));
  const bare = sdk.injectPerfProbe('hello');
  assert.equal(bare, 'hello' + tag);
  assert.equal(sdk.injectPerfProbe(null), tag);
});

test('probe: PERF_PROBE_SOURCE parses and cannot break out of a script tag', () => {
  assert.ok(sdk.PERF_PROBE_SOURCE.length > 0);
  assert.ok(!sdk.PERF_PROBE_SOURCE.includes('</script'));
  assert.doesNotThrow(() => new Function(sdk.PERF_PROBE_SOURCE));
});
