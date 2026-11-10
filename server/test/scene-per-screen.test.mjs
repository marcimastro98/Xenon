// Each screen shows its own scene (js/screen-scene-model.js plan, byScreen), chosen
// on a map of the screens in the menu's Look section. Asked for by someone with Ambient
// on the Edge only: the monitors kept the PC's own wallpaper, and the menu showed the
// Edge's Ambient as the scene "in use" everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Model = require('../js/screen-scene-model.js');
const scene = require('../capabilities/desktop-scene.js');
const { createLayersHost } = require('../layers-host.js');
const Screens = require('../js/xenon-menu-screens.js');

const DISPLAYS = [{ id: 'pg' }, { id: 'edge' }, { id: 'side' }];
const isScene = (id) => ['builtin', 'joyride', 'night'].includes(id);
const amb = (over = {}) => ({ enabled: true, sceneId: 'joyride', wallpaper: true, saverMinutes: 10, screens: [], byScreen: {}, ...over });
const planOf = (a, active = 'edge') => Model.plan({ settings: { ambientMode: a }, displays: DISPLAYS, active, noDashboard: !active });
const WHERE = { screens: DISPLAYS.map((d) => ({ key: d.id })), displays: DISPLAYS, active: 'edge' };

test('byScreen keeps only real screens with a real scene, and at most eight', () => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['s' + i, { wallpaper: 'builtin' }]));
  assert.equal(Object.keys(Model.normalizeByScreen(many, isScene)).length, 8);
  assert.deepEqual(Model.normalizeByScreen({ a: { wallpaper: 'evil<script>', saver: 'night' }, b: { wallpaper: '' }, '': { saver: 'night' } }, isScene),
    { a: { wallpaper: '', saver: 'night' } }, 'an unknown id is dropped, an empty screen is not kept');
  for (const bad of [null, 'x', [], 5]) assert.deepEqual(Model.normalizeByScreen(bad, isScene), {});
});

test('the plan: one scene on the screens without the dashboard until a screen has its own', () => {
  assert.deepEqual(planOf(amb()).map((r) => [r.key, r.dashboard, r.wallpaper]), [['pg', false, 'joyride'], ['edge', true, ''], ['side', false, 'joyride']]);
  const own = planOf(amb({ byScreen: { side: { wallpaper: 'night', saver: '' } } }));
  assert.deepEqual(own.map((r) => r.wallpaper), ['', '', 'night'], 'from the first screen of its own, each screen says for itself');
  assert.deepEqual(own.map((r) => r.saver), ['joyride', '', 'joyride'], 'the screensaver keeps the one scene until it has its own too');
  const alone = Model.plan({ settings: { ambientMode: amb({ byScreen: { pg: { wallpaper: 'night', saver: '' } } }) }, displays: [{ id: 'pg' }], active: 'pg' });
  assert.equal(alone[0].wallpaper, 'night', 'the only screen has the dashboard and a wallpaper behind it');
});

test('the scene page reads its own screen, the dashboard its Ambient', () => {
  const settings = { ambientMode: amb({ byScreen: { side: { wallpaper: 'night', saver: '' } } }) };
  assert.equal(Model.sceneFor(settings, 'wallpaper', 'side'), 'night');
  assert.equal(Model.sceneFor(settings, 'wallpaper', 'pg'), 'joyride', 'a screen with nothing of its own has no window; the fallback never shows');
  assert.equal(Model.sceneFor(settings, 'saver', 'side'), 'joyride');
  assert.equal(Model.sceneFor(settings, 'ambient', 'side'), 'joyride');
});

test('windows open only where a screen shows something, and the switches still rule them', () => {
  const a = amb({ byScreen: { side: { wallpaper: 'night', saver: '' } } });
  const keys = (ambientMode, status = {}) => Model.surfaces({ settings: { ambientMode }, displays: DISPLAYS, active: 'edge', status }).map((s) => s.key);
  assert.deepEqual(keys(a), ['wallpaper:side']);
  assert.deepEqual(keys({ ...a, wallpaper: false }), [], 'the wallpaper switch pauses every screen');
  assert.deepEqual(keys({ ...a, enabled: false }), []);
});

test('a pick on one screen keeps what the others show and turns the wallpaper on', () => {
  const next = scene.applyPatch(amb({ wallpaper: true }), { screen: { key: 'pg', kind: 'wallpaper', scene: 'night' }, where: WHERE });
  assert.deepEqual(next.byScreen.pg.wallpaper, 'night');
  assert.deepEqual(next.byScreen.side.wallpaper, 'joyride', 'what side showed stays');
  const paused = scene.applyPatch(amb({ wallpaper: false }), { screen: { key: 'pg', kind: 'wallpaper', scene: 'night' }, where: WHERE });
  assert.equal(paused.wallpaper, true);
  assert.equal(paused.byScreen.side.wallpaper, '', 'a paused wallpaper was the PC\'s own there, and stays so');
  const off = scene.applyPatch(amb({ wallpaper: true, byScreen: { pg: { wallpaper: 'night', saver: '' } } }), { screen: { key: 'pg', kind: 'wallpaper', scene: '' }, where: WHERE });
  assert.equal(off.wallpaper, false, 'none left: the wallpaper is off');
  assert.equal(off.byScreen.pg.wallpaper, '');
});

test('a screensaver picked where none ran starts after ten minutes, the last one off sets never', () => {
  const first = scene.applyPatch(amb({ saverMinutes: 0 }), { screen: { key: 'side', kind: 'saver', scene: 'night' }, where: WHERE });
  assert.equal(first.saverMinutes, 10);
  assert.equal(first.byScreen.side.saver, 'night');
  assert.equal(first.byScreen.pg.saver, '', 'never before: still none on the others');
  const kept = scene.applyPatch(amb({ saverMinutes: 30 }), { screen: { key: 'side', kind: 'saver', scene: 'night' }, where: WHERE });
  assert.equal(kept.saverMinutes, 30, 'a delay already chosen stays');
  const none = scene.applyPatch(first, { screen: { key: 'side', kind: 'saver', scene: '' }, where: WHERE });
  assert.equal(none.saverMinutes, 0);
});

test('a scene for every screen changes only the screens that show one, and turns nothing on', () => {
  const a = amb({ wallpaper: false, byScreen: { side: { wallpaper: 'builtin', saver: '' } } });
  const next = scene.applyPatch(a, { everywhere: { id: 'night', kinds: ['wallpaper'] }, where: WHERE });
  assert.equal(next.byScreen.side.wallpaper, 'night');
  assert.equal(next.byScreen.pg.wallpaper, '');
  assert.equal(next.wallpaper, false);
  const none = scene.applyPatch(amb(), { everywhere: { id: '', kinds: ['wallpaper', 'saver'] }, where: WHERE });
  assert.deepEqual([none.wallpaper, none.saverMinutes, none.sceneId], [false, 0, 'joyride'], 'no scene on the screens; the Ambient stays');
});

test('Bit and the menu: a screen by number, what it is for, none for the PC\'s own wallpaper', async () => {
  const calls = [];
  const d = {
    host: { scenes: () => true, monitors: () => [{ key: 'edge' }, { key: 'pg', primary: true }, { key: 'side' }], dashboard: () => 'edge' },
    settings: { setDesktopScene: async (p) => { calls.push(p); return {}; }, desktopScenes: async () => ({ packages: [{ id: 'joyride', name: 'Joyride Scene' }] }) },
  };
  assert.deepEqual(await scene.setScene(d, { scene: 'joyride', screen: '3', for: 'wallpaper' }), { ok: true, scene: 'Joyride Scene' });
  assert.deepEqual(calls.at(-1).screen, { key: 'side', kind: 'wallpaper', scene: 'joyride' }, 'numbered as the menu lists them, the main one first');
  assert.deepEqual(await scene.setScene(d, { scene: 'none', screen: '3' }), { ok: true, scene: 'none' });
  assert.deepEqual(calls.at(-1).screen, { key: 'side', kind: 'wallpaper', scene: '' });
  await scene.setScene(d, { scene: 'Joyride Scene', screen: '2' });
  assert.deepEqual(calls.at(-1), { sceneId: 'joyride' }, 'the dashboard\'s screen: its Ambient');
  await scene.setScene(d, { scene: 'joyride', for: 'ambient' });
  assert.deepEqual(calls.at(-1), { sceneId: 'joyride' });
  const n = calls.length;
  assert.equal((await scene.setScene(d, { scene: 'joyride', screen: '9' })).error, 'bad_screen');
  assert.equal((await scene.setScene(d, { scene: 'joyride', for: 'desk' })).error, 'bad_for');
  assert.equal((await scene.setScene(d, { scene: 'none', for: 'ambient' })).error, 'needs_scene', 'the dashboard always has an Ambient');
  assert.equal(calls.length, n, 'nothing written for a refused request');
});

test('every scene in use that waits for approval is named, each screen\'s own too', () => {
  const hs = { ambientMode: { sceneId: 'builtin', byScreen: { side: { wallpaper: 'joyride', saver: '' } } }, sdkWidgets: { enabled: true, grants: {} } };
  assert.deepEqual(scene.scenesWaiting(hs, [{ id: 'joyride' }]), ['joyride']);
  assert.deepEqual(scene.scenesWaiting({ ...hs, sdkWidgets: { enabled: true, grants: { joyride: {} } } }, [{ id: 'joyride' }]), []);
});

test('the shell tells the server which screen has the dashboard, only a screen it reported', () => {
  const h = createLayersHost();
  h.accept({ layers: true, scene: true, monitors: [{ key: 'pg', primary: true }, { key: 'edge' }], dashboard: 'edge' });
  assert.equal(h.dashboard(), 'edge');
  h.accept({ layers: true, scene: true, monitors: [{ key: 'pg', primary: true }], dashboard: 'edge' });
  assert.equal(h.dashboard(), '', 'a screen that is gone is no answer');
  h.accept({ layers: true, scene: true, monitors: [{ key: 'pg', primary: true }] });
  assert.equal(h.dashboard(), '', 'the "widgets only" driver names none');
});

test("the map in the menu: a tap shows that screen's tabs, a tab its rows, and the focus stays", () => {
  const { document } = makeDom();
  globalThis.CSS = globalThis.CSS || { escape: (s) => s };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const button = (cls) => el('button', cls);
  const drawn = [];
  const plain = (r) => { drawn.push(r.id); return el('li', 'row', r.id); };
  const DRAW = { choice: plain, button: plain };
  let held = 0;
  const { draw } = Screens.create({ el, button, say: (v) => (v && v.text) || (v && v.key) || '', DRAW, rowShell: () => el('li'), perform: () => {}, icon: () => null, hold: () => { held++; }, settle: () => {} });
  const tab = (id, ids) => ({ id, label: { key: id }, value: { text: id + ' now' }, rows: ids.map((x) => ({ kind: 'choice', id: x })) });
  const view = (key, primary, tabs) => ({ key, label: { text: key }, width: 1920, height: 1080, x: primary ? 0 : 1920, y: 0, says: [{ label: { key: 'l' }, value: { text: 'v' } }], tabs });
  const li = draw({ kind: 'screens', sub: { key: 'hint' }, screens: [view('pg', true, [tab('wall', ['wall-1']), tab('saver', ['saver', 'saver-1'])]), view('edge', false, [tab('ambient', ['ambient-2']), tab('dash', ['dashBg-2'])])] });
  const picks = li.querySelectorAll('.xm-scrpick');
  assert.equal(picks.length, 2);
  assert.deepEqual(picks.map((b) => b.getAttribute('aria-pressed')), ['true', 'false'], 'the first screen is shown first');
  assert.deepEqual(li.querySelectorAll('.xm-wtab').map((b) => b.getAttribute('aria-selected')), ['true', 'false'], 'its first tab open');
  assert.deepEqual(drawn, ['wall-1']);
  li.querySelector('[data-keep="screen:pg:saver"]').click();
  assert.deepEqual(drawn.slice(1), ['saver', 'saver-1'], 'a tab draws only its own rows');
  li.querySelectorAll('.xm-scrpick')[1].click();
  assert.deepEqual(drawn.slice(3), ['ambient-2']);
  assert.equal(held, 2, 'the moving preview waits aside while the block is redrawn');
  const again = li.querySelectorAll('.xm-scrpick');
  assert.deepEqual(again.map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(document.activeElement, again[1]);
  again[0].click();
  assert.equal(drawn.at(-2), 'saver', 'the tab left open on a screen is open again');
});

test('a scene list in the menu: a tick on the one in use, the preview in the screen, more scenes at the end', () => {
  const { document } = makeDom();
  globalThis.CSS = globalThis.CSS || { escape: (s) => s };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const button = (cls) => el('button', cls);
  const done = [];
  const followed = [];
  const box = el('div', 'xm-scene-view');
  const slot = () => ({ box, follow: (b, id) => followed.push(id) });
  const DRAW = { button: (r) => el('li', 'more-row', r.id) };
  const { draw } = Screens.create({ el, button, say: (v) => (v && v.text) || (v && v.key) || '', DRAW, rowShell: () => el('li'), perform: (r, act) => done.push(act), icon: () => null, slot });
  const options = [{ value: '', label: { key: 'own' }, act: 'none' }, { value: 'joyride', label: { text: 'Joyride' }, act: 'joy' }];
  const wall = { kind: 'choice', id: 'wall-1', scenes: true, live: true, value: 'joyride', label: { key: 'w' }, options };
  const li = draw({ kind: 'screens', more: { kind: 'button', id: 'moreScenes', label: { key: 'more' } }, screens: [{ key: 'pg', label: { text: 'pg' }, width: 1920, height: 1080, x: 0, y: 0, tabs: [{ id: 'wall', label: { key: 'w' }, value: { text: 'Joyride' }, rows: [wall] }] }] });
  const opts = li.querySelectorAll('.xm-sceneopt').filter((b) => !b.className.includes('--more'));
  assert.deepEqual(opts.map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
  assert.deepEqual(followed, ['', 'joyride'], 'passing over a line plays it');
  assert.equal(li.querySelector('.xm-scrpick').querySelector('.xm-scene-view'), box, 'the preview plays inside the screen tapped');
  opts[1].click();
  opts[0].click();
  assert.deepEqual(done, ['none'], 'the one in use is not sent again');
  assert.equal(li.querySelector('.more-row'), null);
  li.querySelector('.xm-sceneopt--more').click();
  assert.ok(li.querySelector('.more-row'), 'more scenes opens where they would go');
});
