// What is behind the dashboard when the dashboard is not painting.
//
// A window has its own backing colour under the web content, and left unset it
// is the platform default: white. The Spotlight window has always set it — the
// comment there calls it "never the WebView2 white default" — and the main
// window never did.
//
// On Windows that only costs a white flash at launch. On macOS it outlives the
// launch: after the display sleeps, WebKit brings the page back without
// repainting the root background, so the white backing shows through every gap
// and the tiles, which are translucent (materials.css composites
// rgba(--oled-bg-rgb, --panel-alpha)), sit on it as pale grey. The whole thing
// reads as "the light theme came back", which is what it was first reported as.
//
// Reported on Discord from a Mac mini (Sep 2026) on a dashboard explicitly set
// to Dark — the detail that ruled the palette out: no code path resolves an
// explicit 'dark' to a light tone, so the colours were never wrong. The surface
// behind them was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const LIB = read('../../apps/native/src-tauri/src/lib.rs');
const SPOTLIGHT = read('../../apps/native/src-tauri/src/spotlight_window.rs');
const GLOBAL_CSS = read('../styles/global.css');

/** The Color(r, g, b, a) a builder declares, or null. */
function backing(src) {
  const m = src.match(/\.background_color\(tauri::window::Color\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)\)/);
  return m ? m.slice(1).map(Number) : null;
}

test('every window Xenon builds declares its own backing', () => {
  for (const [name, src] of [['main', LIB], ['spotlight', SPOTLIGHT]]) {
    const c = backing(src);
    assert.ok(c, `the ${name} window has no background_color — its backing is the platform white`);
    assert.equal(c[3], 255, `the ${name} backing must be opaque`);
  }
});

test('the backing is dark, and never light', () => {
  const [r, g, b] = backing(LIB);
  // Not a taste call: this is the colour that shows when the page is not
  // painting, so anything bright is the bug it exists to prevent.
  assert.ok(r + g + b < 96, `the main window backing (${r},${g},${b}) is not dark`);
});

test('the backing matches the page background it stands in for', () => {
  // A backing that does not match --bg is a visible seam at every launch, and
  // a slow drift: the palette moves, this literal does not.
  const m = GLOBAL_CSS.match(/--bg:\s*#([0-9a-fA-F]{6});/);
  assert.ok(m, 'global.css no longer declares --bg');
  const css = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  assert.deepEqual(backing(LIB).slice(0, 3), css,
    `the window backing should be #${m[1]}, the same colour the page paints`);
});

test('macOS is actually reached, which takes one config flag', () => {
  // The colour alone does nothing on a Mac. WKWebView paints an opaque WHITE
  // background of its own, and the switch that turns it off (`drawsBackground`)
  // is a private key — wry compiles that call in only under its `transparent`
  // feature, which Tauri enables from `macOSPrivateApi`. Without the flag the
  // colour lands on the NSWindow and the white webview covers it: a dark window
  // behind a white app, which is no fix at all.
  const conf = JSON.parse(read('../../apps/native/src-tauri/tauri.conf.json'));
  assert.equal(conf.app.macOSPrivateApi, true,
    'without macOSPrivateApi the window backing never reaches macOS');
  // tauri-build CHECKS that the two agree and fails the build rather than
  // deriving one from the other, so the config flag alone does not compile.
  const cargo = read('../../apps/native/src-tauri/Cargo.toml');
  const feats = cargo.match(/^tauri = \{[^}]*features = \[([^\]]*)\]/m);
  assert.ok(feats, 'the tauri dependency no longer declares a feature list');
  assert.match(feats[1], /"macos-private-api"/,
    'tauri.conf.json asks for macOSPrivateApi but Cargo.toml does not enable it — the build fails');
  // Private APIs are refused by the App Store. Xenon does not ship there — if a
  // Mac App Store target ever appears, this pairing has to be reconsidered.
  const targets = (conf.bundle && conf.bundle.targets) || [];
  assert.ok(!targets.includes('app') && !targets.includes('dmg-mas'),
    'macOSPrivateApi and an App Store target cannot both be true');
});

test('the tiles really are translucent, which is why white leaked into them', () => {
  // If the panels were opaque, a white backing would show only in the gaps and
  // would never have read as a light theme.
  assert.match(read('../styles/materials.css'),
    /background:\s*rgba\(var\(--oled-bg-rgb\), var\(--panel-alpha\)\)/);
});
