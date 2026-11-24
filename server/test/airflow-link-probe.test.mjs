// The iCUE LINK probe (tools/airflow-spike/link-probe-run.mjs) on a stand-in hub: it
// lists the chain, reads for a while, never sets a speed, stops when a pump slows, and
// always gives the hub back to hardware mode, even after an error. With --colours it paints
// a chain it can lay out, and names one it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeLinkHub, deviceEntry, EMPTY } from './airflow-link-fake.mjs';
import { runProbe, pumpDrop, listInTwoReads } from '../../tools/airflow-spike/link-probe-run.mjs';

const quiet = { log: () => {}, sleep: async () => {} };

test('newer firmware lists the chain in two reads', () => {
  assert.equal(listInTwoReads({ major: 2, minor: 4 }), false);
  assert.equal(listInTwoReads({ major: 2, minor: 5 }), true);
  assert.equal(listInTwoReads({ major: 3, minor: 0 }), true);
  assert.equal(listInTwoReads(null), false);
});

test('a pump under half its first speed, or gone, stops the probe', () => {
  const first = new Map([[1, 2400], [2, 900]]);
  assert.equal(pumpDrop(first, new Map([[1, 1300]]), [1]), null);
  assert.deepEqual(pumpDrop(first, new Map([[1, 1100]]), [1]), { channel: 1, first: 2400, now: 1100 });
  assert.deepEqual(pumpDrop(first, new Map(), [1]), { channel: 1, first: 2400, now: null });
  assert.equal(pumpDrop(first, new Map(), []), null);
});

test('the probe lists, reads, never writes a speed, and ends in hardware mode', async () => {
  const hub = fakeLinkHub();
  const out = await runProbe({ link: hub.link, leadingZero: true, seconds: 3, ...quiet });
  assert.equal(out.firmware.text, '3.11.646');
  assert.deepEqual(out.devices.map((d) => [d.channel, d.kind, d.name]), [[1, 'pump', 'H150i pump'], [2, 'fan', 'QX fan']]);
  assert.equal(out.samples.length, 3);
  assert.deepEqual(out.samples[0], { rpm: { 1: 2400, 2: 900 }, temps: { 1: 31.2, 2: 29 } });
  assert.equal(hub.speeds.size, 0);
  assert.ok(!hub.log.some((l) => l.startsWith('06')));
  assert.equal(out.backToHardware, true);
  assert.equal(hub.mode, 'hardware');
  assert.equal(hub.closed, true);
});

test('a pump that slows stops the probe and the hub goes back to hardware mode', async () => {
  const hub = fakeLinkHub();
  let n = 0;
  const out = await runProbe({ link: hub.link, leadingZero: true, seconds: 10, log: () => {}, sleep: async () => { if (++n === 2) hub.rpm = [null, 600, 900]; } });
  assert.deepEqual(out.stopped, { channel: 1, first: 2400, now: 600 });
  assert.equal(out.samples.length, 3);
  assert.equal(hub.mode, 'hardware');
});

test('an error midway still gives the hub back to hardware mode', async () => {
  const hub = fakeLinkHub();
  const link = { ...hub.link, read: async () => { const r = await hub.link.read(); if (r && r[3] === 0x08 && hub.open === 0x21) throw new Error('unplugged'); return r; } };
  const out = await runProbe({ link, leadingZero: true, seconds: 2, ...quiet });
  assert.match(out.error, /unplugged/);
  assert.equal(out.backToHardware, true);
  assert.equal(hub.mode, 'hardware');
});

test('drive: the fans (never the pump) at each step, then the seconds of silence after which the hub took over', async () => {
  const hub = fakeLinkHub({ leaseMs: 12000 });
  const sleep = async (ms) => { hub.clock += ms; };
  const out = await runProbe({ link: hub.link, leadingZero: true, seconds: 1, drive: true, log: () => {}, sleep });
  assert.deepEqual(out.steps.map((s) => s.percent), [30, 70]);
  // Only the fan's channel was ever given a speed.
  assert.deepEqual([...hub.speeds.keys()], [2]);
  assert.equal(out.lease, 15);
  assert.equal(out.backToHardware, true);
  assert.equal(hub.mode, 'hardware');
});

test('watching the mode: a hub another program put back in hardware mode is counted and taken again', async () => {
  const hub = fakeLinkHub();
  let n = 0;
  const sleep = async () => { if (++n === 2) hub.mode = 'hardware'; };
  const out = await runProbe({ link: hub.link, leadingZero: true, seconds: 4, watchMode: true, log: () => {}, sleep });
  assert.equal(out.flips, 1);
  assert.equal(out.samples.length, 4);
  assert.equal(out.backToHardware, true);
  const quiet = await runProbe({ link: fakeLinkHub().link, leadingZero: true, seconds: 3, watchMode: true, log: () => {}, sleep: async () => {} });
  assert.equal(quiet.flips, 0);
});

test('drive: a pump that slows during the steps stops it before the lease test', async () => {
  const hub = fakeLinkHub();
  let n = 0;
  const sleep = async () => { if (++n === 4) hub.rpm = [null, 500, 900]; };
  const out = await runProbe({ link: hub.link, leadingZero: true, seconds: 1, drive: true, log: () => {}, sleep });
  assert.equal(out.stopped.channel, 1);
  assert.equal(out.lease, null);
  assert.equal(hub.mode, 'hardware');
});

test('colours: red, green, blue, then a light round each part, on a chain it can lay out', async () => {
  const hub = fakeLinkHub({ channels: [deviceEntry(0x06, 0, 'LCDID'), deviceEntry(0x11, 5, 'PUMPID'), deviceEntry(0x0f, 0, 'FANID')], rpm: [null, null, 2400, 900], temps: [null, null, 300, null] });
  const lines = [];
  const out = await runProbe({ link: hub.link, leadingZero: true, seconds: 1, colours: true, log: (m) => lines.push(m), sleep: async () => {} });
  assert.equal(out.error, null);
  assert.deepEqual(out.colours, { painted: 3 * 3 + 40 + 8, why: null });
  assert.deepEqual(hub.frames[0], [], 'the empty frame first, as iCUE');
  assert.equal(hub.frames[1].length, (20 + 24 + 8) * 3);
  assert.deepEqual(hub.frames[1].slice(0, 3), [255, 0, 0]);
  assert.ok(lines.some((l) => l === 'colours: a white light round the pump (40 lights)'));
  assert.equal(hub.speeds.size, 0, 'colours never set a speed');
  assert.equal(out.backToHardware, true);
});

test('colours: a chain with a device never measured is named and left dark', async () => {
  const hub = fakeLinkHub({ channels: [deviceEntry(0x01, 0, 'QXFANID'), EMPTY] });
  const out = await runProbe({ link: hub.link, leadingZero: true, seconds: 1, colours: true, ...quiet });
  assert.deepEqual(out.colours, { painted: 0, why: 'unknown-leds' });
  assert.deepEqual(hub.frames, []);
});
