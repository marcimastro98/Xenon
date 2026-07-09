import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const unifi = require('../actions/unifi.js');

// ── unifiBaseUrl: normalize a user-entered host to an origin ──────────────────
test('unifiBaseUrl defaults bare hosts to https and strips path/query', () => {
  assert.equal(unifi.unifiBaseUrl('192.168.1.1'), 'https://192.168.1.1');
  assert.equal(unifi.unifiBaseUrl('udm.local:8443'), 'https://udm.local:8443');
  assert.equal(unifi.unifiBaseUrl('https://console.home/manage/protect'), 'https://console.home');
  assert.equal(unifi.unifiBaseUrl('http://10.0.0.2'), 'http://10.0.0.2');
});
test('unifiBaseUrl rejects non-http schemes and junk', () => {
  assert.equal(unifi.unifiBaseUrl('file:///etc/passwd'), '');
  assert.equal(unifi.unifiBaseUrl('javascript:alert(1)'), '');
  assert.equal(unifi.unifiBaseUrl(''), '');
  assert.equal(unifi.unifiBaseUrl(null), '');
});

// ── isCameraId: the id interpolated into the snapshot path ────────────────────
test('isCameraId accepts hex-ish ids, rejects traversal/injection', () => {
  assert.equal(unifi.isCameraId('61b3f5a9e4b0c1d2e3f4a5b6'), true);
  assert.equal(unifi.isCameraId('ABC123'), true);
  assert.equal(unifi.isCameraId('../../etc/passwd'), false);
  assert.equal(unifi.isCameraId('abc/def'), false);
  assert.equal(unifi.isCameraId('abc?x=1'), false);
  assert.equal(unifi.isCameraId('ab'), false);          // too short
  assert.equal(unifi.isCameraId(''), false);
  assert.equal(unifi.isCameraId(null), false);
});

// ── normalizeUnifi: known-key rebuild, camera-id + length clamping ────────────
test('normalizeUnifi rebuilds a clean block and drops bad cameras', () => {
  const out = unifi.normalizeUnifi({
    host: '  192.168.1.1  ',
    username: '  viewer ',
    password: 'secret',
    cameras: ['abcd', 'abcd', '../bad', 'EF12'],
    junk: 'nope',
  });
  assert.equal(out.host, '192.168.1.1');
  assert.equal(out.username, 'viewer');
  assert.equal(out.password, 'secret');
  assert.deepEqual(out.cameras, ['abcd', 'EF12']);      // deduped, traversal dropped
  assert.equal('junk' in out, false);
});
test('normalizeUnifi blanks an unusable host and coerces types', () => {
  const out = unifi.normalizeUnifi({ host: 'file:///x', cameras: 'nope' });
  assert.equal(out.host, '');
  assert.deepEqual(out.cameras, []);
  assert.equal(out.password, '');
});
test('normalizeUnifi tolerates non-objects', () => {
  assert.deepEqual(unifi.normalizeUnifi(null), { host: '', username: '', password: '', cameras: [] });
});

// ── preserveUnifiCreds: never wipe a password the client never received ───────
test('preserveUnifiCreds carries the persisted password over an empty one', () => {
  const incoming = { unifi: { host: '10.0.0.2', username: 'v', password: '', cameras: [] } };
  const prev = { unifi: { host: '10.0.0.2', username: 'v', password: 'saved', cameras: [] } };
  unifi.preserveUnifiCreds(incoming, prev);
  assert.equal(incoming.unifi.password, 'saved');
});
test('preserveUnifiCreds keeps an explicitly typed new password', () => {
  const incoming = { unifi: { host: '10.0.0.2', username: 'v', password: 'fresh', cameras: [] } };
  const prev = { unifi: { password: 'saved' } };
  unifi.preserveUnifiCreds(incoming, prev);
  assert.equal(incoming.unifi.password, 'fresh');
});
test('preserveUnifiCreds restores the whole block when the client omits it', () => {
  const incoming = { other: true };
  const prev = { unifi: { host: '10.0.0.2', username: 'v', password: 'saved', cameras: ['abcd'] } };
  unifi.preserveUnifiCreds(incoming, prev);
  assert.deepEqual(incoming.unifi, prev.unifi);
});
test('preserveUnifiCreds is a no-op with no prev', () => {
  const incoming = { unifi: { password: '' } };
  unifi.preserveUnifiCreds(incoming, null);
  assert.equal(incoming.unifi.password, '');
});

// ── redactUnifiCreds: blank the password on the wire, expose passwordSet ──────
test('redactUnifiCreds blanks the password and sets the flag', () => {
  const out = unifi.redactUnifiCreds({ unifi: { host: 'h', username: 'u', password: 'secret', cameras: ['abcd'] } });
  assert.equal(out.unifi.password, '');
  assert.equal(out.unifi.passwordSet, true);
  assert.equal(out.unifi.host, 'h');
  assert.deepEqual(out.unifi.cameras, ['abcd']);
});
test('redactUnifiCreds flags an unset password and does not mutate the source', () => {
  const src = { unifi: { host: 'h', username: 'u', password: '', cameras: [] } };
  const out = unifi.redactUnifiCreds(src);
  assert.equal(out.unifi.passwordSet, false);
  assert.equal(src.unifi.password, '');           // source untouched (shallow copy)
  assert.notEqual(out.unifi, src.unifi);
});
test('redactUnifiCreds tolerates a missing block', () => {
  const src = { other: 1 };
  assert.equal(unifi.redactUnifiCreds(src), src);
});

// combined round-trip: redact-then-preserve keeps the real password server-side
test('redact then preserve round-trips the saved password', () => {
  const stored = { unifi: { host: 'h', username: 'u', password: 'secret', cameras: [] } };
  const onWire = unifi.redactUnifiCreds(stored);          // browser sees no password
  assert.equal(onWire.unifi.password, '');
  const incoming = JSON.parse(JSON.stringify(onWire));    // client saves it back
  unifi.preserveUnifiCreds(incoming, stored);
  assert.equal(incoming.unifi.password, 'secret');        // restored, not wiped
});

// ── compactCamera: project the raw Protect object to the tile shape ───────────
test('compactCamera projects id/name/connected and drops bad ids', () => {
  assert.deepEqual(
    unifi.compactCamera({ id: 'abcd1234', name: 'Front Door', state: 'CONNECTED' }),
    { id: 'abcd1234', name: 'Front Door', connected: true },
  );
  assert.equal(unifi.compactCamera({ id: 'abcd', state: 'DISCONNECTED' }).connected, false);
  assert.equal(unifi.compactCamera({ id: '../x', name: 'bad' }), null);
  assert.equal(unifi.compactCamera(null), null);
});
