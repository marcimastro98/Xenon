// Bit and the house (server/smart-home/camera-look.js, home-summary.js, camera-consent.js): which
// camera a few words mean, a picture in the reply that no AI sees, a look only after the person's
// yes (or "only this time", once), and "how is the house?" read from Home Assistant without ever
// driving a door or a lock. Settings are a stub, the cameras pretend clients: nothing leaves the test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { settingsReader } = require('../settings/read-cache.js');
const changeOne = require('../settings/change-one.js');
const { sseClients } = require('../http/sse-clients.js');
const doorbell = require('../smart-home/doorbell.js');
const consent = require('../smart-home/camera-consent.js');
const look = require('../smart-home/camera-look.js');
const { summarize } = require('../smart-home/home-summary.js');
const { branches } = require('../smart-home/camera-look.js');
const homeLog = require('../smart-home/home-events.js');

// The home log in a folder of its own: never the app's data folder.
homeLog._use(homeLog.createHomeEvents({ dataDir: mkdtempSync(join(tmpdir(), 'xenon-home-cam-')) }));

let settings = {};
settingsReader.read = async () => JSON.parse(JSON.stringify(settings));
sseClients.add({ writableLength: 0, write: () => true });
const saved = [];
changeOne.updateHubSettingKey = async (key, change) => { saved.push({ key, value: change(settings[key]) }); return saved.at(-1).value; };

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const deps = () => ({
  deckUnifi: { cameras: async () => [{ id: 'cam0001abcd', name: 'Front door', connected: true }], snapshot: async () => JPEG },
  deckHa: {
    cameras: async () => [{ id: 'camera.giardino', name: 'Giardino', connected: true, area: 'Esterno' }],
    cameraSnapshot: async () => JPEG,
    listEntities: async () => [
      { id: 'binary_sensor.back_door', name: 'Back door', domain: 'binary_sensor', deviceClass: 'door', state: 'on', changed: NOW - 20 * 60000 },
      { id: 'binary_sensor.hall_motion', name: 'Hall', domain: 'binary_sensor', deviceClass: 'motion', state: 'on' },
      { id: 'sensor.living_temp', name: 'Living room', domain: 'sensor', deviceClass: 'temperature', state: '21.5', unit: '°C' },
      { id: 'lock.front', name: 'Front lock', domain: 'lock', state: 'unlocked' },
      { id: 'light.kitchen', name: 'Kitchen', domain: 'light', state: 'on', colorModes: ['brightness'], brightness: 128 },
      { id: 'light.desk', name: 'Desk', domain: 'light', state: 'off' },
    ],
  },
});
const NOW = Date.now();
const call = async (fnArgs, extra = {}) => {
  const ctx = { fnArgs, clientActions: [], provider: 'gemini', looked: null, ...extra };
  ctx.look = (b64) => { ctx.looked = b64; };
  const out = await branches.home_camera(ctx, deps());
  return { out, ctx };
};
const pictures = (ctx) => ctx.clientActions.filter((a) => a.action === 'reply_camera').map((a) => a.args);

beforeEach(() => {
  settings = {
    home: { doorbell: true, doorbellPush: false, bitCameras: 'ask' },
    unifi: { host: 'unifi.example', username: 'viewer', password: 'pretend' },
    homeAssistant: { url: 'http://ha.example:8123', token: 'pretend' },
  };
  saved.length = 0;
  consent._reset();
  doorbell._lastRing.clear();
});

test('a camera id becomes only one of the two loopback picture paths, and back', () => {
  assert.equal(look.picOf('unifi:cam0001abcd'), '/api/unifiprotect/snapshot/cam0001abcd');
  assert.equal(look.picOf('ha:camera.giardino'), '/api/ha/camera/snapshot/camera.giardino');
  for (const bad of ['unifi:../x', 'ha:light.kitchen', 'http://evil/x', 'ha:camera.A', '']) assert.equal(look.picOf(bad), '');
  assert.equal(look.idOfPic('/api/unifiprotect/snapshot/cam0001abcd'), 'unifi:cam0001abcd');
  assert.equal(look.idOfPic('/api/ha/camera/snapshot/camera.giardino'), 'ha:camera.giardino');
  assert.equal(look.idOfPic('https://example.com/a.jpg'), '');
});

test('a few words find the camera: name without accents, area, one camera alone, the last ring', async () => {
  const list = [{ id: 'unifi:cam0001abcd', name: 'Ingresso', area: null }, { id: 'ha:camera.giardino', name: 'Giardino', area: 'Esterno' }];
  assert.equal(look.findCamera(list, 'giardìno', NOW).id, 'ha:camera.giardino');
  assert.equal(look.findCamera(list, 'esterno', NOW).id, 'ha:camera.giardino');
  assert.equal(look.findCamera(list, 'cantina', NOW), null);
  assert.equal(look.findCamera(list, '', NOW), null, 'two cameras and no words: ask which');
  assert.equal(look.findCamera(list.slice(1), '', NOW).id, 'ha:camera.giardino');
  await doorbell.fromUnifi({ camId: 'cam0001abcd', name: 'Ingresso' });
  assert.equal(look.findCamera(list, '', Date.now()).id, 'unifi:cam0001abcd', 'after a ring, no words means the door');
});

test('show puts the live picture in the reply and the AI sees nothing', async () => {
  const { out, ctx } = await call({ action: 'show', camera: 'giardino' });
  assert.equal(out.ok, true);
  assert.deepEqual(pictures(ctx), [{ pic: '/api/ha/camera/snapshot/camera.giardino', name: 'Giardino' }]);
  assert.equal(ctx.looked, null);
});

test('look asks first: the picture with the question, naming where it would go, and no look', async () => {
  const { out, ctx } = await call({ action: 'look', camera: 'front door' }, { provider: 'xenon' });
  assert.equal(out.needs_consent, true);
  assert.equal(ctx.looked, null);
  assert.deepEqual(pictures(ctx)[0].ask, { provider: 'xenon' });
  const odd = await call({ action: 'look', camera: 'front door' }, { provider: 'made-up' });
  assert.deepEqual(pictures(odd.ctx)[0].ask, { provider: '' }, 'an unknown provider is not named');
});

test('"only this time" lets one look through within two minutes, then Bit asks again', async () => {
  consent.grantOnce();
  const first = await call({ action: 'look', camera: 'front door' });
  assert.equal(first.out.ok, true);
  assert.equal(first.ctx.looked, JPEG.toString('base64'));
  assert.equal(pictures(first.ctx)[0].ask, undefined, 'the picture still shows, without a question');
  const second = await call({ action: 'look', camera: 'front door' });
  assert.equal(second.out.needs_consent, true);
  consent.grantOnce(NOW - consent.ONCE_MS - 1000);
  assert.equal(consent.takeOnce(), false, 'an old "only this time" has run out');
});

test('a yes looks every time, a no only shows the picture', async () => {
  settings.home.bitCameras = 'yes';
  const yes = await call({ action: 'look', camera: 'giardino' });
  assert.equal(yes.out.ok, true);
  assert.match(yes.out.hint, /Never say who a person is/);
  settings.home.bitCameras = 'no';
  const no = await call({ action: 'look', camera: 'giardino' });
  assert.equal(no.out.error, 'looking_off');
  assert.equal(no.ctx.looked, null);
  assert.equal(pictures(no.ctx).length, 1);
});

test('a camera that does not answer is said, not guessed', async () => {
  settings.home.bitCameras = 'yes';
  const ctx = { fnArgs: { action: 'look', camera: 'giardino' }, clientActions: [], look: () => assert.fail('no picture to see') };
  const d = deps();
  d.deckHa.cameraSnapshot = async () => { throw new Error('ha_snapshot_failed_502'); };
  const out = await branches.home_camera(ctx, d);
  assert.equal(out.error, 'snapshot_failed');
});

test('no camera connected, an unknown one, a bad action: plain answers', async () => {
  settings = { home: {} };
  assert.equal((await call({ action: 'show', camera: 'x' })).out.error, 'no_cameras');
  settings = { homeAssistant: { url: 'http://ha.example:8123', token: 'pretend' } };
  const miss = await call({ action: 'show', camera: 'cantina' });
  assert.equal(miss.out.error, 'not_found');
  assert.deepEqual(miss.out.cameras, ['Giardino']);
  assert.equal((await call({ action: 'unlock' })).out.error, 'bad_action');
});

test('at most two pictures in one reply, never the same one twice', async () => {
  const ctx = { fnArgs: { action: 'show', camera: 'giardino' }, clientActions: [], provider: 'gemini' };
  for (const camera of ['giardino', 'giardino', 'front door', 'giardino']) await branches.home_camera({ ...ctx, fnArgs: { action: 'show', camera } }, deps());
  assert.equal(pictures(ctx).length, 2);
});

test('how is the house: open doors with minutes, temperatures, unlocked locks, lights with their switches', async () => {
  const { out, ctx } = await call({ action: 'summary' });
  assert.deepEqual(out.open, [{ name: 'Back door', area: null, minutes: 20 }]);
  assert.deepEqual(out.temperatures, [{ name: 'Living room', area: null, value: 21.5, unit: '°C' }]);
  assert.deepEqual(out.unlocked, [{ name: 'Front lock', area: null }]);
  assert.equal(out.lightsOn, 1);
  assert.deepEqual(out.cameras, ['Front door', 'Giardino']);
  const controls = ctx.clientActions.filter((a) => a.action === 'reply_control').map((a) => a.args);
  assert.deepEqual(controls.map((c) => c.entity), ['light.kitchen'], 'only lights get a switch, never the lock');
  assert.match(out.hint, /cannot open or lock/);
});

test('the summary works without Home Assistant, and caps long lists', async () => {
  settings = { unifi: { host: 'unifi.example', username: 'viewer', password: 'pretend' } };
  const { out } = await call({ action: 'summary' });
  assert.equal(out.homeAssistant, false);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'light.l' + i, name: 'L' + i, domain: 'light', state: 'on' }));
  const sum = summarize([...many, { id: 'sensor.x', domain: 'sensor', state: 'unavailable' }, null, { id: 3 }], NOW);
  assert.equal(sum.lightsOn, 30);
  assert.equal(sum.lights.length, 12);
  assert.equal(sum.unavailable, 1);
});

test('what happened today: the log newest first with day and time, said honestly; off means off', async () => {
  await homeLog.record({ kind: 'person', place: 'Giardino' }, Date.now() - 3 * 60000);
  await homeLog.record({ kind: 'ring', place: 'Front door' }, Date.now() - 60000);
  const { out, ctx } = await call({ action: 'events' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.events.map((e) => [e.kind, e.place]), [['ring', 'Front door'], ['person', 'Giardino']]);
  assert.ok(out.events.every((e) => ['today', 'yesterday'].includes(e.day) && /^[0-2][0-9]:[0-5][0-9]$/.test(e.time)));
  assert.match(out.hint, /while Xenon was open/);
  assert.match(out.hint, /Never guess who/);
  assert.equal(ctx.clientActions.length, 0, 'nothing in the reply but words');
  settings.home.log = false;
  assert.equal((await call({ action: 'events' })).out.error, 'log_off');
});

const post = (body) => Object.assign(Readable.from([Buffer.from(body)]), { headers: {} });
const answer = async (body) => {
  let got = null;
  await consent.route(post(body), {}, { json: (v) => { got = v; } });
  return got;
};

test('the consent route: yes saves for good, once is kept in memory, anything else is refused', async () => {
  assert.deepEqual(await answer('{"choice":"once"}'), { ok: true, choice: 'once' });
  assert.equal(saved.length, 0);
  assert.equal(consent.takeOnce(), true);
  assert.deepEqual(await answer('{"choice":"yes"}'), { ok: true, choice: 'yes' });
  assert.deepEqual(saved, [{ key: 'home', value: { doorbell: true, doorbellPush: false, bitCameras: 'yes', log: true } }]);
  for (const bad of ['{"choice":"no"}', '{"choice":"always"}', 'nope', '{}']) assert.equal((await answer(bad)).ok, false);
  assert.equal(saved.length, 1);
});

test('a yes given for an AI on this PC does not cover a cloud AI', () => {
  const s = { home: { bitCameras: 'local' } };
  assert.equal(consent.modeOf(s, 'ollama'), 'yes');
  assert.equal(consent.modeOf(s, 'localapi'), 'yes');
  assert.equal(consent.modeOf(s, 'gemini'), 'ask');
  assert.equal(consent.modeOf(s, undefined), 'ask');
  assert.equal(consent.modeOf({ home: { bitCameras: 'yes' } }, 'gemini'), 'yes');
  assert.equal(consent.modeOf({ home: { bitCameras: 'no' } }, 'ollama'), 'no');
});

test('"only this time" said under one camera does not open another', () => {
  consent._reset();
  consent.grantOnce(NOW, '/api/ha/camera/one');
  assert.equal(consent.takeOnce(NOW, '/api/ha/camera/two'), false);
  assert.equal(consent.takeOnce(NOW, '/api/ha/camera/one'), true);
  assert.equal(consent.takeOnce(NOW, '/api/ha/camera/one'), false, 'used once');
  consent._reset();
});
