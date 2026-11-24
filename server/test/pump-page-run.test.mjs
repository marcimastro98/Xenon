// A pump's page loads again when the engine names another run than the one that served it
// (js/pump/face-kit.js reloadForRun, called from pump-face.js on each hello and settings read):
// iCUE keeps its widget's page open across an update, and the old code went on drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function kit() {
  const { document } = makeDom();
  const window = {};
  vm.runInContext(read('../js/pump/face-kit.js'), vm.createContext({ window, document, Intl, Number, Math, Date, Object, String, Array, JSON, URL }));
  return window.PumpFaceKit;
}

// A page's address, and where it was sent.
function place(href) {
  const went = [];
  return { href, replace: (to) => went.push(to), went };
}

const PAGE = 'http://127.0.0.1:3030/pump-face?screen=pump&via=icue&shape=round';

test('a new run of the engine loads the page again, at the same address with the run it went for', () => {
  const at = place(PAGE);
  assert.equal(kit().reloadForRun('abc', 'abd', at), true);
  assert.deepEqual(at.went, [PAGE + '&run=abd'], 'the screen, its shape and where it is shown are kept');
});

test('the same run, or no run said, leaves the page as it is', () => {
  const Kit = kit();
  for (const [served, run] of [['abc', 'abc'], ['abc', undefined], ['abc', ''], ['', 'abd'], ['abc', 42]]) {
    const at = place(PAGE);
    assert.equal(Kit.reloadForRun(served, run, at), false, `${served} -> ${run}`);
    assert.deepEqual(at.went, []);
  }
});

test('once per run: a page served old again (a cache) never loads round and round', () => {
  const at = place(PAGE + '&run=abd');
  assert.equal(kit().reloadForRun('abc', 'abd', at), false);
  assert.deepEqual(at.went, []);
  const later = place(PAGE + '&run=abd');
  assert.equal(kit().reloadForRun('abd', 'abe', later), true, 'the next update loads it again');
  assert.deepEqual(later.went, [PAGE + '&run=abe']);
});

test('the page asks on every hello and settings read, with the run it was served', () => {
  const src = read('../js/pump/pump-face.js');
  assert.match(src, /const \{ lang: pageLang, run: served \} = readWords\(\);/);
  assert.equal((src.match(/if \(Kit\.reloadForRun\(served, d\.run\)\) return;/g) || []).length, 2, 'hello and refresh');
});
