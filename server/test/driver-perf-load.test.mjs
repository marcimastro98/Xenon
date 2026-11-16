// Performance Mode with no dashboard (js/performance/driver-perf.js) loads the scripts of its list
// itself. They are scripts of the dashboard, written to run one after the other: each is
// asked for only when the one before it has run, in the order of the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { partsOf } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const DriverPerf = require('../js/performance/driver-perf.js');

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function page() {
  const asked = [];
  const win = {};
  const doc = { createElement: (tag) => ({ tag }), body: { appendChild: (node) => { asked.push(node); } } };
  const perf = DriverPerf.create({ win, doc, read: () => ({ performance: { enabled: true } }), post: () => Promise.resolve() });
  return { asked, win, perf, sources: () => asked.map((node) => node.src) };
}

test('the list is a frozen list of scripts, the dashboard\'s own', () => {
  assert.ok(Object.isFrozen(DriverPerf.SCRIPTS));
  assert.ok(DriverPerf.SCRIPTS.length >= 2);
  for (const src of DriverPerf.SCRIPTS) assert.match(src, /^js\/[\w./-]+\.js$/);
  // The scripts Performance Mode is made of today, in the order a page loads them: they end the list, in that order.
  const perfMode = partsOf('server/js/performance/performance.js').map((file) => file.slice('server/'.length));
  assert.deepEqual(DriverPerf.SCRIPTS.slice(-perfMode.length), perfMode, 'the script that starts Performance Mode runs last, right after the scripts taken out of it');
  const settings = DriverPerf.SCRIPTS.indexOf('js/performance/perf-settings.js');
  assert.ok(settings !== -1 && settings < DriverPerf.SCRIPTS.indexOf(perfMode[0]), 'the settings it reads load before all of them');
  assert.equal(new Set(DriverPerf.SCRIPTS).size, DriverPerf.SCRIPTS.length);
});

test('each script is asked for when the one before it has run, in the order of the list', async () => {
  const p = page();
  let done = false;
  p.perf.load().then(() => { done = true; });
  for (let at = 0; at < DriverPerf.SCRIPTS.length; at++) {
    await tick();
    assert.deepEqual(p.sources(), DriverPerf.SCRIPTS.slice(0, at + 1), 'one more, and only after the one before it ran');
    assert.equal(p.asked[at].tag, 'script');
    assert.equal(done, false);
    p.asked[at].onload();
  }
  await tick();
  assert.equal(done, true);
  assert.equal(p.asked.length, DriverPerf.SCRIPTS.length, 'nothing is asked for twice');
});

test('asked twice while it loads, the list is loaded once', async () => {
  const p = page();
  const [one, two] = [p.perf.load(), p.perf.load()];
  await tick();
  assert.equal(one, two);
  assert.deepEqual(p.sources(), DriverPerf.SCRIPTS.slice(0, 1));
});

test('a script that does not load stops the rest, and the next try starts over', async () => {
  const p = page();
  let failed = false;
  p.perf.load().catch(() => { failed = true; });
  await tick();
  p.asked[0].onerror(new Error('gone'));
  await tick();
  assert.equal(failed, true);
  assert.equal(p.asked.length, 1, 'the scripts after it are not asked for');
  p.perf.load().catch(() => {});
  await tick();
  assert.deepEqual(p.sources(), [DriverPerf.SCRIPTS[0], DriverPerf.SCRIPTS[0]]);
});

test('once Performance Mode is there, nothing is loaded again', async () => {
  const p = page();
  p.win.PerfMode = { refresh() {}, applyState() {} };
  await p.perf.load();
  assert.deepEqual(p.sources(), []);
  assert.equal(p.perf.loaded(), true);
});
