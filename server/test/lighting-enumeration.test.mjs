// The iCUE bridge reported a healthy session while painting nothing.
//
// Two independent defects produced that, both invisible from /api/lighting/status:
//
//   1. Every SDK call discarded its return code. `fns.setLedColors.async(..., (err,
//      _rc) => err ? reject(err) : resolve())` only rejects when the FFI call itself
//      breaks; the SDK reports real failures through the rc. A session invalidated
//      underneath us (iCUE restarted, upgraded or reinstalled) answers CE_NotConnected
//      on every write, so writes silently no-op'd, the on-change cache in writeDevice()
//      recorded them as painted, `connected` stayed true, and nothing ever retried.
//
//   2. Completeness was judged on `ledCount` (CorsairDeviceInfo) instead of `ledIds`
//      (CorsairGetLedPositions — the array every write actually iterates). A device
//      declaring 20 LEDs and returning zero positions looked ready and then wrote an
//      empty colour array. And neither test can see a device that never appeared at
//      all: a list holding only the RAM is "complete" while the iCUE LINK hub, which
//      registers seconds later because the server starts before iCUE finishes booting,
//      is simply absent — and enumerate() ran exactly once, from the connect callback.
//
// Observed on a real machine: /api/lighting/status said connected with one device,
// while a direct SDK probe against the same DLL saw two (VENGEANCE RGB DDR5 + iCUE
// LINK System Hub) and lit both. The radiator never came back until a server restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(ROOT, 'server', 'lighting.js'), 'utf8');
const { _enumerationComplete: complete } = createRequire(import.meta.url)(join(ROOT, 'server', 'lighting.js'));

const dev = (id, ledCount, ledIds) => ({ id, model: id, type: 1, ledCount, ledIds });

test('a device with declared LEDs but no resolved positions is NOT complete', () => {
  // The exact shape that painted nothing: ledCount 20, ledIds empty.
  assert.equal(complete([dev('ram', 20, [])]), false);
  assert.equal(complete([dev('ram', 20, [1, 2, 3]), dev('hub', 64, [])]), false);
});

test('an empty device list is never complete', () => {
  assert.equal(complete([]), false);
});

test('every device answering with real LED ids is complete', () => {
  assert.equal(complete([dev('ram', 20, [1, 2]), dev('hub', 64, [3, 4])]), true);
});

test('completeness is judged on ledIds, never on ledCount', () => {
  // A hub can legitimately report ledCount 0 yet still hand back positions; the
  // old predicate called that incomplete and re-enumerated it forever.
  assert.equal(complete([dev('hub', 0, [7, 8])]), true);
  assert.match(src, /function enumerationComplete\(list\) \{\s*return list\.length > 0 && list\.every\(d => d\.ledIds\.length > 0\);/);
});

test('no paint-path SDK call discards its return code', () => {
  // The `(err, _rc) =>` shape is the bug: it resolves on a failed call.
  assert.equal(/_rc/.test(src), false, 'a call site still ignores the SDK return code');
  // Painting and enumeration must route through sdkCall(), which rejects on rc != 0.
  for (const fn of ['setLedColors', 'getDevices', 'getLedPositions']) {
    assert.equal(new RegExp(`fns\\.${fn}\\.async\\(`).test(src), false, `${fn} bypasses sdkCall()`);
    assert.ok(src.includes(`sdkCall(fns.${fn}`), `${fn} is not routed through sdkCall()`);
  }
  assert.match(src, /if \(rc !== 0\) return reject\(new SdkError\(label, rc\)\);/);
});

test('the deliberately rc-tolerant calls stay tolerant', () => {
  // Not every call should fail on a non-zero rc, and sdkCall() would break these:
  //   readProperty  — CE_NotAllowed is the normal answer for a wired device
  //   freeProperty  — best-effort free, nothing to report
  //   disconnect    — teardown, the rc changes nothing
  // Pinned so a future "route everything through sdkCall" sweep doesn't turn a
  // wired keyboard into a logged error on every battery poll.
  assert.match(src, /if \(rc !== 0\) continue; \/\/ wired \/ unsupported device/);
  assert.ok(src.includes('fns.freeProperty.async('), 'freeProperty should stay fire-and-forget');
  assert.ok(src.includes('fns.disconnect.async('), 'disconnect should stay rc-tolerant');
});

test('a lost session drops `connected` so the reconnect path can rebuild it', () => {
  // CE_NotConnected must invalidate the handle: the state callback only fires for
  // transitions the SDK still knows about, so a service that died under us never
  // sends one and the bridge would sit on a dead handle forever.
  assert.match(src, /e\.rc === CE_NOT_CONNECTED/);
  assert.match(src, /const CE_NOT_CONNECTED = 1;/);
});

test('a write is cached only after the SDK confirms it', () => {
  // lastWrite is the on-change guard; caching an unconfirmed write is what stopped
  // the retry. Each setLedColors path must await sdkCall before lastWrite.set.
  for (const body of src.split('async function ').slice(1)) {
    if (!body.includes('lastWrite.set')) continue;
    const write = body.indexOf('sdkCall(fns.setLedColors');
    if (write === -1) continue;
    assert.ok(write < body.indexOf('lastWrite.set'), 'lastWrite.set precedes the confirmed write');
  }
});

test('devices that register after the initial enumeration are picked up', () => {
  assert.match(src, /const DEVICE_RESCAN_MS = \d+;/);
  assert.match(src, /now - lastDeviceScan >= DEVICE_RESCAN_MS/);
  // The rescan must stay gated on wantsPaint() via maybeReenumerate, so an idle
  // bridge keeps costing nothing.
  assert.match(src, /function maybeReenumerate\(\) \{\s*if \(!wantsPaint\(\)\) return;/);
});
