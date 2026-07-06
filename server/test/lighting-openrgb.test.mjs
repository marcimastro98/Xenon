import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const openrgb = require('../lighting-providers/openrgb.js');

// --- helpers to build a synthetic controller-data blob (OpenRGB NetworkProtocol) ---
function str(s) {
  const utf = Buffer.from(s + '\0', 'utf8'); // OpenRGB strings carry a trailing NUL in the length
  const out = Buffer.alloc(2 + utf.length);
  out.writeUInt16LE(utf.length, 0);
  utf.copy(out, 2);
  return out;
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }

// Minimal proto-4 controller blob: no modes, one zone, no segments.
function controllerBlob({ name, vendor, zoneLeds, numLeds }) {
  return Buffer.concat([
    u32(0),            // data_size (unused by the parser)
    u32(0),            // device type
    str(name),
    str(vendor),
    str('desc'), str('1.0'), str('serial'), str('loc'),
    u16(0),            // numModes
    i32(0),            // active mode
    u16(1),            // numZones
    str('Zone 1'), i32(0), u32(0), u32(zoneLeds), u32(zoneLeds),
    u16(0),            // matrixLen
    u16(0),            // numSegments (proto >= 4)
    u16(numLeds),      // top-level LED count
  ]);
}

test('openrgb header() writes the ORGB magic + LE fields', () => {
  const h = openrgb._header(3, 1050, 42);
  assert.equal(h.length, 16);
  assert.equal(h.toString('ascii', 0, 4), 'ORGB');
  assert.equal(h.readUInt32LE(4), 3);    // device id
  assert.equal(h.readUInt32LE(8), 1050); // packet id
  assert.equal(h.readUInt32LE(12), 42);  // data length
});

test('openrgb splitHostPort defaults to 6742 and honours an explicit port', () => {
  assert.deepEqual(openrgb._splitHostPort('192.168.1.5'), { ip: '192.168.1.5', port: 6742 });
  assert.deepEqual(openrgb._splitHostPort('192.168.1.5:7000'), { ip: '192.168.1.5', port: 7000 });
  assert.deepEqual(openrgb._splitHostPort(' 127.0.0.1 '), { ip: '127.0.0.1', port: 6742 });
});

test('openrgb parseController reads name/vendor/LED count (proto 4)', () => {
  const blob = controllerBlob({ name: 'ASUS Aura MB', vendor: 'ASUSTek', zoneLeds: 10, numLeds: 10 });
  const info = openrgb._parseController(blob, 4);
  assert.equal(info.name, 'ASUS Aura MB');
  assert.equal(info.vendor, 'ASUSTek');
  assert.equal(info.numLeds, 10);
  assert.equal(openrgb._parseLedCount(blob, 4), 10);
});

test('openrgb parseController falls back to the zone LED sum when numLeds is 0', () => {
  const blob = controllerBlob({ name: 'RAM', vendor: 'Generic', zoneLeds: 8, numLeds: 0 });
  assert.equal(openrgb._parseController(blob, 4).numLeds, 8);
});

test('openrgb parseController survives a truncated blob (returns 0 LEDs)', () => {
  const info = openrgb._parseController(Buffer.alloc(6), 4);
  assert.equal(info.numLeds, 0);
});

test('openrgb skips Corsair controllers so it never fights iCUE', () => {
  assert.ok(openrgb._isCorsairController({ name: 'Corsair Vengeance RGB', vendor: '' }));
  assert.ok(openrgb._isCorsairController({ name: 'K95 Platinum', vendor: 'Corsair' }));
  assert.ok(!openrgb._isCorsairController({ name: 'ASUS Aura MB', vendor: 'ASUSTek' }));
});
