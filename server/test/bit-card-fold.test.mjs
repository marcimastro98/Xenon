import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'bit-message-card.js'), 'utf8');

// Left alone, Bit's card folds to a small face. It used to wait in a corner of the
// screen, where it sat on a tile's own header and read as part of that tile. Now it
// waits in the clock, which covers nothing; only with no clock on screen does it keep
// the corner, and a bar that changes has to take it along.

function rig({ slot = true } = {}) {
  const { document } = makeDom();
  const timers = new Map();
  let nextTimer = 1;
  const reflows = [];
  let clock = null;
  if (slot) {
    clock = document.createElement('span');
    clock.id = 'clock-bit';
    clock.hidden = true;
    document.body.append(clock);
  }
  const window = { TopbarMinimal: { reflowIsland: () => reflows.push(1) } };
  vm.runInNewContext(SRC, {
    window,
    document,
    console,
    setTimeout: (fn) => { timers.set(nextTimer, fn); return nextTimer++; },
    clearTimeout: (id) => timers.delete(id),
  });
  const handlers = {
    tr: (key) => key,
    bit: (parent) => { parent.append(document.createElement('i')); return { destroy() {} }; },
    read() {},
    run() {},
    done() {},
    answer() {},
  };
  const open = () => window.XenonBitCard.card({ title: 'Sparks running low', line: 'You have 40 left.' }, handlers);
  const wait = () => { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); };
  return {
    document, clock, reflows, open, wait,
    refit: () => window.XenonBitCard.refit(),
    root: () => document.querySelector('.bm-card'),
  };
}

test('an untouched card goes to wait in the clock', () => {
  const r = rig();
  r.open();
  assert.equal(r.root().parentNode, r.document.body, 'a card opens over the page');
  assert.equal(r.clock.hidden, true);

  r.wait();
  assert.equal(r.root().parentNode, r.clock);
  assert.ok(r.root().classList.contains('is-face'));
  assert.equal(r.clock.hidden, false);
  assert.equal(r.reflows.length, 1, 'the pill measures itself again with Bit inside');
});

for (const name of ['topbar-noisland', 'topbar-hidden']) {
  test(`with ${name} there is no clock, so it keeps a corner`, () => {
    const r = rig();
    r.document.body.classList.add(name);
    r.open();
    r.wait();
    assert.equal(r.root().parentNode, r.document.body);
    assert.ok(r.root().classList.contains('is-face'));
    assert.equal(r.clock.hidden, true, 'an empty slot stays out of the pill');
  });
}

test('a page without the slot, like the alerts window, keeps the corner too', () => {
  const r = rig({ slot: false });
  r.open();
  r.wait();
  assert.equal(r.root().parentNode, r.document.body);
});

test('a bar that changes takes the face along, both ways', () => {
  const r = rig();
  r.open();
  r.wait();

  r.document.body.classList.add('topbar-noisland');
  r.refit();
  assert.equal(r.root().parentNode, r.document.body);
  assert.equal(r.clock.hidden, true, 'the slot it left does not stay in the pill');

  r.document.body.classList.remove('topbar-noisland');
  r.refit();
  assert.equal(r.root().parentNode, r.clock);
  assert.equal(r.clock.hidden, false);
});

test('refit does nothing to a card that is still open', () => {
  const r = rig();
  r.open();
  r.refit();
  assert.equal(r.root().parentNode, r.document.body);
  assert.equal(r.clock.hidden, true);
});

test('tapping the face opens the card over the page and frees the clock', () => {
  const r = rig();
  r.open();
  r.wait();

  r.document.querySelector('.bm-face').click();
  assert.equal(r.root().parentNode, r.document.body);
  assert.ok(!r.root().classList.contains('is-face'));
  assert.equal(r.clock.hidden, true);
});

test('closing a folded card leaves nothing behind', () => {
  const r = rig();
  const close = r.open();
  r.wait();

  close();
  assert.equal(r.root(), null);
  assert.equal(r.clock.hidden, true);
  assert.equal(r.clock.children.length, 0);
});
