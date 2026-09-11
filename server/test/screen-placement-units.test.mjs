// Why Xenon would not move onto the Xeneon Edge on a Mac.
//
// The panel was detected, tagged "Xeneon Edge" in the picker and chosen — and
// the dashboard opened as a window on the main display anyway, with nothing
// failing and nothing to say why.
//
// Two APIs measure in different units and neither says so.
// `Monitor::position()` and `Monitor::size()` are built with the scale factor of
// the monitor being ASKED ABOUT. `set_position` and `set_size` convert what they
// are given with the scale factor of the display the window is on RIGHT NOW. On
// Windows and Linux both are physical pixels and the two agree. On macOS they
// disagree the moment the screens differ — a Retina main display beside a 1×
// Edge — and the failure is silent: asking for the Edge's origin (1512, 0) while
// the window is still on a 2× screen lands it at (756, 0), a point inside the
// main display. The window never leaves.
//
// It was never only the Edge: moving the dashboard to ANY second screen with a
// different backing scale had the same fate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MON = readFileSync(new URL('../../apps/native/src-tauri/src/monitor.rs', import.meta.url), 'utf8');

/** The same arithmetic monitor_rect() does, so the rule can be checked here. */
function monitorRect({ x, y, w, h, scale }, macos) {
  const k = macos ? 1 / Math.max(scale, 1) : 1;
  return { x: x * k, y: y * k, w: w * k, h: h * k };
}
/** What tao then makes of it: the setter divides by the WINDOW's scale factor. */
function landsAt(rect, windowScale, macos) {
  return macos ? rect : { x: rect.x / windowScale, y: rect.y / windowScale };
}

test('the reported case: a 1x Edge beside a 2x main display', () => {
  // tao reports a monitor's origin as points x its OWN scale, so the Edge at
  // point origin (1512, 0) on a 1x panel reads as (1512, 0).
  const edge = { x: 1512, y: 0, w: 2560, h: 720, scale: 1 };
  // Physical, the old way: the setter divides by the window's scale (2, because
  // the window is still on the Retina display) and the window stays put.
  const old = landsAt(monitorRect(edge, false), 2, false);
  assert.equal(old.x, 756);
  assert.ok(old.x < 1512, 'the window never reaches the Edge — it lands inside the main display');
  // Logical: unchanged by that conversion, so it means the same thing on either
  // screen and the window arrives.
  const now = landsAt(monitorRect(edge, true), 2, true);
  assert.equal(now.x, 1512);
});

test('the size travels too, or the kiosk covers a quarter of the panel', () => {
  const edge = { x: 0, y: 0, w: 2560, h: 720, scale: 1 };
  const logical = monitorRect(edge, true);
  assert.deepEqual([logical.w, logical.h], [2560, 720]);
  // A 2x Edge (a HiDPI mode) reports 5120x1440 physical for the same panel; in
  // points that is still 2560x720, which is what the window has to be told.
  const hidpi = monitorRect({ x: 0, y: 0, w: 5120, h: 1440, scale: 2 }, true);
  assert.deepEqual([hidpi.w, hidpi.h], [2560, 720]);
});

test('matching scales were always fine, which is why it looked machine-specific', () => {
  const same = { x: 1920, y: 0, w: 2560, h: 720, scale: 1 };
  assert.equal(landsAt(monitorRect(same, false), 1, false).x, 1920);
  assert.equal(landsAt(monitorRect(same, true), 1, true).x, 1920);
});

test('Windows and Linux keep physical pixels, which mixed-DPI depends on', () => {
  const m = { x: 3840, y: 0, w: 2560, h: 720, scale: 2 };
  assert.equal(monitorRect(m, false).x, 3840, 'no conversion off macOS');
});

test('every placement goes through the helper — none reads a monitor directly', () => {
  // The bug was one cast repeated at five call sites. Anything that positions the
  // window from a monitor has to come through monitor_rect/point/extent, or the
  // next placement added quietly reintroduces it.
  const direct = [...MON.matchAll(/set_position\(([^)]*)\)/g)].map((m) => m[1]);
  for (const arg of direct) {
    assert.match(arg, /^point\(/, `set_position(${arg}) bypasses the unit helper`);
  }
  for (const arg of [...MON.matchAll(/set_size\(([^)]*)\)/g)].map((m) => m[1])) {
    assert.ok(/^extent\(/.test(arg) || /^windowed_size_for\(/.test(arg),
      `set_size(${arg}) bypasses the unit helper`);
  }
});

test('the conversion is macOS-only, and stated as such', () => {
  assert.match(MON, /#\[cfg\(target_os = "macos"\)\]\s*\n\s*let k = 1\.0 \/ monitor\.scale_factor\(\)\.max\(1\.0\);/);
  assert.match(MON, /#\[cfg\(not\(target_os = "macos"\)\)\]\s*\n\s*let k = 1\.0;/);
});
