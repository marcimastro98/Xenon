// Classic <script> files share one global scope per page. A top-level
// `function NAME` in a later script silently replaces an earlier one with the
// same name, and every bare call in the earlier file then reaches the wrong
// code: that is how deck-model.js's firstFreeSlot(config) took over the
// dashboard grid's firstFreeSlot(occupied, w, h, columns) on index.html, so
// overlap repair and new-widget placement got { config, nav, slot } back.
//
// How the names are found: no regex over the source. Each script goes to V8
// (node:vm) behind a leading `throw`, so the engine sets up the script's global
// declarations as a browser does before running it, then stops before a single
// statement of the file runs. What lands on the sandbox global is exactly the
// top-level function (async, generator) and `var` names; anything inside an
// IIFE, a UMD factory or a block of strict code stays local and is not seen.
// A leading 'use strict' is kept in front, so block functions stay block-scoped
// as on the page. let/const/class do not land on the global object: a clash
// with one of them is a SyntaxError when the later script is set up, which the
// second test catches by setting up a page's scripts in order in one context.
//
// What is read: every server/*.html page and its <script> tags outside HTML
// comments, with no type or a JavaScript type (type="module" and data blocks
// have their own scope or none). Local src files that exist on disk are read,
// plus inline scripts; a src served by a route (/layer-i18n.js) has no file and
// is skipped, and scripts added at runtime with createElement are not seen.
// A name that is already a JavaScript built-in (escape, parseInt) is not
// compared.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_TYPE = /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$/i;
const REMOTE_SRC = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const USE_STRICT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use strict\1/;
const STOP = '__classic_script_globals_probe__';

// Duplicates judged harmless: the same small helper copied into two files that
// always load together. The guard checks the copies stay identical, so one
// cannot drift and quietly win on the page.
const ALLOWED = new Map([
  ['cssId', { files: ['js/notes.js', 'js/timer.js'], reason: 'the same CSS.escape wrapper, copied byte for byte' }],
]);

// Set up `code`'s global declarations in `ctx` without running any of it.
function instantiate(code, ctx, filename) {
  const head = USE_STRICT.test(code) ? "'use strict';" : '';
  try {
    vm.runInContext(`${head}throw ${JSON.stringify(STOP)};\n${code}`, ctx, { filename });
  } catch (err) {
    if (err !== STOP) throw err;
  }
}

// name -> { kind: 'function' | 'var', source } for one script on its own. Read
// from inside the context: a bare `var` never reaches the sandbox object.
const LIST_GLOBALS = 'Object.getOwnPropertyNames(globalThis).map((n) => [n, typeof globalThis[n], String(globalThis[n])])';
function globalNames(code, filename) {
  const ctx = vm.createContext({});
  const builtins = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', ctx));
  instantiate(code, ctx, filename);
  const out = new Map();
  for (const [name, type, source] of vm.runInContext(LIST_GLOBALS, ctx)) {
    if (builtins.has(name)) continue;
    out.set(name, type === 'function' ? { kind: 'function', source } : { kind: 'var', source: '' });
  }
  return out;
}

function pageScripts(page) {
  const html = fs.readFileSync(path.join(SERVER, page), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const seen = new Set();
  let inline = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (type && !JS_TYPE.test(type[1])) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!src) {
      out.push({ id: `${page} inline script ${++inline}`, code: m[2] });
      continue;
    }
    const rel = src[1].split(/[?#]/)[0].replace(/^\//, '');
    if (REMOTE_SRC.test(rel) || seen.has(rel)) continue;
    const file = path.resolve(SERVER, rel);
    if (!file.startsWith(SERVER + path.sep) || !fs.existsSync(file)) continue;
    seen.add(rel);
    out.push({ id: rel, code: fs.readFileSync(file, 'utf8') });
  }
  return out;
}

const PAGES = fs.readdirSync(SERVER).filter((f) => f.endsWith('.html')).sort();

test('the probe sees top-level declarations, skips wrapped ones and runs nothing', () => {
  const names = globalNames([
    "'use strict';",
    'globalThis.ran = true;',
    'function top() {}',
    'async function later() {}',
    'function* gen() {}',
    'var flag = 1;',
    'const lexical = 1;',
    'class Shape {}',
    '(function () {',
    'function wrapped() {}',
    '})();',
    'const api = (() => { function inner() {} return { inner }; })();',
    'if (true) { function blockOnly() {} }',
  ].join('\n'), 'probe.js');
  assert.deepEqual([...names.keys()].sort(), ['flag', 'gen', 'later', 'top']);
  assert.equal(names.get('top').kind, 'function');
  assert.equal(names.get('flag').kind, 'var');
});

test('no two classic scripts of a page declare the same global function or var', () => {
  const cache = new Map();
  const clashes = [];
  const allowedSeen = new Set();
  for (const page of PAGES) {
    const owners = new Map();
    for (const { id, code } of pageScripts(page)) {
      if (!cache.has(id)) cache.set(id, globalNames(code, id));
      for (const [name, decl] of cache.get(id)) {
        if (!owners.has(name)) owners.set(name, []);
        owners.get(name).push({ id, ...decl });
      }
    }
    for (const [name, list] of owners) {
      if (list.length < 2) continue;
      const files = list.map((d) => d.id);
      const allowed = ALLOWED.get(name);
      const sameFiles = allowed && files.length === allowed.files.length && allowed.files.every((f) => files.includes(f));
      const identical = list.every((d) => d.kind === 'function' && d.source === list[0].source);
      if (sameFiles && identical) {
        allowedSeen.add(name);
        continue;
      }
      const why = sameFiles ? ' (allowed only while the copies are identical, and they differ now)' : '';
      clashes.push(`${page}: ${name} is declared by ${list.map((d) => `${d.id} (${d.kind})`).join(' and ')}${why}`);
    }
  }
  assert.deepEqual(clashes, [], 'classic scripts of one page share their globals: rename one, or keep it inside its IIFE');
  const stale = [...ALLOWED.keys()].filter((name) => !allowedSeen.has(name));
  assert.deepEqual(stale, [], 'these allowed duplicates are gone: take them out of ALLOWED');
});

test("a page's classic scripts set up in order without a redeclared name", () => {
  const errors = [];
  for (const page of PAGES) {
    const ctx = vm.createContext({});
    for (const { id, code } of pageScripts(page)) {
      try {
        instantiate(code, ctx, id);
      } catch (err) {
        errors.push(`${page}: ${id}: ${err && err.name}: ${err && err.message}`);
      }
    }
  }
  assert.deepEqual(errors, []);
});

test('the dashboard grid keeps its own slot finder when deck-model.js loads after it', () => {
  // index.html order: dashboard-grid.js, then deck-model.js, both classic.
  const ctx = vm.createContext({ window: { addEventListener() {} } });
  for (const rel of ['js/dashboard-grid.js', 'js/deck-model.js']) {
    vm.runInContext(fs.readFileSync(path.join(SERVER, rel), 'utf8'), ctx, { filename: rel });
  }
  const tile = () => ({ visible: true, page: 'p1', x: 0, y: 0, w: 8, h: 8 });
  const layout = { pages: [{ id: 'p1' }], widgets: { a: tile(), b: tile() } };
  assert.equal(ctx.resolveLayoutOverlaps(layout), true);
  assert.deepEqual({ x: layout.widgets.a.x, y: layout.widgets.a.y }, { x: 0, y: 0 });
  assert.deepEqual({ x: layout.widgets.b.x, y: layout.widgets.b.y }, { x: 8, y: 0 });
  // A new widget on a page with no hole falls back to the first free slot below.
  const full = [{ x: 0, y: 0, w: 24, h: 8 }];
  assert.deepEqual({ ...ctx.placeNewWidget(full, 8, 4, 'p1', false) }, { x: 0, y: 8, w: 8, h: 4 });
  const grid = ctx.window.DashboardGrid;
  assert.deepEqual({ ...grid.firstFreeSlot([{ x: 0, y: 0, w: 4, h: 2 }], 4, 2, 12) }, { x: 4, y: 0 });
  assert.notEqual(grid.firstFreeSlot, ctx.window.DeckModel.firstFreeSlot);
});
