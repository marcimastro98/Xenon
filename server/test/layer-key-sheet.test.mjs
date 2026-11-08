// The confirm sheet of a Deck key placed on the screen. Allow agrees to every step,
// so it stays off until the steps have been on the screen right to their end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/layer-key.js', import.meta.url), 'utf8');
const ARM_MS = 600;

function element(tag) {
  const listeners = {};
  const classes = new Set();
  const el = {
    tag, children: [], dataset: {}, style: { setProperty() {}, removeProperty() {} },
    textContent: '', disabled: false, title: '', tabIndex: -1,
    scrollTop: 0, clientHeight: 100, scrollHeight: 100,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    set className(v) { classes.clear(); String(v).split(' ').filter(Boolean).forEach((c) => classes.add(c)); },
    get className() { return [...classes].join(' '); },
    setAttribute() {},
    append: (...kids) => el.children.push(...kids),
    appendChild: (kid) => { el.children.push(kid); return kid; },
    remove: () => { el.gone = true; },
    focus: () => { el.focused = (el.focused || 0) + 1; },
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    fire: (name, e = { isTrusted: true }) => (listeners[name] || []).forEach((fn) => fn(e)),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44 }),
    querySelector: (sel) => el.children.find((k) => k.classList.contains(sel.slice(1))) || null,
  };
  return el;
}

const find = (root, cls) => {
  if (root.classList.contains(cls)) return root;
  for (const kid of root.children) {
    const hit = typeof kid === 'object' ? find(kid, cls) : null;
    if (hit) return hit;
  }
  return null;
};

// The page's clock is ours, and a real tap is the only thing that reaches the sheet.
function boot({ overflow }) {
  const body = element('body');
  const timers = [];
  const made = [];
  const document = {
    body,
    head: element('head'),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = element(tag);
      if (tag === 'ol' && overflow) el.scrollHeight = 400;
      made.push(el);
      return el;
    },
  };
  const window = { innerWidth: 1440, innerHeight: 900, LayerHost: { editing: () => false } };
  const posts = [];
  const shown = { ok: true, state: 'confirm', fp: 'a'.repeat(32), title: 'Lights', does: [{ type: 'dnd', label: '' }] };
  const fetch = async (_url, opts) => {
    if (opts && opts.body) posts.push(JSON.parse(opts.body));
    const reply = opts && JSON.parse(opts.body).accept ? { ok: true } : (opts ? { ok: false, error: 'key_changed' } : shown);
    return { json: async () => reply };
  };
  vm.runInNewContext(SRC, {
    window, document, fetch, encodeURIComponent, WeakMap, Object, String,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  const passTime = () => timers.splice(0).forEach((t) => t.fn());
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { window, body, posts, passTime, settle };
}

async function openConfirm(h) {
  const node = h.window.LayerKey.atom({ id: 'lw_1' });
  await h.settle();
  node.children[0].fire('click');
  await h.settle();
  const sheet = h.body.children.at(-1);
  return {
    sheet,
    key: node.children[0],
    allow: find(sheet, 'layer-key-sheet-go'),
    list: find(sheet, 'layer-key-steps'),
    hint: find(sheet, 'layer-key-sheet-hint'),
  };
}

test('a list that fits arms Allow after the pause alone', async () => {
  const h = boot({ overflow: false });
  const { allow, hint } = await openConfirm(h);
  assert.equal(allow.disabled, true, 'a double tap on the key must not land on Allow');
  h.passTime();
  assert.equal(allow.disabled, false);
  assert.match(hint.textContent, /next tap/);
});

test('a list too long for the sheet keeps Allow off until it is read to its end', async () => {
  const h = boot({ overflow: true });
  const { allow, list, hint } = await openConfirm(h);
  h.passTime();
  assert.equal(allow.disabled, true, 'time alone never agrees to steps nobody saw');
  assert.match(hint.textContent, /Scroll to the end/);
  assert.equal(list.tabIndex, 0);

  list.scrollTop = 150;
  list.fire('scroll');
  assert.equal(allow.disabled, true, 'halfway is not the end');

  list.scrollTop = 300;
  list.fire('scroll');
  assert.equal(allow.disabled, false);
  assert.match(hint.textContent, /next tap/);

  list.scrollTop = 0;
  list.fire('scroll');
  assert.equal(allow.disabled, false, 'going back up to reread takes nothing away');
});

test('reading to the end during the pause still waits for the pause', async () => {
  const h = boot({ overflow: true });
  const { allow, list } = await openConfirm(h);
  list.scrollTop = 300;
  list.fire('scroll');
  assert.equal(allow.disabled, true);
  h.passTime();
  assert.equal(allow.disabled, false);
});

test('only a real tap on Allow agrees', async () => {
  const h = boot({ overflow: false });
  const { allow } = await openConfirm(h);
  h.passTime();
  allow.fire('click', { isTrusted: false });
  await h.settle();
  assert.equal(h.posts.filter((p) => p.accept).length, 0);
  allow.fire('click');
  await h.settle();
  assert.deepEqual(h.posts.filter((p) => p.accept), [{ id: 'lw_1', accept: 'a'.repeat(32) }]);
});

test('Cancel on the left, Allow on the right, as in every other window', async () => {
  const h = boot({ overflow: false });
  const { sheet } = await openConfirm(h);
  const keys = find(sheet, 'layer-key-sheet-row').children;
  assert.ok(keys[0].classList.contains('layer-key-sheet-no'));
  assert.ok(keys[1].classList.contains('layer-key-sheet-go'));
});

test('the keyboard lands on the sheet, never on Allow, and goes back to the key', async () => {
  const h = boot({ overflow: false });
  const { sheet, allow, key } = await openConfirm(h);
  h.passTime();
  assert.equal(sheet.tabIndex, -1);
  assert.equal(sheet.focused, 1, 'Esc is heard on the sheet, so the sheet needs the keyboard');
  assert.equal(allow.focused, undefined, 'a stray Enter must agree to nothing');
  sheet.fire('keydown', { key: 'Escape' });
  assert.equal(sheet.gone, true);
  assert.equal(key.focused, 1);
});

test('the pause in the test is the pause in the file', () => {
  assert.match(SRC, new RegExp(`ARM_MS = ${ARM_MS}`));
});
