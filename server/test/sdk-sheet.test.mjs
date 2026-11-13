// The questions the host puts for a widget or a tool: may this widget run, copy this, open
// that site, pair that tool. They all open the request window (js/approval-keys.js), and each
// one is a security decision, so what has to stay true is pinned here on the real code:
//  1. Nothing holds a key when it opens. A stray Enter, or one aimed at something else while
//     the window appears, approves nothing.
//  2. Esc, a press outside the card and the quiet key are one answer, and it is No.
//  3. A window that goes lets go of the keyboard: a root removed without that traps Tab and
//     Esc for good.
//  4. One permission question at a time, and a pairing on screen is not one of them.
//  5. A copy happens inside the Copy press, and nowhere else.
//  6. The site's name is what is read, and a long path never pushes it out of sight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom, windowKeys } from './mini-dom.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SRC = read('../js/custom-widget.js');
const STRINGS = {
  cw_by: 'by {a}',
};

function sliceOf(from, to) {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} not found in custom-widget.js`);
  return SRC.slice(start, end);
}

function makeEl(document) {
  return (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
}

// The window pieces for real, on a small DOM. `keys` are the handlers DialogFocus put on window.
function rig() {
  const { document } = makeDom();
  const window = {};
  const keys = windowKeys(window);
  const timers = [];
  const clock = {
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { timers[id - 1] = null; },
  };
  const freezes = [];
  window.ambientFreeze = (token, on) => freezes.push(`${token} ${on}`);
  vm.runInNewContext(read('../js/dialog-focus.js'), { window, document });
  vm.runInNewContext(read('../js/approval-keys.js'), { window, document, ...clock });
  const press = (key) => {
    const ev = { key, preventDefault() {}, stopPropagation() {} };
    keys.slice().forEach((fn) => fn(ev));
  };
  // A press on the scrim: the click lands on the window itself.
  const pressOutside = (root) => root._handlers.click.forEach((fn) => fn({ target: root }));
  return { document, window, keys, press, pressOutside, clock, timers, freezes };
}

function widgets(over = {}) {
  const base = rig();
  const { document, window, clock } = base;
  const saved = [];
  const copies = [];
  const box = {
    window, document, ...clock,
    ApprovalKeys: window.ApprovalKeys,
    el: makeEl(document),
    t: (key, fallback) => STRINGS[key] || fallback,
    packageById: (id) => ({ id, name: 'Nova Clock' }),
    packageIconEl: () => null,
    copyText: async (text) => { copies.push(text); return true; },
    cwForbiddenHost: () => false,
    grantsFor: () => ({}),
    formatUserHost: (v) => String(v),
    parseUserHost: (raw) => (String(raw).trim()
      ? { ok: true, value: String(raw).trim() }
      : { ok: false, error: 'empty' }),
    sdk: () => ({ grants: {}, assign: {} }),
    assignKeyOf: (id) => id,
    persist: (patch) => saved.push(patch),
    paint: () => {},
    syncServiceFrames: () => {},
    approveFromScreen: () => {},
    isLayerPage: () => false,
    hubSettings: { sdkWidgets: { enabled: true }, sdkAiDailyCap: 50 },
    STREAM_LABELS: { system: ['k', 'System sensors (CPU, GPU, RAM)'] },
    ACTION_LABELS: { media: ['k', 'Control media playback'] },
    XenonToast: null,
    URL, Set, Promise, Array, String, Number, Math, Map, Object,
    ...over,
  };
  vm.createContext(box);
  const code = sliceOf('const pendingPermRequests', '// ── Tile rendering');
  vm.runInContext(`${code}\nthis.api = { openPermDialog, closePermDialog, openClipboardConfirm, openExternalConfirm };`, box);
  return { ...base, ...box.api, saved, copies, box };
}

const pkg = (over = {}) => ({ id: 'nova', name: 'Nova Clock', streams: [], actions: [], ...over });
const sheetOf = (document, cls) => document.querySelector(`.ask-overlay.${cls}`);
const mainKey = (root) => root.querySelector('.ask-key.is-main');
const quietKey = (root) => Array.from(root.querySelectorAll('.ask-key')).find((key) => !key.classList.contains('is-main'));
const textOf = (node) => [node.textContent || '', ...(node.children || []).map(textOf)].join(' ');

function pairRig() {
  const base = rig();
  const { document, window, clock } = base;
  const answers = [];
  const handlers = {};
  const fetch = (url, opts) => {
    answers.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ json: () => Promise.resolve({ pairs: [] }) });
  };
  window.location = { hostname: '127.0.0.1' };
  document.readyState = 'complete';
  vm.runInNewContext(read('../js/mcp-dev-client.js'), {
    window, document, fetch, SERVER: '', JSON, Number, Promise, Map, Array, String, Object, ...clock,
    requestAnimationFrame: (fn) => fn(),
  });
  window.McpDev.listen({ addEventListener: (name, fn) => { handlers[name] = fn; } });
  const show = (p) => handlers.mcp_dev_pair({ data: JSON.stringify(p) });
  const done = (id) => handlers.mcp_dev_pair_done({ data: JSON.stringify({ id }) });
  return { ...base, answers, show, done };
}

// ── 1. Nothing holds a key ──────────────────────────────────────────────────

test('a permission question opens with the focus on the window, never on Allow', () => {
  const { document, openPermDialog } = widgets();
  openPermDialog(pkg(), null);
  const root = sheetOf(document, 'cw-perm-backdrop');
  assert.equal(document.activeElement, root);
  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-modal'), 'true');
  assert.equal(root.getAttribute('aria-label'), 'Allow this widget?');
});

test('a copy question opens with the focus on the window, never on Copy', () => {
  const { document, openClipboardConfirm } = widgets();
  openClipboardConfirm({ pkgId: 'nova', label: 'Share link', text: 'abc', secret: false });
  assert.equal(document.activeElement, sheetOf(document, 'cw-clip-backdrop'));
});

test('a site question opens with the focus on the window, never on Open', () => {
  const { document, openExternalConfirm } = widgets();
  openExternalConfirm({ pkgId: 'nova', url: new URL('https://example.com/a') });
  assert.equal(document.activeElement, sheetOf(document, 'cw-ext-backdrop'));
});

test('a pairing opens with the focus on the window, never on Allow', () => {
  const { document, show } = pairRig();
  show({ id: 'p1', name: 'Claude Code' });
  assert.equal(document.activeElement, sheetOf(document, 'cw-pair-backdrop'));
});

test('the main key is the last one, the quiet one sits before it', () => {
  const { document, openPermDialog } = widgets();
  openPermDialog(pkg(), null);
  const keys = sheetOf(document, 'cw-perm-backdrop').querySelectorAll('.ask-key');
  assert.deepEqual(Array.from(keys, (k) => k.textContent), ['Cancel', 'Allow']);
  assert.ok(keys[1].classList.contains('is-main'));
  assert.ok(!keys[0].classList.contains('is-main'));
});

// ── 2. Esc, outside and the quiet key are No ────────────────────────────────

for (const [name, answer] of [
  ['Esc', ({ press }) => press('Escape')],
  ['a press outside', ({ pressOutside }, root) => pressOutside(root)],
  ['the quiet key', (_, root) => quietKey(root).click()],
]) {
  test(`${name} answers no to a permission and saves nothing`, () => {
    const w = widgets();
    let closed = 0;
    let allowed = 0;
    w.openPermDialog(pkg(), null, () => { allowed += 1; }, () => { closed += 1; });
    answer(w, sheetOf(w.document, 'cw-perm-backdrop'));
    assert.equal(sheetOf(w.document, 'cw-perm-backdrop'), null);
    assert.deepEqual([closed, allowed, w.saved.length], [1, 0, 0]);
  });

  test(`${name} answers no to a copy and copies nothing`, async () => {
    const w = widgets();
    const copied = w.openClipboardConfirm({ pkgId: 'nova', label: '', text: 'abc', secret: false });
    answer(w, sheetOf(w.document, 'cw-clip-backdrop'));
    assert.equal(await copied, false);
    assert.equal(w.copies.length, 0);
  });

  test(`${name} answers no to a site`, async () => {
    const w = widgets();
    const opened = w.openExternalConfirm({ pkgId: 'nova', url: new URL('https://example.com/') });
    answer(w, sheetOf(w.document, 'cw-ext-backdrop'));
    assert.equal(await opened, false);
  });

  test(`${name} answers no to a pairing`, () => {
    const w = pairRig();
    w.show({ id: 'p1', name: 'Claude Code' });
    answer(w, sheetOf(w.document, 'cw-pair-backdrop'));
    assert.equal(sheetOf(w.document, 'cw-pair-backdrop'), null);
    const said = w.answers.find((a) => a.url.endsWith('pair/answer'));
    assert.deepEqual(said.body, { id: 'p1', allow: false });
  });
}

test('a press on the card itself answers nothing', () => {
  const { document, openPermDialog } = widgets();
  openPermDialog(pkg(), null);
  const root = sheetOf(document, 'cw-perm-backdrop');
  root._handlers.click.forEach((fn) => fn({ target: root.children[0] }));
  assert.ok(sheetOf(document, 'cw-perm-backdrop'));
});

test('a question nobody answers goes as a no', async () => {
  const w = widgets();
  const copied = w.openClipboardConfirm({ pkgId: 'nova', label: '', text: 'abc', secret: false });
  w.timers.filter(Boolean).forEach((fn) => fn());
  assert.equal(await copied, false);
  assert.equal(sheetOf(w.document, 'cw-clip-backdrop'), null);
});

test('a fresh request takes the place of the one waiting, which is declined', async () => {
  const w = widgets();
  const first = w.openClipboardConfirm({ pkgId: 'nova', label: '', text: 'one', secret: false });
  const second = w.openClipboardConfirm({ pkgId: 'nova', label: '', text: 'two', secret: false });
  assert.equal(await first, false);
  assert.equal(w.document.querySelectorAll('.ask-overlay').length, 1);
  w.press('Escape');
  assert.equal(await second, false);
});

// ── 3. Leaving lets go ──────────────────────────────────────────────────────

test('every way out gives the keyboard back', () => {
  const w = widgets();
  const before = w.document.createElement('button');
  w.document.body.appendChild(before);
  before.focus();
  w.openPermDialog(pkg(), null);
  mainKey(sheetOf(w.document, 'cw-perm-backdrop')).click();
  assert.equal(w.document.activeElement, before);
  let tabbed = false;
  const ev = { key: 'Tab', preventDefault() { tabbed = true; }, stopPropagation() {} };
  w.keys.slice().forEach((fn) => fn(ev));
  assert.equal(tabbed, false, 'Tab still belongs to a window that is gone');
});

test('the window freezes what runs under it, and thaws', () => {
  const w = widgets();
  w.openPermDialog(pkg(), null);
  w.press('Escape');
  assert.deepEqual(w.freezes, ['sdk-perm true', 'sdk-perm false']);
});

// ── 4. One at a time ────────────────────────────────────────────────────────

test('a second permission waits for the first, then opens', () => {
  const w = widgets();
  w.openPermDialog(pkg({ name: 'First' }), null);
  w.openPermDialog(pkg({ name: 'Second' }), null);
  assert.equal(w.document.querySelectorAll('.ask-overlay').length, 1);
  assert.match(textOf(sheetOf(w.document, 'cw-perm-backdrop')), /First/);
  w.press('Escape');
  assert.equal(w.document.querySelectorAll('.ask-overlay').length, 1);
  assert.match(textOf(sheetOf(w.document, 'cw-perm-backdrop')), /Second/);
  w.press('Escape');
  assert.equal(w.document.querySelectorAll('.ask-overlay').length, 0);
});

test('the close callback that opens the next question is not doubled by the queue', () => {
  const w = widgets();
  w.openPermDialog(pkg({ name: 'Queued' }), null);
  w.openPermDialog(pkg({ name: 'First' }), null, null, () => {});
  w.press('Escape');
  w.press('Escape');
  assert.equal(w.document.querySelectorAll('.ask-overlay').length, 0);
});

test('Allow saves the grant with what the widget declared', () => {
  const w = widgets();
  let allowed = 0;
  let closed = 0;
  w.openPermDialog(pkg({ streams: ['system'] }), 'tile1', () => { allowed += 1; }, () => { closed += 1; });
  mainKey(sheetOf(w.document, 'cw-perm-backdrop')).click();
  assert.deepEqual([allowed, closed], [1, 1]);
  assert.equal(w.saved.length, 1);
  assert.equal(w.saved[0].assign.tile1, 'nova');
  assert.equal(JSON.stringify(w.saved[0].grants.nova.streams), '["system"]');
  assert.equal(sheetOf(w.document, 'cw-perm-backdrop'), null);
});

// ── 5. The copy ─────────────────────────────────────────────────────────────

test('the copy happens in the press on Copy, with the text, and only there', async () => {
  const w = widgets();
  const copied = w.openClipboardConfirm({ pkgId: 'nova', label: 'Link', text: 'abc', secret: false });
  assert.equal(w.copies.length, 0, 'opening the question copies nothing');
  mainKey(sheetOf(w.document, 'cw-clip-backdrop')).click();
  assert.deepEqual(w.copies, ['abc']);
  assert.equal(await copied, true);
  assert.equal(sheetOf(w.document, 'cw-clip-backdrop'), null);
});

test('a secret stays masked until asked, and Show gives it back', () => {
  const { document, openClipboardConfirm } = widgets();
  openClipboardConfirm({ pkgId: 'nova', label: 'Password', text: 'hunter2', secret: true });
  const root = sheetOf(document, 'cw-clip-backdrop');
  const value = root.querySelector('.cw-clip-val');
  assert.doesNotMatch(value.textContent, /hunter2/);
  root.querySelector('.cw-clip-eye').click();
  assert.equal(value.textContent, 'hunter2');
  root.querySelector('.cw-clip-eye').click();
  assert.doesNotMatch(value.textContent, /hunter2/);
});

test('a value that is no secret is shown whole, with no eye', () => {
  const { document, openClipboardConfirm } = widgets();
  openClipboardConfirm({ pkgId: 'nova', label: 'Code', text: '123 456', secret: false });
  const root = sheetOf(document, 'cw-clip-backdrop');
  assert.equal(root.querySelector('.cw-clip-val').textContent, '123 456');
  assert.equal(root.querySelector('.cw-clip-eye'), null);
});

// ── 6. The site ─────────────────────────────────────────────────────────────

test('the host stands alone and the path under it is cut, so the name stays in sight', () => {
  const { document, openExternalConfirm } = widgets();
  openExternalConfirm({ pkgId: 'nova', url: new URL(`https://status.example.com/${'a'.repeat(300)}`) });
  const root = sheetOf(document, 'cw-ext-backdrop');
  assert.equal(root.querySelector('.cw-ext-host').textContent, 'status.example.com');
  const path = root.querySelector('.cw-ext-path').textContent;
  assert.equal(path.length, 121);
  assert.ok(path.endsWith('…'));
});

test('a bare address has no path line', () => {
  const { document, openExternalConfirm } = widgets();
  openExternalConfirm({ pkgId: 'nova', url: new URL('https://example.com/') });
  assert.equal(sheetOf(document, 'cw-ext-backdrop').querySelector('.cw-ext-path'), null);
});

// ── What the permission question says ───────────────────────────────────────

test('author and version read as words, in a list of plain lines', () => {
  const { document, openPermDialog } = widgets();
  openPermDialog(pkg({ author: 'Ada Rossi', version: '1.2.0', streams: ['system', 'unknown'], actions: ['media'] }), null);
  const root = sheetOf(document, 'cw-perm-backdrop');
  const line = root.querySelector('.ask-line');
  assert.match(textOf(line), /Nova Clock/);
  assert.match(textOf(line), /by Ada Rossi, v1\.2\.0/);
  assert.doesNotMatch(textOf(root), / · /);
  const items = Array.from(root.querySelectorAll('.cw-perm-items li'), (n) => n.textContent);
  assert.deepEqual(items, ['System sensors (CPU, GPU, RAM)', 'unknown', 'Control media playback']);
});

test('every capability is named, and a widget asking for one is never called Nothing', () => {
  for (const flag of ['storage', 'secrets', 'island', 'islandDynamic', 'islandFull', 'badge', 'badgeAction', 'mini', 'topbarButton', 'clipboard', 'ai', 'accent', 'expand']) {
    const { document, openPermDialog } = widgets();
    openPermDialog(pkg({ [flag]: true }), null);
    const root = sheetOf(document, 'cw-perm-backdrop');
    assert.equal(root.querySelectorAll('.cw-perm-sec').length, 1, `${flag} has its line`);
    assert.equal(root.querySelector('.cw-perm-nothing'), null, `${flag} is not nothing`);
  }
});

test('a widget that asks for nothing is told so', () => {
  const { document, openPermDialog } = widgets();
  openPermDialog(pkg(), null);
  assert.ok(sheetOf(document, 'cw-perm-backdrop').querySelector('.cw-perm-nothing'));
});

test('text from a manifest stays text', () => {
  const { document, openPermDialog } = widgets();
  const name = '<img src=x onerror=alert(1)>';
  openPermDialog(pkg({ name, description: name, author: name, hosts: [name] }), null);
  const root = sheetOf(document, 'cw-perm-backdrop');
  assert.ok(root.querySelector('.ask-line').querySelectorAll('img').length === 0);
  assert.equal(root.querySelector('.cw-perm-desc').textContent, name);
});

test('turning the switch on is said beside the keys, and done by the same press', () => {
  const w = widgets({ hubSettings: { sdkWidgets: { enabled: false } } });
  w.openPermDialog(pkg(), null);
  const root = sheetOf(w.document, 'cw-perm-backdrop');
  assert.match(root.querySelector('.ask-foot .ask-note').textContent, /also turns on community widgets/);
  mainKey(root).click();
  assert.equal(w.saved[0].enabled, true);
});

test('with the switch on the foot holds only the keys', () => {
  const { document, openPermDialog } = widgets();
  openPermDialog(pkg(), null);
  assert.equal(sheetOf(document, 'cw-perm-backdrop').querySelector('.ask-foot .ask-note'), null);
});

test('a phone cannot give permissions: it says where, and Allow stays off', () => {
  const w = widgets();
  w.window.__xenonRemote = true;
  w.openPermDialog(pkg(), null);
  const root = sheetOf(w.document, 'cw-perm-backdrop');
  assert.match(root.querySelector('.ask-note').textContent, /Approve it on the PC/);
  assert.equal(mainKey(root).disabled, true);
});

test('Allow waits for every address the widget needs', () => {
  const w = widgets();
  w.openPermDialog(pkg({ userHosts: [{ id: 'nas', label: 'Your NAS', scope: 'private' }] }), null);
  const root = sheetOf(w.document, 'cw-perm-backdrop');
  const input = root.querySelector('.cw-perm-input');
  assert.equal(mainKey(root).disabled, true);
  input.value = '192.168.1.50';
  input._handlers.input.forEach((fn) => fn({}));
  assert.equal(mainKey(root).disabled, false);
  mainKey(root).click();
  assert.equal(w.saved[0].grants.nova.userHosts.nas, '192.168.1.50');
});

// ── The pairing ─────────────────────────────────────────────────────────────

test('Allow answers yes to the pairing it shows, once', () => {
  const w = pairRig();
  w.show({ id: 'p1', name: 'Claude Code' });
  w.show({ id: 'p1', name: 'Claude Code' });
  assert.equal(w.document.querySelectorAll('.ask-overlay').length, 1);
  mainKey(sheetOf(w.document, 'cw-pair-backdrop')).click();
  assert.equal(sheetOf(w.document, 'cw-pair-backdrop'), null);
  const said = w.answers.filter((a) => a.url.endsWith('pair/answer'));
  assert.equal(said.length, 1);
  assert.deepEqual(said[0].body, { id: 'p1', allow: true });
});

test('a pairing the server closed leaves the screen and lets go', () => {
  const w = pairRig();
  w.show({ id: 'p1', name: 'Claude Code' });
  w.done('p1');
  assert.equal(sheetOf(w.document, 'cw-pair-backdrop'), null);
  let tabbed = false;
  const ev = { key: 'Tab', preventDefault() { tabbed = true; }, stopPropagation() {} };
  w.keys.slice().forEach((fn) => fn(ev));
  assert.equal(tabbed, false);
});

test('a pairing the server forgets goes when its time is up', () => {
  const w = pairRig();
  w.show({ id: 'p1', name: 'Claude Code', expiresInMs: 1000 });
  w.timers.filter(Boolean).forEach((fn) => fn());
  assert.equal(sheetOf(w.document, 'cw-pair-backdrop'), null);
});

test('the pairing is not a permission question, so it never parks one', () => {
  assert.doesNotMatch(read('../js/mcp-dev-client.js'), /cw-perm-backdrop/);
});

// ── Every page that can ask ─────────────────────────────────────────────────

test('every page that runs widgets has the window, and the code it needs loads once', async () => {
  for (const page of ['index.html', 'layer-lite.html', 'scene.html', 'sdk-service.html']) {
    const html = read(`../${page}`);
    assert.match(html, /js\/custom-widget\.js/, page);
    assert.equal((html.match(/js\/dialog-focus\.js/g) || []).length, 1, `${page}: dialog-focus`);
    assert.equal((html.match(/js\/approval-keys\.js/g) || []).length, 1, `${page}: approval-keys`);
  }
  for (const page of ['index.html', 'layer-lite.html', 'scene.html']) {
    const html = read(`../${page}`);
    assert.match(html, /components\/AskSheet\/AskSheet\.css/, page);
    assert.match(html, /styles\/liquid-sheets\.css/, page);
    assert.ok(html.indexOf('styles/liquid-sheets.css') > html.indexOf('styles/themes-comic.css'), `${page}: the glass comes after the skins`);
  }
});

test('a tile that also lists those files does not load them twice in a layer window', async () => {
  const { createRequire } = await import('node:module');
  const LayerPage = createRequire(import.meta.url)('../layer-page.js');
  const page = LayerPage.compose(read('../layer-lite.html'), ['weather'], read('../index.html'));
  assert.match(page, /data-layer-tiles="weather"/);
  for (const file of ['js/dialog-focus.js', 'styles/liquid-sheets.css']) {
    assert.equal(page.split(file).length - 1, 1, file);
  }
});
