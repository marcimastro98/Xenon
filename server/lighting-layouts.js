'use strict';
// What hangs on an addressable output that cannot describe itself: plain ARGB
// fans and strips chained on a motherboard header send no data back, so how
// many LEDs each fan has is something the user tells Xenon once (the guided
// setup in the Lighting page does it with them). Stored per device and output:
//   layouts[deviceId][zone] = { empty?: true, name?, parts: [{ kind, count, name? }] }
// `name` is what the user calls the output ("Fans", "Desk strip"); the map, the
// Deck and widgets show it instead of "Output 2".
// The setup stores 'piece' parts: a stretch of the output, whatever hangs there
// (one fan, a strip, or several fans on a splitter that all show the same LEDs).
// The other kinds are older layouts and stay valid.
// Pure: normalizer (server + browser mirror) and the luid scheme every native
// device uses: (output + 1) << 16 | LED index, and | 0xFFFF for "the whole
// output", which is all an output nobody has set up yet can offer.

const PART_KINDS = ['piece', 'fan', 'strip', 'pump', 'block', 'zone'];
const MAX_PARTS = 32;
const MAX_PART_LEDS = 256;
const MAX_ZONE_LEDS = 1024;
const MAX_DEVICES = 16;
const MAX_ZONES = 16;
const MAX_NAME = 32;
const WHOLE_OUTPUT = 0xFFFF;
const ZONE_KEY = /^[a-z0-9_-]{1,16}$/;

const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME) : '');

function normalizePart(p) {
  if (!p || typeof p !== 'object') return null;
  const count = Math.round(Number(p.count));
  if (!Number.isFinite(count) || count < 1) return null;
  const out = { kind: PART_KINDS.includes(p.kind) ? p.kind : 'piece', count: Math.min(count, MAX_PART_LEDS) };
  const name = cleanName(p.name);
  if (name) out.name = name;
  return out;
}

function normalizeZoneLayout(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.empty === true) return { empty: true, parts: [] };
  const parts = [];
  let total = 0;
  for (const raw of Array.isArray(v.parts) ? v.parts.slice(0, MAX_PARTS) : []) {
    const p = normalizePart(raw);
    if (!p || total + p.count > MAX_ZONE_LEDS) continue;
    total += p.count;
    parts.push(p);
  }
  if (!parts.length) return null;
  const name = cleanName(v.name);
  return name ? { name, parts } : { parts };
}

function normalizeLayouts(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, zones] of Object.entries(value).slice(0, MAX_DEVICES)) {
    if (!zones || typeof zones !== 'object' || Array.isArray(zones)) continue;
    const dev = {};
    for (const [zone, layout] of Object.entries(zones).slice(0, MAX_ZONES)) {
      if (!ZONE_KEY.test(zone)) continue;
      const l = normalizeZoneLayout(layout);
      if (l) dev[zone] = l;
    }
    if (Object.keys(dev).length) out[String(id).slice(0, 160)] = dev;
  }
  return out;
}

const luidOf = (output, index) => (((output + 1) << 16) | index) >>> 0;
const outputOfLuid = (luid) => ((luid >>> 16) & 0xFFFF) - 1;
const indexOfLuid = (luid) => luid & 0xFFFF;

// The map segments of one output, from its layout. No layout yet → one part
// standing for the whole output, flagged so the page offers the setup.
function outputSegments(output, layout) {
  const zone = 'h' + output;
  if (layout && layout.empty) return [];
  if (!layout || !layout.parts || !layout.parts.length) {
    return [{ kind: 'header', model: '', output: output + 1, zone, unconfigured: true, ledIds: [luidOf(output, WHOLE_OUTPUT)] }];
  }
  let at = 0;
  const many = layout.parts.length > 1;
  return layout.parts.map((p, i) => {
    const ledIds = Array.from({ length: p.count }, (_, k) => luidOf(output, at + k));
    at += p.count;
    const seg = { kind: p.kind, model: '', output: output + 1, zone, ledIds };
    if (many) seg.piece = i + 1;   // "Output 1 · 2" when the output is split
    const name = p.name || (layout.name ? layout.name + (many ? ` · ${i + 1}` : '') : '');
    if (name) seg.name = name;
    return seg;
  });
}

// The board's own lights (single-colour zones, no setup needed) live on an
// output number no ARGB header uses; each LED index is the controller's zone.
const BOARD_OUTPUT = 0xFE;
function boardSegment(zones) {
  if (!zones || !zones.length) return [];
  return [{ kind: 'board', model: '', zone: 'board', ledIds: zones.map(z => luidOf(BOARD_OUTPUT, z)) }];
}

function layoutLeds(layout) {
  return layout && layout.parts ? layout.parts.reduce((s, p) => s + p.count, 0) : 0;
}

module.exports = {
  PART_KINDS, MAX_PARTS, MAX_PART_LEDS, WHOLE_OUTPUT, BOARD_OUTPUT,
  normalizeLayouts, normalizeZoneLayout, outputSegments, boardSegment, layoutLeds, luidOf, outputOfLuid, indexOfLuid,
};
