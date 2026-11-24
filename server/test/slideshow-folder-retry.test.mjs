// A Slideshow folder on a network share stayed empty for a whole "time per image".
//
// Reported on Discord: a slideshow reading an SMB share, 15 minutes per picture.
// At login the share is not reachable yet, so the tile said "This folder could not
// be read", and then sat empty for 15 minutes although the share came up seconds
// later. The folder was only asked again on the rotation's tick, and the server
// kept the failed answer for 30 seconds besides.
//
// Now the folder is re-read on its own clock: soon after a failure (5 s, backing off
// to once a minute) and every 5 minutes otherwise; the server keeps a failure only a
// few seconds and never runs two reads of the same folder at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const fs = require('fs');
const folderSrc = require('../windows-tiles/slideshow-folder.js');
const SRC = readFileSync(new URL('../js/windows-tiles/slideshow-widget.js', import.meta.url), 'utf8');

function matches(n, sel) {
  if (sel.includes(',')) return sel.split(',').some((s) => matches(n, s.trim()));
  const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (attr) return n.attrs && n.attrs[attr[1]] === attr[2];
  if (sel.startsWith('.')) return (' ' + n.className + ' ').includes(' ' + sel.slice(1) + ' ');
  return false;
}

// The real widget in a DOM cut down to what it touches, with a fetch the test answers.
function makeWorld(slideshow) {
  let doc;
  function mkEl(tag) {
    const n = {
      tagName: tag.toUpperCase(), className: '', children: [], parentNode: null,
      attrs: {}, handlers: {}, hidden: false, textContent: '', innerHTML: '',
      naturalWidth: 0, naturalHeight: 0,
      style: { setProperty() {} },
      get classList() {
        const list = () => n.className.split(/\s+/).filter(Boolean);
        return {
          contains: (c) => list().includes(c),
          toggle: (c, on) => { const rest = list().filter((x) => x !== c); n.className = (on ? [...rest, c] : rest).join(' '); },
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
    };
    if (tag === 'img') {
      Object.defineProperty(n, 'src', { get() { return n.attrs.src || ''; }, set(v) { n.attrs.src = String(v); } });
    }
    return n;
  }
  function all(root, sel) {
    const out = [];
    (function walk(n) { n.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); }); })(root);
    return out;
  }
  doc = {
    hidden: false, body: mkEl('body'), createElement: mkEl,
    createDocumentFragment: () => mkEl('fragment'),
    querySelectorAll: (sel) => all(doc.body, sel), addEventListener() {},
  };
  const page = mkEl('div'); page.className = 'pager-page';
  const tile = mkEl('div');
  tile.setAttribute('data-dashboard-widget', 'slideshow');
  const mount = mkEl('div'); mount.className = 'slideshow-widget-mount';
  tile.append(mount); page.append(tile); doc.body.append(page);

  const asked = [];      // every /slideshow/folder request, in order
  let answer = { ok: false, error: 'not_found', network: true };
  const win = { addEventListener() {}, devicePixelRatio: 1 };
  const ctx = {
    window: win, document: doc, hubSettings: { slideshow },
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a),
    MutationObserver: class { observe() {} },
    fetch: (url) => { asked.push(url); const body = answer; return Promise.resolve({ ok: true, json: () => Promise.resolve(body) }); },
    openSettingsCategory() {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const stage = () => mount.children[0];
  return {
    asked, page,
    answer: (a) => { answer = a; },
    render: () => win.SlideshowWidget.renderWidgets(),
    img: () => stage().children[0],
    emptyText: () => stage().children[2].children[0].textContent,
    isEmpty: () => stage().className.includes('is-empty'),
  };
}

const settle = () => new Promise((r) => setImmediate(r));
const QUARTER_HOUR = 15 * 60 * 1000;
const folderCfg = { source: 'folder', folder: '\\\\nas\\photos', images: [], intervalMs: QUARTER_HOUR, fit: 'cover' };

test('a folder that is not there yet is asked again in seconds, not at the next picture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(folderCfg);
  w.render(); await settle();
  assert.equal(w.asked.length, 1);
  assert.ok(w.isEmpty());
  assert.match(w.emptyText(), /slideshow_folder_err_not_found/, 'the tile says why it is empty');
  assert.match(w.emptyText(), /slideshow_folder_retrying/, 'and that Xenon keeps trying');

  t.mock.timers.tick(4999); await settle();
  assert.equal(w.asked.length, 1);
  t.mock.timers.tick(1); await settle();
  assert.equal(w.asked.length, 2, 'asked again 5 s after the failure');
  assert.equal(w.asked[1], '/slideshow/folder', 'through the server cache: every window shares one read');

  t.mock.timers.tick(9999); await settle();
  assert.equal(w.asked.length, 2, 'the second wait is longer');
  w.answer({ ok: true, count: 3, skipped: 0 });
  t.mock.timers.tick(1); await settle();
  assert.equal(w.asked.length, 3);
  assert.equal(w.isEmpty(), false, 'the share came up: the pictures show at once');
  assert.equal(w.img().src, '/slideshow/file?i=0');
});

test('the waits back off to once a minute and a readable folder goes back to every 5 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(folderCfg);
  w.render(); await settle();
  for (const wait of [5000, 10000, 20000, 30000, 60000, 60000, 60000]) {
    const before = w.asked.length;
    t.mock.timers.tick(wait - 1); await settle();
    assert.equal(w.asked.length, before, `not before ${wait} ms`);
    t.mock.timers.tick(1); await settle();
    assert.equal(w.asked.length, before + 1, `asked after ${wait} ms`);
  }
  w.answer({ ok: true, count: 2, skipped: 0 });
  t.mock.timers.tick(60000); await settle();
  const before = w.asked.length;
  t.mock.timers.tick(299999); await settle();
  assert.equal(w.asked.length, before, 'a readable folder is not asked every minute');
  t.mock.timers.tick(1); await settle();
  assert.equal(w.asked.length, before + 1, 'but still re-read every 5 minutes, not every 15');
});

test('a folder that cannot be read and will not change is not retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(folderCfg);
  w.answer({ ok: false, error: 'not_a_dir' });
  w.render(); await settle();
  assert.doesNotMatch(w.emptyText(), /slideshow_folder_retrying/, 'a file is not a folder however often it is asked');
  t.mock.timers.tick(60000); await settle();
  assert.equal(w.asked.length, 1);
});

test('when every picture fails, the folder is asked at once, so a dropped share shows and retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(folderCfg);
  w.answer({ ok: true, count: 2, skipped: 0 });
  w.render(); await settle();
  w.answer({ ok: false, error: 'read_failed', network: true });
  w.img().emit('error');
  assert.equal(w.asked.length, 1, 'one broken picture just steps on');
  w.img().emit('error');
  assert.equal(w.asked.at(-1), '/slideshow/folder?refresh=1', 'both broken: ask the folder now, past the cache');
  await settle();
  assert.ok(w.isEmpty(), 'the tile says the folder cannot be read instead of staying black');
  w.answer({ ok: true, count: 2, skipped: 0 });
  t.mock.timers.tick(5000); await settle();
  assert.equal(w.isEmpty(), false, 'and the pictures come back with the share');
  assert.equal(w.img().src, '/slideshow/file?i=0');
});

test('with no Slideshow tile left the folder is not asked any more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld(folderCfg);
  w.render(); await settle();
  w.page.replaceChildren();
  w.render();
  t.mock.timers.tick(QUARTER_HOUR); await settle();
  assert.equal(w.asked.length, 1);
});

function tempFolder() { return mkdtempSync(join(tmpdir(), 'xenon-slideshow-retry-')); }

test('the server keeps a failed read only a few seconds, and a good one for 30', async (t) => {
  const base = tempFolder();
  const dir = join(base, 'share');
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  t.after(() => { Date.now = realNow; rmSync(base, { recursive: true, force: true }); folderSrc.invalidate(); });
  folderSrc.invalidate();
  assert.equal((await folderSrc.listFolder(dir)).error, 'not_found');
  fs.mkdirSync(dir);
  writeFileSync(join(dir, 'a.png'), 'x');
  assert.equal((await folderSrc.listFolder(dir)).error, 'not_found', 'a moment later the same answer is reused');
  shift = 5000;
  const up = await folderSrc.listFolder(dir);
  assert.equal(up.ok, true, '5 s later the folder is read again');
  assert.equal(up.count, 1);
  writeFileSync(join(dir, 'b.png'), 'x');
  shift = 20000;
  assert.equal((await folderSrc.listFolder(dir)).count, 1, 'a folder that reads is still kept for 30 s');
});

test('the server runs one read of a folder at a time, however many ask', async (t) => {
  const dir = tempFolder();
  writeFileSync(join(dir, 'a.png'), 'x');
  const realReaddir = fs.promises.readdir;
  let reads = 0;
  fs.promises.readdir = (...a) => { reads++; return realReaddir.apply(fs.promises, a); };
  t.after(() => { fs.promises.readdir = realReaddir; rmSync(dir, { recursive: true, force: true }); folderSrc.invalidate(); });
  folderSrc.invalidate();
  const answers = await Promise.all([folderSrc.listFolder(dir), folderSrc.listFolder(dir, { refresh: true }), folderSrc.listFolder(dir)]);
  assert.equal(reads, 1, 'three windows asking at once share one read');
  assert.deepEqual(answers.map((a) => a.count), [1, 1, 1]);
});

test('a read that a folder change orphaned answers its caller but is not kept', async (t) => {
  const dir = tempFolder();
  writeFileSync(join(dir, 'a.png'), 'x');
  t.after(() => { rmSync(dir, { recursive: true, force: true }); folderSrc.invalidate(); });
  folderSrc.invalidate();
  const pending = folderSrc.listFolder(dir);
  folderSrc.invalidate();
  assert.equal((await pending).count, 1);
  writeFileSync(join(dir, 'b.png'), 'x');
  assert.equal((await folderSrc.listFolder(dir)).count, 2, 'the next ask reads the folder again');
});
