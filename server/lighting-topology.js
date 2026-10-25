'use strict';
// Physical layout of an iCUE device for the lighting map: which LEDs belong to
// which fan, pump, strip or RAM stick. Pure — lighting.js feeds it what the SDK
// reported, the UI draws the result.
//
// Values from the official iCUE SDK v4 header (CorsairOfficial/cue-sdk) and a
// read-only probe on real hardware (Oct 2026):
//   - A LED luid is (CorsairLedGroup << 16) | index.
//   - Per channel, CDPI_ChannelDeviceLedCountArray lists each connected device's
//     LED count and CDPI_ChannelDeviceTypeArray its CorsairChannelDeviceType.
//   - The LED GROUP is not the channel: an iCUE LINK hub reported one channel
//     holding a 40-LED pump and three 8-LED fans, with the LEDs split across
//     groups 11 and 12. So the split is positional: LEDs sorted by luid, cut in
//     order by the concatenated per-device counts.

// CorsairChannelDeviceType → map shape. 0 (invalid) and unknown values draw as a strip.
const CHANNEL_KIND = {
  1: ['fan', 'HD'], 2: ['fan', 'SP'], 3: ['fan', 'LL'], 4: ['fan', 'ML'], 5: ['fan', 'QL'],
  6: ['fan', ''], 7: ['strip', ''], 8: ['block', 'DAP'], 9: ['pump', ''], 10: ['dram', ''],
  11: ['block', ''], 12: ['fan', 'QX'],
};

// CorsairDeviceType bits for devices without channels. Keyboards, mice and the
// like have meaningful positions (mm), so they draw from them ('pos').
const DT_MEMORY = 0x80;
const DT_COOLER = 0x100;
const DT_MOTHERBOARD = 0x200;
const DT_GPU = 0x400;
const POSITIONAL_TYPES = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x800 | 0x1000;
const MAX_BOARD_ZONES = 12;

function sortedLeds(leds) {
  return leds.slice().sort((a, b) => (a.id >>> 0) - (b.id >>> 0));
}

function wholeDeviceKind(type) {
  if (type & DT_MEMORY) return 'dram';
  if (type & DT_COOLER) return 'pump';
  if (type & (DT_MOTHERBOARD | DT_GPU)) return 'zone';
  if (type & POSITIONAL_TYPES) return 'pos';
  return 'zone';
}

// Flatten channels → [{ kind, model, count }] in wiring order. Returns null when
// any channel is missing or malformed, so the caller falls back to one segment.
function channelDevices(channels) {
  if (!Array.isArray(channels) || !channels.length) return null;
  const out = [];
  for (const ch of channels) {
    if (!ch || !Array.isArray(ch.ledCounts) || !Array.isArray(ch.types)) return null;
    ch.ledCounts.forEach((count, i) => {
      const [kind, model] = CHANNEL_KIND[ch.types[i]] || ['strip', ''];
      out.push({ kind, model, count: Math.max(0, Math.floor(Number(count) || 0)) });
    });
  }
  return out.length ? out : null;
}

// device: { type, leds: [{ id, cx, cy }], channels?: [{ ledCounts:[n], types:[t] }] }
// → [{ kind, model, ledIds, pos? }]. Every LED lands in exactly one segment.
function buildSegments(device) {
  const leds = sortedLeds((device && Array.isArray(device.leds)) ? device.leds : []);
  if (!leds.length) return [];
  const parts = channelDevices(device.channels);
  const total = parts ? parts.reduce((s, p) => s + p.count, 0) : 0;
  // Counts that do not add up to what the device reported mean the property
  // read is not describing these LEDs: drawing a wrong split would put colours
  // on the wrong fan, so show the device whole instead.
  if (parts && total === leds.length) {
    const segs = [];
    let at = 0;
    for (const p of parts) {
      if (!p.count) continue;
      segs.push({ kind: p.kind, model: p.model, ledIds: leds.slice(at, at + p.count).map(l => l.id >>> 0) });
      at += p.count;
    }
    return segs;
  }
  const type = Number(device.type) || 0;
  // A motherboard's LEDs are its lighting zones (a board plugin reports one LED
  // per zone, the ARGB headers among them), so each one is a part of its own,
  // named as iCUE names it: Zone 1, Zone 2… Many LEDs mean a real per-LED strip.
  if ((type & DT_MOTHERBOARD) && leds.length <= MAX_BOARD_ZONES) {
    return leds.map(l => ({ kind: 'zone', model: '', ledIds: [l.id >>> 0] }));
  }
  const kind = wholeDeviceKind(type);
  const seg ={ kind, model: '', ledIds: leds.map(l => l.id >>> 0) };
  if (kind === 'pos') seg.pos = leds.map(l => [round1(l.cx), round1(l.cy)]);
  return [seg];
}

function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

module.exports = { buildSegments, CHANNEL_KIND };
