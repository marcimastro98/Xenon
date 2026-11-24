// The lights of an iCUE LINK hub while Airflow holds it: the colour frame of the protocol,
// where each LED sits in it (corsair-link-lights.js, measured on a real chain's USB traffic),
// the session's colour handle, the painter that never queues (link-lights.js), and the
// driver handing its session to the lights, end to end on the stand-in hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeLinkHub, deviceEntry, EMPTY } from './airflow-link-fake.mjs';

const require = createRequire(import.meta.url);
const P = require('../airflow/corsair-link-protocol.js');
const { layoutOf, frameOf, ledId } = require('../airflow/corsair-link-lights.js');
const { createLinkSession } = require('../airflow/corsair-link-session.js');
const { createLinkLights, DEVICE_ID } = require('../airflow/link-lights.js');
const { createLinkDriver } = require('../airflow/driver-link.js');

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };
// The measured chain: a screen on 1, a TITAN pump on 2, three RX RGB fans on 13-15.
const CHAIN = [
  { channel: 1, type: 0x06, model: 0 }, { channel: 2, type: 0x11, model: 5 },
  { channel: 13, type: 0x0f, model: 0 }, { channel: 14, type: 0x0f, model: 0 }, { channel: 15, type: 0x0f, model: 0 },
];
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const slotsOf = (l, seg) => seg.ledIds.map((id) => l.slotOf.get(id));
const until = async (ok) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(ok(), 'never settled');
};

test('colour frames: the bytes iCUE sends, RGB clamped to whole bytes, one report at most', () => {
  assert.deepEqual(P.COMMAND.openColours(), [0x0d, 0x00, 0x22]);
  assert.deepEqual(P.COMMAND.closeColours(), [0x05, 0x01, 0x00]);
  assert.deepEqual(P.COMMAND.colours([]), [0x06, 0x00, 0x02, 0x00, 0x00, 0x00, 0x12, 0x00], 'the empty frame first');
  const data = P.colourData([RED, { r: -5, g: 300, b: 12.6 }, null]);
  assert.deepEqual(data, [255, 0, 0, 0, 255, 13, 0, 0, 0]);
  assert.deepEqual(P.COMMAND.colours(data).slice(0, 8), [0x06, 0x00, 11, 0x00, 0x00, 0x00, 0x12, 0x00]);
  const full = P.colourData(new Array(P.MAX_COLOUR_SLOTS).fill(BLUE));
  assert.equal(P.packet(P.COMMAND.colours(full)).length, P.REPORT_BYTES);
  assert.throws(() => P.colourData(new Array(P.MAX_COLOUR_SLOTS + 1).fill(BLUE)), /do not fit/);
});

test('the measured chain: 68 slots, the pump ring then the screen ring as iCUE draws them, fans in order', () => {
  const l = layoutOf(CHAIN);
  assert.equal(l.ok, true);
  assert.equal(l.slots, 68);
  assert.deepEqual(l.segments.map((s) => [s.kind, s.model, s.ledIds.length]), [
    ['pump', 'TITAN AIO pump', 40], ['fan', 'RX RGB fan', 8], ['fan', 'RX RGB fan', 8], ['fan', 'RX RGB fan', 8],
  ]);
  assert.deepEqual(slotsOf(l, l.segments[0]), [...range(30, 43), ...range(20, 29), ...range(11, 15), ...range(0, 10)]);
  assert.deepEqual(l.segments.map((s) => s.rings), [[24, 16], undefined, undefined, undefined], "the pump says where its own ring ends and the screen's begins");
  assert.deepEqual(layoutOf([{ channel: 1, type: 0x06, model: 0 }]).segments.map((s) => [s.kind, s.rings]), [['pump', [16]]], 'a screen with no pump beside it: one ring');
  assert.deepEqual(l.segments.slice(1).map((s) => slotsOf(l, s)), [range(44, 51), range(52, 59), range(60, 67)]);
  // The screen's last four slots have no light: nothing ever paints them.
  assert.ok(range(16, 19).every((slot) => ![...l.slotOf.values()].includes(slot)));
  assert.deepEqual(layoutOf([...CHAIN].reverse()), l, 'channel order, whatever order the list came in');
});

test('a LED keeps its id when the chain grows; its slot moves', () => {
  const l = layoutOf(CHAIN);
  const grown = layoutOf([{ channel: 3, type: 0x0f, model: 0 }, ...CHAIN]);
  const fan13 = ledId(13, 0);
  assert.ok(l.segments[1].ledIds.includes(fan13) && grown.segments[2].ledIds.includes(fan13));
  assert.equal(l.slotOf.get(fan13), 44);
  assert.equal(grown.slotOf.get(fan13), 52);
});

test('a device whose slots were never measured, or a chain past one report, gets no lights', () => {
  assert.deepEqual(layoutOf([...CHAIN, { channel: 3, type: 0x01, model: 0 }]), { ok: false, why: 'unknown-leds' });
  assert.deepEqual(layoutOf([{ channel: 1, type: 0x0e, model: 0 }]), { ok: false, why: 'unknown-leds' });
  const many = range(1, 21).map((channel) => ({ channel, type: 0x0f, model: 0 }));
  assert.deepEqual(layoutOf(many), { ok: false, why: 'too-many-leds' });
  assert.equal(layoutOf(many.slice(0, 20)).ok, true);
  // A screen with no pump under it is still drawn, as a pump part.
  assert.deepEqual(layoutOf([{ channel: 1, type: 0x06, model: 0 }]).segments.map((s) => [s.kind, s.ledIds.length]), [['pump', 16]]);
});

test('a frame puts each colour on its slot, the rest dark', () => {
  const l = layoutOf(CHAIN);
  const pump = l.segments[0].ledIds;
  const frame = frameOf(l, [pump[0], pump[24], ledId(15, 7), 99999], [RED, BLUE, RED, RED]);
  assert.equal(frame.length, 68);
  assert.deepEqual([frame[30], frame[11], frame[67]], [RED, BLUE, RED]);
  assert.equal(frame.filter((c) => c.r || c.g || c.b).length, 3, 'an id not on the chain paints nothing');
  assert.deepEqual(frameOf(l, [pump[0]], [null])[30], { r: 0, g: 0, b: 0 });
});

test('the session opens the colour handle once, as iCUE does, and again after the hub fell back', async () => {
  const hub = fakeLinkHub();
  const s = createLinkSession({ link: hub.link, leadingZero: true });
  await s.software();
  assert.equal(s.coloursOpen(), false);
  const one = P.colourData([RED, BLUE]);
  await s.paint(one);
  await s.paint(one);
  assert.deepEqual(hub.log.slice(1), ['05 01 00 00', '0d 00 22 00', '06 00 02 00', '06 00 08 00', '06 00 08 00']);
  assert.deepEqual(hub.frames, [[], one, one]);
  assert.equal(s.coloursOpen(), true);
  // The hub went back to hardware mode by itself: the frame is refused, the session enters
  // software mode again, reopens the handle and paints.
  hub.mode = 'hardware';
  hub.colours = null;
  await s.paint(one);
  assert.deepEqual(hub.frames.slice(-2), [[], one]);
  assert.equal(s.retakes(), 1);
});

// A stand-in session whose frames finish when the test says.
function fakeSession() {
  const s = {
    open: true, painted: [], pending: [], coloursOpen: () => s.open,
    paint: (data) => new Promise((resolve, reject) => { s.painted.push(data); s.pending.push({ resolve, reject }); }),
  };
  s.finish = async (err) => {
    const p = s.pending.shift();
    if (err) p.reject(err); else p.resolve();
    await new Promise((r) => setImmediate(r));
  };
  return s;
}

test('the hub shows in the lights only while held, with a chain it can lay out', () => {
  let changes = 0;
  const lights = createLinkLights({ onChange: () => changes++ });
  assert.deepEqual(lights.devices(), []);
  lights.attach(fakeSession(), [...CHAIN, { channel: 3, type: 0x01, model: 0 }]);
  assert.deepEqual([lights.devices(), lights.why(), changes], [[], 'unknown-leds', 0]);
  const s = fakeSession();
  lights.attach(s, CHAIN);
  const [dev] = lights.devices();
  assert.deepEqual([dev.id, dev.source, dev.maker, dev.ledCount, lights.why(), changes], [DEVICE_ID, 'native', 'CORSAIR', 64, null, 1]);
  assert.deepEqual(dev.ledIds, dev.segments.flatMap((g) => g.ledIds));
  assert.equal(lights.owns(DEVICE_ID), true);
  lights.attach(s, CHAIN);
  assert.equal(changes, 1, 'the same hub and chain: nothing changed');
  lights.attach(fakeSession(), CHAIN);
  assert.equal(changes, 2, 'a new session lays the hub out again');
  lights.detach();
  assert.deepEqual([lights.devices(), lights.owns(DEVICE_ID), changes], [[], false, 3]);
});

test('frames never queue: one on its way, only the newest waits', async () => {
  const lights = createLinkLights();
  const s = fakeSession();
  lights.attach(s, CHAIN);
  const [dev] = lights.devices();
  const paint = (c) => lights.write(dev, dev.ledIds.map(() => c));
  assert.equal(lights.write({ ...dev, id: 'other' }, []), false, 'another device is not this hub');
  assert.equal(paint(RED), true);
  paint(BLUE);
  paint({ r: 0, g: 255, b: 0 });
  assert.equal(s.painted.length, 1);
  await s.finish();
  assert.equal(s.painted.length, 2);
  assert.deepEqual(s.painted[1].slice(30 * 3, 30 * 3 + 3), [0, 255, 0], 'the newest, the one between dropped');
  await s.finish();
  assert.equal(s.painted.length, 2);
});

test('a frame the hub did not take is painted again at the next read; one warning per run of failures', async () => {
  const warned = [];
  const lights = createLinkLights({ warn: (m) => warned.push(m) });
  const s = fakeSession();
  lights.attach(s, CHAIN);
  const [dev] = lights.devices();
  lights.write(dev, dev.ledIds.map(() => RED));
  await s.finish(new Error('the hub did not answer'));
  lights.write(dev, dev.ledIds.map(() => BLUE));
  await s.finish(new Error('the hub did not answer'));
  assert.equal(warned.length, 1);
  lights.attach(s, CHAIN);
  assert.equal(s.painted.length, 3);
  assert.deepEqual(s.painted[2], s.painted[1], 'the failed frame again');
  await s.finish();
  lights.attach(s, CHAIN);
  assert.equal(s.painted.length, 3, 'taken: nothing to repaint');
  // The hub fell back to hardware mode: its last frame again.
  s.open = false;
  lights.attach(s, CHAIN);
  assert.deepEqual(s.painted[3], s.painted[2]);
});

test('off paints every slot dark', async () => {
  const lights = createLinkLights();
  const s = fakeSession();
  await lights.off();
  assert.equal(s.painted.length, 0, 'not held: nothing to darken');
  lights.attach(s, CHAIN);
  const done = lights.off();
  await s.finish();
  await done;
  assert.deepEqual(s.painted[0], new Array(68 * 3).fill(0));
});

test('end to end: the driver hands its hub to the lights, a frame reaches it, release takes them away', async () => {
  const at = (ch, entry) => ({ ch, entry });
  const list = [at(1, deviceEntry(0x06, 0, 'LCDID')), at(2, deviceEntry(0x11, 5, 'PUMPID')),
    at(13, deviceEntry(0x0f, 0, 'FANA')), at(14, deviceEntry(0x0f, 0, 'FANB')), at(15, deviceEntry(0x0f, 0, 'FANC'))];
  const channels = range(1, 15).map((ch) => list.find((d) => d.ch === ch)?.entry ?? EMPTY);
  const hub = fakeLinkHub({ channels, rpm: new Array(16).fill(900), temps: new Array(16).fill(null) });
  let changes = 0;
  const lights = createLinkLights({ onChange: () => changes++ });
  let t = 1000;
  const driver = createLinkDriver({
    hid: { list: async () => [{ vendorId: 0x1b1c, productId: 0x0c3f, usagePage: 0xff42, usage: 1, outputLength: 513, path: 'cmd' }] },
    openReports: async () => hub.link, leadingZero: true, busy: async () => [], now: () => (t += 10), lights,
  });
  await driver.poll();
  const [dev] = lights.devices();
  assert.equal(dev.ledCount, 64);
  assert.equal(changes, 1);
  lights.write(dev, dev.ledIds.map((_, i) => (i === 0 ? RED : null)));
  await until(() => hub.frames.length === 2);
  assert.equal(hub.frames[1].length, 68 * 3);
  assert.deepEqual(hub.frames[1].slice(30 * 3, 31 * 3), [255, 0, 0]);
  await driver.release();
  assert.deepEqual([lights.devices(), changes, hub.mode], [[], 2, 'hardware']);
});
