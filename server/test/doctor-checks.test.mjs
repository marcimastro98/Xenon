'use strict';
// doctor-checks.mjs — the validators behind `npm run doctor`.
//
// The point of these tests is that the diagnostic itself gets diagnosed. A
// checker that has never been shown to FAIL is worth nothing: it would report a
// green machine whatever the collectors did. So every check is exercised twice —
// once against real collector output (parsed from the same fixtures the
// collector suites use, so the "good" case is not hand-written to match) and
// once against a payload broken in the specific way that would slip past a
// weaker check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as dc from '../../tools/doctor-checks.mjs';

const require = createRequire(import.meta.url);
const darwin = require('../darwin-collectors.js');
const media = require('../darwin-media.js');
const linux = require('../linux-collectors.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('checkDisks: accepts real parsed output and rejects arithmetic that cannot be true', () => {
  const real = darwin.parseDisks(fixture('darwin-df.txt'), darwin.parseMountTypes(fixture('darwin-mount.txt')));
  const good = dc.checkDisks(real);
  assert.equal(good.level, 'ok', JSON.stringify(good));

  // used+free must agree with total. This is the APFS trap: df's own Used
  // column excludes purgeable space, so a collector that copies it makes the
  // bar and the label on the same tile disagree.
  const bad = real.map((d) => ({ ...d }));
  bad[0].used = Math.floor(bad[0].total * 0.1);
  bad[0].free = Math.floor(bad[0].total * 0.1);
  const r = dc.checkDisks(bad);
  assert.equal(r.level, 'fail');
  assert.ok(r.notes.some((n) => /does not match total/.test(n)), JSON.stringify(r.notes));

  assert.equal(dc.checkDisks([{ drive: 'C:', total: 1, used: 'x', free: 0, percent: 0 }]).level, 'fail');
  assert.equal(dc.checkDisks('nope').level, 'fail');
  assert.equal(dc.checkDisks(null).level, 'warn');   // "no drives" is not a shape error
});

test('checkGpu: a machine with no sensor warns, a wrong shape fails', () => {
  const real = darwin.parseDisplaysJson(fixture('darwin-displays.json'));
  const withSensor = dc.checkGpu({ ...real, gpu: 42, gpuTemp: 55, vramUsed: 0, vramTotal: 0 });
  assert.equal(withSensor.level, 'ok', JSON.stringify(withSensor));
  // Apple Silicon has no separate VRAM; 0 is the right answer, not a fault.
  assert.ok(withSensor.notes.some((n) => /unified memory/.test(n)));

  assert.equal(dc.checkGpu({ gpu: null, gpuTemp: null, vramUsed: null, vramTotal: null }).level, 'warn');
  assert.equal(dc.checkGpu({ gpu: '42' }).level, 'fail');
  assert.equal(dc.checkGpu({ gpu: 140 }).level, 'fail');
  assert.equal(dc.checkGpu(null).level, 'fail');
});

test('checkCpuTemp: absent warns, impossible fails', () => {
  assert.equal(dc.checkCpuTemp({ cpuTemp: 48 }).level, 'ok');
  assert.equal(dc.checkCpuTemp({ cpuTemp: null }).level, 'warn');
  assert.equal(dc.checkCpuTemp({ cpuTemp: 0 }).level, 'fail');      // a real reading is never 0
  assert.equal(dc.checkCpuTemp({ cpuTemp: 900 }).level, 'fail');    // millidegrees read as degrees
  assert.equal(dc.checkCpuTemp({ cpuTemp: '48' }).level, 'fail');
});

test('checkNetwork: accepts real counters, rejects negatives and wrong types', () => {
  // The parser returns {rx,tx}; network() is what renames them to the
  // rxBytes/txBytes server.js differences into a rate. The check validates the
  // COLLECTOR's contract, so the rename belongs here too.
  const real = darwin.parseNetstatIb(fixture('darwin-netstat-ib.txt'));
  const good = dc.checkNetwork({ rxBytes: real.rx, txBytes: real.tx, ping: 12, latency: 3 });
  assert.equal(good.level, 'ok', JSON.stringify(good));
  assert.equal(dc.checkNetwork({ rxBytes: null, txBytes: null, ping: null }).level, 'warn');
  assert.equal(dc.checkNetwork({ rxBytes: -1, txBytes: 0 }).level, 'fail');
  assert.equal(dc.checkNetwork({ rxBytes: '10', txBytes: 0 }).level, 'fail');
});

test('checkWindows: an empty list is supported, a malformed id is not', () => {
  const real = { windows: darwin.parseAppList(fixture('darwin-apps.txt')) };
  assert.equal(dc.checkWindows(real).level, 'ok');
  // Empty is what macOS reports before the Automation permission is granted.
  assert.equal(dc.checkWindows({ windows: [] }).level, 'warn');
  // server.js validates the id with /^\d{1,24}$/ before using it; anything else
  // means focus and close will silently miss.
  const bad = { windows: [{ id: 'window-1', title: 't', app: 'a', active: false }] };
  const r = dc.checkWindows(bad);
  assert.equal(r.level, 'fail');
  assert.ok(r.notes.some((n) => /digit string/.test(n)));
  assert.equal(dc.checkWindows({}).level, 'fail');
});

test('checkAudioRows: accepts both platforms real rows', () => {
  const mac = darwin.buildAudioRows(darwin.parseAudioDevices(fixture('darwin-audio.json')), { output: 50, input: 75, muted: false });
  assert.equal(dc.checkAudioRows(mac).level, 'ok', JSON.stringify(dc.checkAudioRows(mac)));
  const lin = linux.buildAudioRows(linux.parsePwDump(fixture('linux-pw-dump.json')));
  const r = dc.checkAudioRows(lin);
  assert.ok(['ok', 'fail'].includes(r.level));
  if (r.level === 'fail') assert.ok(r.notes.length, 'a failure must say what is wrong');
});

test('checkAudioRows: the failures that would silently misroute a write', () => {
  const base = darwin.buildAudioRows(darwin.parseAudioDevices(fixture('darwin-audio.json')), { output: 50, input: 75, muted: false });

  // A short row: every consumer indexes positionally, so this reads as a
  // device with no id and every write against it goes nowhere.
  const short = base.map((r) => r.slice(0, 20));
  assert.equal(dc.checkAudioRows(short).level, 'fail');

  // Two defaults in one direction: server.js caches whichever it sees first,
  // and every later write lands on the wrong device.
  const twoDefaults = base.map((r) => [...r]);
  const renders = twoDefaults.filter((r) => r[dc.AUDIO_COLS.DIR] === 'Render');
  assert.ok(renders.length >= 2, 'fixture needs two outputs for this case');
  renders.forEach((r) => { r[dc.AUDIO_COLS.DEFAULT] = 'Render'; });
  const dup = dc.checkAudioRows(twoDefaults);
  assert.equal(dup.level, 'fail');
  assert.ok(dup.notes.some((n) => /claim to be the default/.test(n)));

  // No capture device at all: the mic button would never bind.
  const noMic = base.filter((r) => r[dc.AUDIO_COLS.DIR] !== 'Capture');
  const nm = dc.checkAudioRows(noMic);
  assert.equal(nm.level, 'fail');
  assert.ok(nm.notes.some((n) => /input device/.test(n)));

  assert.equal(dc.checkAudioRows([]).level, 'fail');
});

test('checkMedia: accepts the real shaped payload and catches a broken vocabulary', () => {
  const line = fixture('darwin-mediaremote-stream.txt').split(/\r?\n/)[1];
  const info = media.shapeNowPlaying(media.parseStreamLine(line).payload, 0);
  const good = dc.checkMedia(info);
  assert.equal(good.level, 'ok', JSON.stringify(good));

  // "nothing playing" is a complete answer unless the tester says otherwise.
  const empty = media.shapeNowPlaying(null, 0);
  assert.equal(dc.checkMedia(empty).level, 'ok');
  assert.equal(dc.checkMedia(empty, true).level, 'warn');

  // liveMediaSnapshot compares playbackStatus to 'Playing' exactly.
  assert.equal(dc.checkMedia({ ...info, playbackStatus: 'In riproduzione' }).level, 'fail');
  assert.equal(dc.checkMedia({ ...info, playbackStatus: 'playing' }).level, 'fail');
  // The thumbnail is rendered as an <img src>.
  assert.equal(dc.checkMedia({ ...info, thumbnail: 'javascript:alert(1)' }).level, 'fail');
  assert.equal(dc.checkMedia({ ...info, position: 9999 }).level, 'fail');
  assert.equal(dc.checkMedia({ ...info, active: 'yes' }).level, 'fail');
});

test('every check answers with a level and a summary, never throws', () => {
  const checks = [dc.checkDisks, dc.checkGpu, dc.checkCpuTemp, dc.checkNetwork, dc.checkWindows, dc.checkAudioRows, dc.checkMedia];
  for (const fn of checks) {
    for (const junk of [undefined, null, 0, '', 'x', [], {}, { windows: 'x' }]) {
      const r = fn(junk);
      assert.ok(r && ['ok', 'warn', 'fail'].includes(r.level), `${fn.name} on ${JSON.stringify(junk)}`);
      assert.equal(typeof r.summary, 'string');
      assert.ok(Array.isArray(r.notes));
    }
  }
});
