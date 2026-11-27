// A ring at the door (server/smart-home/doorbell.js): which Home Assistant changes are a ring, which
// camera goes with a HA doorbell, one card per doorbell while someone keeps pressing, the person's
// switches (card off, phone off), the push words, and the UniFi detection router handing a ring to
// the doorbell card instead of the plain camera notice. Settings are read from a stub, the live
// stream is a pretend client, the push a spy: nothing leaves the test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { settingsReader } = require('../settings/read-cache.js');
const { sseClients } = require('../http/sse-clients.js');
const { unifiNotify } = require('../smart-home/unifi-notify-state.js');
const { normalizeHome, HOME_DEFAULTS } = require('../smart-home/home-settings.js');
const doorbell = require('../smart-home/doorbell.js');
const { _onUnifiDetection, _unifiNotifyCooldown } = require('../smart-home/unifi-detections.js');
const homeLog = require('../smart-home/home-events.js');

// The home log is a spy here: nothing is written in the app's data folder.
const logged = [];
homeLog._use({ add: async (e) => { logged.push(e); return true; }, recent: async () => [], clear: async () => {} });

let settings = {};
settingsReader.read = async () => JSON.parse(JSON.stringify(settings));

const sent = [];
sseClients.add({ writableLength: 0, write: (payload) => { sent.push(payload); return true; } });
const events = (name) => sent.filter((p) => p.startsWith(`event: ${name}\n`)).map((p) => JSON.parse(p.split('\ndata: ')[1]));

const pushes = [];
doorbell.usePush((payload, opts) => { pushes.push({ payload, opts }); return Promise.resolve(); });

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  settings = { language: 'it', home: { doorbell: true, doorbellPush: true, bitCameras: 'ask' } };
  sent.length = 0;
  pushes.length = 0;
  logged.length = 0;
  doorbell._lastRing.clear();
  _unifiNotifyCooldown.clear();
});

const NOW = Date.parse('2026-11-26T18:30:00Z');
const press = (over = {}) => ({
  entity_id: 'event.front_door_ding',
  old_state: { state: '2026-11-26T09:00:00.000+00:00' },
  new_state: { state: new Date(NOW - 1500).toISOString(), attributes: { device_class: 'doorbell', friendly_name: 'Front door Ding' } },
  ...over,
});

test('a doorbell event entity whose time moves on, just now, is a ring', () => {
  assert.deepEqual(doorbell.haRing(press(), NOW), { id: 'event.front_door_ding', name: 'Front door Ding' });
});

test('not a ring: back from unavailable, first seen, the same time, another class, an old time, not an event', () => {
  const p = press();
  assert.equal(doorbell.haRing({ ...p, old_state: { state: 'unavailable' } }, NOW), null);
  assert.equal(doorbell.haRing({ ...p, old_state: null }, NOW), null);
  assert.equal(doorbell.haRing({ ...p, old_state: { state: p.new_state.state } }, NOW), null);
  assert.equal(doorbell.haRing({ ...p, new_state: { ...p.new_state, attributes: { device_class: 'button' } } }, NOW), null);
  assert.equal(doorbell.haRing({ ...p, new_state: { ...p.new_state, state: new Date(NOW - 10 * 60000).toISOString() } }, NOW), null);
  assert.equal(doorbell.haRing({ ...p, entity_id: 'sensor.front_door' }, NOW), null);
  assert.equal(doorbell.haRing(null, NOW), null);
});

test('the camera of a HA doorbell: the one on its device, else the longest id it starts with', () => {
  const list = [
    { id: 'event.front_door_ding', device: 'dev-1' },
    { id: 'camera.front', device: 'dev-9' },
    { id: 'camera.front_door', device: 'dev-8' },
    { id: 'camera.porch', device: 'dev-1' },
  ];
  assert.equal(doorbell.haDoorCamera('event.front_door_ding', list).id, 'camera.porch');
  const noDevice = list.map((e) => ({ id: e.id }));
  assert.equal(doorbell.haDoorCamera('event.front_door_ding', noDevice).id, 'camera.front_door');
  assert.equal(doorbell.haDoorCamera('event.garden_gate', noDevice), null);
  assert.equal(doorbell.haDoorCamera('event.x', null), null);
});

test('a UniFi ring: one card with the camera picture and a push in the person\'s language', async () => {
  const out = await doorbell.fromUnifi({ camId: 'cam0001abcd', name: 'Ingresso' });
  assert.equal(out, 'shown');
  const [card] = events('home_ring');
  assert.equal(card.id, 'unifi:cam0001abcd');
  assert.equal(card.name, 'Ingresso');
  assert.equal(card.pic, '/api/unifiprotect/snapshot/cam0001abcd');
  assert.equal(card.source, 'unifi');
  await settle();
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].payload, { title: 'Xenon', body: 'Suonano alla porta', tag: 'door', url: '/' });
  assert.deepEqual(pushes[0].opts, { urgency: 'high', ttl: 60 });
  assert.equal(doorbell.latest().id, 'unifi:cam0001abcd');
});

test('pressing again within the wait makes no second card', async () => {
  assert.equal(await doorbell.fromUnifi({ camId: 'cam0001abcd' }), 'shown');
  assert.equal(await doorbell.fromUnifi({ camId: 'cam0001abcd' }), 'waiting');
  assert.equal(await doorbell.fromUnifi({ camId: 'cam0002abcd' }), 'shown', 'another doorbell has its own wait');
  assert.equal(events('home_ring').length, 2);
});

test('the person\'s switches: card off sends nothing, phone off keeps the card only', async () => {
  settings.home.doorbell = false;
  assert.equal(await doorbell.fromUnifi({ camId: 'cam0001abcd' }), 'off');
  assert.equal(events('home_ring').length, 0);
  doorbell._lastRing.clear();
  settings.home = { doorbell: true, doorbellPush: false };
  assert.equal(await doorbell.fromUnifi({ camId: 'cam0001abcd' }), 'shown');
  await settle();
  assert.equal(pushes.length, 0);
});

test('an unknown language gets the English push; a bad camera id makes no card', async () => {
  settings.language = 'xx';
  await doorbell.fromUnifi({ camId: 'cam0001abcd' });
  await settle();
  assert.equal(pushes[0].payload.body, 'Someone rang the doorbell');
  assert.equal(await doorbell.fromUnifi({ camId: '../settings' }), 'off');
  assert.equal(await doorbell.fromUnifi(null), 'off');
});

test('a HA ring finds its camera through the entity list', async () => {
  const deckHa = { listEntities: async () => [{ id: 'event.front_door_ding' }, { id: 'camera.front_door', name: 'Front door' }] };
  const now = new Date().toISOString();
  const data = press({ new_state: { state: now, attributes: { device_class: 'doorbell', friendly_name: 'Ding' } } });
  assert.equal(await doorbell.fromHa(data, deckHa), 'shown');
  const [card] = events('home_ring');
  assert.equal(card.id, 'ha:event.front_door_ding');
  assert.equal(card.name, 'Front door');
  assert.equal(card.pic, '/api/ha/camera/snapshot/camera.front_door');
  assert.equal(await doorbell.fromHa({ entity_id: 'light.desk' }, deckHa), 'off');
});

test('a HA ring with no camera, or a list that fails, still makes a card without a picture', async () => {
  const deckHa = { listEntities: async () => { throw new Error('offline'); } };
  const data = press({ new_state: { state: new Date().toISOString(), attributes: { device_class: 'doorbell', friendly_name: 'Ding' } } });
  assert.equal(await doorbell.fromHa(data, deckHa), 'shown');
  assert.equal(events('home_ring')[0].pic, '');
  assert.equal(events('home_ring')[0].name, 'Ding');
});

test('UniFi router: a ring goes to the doorbell card, not to the plain camera notice', async () => {
  unifiNotify.snapshot = { enabled: true, types: { person: true, ring: true }, cooldownMs: 30000 };
  _onUnifiDetection({ camId: 'cam0001abcd', name: 'Ingresso', kinds: ['ring', 'person'] });
  await settle(); await settle();
  assert.equal(events('home_ring').length, 1);
  assert.deepEqual(events('unifi_event').map((e) => e.kind), ['person']);
});

test('UniFi router: with the doorbell card off, a ring is the plain notice again, only if notices are on', async () => {
  settings.home.doorbell = false;
  unifiNotify.snapshot = { enabled: true, types: { ring: true }, cooldownMs: 30000 };
  _onUnifiDetection({ camId: 'cam0001abcd', kinds: ['ring'] });
  await settle(); await settle();
  assert.deepEqual(events('unifi_event').map((e) => e.kind), ['ring']);
  sent.length = 0; doorbell._lastRing.clear(); _unifiNotifyCooldown.clear();
  unifiNotify.snapshot = { enabled: false, types: { ring: true }, cooldownMs: 30000 };
  _onUnifiDetection({ camId: 'cam0001abcd', kinds: ['ring'] });
  await settle(); await settle();
  assert.equal(sent.length, 0);
});

test('UniFi router: notices off still brings the doorbell card; ring unticked brings nothing', async () => {
  unifiNotify.snapshot = { enabled: false, types: { ring: true, person: true }, cooldownMs: 30000 };
  _onUnifiDetection({ camId: 'cam0001abcd', kinds: ['ring', 'person'] });
  await settle(); await settle();
  assert.equal(events('home_ring').length, 1);
  assert.equal(events('unifi_event').length, 0);
  sent.length = 0; doorbell._lastRing.clear();
  unifiNotify.snapshot = { enabled: true, types: { ring: false }, cooldownMs: 30000 };
  _onUnifiDetection({ camId: 'cam0001abcd', kinds: ['ring'] });
  await settle(); await settle();
  assert.equal(sent.length, 0);
});

test('home settings: defaults, kept choices, anything else back to the default', () => {
  assert.deepEqual(normalizeHome(undefined), HOME_DEFAULTS);
  assert.deepEqual(normalizeHome({ doorbell: false, doorbellPush: false, bitCameras: 'yes', log: false }), { doorbell: false, doorbellPush: false, bitCameras: 'yes', log: false });
  assert.deepEqual(normalizeHome({ doorbell: 'no', bitCameras: 'always' }), HOME_DEFAULTS);
});

test('the home log gets the ring and what the camera picked out, never plain movement', async () => {
  unifiNotify.snapshot = { enabled: false, types: { ring: true }, cooldownMs: 30000 };
  _onUnifiDetection({ camId: 'cam0001abcd', name: 'Ingresso', kinds: ['ring', 'person', 'motion', 'package'] });
  await settle(); await settle();
  assert.deepEqual(logged.map((e) => e.kind).sort(), ['package', 'person', 'ring']);
  assert.ok(logged.every((e) => e.place === 'Ingresso' && !('pic' in e)), 'a place and a kind, never a picture');
  settings.home.doorbell = false;
  doorbell._lastRing.clear();
  logged.length = 0;
  await doorbell.fromUnifi({ camId: 'cam0002abcd', name: 'Retro' });
  assert.deepEqual(logged, [{ kind: 'ring', place: 'Retro' }], 'a ring is kept with the card switched off too');
});
