// The up-swipe from the bottom edge that sends the native window to the
// desktop did nothing whenever the finger landed on anything that could
// scroll, and the dashboard page scrolls as soon as its tiles are taller than
// the screen. The page now never takes the swipe; a list inside a tile keeps
// it until it has nothing left to scroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/native-bridge.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function loadOwnsVerticalDrag(bodyClasses = []) {
  const start = SRC.indexOf('    function ownsVerticalDrag(target) {');
  const end = SRC.indexOf('\n    }\n', start);
  assert.ok(start > 0 && end > start, 'ownsVerticalDrag is in native-bridge.js');
  const body = { classList: { contains: (c) => bodyClasses.includes(c) } };
  const ctx = {
    document: { body },
    getComputedStyle: (el) => ({ overflowY: el.overflowY || 'visible' }),
  };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(start, end + 6) + '\nthis.owns = ownsVerticalDrag;', ctx);
  return { owns: ctx.owns, body };
}

function node(parent, { cls = [], overflowY, scrollHeight = 100, clientHeight = 100, scrollTop = 0 } = {}) {
  return {
    nodeType: 1, parentElement: parent, overflowY, scrollHeight, clientHeight, scrollTop,
    classList: { contains: (c) => cls.includes(c) },
  };
}

test('a dashboard page taller than the screen does not take the swipe home', () => {
  const { owns, body } = loadOwnsVerticalDrag();
  const page = node(body, { cls: ['pager-page'], overflowY: 'auto', scrollHeight: 1400, clientHeight: 720 });
  const tile = node(page);
  assert.equal(owns(tile), false);
});

test('a list in a tile that can still scroll keeps the flick', () => {
  const { owns, body } = loadOwnsVerticalDrag();
  const page = node(body, { cls: ['pager-page'], overflowY: 'auto' });
  const list = node(page, { overflowY: 'auto', scrollHeight: 600, clientHeight: 200, scrollTop: 100 });
  assert.equal(owns(node(list)), true);
});

test('a list already at its end lets the swipe through', () => {
  const { owns, body } = loadOwnsVerticalDrag();
  const page = node(body, { cls: ['pager-page'], overflowY: 'auto' });
  const list = node(page, { overflowY: 'auto', scrollHeight: 600, clientHeight: 200, scrollTop: 400 });
  assert.equal(owns(node(list)), false);
});

test('layout editing still keeps every drag for moving tiles', () => {
  const { owns, body } = loadOwnsVerticalDrag(['layout-editing']);
  assert.equal(owns(node(body)), true);
});
