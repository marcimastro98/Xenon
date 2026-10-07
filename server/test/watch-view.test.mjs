// How a watching tile (Twitch, YouTube) shows its player — js/watch-view.js.
// effectiveView is the one decision both widgets and their CSS rely on: what
// the tile really shows given what the user asked for and what is true now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WatchView = require('../js/watch-view.js');
const { effectiveView, sideOnEnter } = WatchView;

test('nothing playing is always the normal tile, whatever was asked for', () => {
  for (const view of ['normal', 'cinema', 'fill']) {
    for (const screen of [false, true]) {
      const r = effectiveView({ view, screen, side: true, playing: false });
      assert.equal(r.view, 'normal');
      assert.equal(r.screen, false);
      assert.equal(r.overlay, false);
    }
  }
});

test('the layout editor always sees the normal tile, even mid-stream', () => {
  const r = effectiveView({ view: 'fill', screen: true, side: false, playing: true, editing: true });
  assert.deepEqual([r.view, r.screen, r.overlay], ['normal', false, false]);
});

test('in the tile, the asked-for view is kept and only fill floats the controls', () => {
  assert.deepEqual(effectiveView({ view: 'normal', playing: true }), { view: 'normal', screen: false, side: true, overlay: false });
  assert.deepEqual(effectiveView({ view: 'cinema', playing: true }), { view: 'cinema', screen: false, side: true, overlay: false });
  assert.deepEqual(effectiveView({ view: 'fill', playing: true }), { view: 'fill', screen: false, side: true, overlay: true });
});

test('an unknown view from storage falls back to normal', () => {
  assert.equal(effectiveView({ view: 'theatre', playing: true }).view, 'normal');
  assert.equal(effectiveView({ view: undefined, playing: true }).view, 'normal');
});

test('full screen is cinema with the side panel and fill without it', () => {
  assert.deepEqual(effectiveView({ view: 'normal', screen: true, side: true, playing: true }), { view: 'cinema', screen: true, side: true, overlay: true });
  assert.deepEqual(effectiveView({ view: 'cinema', screen: true, side: false, playing: true }), { view: 'fill', screen: true, side: false, overlay: true });
});

test('the side panel defaults to on', () => {
  assert.equal(effectiveView({ playing: true, screen: true }).side, true);
  assert.equal(effectiveView({ playing: true, screen: true }).view, 'cinema');
});

test('full screen opens in the arrangement the tile was in', () => {
  assert.equal(sideOnEnter('cinema', false), true);
  assert.equal(sideOnEnter('fill', true), false);
  assert.equal(sideOnEnter('normal', false), false);
  assert.equal(sideOnEnter('normal', true), true);
  assert.equal(sideOnEnter('normal', undefined), true);
});
