// Bit's chat inside the search window (js/spotlight-chat.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/spotlight-chat.js');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

function page({ loadFails = false, search = '?frameless=1' } = {}) {
  const classes = new Set();
  const calls = { load: 0, opened: 0, closed: 0, attached: [], fresh: 0, said: [], announced: [], signals: [] };
  const docListeners = {};
  const box = { attachMenu: null, observer: null };
  const input = { value: '', focused: 0, events: 0, focus() { this.focused++; }, dispatchEvent() { this.events++; } };
  const window = {
    location: { href: '' },
    __xenonSignal: (s) => { calls.signals.push(s); return s; },
    dispatchEvent: (ev) => calls.announced.push(ev.detail.open),
    ScreenBit: { load: async () => { calls.load++; if (loadFails) throw new Error('no'); } },
    Spotlight: { fresh() { calls.fresh++; }, say(s) { calls.said.push(s); } },
    SpotlightChat: null,
  };
  box.panel = { role: null, setAttribute(k, v) { if (k === 'data-chatf') this.role = v; } };
  const ctx = vm.createContext({
    window,
    location: { search },
    document: {
      body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } },
      getElementById: () => input,
      querySelector: (sel) => (sel === '.ai-panel' ? box.panel : box.attachMenu),
      addEventListener: (k, f, capture) => { (docListeners[k] ||= []).push({ f, capture }); },
    },
    MutationObserver: class { constructor(f) { box.observer = f; } observe() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    Event: class {},
    encodeURIComponent,
    openAiPanel() { calls.opened++; classes.add('ai-open'); },
    closeAiPanel() { calls.closed++; classes.delete('ai-open'); box.observer && box.observer(); },
    aiOnFileAttach: (i) => calls.attached.push(i.files),
    t: (_k, s) => s,
  });
  vm.runInContext(SRC, ctx);
  const fire = (k, ev) => (docListeners[k] || []).forEach((l) => l.f(ev));
  return { window, calls, classes, input, fire, box, docListeners, chat: window.SpotlightChat };
}

const key = (k) => { const e = { key: k, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented++; } }; return e; };
const paste = (files) => ({ clipboardData: { files }, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } });

test('the icon opens the chat with what was typed, and loads it only then', async () => {
  const p = page();
  assert.equal(p.calls.load, 0);
  p.chat.open('quanto spazio ho?');
  await settle();
  assert.equal(p.calls.load, 1);
  assert.equal(p.calls.opened, 1);
  assert.ok(p.classes.has('spot-chat'));
  assert.deepEqual(p.calls.announced, [true]);
  assert.equal(p.input.value, 'quanto spazio ho?');
  assert.ok(p.input.focused > 0);
  assert.ok(p.chat.isOpen());
  assert.equal(p.box.panel.role, 'pane', 'the panel takes the theme colours, as the chat tile does');
});

test('a second open only puts the text in', async () => {
  const p = page();
  p.chat.open('');
  await settle();
  p.chat.open('altro');
  await settle();
  assert.equal(p.calls.opened, 1);
  assert.deepEqual(p.calls.announced, [true]);
  assert.equal(p.input.value, 'altro');
});

test('Esc goes back to a clean search bar', async () => {
  const p = page();
  p.chat.open('');
  await settle();
  const e = key('Escape');
  p.fire('keydown', e);
  assert.equal(p.calls.closed, 1);
  assert.equal(e.prevented, 1);
  assert.ok(!p.classes.has('spot-chat'));
  assert.equal(p.calls.fresh, 1);
  assert.deepEqual(p.calls.announced, [true, false]);
  assert.ok(!p.chat.isOpen());
});

test('Esc with the attach menu open closes only the menu', async () => {
  const p = page();
  p.chat.open('');
  await settle();
  p.box.attachMenu = {};
  p.fire('keydown', key('Escape'));
  assert.equal(p.calls.closed, 0);
  assert.ok(p.chat.isOpen());
});

test('Esc in the bar is left to the search', () => {
  const p = page();
  const e = key('Escape');
  p.fire('keydown', e);
  assert.equal(p.calls.closed, 0);
  assert.equal(e.prevented, 0);
});

test('the X of the panel goes back to the search too', async () => {
  const p = page();
  p.chat.open('');
  await settle();
  p.classes.delete('ai-open');
  p.box.observer();
  assert.equal(p.calls.fresh, 1);
  assert.ok(!p.chat.isOpen());
});

test('a picture or a file pasted in the bar opens the chat with it', async () => {
  const p = page();
  const e = paste([{ name: 'shot.png' }]);
  p.fire('paste', e);
  assert.equal(e.prevented, 1);
  assert.equal(e.stopped, 1, 'the chat must not add it a second time');
  await settle();
  assert.equal(p.calls.opened, 1);
  assert.equal(p.calls.attached.length, 1);
  assert.equal(p.calls.attached[0][0].name, 'shot.png');
  assert.ok(p.docListeners.paste[0].capture, 'before the chat own listener');
});

test('plain text pasted stays where it was pasted', async () => {
  const p = page();
  const e = paste([]);
  p.fire('paste', e);
  await settle();
  assert.equal(e.prevented, 0);
  assert.equal(p.calls.load, 0);
});

test('a chat that fails to load says so and leaves the bar working', async () => {
  const p = page({ loadFails: true });
  p.chat.open('ciao');
  await settle();
  assert.equal(p.calls.said.length, 1);
  assert.ok(!p.classes.has('spot-chat'));
  assert.ok(!p.chat.isOpen());
  assert.deepEqual(p.calls.announced, [true, false]);
});

test('in the native window Settings and the Sparks shop open the dashboard', async () => {
  const p = page();
  p.chat.open('');
  await settle();
  p.window.openSettings('ai');
  p.window.CommunityGallery.openSparks();
  assert.deepEqual(p.calls.signals, ['xenon-app:open-dashboard?open=settings&cat=ai', 'xenon-app:open-dashboard?open=sparks']);
});

test('in Edge the chat keeps its own ways out', async () => {
  const p = page({ search: '' });
  p.chat.open('');
  await settle();
  assert.equal(p.window.openSettings, undefined);
  assert.equal(p.window.CommunityGallery, undefined);
});

test('the page carries the panel, cut from the dashboard', () => {
  const { compose } = require('../screen-alerts-page.js');
  const html = read('../spotlight.html');
  const dash = read('../index.html');
  const out = compose(html, dash);
  assert.ok(html.includes('<template id="screen-bit-markup"><!-- bit markup --></template>'));
  assert.ok(out.includes('id="ai-text-input"'));
  const route = engineSource();
  const at = route.indexOf("reqPath === '/spotlight' && req.method === 'GET'");
  assert.ok(route.slice(at, at + 900).includes('screenAlertsPage.compose'));
});

test('every search surface reaches the same chat', () => {
  const src = read('../js/spotlight.js');
  assert.ok(src.includes('onChat: chatHandler()'));
  assert.ok(read('../js/search-widget.js').includes('onChat: Spotlight.chatHandler()'));
});

test('a failed open answers a sentence, and a sent question goes through the panel', async () => {
  const ok = page();
  let sent = 0;
  ok.window.aiSendText = () => { sent++; };
  assert.equal(await ok.chat.open('ciao', true), undefined);
  assert.equal(sent, 1);
  const bad = page({ loadFails: true });
  assert.match(await bad.chat.open('ciao', true), /non si è aperta/);
});
