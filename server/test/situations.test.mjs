// The facts behind a widget's rule (situations.js) and "another app has the microphone" (mic-use.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSituations } = require('../situations.js');
const { parseConsentStore, parsePulseOutputs, parseMonitorSources } = require('../mic-use.js');
const L = require('../js/layers-model.js');
const W = require('../js/layer-when.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const placed = (id, text, extra = {}) => ({ id, kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, when: W.parse(text), ...extra });

function rig(widgets, over = {}, pages) {
  const state = { layers: { enabled: true, widgets, pages: pages || [] } };
  const calls = { music: 0, open: 0, call: 0, battery: 0, cpu: 0, changes: 0, plans: 0, facts: [] };
  const read = {
    game: () => false, live: () => false, recording: () => false, timer: () => false, dnd: () => false,
    cpu: () => { calls.cpu += 1; return 10; }, idleSec: () => 0, front: () => '',
    music: async () => { calls.music += 1; return false; },
    call: async () => { calls.call += 1; return false; },
    open: async () => { calls.open += 1; return []; },
    battery: async () => { calls.battery += 1; return null; },
    ...over,
  };
  const s = createSituations({
    layers: () => state.layers, read,
    isOwnApp: (n) => n.startsWith('xenon'),
    onChange: () => { calls.changes += 1; },
    onPlan: () => { calls.plans += 1; },
    onFacts: (f) => calls.facts.push({ ...f }),
    clock: () => new Date(2026, 10, 5, 10, 30),
  });
  return { s, calls, state, read };
}

test('with no rule nothing at all is read', async () => {
  const { s, calls } = rig([{ id: 'lw_aaaa', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0, y: 0, w: 0.2, h: 0.2 } }]);
  s.tick();
  await flush();
  assert.deepEqual([calls.music, calls.open, calls.call, calls.battery, calls.cpu], [0, 0, 0, 0, 0]);
  assert.deepEqual(s.hidden(), []);
  assert.equal(calls.facts.length, 0);
});

test('only what a rule uses is read', async () => {
  const { s, calls } = rig([placed('lw_aaaa', 'music')]);
  s.tick();
  await flush();
  assert.equal(calls.music, 1);
  assert.deepEqual([calls.open, calls.call, calls.battery, calls.cpu], [0, 0, 0, 0]);
  assert.equal(s.needs('music'), true);
  assert.equal(s.needs('idle'), false);
});

test('a slow fact decides nothing until it has answered, then says so once', async () => {
  let answer;
  const { s, calls } = rig([placed('lw_aaaa', 'music')], { music: () => new Promise((r) => { answer = r; }) });
  s.tick();
  await flush();
  assert.deepEqual(s.hidden(), [], 'not hidden on a fact nobody has read');
  answer(false);
  await flush();
  assert.deepEqual(s.hidden(), ['lw_aaaa']);
  assert.equal(calls.changes, 1);
});

test('the answer follows the music, and a tick that moves it leaves the telling to the caller', async () => {
  let playing = true;
  const { s, calls } = rig([placed('lw_aaaa', 'music')], { music: async () => playing });
  s.tick();
  await flush();
  assert.deepEqual(s.hidden(), []);
  assert.equal(calls.changes, 0);
  playing = false;
  await new Promise((r) => setTimeout(r, 0));
  s.tick();
  await flush();
  assert.equal(s.hidden().length, 0, 'asked again only after its wait');
});

test('a slow reader that fails keeps the last answer and frees the slot', async () => {
  const { s } = rig([placed('lw_aaaa', 'music')], { music: async () => { throw new Error('no'); } });
  s.tick();
  await flush();
  assert.deepEqual(s.hidden(), ['lw_aaaa']);
});

test('pressing a widget does not change the app in front', () => {
  let front = 'EXCEL.EXE';
  const { s } = rig([placed('lw_aaaa', 'app:excel')], { front: () => front });
  s.tick();
  assert.deepEqual(s.hidden(), []);
  front = 'xenon-native';
  s.tick();
  assert.deepEqual(s.hidden(), [], 'our own window is not an app in front');
  front = 'word';
  s.tick();
  assert.deepEqual(s.hidden(), ['lw_aaaa']);
});

test('busy needs two readings to start and a clear fall to end', () => {
  let cpu = 90;
  const { s } = rig([placed('lw_aaaa', 'busy')], { cpu: () => cpu });
  s.tick();
  assert.deepEqual(s.hidden(), ['lw_aaaa'], 'one spike moves nothing');
  s.tick();
  assert.deepEqual(s.hidden(), []);
  cpu = 75;
  s.tick();
  assert.deepEqual(s.hidden(), [], 'between the two lines it stays');
  cpu = 40;
  s.tick();
  assert.deepEqual(s.hidden(), ['lw_aaaa']);
});

test('idle starts at five minutes, and an unknown idle time is not idle', () => {
  let sec = 299;
  const { s } = rig([placed('lw_aaaa', 'idle')], { idleSec: () => sec });
  s.tick();
  assert.deepEqual(s.hidden(), ['lw_aaaa']);
  sec = 300;
  s.tick();
  assert.deepEqual(s.hidden(), []);
  sec = null;
  s.tick();
  assert.deepEqual(s.hidden(), ['lw_aaaa']);
});

test('the clock is local time', () => {
  const { s } = rig([placed('lw_aaaa', 'time:09:00-11:00:4'), placed('lw_bbbb', 'time:09:00-10:00')]);
  s.tick();
  assert.deepEqual(s.hidden(), ['lw_bbbb']);
});

test('a new rule changes the plan, and with no rule left the list empties', () => {
  const { s, calls, state } = rig([placed('lw_aaaa', 'dnd')]);
  s.tick();
  assert.deepEqual(s.hidden(), ['lw_aaaa']);
  assert.equal(calls.plans, 1);
  state.layers = { enabled: true, widgets: [], pages: [] };
  s.tick();
  assert.deepEqual(s.hidden(), []);
  assert.equal(calls.plans, 2);
});

test('a tab box answers for all its tabs, by the rule of the first', () => {
  const group = { group: 'lt_aaaa' };
  const layers = L.normalize({ enabled: true, widgets: [placed('lw_aaaa', 'dnd', group), { ...placed('lw_bbbb', 'timer', group), widget: 'media' }] });
  assert.deepEqual(layers.widgets.map((w) => W.format(w.when)), ['dnd', 'dnd']);
});

test('the pages hear every settled reading', async () => {
  const pages = [{ id: 'lp_aaaa', name: 'A' }, { id: 'lp_bbbb', name: 'B', when: W.parse('music') }];
  const { s, calls } = rig([], { music: async () => true }, pages);
  s.tick();
  await flush();
  assert.equal(calls.facts.at(-1).music, true);
});

const STORE = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged';
const fileTime = (ms) => '0x' + ((BigInt(ms) + 11644473600000n) * 10000n).toString(16);
const entry = (app, start, stop) => `${STORE}\\${app}\n    LastUsedTimeStart    REG_QWORD    ${start}\n    LastUsedTimeStop    REG_QWORD    ${stop}\n`;

test('the Windows store: only an open use of another app counts', () => {
  const now = Date.UTC(2026, 10, 5);
  const fresh = fileTime(now - 60000);
  assert.equal(parseConsentStore(entry('C:#Discord.exe', fresh, '0x0'), now), true);
  assert.equal(parseConsentStore(entry('C:#Discord.exe', fresh, fresh), now), false, 'finished');
  assert.equal(parseConsentStore(entry('C:#Discord.exe', '0x0', '0x0'), now), false, 'never used');
  assert.equal(parseConsentStore(entry('C:#tools#ffmpeg.exe', fresh, '0x0'), now), false, 'our wake word');
  assert.equal(parseConsentStore(entry('C:#EdgeWebView#msedgewebview2.exe', fresh, '0x0'), now), false, 'our dashboard');
  assert.equal(parseConsentStore(entry('C:#Discord.exe', fileTime(now - 21 * 86400000), '0x0'), now), false, 'left open by a crash weeks ago');
  assert.equal(parseConsentStore('', now), false);
  assert.equal(parseConsentStore(entry('C:#Old.exe', fileTime(now - 21 * 86400000), '0x0') + entry('C:#Zoom.exe', fresh, '0x0'), now), true);
});

test('the Linux streams: a paused one and our own do not count', () => {
  const stream = (binary, corked) => `Source Output #12\n\tCorked: ${corked}\n\tProperties:\n\t\tapplication.process.binary = "${binary}"\n`;
  assert.equal(parsePulseOutputs(stream('discord', 'no')), true);
  assert.equal(parsePulseOutputs(stream('discord', 'yes')), false);
  assert.equal(parsePulseOutputs(stream('ffmpeg', 'no')), false);
  assert.equal(parsePulseOutputs(''), false);
});

test('OBS recording what the PC plays holds a monitor source: that is not a call', () => {
  const stream = 'Source Output #12\n\tSource: 5\n\tCorked: no\n\tProperties:\n\t\tapplication.process.binary = "obs"\n';
  const monitors = parseMonitorSources('4\talsa_input.usb\tmodule-alsa\ts16le\tRUNNING\n5\talsa_output.pci.monitor\tmodule-alsa\ts16le\tRUNNING\n');
  assert.deepEqual([...monitors], ['5']);
  assert.equal(parsePulseOutputs(stream, monitors), false);
  assert.equal(parsePulseOutputs(stream.replace('Source: 5', 'Source: 4'), monitors), true, 'the real microphone');
  assert.equal(parsePulseOutputs(stream), true, 'sources unread: as before');
});
