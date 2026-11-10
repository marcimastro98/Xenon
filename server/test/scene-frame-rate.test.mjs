// The desktop scene page steps its endless CSS animations to a few frames a
// second (js/scene-frame-rate.js): a full-screen wallpaper redrawn at the
// monitor's refresh cost ~0.7 of a core for motion nobody can tell apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FPS, stepsFor, attach } = require('../js/scene-frame-rate.js');

test('only endless animations are stepped, by their length', () => {
  assert.equal(stepsFor({ iterations: Infinity, duration: 22000 }), Math.round(22 * FPS));
  assert.equal(stepsFor({ iterations: Infinity, duration: 1200 }), Math.round(1.2 * FPS));
  // Never fewer than two frames: a one-step animation would freeze.
  assert.equal(stepsFor({ iterations: Infinity, duration: 50 }), 2);
  // Entrances and digit flips are short and seen: full rate.
  assert.equal(stepsFor({ iterations: 1, duration: 550 }), 0);
  for (const bad of [null, {}, { iterations: Infinity, duration: 'auto' }, { iterations: Infinity, duration: 0 }]) {
    assert.equal(stepsFor(bad), 0);
  }
});

function fakeAnim(timing) {
  const t = { easing: 'linear', ...timing };
  return { effect: { getTiming: () => ({ ...t }), updateTiming: (u) => Object.assign(t, u) }, timing: t };
}

test('attach steps what runs now and what starts later, pseudo-elements included', () => {
  const aurora = fakeAnim({ iterations: Infinity, duration: 22000 });
  const enter = fakeAnim({ iterations: 1, duration: 340 });
  const cloud = fakeAnim({ iterations: Infinity, duration: 7500 });
  let listener = null;
  let subtree = null;
  const doc = {
    getAnimations: () => [aurora, enter],
    addEventListener: (type, fn, capture) => { assert.equal(type, 'animationstart'); assert.equal(capture, true); listener = fn; },
  };
  attach(doc);
  assert.equal(aurora.timing.easing, `steps(${22 * FPS})`);
  assert.equal(enter.timing.easing, 'linear');
  listener({ target: { getAnimations: (o) => { subtree = o; return [cloud, aurora]; } } });
  assert.deepEqual(subtree, { subtree: true });
  assert.equal(cloud.timing.easing, `steps(${7.5 * FPS})`);
  // A target with no animations API is ignored.
  listener({ target: {} });
  attach(null);
});

test('the scene page loads it and attaches it before the scene mounts', () => {
  const src = readFileSync(new URL('../js/screen-scene.js', import.meta.url), 'utf8');
  assert.ok(src.indexOf('SceneFrameRate.attach(document)') < src.indexOf('boot();'));
});
