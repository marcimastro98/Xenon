// The phone's full-screen chat (js/ai/bit-chat-full.js): a tap on a narrow screen
// moves the pane into a sheet on <body>; the arrow, Escape or the phone's back
// button put it back where it was, with the same live session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { shouldOpen } = require('../js/ai/bit-chat-full.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('only a narrow screen outside edit mode opens it, and only once', () => {
  assert.equal(shouldOpen({ narrow: true, editing: false, inSheet: false }), true);
  assert.equal(shouldOpen({ narrow: false, editing: false, inSheet: false }), false, 'a wide screen keeps the tile');
  assert.equal(shouldOpen({ narrow: true, editing: true, inSheet: false }), false, 'editing the layout moves tiles, not the chat');
  assert.equal(shouldOpen({ narrow: true, editing: false, inSheet: true }), false);
});

// Just enough DOM for the move and the way back.
class ClassList extends Set { remove(c) { this.delete(c); } contains(c) { return this.has(c); } }
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.parentNode = null; this.classList = new ClassList(); this.attrs = {}; this.hidden = false; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.tag === 'html'; }
  setAttribute(k, v) { this.attrs[k] = v; }
  insertBefore(n, ref) { if (n.parentNode) n.remove(); const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, n); n.parentNode = this; return n; }
  appendChild(n) { return this.insertBefore(n, null); }
  remove() { if (!this.parentNode) return; const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) {
      if (sel === '[data-chatf="pane"]' && n.attrs['data-chatf'] === 'pane') return n;
      if (sel === '.bit-sheet' && n.className === 'bit-sheet') return n;
      if (sel === '[data-bit-back]' && 'data-bit-back' in n.attrs) return n;
      if (sel === 'button, a, input, textarea' && ['button', 'a', 'input', 'textarea'].includes(n.tag)) return n;
    }
    return null;
  }
  querySelector() { return this.input || null; }
}

function boot({ narrow = true, rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } } = {}) {
  const html = new Node('html');
  const body = html.appendChild(new Node('body'));
  const tile = body.appendChild(new Node('section'));
  const pane = tile.appendChild(new Node('div'));
  pane.attrs['data-chatf'] = 'pane';
  const back = pane.appendChild(new Node('button'));
  back.attrs['data-bit-back'] = '';
  const log = pane.appendChild(new Node('div'));
  let focused = null;
  const events = [];
  pane.input = { disabled: false, value: '', maxLength: 500, focus: () => { focused = 'input'; }, dispatchEvent: (e) => events.push(e.type) };
  pane.getBoundingClientRect = () => rect;
  const listeners = {};
  const winListeners = {};
  const historyCalls = [];
  const ctx = {
    console, Object, String,
    innerWidth: 1920, innerHeight: 1080,
    Event: class { constructor(type) { this.type = type; } },
    t: (k) => k,
    moveNode: (parent, node, ref = null) => parent.insertBefore(node, ref),
    matchMedia: () => ({ matches: narrow, addEventListener() {} }),
    addEventListener: (type, fn) => { winListeners[type] = fn; },
    history: {
      state: null,
      pushState(s) { this.state = s; historyCalls.push('push'); },
      back() { this.state = null; historyCalls.push('back'); },
    },
    document: {
      body,
      createElement: (tag) => new Node(tag),
      getElementById: (id) => (id === 'media-pane-chat' ? pane : null),
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/ai/bit-chat-full.js'), ctx);
  return { ctx, body, tile, pane, back, log, listeners, winListeners, historyCalls, events, focused: () => focused };
}

test('a tap moves the pane into a sheet, and the arrow puts it back in place', () => {
  const s = boot();
  s.listeners.click({ target: s.log });
  const sheet = s.pane.parentNode;
  assert.equal(sheet.className, 'bit-sheet');
  assert.equal(sheet.parentNode, s.body);
  assert.equal(s.tile.children.length, 1, 'a placeholder keeps the place');
  assert.ok(s.body.classList.has('bit-sheet-open'));
  assert.equal(s.focused(), 'input', 'a tap on the empty pane goes on to typing');
  assert.equal(s.ctx.BitChatFull.isOpen(), true);

  s.listeners.click({ target: s.back });
  assert.equal(s.pane.parentNode, s.tile, 'back in its tile');
  assert.deepEqual(s.tile.children, [s.pane], 'the placeholder is gone');
  assert.equal(sheet.parentNode, null);
  assert.ok(!s.body.classList.has('bit-sheet-open'));
  assert.deepEqual(s.historyCalls, ['push', 'back'], 'the phone history stays clean');
});

test('Escape and the phone back button close it; a handled Escape does not', () => {
  const s = boot();
  s.listeners.click({ target: s.log });
  s.listeners.keydown({ key: 'Escape', defaultPrevented: true });
  assert.equal(s.ctx.BitChatFull.isOpen(), true, 'that Escape closed the model panel');
  s.listeners.keydown({ key: 'Escape', defaultPrevented: false });
  assert.equal(s.pane.parentNode, s.tile);

  s.listeners.click({ target: s.log });
  s.winListeners.popstate();
  assert.equal(s.pane.parentNode, s.tile);
  assert.deepEqual(s.historyCalls, ['push', 'back', 'push'], 'no extra back after the phone already went back');
});

test('a wide screen never moves the pane', () => {
  const s = boot({ narrow: false });
  s.listeners.click({ target: s.log });
  assert.equal(s.pane.parentNode, s.tile);
});

test('the sheet sits under Settings and the Store, and the script is loaded', () => {
  const css = read('../components/MediaPanel/MediaPanel.css');
  const z = Number((/\.bit-sheet \{[^}]*z-index: (\d+)/.exec(css) || [])[1]);
  const settingsZ = Number((/\.settings-overlay \{[^}]*z-index: (\d+)/.exec(read('../components/SettingsModal/SettingsPage.css')) || [])[1]);
  assert.ok(z > 0 && z < settingsZ, `sheet ${z} under Settings ${settingsZ}`);
  assert.match(read('../index.html'), /<script src="js\/ai\/bit-chat-full\.js"><\/script>/);
});

// "Ask Bit" from a notification (js/ambient/ambient.js): the question waits in the box,
// unsent, and the layout never changes to show it.
test('asking with the chat on screen fills the box where it is', () => {
  const s = boot({ narrow: false, rect: { left: 100, top: 100, right: 400, bottom: 600, width: 300, height: 500 } });
  assert.equal(s.ctx.BitChatFull.ask('How did my game go?'), true);
  assert.equal(s.pane.parentNode, s.tile, 'no sheet');
  assert.equal(s.pane.input.value, 'How did my game go?');
  assert.deepEqual(s.events, ['input'], 'the box hears it, nothing is sent');
  assert.equal(s.focused(), 'input');
});

test('asking with the chat hidden or off screen opens it as a card, and a tap outside closes it', () => {
  for (const rect of [
    { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    { left: 2000, top: 100, right: 2300, bottom: 600, width: 300, height: 500 },
  ]) {
    const s = boot({ narrow: false, rect });
    s.ctx.BitChatFull.ask('Why is my GPU this hot?');
    const sheet = s.pane.parentNode;
    assert.equal(sheet.className, 'bit-sheet bit-sheet-card', JSON.stringify(rect));
    assert.equal(s.pane.input.value, 'Why is my GPU this hot?');
    s.listeners.click({ target: sheet });
    assert.equal(s.pane.parentNode, s.tile, 'back in its tile');
  }
});

test('on a phone asking opens the full-screen sheet', () => {
  const s = boot({ narrow: true });
  s.ctx.BitChatFull.ask('x'.repeat(600));
  assert.equal(s.pane.parentNode.className, 'bit-sheet');
  assert.equal(s.pane.input.value.length, 500, 'kept to the box limit');
});

test('the questions are in every language, and the card has its look', () => {
  // One file per language here (server/js/i18n/<code>.js).
  const i18n = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'].map((code) => read(`../js/i18n/${code}.js`)).join('\n');
  for (const k of ['bit_ask_recap', 'bit_ask_recap_last', 'bit_ask_hot_gpu', 'bit_ask_hot_cpu']) {
    const hits = i18n.match(new RegExp('^  ' + k + ": '((?:[^'\\\\]|\\\\.)*)'", 'gm')) || [];
    assert.equal(hits.length, 11, k);
    if (k === 'bit_ask_recap') hits.forEach((h) => assert.ok(h.includes('{game}'), h));
    hits.forEach((h) => assert.ok(!h.includes('—'), h));
  }
  assert.match(read('../components/MediaPanel/MediaPanel.css'), /\.bit-sheet\.bit-sheet-card \{/);
});
