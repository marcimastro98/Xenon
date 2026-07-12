import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AS = require('../js/ambient-scene.js');

// ── scene identity + refs ────────────────────────────────────────────────────

test('canvas ref helpers round-trip', () => {
  assert.equal(AS.canvasRef('abc'), 'canvas:abc');
  assert.equal(AS.isCanvasRef('canvas:abc'), true);
  assert.equal(AS.isCanvasRef('canvas:AB'), false);      // uppercase not allowed
  assert.equal(AS.isCanvasRef('abc'), false);
  assert.equal(AS.canvasIdOf('canvas:abc'), 'abc');
  assert.equal(AS.canvasIdOf('builtin'), '');
});

// ── normalizeScene ───────────────────────────────────────────────────────────

test('normalizeScene: junk returns null', () => {
  assert.equal(AS.normalizeScene(null), null);
  assert.equal(AS.normalizeScene('x'), null);
});

test('normalizeScene: fills defaults and generates an id', () => {
  const s = AS.normalizeScene({});
  assert.ok(AS.SCENE_ID_RE.test(s.id));
  assert.equal(s.v, AS.SCENE_SCHEMA);
  assert.equal(s.name, '');
  assert.equal(s.bg.type, 'color');
  assert.equal(s.bg.color, '#05060a');   // OLED-dark default
  assert.deepEqual(s.components, []);
});

test('normalizeScene: preserves a valid id and trims/bounds the name', () => {
  const s = AS.normalizeScene({ id: 'my-scene', name: '  Hi  ' + 'x'.repeat(200) });
  assert.equal(s.id, 'my-scene');
  assert.equal(s.name.length, AS.MAX_NAME);
});

test('normalizeScene: bounds component count', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: 'c' + i, type: 'text', props: { text: 'x' } }));
  const s = AS.normalizeScene({ components: many });
  assert.equal(s.components.length, AS.MAX_COMPONENTS);
});

test('normalizeScene: drops duplicate component ids', () => {
  const s = AS.normalizeScene({ components: [
    { id: 'dup', type: 'clock' },
    { id: 'dup', type: 'date' },
  ] });
  assert.equal(s.components.length, 1);
  assert.equal(s.components[0].type, 'clock');
});

test('normalizeScene: imported flag is sticky only when set', () => {
  assert.equal(AS.normalizeScene({}).imported, undefined);
  assert.equal(AS.normalizeScene({ imported: true }).imported, true);
  assert.equal(AS.normalizeScene({ imported: 'yes' }).imported, undefined);
});

// ── normalizeComponent ───────────────────────────────────────────────────────

test('normalizeComponent: unknown type is dropped', () => {
  assert.equal(AS.normalizeComponent({ type: 'nope' }), null);
  assert.equal(AS.normalizeComponent(null), null);
});

test('normalizeComponent: clamps geometry to percentages', () => {
  const c = AS.normalizeComponent({ type: 'clock', x: -50, y: 999, w: 0, h: 1000, rot: 999, z: -5 });
  assert.equal(c.x, 0);
  assert.equal(c.y, 100);
  assert.equal(c.w, 2);      // min width
  assert.equal(c.h, 100);
  assert.equal(c.rot, 180);
  assert.equal(c.z, 0);
});

test('normalizeComponent: text props are bounded and defaulted', () => {
  const c = AS.normalizeComponent({ type: 'text', props: { text: 'y'.repeat(999), size: 9999, weight: 550, align: 'wat' } });
  assert.equal(c.props.text.length, AS.MAX_TEXT);
  assert.equal(c.props.size, 480);        // clamped to max
  assert.equal(c.props.weight, 400);      // 550 not in the allowed set → default
  assert.equal(c.props.align, 'center');  // invalid → default
});

test('normalizeComponent: sdk without a valid pkgId is dropped', () => {
  assert.equal(AS.normalizeComponent({ type: 'sdk', props: {} }), null);
  assert.equal(AS.normalizeComponent({ type: 'sdk', props: { pkgId: 'BAD ID' } }), null);
  const c = AS.normalizeComponent({ type: 'sdk', props: { pkgId: 'my-widget', entry: '../evil.html' } });
  assert.equal(c.props.pkgId, 'my-widget');
  assert.equal(c.props.entry, 'index.html');   // traversal entry rejected → default
});

test('normalizeComponent: image url must pass the tile image allowlist', () => {
  const bad = AS.normalizeComponent({ type: 'image', props: { url: 'https://evil.example/x.png' } });
  assert.equal(bad.props.url, '');   // remote http(s) rejected
  const ok = AS.normalizeComponent({ type: 'image', props: { url: '/uploads/background-1-2.png' } });
  assert.equal(ok.props.url, '/uploads/background-1-2.png');
});

test('normalizeComponent: valid tile style survives, junk style is dropped', () => {
  const c = AS.normalizeComponent({ type: 'clock', style: { mode: 'custom', accent: '#ff0000' } });
  assert.equal(c.style.mode, 'custom');
  assert.equal(c.style.accent, '#ff0000');
  const plain = AS.normalizeComponent({ type: 'clock', style: { junk: 1 } });
  assert.equal(plain.style, undefined);
});

// ── normalizeBg ──────────────────────────────────────────────────────────────

test('normalizeBg: gradient without both stops downgrades to color', () => {
  const bg = AS.normalizeBg({ type: 'gradient', grad: { from: '#fff' } });
  assert.equal(bg.type, 'color');
  assert.equal(bg.grad, undefined);
});

test('normalizeBg: valid gradient is kept', () => {
  const bg = AS.normalizeBg({ type: 'gradient', grad: { from: '#001122', to: '#334455', angle: 45 } });
  assert.equal(bg.type, 'gradient');
  assert.deepEqual(bg.grad, { from: '#001122', to: '#334455', angle: 45 });
});

// ── normalizeScenes (array) ──────────────────────────────────────────────────

test('normalizeScenes: drops junk, dedupes ids, bounds the array', () => {
  assert.deepEqual(AS.normalizeScenes('x'), []);
  const out = AS.normalizeScenes([{ id: 'aa' }, null, { id: 'aa' }, { id: 'bb' }]);
  assert.deepEqual(out.map(s => s.id), ['aa', 'bb']);
});
