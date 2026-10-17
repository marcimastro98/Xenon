// Home Assistant reads for SDK widgets: an entity's recent history and one
// camera frame, only for entities the user already selected in Settings.
//
// Asked for by a supporter who wanted a Home Assistant dashboard of their own;
// the wall-plate "Casa" widget is built on exactly this surface, which is open
// to every widget author. What must hold:
//   · nothing outside the user's selection is ever asked of Home Assistant;
//   · a person's coordinates never reach a widget (or any tile);
//   · whatever HA sends back, the widget gets one shape: {t, avg, max} points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const q = require('../actions/home-assistant-query.js');
const { compactEntity } = require('../actions/home-assistant.js');

const SELECTED = ['sensor.outside_temp', 'binary_sensor.patio_door', 'camera.gate', 'light.sofa'];

// ── The request is bounded by the user's selection ─────────────────────────────

test('history leaves out an entity the user never selected, names it, and never asks HA about it', () => {
  assert.deepEqual(q.normalizeHistoryRequest(['sensor.outside_temp', 'lock.front_door'], 24, SELECTED),
    { ids: ['sensor.outside_temp'], hours: 24, skipped: ['lock.front_door'] });
  assert.deepEqual(q.normalizeHistoryRequest(['person.marco'], 24, SELECTED), { error: 'not_selected' });
  assert.deepEqual(q.normalizeHistoryRequest(['person.marco', 'lock.front_door'], 24, SELECTED), { error: 'not_selected' });
});

test('history ids are validated, de-duplicated and capped', () => {
  assert.deepEqual(q.normalizeHistoryRequest('sensor.outside_temp, SENSOR.OUTSIDE_TEMP', undefined, SELECTED),
    { ids: ['sensor.outside_temp'], hours: 24, skipped: [] });
  const strangers = Array.from({ length: q.HISTORY_MAX_IDS }, (_, i) => 'lock.l' + i);
  assert.deepEqual(q.normalizeHistoryRequest(['light.sofa', ...strangers], 24, SELECTED), { error: 'too_many_ids' },
    'strangers count toward the cap, so a request cannot grow without bound');
  assert.deepEqual(q.normalizeHistoryRequest([], 24, SELECTED), { error: 'bad_ids' });
  assert.deepEqual(q.normalizeHistoryRequest(['../api/states', 'x'], 24, SELECTED), { error: 'bad_ids' });
  const many = Array.from({ length: q.HISTORY_MAX_IDS + 1 }, (_, i) => 'sensor.s' + i);
  assert.deepEqual(q.normalizeHistoryRequest(many, 24, many), { error: 'too_many_ids' });
});

test('history hours are whole numbers from 1 to 72', () => {
  for (const h of [0, -1, 73, 1.5, 'abc', Infinity]) {
    assert.deepEqual(q.normalizeHistoryRequest(['light.sofa'], h, SELECTED), { error: 'bad_hours' }, String(h));
  }
  assert.equal(q.normalizeHistoryRequest(['light.sofa'], '72', SELECTED).hours, 72);
});

// ── One shape out, whatever HA sends ─────────────────────────────────────────

test('statistics rows become points, with ISO or epoch-ms starts', () => {
  const pts = q.pointsFromStatistics([
    { start: '2026-10-16T10:00:00+00:00', mean: 12.3456, max: 13 },
    { start: Date.parse('2026-10-16T11:00:00Z'), mean: 14, max: 15.5 },
    { start: '2026-10-16T12:00:00Z', state: 900 },
    { start: 'garbage', mean: 1 },
    null,
  ]);
  assert.deepEqual(pts, [
    { t: Date.parse('2026-10-16T10:00:00Z'), avg: 12.346, max: 13 },
    { t: Date.parse('2026-10-16T11:00:00Z'), avg: 14, max: 15.5 },
    { t: Date.parse('2026-10-16T12:00:00Z'), avg: 900, max: 900 },
  ]);
});

test('raw history is bucketed, holds a state until it changes, and reads on/off as 1/0', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const sec = (iso) => Date.parse(iso) / 1000;
  const pts = q.pointsFromHistory([
    { s: 'off', lu: sec('2026-10-15T08:00:00Z') },     // before the window: clamped to its start
    { s: 'on', lu: sec('2026-10-16T11:40:00Z') },
    { s: 'unavailable', lu: sec('2026-10-16T11:50:00Z') }, // not a value: skipped
  ], 24, now);
  assert.equal(pts.length, q.HISTORY_BUCKETS, 'every bucket carries the held state');
  assert.deepEqual(pts[0], { t: now - 24 * 3600 * 1000, avg: 0, max: 0 });
  const last = pts[pts.length - 1];
  assert.equal(last.max, 1);
  assert.ok(last.avg > 0 && last.avg <= 1);
  assert.deepEqual(q.pointsFromHistory([], 24, now), []);
  assert.deepEqual(q.pointsFromHistory([{ s: 'heat', lu: sec('2026-10-16T11:00:00Z') }], 24, now), []);
});

// ── Talking to HA ─────────────────────────────────────────────────────────────

function fakeHa(answers, calls = []) {
  return {
    async request(type, extra, timeoutMs) {
      calls.push({ type, extra, timeoutMs });
      return answers[type] || {};
    },
    async cameraSnapshot(id) { calls.push({ type: 'snapshot', id }); return answers.snapshot; },
    artworkKey(id) { return (answers.artKey || {})[id] || ''; },
    async mediaArtwork(id) { calls.push({ type: 'artwork', id }); return answers.artwork; },
  };
}

test('statistics first, raw history only for what has none, and a cache after that', async () => {
  const calls = [];
  const ha = fakeHa({
    'recorder/statistics_during_period': { 'sensor.outside_temp': [{ start: Date.now() - 3600e3, mean: 9, max: 10 }] },
    'history/history_during_period': { 'binary_sensor.patio_door': [{ s: 'on', lu: Date.now() / 1000 - 60 }] },
  }, calls);
  const hq = q.createHaQuery(ha);
  const ids = ['sensor.outside_temp', 'binary_sensor.patio_door'];
  const r = await hq.history(ids, 24);
  assert.equal(r.ok, true);
  assert.equal(r.series['sensor.outside_temp'].source, 'statistics');
  assert.equal(r.series['binary_sensor.patio_door'].source, 'history');
  assert.deepEqual(calls.map((c) => c.type), ['recorder/statistics_during_period', 'history/history_during_period']);
  assert.deepEqual(calls[1].extra.entity_ids, ['binary_sensor.patio_door'], 'only what statistics lacked');
  assert.equal(calls[1].extra.minimal_response, true);
  assert.ok(calls.every((c) => c.timeoutMs > 8000), 'the slow reads get a longer timeout');
  await hq.history(ids, 24);
  assert.equal(calls.length, 2, 'a second ask inside five minutes costs HA nothing');
});

test('a camera frame comes back as a data: URL, and only for a selected camera', async () => {
  const calls = [];
  const hq = q.createHaQuery(fakeHa({ snapshot: Buffer.from([0xff, 0xd8, 0xff]) }, calls));
  const ok = await hq.cameraFrame('camera.gate', SELECTED);
  assert.equal(ok.ok, true);
  assert.match(ok.src, /^data:image\/jpeg;base64,/);
  assert.deepEqual(await hq.cameraFrame('camera.bedroom', SELECTED), { ok: false, error: 'not_selected' });
  assert.deepEqual(await hq.cameraFrame('light.sofa', SELECTED), { ok: false, error: 'bad_camera' });
  assert.equal(calls.length, 1, 'refusals never reach HA');
  const big = q.createHaQuery(fakeHa({ snapshot: Buffer.alloc(3 * 1024 * 1024) }));
  assert.deepEqual(await big.cameraFrame('camera.gate', SELECTED), { ok: false, error: 'frame_too_large' });
});

test('cover art: selected players only, a real image only, fetched again only when the art changes', async () => {
  const PLAYERS = [...SELECTED, 'media_player.denon', 'media_player.kef'];
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const calls = [];
  const answers = { artwork: png, artKey: { 'media_player.denon': '/api/media_player_proxy/media_player.denon?cache=a1' } };
  const hq = q.createHaQuery(fakeHa(answers, calls));
  const ok = await hq.artwork('media_player.denon', PLAYERS);
  assert.equal(ok.ok, true);
  assert.match(ok.src, /^data:image\/png;base64,/);
  assert.deepEqual(await hq.artwork('media_player.denon', PLAYERS), ok, 'same art, no second fetch');
  assert.equal(calls.length, 1);
  answers.artKey['media_player.denon'] = '/api/media_player_proxy/media_player.denon?cache=b2';
  await hq.artwork('media_player.denon', PLAYERS);
  assert.equal(calls.length, 2, 'a new track fetches its cover');

  assert.deepEqual(await hq.artwork('media_player.office', PLAYERS), { ok: false, error: 'not_selected' });
  assert.deepEqual(await hq.artwork('camera.gate', PLAYERS), { ok: false, error: 'bad_media_player' });
  assert.deepEqual(await hq.artwork('media_player.kef', PLAYERS), { ok: false, error: 'no_artwork' });
  assert.equal(calls.length, 2, 'refusals and players without art never reach HA');

  const html = q.createHaQuery(fakeHa({ artwork: Buffer.from('<html><script>x</script></html>'), artKey: answers.artKey }));
  assert.deepEqual(await html.artwork('media_player.denon', PLAYERS), { ok: false, error: 'bad_image' });
  const big = q.createHaQuery(fakeHa({ artwork: Buffer.alloc(3 * 1024 * 1024), artKey: answers.artKey }));
  assert.deepEqual(await big.artwork('media_player.denon', PLAYERS), { ok: false, error: 'artwork_too_large' });
});

test('image formats are told by their bytes', () => {
  assert.equal(q.imageMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)])), 'image/jpeg');
  assert.equal(q.imageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(q.imageMime(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)])), 'image/gif');
  assert.equal(q.imageMime(Buffer.from('<svg onload=alert(1)></svg>')), '');
  assert.equal(q.imageMime(Buffer.alloc(4)), '');
});

test('a media player says whether it has art and which players are grouped, nothing more', () => {
  const c = compactEntity({ entity_id: 'media_player.denon', state: 'playing', attributes: {
    friendly_name: 'Denon', entity_picture: '/api/media_player_proxy/media_player.denon?token=SECRET&cache=a1',
    group_members: ['media_player.denon', 'media_player.kitchen', 'not an id'],
  } });
  assert.equal(c.art, true);
  assert.deepEqual(c.group, ['media_player.denon', 'media_player.kitchen']);
  assert.ok(!JSON.stringify(c).includes('SECRET'), 'the picture URL (and its token) never leaves the server');
  const solo = compactEntity({ entity_id: 'media_player.kef', state: 'off', attributes: { group_members: ['media_player.kef'] } });
  assert.equal(solo.art, false);
  assert.equal(solo.group, undefined);
});

// ── What an entity carries ────────────────────────────────────────────────────

test('a person or tracker carries where they are by name, never by coordinates', () => {
  for (const id of ['person.marco', 'device_tracker.marco_phone']) {
    const c = compactEntity({ entity_id: id, state: 'home', attributes: {
      friendly_name: 'Marco', latitude: 45.07, longitude: 7.68, gps_accuracy: 12, source: 'device_tracker.x',
    } });
    assert.equal(c.state, 'home');
    const json = JSON.stringify(c);
    for (const leak of ['45.07', '7.68', 'latitude', 'longitude', 'gps']) assert.ok(!json.includes(leak), id + ' leaks ' + leak);
  }
});

test('weather and sensors carry what a widget needs to draw them', () => {
  const w = compactEntity({ entity_id: 'weather.home', state: 'cloudy', attributes: { temperature: 14.2, temperature_unit: '°C', humidity: 71 } });
  assert.deepEqual([w.state, w.temperature, w.tempUnit, w.humidity], ['cloudy', 14.2, '°C', 71]);
  const s = compactEntity({ entity_id: 'sensor.power', state: '1240', attributes: { state_class: 'measurement', unit_of_measurement: 'W' } });
  assert.equal(s.stateClass, 'measurement');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('the route is grant-gated, selection-bound and POST; the bridge checks the grant too', () => {
  const server = read('server/server.js');
  const at = server.indexOf("reqPath === '/stream/homeassistant/query' && req.method === 'POST'");
  assert.ok(at > 0, 'route exists as POST');
  const body = server.slice(at, at + 2200);
  assert.match(body, /sdkGrantsFor\(pkgId\)\.streams\.includes\('homeassistant'\)/);
  assert.match(body, /ha\.entities \|\| \[\], ha\.energyEntities/);
  assert.match(body, /sdkTileGate\(pkgId/);
  assert.match(body, /body\.op === 'artwork'\) \{\s*json\(await haQuery\.artwork\(p\.id, allowed\)\)/);
  const cw = read('server/js/custom-widget.js');
  const fn = cw.slice(cw.indexOf('async function onBridgeHaQuery'));
  assert.match(fn.slice(0, 900), /grant\.streams\.includes\('homeassistant'\)/);
  assert.match(cw, /d\.type === 'haQuery'\) \{\s*if \(entry\.ready\) onBridgeHaQuery/);
});

test('an unchanged selection is not broadcast again; a new dashboard is seeded at connect', () => {
  const server = read('server/server.js');
  const fn = server.slice(server.indexOf('function scheduleHaBroadcast'), server.indexOf('async function refreshHaWatch'));
  assert.match(fn, /if \(sig !== _haStateLast\) \{ _haStateLast = sig; broadcastSSE\('homeassistant', state\); \}/);
  const refresh = server.slice(server.indexOf('async function refreshHaWatch'));
  assert.match(refresh.slice(0, 1600), /_haStateLast = '';/, 'stopping the watch forgets the last payload');
  assert.match(refresh.slice(0, 800), /JSON\.stringify\(ha\.areaOrder \|\| \[\]\), ha\.tileView/, 'a new room order is pushed at once');
  assert.match(server, /buildHaState\(\)\.then\(\(st\) => \{ try \{ res\.write\(`event: homeassistant/, 'the SSE connect writes its own seed');
});

test('init tells a tile which copy it is, and tells a service frame nothing', () => {
  const cw = read('server/js/custom-widget.js');
  assert.match(cw, /instance: entry\.service \|\| entry\.ambient \? null : instanceIdOfEntry\(entry\)/);
});
