import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const store = require('../sdk-store.js');

// ── Key/value store: caps + purity ──────────────────────────────────────────

test('store: set then get round-trips a JSON value without mutating the input', () => {
  const cur = {};
  const set = store.applyStoreOp(cur, { op: 'set', key: 'teams', value: [1, 2, 3] });
  assert.equal(set.ok, true);
  assert.equal(set.changed, true);
  assert.deepEqual(cur, {});                       // pure — original untouched
  const get = store.applyStoreOp(set.store, { op: 'get', key: 'teams' });
  assert.deepEqual(get.value, [1, 2, 3]);
  assert.equal(get.changed, false);
});

test('store: get of a missing key is null, delete of a missing key is a no-op', () => {
  assert.equal(store.applyStoreOp({}, { op: 'get', key: 'nope' }).value, null);
  const d = store.applyStoreOp({}, { op: 'delete', key: 'nope' });
  assert.equal(d.ok, true);
  assert.equal(d.changed, false);
});

test('store: keys lists, clear empties', () => {
  const s = { a: 1, b: 2 };
  assert.deepEqual(store.applyStoreOp(s, { op: 'keys' }).keys.sort(), ['a', 'b']);
  const c = store.applyStoreOp(s, { op: 'clear' });
  assert.deepEqual(c.store, {});
  assert.equal(c.changed, true);
  assert.equal(store.applyStoreOp({}, { op: 'clear' }).changed, false);   // already empty
});

test('store: bad op / bad key / non-JSON value are rejected', () => {
  assert.equal(store.applyStoreOp({}, { op: 'nuke' }).error, 'bad_op');
  assert.equal(store.applyStoreOp({}, { op: 'set', key: '../x', value: 1 }).error, 'bad_key');
  assert.equal(store.applyStoreOp({}, { op: 'set', key: 'k', value: undefined }).error, 'bad_value');
  const cyc = {}; cyc.self = cyc;
  assert.equal(store.applyStoreOp({}, { op: 'set', key: 'k', value: cyc }).error, 'bad_value');
});

test('store: value size, key count and total size caps hold', () => {
  const big = 'x'.repeat(store.STORE_MAX_VALUE_BYTES + 1);
  assert.equal(store.applyStoreOp({}, { op: 'set', key: 'k', value: big }).error, 'value_too_large');

  let s = {};
  for (let i = 0; i < store.STORE_MAX_KEYS; i++) s['k' + i] = 1;
  assert.equal(store.applyStoreOp(s, { op: 'set', key: 'overflow', value: 1 }).error, 'too_many_keys');
  // Overwriting an existing key at the cap is still allowed (no new key).
  assert.equal(store.applyStoreOp(s, { op: 'set', key: 'k0', value: 2 }).ok, true);
});

// ── Secret vault: write-only, never leaks a value ───────────────────────────

test('secret: set/has/names never expose a value; delete works', () => {
  const set = store.applySecretOp({}, { op: 'set', name: 'apikey', value: 'super-secret' });
  assert.equal(set.ok, true);
  assert.equal(set.secrets.apikey, 'super-secret');
  // `has` and `names` are the ONLY reads, and neither returns the value.
  const has = store.applySecretOp(set.secrets, { op: 'has', name: 'apikey' });
  assert.equal(has.has, true);
  assert.equal('value' in has, false);
  const names = store.applySecretOp(set.secrets, { op: 'names' });
  assert.deepEqual(names.names, ['apikey']);
  assert.equal('value' in names, false);
  // There is deliberately no 'get' op.
  assert.equal(store.applySecretOp(set.secrets, { op: 'get', name: 'apikey' }).error, 'bad_op');
  const del = store.applySecretOp(set.secrets, { op: 'delete', name: 'apikey' });
  assert.deepEqual(del.secrets, {});
});

test('secret: rejects CRLF-bearing values, oversize values and too many secrets', () => {
  assert.equal(store.applySecretOp({}, { op: 'set', name: 'k', value: 'a\r\nb' }).error, 'bad_value');
  assert.equal(store.applySecretOp({}, { op: 'set', name: 'k', value: 123 }).error, 'bad_value');
  const big = 'x'.repeat(store.SECRET_MAX_VALUE_BYTES + 1);
  assert.equal(store.applySecretOp({}, { op: 'set', name: 'k', value: big }).error, 'value_too_large');
  let s = {};
  for (let i = 0; i < store.SECRET_MAX_COUNT; i++) s['s' + i] = 'v';
  assert.equal(store.applySecretOp(s, { op: 'set', name: 'more', value: 'v' }).error, 'too_many_secrets');
});

// ── Secret placeholder resolution in proxy requests ─────────────────────────

test('resolveSecretsInText: substitutes known, hard-errors unknown', () => {
  const secrets = { apikey: 'K1', token: 'T2' };
  assert.deepEqual(store.resolveSecretsInText('key={{secret:apikey}}&t={{ secret:token }}', secrets),
    { ok: true, text: 'key=K1&t=T2' });
  assert.deepEqual(store.resolveSecretsInText('plain text, no tokens', secrets), { ok: true, text: 'plain text, no tokens' });
  const bad = store.resolveSecretsInText('{{secret:missing}}', secrets);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_secret');
});

test('resolveProxySecrets: fills url/headers/body, pins the host', () => {
  const secrets = { apikey: 'K1' };
  const hosts = ['api.football-data.org'];
  const req = {
    url: 'https://api.football-data.org/v4/matches',
    method: 'GET',
    headers: { 'x-auth-token': '{{secret:apikey}}', accept: 'application/json' },
    body: '',
  };
  const r = store.resolveProxySecrets(req, secrets, hosts);
  assert.equal(r.ok, true);
  assert.equal(r.req.headers['x-auth-token'], 'K1');
  assert.equal(r.req.headers.accept, 'application/json');
});

test('resolveProxySecrets: a secret can never move the request to a new host', () => {
  // Even if a stored secret were a full URL, substitution in the URL is re-parsed
  // and the host must stay the original, allowlisted one.
  const secrets = { evil: 'evil.example.com/x?a=' };
  const hosts = ['api.football-data.org'];
  const req = {
    url: 'https://api.football-data.org/v4/{{secret:evil}}',   // host unchanged by design
    method: 'GET', headers: {}, body: '',
  };
  const ok = store.resolveProxySecrets(req, secrets, hosts);
  assert.equal(ok.ok, true);                       // path grows but host is pinned
  assert.equal(new URL(ok.req.url).hostname, 'api.football-data.org');

  // A placeholder that references an unknown secret is a hard error, never a
  // silently-dropped credential.
  const bad = store.resolveProxySecrets(
    { url: 'https://api.football-data.org/{{secret:nope}}', method: 'GET', headers: {}, body: '' },
    secrets, hosts);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_secret');
});

// A key carried in a PATH segment (TheSportsDB V1: /api/v1/json/<key>/...) is
// the case that used to ship the literal token to the provider: validateProxyRequest
// serialises the URL, and `{`/`}` are in the WHATWG path percent-encode set, so the
// placeholder reached substitution as `%7B%7B...%7D%7D` and no longer matched.
test('resolveProxySecrets: resolves a placeholder that URL serialisation encoded in the path', () => {
  const secrets = { THESPORTSDB_API_KEY: 'K9' };
  const hosts = ['www.thesportsdb.com'];
  const req = {
    url: 'https://www.thesportsdb.com/api/v1/json/%7B%7Bsecret:THESPORTSDB_API_KEY%7D%7D/all_leagues.php',
    method: 'GET', headers: {}, body: '',
  };
  const r = store.resolveProxySecrets(req, secrets, hosts);
  assert.equal(r.ok, true);
  assert.equal(r.req.url, 'https://www.thesportsdb.com/api/v1/json/K9/all_leagues.php');

  // Lowercase hex and the raw form both resolve; an unknown name stays a hard error.
  const lower = store.resolveProxySecrets(
    { ...req, url: 'https://www.thesportsdb.com/api/v1/json/%7b%7bsecret:THESPORTSDB_API_KEY%7d%7d/x.php' },
    secrets, hosts);
  assert.equal(lower.ok, true);
  assert.equal(new URL(lower.req.url).pathname, '/api/v1/json/K9/x.php');

  const bad = store.resolveProxySecrets(
    { ...req, url: 'https://www.thesportsdb.com/api/v1/json/%7B%7Bsecret:NOPE%7D%7D/x.php' },
    secrets, hosts);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_secret');
});

test('restoreEncodedPlaceholders: only rewrites well-formed placeholders', () => {
  const keep = 'https://h/x?q=%7B%22a%22%3A1%7D';          // an encoded JSON object, not a placeholder
  assert.equal(store.restoreEncodedPlaceholders(keep), keep);
  const none = 'https://h/plain/path';
  assert.equal(store.restoreEncodedPlaceholders(none), none);
  assert.equal(
    store.restoreEncodedPlaceholders('https://h/%7B%7B%20secret:A%20%7D%7D/b'),
    'https://h/{{secret:A}}/b');
});

// The end-to-end shape the widget actually hits: validateProxyRequest first
// (which is what encodes the braces), then secret substitution.
test('proxy pipeline: a path placeholder survives validateProxyRequest into substitution', () => {
  const widgets = require('../sdk-widgets.js');
  const manifest = { id: 'dgm-results', hosts: ['www.thesportsdb.com'], secrets: true };
  const v = widgets.validateProxyRequest(manifest, {
    url: 'https://www.thesportsdb.com/api/v1/json/{{secret:K}}/all_leagues.php',
    method: 'GET',
  });
  assert.equal(v.ok, true);
  assert.match(v.url, /%7B%7Bsecret:K%7D%7D/);   // pins WHY the recovery pass exists
  const r = store.resolveProxySecrets(v, { K: 'abc' }, manifest.hosts);
  assert.equal(r.ok, true);
  assert.equal(r.req.url, 'https://www.thesportsdb.com/api/v1/json/abc/all_leagues.php');
});

// ── Namespace selection (shared groups) ─────────────────────────────────────

test('storeNamespace: package id by default, shared group when declared', () => {
  assert.equal(store.storeNamespace({ id: 'weather-radar' }), 'weather-radar');
  assert.equal(store.storeNamespace({ id: 'weather-radar', storageGroup: 'dgm' }), 'g:dgm');
});

// The `sdk_store` cross-surface broadcast (GitHub #109) re-mounts frames of every
// package that SHARES the written namespace, so sibling widgets in a storageGroup
// stay 1:1 too — not only the one that wrote. This locks the exact fanout the
// server sends: packages.filter(p => storeNamespace(p) === ns).map(p => p.id).
test('storeNamespace fanout: a group write targets every sibling, a solo write only itself', () => {
  const packages = [
    { id: 'radar-a', storageGroup: 'dgm' },
    { id: 'radar-b', storageGroup: 'dgm' },
    { id: 'teleprompter' },                    // no group → its own namespace
    { id: 'clock' },
  ];
  const affected = (writerId) => {
    const ns = store.storeNamespace(packages.find(p => p.id === writerId));
    return packages.filter(p => store.storeNamespace(p) === ns).map(p => p.id).sort();
  };
  // A write by one group member re-mounts BOTH members of the group.
  assert.deepEqual(affected('radar-a'), ['radar-a', 'radar-b']);
  assert.deepEqual(affected('radar-b'), ['radar-a', 'radar-b']);
  // A standalone widget's write re-mounts only itself — never an unrelated package.
  assert.deepEqual(affected('teleprompter'), ['teleprompter']);
  assert.deepEqual(affected('clock'), ['clock']);
});

// ── The sync feedback loop, and the guards that close it ────────────────────
// v4.6.1 broadcast EVERY store write and re-mounted the package's frames on
// every other surface. A widget that saves its own start-up state (a cache, a
// "last updated" stamp) then wrote again the moment it was re-mounted, that
// write broadcast back, and two surfaces re-mounted each other without end —
// the widget visibly reloaded over and over on both screens. Two guards close
// it, and these assert they are still wired end to end. They check the source,
// not the behaviour: the loop needs two live surfaces, which no unit test here
// can stand up. Treat a failure as "the loop protection was removed".

test('sync guard: the host marks post-remount writes quiet and the server keeps them silent', () => {
  const client = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  // Host half: the store write carries the quiet flag.
  assert.match(client, /quiet:\s*storeWriteIsQuiet\(/,
    'the /sdk/store write must send quiet — without it a re-mount echoes back');
  // Host half: a sync re-mount opens the quiet window AND stamps the cooldown.
  assert.match(client, /_syncQuietUntil\.set\(/, 'a sync re-mount must open the quiet window');
  assert.match(client, /_syncRemountedAt\.set\(/, 'a sync re-mount must stamp the cooldown');
  assert.match(client, /SYNC_REMOUNT_COOLDOWN_MS\)\s*continue/,
    'a package re-mounted within the cooldown must be skipped');

  // Server half: a quiet write is stored, but never announced.
  assert.match(server, /if\s*\(!body\.quiet\)\s*\{[\s\S]{0,400}?broadcastSSE\('sdk_store'/,
    'the sdk_store broadcast must be gated on !body.quiet');
  // The save itself is NOT gated — quiet data must still persist for the next read.
  assert.match(server, /if\s*\(r\.changed\)\s*\{\s*\n\s*await sdkStoreSave\(/,
    'a quiet write must still be persisted, only the broadcast is suppressed');
});
