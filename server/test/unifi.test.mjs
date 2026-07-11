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
  assert.deepEqual(unifi.normalizeUnifi(null), {
    host: '', username: '', password: '', cameras: [],
    columns: 0, fit: 'cover', aspect: '16:9', order: [], refreshMs: 1500, angles: {},
    notify: { enabled: false, types: { person: true, vehicle: true, package: false, animal: false, motion: false, ring: true }, cooldownSec: 45 },
  });
});

// ── normalizeUnifi: display-layout fields (columns / fit / aspect / order) ─────
test('normalizeUnifi clamps columns and defaults on non-numbers', () => {
  assert.equal(unifi.normalizeUnifi({ columns: 3 }).columns, 3);
  assert.equal(unifi.normalizeUnifi({ columns: 99 }).columns, 6);      // clamp to max
  assert.equal(unifi.normalizeUnifi({ columns: -2 }).columns, 0);      // clamp to min
  assert.equal(unifi.normalizeUnifi({ columns: 2.6 }).columns, 3);     // rounded
  assert.equal(unifi.normalizeUnifi({ columns: 'nope' }).columns, 0);  // non-number → Auto
  assert.equal(unifi.normalizeUnifi({}).columns, 0);                   // default Auto
});
test('normalizeUnifi allowlists fit and aspect, falling back to defaults', () => {
  assert.equal(unifi.normalizeUnifi({ fit: 'contain' }).fit, 'contain');
  assert.equal(unifi.normalizeUnifi({ fit: 'evil()' }).fit, 'cover');
  assert.equal(unifi.normalizeUnifi({ aspect: '4:3' }).aspect, '4:3');
  assert.equal(unifi.normalizeUnifi({ aspect: '21:9' }).aspect, '16:9');
});
test('normalizeUnifi validates the display order like camera ids', () => {
  const out = unifi.normalizeUnifi({ order: ['EF12', 'abcd', 'EF12', '../bad', 5] });
  assert.deepEqual(out.order, ['EF12', 'abcd']);   // deduped, junk + traversal dropped
  assert.deepEqual(unifi.normalizeUnifi({ order: 'nope' }).order, []);
});
test('normalizeUnifi clamps the snapshot refresh rate', () => {
  assert.equal(unifi.normalizeUnifi({ refreshMs: 3000 }).refreshMs, 3000);
  assert.equal(unifi.normalizeUnifi({ refreshMs: 50 }).refreshMs, 500);       // clamp to min
  assert.equal(unifi.normalizeUnifi({ refreshMs: 999999 }).refreshMs, 60000); // clamp to max
  assert.equal(unifi.normalizeUnifi({ refreshMs: 'fast' }).refreshMs, 1500);  // default
  assert.equal(unifi.normalizeUnifi({}).refreshMs, 1500);
});
test('normalizeUnifi validates per-camera angles and drops neutral/bad ones', () => {
  const out = unifi.normalizeUnifi({ angles: {
    abcd: { rot: 90, flip: true },       // kept, flip coerced to 1
    EF12: { rot: 45, flip: 0 },          // bad rot → 0, no flip → neutral → dropped
    GH34: { rot: 0, flip: 0 },           // neutral → dropped
    '../bad': { rot: 180 },              // bad id → dropped
    IJ56: { rot: 270, flip: 1 },         // kept
  } });
  assert.deepEqual(out.angles, { abcd: { rot: 90, flip: 1 }, IJ56: { rot: 270, flip: 1 } });
  assert.deepEqual(unifi.normalizeUnifi({ angles: 'nope' }).angles, {});
});

test('normalizeUnifi validates per-camera digital zoom + pan', () => {
  const out = unifi.normalizeUnifi({ angles: {
    abcd: { rot: 0, flip: 0, zoom: 2, panX: 40, panY: -30 },   // kept, zoom + pan
    EF12: { rot: 0, flip: 0, zoom: 9, panX: 999 },             // zoom clamps 3, pan clamps 100
    GH34: { rot: 0, flip: 0, zoom: 1, panX: 50, panY: 50 },    // zoom 1 → pan dropped → neutral → dropped
    IJ56: { rot: 90, flip: 0, zoom: 0.2 },                     // zoom < 1 → 1 (dropped), rot keeps it
    KL78: { rot: 0, flip: 0, zoom: 1.5 },                      // zoom only, no pan keys
  } });
  assert.deepEqual(out.angles.abcd, { rot: 0, flip: 0, zoom: 2, panX: 40, panY: -30 });
  assert.deepEqual(out.angles.EF12, { rot: 0, flip: 0, zoom: 3, panX: 100 });
  assert.equal(out.angles.GH34, undefined);                   // fully neutral once zoom coerced to 1
  assert.deepEqual(out.angles.IJ56, { rot: 90, flip: 0 });    // pan/zoom stripped, rotation kept
  assert.deepEqual(out.angles.KL78, { rot: 0, flip: 0, zoom: 1.5 });
});

test('normalizeUnifiNotify defaults, validates and clamps', () => {
  // Absent block → off, but a sensible starter type set (so enabling isn't silent).
  const def = unifi.normalizeUnifiNotify(undefined);
  assert.equal(def.enabled, false);
  assert.deepEqual(def.types, { person: true, vehicle: true, package: false, animal: false, motion: false, ring: true });
  assert.equal(def.cooldownSec, 45);
  // Present types are honoured exactly (all-false is a valid user choice).
  const cleared = unifi.normalizeUnifiNotify({ enabled: true, types: { person: false }, cooldownSec: 3 });
  assert.equal(cleared.enabled, true);
  assert.equal(cleared.types.person, false);
  assert.equal(cleared.types.ring, false);        // absent key in a present map → false
  assert.equal(cleared.cooldownSec, 5);           // clamped up to the 5s floor
  assert.equal(unifi.normalizeUnifiNotify({ cooldownSec: 9999 }).cooldownSec, 600);   // clamped to ceiling
});

test('normalizeUnifi embeds a normalized notify block', () => {
  const out = unifi.normalizeUnifi({ notify: { enabled: true, types: { motion: true, bogus: true }, cooldownSec: 30 } });
  assert.equal(out.notify.enabled, true);
  assert.equal(out.notify.types.motion, true);
  assert.equal(out.notify.cooldownSec, 30);
  assert.equal('bogus' in out.notify.types, false);   // only known kinds survive
});

// ── redactUnifiCreds: layout fields reach the browser ─────────────────────────
test('redactUnifiCreds carries the layout fields to the wire', () => {
  const out = unifi.redactUnifiCreds({
    unifi: { host: 'h', username: 'u', password: 'secret', cameras: ['abcd'], columns: 2, fit: 'contain', aspect: '1:1', order: ['abcd'], refreshMs: 5000, angles: { abcd: { rot: 180, flip: 1 } }, notify: { enabled: true, types: { person: true }, cooldownSec: 60 } },
  });
  assert.equal(out.unifi.notify.enabled, true);    // notify reaches the browser (not a secret)
  assert.equal(out.unifi.notify.types.person, true);
  assert.equal(out.unifi.notify.cooldownSec, 60);
  assert.equal(out.unifi.columns, 2);
  assert.equal(out.unifi.fit, 'contain');
  assert.equal(out.unifi.aspect, '1:1');
  assert.deepEqual(out.unifi.order, ['abcd']);
  assert.equal(out.unifi.refreshMs, 5000);
  assert.deepEqual(out.unifi.angles, { abcd: { rot: 180, flip: 1 } });
  assert.equal(out.unifi.password, '');            // still redacted
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
