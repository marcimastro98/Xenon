// The motherboard card in Connections. Linux keeps the controller for root until a
// udev rule says otherwise, so the card has to give the exact line instead of saying
// nothing was found, and say it is a Beta only where the backend is one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/lighting-connections.js', import.meta.url), 'utf8');
const LINE = "echo 'rule' | sudo tee /etc/udev/rules.d/60-xenon-rgb.rules";

class FakeNode {
  constructor(tag, className = '', key = '', text = '') {
    Object.assign(this, { tag, className, key, textContent: text, children: [], disabled: false, onClick: null });
    this.classList = { add: () => {} };
    this.style = {};
    this.dataset = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener() {}
  setAttribute() {}
  querySelector() { return new FakeNode('input'); }
  walk() { return [this, ...this.children.flatMap(c => (c instanceof FakeNode ? c.walk() : []))]; }
}

function render(native) {
  const copied = [];
  const posts = [];
  const ui = {
    tr: (key, fallback) => fallback || key,
    post: async (path, body) => { posts.push({ path, body }); return {}; },
    el: (tag, className, key, text) => new FakeNode(tag, className, key, text),
    hintP: (text, key) => new FakeNode('p', 'hint', key, text),
    button(className, key, text, onClick) {
      const b = new FakeNode('button', className, key, text);
      b.onClick = onClick;
      return b;
    },
    card(key, title) {
      const c = new FakeNode('section', 'card', key, title);
      c.body = new FakeNode('div', 'body');
      c.children.push(c.body);
      return c;
    },
    toggleRow: (key) => new FakeNode('label', 'toggle', key),
  };
  const window = { LightingUI: ui };
  const document = { createElement: (tag) => new FakeNode(tag) };
  const pending = () => new Promise(() => {});   // the other cards' lookups, not under test
  vm.runInNewContext(SRC, { window, document, fetch: pending, SERVER: '', copyText: async (text) => { copied.push(text); return true; } });
  const box = window.LightingConnections.build(() => {}, { available: true, connected: true, native });
  const nodes = box.walk();
  return {
    copied,
    posts,
    has: (key) => nodes.some(n => n.key === key),
    code: nodes.find(n => n.tag === 'code'),
    copy: nodes.find(n => n.key === 'streaming_copy'),
    rescan: nodes.find(n => n.key === 'lighting_native_rescan'),
    texts: nodes.map(n => n.textContent),
  };
}

const refused = { available: true, beta: true, enabled: true, starting: false, error: 'no-permission', accessCommand: LINE, controllers: [] };

test('a refused controller gets the line to paste, not "nothing found"', () => {
  const card = render(refused);
  assert.equal(card.has('lighting_native_permission'), true);
  assert.equal(card.code.textContent, LINE);
  assert.equal(card.has('lighting_native_none'), false);
  assert.equal(card.texts.includes('no-permission'), false, 'the raw error code never reaches the user');
});

test('Copy copies the line exactly, and Search again is there for after pasting it', async () => {
  const card = render(refused);
  await card.copy.onClick();
  assert.deepEqual(card.copied, [LINE]);
  assert.equal(card.copy.textContent, 'Copied');
  await card.rescan.onClick();
  assert.equal(JSON.stringify(card.posts), JSON.stringify([{ path: '/api/lighting/native/scan', body: {} }]));
});

test('nothing on the bus still says nothing was found, and shows no command', () => {
  const card = render({ ...refused, error: 'no-controller', accessCommand: '' });
  assert.equal(card.has('lighting_native_none'), true);
  assert.equal(card.has('lighting_native_permission'), false);
  assert.equal(card.code, undefined);
});

test('a controller that opened asks for nothing', () => {
  const card = render({ ...refused, error: '', accessCommand: '', controllers: [{ id: 'a', name: 'IT5711', outputs: 4 }] });
  assert.equal(card.has('lighting_native_permission'), false);
  assert.equal(card.has('lighting_native_none'), false);
});

test('the Beta line follows the backend, and shows before the switch is on', () => {
  assert.equal(render({ ...refused, enabled: false }).has('lighting_native_beta'), true);
  assert.equal(render({ ...refused, beta: false }).has('lighting_native_beta'), false);
});

test('a PC with no backend says so, and offers no switch', () => {
  const card = render({ available: false, beta: false });
  assert.equal(card.has('lighting_native_unsupported'), true);
  assert.equal(card.has('lighting_native_enable'), false);
});
