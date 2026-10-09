import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The interface scale on the macOS app.
//
// Reported on Discord against 4.11.11: the Nocturne Now Playing widget looked
// right in a browser but, in the macOS app, came out enlarged with blurry text
// and its controls cut off behind frame scrollbars. The scale was a CSS `zoom`
// on <html>; WKWebView carries that into the sandboxed widget frames without
// shrinking their viewport. The macOS shell now applies WKWebView page zoom
// instead, and the dashboard keeps the CSS path everywhere else.

const BRIDGE = readFileSync(new URL('../js/native-bridge.js', import.meta.url), 'utf8');
const SHELL = readFileSync(new URL('../../apps/native/src-tauri/src/lib.rs', import.meta.url), 'utf8');

function bridgeFn(name) {
  const at = BRIDGE.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' exists');
  return BRIDGE.slice(at, BRIDGE.indexOf('\n  }\n', at));
}

test('the page-zoom signal goes only to shells that declare it', () => {
  const body = bridgeFn('applyNativeZoomCss');
  assert.match(body, /caps\.nativePageZoom === true/,
    'an older shell hands an unknown scheme to the OS opener');
  const native = body.slice(body.indexOf('nativePageZoom'), body.indexOf('return;'));
  assert.match(native, /el\.style\.zoom = ''/, 'no CSS zoom on top of the native one');
  assert.match(native, /window\.__pageZoom = 1/, 'client coordinates need no correction');
  assert.match(native, /sendPageZoomSignalSoon\(\)/);
  assert.match(body.slice(body.indexOf('return;')), /el\.style\.zoom = String\(z\)/,
    'every other shell keeps the CSS path');
});

test('the signal waits for the page to load and sends only the latest scale', () => {
  const body = bridgeFn('sendPageZoomSignalSoon');
  assert.match(body, /document\.readyState === 'complete'/,
    'assigning location.href during load aborts the page in WebView2');
  assert.match(body, /pageZoomShellSignal === currentNativeZoom\) return/);
  assert.match(body, /'xenon-zoom:set\?z=' \+ currentNativeZoom/);
});

test('the shell declares the cap on macOS only and handles the signal there', () => {
  assert.match(SHELL, /"nativePageZoom": cfg!\(target_os = "macos"\)/);
  const at = SHELL.indexOf('if scheme == "xenon-zoom"');
  assert.ok(at > 0, 'handler exists');
  const head = SHELL.slice(at - 200, at);
  assert.match(head, /#\[cfg\(target_os = "macos"\)\]/);
  const body = SHELL.slice(at, SHELL.indexOf('return false;', at));
  assert.match(body, /\.clamp\(0\.6, 2\.5\)/, 'same range as the Settings slider');
  assert.match(body, /set_zoom\(z\)/);
});
