// The bar draws four badges at most. Until 5.3 a fifth was dropped without a word
// and never came back, even after a place freed up, and a package switched off in
// the bar still held one of the four places through its tile. Seen on 21 Nov 2026
// with five badge widgets installed: the newest one showed nothing until it was
// switched off and on again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const SCRIPTS = [
  'widget-sdk/sdk-island-schema.js', 'deck/deck-icons.js', 'widget-sdk/sdk-block-render.js', 'widget-sdk/sdk-badges.js',
].map((rel) => readFileSync(join(JS, rel), 'utf8'));

function rig() {
  const { document } = makeDom();
  const host = document.createElement('span');
  host.id = 'clock-sdkbadges';
  document.body.append(host);
  const hidden = new Set();
  const events = [];
  const window = {
    t: (k) => k,
    SdkIsland: { sourceEnabled: (id) => !hidden.has(id) },
    dispatchEvent: (e) => { events.push(e.type); return true; },
  };
  const ctx = { window, document, setInterval: () => 1, clearInterval: () => {}, CustomEvent: class { constructor(type) { this.type = type; } } };
  ctx.globalThis = window;
  for (const src of SCRIPTS) vm.runInNewContext(src, ctx);
  const B = window.SdkBadges;
  const claim = (id) => B.set(id, B.normalize({ text: id }), null);
  const shown = () => host.children.map((c) => c.textContent);
  return { B, host, hidden, events, claim, shown };
}

test('a fifth badge waits, and takes the first place that frees up', () => {
  const { B, claim, shown } = rig();
  ['a', 'b', 'c', 'd', 'e'].forEach(claim);
  assert.deepEqual(shown(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...B.waiting()], ['e']);
  B.clear('b');
  assert.deepEqual(shown(), ['a', 'c', 'd', 'e']);
  assert.deepEqual([...B.waiting()], []);
});

test('a badge switched off in the bar holds no place, and comes back in its order', () => {
  const { B, hidden, claim, shown } = rig();
  ['a', 'b', 'c', 'd', 'e'].forEach(claim);
  hidden.add('b');
  B.apply();
  assert.deepEqual(shown(), ['a', 'c', 'd', 'e'], 'the waiting one is drawn at once');
  assert.deepEqual([...B.waiting()], [], 'a switched-off badge is not waiting: the person chose it');
  hidden.delete('b');
  B.apply();
  assert.deepEqual(shown(), ['a', 'b', 'c', 'd'], 'claim order wins back');
  assert.deepEqual([...B.waiting()], ['e']);
});

test('the waiting badge keeps its latest value', () => {
  const { B, claim, shown } = rig();
  ['a', 'b', 'c', 'd'].forEach(claim);
  B.set('e', B.normalize({ text: 'old' }), null);
  B.set('e', B.normalize({ text: 'new' }), null);
  B.clear('a');
  assert.deepEqual(shown(), ['b', 'c', 'd', 'new']);
});

test('Settings hears when a badge starts or stops waiting', () => {
  const { B, events, claim } = rig();
  ['a', 'b', 'c', 'd'].forEach(claim);
  events.length = 0;
  claim('e');
  assert.ok(events.includes('xenon:sdk-badges'));
  events.length = 0;
  claim('e');
  assert.equal(events.length, 0, 'a value update of a waiting badge says nothing');
  B.clear('a');
  assert.ok(events.includes('xenon:sdk-badges'));
});

test('the host hides with no chip drawn', () => {
  const { B, host, hidden, claim } = rig();
  claim('a');
  assert.equal(host.hidden, false);
  hidden.add('a');
  B.apply();
  assert.equal(host.hidden, true);
});
