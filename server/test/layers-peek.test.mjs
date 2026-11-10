// The widget whose screen is open in the menu shows on the real screen, rule or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { createLayersPeek } = require('../layers-peek.js');
const { create } = require('../js/xenon-menu-peek.js');

function clock() {
  const timers = new Set();
  return {
    setTimer: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearTimer: (t) => { timers.delete(t); },
    fire: () => { for (const t of [...timers]) { timers.delete(t); t.fn(); } },
    count: () => timers.size,
  };
}

test('the server tells the windows once, and lets go by itself when the repeats stop', () => {
  const said = [];
  const c = clock();
  const peek = createLayersPeek({ broadcast: (id) => said.push(id), setTimer: c.setTimer, clearTimer: c.clearTimer });
  peek.set('lw_abc123');
  peek.set('lw_abc123');
  assert.deepEqual(said, ['lw_abc123'], 'a repeat only keeps it up');
  assert.equal(c.count(), 1);
  c.fire();
  assert.equal(peek.get(), null);
  assert.deepEqual(said, ['lw_abc123', null]);
});

test('only a widget id counts, and stopping leaves no timer', () => {
  const c = clock();
  const peek = createLayersPeek({ setTimer: c.setTimer, clearTimer: c.clearTimer });
  for (const bad of ['../x', 'lw_', '<b>', 12, {}, null]) assert.equal(peek.set(bad), null);
  peek.set('lw_abc123');
  peek.stop();
  assert.equal(c.count(), 0);
});

function menu(over = {}) {
  const sent = [];
  const c = clock();
  const doc = {
    visibilityState: 'visible', on: {},
    addEventListener(n, f) { this.on[n] = f; },
    removeEventListener(n) { delete this.on[n]; },
  };
  const peek = create({ post: async (path, body) => { sent.push([path, body.peek]); return over.reply || { ok: true }; }, doc, setTimer: c.setTimer, clearTimer: c.clearTimer, ...over.opts });
  return { peek, sent, c, doc };
}

test('the menu repeats the id while its screen is in sight, and says when it left', () => {
  const { peek, sent, c } = menu();
  peek.show('lw_a');
  peek.show('lw_a');
  assert.deepEqual(sent, [['/screen-menu', 'lw_a']], 'a redraw says nothing new');
  assert.equal(peek.held(), true);
  c.fire();
  assert.equal(sent.length, 2);
  peek.show(null);
  assert.deepEqual(sent[2], ['/screen-menu', null]);
  assert.equal(c.count(), 0);
  assert.equal(peek.held(), false);
});

test('a menu out of sight lets go, and takes it back when seen again', () => {
  const { peek, sent, c, doc } = menu();
  peek.show('lw_a');
  doc.visibilityState = 'hidden';
  doc.on.visibilitychange();
  assert.deepEqual(sent.at(-1), ['/screen-menu', null]);
  assert.equal(c.count(), 0, 'no repeats while hidden');
  doc.visibilityState = 'visible';
  doc.on.visibilitychange();
  assert.deepEqual(sent.at(-1), ['/screen-menu', 'lw_a']);
  assert.equal(c.count(), 1);
});

test('a device that may not do it stops asking and the screen says the plain truth', async () => {
  let redraws = 0;
  const { peek, sent } = menu({ reply: { ok: false }, opts: { onRefused: () => { redraws += 1; } } });
  peek.show('lw_a');
  await new Promise((r) => setImmediate(r));
  assert.equal(peek.held(), false);
  assert.equal(redraws, 1);
  peek.show('lw_b');
  assert.equal(sent.length, 1);
});

test('closing the menu ends it, and the route stays one a paired device cannot use', () => {
  const server = readFileSync(join(HERE, '..', 'server.js'), 'utf8');
  assert.match(server, /if \(!state\.open\) layersPeek\.set\(null\);/);
  assert.match(server, /function _gracefulShutdown\(\) \{[\s\S]{0,1500}layersPeek\.stop\(\)/);
  assert.match(server, /'\/screen-menu'[\s\S]{0,1500}'peek' in body/);
  const css = readFileSync(join(HERE, '..', 'components', 'LayerHost', 'LayerHost.css'), 'utf8');
  for (const rule of ['[data-show="gaming"]', '[data-show="notGaming"]', '[data-when-off]']) {
    assert.ok(css.includes(`.layer-slot${rule}:not([data-peek]),`) || css.includes(`.layer-slot${rule}:not([data-peek]) {`), rule);
  }
});
