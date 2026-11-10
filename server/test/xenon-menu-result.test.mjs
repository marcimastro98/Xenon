// js/xenon-menu-result.js: the line that says what a function did, in the menu's
// window. Pinned here: it starts hidden, shows the card's words as text, drops a
// picture that does not load, hands its buttons back, and clears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create } = require('../js/xenon-menu-result.js');

function fakeDoc() {
  const doc = {
    createElement(tag) {
      const n = {
        tag, children: [], listeners: {}, dataset: {}, className: '', textContent: '',
        append(...kids) { n.children.push(...kids); },
        replaceChildren(...kids) { n.children = kids; },
        addEventListener(name, fn) { n.listeners[name] = fn; },
        remove() { n.removed = true; },
      };
      return n;
    },
  };
  return doc;
}

function box() {
  const doc = fakeDoc();
  const b = doc.createElement('div');
  b.ownerDocument = doc;
  return b;
}

const flat = (n) => [n, ...n.children.flatMap(flat)];
const byClass = (n, cls) => flat(n).find((x) => x.className.split(' ').includes(cls));

test('it starts hidden and shows the words of the card', () => {
  const b = box();
  const r = create(b, () => {});
  assert.equal(b.hidden, true);
  r.show({ type: 'success', kicker: 'Game', title: 'Screenshot saved', message: 'In Pictures' });
  assert.equal(b.hidden, false);
  assert.equal(b.dataset.type, 'success');
  assert.equal(byClass(b, 'xm-result-title').textContent, 'Screenshot saved');
  assert.equal(byClass(b, 'xm-result-message').textContent, 'In Pictures');
  assert.equal(byClass(b, 'xm-result-img'), undefined);
});

test('a picture that does not load goes, the words stay', () => {
  const b = box();
  create(b, () => {}).show({ title: 'Saved', image: '/captures/thumb?id=a' });
  const img = byClass(b, 'xm-result-img');
  assert.equal(img.src, '/captures/thumb?id=a');
  assert.equal(img.alt, '');
  img.listeners.error();
  assert.equal(img.removed, true);
});

test('its buttons go back to the place, the first one marked', () => {
  const b = box();
  const pressed = [];
  const open = { label: 'Open', primary: true };
  create(b, (a) => pressed.push(a)).show({ title: 'Saved', actions: [open, { label: 'Show' }] });
  const button = byClass(b, 'is-primary');
  assert.equal(button.textContent, 'Open');
  assert.equal(button.type, 'button');
  button.listeners.click();
  assert.deepEqual(pressed, [open]);
});

test('no card, or clear, hides it', () => {
  const b = box();
  const r = create(b, () => {});
  r.show({ title: 'Saved' });
  r.show(null);
  assert.equal(b.hidden, true);
  assert.equal(b.children.length, 0);
  r.show({ title: 'Saved' });
  r.clear();
  assert.equal(b.hidden, true);
});

test('a kicker the title already says is left out', () => {
  const b = box();
  const r = create(b, () => {});
  r.show({ kicker: 'Screenshot', title: 'Screenshot saved' });
  assert.equal(byClass(b, 'xm-result-kicker'), undefined);
  r.show({ kicker: 'Tabletop', title: 'Screenshot saved' });
  assert.equal(byClass(b, 'xm-result-kicker').textContent, 'Tabletop');
});
