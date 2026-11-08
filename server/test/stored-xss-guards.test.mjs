// Stored values that reach the dashboard's markup.
//
// The dashboard is served from the same origin as /actions/run and every API
// key, so one injected script there can do anything Xenon can. These values
// arrive from places the page does not control — a restored backup, a settings
// write, the window helper, the audio mixer, the assistant's own text — and
// each of them used to be written into HTML: an icon or preview data URI in
// <img src="…">, a window / timer / note id inside an inline onclick="…('id')",
// a link URL that the inline-code pass had already turned into markup. Each
// test below pins the fix for one of them, by running the real function where
// that is practical and by reading the source where it is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import { makeDom } from './mini-dom.mjs';

const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SERVER = read('../server.js');
const UTILS = read('../js/utils.js');

// A top-level function's source, from "function name(" to its closing brace.
function fnSource(src, name) {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, name + ' not found');
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}
const constLine = (src, name) => {
  const m = src.match(new RegExp(`^const ${name} = .*$`, 'm'));
  assert.ok(m, name + ' not found');
  return m[0] + '\n';
};

// The client helpers every module below uses.
const CLIENT_HELPERS = fnSource(UTILS, 'escHtml') + constLine(UTILS, 'SAFE_IMAGE_DATA_URI_RE') + fnSource(UTILS, 'safeImageDataUri');
const helpers = new Function(CLIENT_HELPERS + 'return { escHtml, safeImageDataUri, SAFE_IMAGE_DATA_URI_RE };')();

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
const EVIL_SRC = 'data:image/png;base64,AAAA" onerror="alert(document.domain)';
const EVIL_ID = `x');fetch('/actions/run',{method:'POST'});('`;

// ── The data URI check ───────────────────────────────────────────────────────
test('safeImageDataUri accepts the helpers\' PNGs and nothing that could leave an attribute', () => {
  const { safeImageDataUri } = helpers;
  assert.equal(safeImageDataUri(PNG), PNG);
  for (const ok of ['data:image/jpeg;base64,/9j/4AAQ', 'data:image/gif;base64,R0lGOD==', 'data:image/webp;base64,UklG', 'data:image/x-icon;base64,AAAB', 'data:image/bmp;base64,Qk0=']) {
    assert.equal(safeImageDataUri(ok), ok);
  }
  for (const bad of [
    EVIL_SRC,
    'data:image/svg+xml;base64,PHN2Zz4=',          // SVG can carry script
    'data:image/png,<svg onload=alert(1)>',         // not base64
    'data:image/png;base64,AAAA\n',                 // trailing junk
    'data:image/png;base64,AAAA===',                // over-padded
    'javascript:alert(1)',
    'https://example.com/icon.png',
    '', null, undefined, 42, { toString: () => PNG },
  ]) {
    assert.equal(safeImageDataUri(bad), '', String(bad));
  }
});

test('the server and the dashboard use the identical pattern', () => {
  assert.equal(constLine(SERVER, 'SAFE_IMAGE_DATA_URI_RE'), constLine(UTILS, 'SAFE_IMAGE_DATA_URI_RE'));
});

test('appFavorites: the server drops a crafted icon (settings write or backup)', () => {
  const normalize = new Function(constLine(SERVER, 'SAFE_IMAGE_DATA_URI_RE') + fnSource(SERVER, 'normalizeServerAppFavorites') + 'return normalizeServerAppFavorites;')();
  const out = normalize([
    { key: 'a', app: 'a', icon: EVIL_SRC },
    { key: 'b', app: 'b', icon: PNG },
    { key: 'c', app: 'c', icon: 'data:image/png;base64,' + 'A'.repeat(70000) },
  ]);
  assert.equal(out[0].icon, '');
  assert.equal(out[1].icon, PNG);
  assert.equal(out[2].icon, '', 'over the bound is dropped, not truncated');
});

// ── App switcher ─────────────────────────────────────────────────────────────
// A host whose innerHTML is kept as a string, and whose <img data-img-slot>
// placeholders become objects fillImgSlots can set a src on.
function makeHost() {
  return {
    _html: '', slots: [], handlers: {},
    classList: { add() {}, remove() {} },
    set innerHTML(v) {
      this._html = String(v);
      const n = (this._html.match(/data-img-slot/g) || []).length;
      this.slots = Array.from({ length: n }, () => ({ src: '', removeAttribute() {} }));
    },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) { return sel === 'img[data-img-slot]' ? this.slots : []; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    contains() { return true; },
  };
}

function loadAppSwitcher() {
  const list = makeHost();
  const dock = makeHost();
  const fetched = [];
  const ctx = {
    appWindows: [], appFavorites: [], appWindowsLoading: false, appWindowsError: false,
    t: (k) => k, prettyAppName: (s) => String(s || ''), appWindowKey: (w) => String((w && w.app) || '').toLowerCase(),
    localStorage: { setItem() {} },
    document: { getElementById: (id) => (id === 'app-list' ? list : id === 'app-favorites' ? dock : null) },
    fetch: async (url, opts) => { fetched.push({ url, body: opts && opts.body }); return { ok: true, json: async () => ({}) }; },
    setTimeout: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_HELPERS + read('../js/app-switcher.js'), ctx);
  return { ctx, list, dock, fetched };
}

test('app switcher: ids, icons and previews never enter the markup', () => {
  const { ctx, list } = loadAppSwitcher();
  ctx.appWindows = [
    { id: EVIL_ID, app: 'evil', title: 't', icon: EVIL_SRC, preview: EVIL_SRC },
    { id: '0x1234', app: 'good', title: 't', icon: PNG, preview: PNG },
  ];
  ctx.renderAppWindows();
  const html = list.innerHTML;
  assert.doesNotMatch(html, /onclick|onkeydown|onerror/i, 'no inline handlers at all');
  assert.ok(!html.includes(EVIL_ID) && !html.includes('fetch('), 'the window id is not in the markup');
  assert.ok(!html.includes('base64,'), 'no image data in the markup');
  // The evil window falls back to its initial (both its images are rejected);
  // the good one gets its preview and its icon, set through the DOM.
  assert.deepEqual(list.slots.map((s) => s.src), [PNG, PNG]);
});

test('app switcher: a click runs the action with the exact window id', async () => {
  const { ctx, list, fetched } = loadAppSwitcher();
  ctx.appWindows = [{ id: EVIL_ID, app: 'evil', title: 't' }];
  ctx.renderAppWindows();
  const card = { dataset: { winIndex: '0' } };
  const target = { closest: (sel) => (sel === '.app-card' ? card : null) };
  list.handlers.click({ target, preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetched[0].url, '/windows/focus');
  assert.deepEqual(JSON.parse(fetched[0].body), { id: EVIL_ID }, 'the id is data, not code');
});

test('app switcher: the favorites dock sets icons through the DOM', () => {
  const { ctx, dock } = loadAppSwitcher();
  ctx.appFavorites = [{ key: 'a', app: 'a', icon: EVIL_SRC, path: 'x' }, { key: 'b', app: 'b', icon: PNG, path: 'y' }];
  ctx.renderAppFavorites();
  assert.ok(!dock.innerHTML.includes('base64,'));
  assert.deepEqual(dock.slots.map((s) => s.src), [PNG]);
});

// ── Audio mixer ──────────────────────────────────────────────────────────────
test('mixer: the app icon is set through the DOM, never interpolated', () => {
  const rows = [];
  const host = {
    set innerHTML(v) {
      rows.length = 0;
      String(v).split('<div class="app-mix-row').slice(1).forEach((chunk) => {
        const img = chunk.includes('<img class="app-mix-icon"') ? { src: '' } : null;
        rows.push({ chunk, img, querySelector: (sel) => (sel === 'img.app-mix-icon' ? img : null) });
      });
      this._html = String(v);
    },
    get innerHTML() { return this._html; },
    querySelectorAll: (sel) => (sel === '.app-mix-row' ? rows : []),
    closest: () => null,
  };
  const ctx = { setInterval: () => 0, document: { getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_HELPERS + read('../js/volume.js'), ctx);
  ctx.renderAppMixerRows(host, [
    { id: 'a', proc: 'a.exe', name: 'A', icon: EVIL_SRC, volume: 50 },
    { id: 'b', proc: 'b.exe', name: 'B', icon: PNG, volume: '70"><img src=x onerror=alert(1)>' },
  ]);
  assert.ok(!host.innerHTML.includes('onerror') && !host.innerHTML.includes('base64,'));
  assert.equal(rows[0].img, null, 'a rejected icon falls back to the letter');
  assert.equal(rows[1].img.src, PNG);
  assert.match(read('../js/mic.js'), /renderAppMixerRows\(host, apps\)/);
  assert.match(read('../js/deck.js'), /renderAppMixerRows\(host, apps\)/);
});

// ── Timers and notes ─────────────────────────────────────────────────────────
test('timer cards: no inline handlers; one delegated listener runs the action by id', async () => {
  const dom = makeDom();
  const docHandlers = {};
  dom.document.addEventListener = (type, fn) => { docHandlers[type] = fn; };
  const fetched = [];
  const ctx = {
    document: dom.document, t: () => '', requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    fetch: (url, opts) => { fetched.push({ url, opts }); return Promise.resolve({ json: async () => ({}) }); },
  };
  vm.createContext(ctx);
  vm.runInContext(read('../js/timer.js'), ctx);
  const card = ctx._buildTimerCard({ id: 't1700000000000-abc', label: 'Tea', kind: 'countdown', durationSecs: 60, status: 'running', startedAt: Date.now(), pausedElapsed: 3 });
  assert.doesNotMatch(card.innerHTML, /onclick/);
  assert.match(card.innerHTML, /data-timer-action="pause"/);
  assert.equal(card.dataset.timerId, 't1700000000000-abc');

  ctx._wireTimerActions();
  const btn = {
    dataset: { timerAction: 'pause' },
    closest: (sel) => (sel === '.timer-card' ? { dataset: { timerId: EVIL_ID } } : null),
  };
  docHandlers.click({ target: { closest: (sel) => (sel === '.timer-card [data-timer-action]' ? btn : null) } });
  assert.equal(fetched[0].url, '/api/timers/' + encodeURIComponent(EVIL_ID));
  assert.equal(JSON.parse(fetched[0].opts.body).action, 'pause');
  // An unknown action name is ignored rather than looked up on the prototype.
  btn.dataset.timerAction = 'constructor';
  docHandlers.click({ target: { closest: () => btn } });
  assert.equal(fetched.length, 1);
});

test('notes tabs: selected through data-note-id, not an inline handler', () => {
  const NOTES = read('../js/notes.js');
  assert.doesNotMatch(NOTES, /setAttribute\('onclick', `notesSelect/);
  assert.match(NOTES, /closest\('\.notes-tab\[data-note-id\]'\)/);
  assert.match(fnSource(NOTES, 'renderNotesInto'), /_wireNotesTabs\(\)/);
});

test('server: note and timer ids are limited to [A-Za-z0-9_-]{1,80}', () => {
  const ID_RE = constLine(SERVER, 'SAFE_ITEM_ID_RE');
  const notes = new Function('const NOTES_MAX = 50, NOTE_BODY_MAX = 1e5, NOTES_TOTAL_MAX = 1e6;\n'
    + fnSource(SERVER, '_noteId') + ID_RE + fnSource(SERVER, 'normalizeNotesState') + 'return { normalizeNotesState, _noteId };')();
  const timers = new Function("const TIMER_KINDS = ['countdown', 'stopwatch'], SCOPED_LABEL_MAX = 67;\n" + ID_RE
    + fnSource(SERVER, '_timerId') + fnSource(SERVER, '_normalizeTimer') + 'return { _normalizeTimer, _timerId };')();
  const re = /^[A-Za-z0-9_-]{1,80}$/;

  // What the app mints already fits, so nothing existing is renamed.
  assert.match(notes._noteId(), re);
  assert.match(timers._timerId(), re);
  const st = notes.normalizeNotesState({ activeId: 'nabc123', notes: [{ id: 'nabc123', body: 'keep' }, { id: EVIL_ID, body: 'x' }, { id: 'a"b', body: 'y' }] });
  assert.equal(st.notes[0].id, 'nabc123');
  assert.equal(st.activeId, 'nabc123');
  for (const n of st.notes) assert.match(n.id, re);
  assert.notEqual(st.notes[1].id, EVIL_ID);

  assert.equal(timers._normalizeTimer({ id: 't1-ab', label: 'x' }).id, 't1-ab');
  const bad = timers._normalizeTimer({ id: EVIL_ID, label: 'x' });
  assert.match(bad.id, re);
  assert.match(timers._normalizeTimer({ label: 'x' }).id, re);
});

// ── Assistant markdown ───────────────────────────────────────────────────────
const AI = read('../js/ai.js');
const md = new Function(['_escHtmlAI', '_aiSafeLinkScheme', '_inlineEmphasis', '_inlineMarkdown', '_aiRenderMarkdown']
  .map((n) => fnSource(AI, n)).join('') + 'return { _inlineMarkdown, _aiRenderMarkdown };')();

// Every <a …> must carry exactly the four attributes the renderer writes.
function anchorsAreClean(html) {
  const tags = html.match(/<a\b[^>]*>/g) || [];
  return tags.every((tag) => /^<a href="[^"<>]*" target="_blank" rel="noopener" class="ai-link">$/.test(tag));
}

test('markdown: a code span inside a link URL cannot add attributes to the anchor', () => {
  for (const evil of [
    '[click](https://x.example/`" onmouseover="alert(1)`)',
    '[click](https://x.example/`a` onfocus=alert(1) autofocus `b`)',
    '[click](https://x.example/_a_" onclick="alert(1)_b_)',
    '[click](https://x.example/**" style="x**)',
  ]) {
    const html = md._inlineMarkdown(evil);
    assert.ok(anchorsAreClean(html), html);
    assert.doesNotMatch(html, /<[^>]+\son\w+=/i, html);
  }
});

test('markdown: what the renderer supports still renders', () => {
  assert.equal(md._inlineMarkdown('**b** *i* `c` _u_'),
    '<strong>b</strong> <em>i</em> <code class="ai-inline-code">c</code> <em>u</em>');
  assert.equal(md._inlineMarkdown('see [**Docs**](https://ex.com/a_b_c) now'),
    'see <a href="https://ex.com/a_b_c" target="_blank" rel="noopener" class="ai-link"><strong>Docs</strong></a> now',
    'underscores in a URL stay a URL');
  assert.match(md._inlineMarkdown('[mail](mailto:a@b.c)'), /href="mailto:a@b\.c"/);
  // The URL ends at the first ")", so the second one stays as text.
  assert.equal(md._inlineMarkdown('[x](javascript:alert(1))'), 'x (javascript:alert(1))');
  assert.equal(md._inlineMarkdown('[x](data:text/html,hi)'), 'x (data:text/html,hi)', 'the "label (url)" fallback');
  const block = md._aiRenderMarkdown('## Title\n- one\n- two\n1. first\n---\ntext');
  assert.match(block, /<h2 class="ai-h3">Title<\/h2>/);
  assert.match(block, /<ul class="ai-ul"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(block, /<ol class="ai-ol"><li>first<\/li><\/ol>/);
  assert.match(block, /<hr class="ai-hr">/);
});

// ── Legacy iCUE widget ───────────────────────────────────────────────────────
test('iCUE widget: the album art <img> is built with the DOM', () => {
  const MEDIA = readFileSync(new URL('../../widget/modules/media.js', import.meta.url), 'utf8');
  assert.doesNotMatch(MEDIA, /src="\$\{m\.thumbnail\}"/);
  assert.match(MEDIA, /img\.src = String\(m\.thumbnail\)/);
});
