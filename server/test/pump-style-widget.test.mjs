// A Store widget as a pump screen's whole style (manifest pumpStyle): the model keeps
// 'widget:<id>' (js/pump/pump-faces.js), the face page hands it each line with the kind of
// moment showing it (drawnShow, face-widget.js), the widget's page tells it the line
// (pump-widget-host.js placement.line) and passes its pumpRing asks to the face page, which
// says them to the ring (face-colors.js, POST /pump/colors, pump-screen/ring.js). The menu
// offers the style beside Xenon and Strumento (menu/menu-pump-style.js) and says on each line
// who draws it (menu-pump-faces.js); Bit and xenon-mcp know the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Faces = require('../js/pump/pump-faces.js');
const Model = require('../js/pump/pump-model.js');
const Edit = require('../pump-screen/edit.js');
const { createPumpRing, cleanEffect } = require('../pump-screen/ring.js');
const { createPumpStore } = require('../pump-screen/store.js');
const { createPumpLive } = require('../pump-screen/live.js');
const { createRoutes } = require('../pump-screen/handlers.js');
const { pumpWidgets } = require('../pump-screen/widgets.js');
const { pumpViews } = require('../menu/menu-pump.js');
const { pumpOf } = require('../mcp/mcp-dev-pump.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const seen = { pump: { shape: 'round', w: 480, h: 480, via: 'icue' } };

test('a widget style is "widget:" and an id the SDK takes; anything else is not a style', () => {
  assert.equal(Faces.styleWidget('widget:neon-dial'), 'neon-dial');
  for (const bad of ['widget:', 'widget:X', 'widget:-a', 'widget:a', 'widget:../x', 'neon-dial', null, 42]) {
    assert.equal(Faces.styleWidget(bad), null, String(bad));
    assert.equal(Faces.isStyle(bad), false, String(bad));
  }
  assert.ok(Faces.isStyle('xenon') && Faces.isStyle('gauge') && Faces.isStyle('widget:neon-dial'));
  // It draws the four lines with a number or a time; a picture or a widget line stays itself.
  for (const face of Faces.GAUGED) assert.equal(Faces.drawnAs('widget:neon-dial', face), Faces.WIDGET, face);
  for (const face of ['picture', 'widget']) assert.equal(Faces.drawnAs('widget:neon-dial', face), face);
});

test('the model and a change keep the widget style, and an unknown one goes back to Xenon', () => {
  assert.equal(Model.normalizeScreen({ style: 'widget:neon-dial' }).style, 'widget:neon-dial');
  assert.equal(Model.normalizeScreen({ style: 'widget:Neon' }).style, 'xenon');
  const m = Edit.patchScreen({ seen }, 'pump', { style: 'widget:neon-dial' }).model;
  assert.equal(m.screens.pump.style, 'widget:neon-dial');
  assert.equal(Edit.patchScreen(m, 'pump', { style: 'widget:../x' }).error, 'bad_style');
  // A setup changes what the lines show, never who draws them.
  assert.equal(Model.withSetup({ style: 'widget:neon-dial' }, 'music').style, 'widget:neon-dial');
});

test('the widget is told the line and only the kind of moment showing it, never which app or hours', () => {
  const screen = { style: 'widget:neon-dial' };
  const show = { face: 'game', readings: ['fps', 'gpuTemp'] };
  assert.deepEqual(Faces.drawnShow(show, screen, 'game'), { ...show, drawn: 'widget', id: 'neon-dial', line: { face: 'game', moment: 'game' } });
  assert.deepEqual(Faces.drawnShow(show, screen, 'app:spotify.exe').line.moment, 'app');
  assert.equal(Faces.drawnShow(show, screen, 'time:22-07').line.moment, 'time');
  for (const why of ['base', 'hide:game', '', undefined, 'a'.repeat(30), 'what?']) assert.equal(Faces.momentOf(why), 'base', String(why));
  const picture = { face: 'picture', items: ['art:tide'] };
  assert.equal(Faces.drawnShow(picture, screen, 'base'), picture, 'a picture is not handed over');
  const own = { face: 'widget', id: 'cpu-ring' };
  assert.equal(Faces.drawnShow(own, screen, 'base'), own, 'a widget of its own keeps its id');
  assert.equal(Faces.drawnShow(show, { style: 'xenon' }, 'game'), show);
});

test('the ring moves as the widget asks only when it moves as the style, and never to the beat', () => {
  const show = { face: 'sensors' };
  const style = 'widget:neon-dial';
  assert.equal(Faces.ringEffect({ move: 'style' }, show, style, 'spin'), 'spin');
  assert.equal(Faces.ringEffect({ move: 'style' }, show, style, 'beat'), 'still', 'the beat reads the sound: never from a widget');
  assert.equal(Faces.ringEffect({ move: 'style' }, show, style, undefined), 'still', 'nothing asked yet: still');
  assert.equal(Faces.ringEffect({ move: 'breathe' }, show, style, 'spin'), 'breathe', 'the person chose how it moves');
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'picture' }, style, 'spin'), 'still', 'a line the widget does not draw');
  assert.equal(Faces.ringEffect({ move: 'style' }, { face: 'sensors', leds: 'spin' }, style, 'level'), 'spin', 'the line chose');
  assert.ok(['still', 'comet', 'aurora', 'level', 'clock'].every((e) => Faces.WIDGET_RING.includes(e)), 'every effect the lights draw by themselves');
  assert.ok(!Faces.WIDGET_RING.includes('beat') && !Faces.WIDGET_RING.includes('meter'), 'never one that reads the sound');
  assert.equal(cleanEffect('beat'), null);
  assert.equal(cleanEffect('meter'), null);
  assert.equal(cleanEffect('level'), 'level');
});

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-style-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  const told = [];
  const ring = createPumpRing({ store, setRing: (s) => told.push(s) });
  const live = createPumpLive({ store, broadcast: () => {}, changed: (now) => ring.refresh(now) });
  const routes = createRoutes({ store, live, ring });
  const call = async (key, body) => {
    let answer;
    await routes[key]({}, {}, { json: (v) => { answer = v; }, readBody: async () => JSON.stringify(body), sendPage: async () => {} });
    return answer;
  };
  return { store, live, told, call };
}

test('POST /pump/colors carries how the widget moves the ring, and the colours said before stay', async (t) => {
  const { store, live, told, call } = rig(t);
  await store.ready();
  await call('POST /pump/hello', { screen: 'pump', shape: 'round', w: 480, h: 480, via: 'icue' });
  await call('POST /pump', { screen: 'pump', patch: { style: 'widget:neon-dial', base: { face: 'sensors' } } });
  live.source.onFacts({});
  assert.deepEqual(await call('POST /pump/colors', { screen: 'pump', colors: ['#00e5ff'] }), { ok: true });
  assert.equal(told.at(-1).effect, 'still');
  assert.deepEqual(await call('POST /pump/colors', { screen: 'pump', effect: 'spin' }), { ok: true });
  assert.deepEqual([told.at(-1).effect, told.at(-1).colours], ['spin', ['#00e5ff']], 'the colours said before stay');
  assert.deepEqual(await call('POST /pump/colors', { screen: 'pump', effect: 'beat' }), { ok: false, error: 'bad_colors' });
  await call('POST /pump/colors', { screen: 'pump', effect: 'level', level: 0.4 });
  assert.deepEqual([told.at(-1).effect, told.at(-1).level], ['level', 0.4]);
  // Back to Xenon's own faces: what the widget asked no longer moves the ring, Xenon's readings do.
  await call('POST /pump', { screen: 'pump', patch: { style: 'xenon' } });
  assert.equal(told.at(-1).effect, 'heat');
});

// face-colors.js on a page of its own (as pump-ring-own.test.mjs).
function facePage() {
  const { document } = makeDom();
  const make = document.createElement.bind(document);
  document.createElement = (tag) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => ({}) } : make(tag));
  /** @type {any} */
  const window = { PumpFaces: Faces };
  const ctx = vm.createContext({ window, document, Intl, Number, Math, Date, Object, String, Array, JSON });
  for (const file of ['light-fx-colour', 'light-fx-calm', 'light-fx-moving', 'light-fx-pc', 'light-fx']) vm.runInContext(read(`../js/light-fx/${file}.js`), ctx);
  vm.runInContext(read('../js/pump/ring-effects.js'), ctx);
  vm.runInContext(read('../js/pump/face-kit.js'), ctx);
  window.PumpFaceKit.setWords({ locale: 'en-US' }, { lang: 'en', tempUnit: 'c' });
  vm.runInContext(read('../js/pump/face-colors.js'), ctx);
  const said = [];
  const colors = window.PumpFaceKit.get('part', 'colors')(async (list, ring) => { said.push(JSON.parse(JSON.stringify({ list, ring }))); return true; });
  return { colors, said };
}

test('the face page says what the widget asked: its move, its colours instead of the picture, its level', async () => {
  const { colors, said } = facePage();
  const face = { show: { face: 'sensors', readings: ['cpu'] }, layer: null };
  const data = { system: { cpu: 42 }, media: null };
  const own = { leds: { follow: 'own', move: 'style' }, style: 'widget:neon-dial' };
  colors.ask({ effect: 'level', colors: null, level: 0.7 });
  await colors.tick(face, own, data);
  assert.deepEqual(said.at(-1), { list: null, ring: { level: 0.7, effect: 'level' } }, 'its level, not the line\'s reading');
  colors.ask({ effect: 'level', colors: null, level: null });
  await colors.tick(face, own, data);
  assert.deepEqual(said.at(-1).ring, { level: 0.42, effect: 'level' }, 'no level: the line\'s first reading');
  colors.ask({ effect: 'spin', colors: ['#112233', '#445566'], level: null });
  await colors.tick(face, { ...own, leds: { follow: 'screen', move: 'style' } }, data);
  assert.deepEqual(said.at(-1), { list: null, ring: { colors: ['#112233', '#445566'], effect: 'spin' } }, 'its colours, no picture read');
  // Drawn by Xenon (another style): the ask is not this line's.
  const before = said.length;
  await colors.tick(face, { leds: { follow: 'own', move: 'still' }, style: 'xenon' }, data);
  assert.equal(said.length, before);
});

// The widget's page: the lines that build its placement and take its ring asks.
function hostPage(search) {
  const host = read('../js/pump/pump-widget-host.js');
  const at = host.indexOf('  const doc = document.documentElement;');
  const end = host.indexOf('  };\n', host.indexOf('window.pumpRingAsk = ')) + 5;
  const lines = `const SHAPES = ['round', 'square', 'wide'];\n${host.slice(at, end).replace(/^ {2}const (host|widgets|id) = .*$/gm, '')}`;
  const asks = [];
  const window = { PumpFaces: Faces, parent: { PumpFace: { widgetRing: (a) => asks.push(JSON.parse(JSON.stringify(a))) } } };
  vm.runInNewContext(lines, { window, document: makeDom().document, location: { search }, URLSearchParams });
  return { window, asks, placement: JSON.parse(JSON.stringify(window.pumpPlacement)) };
}

test('the widget\'s page tells it the line it draws, checked as any query', () => {
  const { placement } = hostPage('?id=neon-dial&line=game&moment=game&readings=fps,gpuTemp,bogus,fps,cpu,ram,vram');
  assert.deepEqual(placement.line, { face: 'game', moment: 'game', readings: ['fps', 'gpuTemp', 'cpu', 'ram'] }, 'known, once each, four at most');
  assert.deepEqual(hostPage('?id=x&line=clock&moment=app:spotify').placement.line, { face: 'clock', moment: 'app', readings: [] }, 'the kind of moment only');
  assert.equal(hostPage('?id=x&line=picture').placement.line, undefined, 'only the lines a style draws');
  assert.equal(hostPage('?id=x').placement.line, undefined, 'a face of its own has no line');
});

test('a pumpRing ask is checked, then handed to the face page around it', () => {
  const { window, asks } = hostPage('?id=x&line=sensors');
  window.pumpRingAsk({ effect: 'spin', colors: ['#AABBCC', 'red', '#001122', '#334455', '#667788'], level: 3 });
  assert.deepEqual(asks.at(-1), { effect: 'spin', colors: ['#aabbcc', '#001122', '#334455'], level: 1 });
  window.pumpRingAsk({ effect: 'beat' });
  window.pumpRingAsk({});
  window.pumpRingAsk(null);
  assert.equal(asks.length, 1, 'the beat or nothing usable is never said');
  window.pumpRingAsk({ level: 0.25 });
  assert.deepEqual(asks.at(-1), { effect: null, colors: null, level: 0.25 });
  // Not framed by a face page: nothing breaks.
  hostPage('?id=x').window.pumpRingAsk.call(null, { effect: 'spin' });
});

test('custom-widget passes pumpRing only to a pump\'s page, from a widget that is ready', () => {
  const src = read('../js/custom-widget/custom-widget.js');
  assert.match(src, /d\.type === 'accent' \|\| d\.type === 'pumpRing'/);
  assert.match(src, /if \(entry\.ready\) \(d\.type === 'accent' \? onBridgeAccent\(entry, grant, d\) : window\.pumpRingAsk\?\.\(d\)\)/);
  assert.equal((read('../js/pump/pump-face.js').match(/widgetRing\(ask\) \{ colors\.ask\(ask\); \}/g) || []).length, 1);
});

test('the widgets offered say which can be the style, and the menu offers those that fit the shape', () => {
  const settings = { sdkWidgets: { enabled: true, grants: { 'neon-dial': {}, 'cpu-ring': {}, 'square-one': {} } } };
  const packages = [
    { id: 'neon-dial', name: 'Neon Dial', pump: ['round'], pumpStyle: true },
    { id: 'cpu-ring', name: 'CPU Ring', pump: ['round'], pumpStyle: false },
    { id: 'square-one', name: 'Square One', pump: ['square'], pumpStyle: true },
  ];
  const widgets = pumpWidgets(packages, settings);
  assert.deepEqual(widgets.map((w) => [w.id, w.style]), [['neon-dial', true], ['cpu-ring', false], ['square-one', true]]);
  const view = (over = {}) => {
    const screen = { screen: 'pump', ...Model.screenFor({ screens: {}, seen: {} }, 'pump'), set: true, seen: seen.pump, now: null, ...over };
    return pumpViews({ probes: {}, pump: { icue: true, detected: [], url: '', screens: [screen], widgets } })[0];
  };
  const cards = (v) => v.tabs.find((t) => t.id === 'look').rows.find((r) => r.id === 'pump-style').cards;
  assert.deepEqual(cards(view()).map((c) => [c.value, c.art]), [['xenon', 'style-xenon'], ['gauge', 'style-gauge'], ['widget:neon-dial', 'style-widget']], 'round: the square one does not fit');
  assert.deepEqual(cards(view())[2].label, { text: 'Neon Dial' });
  assert.deepEqual(JSON.parse(cards(view())[2].act.run.patch), { style: 'widget:neon-dial' });
  const chosen = cards(view({ style: 'widget:neon-dial' }));
  assert.deepEqual(chosen.map((c) => c.on), [false, false, true]);
  // Removed or turned off since: still on show, saying Xenon draws the lines meanwhile.
  const gone = cards(view({ style: 'widget:old-dial' }));
  assert.deepEqual(gone.at(-1).label, { key: 'xmenu_pump_drawn_widget_gone' });
  assert.equal(gone.at(-1).on, true);
  // More styles: the Store opens on what is made for pump screens, and the menu steps aside.
  const more = view().tabs.find((t) => t.id === 'look').rows.find((r) => r.id === 'pump-style-store');
  assert.deepEqual([more.kind, more.label, more.act, more.closes], ['button', { key: 'xmenu_pump_style_more' }, { open: 'store:__pump' }, true]);
});

test('each line drawn by the style says so with the widget\'s name, and offers no face style of its own', () => {
  const widgets = [{ id: 'neon-dial', name: 'Neon Dial', shapes: ['round'], style: true }];
  const lines = (over, list = widgets) => {
    const screen = { screen: 'pump', ...Model.screenFor({ screens: {}, seen: {} }, 'pump'), set: true, seen: seen.pump, now: null, ...over };
    const [v] = pumpViews({ probes: {}, pump: { icue: true, detected: [], url: '', screens: [screen], widgets: list } });
    return v.tabs[0].rows.filter((r) => r.kind === 'pumpmoment');
  };
  const base = (ls) => ls.find((r) => r.id === 'pump-base');
  const drawn = base(lines({ style: 'widget:neon-dial' }));
  assert.ok(!drawn.rows.some((r) => r.id === 'pump-base-style'), 'the widget draws it: no face style to pick');
  assert.deepEqual(drawn.rows.find((r) => r.id === 'pump-base-drawn').label, { key: 'xmenu_pump_drawn_note_widget' });
  // Under a line with no readings (a song, the time): who draws it.
  const song = { style: 'widget:neon-dial', base: { face: 'music', style: 'cover' } };
  assert.deepEqual(base(lines(song)).sub, { text: 'Neon Dial' });
  assert.deepEqual(base(lines(song, [])).sub, { key: 'xmenu_pump_drawn_widget_gone' });
  const plain = base(lines({}));
  assert.ok(plain.rows.some((r) => r.id === 'pump-base-style'));
  assert.equal(plain.rows.find((r) => r.id === 'pump-base-drawn'), undefined);
});

test('the manifest key is cosmetic, and xenon-mcp gives a style widget the rules for its lines', () => {
  const { normalizeManifest } = require('../widget-sdk/manifest-normalize.js');
  const base = { id: 'neon-dial', name: 'Neon Dial', version: '1.0.0', api: 1, entry: 'index.html', pump: ['round'] };
  assert.equal(normalizeManifest({ ...base, pumpStyle: true }, 'neon-dial').manifest.pumpStyle, true);
  assert.equal(normalizeManifest({ ...base, pumpStyle: 'yes' }, 'neon-dial').manifest.pumpStyle, false);
  const style = pumpOf({ pump: ['round'], pumpStyle: true });
  assert.deepEqual([style.pump, style.pumpStyle], [['round'], true]);
  assert.match(style.pumpHint, /placement\.line/);
  assert.match(style.pumpHint, /pumpRing/);
  assert.doesNotMatch(pumpOf({ pump: ['round'] }).pumpHint, /pumpRing/);
  assert.match(pumpOf({ pumpStyle: true }).pumpHint, /pump/, 'a style with no pump shape is told it needs one');
  assert.deepEqual(pumpOf({}), { pump: [] });
});

test('xenon-mcp, Bit and the skill tell a style how to take the alerts, and say when the key was dropped', () => {
  const style = { pump: ['round'], pumpStyle: true };
  const kept = pumpOf({ ...style, pumpAlerts: 'dots' }, { pumpAlerts: 'dots' });
  assert.equal(kept.pumpAlerts, 'dots');
  assert.ok(kept.pumpHint.includes('"pumpAlert", kind: "notify"|"call"|"timer"|"discord"|"hot"|null'), kept.pumpHint);
  assert.doesNotMatch(kept.pumpHint, /was dropped/);
  const dropped = pumpOf(style, { pumpAlerts: 'dots', actions: ['media'] });
  assert.equal(dropped.pumpAlerts, undefined);
  assert.match(dropped.pumpHint, /"pumpAlerts" was dropped/);
  assert.match(pumpOf({}, { pumpAlerts: 'dots' }).pumpHint, /"pumpAlerts" was dropped/, 'dropped with no pump at all');
  assert.doesNotMatch(pumpOf(style).pumpHint, /was dropped/);
  const { deckCreatorAiFunctions } = require('../ai/core-tools-deck-creator.js');
  const create = deckCreatorAiFunctions().find((f) => f.name === 'create_widget').description;
  assert.match(create, /"pumpAlerts": "dots"/);
  assert.match(create, /sdk_reference section "pumpAlert"/);
  const skill = read('../../packages/mcp/skills/build-widget/SKILL.md');
  assert.match(skill, /"pumpAlerts": "dots"/);
  assert.match(skill, /never the words/);
  const sdk = read('../../docs/WIDGET_SDK.md');
  assert.ok(sdk.includes('| `pumpAlerts` | no |'), 'the manifest table has the key');
  assert.ok(sdk.includes("### 4e-sexies. The pump's alerts, your way"), 'the SDK has the message section');
  assert.ok(read('../../docs/create/index.html').includes('<code>pumpAlerts</code>'), 'the creator guide has the key');
});

test('Bit knows the style: it can make one, read which widgets can be one, and pick it', () => {
  const { deckCreatorAiFunctions } = require('../ai/core-tools-deck-creator.js');
  const create = deckCreatorAiFunctions().find((f) => f.name === 'create_widget').description;
  assert.match(create, /"pumpStyle": true and read sdk_reference sections "placement" \(placement\.line[^)]*\) and "pumpRing"/, 'create_widget says how to make a style');
  assert.match(create, /set_pump_screen \{"style":"widget:<its id>"\}/);
  const catalog = read('../js/capabilities/catalog-pump.js');
  assert.match(catalog, /"widget:<id>" = a Store widget from get_pump_screen widgets with style:true/);
  assert.match(catalog, /style true = it can also be the screen\\'s style/);
});

// A Deck key, Bit or the phone: Xenon, Gauge, or the next style, the Store ones for its shape included.
test('the style key: next goes round Xenon, Gauge and the Store styles that fit, then Xenon again', async (t) => {
  const { validateAction } = require('../js/deck/deck-actions.js');
  const { createCapabilities } = require('../capabilities/index.js');
  const { createChange } = require('../pump-screen/change.js');
  const { createPumpActions } = require('../pump-screen/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-style-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  const live = createPumpLive({ store, broadcast: () => {} });
  const widgets = async () => [
    { id: 'neon-dial', name: 'Neon Dial', shapes: ['round'], style: true },
    { id: 'cpu-ring', name: 'CPU Ring', shapes: ['round'], style: false },
    { id: 'square-one', name: 'Square One', shapes: ['square'], style: true },
  ];
  const caps = createCapabilities({ pump: createPumpActions({ store, live, change: createChange({ store, live }), widgets }) });
  const run = (action) => caps.run(validateAction(action));
  assert.deepEqual(await run({ type: 'pumpStyle', style: 'next' }), { ok: false, error: 'unknown_screen', choices: [] }, 'no pump yet');
  await store.remember((m) => Edit.noteSeen(m, 'pump', { via: 'icue', shape: 'round', w: 480, h: 480 }));
  const styles = [];
  for (let i = 0; i < 4; i++) styles.push((await run({ type: 'pumpStyle', style: 'next' })).style);
  assert.deepEqual(styles, ['gauge', 'widget:neon-dial', 'xenon', 'gauge'], 'the square one and the face-only one are not styles here');
  assert.equal(Model.screenFor(await store.ready(), 'pump').style, 'gauge');
  assert.deepEqual(await run({ type: 'pumpStyle', style: 'xenon' }), { ok: true, screen: 'pump', style: 'xenon' });
  assert.equal(validateAction({ type: 'pumpStyle', style: 'widget:neon-dial' }).style, 'next', 'a key names only the three choices');
  assert.deepEqual(await run({ type: 'pumpStyle', style: 'gauge', screen: 'desk' }), { ok: false, error: 'unknown_screen', choices: ['pump'] });
  // A style chosen before and gone since: the next one is Xenon's again.
  assert.equal(Faces.nextStyle('widget:old-dial', await widgets(), 'round'), 'xenon');
  // The phone may press it; the Deck draws it with an icon of its own.
  assert.match(read('../paired/remote-actions.js'), /'pumpFace', 'pumpSetup', 'pumpStyle', 'pumpSet', 'pumpGet',/);
  assert.match(read('../js/deck-editor/action-icons.js'), /\n\s+pumpStyle: _ai\(/);
});
