// Brand protocols against fake links only: replies are built from what public tools print,
// and real captures are used where a source gives one. Nothing here opens a device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MODELS, byProduct } = require('../device-battery/brands/index.js');
const { productKey } = require('../device-battery/brands/ids.js');
const { createIo, fits } = require('../device-battery/direct.js');

const BRANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'device-battery', 'brands');
const RAZER = 0x1532;
const CORSAIR = 0x1B1C;
const HP = 0x03F0;
const NINTENDO = 0x057E;
const FEATURE_ZEROS = 65;

const noDelay = async () => {};
const bytes = (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex');
const toBuffer = (reply) => (typeof reply === 'string' ? bytes(reply) : reply);
const model = (vendorId, productId) => byProduct.get(productKey(vendorId, productId));
const vendorOf = (m) => Math.floor(m.products[0] / 0x10000);

// A report of `length` bytes with these values at these offsets.
function report(length, values) {
  const out = Buffer.alloc(length);
  for (const [at, value] of Object.entries(values)) out[at] = value;
  return out;
}

// Every frame the tests below make a model send, checked against the forbidden list at the end.
const everySent = [];

// Answers from a queue, then stays silent for as long as it is asked to wait.
function reportLink(replies = []) {
  const queue = replies.map(toBuffer);
  const sent = [];
  return {
    sent,
    write: async (b) => { sent.push(Buffer.from(b)); everySent.push(Buffer.from(b)); },
    read: async (timeoutMs) => {
      if (queue.length) return queue.shift();
      await sleep(timeoutMs);
      return null;
    },
  };
}

function featureLink(replies = []) {
  const queue = replies.map(toBuffer);
  const sent = [];
  return {
    sent,
    setFeature: async (b) => { sent.push(Buffer.from(b)); everySent.push(Buffer.from(b)); },
    getFeature: async () => queue.shift() ?? Buffer.alloc(FEATURE_ZEROS),
  };
}

async function readReports(m, replies, { leadingZero = false } = {}) {
  const link = reportLink(replies);
  const readings = await m.read(createIo({ link, size: m.size ?? 64, leadingZero, wait: noDelay }));
  return { readings, sent: link.sent };
}

async function readFeature(m, replies) {
  const feature = featureLink(replies);
  const readings = await m.read(createIo({ feature, size: m.size ?? 64, wait: noDelay }));
  return { readings, sent: feature.sent };
}

const startsWith = (frame, text) => assert.deepEqual([...frame.subarray(0, bytes(text).length)], [...bytes(text)]);

test('the table: no device in two models, and the rows left out on purpose stay out', () => {
  assert.equal(MODELS.flatMap((m) => m.products).length, byProduct.size);
  const leftOut = [[RAZER, 0x0528], [0x17EF, 0xA07D], [0x3434, 0xD048], [0x373B, 0x1154], [0x258A, 0x002E]];
  for (const [vendorId, productId] of leftOut) assert.equal(model(vendorId, productId), undefined);
});

test('the table: no brand file can reach an input report call', () => {
  for (const name of fs.readdirSync(BRANDS_DIR)) {
    const source = fs.readFileSync(path.join(BRANDS_DIR, name), 'utf8');
    assert.doesNotMatch(source, /(get|set)(Input|Output)Report/i, name);
  }
});

test('the table: a passive model fits a collection it can only hear', () => {
  const pad = model(0x28DE, 0x1304);
  assert.ok(fits(pad, { path: 'x', usagePage: 0xFF00, usage: 1, inputLength: 64, outputLength: 0 }));
  assert.ok(!fits(pad, { path: 'x', usagePage: 0xFF00, usage: 1, inputLength: 0 }));
});

// Logitech

const X2 = () => model(0x046D, 0x0AF7);
const X2_ROOT = '51 05 00 00 01 03 00';
const X2_ACK = '51 03 00 03 11';
const X2_LOOKUP = '51 09 00 03 10 00 04 00 00 01 04';

test('Centurion: the bridge, the feature lookup and the battery give 75 percent', async () => {
  const battery = '51 0B 00 03 10 00 06 00 04 01 4B 00 00';
  const { readings, sent } = await readReports(X2(), [X2_ROOT, X2_ACK, X2_LOOKUP, X2_ACK, battery]);
  assert.deepEqual(readings, [{ percent: 75, charging: false }]);
  startsWith(sent[0], '51 05 00 00 01 00 03');
  startsWith(sent[1], '51 0A 00 03 11 00 05 00 00 01 01 04');
  startsWith(sent[2], '51 08 00 03 11 00 03 00 04 01');
});

test('Centurion: charging, on the G522 prefix', async () => {
  const replies = ['50 23 05 00 00 01 03 00', '50 23 09 00 03 10 00 04 00 00 01 04', '50 23 0B 00 03 10 00 06 00 04 01 32 00 02'];
  const { readings, sent } = await readReports(model(0x046D, 0x0B18), replies);
  assert.deepEqual(readings, [{ percent: 50, charging: true }]);
  startsWith(sent[0], '50 23 05 00 00 01 00 03');
});

test('Centurion: a headset that is off, refuses or has no battery feature is no reading', async () => {
  const off = '51 05 00 03 00 00 00';
  const refused = '51 08 00 03 10 00 00 00 FF 00';
  const noFeature = '51 09 00 03 10 00 04 00 00 01 00';
  for (const reply of [off, refused, noFeature]) {
    assert.deepEqual((await readReports(X2(), [X2_ROOT, reply])).readings, []);
  }
});

test('ASTRO A50: the level after the bare acknowledgement, and the dock', async () => {
  const { readings, sent } = await readReports(model(0x046D, 0x0B1C), ['02 0C 03 00 06 0C', '02 0C 06 00 06 00 4B 4B 01']);
  assert.deepEqual(readings, [{ percent: 75, charging: true }]);
  startsWith(sent[0], '02 0C 03 00 06 0C');
});

test('ASTRO A50: only the acknowledgement, or a level of 0, is no reading', async () => {
  const a50 = model(0x046D, 0x0B1C);
  assert.deepEqual((await readReports(a50, ['02 0C 03 00 06 0C'])).readings, []);
  assert.deepEqual((await readReports(a50, ['02 0C 06 00 06 00 00 00 00'])).readings, []);
});

// HyperX

test('HyperX Cloud Alpha Wireless: link, level and charging, by command or by code', async () => {
  const headset = model(HP, 0x098D);
  const { readings, sent } = await readReports(headset, ['21 BB 03 02', '21 BB 0B 5A', '21 BB 0C 01']);
  assert.deepEqual(readings, [{ percent: 90, charging: true }]);
  assert.deepEqual(sent.map((f) => f[2]), [0x03, 0x0B, 0x0C]);
  assert.equal(sent[0].length, 31);
  const coded = await readReports(headset, ['21 BB 24 02', '21 BB 25 5A', '21 BB 26 00']);
  assert.deepEqual(coded.readings, [{ percent: 90, charging: false }]);
});

test('HyperX Cloud Alpha Wireless: a headset off the dongle is not asked its level', async () => {
  const { readings, sent } = await readReports(model(HP, 0x098D), ['21 BB 03 01']);
  assert.deepEqual(readings, []);
  assert.equal(sent.length, 1);
});

test('HyperX Pulsefire Haste 2: the level, and 0 for a mouse off', async () => {
  const mouse = model(HP, 0x0F98);
  assert.deepEqual((await readReports(mouse, ['51 02 3C'])).readings, [{ percent: 60, charging: null }]);
  assert.deepEqual((await readReports(mouse, ['51 02 00'])).readings, []);
});

// Razer

const blackShark = (command, value) => report(64, { 0: 0x02, 12: command, 13: 0x01, 14: 0x01, 15: value });

test('Razer BlackShark V2 Pro: level and charging, on the 2023 ids', async () => {
  for (const productId of [0x0555, 0x0556]) {
    const { readings, sent } = await readReports(model(RAZER, productId), [blackShark(0x21, 80), blackShark(0x2A, 1)]);
    assert.deepEqual(readings, [{ percent: 80, charging: true }]);
    startsWith(sent[0], '02 80 08 00 00 50 41 08 00 03 21');
    startsWith(sent[1], '02 80 08 00 00 50 41 08 00 03 2A');
  }
});

test('Razer BlackShark V2 Pro: silence is no reading, after three tries of the same read', async () => {
  const { readings, sent } = await readReports(model(RAZER, 0x0555), []);
  assert.deepEqual(readings, []);
  assert.equal(sent.length, 3);
});

test('Razer Barracuda Pro: still read from its new file', async () => {
  const reply = report(64, { 0: 0x01, 1: 0x80, 3: 0x50, 4: 0x49, 13: 0x21, 16: 44 });
  assert.deepEqual((await readReports(model(RAZER, 0x053A), [reply])).readings, [{ percent: 44, charging: null }]);
});

// ASUS

const asusMouse = (level, charging) => report(64, { 0: 0x12, 1: 0x07, 4: level, 9: charging });
const ASUS_ASLEEP = report(64, { 0: 0xFF, 1: 0xAA });

test('ASUS mouse: a percent, a gauge of 0 to 4, and the 0 Windows puts first', async () => {
  const percent = await readReports(model(0x0B05, 0x197F), [Buffer.concat([Buffer.alloc(1), asusMouse(90, 1)])], { leadingZero: true });
  assert.deepEqual(percent.readings, [{ percent: 90, charging: true }]);
  startsWith(percent.sent[0], '00 12 07');
  assert.equal(percent.sent[0].length, 65);
  const gauge = await readReports(model(0x0B05, 0x18E5), [asusMouse(3, 0)]);
  assert.deepEqual(gauge.readings, [{ percent: 75, charging: false }]);
});

test('ASUS mouse: FF AA, a level of 0 and a gauge past its top are no reading', async () => {
  assert.deepEqual((await readReports(model(0x0B05, 0x197F), [ASUS_ASLEEP])).readings, []);
  assert.deepEqual((await readReports(model(0x0B05, 0x197F), [asusMouse(0, 1)])).readings, []);
  assert.deepEqual((await readReports(model(0x0B05, 0x18E5), [asusMouse(5, 0)])).readings, []);
});

test('ASUS keyboard: the level at its own offset, on each layout', async () => {
  const scope = await readReports(model(0x0B05, 0x1A07), [report(64, { 0: 0x12, 1: 0x01, 5: 60, 8: 1 })]);
  assert.deepEqual(scope.readings, [{ percent: 60, charging: true }]);
  startsWith(scope.sent[0], '00 12 01');
  const falchion = await readReports(model(0x0B05, 0x1B04), [report(64, { 0: 0x12, 1: 0x01, 5: 7, 10: 70 })]);
  assert.deepEqual(falchion.readings, [{ percent: 70, charging: false }]);
});

test('ASUS keyboard: asleep is no reading', async () => {
  assert.deepEqual((await readReports(model(0x0B05, 0x1A07), [ASUS_ASLEEP])).readings, []);
});

test('the ASUS mouse row talks to interface 0 of its vendor page', () => {
  const mouse = model(0x0B05, 0x197F);
  assert.ok(fits(mouse, { path: 'hid#vid_0b05&pid_197f&mi_00', usagePage: 0xFF01, outputLength: 65 }));
  assert.ok(!fits(mouse, { path: 'hid#vid_0b05&pid_197f&mi_02', usagePage: 0xFF01, outputLength: 65 }));
});

// Compx variants

test('ATK Zero: the dongle frame and a level', async () => {
  const { readings, sent } = await readReports(model(0x373B, 0x1155), [report(64, { 0: 0x08, 1: 0x72, 5: 0x07, 7: 55 })]);
  assert.deepEqual(readings, [{ percent: 55, charging: null }]);
  startsWith(sent[0], '08 7D 72 02 00 01 07 01');
});

test('ATK Zero: a level of 0 is no reading', async () => {
  const reply = report(64, { 0: 0x08, 1: 0x72, 5: 0x07 });
  assert.deepEqual((await readReports(model(0x373B, 0x124F), [reply])).readings, []);
});

function xs1Reply(status, command, value) {
  const buffer = report(65, { 1: status, 2: command[0], 3: command[1], 4: command[2], 7: value });
  const sum = buffer.subarray(1, 63).reduce((total, b) => total + b, 0);
  buffer.writeUInt16LE(sum & 0xFFFF, 63);
  return buffer;
}
const XS1_BATTERY = [0x08, 0x81, 0x01];
const XS1_CHARGING = [0x08, 0x83, 0x01];

test('Pulsar XS-1: the checksummed frames, the level and charging', async () => {
  const { readings, sent } = await readFeature(model(0x3710, 0x5403), [xs1Reply(1, XS1_BATTERY, 70), xs1Reply(1, XS1_CHARGING, 1)]);
  assert.deepEqual(readings, [{ percent: 70, charging: true }]);
  startsWith(sent[0], '00 00 08 81 01');
  assert.equal(sent[0].length, 65);
  assert.equal(sent[0].readUInt16LE(63), 0x08 + 0x81 + 0x01);
});

test('Pulsar XS-1: no mouse, pending and a bad sum are no reading', async () => {
  const mouse = model(0x3710, 0x3408);
  const badSum = xs1Reply(1, XS1_BATTERY, 70);
  badSum[63] ^= 0xFF;
  for (const reply of [xs1Reply(1, XS1_BATTERY, 0xFF), xs1Reply(2, XS1_BATTERY, 70), badSum]) {
    assert.deepEqual((await readFeature(mouse, [reply])).readings, []);
  }
});

// Mice of smaller brands

const KEYCHRON_STATUS = 'b6 05 01 11 11 01 90 01 20 03 b0 04 40 06 80 0c 01 05 03 1e 45';

test('Keychron: the capture of a real receiver gives 69 percent', async () => {
  const receiver = model(0x3434, 0xD028);
  const { readings, sent } = await readReports(receiver, [KEYCHRON_STATUS]);
  assert.deepEqual(readings, [{ percent: 69, charging: null }]);
  startsWith(sent[0], 'B3 05');
  const big = Buffer.concat([bytes(KEYCHRON_STATUS), Buffer.alloc(40)]);
  big[0] = 0xB4;
  assert.deepEqual((await readReports(receiver, [big])).readings, [{ percent: 69, charging: null }]);
});

test('Keychron: a sleeping mouse stays silent through the three tries', async () => {
  const { readings, sent } = await readReports(model(0x3434, 0xD028), []);
  assert.deepEqual(readings, []);
  assert.equal(sent.length, 3);
});

test('Alienware: the capture of a real mouse gives 70 percent', async () => {
  const { readings, sent } = await readReports(model(0x413C, 0x302D), ['c0 0a 09 00 00 46 00 00 e3 01 46 00 00']);
  assert.deepEqual(readings, [{ percent: 70, charging: false }]);
  startsWith(sent[0], '00 C0 0A 00 00 00 00');
});

test('Alienware: a dongle with no mouse linked is no reading', async () => {
  assert.deepEqual((await readReports(model(0x413C, 0x302D), ['c0 0a 03 00 ec fa 0d'])).readings, []);
});

const sora = (level, charging, online) => report(32, { 0: 0x05, 1: 0x15, 9: level, 10: charging, 12: online });

test('Ninjutso Sora: the dongle with the mouse online, and the cable', async () => {
  const { readings, sent } = await readFeature(model(0x1915, 0xAE1C), [sora(80, 1, 1)]);
  assert.deepEqual(readings, [{ percent: 80, charging: true }]);
  startsWith(sent[0], '05 15 00 00 01 00 00 04');
  assert.deepEqual((await readFeature(model(0x1915, 0xAE12), [sora(60, 0, 0)])).readings, [{ percent: 60, charging: false }]);
});

test('Ninjutso Sora: a last value with the mouse gone, or no data, is no reading', async () => {
  assert.deepEqual((await readFeature(model(0x1915, 0xAE1C), [sora(80, 0, 0)])).readings, []);
  const { readings, sent } = await readFeature(model(0x1915, 0xAE1C), [sora(0, 0, 1), sora(0, 0, 1), sora(0, 0, 1)]);
  assert.deepEqual(readings, []);
  assert.equal(sent.length, 3);
});

const op1w = (status, level) => report(64, { 0: 0xA1, 1: status, 16: level });

test('Endgame Gear OP1w: ready gives the level, busy is asked again', async () => {
  const { readings, sent } = await readFeature(model(0x3367, 0x1970), [op1w(3, 0), op1w(1, 55)]);
  assert.deepEqual(readings, [{ percent: 55, charging: null }]);
  startsWith(sent[0], 'A1 B4');
  assert.equal(sent.length, 2);
});

test('Endgame Gear OP1w: gone, and a level past 100, are no reading', async () => {
  const mouse = model(0x3367, 0x1984);
  assert.deepEqual((await readFeature(mouse, [op1w(8, 55)])).readings, []);
  assert.deepEqual((await readFeature(mouse, [op1w(1, 0xFF)])).readings, []);
});

test('Cherry: the dongle answers on 0x20, with charging', async () => {
  const { readings, sent } = await readReports(model(0x046A, 0x01AC), [report(64, { 0: 0x04, 1: 0x20, 8: 64, 9: 1 })]);
  assert.deepEqual(readings, [{ percent: 64, charging: true }]);
  startsWith(sent[0], '04 20 00 1A 06');
});

test('Cherry: a reply with no level is passed over', async () => {
  assert.deepEqual((await readReports(model(0x046A, 0x01AC), [report(64, { 0: 0x04, 1: 0x20 })])).readings, []);
});

test('Redragon: the read frame of the dongle, and 87 percent', async () => {
  const { readings, sent } = await readFeature(model(0x258A, 0x002F), ['05 90 11 57 00 00 00 00']);
  assert.deepEqual(readings, [{ percent: 87, charging: null }]);
  assert.deepEqual([...sent[0]], [0x05, 0x90, 0, 0, 0, 0]);
});

test('Redragon: a mouse asleep says 0', async () => {
  assert.deepEqual((await readFeature(model(0x258A, 0x002F), ['05 90 11 00 00 00 00 00'])).readings, []);
});

test('MCHOSE G7: both real captures give 46 percent', async () => {
  const mouse = model(0xA8A5, 0x2255);
  const idle = await readReports(mouse, ['aa 30 a5 0b 0a 01 01 01 2e 00 00 00']);
  assert.deepEqual(idle.readings, [{ percent: 46, charging: false }]);
  startsWith(idle.sent[0], '00 55 30 A5 0B 2E 01 01 01');
  const charging = await readReports(mouse, ['aa 30 a5 3c 0a 01 01 01 2e 01 00 00']);
  assert.deepEqual(charging.readings, [{ percent: 46, charging: true }]);
});

test('MCHOSE G7: a level of 0 is no reading', async () => {
  assert.deepEqual((await readReports(model(0xA8A5, 0x2255), ['aa 30 a5 0b 0a 01 01 01 00 00 00 00'])).readings, []);
});

test('MCHOSE X9: the level, and 0 for a mouse asleep', async () => {
  const mouse = model(0x3837, 0x6045);
  const { readings, sent } = await readReports(mouse, ['55 65 50 02']);
  assert.deepEqual(readings, [{ percent: 80, charging: null }]);
  startsWith(sent[0], '55 65 01');
  assert.deepEqual((await readReports(mouse, ['55 65 00 02'])).readings, []);
});

test('MCHOSE A5 Pro Max: an awake mouse, on the third try', async () => {
  const asleep = report(65, { 1: 0xA4, 6: 0x83 });
  const awake = report(65, { 1: 0xA1, 6: 0x83, 7: 1, 8: 75 });
  const { readings, sent } = await readFeature(model(0x2023, 0xF013), [asleep, asleep, awake]);
  assert.deepEqual(readings, [{ percent: 75, charging: true }]);
  startsWith(sent[0], '00 00 00 02 02 00 83');
});

test('MCHOSE A5 Pro Max: a mouse asleep is no reading', async () => {
  assert.deepEqual((await readFeature(model(0x2023, 0xF019), [])).readings, []);
});

test('Akko S9 Ultra: the 64-byte frame with its tail, and a level', async () => {
  const { readings, sent } = await readReports(model(0x36EB, 0x1087), ['02 12 01 00 3C']);
  assert.deepEqual(readings, [{ percent: 60, charging: null }]);
  startsWith(sent[0], '02 12 01');
  assert.equal(sent[0].length, 64);
  assert.deepEqual([...sent[0].subarray(62)], [0x71, 0x12]);
});

test('Akko S9 Ultra: a reply with a level of 0 is passed over', async () => {
  assert.deepEqual((await readReports(model(0x36EB, 0x1087), ['02 12 01 00 00'])).readings, []);
});

// Passive: nothing goes out, whatever comes in.

async function listenTo(m, replies) {
  const { readings, sent } = await readReports(m, replies);
  assert.equal(sent.length, 0);
  return readings;
}

test('Attack Shark: percent, docked, and the X6 scale of 1 to 10', async () => {
  const mouse = model(0x1D57, 0xFA60);
  assert.deepEqual(await listenTo(mouse, ['03 55 40 01 4B']), [{ percent: 75, charging: false }]);
  assert.deepEqual(await listenTo(mouse, ['03 BE 40 80 32']), [{ percent: 50, charging: true }]);
  assert.deepEqual(await listenTo(model(0x1D57, 0xFA62), ['03 85 40 01 07']), [{ percent: 70, charging: false }]);
});

test('Attack Shark: 0 and a report of another kind are no reading', async () => {
  const mouse = model(0x1D57, 0xFA60);
  assert.deepEqual(await listenTo(mouse, ['03 55 40 01 00']), []);
  assert.deepEqual(await listenTo(mouse, ['03 55 41 01 4B']), []);
});

test('Sony PULSE 3D: a level with the headset connected', async () => {
  assert.deepEqual(await listenTo(model(0x054C, 0x0D5E), ['b0 00 00 50 08 00 00 00']), [{ percent: 80, charging: false }]);
});

test('Sony PULSE 3D: charging replaces the level, and off means no reading', async () => {
  const headset = model(0x054C, 0x0D5E);
  assert.deepEqual(await listenTo(headset, ['b0 00 00 80 08 00 00 00']), []);
  assert.deepEqual(await listenTo(headset, ['b0 00 00 50 00 00 00 00']), []);
});

const buds = (right, left) => report(20, { 0: 0x02, 1: 0x12, 2: 0x04, 14: right, 16: left, 19: (right + left + 117) & 0xFF });

test('Sony INZONE Buds: the lower of the two buds', async () => {
  assert.deepEqual(await listenTo(model(0x054C, 0x0EC2), [buds(80, 60)]), [{ percent: 60, charging: null }]);
});

test('Sony INZONE Buds: a bad sum and a bud at 0 are no reading', async () => {
  const headset = model(0x054C, 0x0EC2);
  const bad = buds(80, 60);
  bad[19] ^= 0xFF;
  assert.deepEqual(await listenTo(headset, [bad]), []);
  assert.deepEqual(await listenTo(headset, [buds(0, 60)]), []);
});

test('JBL Quantum 910: the captures of 30 and 95 percent', async () => {
  const headset = model(0x0ECB, 0x2088);
  assert.deepEqual(await listenTo(headset, ['08 1e']), [{ percent: 30, charging: null }]);
  assert.deepEqual(await listenTo(headset, ['09 00', '08 5f']), [{ percent: 95, charging: null }]);
});

test('JBL Quantum 910: a level of 0 is no reading', async () => {
  assert.deepEqual(await listenTo(model(0x0ECB, 0x2088), ['08 00']), []);
});

test('Steam Controller: discharging, charging and done', async () => {
  const puck = model(0x28DE, 0x1304);
  const status = (state, level) => report(15, { 0: 0x43, 1: state, 2: level });
  assert.deepEqual(await listenTo(puck, [status(1, 75)]), [{ percent: 75, charging: false }]);
  assert.deepEqual(await listenTo(puck, [status(2, 75)]), [{ percent: 75, charging: true }]);
  assert.deepEqual(await listenTo(puck, [status(4, 100)]), [{ percent: 100, charging: false }]);
});

test('Steam Controller: an unknown state, a short report and a level of 0 are no reading', async () => {
  const puck = model(0x28DE, 0x1305);
  const replies = [report(15, { 0: 0x43, 1: 3, 2: 75 }), report(8, { 0: 0x43, 1: 1, 2: 75 }), report(15, { 0: 0x43, 1: 1 })];
  assert.deepEqual(await listenTo(puck, replies), []);
});

test('8BitDo Pro 3: padding is passed over, then level and charging', async () => {
  const pad = model(0x2DC8, 0x6009);
  assert.deepEqual(await listenTo(pad, [report(20, { 0: 0x04 }), report(20, { 0: 0x04, 14: 0x80 | 60 })]), [{ percent: 60, charging: true }]);
  assert.deepEqual(await listenTo(pad, [report(20, { 0: 0x04, 14: 60 })]), [{ percent: 60, charging: false }]);
});

test('8BitDo Pro 3: only padding is no reading', async () => {
  assert.deepEqual(await listenTo(model(0x2DC8, 0x6009), [report(20, { 0: 0x04 })]), []);
});

test('Switch: the level of 0 to 4 and the charging bit', async () => {
  const pad = model(NINTENDO, 0x2009);
  assert.deepEqual(await listenTo(pad, ['30 00 90']), [{ percent: 100, charging: true }]);
  assert.deepEqual(await listenTo(model(NINTENDO, 0x2006), ['21 00 40']), [{ percent: 50, charging: false }]);
  assert.deepEqual(await listenTo(model(NINTENDO, 0x2007), ['31 00 20']), [{ percent: 25, charging: false }]);
});

test('Switch: an empty level, one past the top and the simple report are no reading', async () => {
  const pad = model(NINTENDO, 0x2009);
  assert.deepEqual(await listenTo(pad, ['30 00 10']), []);
  assert.deepEqual(await listenTo(pad, ['30 00 A0']), []);
  assert.deepEqual(await listenTo(pad, ['3F 00 90']), []);
});

// The guard

function assertNotForbidden(frame, vendor) {
  const p = frame.subarray(frame[0] === 0 ? 1 : 0);
  const hex = frame.toString('hex');
  assert.ok(!hex.startsWith('020801030002'), 'Corsair software mode');
  assert.notDeepEqual([...p.subarray(0, 2)], [0x08, 0x06], 'Glorious reset');
  assert.notEqual(p[0], 0x75, 'Sinowealth firmware mode');
  assert.notDeepEqual([...frame.subarray(0, 2)], [0x80, 0x02], 'Switch USB handshake');
  if (vendor === RAZER) assert.ok(!frame.includes(0xE1), 'Razer remote mode');
  if (vendor === CORSAIR) assert.notEqual(frame[2], 0x01, 'Bragi SET');
  if (vendor === HP && frame[0] === 0x0C) assert.notEqual(frame[3], 0x00, 'Cloud III S write');
}

test('on a silent link no model sends a forbidden frame, and passive models send nothing', async () => {
  const runs = MODELS.map(async (m) => {
    const sent = [];
    const fed = [];
    const link = { write: async (b) => { sent.push(Buffer.from(b)); }, read: async (timeoutMs) => { await sleep(timeoutMs); return null; } };
    const feature = { setFeature: async (b) => { fed.push(Buffer.from(b)); }, getFeature: async () => Buffer.alloc(FEATURE_ZEROS) };
    await m.read(createIo({ link, feature, size: m.size ?? 64, wait: noDelay }));
    return { m, frames: [...sent, ...fed] };
  });
  const results = await Promise.all(runs);
  assert.ok(results.some(({ frames }) => frames.length));
  for (const { m, frames } of results) {
    if (m.listenOnly) assert.equal(frames.length, 0, m.label);
    for (const frame of frames) assertNotForbidden(frame, vendorOf(m));
  }
});

test('no frame sent by any test above is a forbidden one', () => {
  assert.ok(everySent.length > 0);
  for (const frame of everySent) assertNotForbidden(frame);
  const razerFrames = everySent.filter((frame) => frame[0] === 0x02 && frame[1] === 0x80);
  assert.ok(razerFrames.length > 0);
  for (const frame of razerFrames) assertNotForbidden(frame, RAZER);
});
