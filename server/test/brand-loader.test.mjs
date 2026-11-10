// The one loader: Bit clips as self-animating SVGs (tools/brand/loader.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LOADER_FILES, clipBox, clipSvg, frameSlices, loaderFiles } from '../../tools/brand/loader.mjs';

const require = createRequire(import.meta.url);
const bit = require('../../packages/core/src/bit.js');
const { stillIndex } = require('../../packages/core/src/bit-player.js');

const viewBox = (svg) => svg.match(/viewBox="([^"]+)"/)[1];
const frames = (svg) => svg.match(/<g class="f" id="f\d+">/g) || [];

test('every frame of a clip is in its loader, timed as the clip', () => {
  for (const id of ['think', 'recharge', 'hello']) {
    const c = bit.clip(id);
    const svg = clipSvg(id);
    assert.equal(frames(svg).length, c.frames.length, id);
    assert.ok(svg.includes(`${bit.duration(c)}ms step-end`), `${id}: the loop is not the clip's length`);
    const slices = frameSlices(id);
    let at = 0;
    c.frames.forEach((f, i) => {
      assert.equal(slices[i].from, Math.round((at / bit.duration(c)) * 100000) / 1000, `${id} frame ${i}`);
      at += f.ms;
    });
    assert.equal(slices.at(-1).to, 100);
  }
});

test('without motion the loader rests on the pose the live player rests on', () => {
  const svg = clipSvg('think');
  const rest = stillIndex(bit.clip('think'));
  assert.ok(svg.includes(`#f${rest}{opacity:1}`));
  // Animation only where the viewer has not asked for less motion.
  const media = svg.indexOf('@media (prefers-reduced-motion:no-preference){');
  assert.ok(media > 0);
  assert.ok(svg.indexOf('animation:') > media, 'an animation runs outside the motion query');
});

test('a still file has one frame and no animation at all', () => {
  const svg = clipSvg('think', { still: true });
  assert.doesNotMatch(svg, /<style>|animation/);
  assert.equal((svg.match(/<g class="f" id="still">/g) || []).length, 1);
});

test('played once, Bit stays on the last frame instead of vanishing', () => {
  const svg = clipSvg('hello', { once: true });
  const last = bit.clip('hello').frames.length - 1;
  assert.ok(svg.includes('1 forwards'));
  const lastKeys = svg.slice(svg.indexOf(`@keyframes f${last}{`)).split('</style>')[0];
  assert.ok(lastKeys.endsWith('100%{opacity:1}}'), lastKeys);
  assert.match(svg, /@keyframes f0\{0%\{opacity:1\}[\d.]+%\{opacity:0\}100%\{opacity:0\}\}/);
});

test('the boot loaders share one box, so swapping them never moves Bit', () => {
  const files = Object.fromEntries(loaderFiles().map((f) => [f.name, f.bytes.toString('utf8')]));
  const boot = ['bit-recharge.svg', 'bit-hello.svg', 'bit-recharge-still.svg'].map((n) => viewBox(files[n]));
  assert.equal(new Set(boot).size, 1);
  const b = clipBox('recharge', 'hello');
  assert.equal(boot[0], `${b.x} ${b.y} ${b.w} ${b.h}`);
  assert.equal(viewBox(files['bit-think.svg']), viewBox(files['bit-think-still.svg']));
});

test('the loader set names only real clips, and never draws a shape of its own', () => {
  for (const [name, o] of Object.entries(LOADER_FILES)) {
    assert.ok(bit.clip(o.clip), name);
    const svg = clipSvg(o.clip, o);
    // Only rectangles from bit.js, and only Bit's colours.
    assert.doesNotMatch(svg, /<(path|circle|ellipse|polygon|text|image)\b/, name);
    for (const fill of svg.match(/fill="([^"]+)"/g) || []) assert.match(fill, /fill="(#[0-9a-f]{6}|rgb\(\d+,\d+,\d+\))"/i, name);
  }
});
