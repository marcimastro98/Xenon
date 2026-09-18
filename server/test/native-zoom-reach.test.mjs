import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The interface scale, and the two ways it was out of reach.
//
// Reported by someone who arranges their dashboard from a browser on their main
// monitor and runs the app on an Edge: "the scale UI option appears only if you go
// in settings from edge screen, it was not shown in the settings from my browser
// on main screen… I spent much time trying to figure it out, and even coded a
// little upscale in my widgets in the beginning".
//
// Two faults, and the first is why the second looked defensible:
//
//  1. nativeZoom is a hubSettings field and reaches every surface, but the ONLY
//     thing that ever handed it to the native shell was syncNativeZoomControl —
//     which runs when the Settings panel is rendered on that surface. A change
//     made elsewhere sat in the app's settings, correct and ignored, until
//     Settings were opened there or the app reloaded.
//  2. So the control was hidden off the native app, because it would not have
//     worked. Which put the one control people needed out of sight from the one
//     place they configure from, with nothing to say where to look.

const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const BRIDGE = readFileSync(new URL('../js/native-bridge.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

function fn(name) {
  const at = SETTINGS.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' exists');
  return SETTINGS.slice(at, SETTINGS.indexOf('\n}', at));
}

test('a scale set on another surface reaches the app without opening Settings there', () => {
  const body = fn('applyHubSettings');
  assert.match(body, /XenonNative\.setNativeZoom === 'function'/,
    'applyHubSettings runs on every hydrate — that is the arrival point');
  assert.match(body, /setNativeZoom\(hubSettings\.nativeZoom\)/);
});

test('and it is inert where there is no shell to scale', () => {
  // setNativeZoom returns early off the native app, so the call above costs
  // nothing in a browser. If that guard ever goes, the browser would start
  // zooming itself.
  const at = BRIDGE.indexOf('function setNativeZoom(');
  assert.ok(at > 0);
  assert.match(BRIDGE.slice(at, BRIDGE.indexOf('\n  }', at)), /if \(!isNative\) return;/);
});

test('the control is no longer hidden from the surface people configure from', () => {
  const body = fn('syncNativeZoomControl');
  assert.match(body, /if \(row\) row\.style\.display = '';/, 'shown on every surface');
  assert.ok(!/row\.style\.display = isNativeApp/.test(body),
    'the native-only hide is what sent someone hunting for hours');
});

test('off the native app it says what it will and will not resize', () => {
  const body = fn('syncNativeZoomControl');
  assert.match(body, /remoteNote\.hidden = isNativeApp/,
    'the extra note appears exactly where the slider does not resize this window');
  assert.match(HTML, /id="settings-native-zoom-remote"[^>]*data-i18n="settings_native_zoom_remote"/);
  assert.match(HTML, /id="settings-native-zoom-remote"[^>]*hidden/,
    'hidden until syncNativeZoomControl decides, so the native app never shows it');
});

test('both notes are translated wherever the zoom strings live', () => {
  const base = I18N.split('settings_native_zoom_note').length - 1;
  const mine = I18N.split('settings_native_zoom_remote').length - 1;
  assert.equal(mine, base, `the new note is in ${mine} languages, the existing one in ${base}`);
});

test('the slider still writes through the persisting path', () => {
  // updateNativeZoom normalizes + saves + re-syncs; the browser must take the
  // same route or the value would never reach the app it is meant to scale.
  const body = fn('updateNativeZoom');
  assert.match(body, /normalizeSettings/);
  assert.match(body, /saveHubSettings\(\)/);
  assert.match(body, /syncNativeZoomControl\(\)/);
});
