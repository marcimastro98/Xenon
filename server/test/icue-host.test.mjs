import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The dashboard's half of typing inside the iCUE widget (js/icue-host.js):
// framed, it tells the parent when a text field takes focus, and only then.
const require = createRequire(import.meta.url);
const H = require('../js/icue-host.js');

const el = (tagName, extra = {}) => ({ tagName, ...extra });

test('text fields need the keyboard, the same set iCUE uses', () => {
  assert.equal(H.needsKeyboard(el('TEXTAREA')), true);
  assert.equal(H.needsKeyboard(el('DIV', { isContentEditable: true })), true);
  for (const type of ['', 'text', 'search', 'email', 'password', 'number', 'url', 'TEXT']) {
    assert.equal(H.needsKeyboard(el('INPUT', { type })), true, `input type="${type}"`);
  }
});

test('buttons, toggles and sliders do not take the keyboard', () => {
  for (const type of ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']) {
    assert.equal(H.needsKeyboard(el('INPUT', { type })), false, `input type="${type}"`);
  }
  assert.equal(H.needsKeyboard(el('BUTTON')), false);
  assert.equal(H.needsKeyboard(el('IFRAME')), false);
  assert.equal(H.needsKeyboard(null), false);
  assert.equal(H.needsKeyboard({}), false);
});

function fakeWindow({ framed, topThrows = false }) {
  const sent = [];
  const listeners = {};
  const win = {
    location: { href: 'http://127.0.0.1:3030/', origin: 'http://127.0.0.1:3030' },
    document: { addEventListener: (type, fn) => { listeners['doc:' + type] = fn; } },
    addEventListener: (type, fn) => { listeners['win:' + type] = fn; },
    parent: { postMessage: (msg, target) => sent.push({ msg, target }) },
  };
  win.self = win;
  Object.defineProperty(win, 'top', {
    get() { if (topThrows) throw new Error('cross-origin'); return framed ? {} : win; },
  });
  return { win, sent, listeners };
}

test('a top-level dashboard sends nothing and listens to nothing', () => {
  const { win, sent, listeners } = fakeWindow({ framed: false });
  H.install(win);
  assert.deepEqual(sent, []);
  assert.deepEqual(listeners, {});
});

test('framed, it says hello, then reports text-field focus and nothing else', () => {
  const { win, sent, listeners } = fakeWindow({ framed: true });
  H.install(win);
  assert.deepEqual(sent, [{ msg: { type: H.HELLO }, target: '*' }]);
  listeners['doc:focusin']({ target: el('INPUT', { type: 'checkbox' }) });
  listeners['doc:focusin']({ target: el('BUTTON') });
  assert.equal(sent.length, 1);
  listeners['doc:focusin']({ composedPath: () => [el('TEXTAREA')], target: el('DIV') });
  assert.deepEqual(sent[1], { msg: { type: H.KEYBOARD }, target: '*' });
});

test('a cross-origin parent (top throws) counts as framed', () => {
  const { win, sent } = fakeWindow({ framed: true, topThrows: true });
  H.install(win);
  assert.equal(sent.length, 1);
});

test('loaded as a page script it installs itself and stays out of the global scope', () => {
  const { win, sent } = fakeWindow({ framed: true });
  const src = readFileSync(new URL('../js/icue-host.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({ self: win });
  vm.runInContext(src, ctx);
  assert.equal(sent.length, 1);
  assert.equal(ctx.needsKeyboard, undefined);
});

test('index.html loads it', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="js\/icue-host\.js"><\/script>/);
});

test('only web links leave the dashboard', () => {
  const base = 'http://127.0.0.1:3030/';
  assert.equal(H.webUrl('https://www.buymeacoffee.com/x', base), 'https://www.buymeacoffee.com/x');
  assert.equal(H.webUrl('/settings', base), 'http://127.0.0.1:3030/settings');
  assert.equal(H.webUrl('javascript:alert(1)', base), null);
  assert.equal(H.webUrl('data:text/html,hi', base), null);
  assert.equal(H.webUrl('ms-settings:display', base), null);
  assert.equal(H.webUrl('http://[bad', base), null);
});

const anchor = (href, target = '') => ({ getAttribute: () => href, target, closest() { return this; } });
const click = (a) => { const e = { target: a, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; return e; };

test('links stay untouched until the parent says it is the Xenon widget', () => {
  const { win, sent, listeners } = fakeWindow({ framed: true });
  const nativeOpen = () => 'native';
  win.open = nativeOpen;
  H.install(win);
  assert.equal(win.open, nativeOpen);
  assert.equal(listeners['doc:click'], undefined);
  // A message from anyone but the parent is ignored.
  listeners['win:message']({ source: {}, data: { type: H.WIDGET } });
  assert.equal(win.open, nativeOpen);
  assert.equal(sent.length, 1);
});

test('inside the Xenon widget, window.open and leaving links go to the widget', () => {
  const { win, sent, listeners } = fakeWindow({ framed: true });
  H.install(win);
  listeners['win:message']({ source: win.parent, data: { type: H.WIDGET } });
  assert.deepEqual(sent.at(-1), { msg: { type: H.READY }, target: '*' });
  assert.equal(win.open('https://discord.gg/abc', '_blank', 'noopener'), null);
  assert.deepEqual(sent.at(-1), { msg: { type: H.OPEN, url: 'https://discord.gg/abc' }, target: '*' });
  win.open('javascript:alert(1)');
  assert.equal(sent.length, 3);

  const out = click(anchor('https://github.com/marcimastro98/Xenon'));
  listeners['doc:click'](out);
  assert.equal(out.defaultPrevented, true);
  assert.equal(sent.at(-1).msg.url, 'https://github.com/marcimastro98/Xenon');

  const inside = click(anchor('#notes'));
  listeners['doc:click'](inside);
  assert.equal(inside.defaultPrevented, false);
  const newTab = click(anchor('/privacy', '_blank'));
  listeners['doc:click'](newTab);
  assert.equal(newTab.defaultPrevented, true);
  assert.equal(sent.at(-1).msg.url, 'http://127.0.0.1:3030/privacy');

  // A second hello answer does not wrap anything twice.
  const before = listeners['doc:click'];
  listeners['win:message']({ source: win.parent, data: { type: H.WIDGET } });
  assert.equal(listeners['doc:click'], before);
});

test('every widget check gets an answer, so a live page is never reloaded', () => {
  const { win, sent, listeners } = fakeWindow({ framed: true });
  H.install(win);
  listeners['win:message']({ source: win.parent, data: { type: H.WIDGET } });
  listeners['win:message']({ source: win.parent, data: { type: H.WIDGET } });
  assert.deepEqual(sent.filter((s) => s.msg.type === H.READY).length, 2);
  listeners['win:message']({ source: {}, data: { type: H.WIDGET } });
  assert.deepEqual(sent.filter((s) => s.msg.type === H.READY).length, 2);
});
