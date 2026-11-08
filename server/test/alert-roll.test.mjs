// A card closing on the alerts window stays opaque under a cut that rolls shut,
// and leaves the page only after that: he saw a white box when it left first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const AlertRoll = require('../js/alert-roll.js');
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function card(rects = ['10,20,300,100']) {
  const classes = new Set();
  return { rects, classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
}

function rig() {
  const sent = [];
  const tasks = [];
  const waits = [];
  let changes = 0;
  const roll = AlertRoll.create({
    rectsOf: (el) => el.rects,
    send: (rects) => sent.push(rects),
    changed: () => { changes += 1; },
    wait: (ms) => { waits.push(ms); return Promise.resolve(); },
    later: (fn) => tasks.push(fn),
  });
  return { roll, sent, waits, run: () => tasks.splice(0).forEach((fn) => fn()), changes: () => changes };
}

test('the card is marked and its rectangle goes to the shell', () => {
  const r = rig();
  const el = card();
  const roll = r.roll.away(el);
  assert.ok(el.classes.has('is-rolling'), 'out of the cut the page reports');
  r.run();
  assert.deepEqual(r.sent, ['10,20,300,100']);
  assert.deepEqual(r.waits, [AlertRoll.ROLL_MS + AlertRoll.MARGIN_MS], 'the card waits for the whole roll');
  assert.equal(typeof roll.done.then, 'function');
});

test('cards closing together go out in one signal', () => {
  const r = rig();
  r.roll.away(card(['1,1,1,1']));
  r.roll.away(card(['2,2,2,2', '3,3,3,3']));
  r.run();
  assert.deepEqual(r.sent, ['1,1,1,1;2,2,2,2;3,3,3,3'], 'a second location change in the task would drop the first');
});

test('a later card sends its own signal', () => {
  const r = rig();
  r.roll.away(card(['1,1,1,1']));
  r.run();
  r.roll.away(card(['2,2,2,2']));
  r.run();
  assert.deepEqual(r.sent, ['1,1,1,1', '2,2,2,2']);
});

test('nothing in the cut, nothing to roll', () => {
  const r = rig();
  const el = card([]);
  assert.equal(r.roll.away(el), null);
  assert.ok(!el.classes.has('is-rolling'));
  r.run();
  assert.deepEqual(r.sent, []);
});

test('cancel gives the card back to the cut', () => {
  const r = rig();
  const el = card();
  r.roll.away(el).cancel();
  assert.ok(!el.classes.has('is-rolling'));
  assert.equal(r.changes(), 1);
});

test('page and shell agree on how long the roll lasts', () => {
  const rust = read('../apps/native/src-tauri/src/layers/roll.rs');
  assert.equal(Number(rust.match(/pub const ROLL_MS: u64 = (\d+);/)[1]), AlertRoll.ROLL_MS);
});

test('a stack card stays put until the roll ends, then the others close the gap', () => {
  const toast = read('js/toast.js');
  const dismiss = toast.slice(toast.indexOf('function dismiss(id, dir)'), toast.indexOf('function dismissAll'));
  const rolled = dismiss.indexOf('rollAway(rec.el)');
  assert.ok(rolled > 0 && rolled < dismiss.indexOf('leaveStack(rec.el)'), 'before it leaves the layout');
  assert.match(dismiss, /roll\.done\.then\(\(\) => glide\(\(\) => rec\.el\.remove\(\)\)\)/);
});

test('the island card leaves after the roll, and news takes the roll back', () => {
  const island = read('js/toast-island.js');
  const close = island.slice(island.indexOf('async function close(g)'), island.indexOf('async function render'));
  const waited = close.indexOf('await rolling.done');
  assert.ok(waited > 0 && close.indexOf('release(false)', waited) > waited, 'gone only after the roll');
  assert.match(island, /if \(rolling\) \{ rolling\.cancel\(\); rolling = null; \}/);
});

test('the window page loads the roll and only Windows turns it on', () => {
  const page = read('screen-alerts.html');
  const roll = page.indexOf('<script src="js/alert-roll.js"');
  assert.ok(roll > 0 && roll < page.indexOf('<script src="js/screen-alerts.js"'));
  const script = read('js/screen-alerts.js');
  assert.match(script, /window\.__XENON_ROLL_CARDS__ === true/);
  assert.match(script, /card\.closest\('\.is-rolling'\)/);
  const mod = read('../apps/native/src-tauri/src/layers/mod.rs');
  assert.match(mod, /#\[cfg\(windows\)\]\s+let builder = if alerts \{ builder\.initialization_script\(ALERTS_ROLL\) \}/);
});

test('a cut window never gets the old title bar painted inside the cut', () => {
  const rust = read('../apps/native/src-tauri/src/layers/win32.rs');
  const hooked = rust.indexOf('SetWindowSubclass(p.hwnd, no_title_bar');
  assert.ok(hooked > 0, 'the white band behind a clicked card was this bar');
  assert.ok(hooked < rust.indexOf('cut_region(p.hwnd, &entry.base, &[])'), 'before the first cut');
});

test('a card moving under the cut is followed frame by frame', () => {
  const script = read('js/screen-alerts.js');
  const report = script.slice(script.indexOf('function report()'), script.indexOf('function scheduleReport'));
  assert.match(report, /if \(moving\) frame = requestAnimationFrame\(report\)/);
});
