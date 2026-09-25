// The slideshow stopped changing pictures for as long as a game ran.
//
// "Stop GIFs while gaming" (on by default) was meant to spare the game a GIF
// decoding every frame. It did that by freezing the tile on a still, and the
// same switch also stopped the rotation, so a folder of photos sat on one
// picture for the whole session. On a Xeneon Edge the screen is right next to
// the game and watched the whole time. Reported on #130: "the photos changing
// still freeze when in game on the latest version".
//
// Now a game only stills the picture. The rotation carries on, each new picture
// loading behind the current still and being frozen in its place, so the tile
// never shows a blank frame and a GIF never animates. A hidden dashboard still
// stops everything, as before.
//
// These run the real widget in a DOM cut down to what it touches.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/slideshow-widget.js', import.meta.url), 'utf8');

function matches(n, sel) {
  const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (attr) return n.attrs && n.attrs[attr[1]] === attr[2];
  if (sel.startsWith('.')) return (' ' + n.className + ' ').includes(' ' + sel.slice(1) + ' ');
  return false;
}

function makeWorld(slideshow) {
  const observers = [];
  let doc;
  function mkEl(tag) {
    const n = {
      tagName: tag.toUpperCase(), className: '', children: [], parentNode: null,
      attrs: {}, handlers: {}, hidden: false, textContent: '', innerHTML: '',
      naturalWidth: 0, naturalHeight: 0, drawn: 0,
      get clientWidth() { return n.hidden ? 0 : 300; },
      get clientHeight() { return n.hidden ? 0 : 200; },
      get classList() {
        const list = () => n.className.split(/\s+/).filter(Boolean);
        const set = (arr) => { n.className = arr.join(' '); if (n === doc.body) observers.forEach((cb) => cb()); };
        return {
          contains: (c) => list().includes(c),
          add: (c) => { if (!list().includes(c)) set([...list(), c]); },
          remove: (c) => set(list().filter((x) => x !== c)),
          toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want !== has) (want ? set([...list(), c]) : set(list().filter((x) => x !== c))); },
        };
      },
      get isConnected() { let p = n; while (p.parentNode) p = p.parentNode; return p === doc.body; },
      get childElementCount() { return n.children.length; },
      append(...c) { c.forEach((x) => { x.parentNode = n; n.children.push(x); }); },
      appendChild(c) { n.append(c); return c; },
      replaceChildren(...c) { n.children.forEach((x) => { x.parentNode = null; }); n.children = []; n.append(...c); },
      setAttribute(k, v) { n.attrs[k] = String(v); },
      getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
      removeAttribute(k) { delete n.attrs[k]; },
      addEventListener(type, fn) { (n.handlers[type] ||= []).push(fn); },
      emit(type) { (n.handlers[type] || []).forEach((fn) => fn({ target: n, stopPropagation() {} })); },
      closest(sel) { for (let p = n; p; p = p.parentNode) if (matches(p, sel)) return p; return null; },
      querySelector(sel) { return all(n, sel)[0] || null; },
      getClientRects() { return [{}]; },
      getContext() { return { drawImage() { n.drawn++; } }; },
    };
    if (tag === 'img') {
      Object.defineProperty(n, 'src', {
        get() { return n.attrs.src || ''; },
        // A new src has nothing decoded until its load event.
        set(v) { n.attrs.src = String(v); n.naturalWidth = 0; n.naturalHeight = 0; },
      });
    }
    return n;
  }
  function all(root, sel) {
    const out = [];
    (function walk(n) { n.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); }); })(root);
    return out;
  }

  doc = {
    hidden: false,
    body: mkEl('body'),
    createElement: mkEl,
    createDocumentFragment: () => mkEl('fragment'),
    querySelectorAll: (sel) => all(doc.body, sel),
    addEventListener() {},
  };
  const page = mkEl('div'); page.className = 'pager-page';
  const tile = mkEl('div');
  tile.setAttribute('data-dashboard-widget', 'slideshow');
  tile.setAttribute('data-dashboard-instance', 'slideshow');
  const mount = mkEl('div'); mount.className = 'slideshow-widget-mount';
  tile.append(mount); page.append(tile); doc.body.append(page);

  const win = { addEventListener() {}, devicePixelRatio: 1 };
  const ctx = {
    window: win, document: doc,
    hubSettings: { slideshow },
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    MutationObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
    fetch: () => new Promise(() => {}),
    openSlideshowSettings() {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const stage = () => mount.children[0];
  const img = () => stage().children[0];
  const still = () => stage().children[1];
  /** The browser finishing a decode of whatever the <img> points at. */
  const load = () => { const i = img(); i.naturalWidth = 800; i.naturalHeight = 600; i.emit('load'); };
  return { doc, win, render: () => win.SlideshowWidget.renderWidgets(), img, still, load };
}

const PHOTOS = [{ uri: 'a.jpg', name: 'a' }, { uri: 'b.jpg', name: 'b' }, { uri: 'c.gif', name: 'c' }];
const cfg = (extra) => ({ source: 'library', images: PHOTOS, intervalMs: 6000, fit: 'contain', pauseGame: true, ...extra });

test('while a game runs, the pictures keep changing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(cfg());
  w.render(); w.load();
  assert.equal(w.img().src, 'a.jpg');

  w.doc.body.classList.add('game-mode');
  assert.equal(w.still().hidden, false, 'the game froze the tile on a still');
  assert.equal(w.img().getAttribute('src'), null, 'and dropped the live picture, which is what stops a GIF');

  t.mock.timers.tick(6000);
  assert.equal(w.img().src, 'b.jpg', 'the rotation moved on during the game');
  assert.equal(w.still().hidden, false, 'the old still stays up while the next picture loads: no blank frame');
  assert.equal(w.img().hidden, true, 'the loading picture is not shown half-decoded');

  const drawnBefore = w.still().drawn;
  w.load();
  assert.ok(w.still().drawn > drawnBefore, 'the new picture was painted onto the still');
  assert.equal(w.img().getAttribute('src'), null, 'and dropped again, so nothing decodes between ticks');

  t.mock.timers.tick(6000); w.load();
  t.mock.timers.tick(6000);
  assert.equal(w.img().src, 'a.jpg', 'it keeps going round, not just one step');
});

test('the arrows work during a game too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(cfg());
  w.render(); w.load();
  w.doc.body.classList.add('game-mode');
  const next = w.img().parentNode.children.find((c) => c.className.includes('sl-next'));
  next.emit('click');
  assert.equal(w.img().src, 'b.jpg');
});

test('a game ending while the next picture loads shows that picture', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(cfg());
  w.render(); w.load();
  w.doc.body.classList.add('game-mode');
  t.mock.timers.tick(6000);
  w.doc.body.classList.remove('game-mode');
  assert.equal(w.still().hidden, true, 'no stale still left covering the tile');
  assert.equal(w.img().hidden, false);
  assert.equal(w.img().src, 'b.jpg');
});

test('with the option off, a game changes nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(cfg({ pauseGame: false }));
  w.render(); w.load();
  w.doc.body.classList.add('game-mode');
  assert.equal(w.still().hidden, true);
  t.mock.timers.tick(6000);
  assert.equal(w.img().src, 'b.jpg');
  assert.equal(w.img().hidden, false);
});

test('a hidden dashboard still stops the rotation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(cfg());
  w.render(); w.load();
  w.doc.hidden = true;
  t.mock.timers.tick(6000 * 3);
  w.doc.hidden = false;
  w.render();
  assert.equal(w.img().src, 'a.jpg', 'nobody could see it, so it did not move on');
});
