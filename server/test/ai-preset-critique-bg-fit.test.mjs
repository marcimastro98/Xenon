import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { critiqueBgFit } = require('../ai/ai-preset-critique-fit.js');
const { critiquePreset } = require('../ai/ai-preset-critique.js');

const scene = (fit) => `const W = 2560, H = 720;
function draw(ctx, t, w, h, assets) {
  const s = ${fit};
  ctx.save(); ctx.scale(s, s); ctx.fillRect(0, 0, W, H); ctx.restore();
}`;

test('a background scaled with the smaller ratio of the screen gets a note about the bars', () => {
  const out = critiqueBgFit(scene('Math.min(w / W, h / H)'), 'code');
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'consider');
  assert.match(out[0].hint, /Math\.max/);
});

test('the larger ratio, one side only or names that are not the screen pass', () => {
  assert.deepEqual(critiqueBgFit(scene('Math.max(w / W, h / H)'), 'code'), []);
  assert.deepEqual(critiqueBgFit(scene('Math.min(1, w / W)'), 'code'), []);
  assert.deepEqual(critiqueBgFit(scene('Math.min(a / W, b / H)'), 'code'), []);
  assert.deepEqual(critiqueBgFit('ctx.fillRect(0, 0, 10, 10);', 'code'), [], 'no draw function, nothing to say');
});

test('the note follows draw\'s own names for the size', () => {
  const code = 'function draw(c, time, width, height) { const k = Math.min(width / 1920, height / 1080); c.scale(k, k); }';
  assert.equal(critiqueBgFit(code, 'code').length, 1);
});

test('the bg critique carries it, never as a fix', () => {
  const out = critiquePreset('bg', { code: scene('Math.min(h / H, w / W)'), fps: 30 }, {});
  const note = (out.findings || []).find((f) => /Math\.min of the screen/.test(f.problem));
  assert.ok(note, 'the note reaches the critique');
  assert.equal(note.severity, 'consider');
});
