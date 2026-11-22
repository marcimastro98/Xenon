import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { pumpViews, setupOf, whyText } = require('../menu/menu-pump.js');
const { screensSection } = require('../menu/menu-screens.js');
const { pumpsIn, createPumpDetect, CACHE_MS } = require('../pump-screen/detect.js');
const Pumps = require('../js/menu/xenon-menu-pumps.js');
const Model = require('../js/pump/pump-model.js');
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

test('each pump screen is a card in its shape with four tabs, and its name when there are two', () => {
  const one = pumpViews(state({ screens: [screen()] }));
  assert.equal(one[0].key, 'pump:pump');
  assert.deepEqual(one[0].label, { key: 'xmenu_pump' });
  assert.deepEqual(one[0].tabs.map((t) => t.id), ['shows', 'moments', 'alerts', 'look']);
  assert.deepEqual(one[0].chip, { key: 'pump_face_sensors' });
  const two = pumpViews(state({ screens: [screen('top', { seen: { shape: 'square' } }), screen('side', { name: 'Side AIO' })] }));
  assert.deepEqual(two.map((v) => [v.label, v.shape]), [[{ text: 'top' }, 'square'], [{ text: 'Side AIO' }, 'round']]);
});

test('the setup row lights the setup the screen still matches, and none once changed', () => {
  assert.equal(setupOf(screen()), 'game');
  const own = { ...screen(), base: { face: 'clock', style: 'digital', seconds: false, date: true, weather: true } };
  assert.equal(setupOf(own), '');
  const setup = row(tab(pumpViews(state({ screens: [screen()] }))[0], 'shows'), 'pump-setup');
  assert.equal(setup.value, 'game');
  assert.deepEqual(setup.options.find((o) => o.value === 'monitor').act, { run: { type: 'pumpSetup', screen: 'pump', setup: 'monitor' } });
});

test('the usual face keeps the way this screen shows it, and its styles follow the face', () => {
  const v = pumpViews(state({ screens: [screen()] }))[0];
  const base = row(tab(v, 'shows'), 'pump-base');
  // The setup shows music as a cover in a moment: picked as the usual face, it stays a cover.
  assert.deepEqual(patchOf(base.options.find((o) => o.value === 'music').act), { base: { face: 'music', style: 'cover' } });
  assert.deepEqual(row(tab(v, 'shows'), 'pump-style').options.map((o) => o.value), ['rings', 'bars', 'numbers']);
  const pic = pumpViews(state({ screens: [screen('pump', { base: { face: 'picture', items: ['art:tide'], every: 10, fit: 'cover' } })] }))[0];
  assert.equal(row(tab(pic, 'shows'), 'pump-style'), undefined);
  assert.equal(row(tab(pic, 'shows'), 'pump-art').value, 'art:tide');
});

test('"show now" runs the face action and says why the pump shows what it shows', () => {
  const v = pumpViews(state({ screens: [screen('pump', { now: { show: { face: 'clock' }, why: 'pinned' } })] }))[0];
  const now = row(tab(v, 'shows'), 'pump-now');
  assert.equal(now.value, 'clock');
  assert.deepEqual(now.options[0].act, { run: { type: 'pumpFace', screen: 'pump', face: 'auto' } });
  assert.deepEqual(now.sub[1], { key: 'xmenu_pump_why_pinned' });
  assert.equal(row(tab(pumpViews(state({ screens: [screen()] }))[0], 'shows'), 'pump-now').value, 'auto', 'a moment or the usual face is automatic');
  const s = screen();
  assert.deepEqual(whyText({ show: { face: 'music' }, why: 'music' }, s), [{ pair: [{ key: 'xmenu_pump_now_is' }, { key: 'pump_face_music' }] }, { key: 'xmenu_sit_music' }]);
  assert.deepEqual(whyText({ show: s.base, why: 'base' }, s)[1], { key: 'xmenu_pump_why_base' });
  assert.equal(whyText(null, s), null);
});

test('a moment changes its own face, comes off by its place, and a new one takes a free situation', () => {
  const v = pumpViews(state({ screens: [screen()] }))[0];
  const moments = tab(v, 'moments');
  const music = row(moments, 'pump-m-1');
  assert.deepEqual(music.label, { key: 'xmenu_sit_music' });
  const swapped = patchOf(music.options.find((o) => o.value === 'clock').act).moments;
  assert.deepEqual(swapped.map((m) => m.show.face), ['game', 'clock']);
  assert.deepEqual(patchOf(music.options.find((o) => o.value === 'off').act), { removeMoment: 1 });
  const add = row(moments, 'pump-add');
  const free = add.options.map((o) => o.value);
  assert.ok(!free.includes('game') && !free.includes('music'), 'situations in use are not offered again');
  assert.ok(!free.includes('call'), 'a call is offered only where this PC can tell one');
  assert.ok(row(tab(pumpViews(state({ screens: [screen()] }, { situationCall: true }))[0], 'moments'), 'pump-add').options.some((o) => o.value === 'call'));
  assert.deepEqual(patchOf(add.options.find((o) => o.value === 'busy').act).addMoment, { when: { any: [{ c: 'busy' }] }, show: { face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp'] } });
});

test('every face, usual or in a moment, offers its own choices: style, numbers, what a clock adds', () => {
  const v = pumpViews(state({ screens: [screen()] }))[0];
  const readings = row(tab(v, 'shows'), 'pump-readings');
  assert.equal(readings.multi, true);
  assert.deepEqual(readings.options.filter((o) => o.on).map((o) => o.value), ['cpuTemp', 'gpuTemp']);
  assert.deepEqual(readings.options.find((o) => o.value === 'fps').label, { key: 'pump_reading_fps' });
  assert.deepEqual(readings.options.find((o) => o.value === 'cpuClock').label, { key: 'pump_reading_cpu_clock' });
  assert.deepEqual(patchOf(readings.options.find((o) => o.value === 'fps').act), { base: { readings: ['cpuTemp', 'gpuTemp', 'fps'] } });
  assert.deepEqual(patchOf(readings.options.find((o) => o.value === 'gpuTemp').act), { base: { readings: ['cpuTemp'] } });
  // Four on: a fifth takes the fourth's place. One on: it stays, a face with no number is not a choice.
  const four = screen('pump', { base: { face: 'sensors', style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'cpu', 'gpu'] } });
  const full = row(tab(pumpViews(state({ screens: [four] }))[0], 'shows'), 'pump-readings');
  assert.deepEqual(patchOf(full.options.find((o) => o.value === 'ram').act).base.readings, ['cpuTemp', 'gpuTemp', 'cpu', 'ram']);
  const lone = screen('pump', { base: { face: 'sensors', style: 'rings', readings: ['cpu'] } });
  assert.equal(row(tab(pumpViews(state({ screens: [lone] }))[0], 'shows'), 'pump-readings').options.find((o) => o.value === 'cpu').act, null);
  const clock = screen('pump', { base: { face: 'clock', style: 'digital', seconds: false, date: true, weather: true } });
  const parts = row(tab(pumpViews(state({ screens: [clock] }))[0], 'shows'), 'pump-clock');
  assert.deepEqual(parts.options.map((o) => [o.value, o.on]), [['seconds', false], ['date', true], ['weather', true]]);
  assert.deepEqual(patchOf(parts.options[0].act), { base: { seconds: true } });
  assert.deepEqual(patchOf(parts.options[2].act), { base: { weather: false } });
  // A moment's face: the game moment picks its numbers, the music moment its style, and only its own moment changes.
  const moments = tab(v, 'moments');
  assert.deepEqual(row(moments, 'pump-m-0').sub, { key: 'xmenu_pump_m_sub' }, 'the line under "Game" says it is what the pump shows then');
  const gameReadings = row(moments, 'pump-m-0-readings').options;
  assert.deepEqual(gameReadings.slice(0, 4).map((o) => [o.value, o.on]), [['fps', true], ['gpuTemp', true], ['cpuTemp', true], ['cpu', false]],
    'the chosen ones first, in the order the face shows them: the first is the big one');
  const gameFps = patchOf(gameReadings.find((o) => o.value === 'fps').act).moments;
  assert.deepEqual(gameFps[0].show.readings, ['gpuTemp', 'cpuTemp']);
  assert.equal(gameFps[0].show.face, 'game');
  assert.deepEqual(gameFps[1], screen().moments[1]);
  const vinyl = patchOf(row(moments, 'pump-m-1-style').options.find((o) => o.value === 'vinyl').act).moments;
  assert.deepEqual([vinyl[1].show.face, vinyl[1].show.style], ['music', 'vinyl']);
  assert.equal(row(moments, 'pump-m-1-readings'), undefined, 'a music face reads no numbers');
});

test('a full list of moments offers no new one, and an hours moment says its hours', () => {
  const when = (c) => ({ when: { any: [{ c }] }, show: { face: 'clock' } });
  const full = screen('pump', { moments: ['game', 'music', 'live', 'recording', 'timer', 'dnd'].map(when) });
  assert.equal(row(tab(pumpViews(state({ screens: [full] }))[0], 'moments'), 'pump-add'), undefined);
  const night = screen('pump', { moments: [{ when: { any: [{ c: 'time', from: '22:00', to: '07:00' }] }, show: { face: 'clock' } }] });
  assert.deepEqual(row(tab(pumpViews(state({ screens: [night] }))[0], 'moments'), 'pump-m-0').sub, { text: '22:00 - 07:00' });
});

test('alerts and look write only their own field', () => {
  const v = pumpViews(state({ screens: [screen()] }))[0];
  const alerts = tab(v, 'alerts');
  assert.equal(row(alerts, 'pump-a-call'), undefined, 'no calls where this PC cannot tell one');
  assert.deepEqual(patchOf(row(alerts, 'pump-a-discord').acts.off), { alerts: { discord: false } });
  assert.deepEqual(patchOf(row(alerts, 'pump-secs').options[2].act), { alerts: { seconds: 15 } });
  assert.equal(row(alerts, 'pump-hide').on, true);
  const look = tab(v, 'look');
  assert.deepEqual(patchOf(row(look, 'pump-rotate').options[1].act), { look: { rotate: 90 } });
  assert.deepEqual(patchOf(row(look, 'pump-night').acts.on), { look: { night: { from: '23:00', to: '07:00', dim: 30 } } });
  assert.deepEqual(patchOf(row(look, 'pump-night').acts.off), { look: { night: null } });
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
  walk(pumpViews(state({ screens: [screen('a', { base: Model.normalizeScreen({ base: 'picture' }).base }), screen('b')] }, { situationCall: true })));
  walk(pumpViews(state({ screens: [], detected: [{ route: 'icue' }] })));
  walk(pumpViews(state({ screens: [], detected: [{ route: 'cam' }] })));
  for (const s of ['rings', 'bars', 'numbers', 'cover', 'vinyl', 'pulse', 'digital', 'analog']) keys.add('xmenu_pump_style_' + s);
  keys.add('deck_act_pumpIcue');
  for (const x of ['own', 'own_busy', 'own_bad', 'own_failed', 'art_own']) keys.add('xmenu_pump_' + x);
  assert.ok(keys.size > 40);
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
    classList: { add() {}, remove() {} },
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

// The button under the preview: the file goes to POST /pump/picture, then the pump's usual
// face becomes that picture through the same action a row runs.
function pickerRig(answer) {
  const sent = [];
  const ran = [];
  const r = rig('192.168.1.20', {
    fetch: async (url, init) => { sent.push([url, init.method, init.body.get('asset').name]); return { json: async () => answer }; },
    perform: async (_row, act) => { ran.push(act.run); return true; },
  });
  const [card] = pumpViews(state({ screens: [screen('desk')] }));
  r.body.appendChild(r.view.slot(card));
  const input = r.made.find((n) => n.tag === 'input');
  const note = r.made.find((n) => n.className === 'xm-pumpown-note');
  const pick = async (file) => { input.files = [file]; input.listeners.change(); await new Promise((d) => setTimeout(d, 10)); };
  return { ...r, sent, ran, input, note, pick };
}

test('a picture of your own goes to the pump as its usual face, from a phone too', async () => {
  const r = pickerRig({ ok: true, url: '/uploads/pump-1-ab.gif' });
  assert.equal(r.input.accept, 'image/png,image/jpeg,image/webp,image/gif,video/webm');
  assert.deepEqual(r.made.find((n) => n.tag === 'button').textContent, { key: 'xmenu_pump_own' });
  await r.pick(new File(['GIF89a'], 'cat.gif', { type: 'image/gif' }));
  assert.deepEqual(r.sent, [['http://127.0.0.1:3030/pump/picture', 'POST', 'cat.gif']]);
  assert.deepEqual(r.ran, [{ type: 'pumpSet', screen: 'desk', patch: JSON.stringify({ base: { face: 'picture', items: ['/uploads/pump-1-ab.gif'] } }) }]);
  assert.equal(r.note.textContent, '');
});

test('a file the pump cannot show is said beside the button, and nothing changes', async () => {
  const refused = pickerRig({ ok: false, error: 'bad_type' });
  await refused.pick(new File(['x'], 'tool.exe'));
  assert.deepEqual(refused.note.textContent, { key: 'xmenu_pump_own_bad' });
  assert.deepEqual(refused.ran, []);
  const big = pickerRig({ ok: true, url: '/uploads/x.gif' });
  await big.pick({ name: 'huge.gif', size: 21 * 1024 * 1024 });
  assert.deepEqual(big.sent, [], 'too big for the PC to keep: not even sent');
  assert.deepEqual(big.note.textContent, { key: 'xmenu_pump_own_bad' });
  const down = pickerRig(null);
  await down.pick(new File(['GIF89a'], 'cat.gif'));
  assert.deepEqual(down.note.textContent, { key: 'xmenu_pump_own_failed' });
  assert.deepEqual(down.ran, []);
});

test('a picture of your own lights none of the ready ones and says so', () => {
  const own = pumpViews(state({ screens: [screen('pump', { base: { face: 'picture', items: ['/uploads/pump-1-ab.gif'], every: 10, fit: 'cover' } })] }))[0];
  const art = row(tab(own, 'shows'), 'pump-art');
  assert.equal(art.value, '');
  assert.deepEqual(art.sub, { key: 'xmenu_pump_art_own' });
});

test('a Store widget made for a pump is one more face for the usual face and the moments, never for "now"', () => {
  const widgets = [{ id: 'neon-clock', name: 'Neon Clock', shapes: ['round'] }];
  const v = pumpViews(state({ screens: [screen()], widgets }))[0];
  const base = row(tab(v, 'shows'), 'pump-base');
  const pick = base.options.find((o) => o.value === 'widget:neon-clock');
  assert.deepEqual(pick.label, { text: 'Neon Clock' });
  assert.deepEqual(patchOf(pick.act), { base: { face: 'widget', id: 'neon-clock' } });
  assert.ok(!row(tab(v, 'shows'), 'pump-now').options.some((o) => o.value.startsWith('widget:')), 'a face now is a built-in one');
  const swapped = patchOf(row(tab(v, 'moments'), 'pump-m-0').options.find((o) => o.value === 'widget:neon-clock').act).moments;
  assert.deepEqual(swapped[0].show, { face: 'widget', id: 'neon-clock' });
  // On it: the row lights it, and the card and "why" say its name.
  const on = pumpViews(state({ screens: [screen('pump', { base: { face: 'widget', id: 'neon-clock' }, now: { show: { face: 'widget', id: 'neon-clock' }, why: 'base' } })], widgets }))[0];
  assert.equal(row(tab(on, 'shows'), 'pump-base').value, 'widget:neon-clock');
  assert.deepEqual(on.chip, { text: 'Neon Clock' });
  // Removed since: still listed under a plain name, so the row shows what the pump has.
  const gone = pumpViews(state({ screens: [screen('pump', { base: { face: 'widget', id: 'neon-clock' } })] }))[0];
  assert.deepEqual(row(tab(gone, 'shows'), 'pump-base').options.find((o) => o.value === 'widget:neon-clock').label, { key: 'pump_face_widget' });
  assert.deepEqual(row(tab(gone, 'shows'), 'pump-base').sub, { key: 'xmenu_pump_widget_off' }, 'the row says why the pump shows a clock');
  assert.deepEqual(row(tab(on, 'shows'), 'pump-base').sub, { key: 'xmenu_pump_base_sub' });
  // More of them: the Store opens on its widgets made for pump screens.
  const store = row(tab(v, 'shows'), 'pump-store');
  assert.deepEqual([store.kind, store.act, store.closes], ['button', { open: 'store:__pump' }, true]);
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
    const { view } = rig(host, { perform: (row, act) => ran.push(act) });
    const list = view.cards([add], null, (key) => picked.push(key));
    list.kids[0].listeners.click();
    assert.deepEqual(picked, ['pump-add'], 'the card is picked too');
    assert.equal(ran.length, expected, host);
    if (expected) assert.deepEqual(ran[0], { run: { type: 'pumpIcue' } });
  }
  const ran = [];
  const { view } = rig('127.0.0.1', { perform: (row, act) => ran.push(act) });
  view.cards(pumpViews(state({ screens: [screen()] })), null, () => {}).kids[0].listeners.click();
  assert.deepEqual(ran, [], 'a pump already on Xenon only opens its page');
});
