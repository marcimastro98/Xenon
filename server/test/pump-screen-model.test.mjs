// Pump screens: the faces and their choices (js/pump/pump-faces.js), the screens'
// model and setups (js/pump/pump-model.js), the changes (pump-screen/edit.js) and
// which face shows now (pump-screen/moments.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Faces = require('../js/pump/pump-faces.js');
const Model = require('../js/pump/pump-model.js');
const Edit = require('../pump-screen/edit.js');
const { faceNow, rulesOf } = require('../pump-screen/moments.js');
const W = require('../js/layers/layer-when.js');

test('a face keeps only choices it knows, and an unknown face is no face', () => {
  assert.equal(Faces.normalizeFace({ face: 'tv' }), null);
  assert.equal(Faces.normalizeFace(null), null);
  assert.deepEqual(Faces.normalizeFace('music'), { face: 'music', style: 'cover' });
  const s = Faces.normalizeFace({ face: 'sensors', style: 'swirl', readings: ['gpuTemp', 'bogus', 'gpuTemp', 'cpu', 'ram', 'fps', 'vram'] });
  assert.deepEqual(s, { face: 'sensors', style: 'rings', readings: ['gpuTemp', 'cpu', 'ram', 'fps'] });
  assert.deepEqual(Faces.normalizeFace({ face: 'clock', seconds: 'yes', weather: false }),
    { face: 'clock', style: 'digital', seconds: false, date: true, weather: false });
});

test('a picture is an upload of ours or a moving picture the page draws, never another host', () => {
  assert.equal(Faces.isPicture('/uploads/cat.gif'), true);
  assert.equal(Faces.isPicture('art:aurora'), true);
  for (const bad of ['/uploads/..', '/uploads/.env', '/uploads/a/b.gif', 'https://example.com/a.gif', 'art:nope', '/pump-face', 42]) {
    assert.equal(Faces.isPicture(bad), false, String(bad));
  }
  const p = Faces.normalizeFace({ face: 'picture', items: ['https://example.com/a.gif'], every: 7, fit: 'stretch' });
  assert.deepEqual(p, { face: 'picture', items: ['art:aurora'], every: 10, fit: 'cover' });
});

test('the same face keeps its choices when one changes; another face starts fresh', () => {
  const cur = Faces.normalizeFace({ face: 'clock', style: 'analog', seconds: true });
  assert.deepEqual(Faces.mergeFace(cur, { weather: false }), { face: 'clock', style: 'analog', seconds: true, date: true, weather: false });
  assert.deepEqual(Faces.mergeFace(cur, { face: 'music' }), { face: 'music', style: 'cover' });
  assert.deepEqual(Faces.mergeFace(cur, 'game'), Faces.defaultFace('game'));
});

test('a screen id is a short slug of the name typed in iCUE', () => {
  assert.equal(Model.screenId('Pump 2'), 'pump-2');
  assert.equal(Model.screenId('  Kraken!! '), 'kraken');
  assert.equal(Model.screenId(''), '');
  assert.equal(Model.screenId('-x'), 'x', 'a leading dash goes, as the iCUE widget drops it');
  assert.equal(Model.screenId('---'), '');
  assert.equal(Model.screenId('a'.repeat(40)).length, 24);
});

test('the model drops what it does not know and caps the screens', () => {
  const screens = {};
  for (let i = 0; i < 12; i += 1) screens['s' + i] = { base: { face: 'clock' } };
  const m = Model.normalize({ screens: { ...screens, 'BAD ID': {} }, seen: { pump: { shape: 'hex', w: 5, via: 'usb' } }, extra: 1 });
  assert.equal(Object.keys(m.screens).length, Model.MAX_SCREENS);
  assert.equal(m.screens['BAD ID'], undefined);
  assert.deepEqual(m.seen.pump, { shape: 'round', w: 480, h: 480, via: 'browser' });
  assert.equal(m.extra, undefined);
  assert.equal(m.v, 1);
});

test('a screen keeps sound defaults: alerts on, text hidden, lights follow the screen', () => {
  const s = Model.normalizeScreen({});
  assert.deepEqual(s.alerts, { notify: true, call: true, timer: true, discord: true, hot: true, seconds: 8, hideText: true });
  assert.deepEqual(s.leds, { follow: 'screen', all: false, move: 'style', colors: ['#00e5ff', '#ff2e88'], speed: 'normal', reverse: false, size: null, glow: null, palette: null });
  assert.deepEqual(s.look, { rotate: 0, dim: 100, night: null, fade: true });
  assert.equal(s.base.face, 'sensors');
  const night = Model.normalizeScreen({ look: { night: { from: '23:00', to: '07:00', dim: 2 }, rotate: 45, dim: 500 } }).look;
  assert.deepEqual(night, { rotate: 0, dim: 100, night: { from: '23:00', to: '07:00', dim: 30 }, fade: true });
});

test('moments: no hide rules, no duplicates, at most six', () => {
  const many = ['game', 'music', 'call', 'live', 'timer', 'idle', 'busy', 'dnd'].map((c) => ({ when: { any: [{ c }] }, show: { face: 'clock' } }));
  const s = Model.normalizeScreen({ moments: [{ when: { hide: true, any: [{ c: 'game' }] }, show: 'clock' }, ...many, many[0]] });
  assert.equal(s.moments.length, Model.MAX_MOMENTS);
  assert.ok(s.moments.every((m) => !m.when.hide));
  assert.equal(Model.normalizeMoment({ when: { any: [{ c: 'game' }] }, show: 'tv' }), null);
});

test('a new moment takes its place: a call before a game, a game before music, hours last', () => {
  const m = (c) => Model.normalizeMoment({ when: W.parse(c), show: 'clock' });
  let list = [m('music'), m('time:22:00-23:00')];
  list = Model.insertMoment(list, m('game'));
  list = Model.insertMoment(list, m('call'));
  assert.deepEqual(list.map((x) => W.format(x.when)), ['call', 'game', 'music', 'time:22:00-23:00']);
});

test('every setup is complete and a setup keeps the mounting, name and alerts', () => {
  for (const name of Model.SETUP_NAMES) {
    const s = Model.withSetup(null, name);
    assert.ok(Faces.FACES.includes(s.base.face), name);
    assert.ok(s.moments.some((x) => W.format(x.when) === 'game'), name + ' shows the game face while playing');
  }
  const before = Model.normalizeScreen({ name: 'Desk pump', look: { rotate: 90 }, alerts: { call: false } });
  const after = Model.withSetup(before, 'clock');
  assert.equal(after.name, 'Desk pump');
  assert.equal(after.look.rotate, 90);
  assert.equal(after.alerts.call, false);
  assert.equal(after.base.style, 'analog');
  assert.equal(Model.withSetup(before, 'nope'), null);
});

test('a screen nobody set up shows the default setup', () => {
  assert.deepEqual(Model.screenFor({}, 'pump'), Model.withSetup(null, Model.DEFAULT_SETUP));
});

test('patch: a setup is how a screen starts; any other change needs a screen we know', () => {
  assert.equal(Edit.patchScreen({}, 'pump', { base: 'clock' }).error, 'unknown_screen');
  const set = Edit.patchScreen({}, 'Pump', { setup: 'music' });
  assert.equal(set.model.screens.pump.base.face, 'clock');
  assert.equal(Edit.patchScreen({}, 'pump', { setup: 'disco' }).error, 'bad_setup');
  assert.equal(Edit.patchScreen({}, '!!', { setup: 'music' }).error, 'bad_screen');
  const seen = Model.normalize({ seen: { pump: {} } });
  assert.equal(Edit.patchScreen(seen, 'pump', { base: { face: 'clock', style: 'analog' } }).model.screens.pump.base.style, 'analog');
});

test('patch: base, moments added and removed, parts merged, bad values refused', () => {
  let m = Edit.patchScreen({}, 'pump', { setup: 'game' }).model;
  m = Edit.patchScreen(m, 'pump', { base: { readings: ['fps'] }, alerts: { seconds: 15 }, look: { rotate: 180 }, name: 'Kraken' }).model;
  const s = m.screens.pump;
  assert.deepEqual(s.base.readings, ['fps']);
  assert.equal(s.base.style, 'rings');
  assert.equal(s.alerts.seconds, 15);
  assert.equal(s.alerts.hideText, true);
  assert.equal(s.look.rotate, 180);
  assert.equal(s.name, 'Kraken');
  m = Edit.patchScreen(m, 'pump', { addMoment: { when: { any: [{ c: 'call' }] }, show: 'clock' } }).model;
  assert.equal(W.format(m.screens.pump.moments[0].when), 'call');
  m = Edit.patchScreen(m, 'pump', { removeMoment: 0 }).model;
  assert.equal(W.format(m.screens.pump.moments[0].when), 'game');
  assert.equal(Edit.patchScreen(m, 'pump', { removeMoment: 9 }).error, 'bad_moment');
  assert.equal(Edit.patchScreen(m, 'pump', { addMoment: { when: { any: [{ c: 'game' }] }, show: 'tv' } }).error, 'bad_moment');
  assert.equal(Edit.patchScreen(m, 'pump', { base: { face: 'tv' } }).error, 'bad_face');
});

test('patch: a ninth screen is refused, never dropped in silence', () => {
  let m = {};
  for (let i = 0; i < Model.MAX_SCREENS; i += 1) m = Edit.patchScreen(m, 's' + i, { setup: 'clock' }).model;
  assert.equal(Edit.patchScreen(m, 'one-more', { setup: 'clock' }).error, 'too_many_screens');
  assert.ok(Edit.patchScreen(m, 's0', { setup: 'game' }).model);
});

test('forget takes the screen and its record away; a hello writes only what changed', () => {
  const m = Edit.patchScreen(Model.normalize({ seen: { pump: {} } }), 'pump', { setup: 'clock' }).model;
  const gone = Edit.forgetScreen(m, 'pump').model;
  assert.deepEqual([gone.screens, gone.seen], [{}, {}]);
  assert.equal(Edit.forgetScreen(gone, 'pump').error, 'unknown_screen');
  const hello = Edit.noteSeen({}, 'Pump', { shape: 'round', w: 480, h: 480, via: 'icue' });
  assert.deepEqual(hello.model.seen.pump, { shape: 'round', w: 480, h: 480, via: 'icue' });
  assert.equal(Edit.noteSeen(hello.model, 'pump', { shape: 'round', w: 480, h: 480, via: 'icue' }), null);
  assert.equal(Edit.noteSeen({}, '', {}), null);
});

test('the face now: pinned, then screens off, then the first moment, then the base', () => {
  const screen = Model.withSetup(null, 'game');
  assert.equal(faceNow(screen, {}).show.face, 'sensors');
  assert.equal(faceNow(screen, {}).why, 'base');
  assert.deepEqual([faceNow(screen, { game: true, music: true }).show.face, faceNow(screen, { game: true, music: true }).why], ['game', 'game']);
  assert.equal(faceNow(screen, { music: true }).show.face, 'music');
  const quiet = faceNow(screen, { game: true }, { quiet: true });
  assert.deepEqual([quiet.show.face, quiet.show.weather, quiet.why], ['clock', false, 'screensOff']);
  const picture = Model.withSetup(null, 'picture');
  assert.equal(faceNow(picture, {}, { quiet: true }).show.face, 'picture');
  const pinned = { show: { face: 'music', style: 'vinyl' }, until: 2000 };
  assert.equal(faceNow(screen, { game: true }, { pinned, quiet: true, now: 1000 }).why, 'pinned');
  assert.equal(faceNow(screen, { game: true }, { pinned, now: 3000 }).why, 'game');
});

test('the rules of every known screen reach the situations engine, set up or not', () => {
  const m = Model.normalize({ screens: { a: Model.withSetup(null, 'clock') }, seen: { b: {} } });
  const rules = rulesOf(m).map(W.format).sort();
  assert.deepEqual(rules, ['game', 'game', 'music']);
});
