import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { pumpViews } = require('../menu/menu-pump.js');
const { screensSection } = require('../menu/menu-screens.js');
const { pumpsIn, createPumpDetect, CACHE_MS } = require('../pump-screen/detect.js');
const Pumps = require('../js/menu/xenon-menu-pumps.js');
const Model = require('../js/pump/pump-model.js');
const Faces = require('../js/pump/pump-faces.js');
const { LANGS } = require('../app-strings/tables.js');

// A screen as GET /pump and the pumpGet action give it.
function screen(id = 'pump', over = {}) {
  return {
    screen: id, ...Model.screenFor({ screens: {}, seen: {} }, id), set: false,
    seen: { shape: 'round', w: 480, h: 480, via: 'icue' }, now: { show: { face: 'sensors', style: 'rings' }, why: 'base' }, ...over,
  };
}
const state = (pump, probes = {}) => ({ probes, pump: { icue: true, detected: [], url: 'http://127.0.0.1:3030/pump-face', ...pump } });
const tab = (view, id) => view.tabs.find((t) => t.id === id);
const row = (t, id) => t.rows.find((r) => r.id === id);
const patchOf = (act) => JSON.parse(act.run.patch);

test('no pump, no card: nothing under the desk until one is found or shows up', () => {
  assert.deepEqual(pumpViews({}), []);
  assert.deepEqual(pumpViews(state({ screens: [] })), []);
});

test('a pump found but never seen offers its one step: iCUE for CORSAIR, the address for NZXT', () => {
  const [corsair] = pumpViews(state({ screens: [], detected: [{ brand: 'corsair', route: 'icue' }] }));
  assert.equal(corsair.add, true);
  assert.deepEqual(corsair.tabs[0].rows[0].act, { run: { type: 'pumpIcue' } });
  assert.equal(corsair.tabs[0].rows[0].off, false);
  // The card says what was found and the step left, and a tap on it takes that step.
  assert.deepEqual([corsair.label, corsair.chip], [{ key: 'xmenu_pump_found' }, { key: 'xmenu_pump_found_icue' }]);
  assert.deepEqual(corsair.act, { run: { type: 'pumpIcue' } });
  const [noIcue] = pumpViews(state({ icue: false, screens: [], detected: [{ brand: 'corsair', route: 'icue' }] }));
  assert.equal(noIcue.act, null, 'nothing to open where iCUE cannot import');
  const [nzxt] = pumpViews(state({ screens: [], detected: [{ brand: 'nzxt', route: 'cam' }] }));
  assert.equal(nzxt.tabs[0].rows[0].kind, 'status');
  assert.deepEqual(nzxt.tabs[0].rows[0].value, { text: 'http://127.0.0.1:3030/pump-face' });
  assert.deepEqual([nzxt.chip, nzxt.act], [{ key: 'xmenu_pump_found_cam' }, null], 'CAM takes an address, nothing to open');
  // A screen that already showed Xenon is the pump itself: no more first step.
  const seen = pumpViews(state({ screens: [screen()], detected: [{ brand: 'corsair', route: 'icue' }] }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].add, undefined);
});

test('each pump screen is a card in its shape with three tabs, and its name when there are two', () => {
  const one = pumpViews(state({ screens: [screen()] }));
  assert.equal(one[0].key, 'pump:pump');
  assert.deepEqual(one[0].label, { key: 'xmenu_pump' });
  assert.deepEqual(one[0].tabs.map((t) => t.id), ['shows', 'alerts', 'look']);
  assert.deepEqual(one[0].chip, { key: 'pump_face_sensors' });
  const two = pumpViews(state({ screens: [screen('top', { seen: { shape: 'square' } }), screen('side', { name: 'Side AIO' })] }));
  assert.deepEqual(two.map((v) => [v.label, v.shape]), [[{ text: 'top' }, 'square'], [{ text: 'Side AIO' }, 'round']]);
});

test('"What it shows" is a line per moment in the order that wins, then the rest of the time', () => {
  const shows = tab(pumpViews(state({ screens: [screen()] }))[0], 'shows');
  assert.equal(shows.value, null, 'what it shows now is said over the tabs, once');
  assert.deepEqual(shows.rows.map((r) => [r.kind, r.id]), [
    ['pumpnote', 'pump-intro'], ['pumpmoment', 'pump-m-0'], ['pumpmoment', 'pump-m-1'], ['pumpmoment', 'pump-base'],
    ['pumpadd', 'pump-add'], ['pumpcards', 'pump-setup'],
  ]);
  assert.deepEqual(row(shows, 'pump-intro').label, { key: 'xmenu_pump_auto_intro' });
  assert.deepEqual(shows.rows.slice(1, 4).map((r) => r.label), [{ key: 'xmenu_pump_when_game' }, { key: 'xmenu_pump_when_music' }, { key: 'xmenu_pump_rest' }]);
  // Closed, a line says what it shows: the face drawn small, its name, its readings or style.
  const game = row(shows, 'pump-m-0');
  assert.deepEqual([game.value, game.art], [{ key: 'pump_face_game' }, 'game']);
  assert.deepEqual(game.sub, [{ key: 'pump_reading_fps' }, { key: 'pump_reading_gpu_temp' }, { key: 'pump_reading_cpu_temp' }]);
  assert.deepEqual(row(shows, 'pump-m-1').sub, { key: 'xmenu_pump_style_cover' });
  // A moment comes off by its place; the rest of the time always stays.
  assert.deepEqual(patchOf(row(shows, 'pump-m-1').remove.act), { removeMoment: 1 });
  assert.deepEqual(row(shows, 'pump-m-1').remove.label, { key: 'xmenu_pump_m_remove' });
  assert.equal(row(shows, 'pump-base').remove, null);
});

test('a line opens on every face as a card, and picking one changes only that line', () => {
  const shows = tab(pumpViews(state({ screens: [screen()] }))[0], 'shows');
  const music = row(shows, 'pump-m-1');
  assert.deepEqual(music.faces.map((f) => [f.value, f.on]), [['sensors', false], ['game', false], ['music', true], ['clock', false], ['picture', false]]);
  assert.equal(music.faces.find((f) => f.on).act, null, 'the face on is not a button again');
  const swapped = patchOf(music.faces.find((f) => f.value === 'clock').act).moments;
  assert.deepEqual(swapped.map((m) => m.show.face), ['game', 'clock']);
  assert.deepEqual(swapped[0], screen().moments[0]);
  // The rest of the time takes a face the way this screen already shows it: music as a cover.
  assert.deepEqual(patchOf(row(shows, 'pump-base').faces.find((f) => f.value === 'music').act), { base: { face: 'music', style: 'cover' } });
  // A face of the person's own, four ways: Bit and the Store leave the menu, the other two open a page.
  assert.deepEqual(music.own.actions.map((a) => [a.label.key, a.closes === true]),
    [['xmenu_bit', true], ['xmenu_pump_in_maker', false], ['xmenu_pump_in_code', false], ['xmenu_pump_from_store', true]]);
  assert.deepEqual([music.own.actions[0].act, music.own.actions[3].act], [{ open: 'chat' }, { open: 'store:__pump' }]);
  assert.ok(music.own.actions.slice(1, 3).every((a) => a.act.run.type === 'openUrl' && a.act.run.url.startsWith('https://xenon-app.com/')));
});

test('every face, on any line, offers its own choices: style, numbers, what a clock adds', () => {
  const shows = (s) => tab(pumpViews(state({ screens: [s] }))[0], 'shows');
  const base = row(shows(screen()), 'pump-base');
  assert.deepEqual(row(base, 'pump-base-style').options.map((o) => o.value), ['rings', 'bars', 'numbers']);
  const readings = row(base, 'pump-base-readings');
  assert.equal(readings.multi, true);
  assert.deepEqual(readings.sub, { key: 'xmenu_pump_readings_sub' });
  assert.deepEqual(readings.options.filter((o) => o.on).map((o) => o.value), ['cpuTemp', 'gpuTemp']);
  assert.deepEqual(readings.options.find((o) => o.value === 'cpuClock').label, { key: 'pump_reading_cpu_clock' });
  assert.deepEqual(patchOf(readings.options.find((o) => o.value === 'fps').act).base.readings, ['cpuTemp', 'gpuTemp', 'fps']);
  assert.deepEqual(patchOf(readings.options.find((o) => o.value === 'gpuTemp').act), { base: { face: 'sensors', style: 'rings', readings: ['cpuTemp'] } });
  // Four on: a fifth takes the fourth's place. One on: it stays, a face with no number is not a choice.
  const four = row(row(shows(screen('pump', { base: { face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'cpu', 'gpu'] } })), 'pump-base'), 'pump-base-readings');
  assert.deepEqual(patchOf(four.options.find((o) => o.value === 'ram').act).base.readings, ['cpuTemp', 'gpuTemp', 'cpu', 'ram']);
  const lone = row(row(shows(screen('pump', { base: { face: 'sensors', style: 'rings', readings: ['cpu'] } })), 'pump-base'), 'pump-base-readings');
  assert.equal(lone.options.find((o) => o.value === 'cpu').act, null);
  // The Game face shows three: the first large. A fourth takes the third's place.
  const game = row(row(shows(screen()), 'pump-m-0'), 'pump-m-0-readings');
  assert.deepEqual(game.sub, { key: 'xmenu_pump_readings_game_sub' });
  // The keys keep their places, so a tap never moves the one under the finger; each one on says
  // its place on the face.
  assert.deepEqual(game.options.map((o) => o.value), Faces.READINGS, 'always the same order');
  assert.deepEqual(readings.options.map((o) => o.value), Faces.READINGS);
  assert.deepEqual(game.options.filter((o) => o.on).map((o) => [o.value, o.rank]), [['cpuTemp', 3], ['gpuTemp', 2], ['fps', 1]],
    'the place each has on the face');
  assert.ok(game.options.filter((o) => !o.on).every((o) => o.rank === 0));
  const moments = patchOf(game.options.find((o) => o.value === 'cpu').act).moments;
  assert.deepEqual(moments[0].show.readings, ['fps', 'gpuTemp', 'cpu']);
  assert.deepEqual(moments[1], screen().moments[1], 'only its own line changes');
  const vinyl = patchOf(row(row(shows(screen()), 'pump-m-1'), 'pump-m-1-style').options.find((o) => o.value === 'vinyl').act).moments;
  assert.deepEqual(vinyl[1].show, { face: 'music', style: 'vinyl' });
  assert.equal(row(row(shows(screen()), 'pump-m-1'), 'pump-m-1-readings'), undefined, 'a music face reads no numbers');
  const clock = row(shows(screen('pump', { base: { face: 'clock', style: 'digital', seconds: false, date: true, weather: true } })), 'pump-base');
  const parts = row(clock, 'pump-base-clock');
  assert.deepEqual(parts.options.map((o) => [o.value, o.on]), [['seconds', false], ['date', true], ['weather', true]]);
  assert.equal(patchOf(parts.options[0].act).base.seconds, true);
  assert.equal(patchOf(parts.options[2].act).base.weather, false);
  assert.deepEqual(clock.sub, [{ key: 'xmenu_pump_style_digital' }, { key: 'xmenu_pump_clock_date' }, { key: 'xmenu_pump_clock_weather' }]);
});

test('a picture line picks one of Xenon\'s or takes the person\'s own file', () => {
  const pic = (items) => row(tab(pumpViews(state({ screens: [screen('pump', { base: { face: 'picture', items, every: 10, fit: 'cover' } })] }))[0], 'shows'), 'pump-base');
  const ready = pic(['art:tide']);
  assert.equal(row(ready, 'pump-base-style'), undefined);
  assert.equal(row(ready, 'pump-base-art').value, 'art:tide');
  assert.deepEqual(ready.sub, { key: 'xmenu_pump_art_tide' });
  // The file's address goes where the mark is once it is up (xenon-menu-pump-rows.js).
  assert.deepEqual(ready.upload.label, { key: 'xmenu_pump_own' });
  assert.deepEqual(patchOf(ready.upload.act), { base: { face: 'picture', items: ['xenon:file'], every: 10, fit: 'cover' } });
  const own = pic(['/uploads/pump-1-ab.gif']);
  assert.equal(row(own, 'pump-base-art').value, '', 'a picture of your own lights none of the ready ones');
  assert.deepEqual([own.sub, row(own, 'pump-base-art').sub], [{ key: 'xmenu_pump_art_own' }, { key: 'xmenu_pump_art_own' }]);
  assert.equal(row(tab(pumpViews(state({ screens: [screen()] }))[0], 'shows'), 'pump-base').upload, null, 'only a picture face takes a file');
});

test('over the tabs: what the pump shows now and why, and the way back when picked by hand', () => {
  const now = (n, over = {}) => pumpViews(state({ screens: [screen('pump', { now: n, ...over })] }))[0].now;
  assert.deepEqual(now({ show: { face: 'music', style: 'cover' }, why: 'music' }),
    { caption: { key: 'xmenu_pump_now_is' }, what: { key: 'pump_face_music' }, why: { key: 'xmenu_pump_why_music' }, back: null });
  assert.deepEqual(now({ show: { face: 'sensors' }, why: 'base' }).why, { key: 'xmenu_pump_why_rest' });
  assert.deepEqual(now({ show: { face: 'clock' }, why: 'screensOff' }).why, { key: 'xmenu_pump_why_off' });
  const pinned = now({ show: { face: 'clock' }, why: 'pinned' });
  assert.deepEqual(pinned.why, { key: 'xmenu_pump_why_pinned' });
  assert.deepEqual(pinned.back, { label: { key: 'xmenu_pump_back_auto' }, act: { run: { type: 'pumpFace', screen: 'pump', face: 'auto' } } });
  // A line about an hour or an app: "because of the line" and the line's own name.
  const hours = { when: { any: [{ c: 'time', from: '22:00', to: '07:00' }] }, show: { face: 'clock' } };
  assert.deepEqual(now({ show: { face: 'clock' }, why: 'time:22:00-07:00' }, { moments: [hours] }).why,
    { pair: [{ key: 'xmenu_pump_why_row' }, { key: 'xmenu_pump_when_time', vars: { from: '22:00', to: '07:00' } }] });
  assert.equal(pumpViews(state({ screens: [screen('pump', { now: null })] }))[0].now, null);
});

test('a new line takes a situation still free, with the face that moment is for', () => {
  const add = (probes) => row(tab(pumpViews(state({ screens: [screen()] }, probes))[0], 'shows'), 'pump-add');
  const free = add().options.map((o) => o.value);
  assert.ok(!free.includes('game') && !free.includes('music'), 'situations in use are not offered again');
  assert.ok(!free.includes('call'), 'a call only where this PC can tell one');
  assert.ok(add({ situationCall: true }).options.some((o) => o.value === 'call'));
  assert.equal(free.at(-1), 'night');
  assert.deepEqual(add().options.find((o) => o.value === 'live').label, { key: 'xmenu_pump_when_live' });
  assert.deepEqual(patchOf(add().options.find((o) => o.value === 'busy').act).addMoment,
    { when: { any: [{ c: 'busy' }] }, show: { face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'] } });
  const night = patchOf(add().options.find((o) => o.value === 'night').act).addMoment;
  assert.deepEqual([night.when, night.show.face], [{ any: [{ c: 'time', from: '23:00', to: '07:00' }] }, 'clock']);
  // Full, or the night already a line: nothing more of it.
  const when = (c) => ({ when: { any: [{ c }] }, show: { face: 'clock' } });
  const full = screen('pump', { moments: ['game', 'music', 'live', 'recording', 'timer', 'dnd'].map(when) });
  assert.equal(row(tab(pumpViews(state({ screens: [full] }))[0], 'shows'), 'pump-add'), undefined);
  const hours = screen('pump', { moments: [{ when: { any: [{ c: 'time', from: '22:00', to: '07:00' }] }, show: { face: 'clock' } }] });
  const shows = tab(pumpViews(state({ screens: [hours] }))[0], 'shows');
  assert.ok(!row(shows, 'pump-add').options.some((o) => o.value === 'night'));
  assert.deepEqual(row(shows, 'pump-m-0').label, { key: 'xmenu_pump_when_time', vars: { from: '22:00', to: '07:00' } });
});

test('the examples fill every line in one tap, and none of them is ticked', () => {
  const ex = row(tab(pumpViews(state({ screens: [screen()] }))[0], 'shows'), 'pump-setup');
  assert.equal(ex.plain, true);
  assert.deepEqual(ex.cards.map((c) => c.value), Model.SETUP_NAMES);
  assert.ok(ex.cards.every((c) => c.on === undefined));
  const monitor = ex.cards.find((c) => c.value === 'monitor');
  assert.deepEqual([monitor.label, monitor.sub], [{ key: 'pump_setup_monitor' }, { key: 'xmenu_pump_setup_monitor_sub' }]);
  assert.deepEqual(monitor.act, { run: { type: 'pumpSetup', screen: 'pump', setup: 'monitor' } });
});

test('alerts: the ones that arrive most first, each with what it says, then how long', () => {
  const alerts = (probes) => tab(pumpViews(state({ screens: [screen()] }, probes))[0], 'alerts');
  const a = alerts();
  assert.deepEqual(a.rows.map((r) => r.id), ['pump-a-intro', 'pump-a-which', 'pump-a-notify', 'pump-a-discord', 'pump-a-timer', 'pump-a-hot', 'pump-secs', 'pump-hide']);
  assert.deepEqual(alerts({ situationCall: true }).rows.slice(2, 6).map((r) => r.id), ['pump-a-notify', 'pump-a-discord', 'pump-a-call', 'pump-a-timer']);
  assert.deepEqual(row(a, 'pump-a-discord').sub, { key: 'xmenu_pump_alert_discord_sub' });
  assert.deepEqual(patchOf(row(a, 'pump-a-discord').acts.off), { alerts: { discord: false } });
  assert.deepEqual(patchOf(row(a, 'pump-secs').options[2].act), { alerts: { seconds: 15 } });
  assert.equal(row(a, 'pump-hide').on, true);
  assert.equal(a.value, null, 'the tab says its name only, as the other two');
});

test('look: the ring\'s colours as cards where iCUE paints it, then the screen', () => {
  const look = (pump, over) => tab(pumpViews(state({ screens: [screen('pump', over)], ...pump }))[0], 'look');
  const lit = look({ sound: true });
  const leds = row(lit, 'pump-leds');
  assert.equal(leds.kind, 'pumpcards');
  assert.deepEqual(leds.cards.map((c) => [c.value, c.art]), Model.LED_FOLLOW.map((f) => [f, 'leds-' + f]));
  const follow = screen().leds.follow;
  assert.equal(leds.cards.find((c) => c.on).value, follow);
  assert.equal(leds.cards.find((c) => c.on).act, null);
  const other = leds.cards.find((c) => !c.on);
  assert.deepEqual(patchOf(other.act), { leds: { follow: other.value } });
  assert.deepEqual(row(lit, 'pump-screen').kind, 'tunehead');
  // The two switches only where they do something: the pulse needs sound, "everything" the screen's colours.
  const leds2 = (f, sound) => look({ sound }, { leds: { ...screen().leds, follow: f } }).rows.map((r) => r.id);
  assert.ok(leds2('screen', true).includes('pump-leds-pulse') && leds2('screen', true).includes('pump-leds-all'));
  assert.ok(!leds2('screen', false).includes('pump-leds-pulse'));
  assert.ok(!leds2('theme', true).includes('pump-leds-all'));
  assert.ok(!leds2('off', true).includes('pump-leds-pulse'));
  // No iCUE: no ring to paint, the screen's rows only.
  const plain = look({ icue: false });
  assert.deepEqual(plain.rows.map((r) => r.id), ['pump-rotate', 'pump-dim', 'pump-night', 'pump-fade']);
  assert.deepEqual(patchOf(row(plain, 'pump-rotate').options[1].act), { look: { rotate: 90 } });
  assert.deepEqual(row(plain, 'pump-night').sub, { key: 'xmenu_pump_night_at', vars: { from: '23:00', to: '07:00', dim: 30 } });
  assert.deepEqual(patchOf(row(plain, 'pump-night').acts.on), { look: { night: { from: '23:00', to: '07:00', dim: 30 } } });
  assert.deepEqual(patchOf(row(plain, 'pump-night').acts.off), { look: { night: null } });
  const own = look({ icue: false }, { look: { ...screen().look, night: { from: '22:30', to: '06:00', dim: 50 } } });
  assert.deepEqual(row(own, 'pump-night').sub.vars, { from: '22:30', to: '06:00', dim: 50 }, 'its own hours said');
  assert.deepEqual(row(plain, 'pump-fade').sub, { key: 'xmenu_pump_fade_sub' });
});

test('the Screens home carries the pumps, and search finds their rows', () => {
  const [home] = screensSection({ probes: {}, layers: {}, pump: state({ screens: [screen()] }).pump });
  assert.equal(home.pumps.length, 1);
  assert.ok(home.tune.some((r) => r.id === 'pump-night'));
});

// Every word a pump card uses, in every language the app speaks.
test('every word of the pump cards exists in all 11 languages', () => {
  const keys = new Set();
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (typeof x.key === 'string' && Object.keys(x).every((f) => f === 'key' || f === 'vars')) keys.add(x.key);
    Object.values(x).forEach(walk);
  };
  const picture = screen('a', { base: Model.normalizeScreen({ base: 'picture' }).base, now: { show: { face: 'clock' }, why: 'pinned' } });
  const clock = screen('c', { base: { face: 'clock', style: 'digital', seconds: true, date: true, weather: true }, now: { show: { face: 'clock' }, why: 'screensOff' } });
  walk(pumpViews(state({ screens: [picture, screen('b'), clock], sound: true }, { situationCall: true })));
  walk(pumpViews(state({ screens: [screen('pump', { moments: [{ when: { any: [{ c: 'time', from: '22:00', to: '07:00' }] }, show: { face: 'clock' } }], now: { show: { face: 'clock' }, why: 'time:22:00-07:00' } })] })));
  walk(pumpViews(state({ screens: [], detected: [{ route: 'icue' }] })));
  walk(pumpViews(state({ screens: [], detected: [{ route: 'cam' }] })));
  // Every line a person can add, with the face it starts with, and why the pump shows it.
  for (const c of [...require('../js/layers/layer-when.js').PLAIN]) keys.add('xmenu_pump_when_' + c).add('xmenu_pump_why_' + c);
  for (const s of ['rings', 'bars', 'numbers', 'cover', 'vinyl', 'pulse', 'digital', 'analog']) keys.add('xmenu_pump_style_' + s);
  keys.add('deck_act_pumpIcue');
  for (const x of ['own', 'own_busy', 'own_bad', 'own_failed', 'art_own']) keys.add('xmenu_pump_' + x);
  assert.ok(keys.size > 120, String(keys.size));
  for (const code of LANGS) {
    const words = require(`../js/i18n/${code}.js`);
    const missing = [...keys].filter((key) => typeof words[key] !== 'string' || !words[key]);
    assert.deepEqual(missing, [], code);
  }
});

test('pumps are found by their USB ids, once per device, a CORSAIR LCD by its name', () => {
  const found = pumpsIn([
    { vendorId: 0x1b1c, productId: 0x0c4e, product: '' },
    { vendorId: 0x1b1c, productId: 0x0c4e, product: '' },
    { vendorId: 0x1e71, productId: 0x300c, product: 'NZXT Kraken Elite' },
    { vendorId: 0x1b1c, productId: 0x0c39, product: 'CORSAIR ELITE LCD' },
    { vendorId: 0x1b1c, productId: 0x1b2d, product: 'CORSAIR K95 RGB' },
    { vendorId: 0x1e71, productId: 0x2006, product: 'NZXT Smart Device' },
  ]);
  assert.deepEqual(found, [{ brand: 'corsair', route: 'icue' }, { brand: 'nzxt', route: 'cam' }, { brand: 'corsair', route: 'icue' }]);
});

test('the USB list is read once per ten minutes, never off Windows, and a failure keeps the last list', async () => {
  let reads = 0;
  let fail = false;
  let now = 0;
  const warned = [];
  const hid = { available: true, list: async () => { reads += 1; if (fail) throw new Error('busy'); return [{ vendorId: 0x1e71, productId: 0x3008 }]; } };
  const detect = createPumpDetect({ hid, platform: 'win32', clock: () => now, warn: (m) => warned.push(m) });
  const [a, b] = await Promise.all([detect(), detect()]);
  assert.equal(reads, 1, 'two asks at once share one read');
  assert.deepEqual(a, b);
  now = CACHE_MS - 1;
  await detect();
  assert.equal(reads, 1);
  fail = true;
  now = CACHE_MS * 2;
  assert.deepEqual(await detect(), [{ brand: 'nzxt', route: 'cam' }]);
  now = CACHE_MS * 4;
  await detect();
  assert.equal(warned.length, 1, 'said once');
  fail = false;
  assert.deepEqual(await createPumpDetect({ hid, platform: 'darwin' })(), []);
  assert.deepEqual(await createPumpDetect({ hid: { available: false }, platform: 'win32' })(), []);
});

// A tiny DOM, as in xenon-menu-scene-view.test.mjs.
function node(tag) {
  const listeners = {};
  const n = {
    tag, dataset: {}, parent: null, kids: [], src: '', hidden: false, className: '', listeners,
    classList: { on: new Set(), add(c) { n.classList.on.add(c); }, remove(c) { n.classList.on.delete(c); }, toggle(c, on) { if (on) n.classList.add(c); else n.classList.remove(c); }, contains: (c) => n.classList.on.has(c) },
    style: { props: {}, setProperty(k, v) { n.style.props[k] = v; } },
    setAttribute() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    get isConnected() { return n.tag === 'body' || (!!n.parent && n.parent.isConnected); },
    appendChild(k) { k.parent = n; n.kids.push(k); return k; },
    append(...ks) { ks.forEach((k) => typeof k === 'object' && n.appendChild(k)); },
    insertBefore(k) { return n.appendChild(k); },
    remove() { n.parent = null; },
  };
  return n;
}

function rig(host = '127.0.0.1', extra = {}) {
  const body = node('body');
  const made = [];
  const el = (tag, cls, text) => { const n = node(tag); n.className = cls || ''; n.textContent = text; made.push(n); return n; };
  const view = Pumps.create({ el, button: (cls, label) => el('button', cls, label), say: (x) => x, icon: () => null, server: 'http://127.0.0.1:3030', doc: { body }, host, ...extra });
  return { body, view, made, frames: () => made.filter((n) => n.tag === 'iframe') };
}

test('the picked pump shows its own page in preview, kept through a rebuild', () => {
  const { body, view, frames } = rig();
  const [card] = pumpViews(state({ screens: [screen('desk')] }));
  body.appendChild(view.slot(card));
  view.settle();
  assert.equal(frames().length, 1);
  const [frame] = frames();
  assert.equal(frame.src, 'http://127.0.0.1:3030/pump-face?screen=desk&shape=round&preview=1');
  frame.src = 'loaded';
  view.hold();
  body.appendChild(view.slot(card));
  view.settle();
  assert.equal(frames().length, 1, 'the same frame');
  assert.equal(frame.src, 'loaded', 'not loaded again');
  assert.ok(frame.parent.isConnected);
});

// "I have three on, but I see two": while a line is open the picture shows that line, and says
// so; closed, or after the menu's rebuild without it, the pump's own face again.
test('the picture shows the line open below it, and says what the pump has meanwhile', () => {
  const { body, view, made, frames } = rig();
  const [card] = pumpViews(state({ screens: [screen('desk')] }));
  body.appendChild(view.slot(card));
  view.settle();
  const tried = [];
  const [frame] = frames();
  frame.contentWindow = { PumpFace: { tryFace: (show) => tried.push(show) } };
  frame.listeners.load();
  assert.deepEqual(tried, [null], 'loaded: its own face');
  const game = { face: 'game', readings: ['fps', 'gpuTemp', 'cpu'] };
  view.tryFace(game, 'When you play');
  assert.deepEqual(tried.at(-1), game);
  const box = made.find((n) => n.className === 'xm-pumpnow');
  assert.ok(box.classList.contains('is-trying'));
  const what = made.filter((n) => n.className === 'xm-pumpnow-what');
  assert.equal(what.at(-1).textContent, 'When you play');
  assert.deepEqual(made.find((n) => n.className === 'xm-pumpnow-tried').kids.at(-1).textContent, { key: 'xmenu_pump_try_now', vars: { what: card.now.what } });
  // A rebuild: the open line is drawn again inside it, and only then shown.
  view.hold();
  view.tryFace({ face: 'clock' }, 'Rest');
  assert.deepEqual(tried.at(-1), game, 'nothing sent halfway through a rebuild');
  body.appendChild(view.slot(card));
  view.settle();
  assert.deepEqual(tried.at(-1), { face: 'clock' });
  view.hold();
  body.appendChild(view.slot(card));
  view.settle();
  assert.equal(tried.at(-1), null, 'rebuilt with no line open: its own face');
  assert.equal(made.filter((n) => n.className === 'xm-pumpnow').at(-1).classList.contains('is-trying'), false);
  view.tryFace(game, 'x');
  view.tryFace(null);
  assert.equal(tried.at(-1), null, 'the line closed');
  frame.contentWindow = null;
  view.tryFace(game, 'x');
});

test('the face page shows a line it is handed only as the menu\'s picture, never on the pump', () => {
  const src = readFileSync(new URL('../js/pump/pump-face.js', import.meta.url), 'utf8');
  const at = src.indexOf('tryFace(show) {');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 200), /^tryFace\(show\) \{\n\s+if \(!preview\) return false;/);
  assert.match(src, /const mine = \(tried && Faces\.normalizeFace\(tried\)\) \|\| /, 'the line handed over wins over the pump\'s own');
});

test('each pump is drawn as it is: round, square, or a panel in its proportions as mounted', () => {
  const view = (seen, look) => pumpViews(state({ screens: [screen('p', { seen: { via: 'icue', ...seen }, ...(look ? { look: { ...Model.screenFor({ screens: {}, seen: {} }, 'p').look, ...look } } : {}) })] }))[0];
  assert.deepEqual([view({ shape: 'round', w: 480, h: 480 }).ratio, view({ shape: 'round', w: 480, h: 480 }).turn], [1, 0]);
  assert.equal(view({ shape: 'square', w: 320, h: 300 }).ratio, 1, 'a square is drawn square');
  assert.equal(view({ shape: 'wide', w: 320, h: 240 }).ratio, 1.333, 'landscape');
  assert.equal(view({ shape: 'wide', w: 240, h: 320 }).ratio, 0.75, 'portrait');
  assert.equal(view({ shape: 'wide', w: 320, h: 240 }, { rotate: 90 }).ratio, 0.75, 'a landscape panel turned a quarter stands up');
  assert.equal(view({ shape: 'wide', w: 320, h: 240 }, { rotate: 180 }).ratio, 1.333);
  const turned = view({ shape: 'round', w: 480, h: 480 }, { rotate: 270 });
  assert.deepEqual([turned.ratio, turned.turn], [1, 270]);
  assert.equal(view({ shape: 'wide', w: 1920, h: 240 }).ratio, 4, 'never thinner than a quarter');
  assert.equal(view({ shape: 'wide', w: 0, h: 240 }).ratio, 1, 'no size: drawn square');
  const add = pumpViews(state({ screens: [], detected: [{ brand: 'corsair', route: 'icue' }] }))[0];
  assert.deepEqual([add.shape, add.ratio, add.turn], ['round', 1, 0]);
});

test('the card and the picture take those proportions, the picture turned back to read upright', () => {
  assert.deepEqual(Pumps.drawSize(1, 176, 264), { w: 176, h: 176 });
  assert.deepEqual(Pumps.drawSize(4 / 3, 176, 264), { w: 235, h: 176 });
  assert.deepEqual(Pumps.drawSize(4, 176, 264), { w: 264, h: 66 }, 'a long bar stops at its cap');
  assert.deepEqual(Pumps.drawSize(0.75, 176, 264), { w: 132, h: 176 });
  assert.deepEqual(Pumps.drawSize(NaN, 28, 42), { w: 28, h: 28 });
  assert.deepEqual(Pumps.shapeProps({ ratio: 0.75, turn: 90 }, 176, 264), {
    '--xm-pump-w': '132px', '--xm-pump-h': '176px', '--xm-pump-fw': '176px', '--xm-pump-fh': '132px', '--xm-pump-turn': '-90deg',
  });
  assert.equal(Pumps.shapeProps({ ratio: 1, turn: 180 }, 176, 264)['--xm-pump-fw'], '176px');
  const { body, view, made } = rig();
  const wide = screen('desk', { seen: { shape: 'wide', w: 320, h: 240, via: 'cam' } });
  const [card] = pumpViews(state({ screens: [wide] }));
  view.cards([card], card.key, () => {});
  const mark = made.find((n) => n.className === 'xm-scrpump-shape');
  assert.deepEqual([mark.style.props['--xm-pump-w'], mark.style.props['--xm-pump-h']], ['37px', '28px']);
  body.appendChild(view.slot(card));
  const box = made.find((n) => n.className === 'xm-pumppreview');
  assert.deepEqual([box.style.props['--xm-pump-w'], box.style.props['--xm-pump-h'], box.style.props['--xm-pump-turn']], ['235px', '176px', '0deg']);
  const css = readFileSync(new URL('../components/XenonMenu/XenonMenuScreens.css', import.meta.url), 'utf8');
  const frameRule = css.slice(css.indexOf('.xm-pumpframe {'), css.indexOf('}', css.indexOf('.xm-pumpframe {')));
  assert.ok(frameRule.includes('width: var(--xm-pump-fw, 100%); height: var(--xm-pump-fh, 100%)'), 'the page at the panel size');
  assert.ok(frameRule.includes('rotate(var(--xm-pump-turn, 0deg))'), 'turned back');
  const face = readFileSync(new URL('../components/PumpFace/PumpFace.css', import.meta.url), 'utf8');
  assert.ok(face.includes('.pf-stage[data-rotate="90"], .pf-stage[data-rotate="270"] { inset: auto; left: 50%; top: 50%; width: 100vh; height: 100vw; }'), 'a quarter turn swaps the stage sides');
});

test('no picture on a paired phone, for a pump not set up yet, or once no pump is picked', () => {
  const phone = rig('192.168.1.20');
  const [card] = pumpViews(state({ screens: [screen()] }));
  phone.body.appendChild(phone.view.slot(card));
  phone.view.settle();
  assert.equal(phone.made.some((n) => /xm-pumppreview/.test(n.className)), false);
  assert.equal(phone.frames().length, 0);
  const { body, view, frames } = rig();
  assert.equal(view.slot(pumpViews(state({ screens: [], detected: [{ route: 'icue' }] }))[0]), null);
  body.appendChild(view.slot(card));
  view.settle();
  view.hold();
  view.slot(null);
  view.settle();
  assert.equal(frames()[0].parent, null, 'the frame goes with the pump');
});

test('a widget made for a pump is one more face card on every line, marked as the person\'s', () => {
  const widgets = [{ id: 'neon-clock', name: 'Neon Clock', shapes: ['round'] }];
  const v = pumpViews(state({ screens: [screen()], widgets }))[0];
  const card = row(tab(v, 'shows'), 'pump-base').faces.find((f) => f.value === 'widget:neon-clock');
  assert.deepEqual([card.label, card.art, card.own], [{ text: 'Neon Clock' }, 'widget', true]);
  assert.deepEqual(patchOf(card.act), { base: { face: 'widget', id: 'neon-clock' } });
  const swapped = patchOf(row(tab(v, 'shows'), 'pump-m-0').faces.find((f) => f.value === 'widget:neon-clock').act).moments;
  assert.deepEqual(swapped[0].show, { face: 'widget', id: 'neon-clock' });
  // On it: the card is lit, and the card under the desk and "now" say its name.
  const on = pumpViews(state({ screens: [screen('pump', { base: { face: 'widget', id: 'neon-clock' }, now: { show: { face: 'widget', id: 'neon-clock' }, why: 'base' } })], widgets }))[0];
  const base = row(tab(on, 'shows'), 'pump-base');
  assert.equal(base.faces.find((f) => f.on).value, 'widget:neon-clock');
  assert.deepEqual([on.chip, on.now.what, base.value], [{ text: 'Neon Clock' }, { text: 'Neon Clock' }, { text: 'Neon Clock' }]);
  assert.equal(base.sub, null);
  // Removed since: still a card under a plain name, and the line says why the pump shows a clock.
  const gone = row(tab(pumpViews(state({ screens: [screen('pump', { base: { face: 'widget', id: 'neon-clock' } })] }))[0], 'shows'), 'pump-base');
  assert.deepEqual(gone.faces.find((f) => f.value === 'widget:neon-clock').label, { key: 'pump_face_widget' });
  assert.deepEqual(gone.sub, { key: 'xmenu_pump_widget_off' });
});

test('an open menu reads the pump again when a pump says hello or changes', () => {
  // The menu shows a pump that appears while it is open (iCUE or CAM opened its page) and a
  // change Bit, the Deck or a phone made, without being closed and opened again.
  const src = readFileSync(new URL('../js/menu/xenon-menu.js', import.meta.url), 'utf8');
  const list = src.match(/const LIVE_EVENTS = \[([^\]]*)\]/);
  assert.ok(list, 'the menu names the live events it refreshes on');
  assert.ok(list[1].split(',').map((x) => x.trim().replace(/'/g, '')).includes('pump'));
  const live = readFileSync(new URL('../pump-screen/live.js', import.meta.url), 'utf8');
  assert.ok(live.includes("broadcast('pump'"), 'the event the menu listens to is the one the pump sends');
});

// "It does nothing when I tap it": the card of a pump just found opens iCUE itself, on this PC.
test('tapping the card of a pump just found runs its step on this PC, never from a paired phone', () => {
  const [add] = pumpViews(state({ screens: [], detected: [{ brand: 'corsair', route: 'icue' }] }));
  for (const [host, expected] of [['127.0.0.1', 1], ['192.168.1.20', 0]]) {
    const ran = [];
    const picked = [];
    const { view } = rig(host, { perform: (_row, act) => ran.push(act) });
    const list = view.cards([add], null, (key) => picked.push(key));
    list.kids[0].listeners.click();
    assert.deepEqual(picked, ['pump-add'], 'the card is picked too');
    assert.equal(ran.length, expected, host);
    if (expected) assert.deepEqual(ran[0], { run: { type: 'pumpIcue' } });
  }
  const ran = [];
  const { view } = rig('127.0.0.1', { perform: (_row, act) => ran.push(act) });
  view.cards(pumpViews(state({ screens: [screen()] })), null, () => {}).kids[0].listeners.click();
  assert.deepEqual(ran, [], 'a pump already on Xenon only opens its page');
});
