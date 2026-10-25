'use strict';
// GIGABYTE RGB Fusion 2 USB controllers (ITE IT5702 / IT5711 / IT8297 / IT8950,
// on most GIGABYTE and AORUS boards since 2019): the bytes Xenon sends. Pure, so
// every packet is unit-tested; fusion2.js does the I/O.
//
// The protocol is public knowledge thanks to the OpenRGB project's reverse
// engineering; this is Xenon's own implementation of it. Every message is a
// 64-byte HID feature report starting with report id 0xCC. Xenon only ever sends
// the commands below: never 0x5E (save to the controller's flash) or 0x33
// (colour calibration), so nothing it does outlives a power cycle.

const VENDOR_ID = 0x048D;
const PRODUCT_IDS = [0x5702, 0x5711, 0x8297, 0x8950];
const USAGE_PAGE = 0xFF89;
const USAGE = 0xCC;
const REPORT_ID = 0xCC;
const PACKET_BYTES = 64;
const LEDS_PER_PACKET = 19;
const MAX_HEADER_LEDS = 256;     // what the IT57xx chips address per ARGB header

const CMD = {
  INFO: 0x60, INFO_EXTRA: 0x61, LED_COUNT: 0x34, EFFECTS_OFF: 0x32,
  APPLY: 0x28, BEAT: 0x31, LAMP_ARRAY: 0x48, GEN2_SCAN_BASE: 0x38,
};

// The addressable (ARGB) headers: data register, the bit that switches its
// built-in effect off, and the Gen2 scan offset. The IT5711 has four.
const HEADERS = [
  { reg: 0x58, effectBit: 0x01, scanDelta: 4 },
  { reg: 0x59, effectBit: 0x02, scanDelta: 5 },
  { reg: 0x62, effectBit: 0x08, scanDelta: 0 },
  { reg: 0x63, effectBit: 0x10, scanDelta: 1 },
];

function headerCount(productId) { return productId === 0x5711 ? 4 : 2; }

// The board's own single-colour lights (I/O cover, chipset accent, the 12 V
// LED_C header...): numbered effect zones, which ones are fitted depends on the
// board. Only the zones no chip uses for an ARGB header are listed; a zone the
// board lacks simply shows nothing.
const ONBOARD_ZONES = [0, 1, 2, 3, 4];
const ONBOARD_ZONES_5711 = [0, 1, 2, 3, 4, 9, 10];
const EFFECT_STATIC = 1;

function onboardZones(productId) { return productId === 0x5711 ? ONBOARD_ZONES_5711 : ONBOARD_ZONES; }

function packet(bytes) {
  const buf = Buffer.alloc(PACKET_BYTES);
  buf[0] = REPORT_ID;
  bytes.forEach((b, i) => { buf[i + 1] = b & 0xFF; });
  return buf;
}

// Colour order per header, from the controller's calibration word: the byte
// offsets of R, G and B inside each LED triple. 0 means "not calibrated", which
// takes the first header's order (the common GRB of ARGB fans).
function byteOrder(cal, fallback) {
  const v = cal >>> 0;
  if (!v) return fallback || { r: 1, g: 0, b: 2 };
  const order = { b: v & 0xFF, g: (v >>> 8) & 0xFF, r: (v >>> 16) & 0xFF };
  const valid = [order.r, order.g, order.b].sort().join() === '0,1,2';
  return valid ? order : (fallback || { r: 1, g: 0, b: 2 });
}

// IT8297Report: what the controller says about itself.
function parseInfo(buf, productId) {
  if (!buf || buf.length < 60 || buf[0] !== REPORT_ID) return null;
  const name = buf.toString('latin1', 12, 40).replace(/\0[\s\S]*$/, '').trim();
  return {
    productId,
    deviceNum: buf[2],
    stripDetect: buf[3] === 1,
    firmware: [buf[4], buf[5], buf[6], buf[7]].join('.'),
    supportFlags: buf[11],
    name,
    calStrips: [buf.readUInt32LE(44), buf.readUInt32LE(48)],
    chipId: buf.readUInt32LE(56),
  };
}

// The IT5711's second calibration report: headers 3 to 6.
function parseInfoExtra(buf) {
  if (!buf || buf.length < 20 || buf[0] !== REPORT_ID) return [];
  return [buf.readUInt32LE(4), buf.readUInt32LE(8), buf.readUInt32LE(12), buf.readUInt32LE(16)];
}

function ledCountCode(n) {
  if (n <= 32) return 0;
  if (n <= 64) return 1;
  if (n <= 256) return 2;
  if (n <= 512) return 3;
  return 4;
}

// How many LEDs each header drives (up to six nibbles; unused headers 0).
function ledCountPacket(counts) {
  const c = [0, 1, 2, 3, 4, 5].map(i => ledCountCode(counts[i] || 0));
  return packet([CMD.LED_COUNT, (c[1] << 4) | c[0], (c[3] << 4) | c[2], (c[5] << 4) | c[4]]);
}

// Built-in effects off on the given headers (they then show what we send).
function effectsOffPacket(slots) {
  const mask = slots.reduce((m, s) => m | (HEADERS[s] ? HEADERS[s].effectBit : 0), 0);
  return packet([CMD.EFFECTS_OFF, mask]);
}

function applyPacket(productId) {
  return packet([CMD.APPLY, 0xFF, productId === 0x5711 ? 0x07 : 0x00]);
}

// One header's colours, 19 LEDs per packet: offset and length are in bytes.
function stripPackets(slot, colors, order) {
  const out = [];
  const reg = HEADERS[slot].reg;
  const total = Math.min(colors.length, MAX_HEADER_LEDS);
  for (let start = 0; start < total; start += LEDS_PER_PACKET) {
    const n = Math.min(LEDS_PER_PACKET, total - start);
    const buf = Buffer.alloc(PACKET_BYTES);
    buf[0] = REPORT_ID;
    buf[1] = reg;
    buf.writeUInt16LE(start * 3, 2);
    buf[4] = n * 3;
    for (let i = 0; i < n; i++) {
      const c = colors[start + i] || { r: 0, g: 0, b: 0 };
      const o = 5 + i * 3;
      buf[o + order.r] = c.r;
      buf[o + order.g] = c.g;
      buf[o + order.b] = c.b;
    }
    out.push(buf);
  }
  return out;
}

// One onboard zone set to a steady colour (a static effect with no timing, the
// "direct" form). Effect report: header, zone bitmask (u32), second mask,
// reserved, effect type, max/min brightness, colour as 0x00RRGGBB (u32 LE).
function zoneColorPacket(zone, c) {
  const buf = Buffer.alloc(PACKET_BYTES);
  buf[0] = REPORT_ID;
  buf[1] = zone < 8 ? 0x20 + zone : 0x90 + (zone - 8);
  buf.writeUInt32LE((1 << zone) >>> 0, 2);
  buf[11] = EFFECT_STATIC;
  buf[12] = 0xFF;
  buf[14] = c.b;
  buf[15] = c.g;
  buf[16] = c.r;
  return buf;
}

// Start-up: hand the controller to direct control.
function initPackets(info) {
  const out = [];
  if (info.supportFlags & 0x02) out.push(packet([CMD.LAMP_ARRAY, 0]));   // Windows Dynamic Lighting off
  out.push(packet([CMD.BEAT, 0]));                                        // audio "beat" mode off
  return out;
}

// Gen2 strip detection (devices that report their own LED count).
function gen2Supported(info) {
  return !!info && info.deviceNum === 0 && info.stripDetect && (info.supportFlags & 0x01) === 0x01
    && [0x5702, 0x5711, 0x8950].includes(info.productId);
}
function gen2ScanPackets(slot) {
  const scan = CMD.GEN2_SCAN_BASE + HEADERS[slot].scanDelta;
  return { scan: packet([scan, 0, 0]), info: packet([scan + 2, 0, 0]) };
}
// → LED counts of each chained Gen2 device, [] when the header reports none.
function parseGen2(buf) {
  if (!buf || buf.length < 4 || buf[0] !== REPORT_ID) return [];
  const n = Math.min(15, buf[1]);
  const counts = [];
  for (let k = 0; k < n; k++) {
    const cnt = buf[2 + k * 2] | (buf[3 + k * 2] << 8);
    if (cnt > 0) counts.push(Math.min(cnt, MAX_HEADER_LEDS));
  }
  return counts;
}

module.exports = {
  VENDOR_ID, PRODUCT_IDS, USAGE_PAGE, USAGE, REPORT_ID, MAX_HEADER_LEDS, HEADERS, CMD,
  headerCount, onboardZones, zoneColorPacket, byteOrder, parseInfo, parseInfoExtra, ledCountCode, ledCountPacket, effectsOffPacket,
  applyPacket, stripPackets, initPackets, gen2Supported, gen2ScanPackets, parseGen2, packet,
};
