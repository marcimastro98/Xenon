// Edit mode of a layer window (js/layer-edit.js and js/layer-edit-card.js): the drag, the
// corner, the widget's own choices and "Done" become capability runs; the page saves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const SRC = readFileSync(new URL('../js/layer-edit.js', import.meta.url), 'utf8');
const CARD = readFileSync(new URL('../js/layer-edit-card.js', import.meta.url), 'utf8');
const LayerDrag = require('../js/layer-drag.js');
const LayerSee = require('../js/layer-see.js');
const LayersModel = require('../js/layers-model.js');

const rectOf = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height });

function boot({ surface = 'desktop', reply = { ok: true }, grouped = false, answer, layerKey } = {}) {
  const { document } = makeDom();
  // The page's own nodes need contains() for the cross check; mini-dom has none.
  const make = document.createElement;
  document.createElement = (t) => {
    const n = make(t);
    n.contains = (o) => { for (let p = o; p; p = p.parentNode) if (p === n) return true; return false; };
    return n;
  };
  document.head = document.createElement('head');
  document.documentElement.appendChild(document.head);
  const root = document.createElement('div');
  root.getBoundingClientRect = rectOf(0, 0, 1000, 500);
  document.body.appendChild(root);
  const slot = (left, top) => {
    const s = document.createElement('div');
    s.className = 'layer-slot';
    s.getBoundingClientRect = rectOf(left, top, 200, 100);
    root.appendChild(s);
    return s;
  };
  const a = slot(0, 0);
  const b = slot(600, 300);
  const tile = (id, widget) => ({ id, kind: 'tile', widget, surface: 'desktop', show: 'always', rect: { x: 0, y: 0, w: 0.2, h: 0.2 } });
  const membersA = grouped ? [tile('lw_a1', 'weather'), tile('lw_a2', 'media')] : [tile('lw_a1', 'weather')];
  const boxes = [
    { key: 'A', slot: a, box: { lead: membersA[0], members: membersA }, shown: membersA.at(-1).id },
    { key: 'B', slot: b, box: { lead: tile('lw_b1', 'clock'), members: [tile('lw_b1', 'clock')] }, shown: 'lw_b1' },
  ];
  const runs = [];
  const placed = { n: 0 };
  const rects = { n: 0 };
  const leans = [];
  const whole = [];
  const api = {
    root: () => root,
    surface,
    monitor: surface === 'anchor' ? '' : 'DISPLAY2',
    boxes: () => boxes.slice(),
    place: () => { placed.n++; },
    lean: (slot, rect) => { leans.push({ ...rect }); },
    refreshRects: () => { rects.n++; },
    wholeWindow: (on) => { whole.push(on); },
    run: async (action) => { runs.push({ ...action }); return answer ? answer(action) : reply; },
  };
  const ctx = {
    window: { LayerKey: layerKey, LayerDrag, LayerSee, LayersModel }, document, Math, Array, WeakMap, Map, Object, String,
    setTimeout, clearTimeout, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  vm.createContext(ctx);
  vm.runInContext(CARD, ctx);
  vm.runInContext(SRC, ctx);
  const edit = ctx.window.LayerEdit;
  edit.start(api);
  runs.length = 0;   // start asks layerList whether attaching exists; tests count what follows
  const frameOf = (s) => s.children.find(n => n.className.includes('layer-edit-frame'));
  return { document, root, a, b, edit, runs, placed, frameOf, leans, whole, rects, boxes };
}

const fire = (node, type, ev = {}) => (node._handlers[type] || []).forEach(fn => fn({
  type, button: 0, pointerId: 1, target: node, preventDefault() {}, stopPropagation() {}, ...ev,
}));
const settle = () => new Promise(r => setImmediate(r));

test('on start: the page is marked, a bar says what to do, every box gets a frame', () => {
  const { document, root, a, b, frameOf } = boot();
  assert.equal(document.documentElement.dataset.layerEditing, 'true');
  const bar = root.children.find(n => n.className === 'layer-edit-bar');
  assert.ok(bar);
  assert.match(bar.children[0].textContent, /Drag/);
  for (const s of [a, b]) {
    const frame = frameOf(s);
    assert.ok(frame.querySelector('.layer-edit-tag'));
    assert.ok(frame.querySelector('.layer-edit-resize'));
    assert.equal(frame.querySelector('.layer-edit-remove'), null, 'no loose icons: the choices have words');
    assert.equal(frame.querySelector('.layer-edit-attach'), null);
  }
});

test('a small box has no corner to grab: it was taken for a button and grew the widget', () => {
  const { a, b, edit, frameOf } = boot();
  Object.assign(a, { offsetWidth: 120, offsetHeight: 120 });
  Object.assign(b, { offsetWidth: 320, offsetHeight: 240 });
  edit.refresh();
  assert.ok(frameOf(a).classList.contains('is-small'));
  assert.ok(!frameOf(b).classList.contains('is-small'));
});

test('each frame says when its widget shows', () => {
  const { a, frameOf } = boot();
  assert.equal(frameOf(a).querySelector('.layer-edit-tag').textContent, 'see_desktop');
});

test('"Done" ends the mode through the server', async () => {
  const { root, runs } = boot();
  root.children.find(n => n.className === 'layer-edit-bar').querySelector('.layer-edit-done').click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layersEdit', mode: 'off' }]);
});

test('a drag follows the pointer, keeps the size and saves what was drawn', async () => {
  const { a, runs, frameOf, leans, whole } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  assert.ok(frame.classList.contains('is-dragging'));
  fire(frame, 'pointermove', { clientX: 373, clientY: 183 });
  assert.equal(a.style._props['--layer-x'], '27.3%', 'drawn where it goes while dragging, no grid');
  assert.equal(a.style._props['--layer-w'], '20%');
  assert.deepEqual(leans.at(-1), { x: 0.273, y: 0.266, w: 0.2, h: 0.2 }, 'words lean now, not after the drop');
  assert.deepEqual(whole, [true], 'the window takes the drag');
  fire(frame, 'pointerup');
  await settle();
  assert.ok(!frame.classList.contains('is-dragging'));
  assert.deepEqual(whole, [true, false]);
  assert.deepEqual(runs, [{ type: 'layerMove', target: 'lw_a1', position: 'keep', size: 'keep', rect: '0.273,0.266,0.2,0.2' }]);
});

test('an edge close to another box or the screen edge pulls it, and a line shows why', async () => {
  const { a, root, runs, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  // Right edge lands 6 px short of B's left edge (600): it meets it.
  fire(frame, 'pointermove', { clientX: 494, clientY: 52 });
  assert.equal(root.querySelectorAll('.layer-edit-guide').length, 2);
  fire(frame, 'pointerup');
  assert.equal(root.querySelectorAll('.layer-edit-guide').length, 0);
  await settle();
  assert.equal(runs[0].rect, '0.4,0,0.2,0.2');
});

test('dragged past the top it reaches the true edge and stays there', async () => {
  const { b, runs, frameOf } = boot();
  const frame = frameOf(b);
  fire(frame, 'pointerdown', { clientX: 700, clientY: 350 });
  fire(frame, 'pointermove', { clientX: 620, clientY: -40 });
  fire(frame, 'pointerup');
  await settle();
  assert.equal(runs[0].rect, '0.52,0,0.2,0.2');
});

test('a tap saves nothing and opens the widget\'s choices, a second tap closes them', async () => {
  const { a, root, runs, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  fire(frame, 'pointermove', { clientX: 102, clientY: 51 });
  fire(frame, 'pointerup');
  await settle();
  assert.deepEqual(runs, []);
  assert.ok(frame.classList.contains('is-picked'));
  assert.ok(root.querySelector('.layer-edit-card'));
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  fire(frame, 'pointerup');
  assert.equal(root.querySelector('.layer-edit-card'), null);
});

test('a cancelled press picks nothing', () => {
  const { a, root, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  fire(frame, 'pointercancel', { type: 'pointercancel' });
  assert.equal(root.querySelector('.layer-edit-card'), null);
});

test('passing over another box and letting go is a move, never tabs', async () => {
  const { a, runs, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  fire(frame, 'pointermove', { clientX: 650, clientY: 350 });
  fire(frame, 'pointerup');
  await settle();
  assert.deepEqual(runs.map(r => r.type), ['layerMove']);
});

test('the corner resizes from the top-left that stays put', async () => {
  const { a, runs, frameOf } = boot();
  const frame = frameOf(a);
  const grip = frame.querySelector('.layer-edit-resize');
  fire(frame, 'pointerdown', { clientX: 195, clientY: 95, target: grip });
  fire(frame, 'pointermove', { clientX: 292, clientY: 148 });
  fire(frame, 'pointerup');
  await settle();
  assert.equal(runs[0].type, 'layerMove');
  assert.equal(runs[0].rect, '0,0,0.297,0.306');
});

// ── The widget's own choices ──
const tap = (frame) => { fire(frame, 'pointerdown', { clientX: 1, clientY: 1 }); fire(frame, 'pointerup'); };
const buttons = (root) => root.querySelector('.layer-edit-card').querySelectorAll('button');
const named = (root, text) => buttons(root).find((n) => n.textContent.startsWith(text));

test('"Remove" takes the shown widget off the screen', async () => {
  const { a, root, runs, frameOf } = boot({ grouped: true });
  tap(frameOf(a));
  named(root, 'Remove').click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerRemove', target: 'lw_a2' }]);
});

test('a size by name keeps the widget where it is', async () => {
  const { a, root, runs, frameOf } = boot();
  tap(frameOf(a));
  named(root, 'L').click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerMove', target: 'lw_a1', size: 'large', position: 'keep' }]);
});

test('"When" offers the answers and writes the one picked', async () => {
  const { a, root, runs, frameOf } = boot();
  tap(frameOf(a));
  named(root, 'When:').click();
  named(root, 'game').click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerMove', target: 'lw_a1', surface: 'overlay', show: 'gaming' }]);
});

test('tabs come only from the button, and every tab of the box joins, the shown one last', async () => {
  const { a, root, runs, frameOf } = boot({ grouped: true });
  tap(frameOf(a));
  named(root, 'Tabs').click();
  named(root, 'clock').click();
  await settle();
  assert.deepEqual(runs, [
    { type: 'layerGroup', widget: 'lw_a1', with: 'lw_b1', mode: 'join' },
    { type: 'layerGroup', widget: 'lw_a2', with: 'lw_b1', mode: 'join' },
  ]);
});

test('a name from the Store is shown as text', () => {
  const { a, root, frameOf, boxes } = boot();
  Object.assign(boxes[0].box.lead, { kind: 'sdk', pkg: '<i>Plate</i>' });
  tap(frameOf(a));
  const name = root.querySelector('.layer-edit-card').querySelector('b');
  assert.equal(name.textContent, '<i>Plate</i>');
  assert.equal(name.innerHTML, '');
});

test('"Undo" takes back one step, and says so when there is none', async () => {
  const { root, runs } = boot({ answer: (x) => (x.type === 'layersUndo' ? { ok: false, error: 'nothing_to_undo' } : { ok: true }) });
  barOf(root).querySelector('.layer-edit-step').click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layersUndo', mode: 'step' }]);
  assert.match(barOf(root).querySelector('.layer-edit-hint').textContent, /Nothing to undo/);
});

test('a refused edit puts the boxes back where the saved state says', async () => {
  const { a, placed, frameOf } = boot({ reply: { ok: false, error: 'not_found' } });
  const frame = frameOf(a);
  await settle();
  placed.n = 0;
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  fire(frame, 'pointermove', { clientX: 300, clientY: 50 });
  fire(frame, 'pointerup');
  await settle();
  assert.equal(placed.n, 1);
});

test('a box of tabs keeps its tab bar usable, and each tab gets its own way out', async () => {
  const { document, a, edit, runs, frameOf } = boot({ grouped: true });
  const tile = document.createElement('section');
  tile.className = 'layer-tabs';
  const bar = document.createElement('div');
  bar.className = 'tabgroup-bar';
  bar.offsetTop = 4;
  bar.offsetHeight = 32;
  for (const id of ['lw_a1', 'lw_a2']) {
    const tab = document.createElement('button');
    tab.className = 'tabgroup-tab';
    tab.dataset.member = id;
    bar.appendChild(tab);
  }
  tile.appendChild(bar);
  a.appendChild(tile);
  edit.refresh();
  edit.refresh();
  assert.equal(frameOf(a).style._props['--layer-edit-top'], '36px', 'the frame starts under the tabs');
  const outs = bar.children.map(t => t.querySelector('.layer-edit-untab'));
  assert.ok(outs.every(Boolean));
  assert.equal(bar.children[0].querySelectorAll('.layer-edit-untab').length, 1, 'once, however often it refreshes');
  assert.equal(outs[0].tag, 'span', 'a button never sits inside a button');
  outs[1].click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerGroup', widget: 'lw_a2', mode: 'leave' }]);
});

test('stop leaves nothing behind', () => {
  const { document, root, a, b, edit, frameOf } = boot();
  edit.stop();
  assert.equal(document.documentElement.dataset.layerEditing, undefined);
  assert.equal(root.children.some(n => n.className === 'layer-edit-bar'), false);
  assert.equal(frameOf(a), undefined);
  assert.equal(frameOf(b), undefined);
});

test('an anchored window gets the bar but nothing to drag: it follows its app', () => {
  const { root, a, frameOf } = boot({ surface: 'anchor' });
  assert.ok(root.children.some(n => n.className === 'layer-edit-bar'));
  assert.equal(frameOf(a), undefined);
});

test('stress: dragged far off screen, or resized past it, the box stays on screen', async () => {
  const { a, runs, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  for (let i = 0; i < 200; i++) fire(frame, 'pointermove', { clientX: 100 + i * 37, clientY: 50 + i * 41 });
  fire(frame, 'pointerup');
  const grip = frame.querySelector('.layer-edit-resize');
  fire(frame, 'pointerdown', { clientX: 195, clientY: 95, target: grip });
  fire(frame, 'pointermove', { clientX: 9000, clientY: -9000 });
  fire(frame, 'pointerup');
  await settle();
  assert.equal(runs[0].rect, '0.8,0.8,0.2,0.2');
  const [x, y, w, h] = runs[1].rect.split(',').map(Number);
  assert.ok(x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1 && w > 0 && h > 0, runs[1].rect);
});

// ── "Add" ────────────────────────────────────────────────────────────────────
const LIST = { ok: true, choices: { tiles: ['weather', 'media'], widgets: ['<b>Wall Plate</b>'] } };
const barOf = (root) => root.children.find(n => n.className === 'layer-edit-bar');
const sheetOf = (root) => root.children.find(n => n.className === 'layer-edit-sheet');

test('"Add" shows a picture for each widget, and the first letter where there is none', async () => {
  const list = { ...LIST, pictures: { weather: 'assets/tile-previews/weather.webp' } };
  const { root } = boot({ answer: (a) => (a.type === 'layerList' ? list : { ok: true }) });
  barOf(root).querySelector('.layer-edit-add').click();
  await settle();
  const thumbs = sheetOf(root).querySelectorAll('.layer-edit-pick').map(r => r.children[0]);
  assert.equal(thumbs[0].children[0].src, 'assets/tile-previews/weather.webp');
  assert.equal(thumbs[1].textContent, 'm');
  assert.equal(thumbs[2].textContent, '<', 'a Store name stays text here too');
});

test('"Add" lists what can be placed: the tiles, then the Store widgets by name, as text', async () => {
  const { root, runs } = boot({ answer: (a) => (a.type === 'layerList' ? LIST : { ok: true }) });
  const add = barOf(root).querySelector('.layer-edit-add');
  add.click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerList', pictures: 'yes', keys: 'yes' }]);
  const rows = sheetOf(root).querySelectorAll('.layer-edit-pick');
  assert.deepEqual(rows.map(r => r.children.at(-1).textContent), ['weather', 'media', '<b>Wall Plate</b>']);
  assert.equal(rows[2].innerHTML, '', 'a Store name is never markup');
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  add.click();
  assert.equal(sheetOf(root), undefined, 'a second tap closes it');
  assert.equal(add.getAttribute('aria-expanded'), 'false');
});

test("a pick goes to a free spot of this window's screen, as what suits it, and the list closes", async () => {
  const { root, runs } = boot({ answer: (a) => (a.type === 'layerList' ? LIST : { ok: true }) });
  barOf(root).querySelector('.layer-edit-add').click();
  await settle();
  sheetOf(root).querySelectorAll('.layer-edit-pick')[2].click();
  await settle();
  assert.equal(sheetOf(root), undefined);
  assert.deepEqual(runs.at(-1), {
    type: 'layerPlace', widget: '<b>Wall Plate</b>', position: 'top-right', size: 'medium', monitor: 'DISPLAY2', surface: 'overlay', show: 'always',
  });
});

const KEY_LIST = { ...LIST, keys: [{ id: 'k1', title: 'Lights', labelKey: 'deck_act_openUrl' }, { id: 'k2', title: '', labelKey: 'deck_act_openUrl' }] };

test('"Add" lists the Deck keys after the widgets, and a pick is the person agreeing', async () => {
  const accepted = [];
  const { root, runs } = boot({
    layerKey: { accept: async (id, fp) => { accepted.push([id, fp]); return { ok: true }; } },
    answer: (a) => (a.type === 'layerList' ? KEY_LIST : { ok: true, id: 'lw_k', fp: 'abc' }),
  });
  barOf(root).querySelector('.layer-edit-add').click();
  await settle();
  const sheet = sheetOf(root);
  const rows = sheet.querySelectorAll('.layer-edit-pick');
  assert.equal(rows.length, 5);
  assert.equal(rows[3].children.at(-1).textContent, 'Lights');
  assert.equal(rows[4].children.at(-1).textContent, 'k2', 'with no title and no strings, the id');
  rows[3].click();
  await settle();
  assert.equal(sheetOf(root), undefined);
  assert.deepEqual(runs.at(-1), { type: 'layerKey', key: 'k1', surface: 'desktop', position: 'center', monitor: 'DISPLAY2' });
  assert.deepEqual(accepted, [['lw_k', 'abc']]);
});

test('a key that could not be placed is said in the bar and agrees to nothing', async () => {
  const accepted = [];
  const { root } = boot({
    layerKey: { accept: async (id) => { accepted.push(id); } },
    answer: (a) => (a.type === 'layerList' ? KEY_LIST : { ok: false, error: 'too_many' }),
  });
  barOf(root).querySelector('.layer-edit-add').click();
  await settle();
  sheetOf(root).querySelectorAll('.layer-edit-pick')[3].click();
  await settle();
  assert.match(barOf(root).children[0].textContent, /24 widgets/);
  assert.deepEqual(accepted, []);
});

test('a full screen says so in the bar, and nothing pretends it worked', async () => {
  const { root, placed } = boot({ answer: (a) => (a.type === 'layerList' ? LIST : { ok: false, error: 'too_many' }) });
  barOf(root).querySelector('.layer-edit-add').click();
  await settle();
  sheetOf(root).querySelectorAll('.layer-edit-pick')[0].click();
  await settle();
  assert.match(barOf(root).querySelector('.layer-edit-hint').textContent, /24/);
  assert.equal(placed.n, 1, 'the boxes are put back from the saved state');
});

test('a list that cannot be read says so instead of opening empty', async () => {
  const { root } = boot({ answer: () => ({ ok: false, error: 'offline' }) });
  barOf(root).querySelector('.layer-edit-add').click();
  await settle();
  assert.equal(sheetOf(root), undefined);
  assert.match(barOf(root).querySelector('.layer-edit-hint').textContent, /could not/);
});

test('ending edit mode closes the list, even one still loading', async () => {
  const { root, edit } = boot({ answer: (a) => (a.type === 'layerList' ? LIST : { ok: true }) });
  barOf(root).querySelector('.layer-edit-add').click();
  edit.stop();
  await settle();
  assert.equal(sheetOf(root), undefined);
});

test('an anchored window has no "Add": it is one widget', () => {
  const { root } = boot({ surface: 'anchor' });
  assert.equal(barOf(root).querySelector('.layer-edit-add'), null);
});

// ── "Attach to an app" ──────────────────────────────────────────────────────
const ATTACH_LIST = { ...LIST, attach: true };
const APPS = { ok: true, apps: [{ app: 'EXCEL', active: true }, { app: '<i>Krita</i>', active: false }] };
const openApps = async (b) => {
  tap(b.frameOf(b.a));
  named(b.root, 'When:').click();
  named(b.root, 'app').click();
  await settle();
};

function bootAttach(answer, opts = {}) {
  return boot({ ...opts, answer: (a) => (a.type === 'layerList' ? ATTACH_LIST : a.mode === 'apps' ? APPS : answer(a)) });
}

test('"On an app" is not offered where the shell cannot follow one', async () => {
  const b = boot({ answer: (x) => (x.type === 'layerList' ? LIST : { ok: true }) });
  await settle();
  tap(b.frameOf(b.a));
  named(b.root, 'When:').click();
  assert.equal(named(b.root, 'app'), undefined);
  assert.ok(named(b.root, 'always'));
});

test('"On an app" lists the open apps by name, as text, and a pick attaches the shown widget', async () => {
  const b = bootAttach(() => ({ ok: true }), { grouped: true });
  await settle();
  await openApps(b);
  const { root, runs } = b;
  assert.match(sheetOf(root).querySelector('.layer-edit-sheet-note').textContent, /follows/);
  const rows = sheetOf(root).querySelectorAll('.layer-edit-pick');
  assert.deepEqual(rows.map(r => r.children.at(-1).textContent), ['EXCEL', '<i>Krita</i>']);
  assert.equal(rows[1].innerHTML, '', 'an app name is never markup');
  rows[0].click();
  await settle();
  assert.equal(sheetOf(root), undefined);
  assert.deepEqual(runs.at(-1), { type: 'layerAnchor', widget: 'lw_a1', app: 'EXCEL' });
});

test('no open app, or a refused attach, is said in the bar', async () => {
  const empty = boot({ answer: (x) => (x.type === 'layerList' ? ATTACH_LIST : { ok: true, apps: [] }) });
  await settle();
  await openApps(empty);
  assert.equal(sheetOf(empty.root), undefined);
  assert.match(barOf(empty.root).querySelector('.layer-edit-hint').textContent, /No open app/);

  const refused = bootAttach(() => ({ ok: false, error: 'no_app' }));
  await settle();
  await openApps(refused);
  refused.placed.n = 0;
  sheetOf(refused.root).querySelectorAll('.layer-edit-pick')[0].click();
  await settle();
  assert.match(barOf(refused.root).querySelector('.layer-edit-hint').textContent, /could not be attached/);
  assert.equal(refused.placed.n, 1, 'the boxes are put back from the saved state');
});

test('an attached window\'s bar puts it back on the desktop, and asks nothing else', async () => {
  const { root, runs } = boot({ surface: 'anchor' });
  await settle();
  assert.equal(barOf(root).querySelector('.layer-edit-hint').textContent, '', 'nothing to drag, nothing to explain');
  barOf(root).querySelector('.layer-edit-detach').click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerAnchor', mode: 'off', widget: 'lw_a1' }]);
});

test('nothing drawn in a cut window has a shadow, and words have no dark box behind them', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../components/LayerHost/LayerHost.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /box-shadow: (?!none)/, 'the cut stops the shadow in a hard black rectangle');
  assert.match(css, /\.layer-edit-frame\.is-words,\s+\.layer-edit-frame\.is-words\.is-dragging \{\s+background: none;/);
});
