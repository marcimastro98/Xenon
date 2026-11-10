import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...path) => readFileSync(join(HERE, '..', ...path), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('js', 'bit-message-card.js');

// A question from Bit is about this moment: a game just started, do you want the room?
// So unlike a message it does not fold into the clock to wait, and nothing else takes
// the top centre while it is up. Only its asker closes it.

function rig() {
  const { document } = makeDom();
  const timers = new Map();
  let nextTimer = 1;
  const window = {};
  vm.runInNewContext(SRC, {
    window,
    document,
    console,
    setTimeout: (fn) => { timers.set(nextTimer, fn); return nextTimer++; },
    clearTimeout: (id) => timers.delete(id),
  });
  const stopped = [];
  const answers = [];
  const key = (label) => ({ label, run: () => answers.push(label) });
  const parts = { title: 'Gaming: optimize?', off: key('never'), quiet: key('ignore'), go: key('optimize') };
  const hands = { bit: (parent) => { parent.append(document.createElement('i')); return { destroy: () => stopped.push(1) }; } };
  return {
    document, timers, stopped, answers,
    ask: (extra) => window.XenonBitCard.ask(parts, { ...hands, ...extra }),
    root: () => document.querySelector('.bm-ask'),
    fire: (type) => document.querySelector('.bm-ask')._handlers[type].forEach((fn) => fn()),
    wait: () => { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); },
  };
}

test('three keys in the order of every sheet: away, quiet, main on the right', () => {
  const r = rig();
  r.ask();
  const keys = r.document.querySelector('.bm-foot').children;
  assert.deepEqual(keys.map((k) => k.className), ['bm-off', 'bm-quiet', 'bm-go']);
  assert.deepEqual(keys.map((k) => k.textContent), ['never', 'ignore', 'optimize']);
  assert.equal(r.root().getAttribute('aria-label'), 'Gaming: optimize?');
});

test('a key answers and leaves the closing to the asker', () => {
  const r = rig();
  r.ask();
  r.document.querySelector('.bm-go').click();
  assert.deepEqual(r.answers, ['optimize']);
  assert.ok(r.root(), 'the asker knows when the moment is over');
});

test('it never steps aside by itself', () => {
  const r = rig();
  r.ask();
  assert.equal(r.timers.size, 0, 'no fold, no timer');
  r.fire('pointerleave');
  assert.equal(r.timers.size, 0);
  assert.ok(!r.root().classList.contains('is-face'));
});

test('with a limit it ends, but never under the pointer', () => {
  const r = rig();
  const over = [];
  r.ask({ lasts: { ms: 20000, over: () => over.push(1) } });
  assert.equal(r.timers.size, 1);

  r.fire('pointerenter');
  assert.equal(r.timers.size, 0, 'someone is reading it');

  r.fire('pointerleave');
  assert.equal(r.timers.size, 1);
  r.wait();
  assert.equal(over.length, 1);
});

test('closing it stops Bit and leaves nothing behind', () => {
  const r = rig();
  const close = r.ask({ lasts: { ms: 20000, over() {} } });
  close();
  assert.equal(r.root(), null);
  assert.equal(r.stopped.length, 1);
  assert.equal(r.timers.size, 0);
});

test('while it is up the top centre is its own', () => {
  const css = read('components', 'BitMessage', 'BitMessage.css');
  assert.match(css, /body:has\(> \.bm-ask\) > :is\(\.bm-card:not\(\.bm-ask, \.is-face\), \.rn-corner\) \{ display: none; \}/);
  assert.match(read('js', 'bit-messages.js'), /WAIT_FOR = '[^']*\.bm-ask'/, 'no new message opens under it');
  assert.match(read('js', 'toast.js'), /CENTRE_TAKEN = '[^']*\.bm-card:not\(\.is-face\)/, 'notifications go beside it');
});

test('a game does not hide it: the game starting is what it asks about', () => {
  const css = read('components', 'ScreenAlerts', 'ScreenAlerts.css');
  assert.match(css, /body\.game-mode \.bm-card:not\(\.bm-ask\)/);
});

test('cards at the top hang under the bar, so the clock stays in sight', () => {
  const card = read('components', 'BitMessage', 'BitMessage.css');
  assert.match(card, /:root:not\(\[data-screen-alerts\]\) body:not\(\.topbar-hidden\) \{ --card-top:/);
  assert.match(card, /top: var\(--card-top, 16px\);/);
  assert.match(read('components', 'WhatsNew', 'WhatsNew.css'), /top: var\(--card-top, 16px\);/);
});
