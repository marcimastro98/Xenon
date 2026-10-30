// A hidden webview hands its memory back to Windows.
//
// A dashboard hidden for phone mode, "widgets only", Remote Desktop or the tray
// kept ~1.5 GB of RAM (measured 27 Oct 2026, iGPU). WebView2's memory target
// level `Low` brought it to 0.1-0.3 GB without stopping the page. It only works
// if EVERY hide asks for it and every show undoes it, so this file keeps the
// main window's hides and shows going through the two helpers. The native crate
// is not built by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = '../../apps/native/src-tauri/src/';
const MON = read(`${SRC}monitor.rs`);
const TRAY = read(`${SRC}tray.rs`);
const LIB = read(`${SRC}lib.rs`);
const SPOT = read(`${SRC}spotlight_window.rs`);
const LEVEL = read(`${SRC}memory_level.rs`);

/** The body of `fn name(` up to the next top-level item. */
function fnBody(src, name) {
  const start = src.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} exists`);
  const rest = src.slice(start);
  return rest.slice(0, rest.search(/\n}\n/) + 2);
}

test('the main window is hidden and shown only through the helpers', () => {
  const helpers = fnBody(MON, 'hide_window') + fnBody(MON, 'show_window');
  const outside = MON.replace(fnBody(MON, 'hide_window'), '').replace(fnBody(MON, 'show_window'), '');
  // Comments may name the calls; code may not.
  const code = outside.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /window\.(hide|show)\(\)/, 'a bare hide()/show() skips the memory level');
  assert.match(helpers, /set_low\(window, true\)/);
  assert.match(helpers, /set_low\(window, false\)/);
  assert.match(TRAY, /monitor::hide_window\(&w\)/, 'tray Hide goes through the helper');
  assert.doesNotMatch(TRAY, /w\.hide\(\)/);
});

test('a show asks for memory before the window appears', () => {
  const show = fnBody(MON, 'show_window');
  assert.ok(show.indexOf('set_low') < show.indexOf('.show()'), 'Normal first, then show');
});

test('a window that starts hidden and the search window are covered too', () => {
  assert.match(LIB, /!win\.is_visible\(\)\.unwrap_or\(true\)[\s\S]{0,80}set_low\(&win, true\)/);
  assert.match(LIB, /Focused\(true\)[\s\S]{0,200}set_low\(&focused, false\)/, 'focus is the safety net');
  const hide = fnBody(SPOT, 'hide');
  assert.match(hide, /set_low\(&win, true\)/);
  assert.ok(SPOT.indexOf('set_low(&win, false)') < SPOT.indexOf('win.show()'));
});

test('the level is the WebView2 switch, best-effort and Windows only', () => {
  assert.match(LEVEL, /ICoreWebView2_19/);
  assert.match(LEVEL, /COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW/);
  assert.match(LEVEL, /#\[cfg\(not\(windows\)\)\]/);
  // Never the controller's visibility in the level switch: that would throttle
  // the driver page. Only set_visible touches it…
  assert.doesNotMatch(fnBody(LEVEL, 'apply'), /SetIsVisible/);
  assert.doesNotMatch(fnBody(LEVEL, 'set_low'), /SetIsVisible/);
  assert.match(fnBody(LEVEL, 'set_visible'), /SetIsVisible\(visible\)/);
});

test('…and set_visible stops only the desktop scene windows', () => {
  const callers = [];
  for (const f of ['lib.rs', 'monitor.rs', 'tray.rs', 'spotlight_window.rs', 'layers/mod.rs', 'layers/win32.rs']) {
    if (read(`${SRC}${f}`).includes('set_visible(')) callers.push(f);
  }
  assert.deepEqual(callers, ['layers/mod.rs']);
  const MOD = read(`${SRC}layers/mod.rs`);
  assert.match(fnBody(MOD, 'memory_for'), /if win\.label\(\)\.starts_with\("scene-"\) \{\n\s+crate::memory_level::set_visible\(&win, !low\);/);
});

test('a hidden widget layer gives its memory back too', () => {
  const WIN = read(`${SRC}layers/win32.rs`);
  const MOD = read(`${SRC}layers/mod.rs`);
  // win32::show is the one place a layer window changes visibility.
  assert.match(fnBody(WIN, 'show'), /ShowWindow[\s\S]*super::memory_for\(e\.hwnd, !on \|\| e\.empty\)/);
  const finder = fnBody(MOD, 'memory_for');
  assert.match(finder, /set_low\(&win, low\)/);
  // Never LIVE here: sync can hold it while waiting on the main thread.
  assert.doesNotMatch(finder, /LIVE/);
});

test('a shown window with nothing drawn (the alerts window between cards) is Low too', () => {
  const WIN = read(`${SRC}layers/win32.rs`);
  const region = fnBody(WIN, 'memory_for_region');
  // Only on a change, and never while hidden: show() owns that case.
  assert.match(region, /if e\.empty == empty \{\n\s+return;/);
  assert.match(region, /IsWindowVisible\(e\.hwnd\)[\s\S]*super::memory_for\(e\.hwnd, empty\)/);
  assert.match(fnBody(WIN, 'set_region'), /memory_for_region\(e, rects\.is_empty\(\)\)/);
});
