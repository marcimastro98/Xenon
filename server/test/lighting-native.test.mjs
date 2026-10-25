// Native motherboard lighting (GIGABYTE RGB Fusion 2): the exact bytes sent to
// the controller, the output layouts told in the guided setup, and how a
// device's per-LED colours become one frame per ARGB header. A wrong byte here
// lights the wrong fan or leaves the board's own effect running, so every packet
// is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../lighting-native/fusion2-protocol.js');
const L = require('../lighting-layouts.js');
const { Fusion2Controller } = require('../lighting-native/fusion2.js');
const native = require('../lighting-native/index.js');

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };
const OFF = { r: 0, g: 0, b: 0 };

test('every packet is a 64-byte feature report with id 0xCC', () => {
  const pkt = P.packet([0x60]);
  assert.equal(pkt.length, 64);
  assert.equal(pkt[0], 0xCC);
  assert.equal(pkt[1], 0x60);
});

test('the IT5711 has four ARGB headers, the older chips two', () => {
  assert.equal(P.headerCount(0x5711), 4);
  assert.equal(P.headerCount(0x5702), 2);
  assert.equal(P.headerCount(0x8297), 2);
});

test('colour order comes from the calibration word, 0 falls back to GRB', () => {
  assert.deepEqual(P.byteOrder(0x00010002), { b: 2, g: 0, r: 1 });
  assert.deepEqual(P.byteOrder(0x00000102), { b: 2, g: 1, r: 0 });
  assert.deepEqual(P.byteOrder(0), { r: 1, g: 0, b: 2 });
  // A word that is not a permutation of 0,1,2 is ignored, never trusted.
  assert.deepEqual(P.byteOrder(0x00050505), { r: 1, g: 0, b: 2 });
  assert.deepEqual(P.byteOrder(0, { r: 0, g: 1, b: 2 }), { r: 0, g: 1, b: 2 });
});

test('parseInfo reads name, firmware, calibration and chip id', () => {
  const buf = Buffer.alloc(64);
  buf[0] = 0xCC; buf[2] = 0; buf[3] = 1;
  buf[4] = 1; buf[5] = 0; buf[6] = 19; buf[7] = 6;
  buf[11] = 3;
  buf.write('IT5711-GIGABYTE V1.0.19.6', 12, 'latin1');
  buf.writeUInt32LE(0x00010002, 44);
  buf.writeUInt32LE(0x00010002, 48);
  buf.writeUInt32LE(0x57110001, 56);
  const info = P.parseInfo(buf, 0x5711);
  assert.equal(info.name, 'IT5711-GIGABYTE V1.0.19.6');
  assert.equal(info.firmware, '1.0.19.6');
  assert.equal(info.stripDetect, true);
  assert.equal(info.supportFlags, 3);
  assert.deepEqual(info.calStrips, [0x00010002, 0x00010002]);
  assert.equal(info.chipId, 0x57110001);
  assert.equal(P.gen2Supported(info), true);
  assert.equal(P.parseInfo(Buffer.alloc(64), 0x5711), null, 'a reply without the report id is no reply');
});

test('LED count nibbles follow the controller\'s size steps', () => {
  assert.deepEqual([0, 32, 33, 64, 65, 256, 257, 600].map(P.ledCountCode), [0, 0, 1, 1, 2, 2, 3, 4]);
  const pkt = P.ledCountPacket([120, 30, 0, 64]);
  assert.equal(pkt[1], 0x34);
  assert.equal(pkt[2], (0 << 4) | 2);
  assert.equal(pkt[3], (1 << 4) | 0);
});

test('effects off masks only the given headers; [] gives them all back', () => {
  assert.equal(P.effectsOffPacket([0, 1, 2, 3])[2], 0x01 | 0x02 | 0x08 | 0x10);
  assert.equal(P.effectsOffPacket([2])[2], 0x08);
  assert.equal(P.effectsOffPacket([])[2], 0);
});

test('apply carries 0x07 only on the IT5711', () => {
  assert.deepEqual([...P.applyPacket(0x5711).subarray(0, 4)], [0xCC, 0x28, 0xFF, 0x07]);
  assert.deepEqual([...P.applyPacket(0x5702).subarray(0, 4)], [0xCC, 0x28, 0xFF, 0x00]);
});

test('strip packets carry 19 LEDs each, byte offsets, in the header\'s colour order', () => {
  const colors = Array.from({ length: 40 }, (_, i) => ({ r: i, g: 100 + i, b: 200 }));
  const pkts = P.stripPackets(1, colors, { r: 1, g: 0, b: 2 });
  assert.equal(pkts.length, 3);
  assert.equal(pkts[0][1], 0x59, 'header 2 register');
  assert.equal(pkts[1].readUInt16LE(2), 19 * 3);
  assert.equal(pkts[2][4], 2 * 3, 'last packet: 2 LEDs');
  // LED 0 in GRB: g first, then r, then b.
  assert.deepEqual([...pkts[0].subarray(5, 8)], [100, 0, 200]);
  // Never past what a header addresses.
  assert.equal(P.stripPackets(0, new Array(400).fill(RED), P.byteOrder(0)).length, Math.ceil(256 / 19));
});

test('init switches off Windows Dynamic Lighting only when the board has it', () => {
  assert.deepEqual(P.initPackets({ supportFlags: 3 }).map(p => p[1]), [0x48, 0x31]);
  assert.deepEqual(P.initPackets({ supportFlags: 1 }).map(p => p[1]), [0x31]);
});

test('Xenon never sends a flash save or a calibration write', () => {
  const all = [
    ...P.initPackets({ supportFlags: 3 }), P.ledCountPacket([1]), P.effectsOffPacket([0]), P.applyPacket(0x5711),
    ...P.stripPackets(0, [RED], P.byteOrder(0)), P.gen2ScanPackets(0).scan, P.gen2ScanPackets(0).info,
  ];
  for (const p of all) assert.ok(![0x5E, 0x33].includes(p[1]), `command 0x${p[1].toString(16)}`);
});

test('Gen2 reply: the LED count of each chained device', () => {
  const buf = Buffer.alloc(64);
  buf[0] = 0xCC; buf[1] = 3;
  buf.writeUInt16LE(8, 2); buf.writeUInt16LE(8, 4); buf.writeUInt16LE(0, 6);
  assert.deepEqual(P.parseGen2(buf), [8, 8]);
  assert.deepEqual(P.gen2ScanPackets(0).scan[1], 0x3C);
  assert.deepEqual(P.gen2ScanPackets(0).info[1], 0x3E);
});

test('layouts: only valid parts survive, sizes are capped', () => {
  const out = L.normalizeLayouts({
    'fusion2-1': {
      h0: { parts: [{ kind: 'fan', count: 8 }, { kind: 'bogus', count: 3.4, name: ' Top\u0001 ' }, { count: 0 }, { count: 999 }] },
      h1: { empty: true, parts: [{ count: 5 }] },
      h2: { parts: [] },
      'BAD KEY': { parts: [{ count: 1 }] },
    },
    'fusion2-2': 'nope',
  });
  assert.deepEqual(out, {
    'fusion2-1': {
      h0: { parts: [{ kind: 'fan', count: 8 }, { kind: 'piece', count: 3, name: 'Top' }, { kind: 'piece', count: 256 }] },
      h1: { empty: true, parts: [] },
    },
  });
  assert.deepEqual(L.normalizeLayouts([1, 2]), {});
});

test('segments: an unset output is one part for all of it, an empty one none', () => {
  const unset = L.outputSegments(2, undefined);
  assert.equal(unset.length, 1);
  assert.equal(unset[0].unconfigured, true);
  assert.equal(unset[0].output, 3);
  assert.equal(L.indexOfLuid(unset[0].ledIds[0]), L.WHOLE_OUTPUT);
  assert.deepEqual(L.outputSegments(0, { empty: true, parts: [] }), []);
  const segs = L.outputSegments(0, { parts: [{ kind: 'fan', count: 2 }, { kind: 'strip', count: 3, name: 'Desk' }] });
  assert.deepEqual(segs.map(s => [s.kind, s.ledIds.map(L.indexOfLuid), s.name, s.piece]), [['fan', [0, 1], undefined, 1], ['strip', [2, 3, 4], 'Desk', 2]]);
  // One counted stretch for the whole output: no piece number to show.
  const whole = L.outputSegments(1, { parts: [{ kind: 'piece', count: 40 }] });
  assert.equal(whole.length, 1);
  assert.equal(whole[0].piece, undefined);
  assert.equal(whole[0].ledIds.length, 40);
  assert.equal(L.outputOfLuid(segs[1].ledIds[0]), 0);
});

test('frames: each LED colour lands on its header and index; unset outputs fill whole', async () => {
  await native.configure({ layouts: { dev: { h0: { parts: [{ kind: 'fan', count: 2 }, { kind: 'fan', count: 2 }] }, h1: { empty: true } } } });
  const entry = { id: 'dev', ctl: { headers: 4 } };
  const ids = [L.luidOf(0, 0), L.luidOf(0, 3), L.luidOf(2, L.WHOLE_OUTPUT)];
  const frames = native._framesFor(entry, ids, [RED, BLUE, RED]);
  assert.deepEqual(frames[0], [RED, OFF, OFF, BLUE]);
  assert.equal(frames[1], null, 'nothing plugged in: never written');
  assert.equal(frames[2].length, 120);
  assert.ok(frames[2].every(c => c === RED));
  assert.ok(frames[3].every(c => c.r + c.g + c.b === 0), 'an unset output nobody painted stays dark');
});

test('setup preview: marked parts alternate, the part being measured is white', () => {
  const f = native._previewFrame({ done: [2, 1], lit: 3 });
  assert.equal(f.length, 256);
  assert.deepEqual(f[0], f[1]);
  assert.notDeepEqual(f[1], f[2]);
  assert.deepEqual(f.slice(3, 6), [{ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }]);
  assert.deepEqual(f[6], OFF);
  assert.ok(native._previewFrame({ whole: true }).every(c => c.r === 255));
});

function fakeController() {
  const ctl = new Fusion2Controller({ productId: 0x5711 });
  const sent = [];
  ctl.dev = { setFeature: async (buf) => { sent.push(buf); } };
  ctl.orders = [0, 1, 2, 3].map(() => P.byteOrder(0));
  return { ctl, sent };
}

test('controller: first write sets counts, takes the headers, paints, applies', async () => {
  const { ctl, sent } = fakeController();
  await ctl.write([[RED, RED], null, null, null]);
  assert.deepEqual(sent.map(p => p[1]), [0x34, 0x32, 0x58, 0x28]);
  assert.equal(sent[1][2], 0x01 | 0x02 | 0x08 | 0x10);
});

test('controller: an unchanged frame sends nothing, a changed one only its header', async () => {
  const { ctl, sent } = fakeController();
  await ctl.write([[RED], [BLUE], null, null]);
  sent.length = 0;
  await ctl.write([[RED], [BLUE], null, null]);
  assert.equal(sent.length, 0);
  await ctl.write([[RED], [RED], null, null]);
  assert.deepEqual(sent.map(p => p[1]), [0x59, 0x28]);
});

test('controller: a header growing past a size step resends the counts', async () => {
  const { ctl, sent } = fakeController();
  await ctl.write([new Array(20).fill(RED), null, null, null]);
  sent.length = 0;
  await ctl.write([new Array(40).fill(RED), null, null, null]);
  assert.equal(sent[0][1], 0x34);
});

test('controller: release gives the headers back to the board', async () => {
  const { ctl, sent } = fakeController();
  await ctl.write([[RED], null, null, null]);
  sent.length = 0;
  await ctl.release();
  assert.deepEqual(sent.map(p => [p[1], p[2]]), [[0x32, 0], [0x28, 0xFF]]);
  sent.length = 0;
  await ctl.release();
  assert.equal(sent.length, 0, 'nothing to give back twice');
});

test('controller: a failed write never jams the queue', async () => {
  const { ctl, sent } = fakeController();
  let fail = true;
  ctl.dev.setFeature = async (buf) => { if (fail) { fail = false; throw new Error('gone'); } sent.push(buf); };
  await assert.rejects(ctl.write([[RED], null, null, null]));
  await ctl.write([[BLUE], null, null, null]);
  assert.ok(sent.some(p => p[1] === 0x58));
});

// The map and the Deck picker name a board's own LEDs after the output they hang
// on, so "Output 2 · 3" is the same piece in Settings and on a Deck key.
test('lighting map: an output and its pieces are named after the output', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../js/lighting-map.js', import.meta.url), 'utf8');
  const ctx = { window: { LightingUI: { tr: (key, fallback) => fallback } } };
  vm.runInNewContext(src, ctx);
  const { partLabels } = ctx.window.LightingMap;
  assert.deepEqual(Array.from(partLabels([
    { kind: 'header', output: 1 }, { kind: 'piece', output: 2 },
    { kind: 'piece', output: 3, piece: 1 }, { kind: 'piece', output: 3, piece: 2 },
    { kind: 'fan', output: 4 }, { kind: 'fan', output: 4 },
  ])), ['Uscita 1', 'Uscita 2', 'Uscita 3 · 1', 'Uscita 3 · 2', 'Ventola 1', 'Ventola 2']);
  assert.deepEqual(Array.from(partLabels([{ kind: 'board' }])), ['Luci della scheda madre'], 'the Deck picker names it on its own');
});

// The board's own lights (I/O cover, chipset accent, LED_C): one static colour
// per effect zone, never a zone a chip uses for an ARGB header.
test('onboard zones: the IT5711 skips the ARGB header zones 5 to 8', () => {
  assert.deepEqual(P.onboardZones(0x5711), [0, 1, 2, 3, 4, 9, 10]);
  assert.deepEqual(P.onboardZones(0x5702), [0, 1, 2, 3, 4]);
});

test('onboard zone packet: header, zone mask, static, full brightness, colour as B G R', () => {
  const pkt = P.zoneColorPacket(2, { r: 0x11, g: 0x22, b: 0x33 });
  assert.equal(pkt.length, 64);
  assert.equal(pkt[0], 0xCC);
  assert.equal(pkt[1], 0x22);
  assert.equal(pkt.readUInt32LE(2), 1 << 2);
  assert.equal(pkt.readUInt32LE(6), 0);
  assert.deepEqual([pkt[11], pkt[12], pkt[13]], [1, 0xFF, 0]);
  assert.deepEqual([pkt[14], pkt[15], pkt[16], pkt[17]], [0x33, 0x22, 0x11, 0]);
  assert.ok(pkt.subarray(18).every(b => b === 0), 'no timing: a steady colour');
  const high = P.zoneColorPacket(9, RED);
  assert.equal(high[1], 0x91);
  assert.equal(high.readUInt32LE(2), 1 << 9);
});

test('controller: onboard zones are painted once per change, then applied', async () => {
  const { ctl, sent } = fakeController();
  const zones = new Array(ctl.zones.length).fill(null);
  zones[1] = RED;
  await ctl.write([null, null, null, null], zones);
  assert.deepEqual(sent.slice(-2).map(p => p[1]), [0x21, 0x28]);
  sent.length = 0;
  await ctl.write([null, null, null, null], zones);
  assert.equal(sent.length, 0, 'same colour: nothing sent');
  zones[1] = BLUE;
  await ctl.write([null, null, null, null], zones);
  assert.deepEqual(sent.map(p => p[1]), [0x21, 0x28]);
  assert.ok(!sent.some(p => p[1] === 0x5E || p[1] === 0x33), 'never flash or calibration');
});

// The USB link is slow (~25 ms per report): painting never waits for it and
// only the newest frame is sent, so effects stay in time on every device.
function slowController() {
  const { ctl, sent } = fakeController();
  const gates = [];
  ctl.dev = { setFeature: (buf) => new Promise((resolve) => { sent.push(buf); gates.push(resolve); }) };
  // Lets every report through until `until` settles (default: painting is over).
  const flush = async (until) => {
    let settled = false;
    if (until) until.then(() => { settled = true; });
    while (until ? !settled : ctl.painting) {
      while (gates.length) gates.shift()();
      await new Promise(r => setTimeout(r, 1));
    }
  };
  return { ctl, sent, flush };
}

const greenOf = (pkt) => pkt[5];   // byte order GRB: the first LED's green

test('paint: returns at once; a frame overtaken while waiting is never sent', async () => {
  const { ctl, sent, flush } = slowController();
  const g = (v) => ({ r: 0, g: v, b: 0 });
  ctl.paint([[g(10)], null, null, null], []);
  ctl.paint([[g(20)], null, null, null], []);
  ctl.paint([[g(30)], null, null, null], []);
  assert.equal(sent.length, 0, 'nothing waited for');
  await flush();
  assert.deepEqual(sent.filter(p => p[1] === 0x58).map(greenOf), [10, 30], 'first frame, then straight to the newest');
});

test('paint: a failed frame reports once and the next frame still goes out', async () => {
  const { ctl, sent } = fakeController();
  let fail = true;
  ctl.dev = { setFeature: async (buf) => { if (fail) { fail = false; throw new Error('gone'); } sent.push(buf); } };
  const errors = [];
  ctl.paint([[RED], null, null, null], [], (e) => errors.push(e.message));
  await ctl.drained;
  ctl.paint([[BLUE], null, null, null], [], (e) => errors.push(e.message));
  await ctl.drained;
  assert.deepEqual(errors, ['gone']);
  assert.ok(sent.some(p => p[1] === 0x58));
});

test('paint: board lights give way while newer frames wait, then catch up', async () => {
  const { ctl, sent, flush } = slowController();
  const zones = (c) => new Array(ctl.zones.length).fill(c);
  ctl.paint([[RED], null, null, null], zones(RED));
  ctl.paint([[BLUE], null, null, null], zones(BLUE));
  await flush();
  const zonePkts = sent.filter(p => p[1] >= 0x20 && p[1] < 0x28 || p[1] >= 0x90);
  assert.equal(zonePkts.length, ctl.zones.length, 'only the newest board colour is sent');
  assert.ok(zonePkts.every(p => p[14] === BLUE.b && p[16] === BLUE.r));
  assert.equal(sent.filter(p => p[1] === 0x58).length, 2, 'both strip frames went out');
});

test('release drops a frame still waiting', async () => {
  const { ctl, sent, flush } = slowController();
  ctl.paint([[RED], null, null, null], []);
  ctl.paint([[BLUE], null, null, null], []);
  await flush(ctl.release());
  assert.equal(sent.filter(p => p[1] === 0x58).length, 1, 'the waiting frame never retook the headers');
  assert.equal(ctl.taken, false);
});

test('board segment: one dot per onboard zone, on an output no header uses', () => {
  assert.deepEqual(L.boardSegment([]), []);
  const [seg] = L.boardSegment([0, 1, 9]);
  assert.equal(seg.kind, 'board');
  assert.deepEqual(seg.ledIds.map(L.indexOfLuid), [0, 1, 9]);
  assert.ok(seg.ledIds.every(id => L.outputOfLuid(id) === L.BOARD_OUTPUT));
  const entry = { id: 'dev', ctl: { headers: 4, zones: [0, 1, 9] } };
  const ids = [L.luidOf(0, 0), seg.ledIds[2], seg.ledIds[0]];
  assert.deepEqual(native._zoneColorsFor(entry, ids, [BLUE, RED, BLUE]), [BLUE, null, RED]);
});

// A named output ("Ventole") is what the map, the Deck picker and widgets show.
test('layout name: cleaned, kept on counted outputs, carried into the segments', () => {
  const out = L.normalizeLayouts({ dev: {
    h0: { name: '  Ventole\u0007 ', parts: [{ kind: 'piece', count: 16 }] },
    h1: { name: 'x'.repeat(50), parts: [{ kind: 'piece', count: 4 }, { kind: 'piece', count: 4 }] },
    h2: { name: 'Nothing', empty: true },
    h3: { name: 42, parts: [{ kind: 'piece', count: 2 }] },
  } });
  assert.equal(out.dev.h0.name, 'Ventole');
  assert.equal(out.dev.h1.name.length, 32);
  assert.deepEqual(out.dev.h2, { empty: true, parts: [] });
  assert.equal(out.dev.h3.name, undefined);
  assert.equal(L.outputSegments(0, out.dev.h0)[0].name, 'Ventole');
  const split = L.outputSegments(1, { name: 'Fans', parts: [{ kind: 'piece', count: 4 }, { kind: 'piece', count: 4, name: 'Top' }] });
  assert.deepEqual(split.map(s => s.name), ['Fans · 1', 'Top']);
});
