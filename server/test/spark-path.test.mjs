import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { smoothLineD } = require('../js/spark-path.js');

// Walk a cubic Bézier and return every y it passes through, so the tests can
// assert what the CURVE does rather than what its control points suggest.
function sampleCurve(d, steps = 40) {
  const nums = d.replace(/^M/, '').split(/[C\s,]+/).filter(s => s !== '').map(Number);
  assert.ok(nums.every(Number.isFinite), 'path contains only finite numbers: ' + d);
  const ys = [];
  // nums = x0,y0 then 6 per segment.
  for (let i = 2; i + 5 < nums.length; i += 6) {
    const p0 = [nums[i - 2], nums[i - 1]];
    const c1 = [nums[i], nums[i + 1]];
    const c2 = [nums[i + 2], nums[i + 3]];
    const p1 = [nums[i + 4], nums[i + 5]];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      ys.push(u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]);
    }
  }
  return ys;
}

test('emits M plus one C per gap — the polyline shape `transition: d` interpolates', () => {
  const pts = [[0, 10], [10, 20], [20, 5], [30, 30]];
  const d = smoothLineD(pts, 2);
  assert.match(d, /^M0\.00,10\.00C/);
  assert.equal((d.match(/C/g) || []).length, pts.length - 1);
});

test('two points still emit a C (never an L), so command types never change with n', () => {
  assert.equal((smoothLineD([[0, 0], [10, 10]], 0).match(/C/g) || []).length, 1);
  assert.match(smoothLineD([[0, 0], [10, 10]], 0), /^M0,0C/);
});

test('the curve passes exactly through every sample', () => {
  const pts = [[0, 40], [25, 12], [50, 90], [75, 3], [100, 55]];
  const d = smoothLineD(pts, 3);
  const nums = d.replace(/^M/, '').split(/[C\s,]+/).map(Number);
  // Segment endpoints are at index 1 (start) then every 6th pair after it.
  assert.equal(nums[1], 40);
  for (let i = 0; i < pts.length - 1; i++) {
    assert.ok(Math.abs(nums[2 + i * 6 + 5] - pts[i + 1][1]) < 1e-6, `sample ${i + 1} on the curve`);
  }
});

test('monotone: a spike is rounded but never overshoots the samples', () => {
  // The failure this guards: a Catmull-Rom curve through this series bulges
  // past 100 after the spike, drawing a CPU load that never happened.
  const pts = [[0, 5], [10, 5], [20, 100], [30, 5], [40, 5]];
  const ys = sampleCurve(smoothLineD(pts, 3));
  const lo = Math.min(...ys), hi = Math.max(...ys);
  assert.ok(hi <= 100 + 1e-6, `peak stays at the sample, got ${hi}`);
  assert.ok(lo >= 5 - 1e-6, `valley stays at the sample, got ${lo}`);
});

test('monotone: a rising run never dips on the way up', () => {
  const pts = [[0, 0], [10, 1], [20, 40], [30, 41], [40, 90]];
  const ys = sampleCurve(smoothLineD(pts, 3));
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] >= ys[i - 1] - 1e-6, `no dip inside a monotone run at ${i}`);
  }
});

test('a flat series stays flat (no wobble around a constant value)', () => {
  const pts = [[0, 50], [10, 50], [20, 50], [30, 50]];
  for (const y of sampleCurve(smoothLineD(pts, 3))) assert.ok(Math.abs(y - 50) < 1e-6);
});

test('a point array walked backwards yields the same curve', () => {
  const fwd = smoothLineD([[0, 10], [10, 40], [20, 20]], 3);
  const back = smoothLineD([[20, 20], [10, 40], [0, 10]], 3);
  const a = sampleCurve(fwd), b = sampleCurve(back).reverse();
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, 'same curve either way');
});

test('null / NaN samples are dropped, never written into the path', () => {
  const d = smoothLineD([[0, 1], null, [10, NaN], [20, 3], [undefined, 4], [30, 5]], 2);
  assert.ok(!/NaN|undefined|null/.test(d), d);
  assert.equal((d.match(/C/g) || []).length, 2);
});

test('degenerate inputs return a usable string, not a broken path', () => {
  assert.equal(smoothLineD([], 2), '');
  assert.equal(smoothLineD(null, 2), '');
  assert.equal(smoothLineD([[3, 4]], 1), 'M3.0,4.0');
  // Duplicate x would divide by zero in a naive slope.
  assert.ok(!/NaN|Infinity/.test(smoothLineD([[0, 1], [0, 5], [10, 2]], 2)));
});