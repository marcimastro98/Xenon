// The Gallery over the whole screen (js/capture-gallery.js with its viewer, trim, export and
// editor): the rail, the states of the page, one Esc per layer, Space, which key sits where,
// and every layer letting go of the keyboard while it is still in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SCRIPTS = ['capture-gallery-model', 'capture-annotate-model', 'capture-gallery-viewer',
  'capture-export-view', 'capture-annotate', 'capture-gallery'].map((name) => read(`../js/${name}.js`));

const capture = (id, kind, game, daysAgo = 0) => ({
  id, kind, name: id, game, createdAt: Date.now() - daysAgo * 86400000,
  seconds: kind === 'screenshot' ? 0 : 30, width: 1920, height: 1080,
});
const FULL = {
  ok: true, more: false, editable: true, usedBytes: 2048,
  entries: [capture('v1', 'replay', 'Lantern Trail'), capture('s1', 'screenshot', 'Neon Drift')],
  games: [{ label: 'Lantern Trail', count: 3 }, { label: 'Neon Drift', count: 1 }],
};
const EMPTY = { ok: true, more: false, editable: true, usedBytes: 0, entries: [], games: [] };

function rig(answer = FULL, { remote = false } = {}) {
  const { document, ResizeObserver } = makeDom();
  const plain = document.createElement;
  const played = [];
  const pictures = [];
  document.createElement = (tag) => {
    const node = plain(tag);
    if (tag === 'video') {
      node.paused = true;
      node.play = async () => { node.paused = false; played.push('play'); };
      node.pause = () => { node.paused = true; played.push('pause'); };
      node.load = () => {};
    }
    if (tag === 'canvas') {
      node.setPointerCapture = () => {};
      node.getContext = () => new Proxy({}, {
        get: (box, k) => (k in box ? box[k] : () => ({ width: 10 })),
        set: (box, k, v) => { box[k] = v; return true; },
      });
    }
    return node;
  };

  class Picture {
    constructor() { this.heard = {}; pictures.push(this); }
    addEventListener(type, fn) { this.heard[type] = fn; }
    removeAttribute() {}
  }

  const held = [];
  const log = [];
  const asked = [];
  const nameOf = (root) => String(root.className).split(' ').find((c) => /^(capg-modal|capg-viewer|cann)$/.test(c));
  const window = {
    t: (k) => k,
    __xenonRemote: remote,
    ambientFreeze() {},
    DialogFocus: {
      hold(root, { onEsc }) {
        const entry = { root, onEsc };
        held.push(entry);
        return () => {
          log.push([nameOf(root), root.parentNode !== null]);
          held.splice(held.indexOf(entry), 1);
        };
      },
    },
    openSettings(category) { log.push(['settings', category, !!document.querySelector('.capg-overlay')]); },
  };
  const ctx = {
    window, document, ResizeObserver, Image: Picture, SERVER: '', URLSearchParams, setTimeout, clearTimeout, console,
    makeEl(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    },
    formatBytes: (n) => `${n} B`,
    timeParts: () => ({}),
    apiJson: async (path) => { asked.push(path); return typeof answer === 'function' ? answer(path) : answer; },
  };
  vm.createContext(ctx);
  SCRIPTS.forEach((source) => vm.runInContext(source, ctx));

  const all = (sel) => document.querySelectorAll(sel);
  const one = (sel) => document.querySelector(sel);
  const keyNamed = (word) => all('button').find((b) => b.textContent === word);
  return {
    ctx, window, document, held, log, asked, played, pictures, all, one, keyNamed,
    gallery: window.CaptureGallery,
    esc: () => held.at(-1).onEsc(),
    press: (key) => (document._handlers.keydown || []).slice().forEach((fn) => fn({ key, preventDefault() {}, stopPropagation() {} })),
    layers: () => held.map((h) => nameOf(h.root)),
  };
}

async function opened(answer, opts, how) {
  const r = rig(answer, how);
  await r.gallery.open(opts);
  await settle();
  return r;
}

const texts = (nodes) => nodes.map((n) => n.textContent);

test('the rail names the kinds, and the games only when there is a choice to make', async () => {
  const r = await opened(FULL);
  assert.deepEqual(texts(r.all('.cst-rail-list')[0].children), ['All', 'Videos', 'Screenshots']);
  assert.equal(r.one('.capg-games').hidden, false);
  assert.deepEqual(texts(r.one('.capg-games').children), ['All games', 'Lantern Trail3', 'Neon Drift1']);

  const single = await opened({ ...FULL, games: [{ label: 'Lantern Trail', count: 2 }] });
  assert.equal(single.one('.capg-games').hidden, true);
});

test('picking a kind or a game lights its row and asks the server for it', async () => {
  const r = await opened(FULL);
  r.keyNamed('Videos').click();
  await settle();
  assert.deepEqual(r.all('.cst-rail-list')[0].children.map((row) => row.classList.contains('on')), [false, true, false]);
  assert.equal(r.keyNamed('Videos').getAttribute('aria-pressed'), 'true');
  assert.match(r.asked.at(-1), /kind=video/);

  r.keyNamed('Neon Drift1').click();
  await settle();
  assert.equal(r.keyNamed('Neon Drift1').getAttribute('aria-pressed'), 'true');
  assert.equal(r.keyNamed('All games').getAttribute('aria-pressed'), 'false');
  assert.match(r.asked.at(-1), /kind=video&game=Neon/);
});

test('a game left with nothing keeps the way back to all of them', async () => {
  const r = await opened((path) => (path.includes('game=') ? { ...EMPTY } : FULL));
  r.keyNamed('Neon Drift1').click();
  await settle();
  assert.equal(r.one('.capg-games').hidden, false);
  assert.equal(r.one('.capg-status').textContent, 'Nothing here with this filter.');
  assert.ok(r.keyNamed('All games'));
});

test('the used size stands at the foot of the rail, and says nothing about an empty gallery', async () => {
  assert.equal((await opened(FULL)).one('.capg-rail-used').textContent, '2048 B in all');
  assert.equal((await opened(EMPTY)).one('.capg-rail-used').textContent, '');
});

test('the page keeps its shape until the first answer comes', async () => {
  const r = rig(() => new Promise(() => {}));
  r.gallery.open({});
  await settle();
  assert.equal(r.all('.capg-thumb').length, 8);
  assert.equal(r.one('.capg-grid').getAttribute('aria-hidden'), 'true');
  assert.equal(r.all('.capg-tile').length, 0);
});

test('a day further back starts with a capital, whatever the language writes', async () => {
  const r = rig({ ...FULL, entries: [capture('old', 'screenshot', 'Neon Drift', 9)] });
  vm.runInContext("Date.prototype.toLocaleDateString = () => 'mercoledì 4 novembre';", r.ctx);
  await r.gallery.open({});
  await settle();
  assert.equal(r.one('.capg-day-title').textContent, 'Mercoledì 4 novembre');
});

test('an empty gallery opens the Capture settings, and leaves only after asking', async () => {
  const r = await opened(EMPTY);
  r.keyNamed('Open settings').click();
  assert.deepEqual(r.log, [['settings', 'capture', true], ['capg-modal', true]]);
  assert.equal(r.one('.capg-overlay'), null);
});

test('a paired device has no Settings to open, and a filter has nothing to set up', async () => {
  assert.equal((await opened(EMPTY, {}, { remote: true })).keyNamed('Open settings'), undefined);
  assert.equal((await opened(EMPTY, { filter: 'video' })).keyNamed('Open settings'), undefined);
});

test('a page that did not load has one key, and it asks again', async () => {
  const r = await opened({ ok: false });
  const before = r.asked.length;
  r.keyNamed('Try again').click();
  await settle();
  assert.equal(r.asked.length, before + 1);
});

test('a picture leads with Edit and ends with Delete; a video with Trim', async () => {
  const shot = await opened(FULL, { id: 's1' });
  const keys = shot.one('.capg-actions').children;
  assert.equal(keys[0].textContent, 'Edit');
  assert.ok(keys[0].classList.contains('is-main'));
  assert.equal(keys.at(-1).textContent, 'Delete');
  assert.equal(keys.filter((k) => k.classList.contains('is-main')).length, 1);

  const video = await opened(FULL, { id: 'v1' });
  const row = video.one('.capg-actions').children;
  assert.equal(row[0].textContent, 'Trim');
  assert.equal(row.filter((k) => k.classList.contains('is-main')).length, 1);
});

test('Trim: Cancel on the left, the main key on the right, Esc goes back to the keys', async () => {
  const r = await opened(FULL, { id: 'v1' });
  r.keyNamed('Trim').click();
  const row = r.one('.capg-trim-row').children;
  assert.equal(row[0].textContent, 'Cancel');
  assert.ok(row[1].classList.contains('is-main'));

  r.esc();
  assert.equal(r.one('.capg-trim-row'), null);
  assert.ok(r.keyNamed('Trim'));
  assert.deepEqual(r.layers(), ['capg-modal', 'capg-viewer']);
});

test('Export: Cancel on the left, a pick keeps the keyboard on its key', async () => {
  const r = await opened(FULL, { id: 'v1' });
  r.keyNamed('Export').click();
  await settle();
  const keys = r.keyNamed('Cancel').parentNode.children;
  assert.equal(keys[0].textContent, 'Cancel');
  assert.ok(keys[1].classList.contains('is-main'));

  const second = r.all('.capg-exp-opt')[1];
  r.document.activeElement = second;
  second.click();
  assert.notEqual(r.all('.capg-exp-opt')[1], second);
  assert.equal(r.document.activeElement, r.all('.capg-exp-opt')[1]);
});

test('Esc takes one step: the sheet, then the viewer, then the Gallery', async () => {
  const r = await opened(FULL, { id: 'v1' });
  r.keyNamed('Export').click();
  await settle();

  r.esc();
  assert.equal(r.all('.capg-exp-opt').length, 0);
  assert.ok(r.one('.capg-viewer'));
  r.esc();
  assert.equal(r.one('.capg-viewer'), null);
  assert.ok(r.one('.capg-modal'));
  r.esc();
  assert.equal(r.one('.capg-modal'), null);
  assert.deepEqual(r.held, []);
});

test('Space plays and pauses, and leaves a key with the focus alone', async () => {
  const r = await opened(FULL, { id: 'v1' });
  r.document.activeElement = r.one('.capg-viewer');
  r.press(' ');
  r.press(' ');
  assert.deepEqual(r.played, ['play', 'pause']);

  r.document.activeElement = r.keyNamed('Trim');
  r.press(' ');
  assert.deepEqual(r.played, ['play', 'pause']);
});

test('the arrows walk the list, and the page comes back on the capture last shown', async () => {
  const r = await opened(FULL, { id: 'v1' });
  r.press('ArrowRight');
  assert.equal(r.one('.capg-vname').textContent, 'Neon Drift');
  r.esc();
  assert.equal(r.document.activeElement.dataset.id, 's1');
});

test('the editor: Esc drops the text first, then closes, and the viewer stays', async () => {
  const r = await opened(FULL, { id: 's1' });
  r.keyNamed('Edit').click();
  await settle();
  assert.deepEqual(r.layers(), ['capg-modal', 'capg-viewer', 'cann']);

  r.one('.cann-stage')._rect = { width: 960, height: 540 };
  const picture = r.pictures.at(-1);
  Object.assign(picture, { naturalWidth: 1920, naturalHeight: 1080 });
  picture.heard.load();
  r.all('.cann-tool').find((b) => b.textContent.includes('Text')).click();
  const canvas = r.one('.cann-canvas');
  const tap = { button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} };
  canvas._handlers.pointerdown.forEach((fn) => fn(tap));
  canvas._handlers.pointerup.forEach((fn) => fn(tap));
  assert.ok(r.one('.cann-input'));

  r.esc();
  assert.equal(r.one('.cann-input'), null);
  assert.equal(r.document.activeElement, r.one('.cann'));
  r.esc();
  assert.equal(r.one('.cann'), null);
  assert.deepEqual(r.layers(), ['capg-modal', 'capg-viewer']);
});

test('every layer lets go while it is still in the page, the top one first', async () => {
  const r = await opened(FULL, { id: 's1' });
  r.keyNamed('Edit').click();
  await settle();
  r.gallery.close();
  assert.deepEqual(r.log, [['cann', true], ['capg-viewer', true], ['capg-modal', true]]);
  assert.deepEqual(r.held, []);
});

test('a viewer with nothing left to show leaves nothing holding the keys', async () => {
  const r = await opened(FULL, { id: 's1' });
  r.window.CaptureGalleryViewer.open({
    host: r.one('.capg-modal'), entries: [], id: '', url: (p) => p, kindLabel: () => '', timeOf: () => '',
    onClose() {}, onChanged() {},
  });
  assert.deepEqual(r.layers(), ['capg-modal', 'capg-viewer']);
});
