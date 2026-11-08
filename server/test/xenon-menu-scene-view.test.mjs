import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, previewUrl, POINT_DELAY_MS } = require('../js/xenon-menu-scene-view.js');
const { isSceneKey } = require('../js/screen-scene-model.js');

function node(tag) {
  const listeners = {};
  const n = {
    tag, dataset: {}, parent: null, kids: [], src: '', hidden: false,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type) { listeners[type](); },
    get isConnected() { return n.tag === 'body' || (!!n.parent && n.parent.isConnected); },
    appendChild(k) { k.parent = n; n.kids.push(k); return k; },
    insertBefore(k) { return n.appendChild(k); },
    remove() { n.parent = null; },
  };
  return n;
}

function rig() {
  const body = node('body');
  const made = [];
  const el = (tag) => { const n = node(tag); made.push(n); return n; };
  const view = create({ el, doc: { body }, server: 'http://127.0.0.1:3030' });
  const frames = () => made.filter((n) => n.tag === 'iframe');
  return { body, view, frames };
}

const wait = () => new Promise((done) => { setTimeout(done, POINT_DELAY_MS + 30); });

test('the preview address carries the scene, whatever its id holds', () => {
  assert.equal(previewUrl('http://x', 'theme:a b'), 'http://x/scene?key=preview%3Amenu&scene=theme%3Aa%20b');
  assert.equal(isSceneKey('preview:menu'), true);
});

test('the chosen scene shows, a pointed one replaces it, leaving brings it back', async () => {
  const { body, view, frames } = rig();
  const row = view.slot('builtin');
  body.appendChild(row.box);
  view.settle();
  const [frame] = frames();
  assert.match(frame.src, /scene=builtin$/);
  const chip = node('button');
  row.follow(chip, 'theme:ambra');
  chip.fire('pointerenter');
  await wait();
  assert.match(frame.src, /scene=theme%3Aambra$/);
  chip.fire('pointerleave');
  await wait();
  assert.match(frame.src, /scene=builtin$/);
});

test('a rebuild keeps the one frame and does not reload it', () => {
  const { body, view, frames } = rig();
  body.appendChild(view.slot('builtin').box);
  view.settle();
  const [frame] = frames();
  frame.src = 'kept';
  view.hold();
  body.appendChild(view.slot('builtin').box);
  view.settle();
  assert.equal(frames().length, 1);
  assert.equal(frame.src, 'kept');
  assert.equal(frame.isConnected, true);
});

test('another page drops the frame, so no scene keeps running unseen', () => {
  const { body, view, frames } = rig();
  body.appendChild(view.slot('builtin').box);
  view.settle();
  view.hold();
  view.settle();
  assert.equal(frames()[0].isConnected, false);
});
