// The home log reaches widgets (stream `homeEvents`, GET /api/home/events): only the kind, the
// place and the time, newest first, nothing when the person switched the log off, every list of
// the SDK naming it, and a paired phone may read it. Every place here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const homeLog = require('../smart-home/home-events.js');
const SDK = require('../widget-sdk/surface.js');
const { remotePathAllowed } = require('../paired/remote-access.js');
const { routes } = require('../smart-home/routes-home.js');

const NOW = Date.UTC(2026, 10, 26, 18, 0);
const MIN = 60 * 1000;
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function readers() {
  const window = {};
  vm.runInNewContext(src('../js/custom-widget/stream-readers.js'), { window });
  return (d) => JSON.parse(JSON.stringify(window.CustomWidgetStreamReaders.homeEvents(d)));
}

test('the log for widgets: newest first, kind, place and time only, at most 30', async () => {
  const store = homeLog.createHomeEvents({ dataDir: mkdtempSync(path.join(tmpdir(), 'xenon-home-')) });
  homeLog._use(store);
  for (let i = 0; i < 40; i++) await store.add({ kind: i % 2 ? 'person' : 'ring', place: `Ingresso ${i}` }, NOW - (40 - i) * 2 * MIN);
  const out = await homeLog.forWidgets({ home: { log: true } }, NOW);
  assert.equal(out.ok, true);
  assert.equal(out.events.length, 30);
  assert.deepEqual(out.events[0], { kind: 'person', place: 'Ingresso 39', at: NOW - 2 * MIN });
  assert.ok(out.events.every((e, i, all) => !i || all[i - 1].at > e.at));
  assert.deepEqual(await homeLog.forWidgets({ home: { log: false } }, NOW), { ok: false, error: 'log_off' });
});

test('the route answers through forWidgets, and a phone may read it', () => {
  assert.equal(typeof routes['GET /api/home/events'], 'function');
  assert.equal(remotePathAllowed('/api/home/events', 'GET'), true);
});

test('the reader keeps the six kinds, a short place and a time; log_off stays readable', () => {
  const read = readers();
  const events = [
    { kind: 'ring', place: 'Ingresso', at: NOW, pic: '/api/unifiprotect/snapshot/x', who: 'x' },
    { kind: 'motion', place: 'Giardino', at: NOW },
    { kind: 'opened', place: 'x'.repeat(200), at: NOW - MIN },
    { kind: 'package', place: 3, at: 'ieri' },
  ];
  assert.deepEqual(read({ ok: true, events, extra: 1 }), { ok: true, events: [
    { kind: 'ring', place: 'Ingresso', at: NOW },
    { kind: 'opened', place: 'x'.repeat(80), at: NOW - MIN },
  ] });
  assert.deepEqual(read({ ok: true, events: Array.from({ length: 50 }, () => events[0]) }).events.length, 30);
  assert.deepEqual(read({ ok: false, error: 'log_off' }), { ok: false, error: 'log_off' });
  assert.deepEqual(read({ ok: false, error: 'boom' }), { ok: false, error: 'failed' });
  assert.deepEqual(read(null), { ok: false, error: 'failed' });
});

test('every SDK list names the stream: surface, settings, bridge, words, picker', () => {
  assert.ok(SDK.SDK_STREAMS.includes('homeEvents'));
  assert.ok(src('../js/settings/allowed-values.js').includes("'bit', 'homeEvents']"));
  assert.ok(src('../js/custom-widget/custom-widget.js').includes("homeEvents: Object.freeze({ ttl: 2000, load: async () => Readers.homeEvents(await api('/api/home/events')) }),"));
  assert.match(src('../js/custom-widget/permission-words.js'), /homeEvents: \['cw_stream_homeevents', '[^']+'\]/);
  assert.match(src('../js/custom-widget/picker-words.js'), /streams: \['homeassistant', 'lighting', 'homeEvents'\]/);
  assert.ok(!Object.values(SDK.SDK_ACTION_CATEGORIES).flat().some((t) => /^home/.test(t)), 'nothing a widget can do to the house');
});

test('the home log answers only while a widget holds the homeEvents grant', async () => {
  let said = null;
  await routes['GET /api/home/events']({}, {}, { json: (o) => { said = o; }, sdkStreamGranted: () => false });
  assert.deepEqual(said, { ok: false, error: 'not_granted' });
  const asked = [];
  await routes['GET /api/home/events']({}, {}, { json: (o) => { said = o; }, sdkStreamGranted: (n) => { asked.push(n); return true; } });
  assert.deepEqual(asked, ['homeEvents']);
  assert.notEqual(said.error, 'not_granted');
});
