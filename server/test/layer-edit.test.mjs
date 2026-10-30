// Edit mode of a layer window (js/layer-edit.js): drag, corner, drop for tabs,
// the crosses and "Done" become capability runs; the page itself saves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const SRC = readFileSync(new URL('../js/layer-edit.js', import.meta.url), 'utf8');

const rectOf = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height });

function boot({ surface = 'desktop', reply = { ok: true }, grouped = false, answer } = {}) {
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
  const membersA = grouped ? [{ id: 'lw_a1' }, { id: 'lw_a2' }] : [{ id: 'lw_a1' }];
  const boxes = [
    { key: 'A', slot: a, box: { lead: membersA[0], members: membersA }, shown: membersA.at(-1).id },
    { key: 'B', slot: b, box: { lead: { id: 'lw_b1' }, members: [{ id: 'lw_b1' }] }, shown: 'lw_b1' },
  ];
  const runs = [];
  const placed = { n: 0 };
  const api = {
    root: () => root,
    surface,
    monitor: surface === 'anchor' ? '' : 'DISPLAY2',
    boxes: () => boxes.slice(),
    place: () => { placed.n++; },
    run: async (action) => { runs.push({ ...action }); return answer ? answer(action) : reply; },
  };
  const ctx = { window: {}, document, Math, Array, WeakMap };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const edit = ctx.window.LayerEdit;
  edit.start(api);
  runs.length = 0;   // start asks layerList whether attaching exists; tests count what follows
  const frameOf = (s) => s.children.find(n => n.className.includes('layer-edit-frame'));
  return { document, root, a, b, edit, runs, placed, frameOf };
}

const fire = (node, type, ev = {}) => (node._handlers[type] || []).forEach(fn => fn({
  button: 0, pointerId: 1, target: node, preventDefault() {}, stopPropagation() {}, ...ev,
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
    assert.ok(frame.querySelector('.layer-edit-remove'));
    assert.ok(frame.querySelector('.layer-edit-resize'));
  }
});

test('"Done" ends the mode through the server', async () => {
  const { root, runs } = boot();
  root.children.find(n => n.className === 'layer-edit-bar').querySelector('.layer-edit-done').click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layersEdit', mode: 'off' }]);
});

test('a drag moves the box on an 8 px grid and saves it as screen fractions', async () => {
  const { a, runs, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  assert.ok(frame.classList.contains('is-dragging'));
  fire(frame, 'pointermove', { clientX: 403, clientY: 200 });
  assert.equal(a.style._props['--layer-x'], '30.4%', 'drawn where it goes while dragging');
  fire(frame, 'pointerup');
  await settle();
  assert.ok(!frame.classList.contains('is-dragging'));
  assert.deepEqual(runs, [{ type: 'layerMove', target: 'lw_a1', position: 'keep', size: 'keep', rect: '0.304,0.304,0.2,0.2' }]);
});

test('an edge close to another box or the screen edge snaps to it', async () => {
  const { a, runs, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  // Right edge lands 6 px short of B's left edge (600): it meets it.
  fire(frame, 'pointermove', { clientX: 494, clientY: 52 });
  fire(frame, 'pointerup');
  await settle();
  assert.equal(runs[0].rect, '0.4,0,0.2,0.2');
});

test('a tap is not a drag: nothing runs', async () => {
  const { a, runs, frameOf } = boot();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  fire(frame, 'pointermove', { clientX: 102, clientY: 51 });
  fire(frame, 'pointerup');
  await settle();
  assert.deepEqual(runs, []);
});

test('dropped on another box, every tab joins it, the one shown last', async () => {
  const { a, b, runs, frameOf } = boot({ grouped: true });
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50 });
  fire(frame, 'pointermove', { clientX: 650, clientY: 350 });
  assert.ok(frameOf(b).classList.contains('is-drop-target'));
  fire(frame, 'pointerup');
  await settle();
  assert.ok(!frameOf(b).classList.contains('is-drop-target'));
  assert.deepEqual(runs, [
    { type: 'layerGroup', widget: 'lw_a1', with: 'lw_b1', mode: 'join' },
    { type: 'layerGroup', widget: 'lw_a2', with: 'lw_b1', mode: 'join' },
  ]);
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
  assert.equal(runs[0].rect, '0,0,0.296,0.304');
});

test('the cross takes the shown widget off the screen, without starting a drag', async () => {
  const { a, runs, frameOf } = boot({ grouped: true });
  const frame = frameOf(a);
  const remove = frame.querySelector('.layer-edit-remove');
  fire(frame, 'pointerdown', { clientX: 190, clientY: 10, target: remove });
  assert.ok(!frame.classList.contains('is-dragging'));
  remove.click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerRemove', target: 'lw_a2' }]);
});

test('a refused edit puts the boxes back where the saved state says', async () => {
  const { a, placed, frameOf } = boot({ reply: { ok: false, error: 'not_found' } });
  const frame = frameOf(a);
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

test('"Add" lists what can be placed: the tiles, then the Store widgets by name, as text', async () => {
  const { root, runs } = boot({ answer: (a) => (a.type === 'layerList' ? LIST : { ok: true }) });
  const add = barOf(root).querySelector('.layer-edit-add');
  add.click();
  await settle();
  assert.deepEqual(runs, [{ type: 'layerList' }]);
  const rows = sheetOf(root).querySelectorAll('.layer-edit-pick');
  assert.deepEqual(rows.map(r => r.children.at(-1).textContent), ['weather', 'media', '<b>Wall Plate</b>']);
  assert.equal(rows[2].innerHTML, '', 'a Store name is never markup');
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  add.click();
  assert.equal(sheetOf(root), undefined, 'a second tap closes it');
  assert.equal(add.getAttribute('aria-expanded'), 'false');
});

test('a pick lands in the middle of this window\'s screen and the list closes', async () => {
  const { root, runs } = boot({ answer: (a) => (a.type === 'layerList' ? LIST : { ok: true }) });
  barOf(root).querySelector('.layer-edit-add').click();
  await settle();
  sheetOf(root).querySelectorAll('.layer-edit-pick')[2].click();
  await settle();
  assert.equal(sheetOf(root), undefined);
  assert.deepEqual(runs.at(-1), {
    type: 'layerPlace', widget: '<b>Wall Plate</b>', surface: 'desktop', position: 'center', size: 'medium', monitor: 'DISPLAY2',
  });
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
const pinOf = (frame) => frame.querySelector('.layer-edit-attach');

function bootAttach(answer, opts = {}) {
  return boot({ ...opts, answer: (a) => (a.type === 'layerList' ? ATTACH_LIST : a.mode === 'apps' ? APPS : answer(a)) });
}

test('no pin on the frames where the shell cannot follow an app', async () => {
  const { a, frameOf } = boot({ answer: (x) => (x.type === 'layerList' ? LIST : { ok: true }) });
  await settle();
  assert.equal(pinOf(frameOf(a)), null);
  assert.ok(frameOf(a).querySelector('.layer-edit-remove'), 'the frame is still there');
});

test('the pin lists the open apps by name, as text, and a pick attaches the shown widget', async () => {
  const { root, a, runs, frameOf } = bootAttach(() => ({ ok: true }), { grouped: true });
  await settle();
  const pin = pinOf(frameOf(a));
  assert.ok(pin);
  pin.click();
  await settle();
  assert.match(sheetOf(root).querySelector('.layer-edit-sheet-note').textContent, /follows/);
  const rows = sheetOf(root).querySelectorAll('.layer-edit-pick');
  assert.deepEqual(rows.map(r => r.children.at(-1).textContent), ['EXCEL', '<i>Krita</i>']);
  assert.equal(rows[1].innerHTML, '', 'an app name is never markup');
  rows[0].click();
  await settle();
  assert.equal(sheetOf(root), undefined);
  assert.deepEqual(runs.at(-1), { type: 'layerAnchor', widget: 'lw_a2', app: 'EXCEL' });
});

test('a press on the pin does not start a drag', async () => {
  const { a, runs, frameOf } = bootAttach(() => ({ ok: true }));
  await settle();
  const frame = frameOf(a);
  fire(frame, 'pointerdown', { clientX: 100, clientY: 50, target: pinOf(frame) });
  fire(frame, 'pointermove', { clientX: 400, clientY: 200 });
  fire(frame, 'pointerup');
  await settle();
  assert.ok(!runs.some(r => r.type === 'layerMove'));
});

test('no open app, or a refused attach, is said in the bar', async () => {
  const empty = boot({ answer: (x) => (x.type === 'layerList' ? ATTACH_LIST : { ok: true, apps: [] }) });
  await settle();
  pinOf(empty.frameOf(empty.a)).click();
  await settle();
  assert.equal(sheetOf(empty.root), undefined);
  assert.match(barOf(empty.root).querySelector('.layer-edit-hint').textContent, /No open app/);

  const refused = bootAttach(() => ({ ok: false, error: 'no_app' }));
  await settle();
  pinOf(refused.frameOf(refused.a)).click();
  await settle();
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
