// The see-through window: the Windows app built transparent, so the desktop
// under it (a Wallpaper Engine scene, the wallpaper) shows behind the tiles.
// Asked for on Discord (Oct 2026) by someone running Wallpaper Engine.
//
// Three halves have to agree, and each one failing is silent:
//   * the shell (apps/native/src-tauri/src/see_through.rs) builds the window and
//     reports what it built in its caps;
//   * js/native-bridge.js reads those caps, marks <html> and sends the switch;
//   * the dashboard paints nothing of its own behind the tiles, or the window is
//     transparent and the user still sees the theme colour.
// The Rust rules themselves (when a transparent window would render blank, when
// the switch needs a relaunch) are unit-tested in see_through.rs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const BRIDGE = read('../js/native-bridge.js');
const SETTINGS = read('../js/settings.js');
const HTML = read('../index.html');
const FX_CSS = read('../styles/backgroundfx.css');
const LIB = read('../../apps/native/src-tauri/src/lib.rs');
const MONITOR = read('../../apps/native/src-tauri/src/monitor.rs');
const SEE_THROUGH = read('../../apps/native/src-tauri/src/see_through.rs');

/** Run native-bridge.js against a fake page, as the given shell would load it. */
function loadBridge(caps, { layer = false } = {}) {
  const classes = new Set();
  const navigations = [];
  const location = {};
  Object.defineProperty(location, 'href', {
    get: () => 'http://127.0.0.1:3030/',
    set: (v) => navigations.push(v),
  });
  const document = {
    readyState: 'complete',
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} }, style: {} },
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    __XENON_NATIVE__: caps !== null,
    __XENON_NATIVE_CAPS__: caps || undefined,
    __XENON_LAYER_SHELL__: layer,
    location,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  window.window = window;
  const context = vm.createContext({
    window, document, location, navigator: { userAgent: 'test' },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => new Promise(() => {}), console,
  });
  // Stop before init(): the rest of the bridge wires DOM it does not have here.
  // Everything this test reads is defined above that point.
  const src = BRIDGE.replace(/\n  function init\(\) \{[\s\S]*$/, '\n})();');
  vm.runInContext(src, context);
  return { native: window.XenonNative, classes, navigations, window };
}

const ON = { seeThrough: true, seeThroughOn: true, seeThroughWanted: true, seeThroughReady: true };
const OFF = { seeThrough: true, seeThroughOn: false, seeThroughWanted: false, seeThroughReady: true };

test('a window the shell built see-through marks the page before the splash lifts', () => {
  assert.ok(loadBridge(ON).classes.has('see-through'));
  assert.ok(!loadBridge(OFF).classes.has('see-through'));
  // Wanted but refused at launch (another graphics card): the window is opaque,
  // so painting nothing would show the near-black backing instead of the theme.
  assert.ok(!loadBridge({ ...ON, seeThroughOn: false, seeThroughReady: false }).classes.has('see-through'));
});

test('only the app offers it; a browser, a phone and a layer window never do', () => {
  assert.equal(loadBridge(null).native.seeThroughState().offered, false);
  assert.equal(loadBridge({ seeThrough: false }).native.seeThroughState().offered, false);
  const layer = loadBridge(ON, { layer: true });
  assert.equal(layer.native.seeThroughState().offered, false);
  assert.ok(!layer.classes.has('see-through'), 'a widget layer is transparent already and is not the dashboard');
});

test('the switch is a shell signal, and nothing is sent where it is not offered', () => {
  const on = loadBridge(OFF);
  assert.equal(on.native.setSeeThrough(true), true);
  assert.deepEqual(on.navigations, ['xenon-app:see-through-on']);
  assert.equal(on.native.seeThroughState().wanted, true, 'the page keeps the new choice until the relaunch');
  const off = loadBridge(ON);
  off.native.setSeeThrough(false);
  assert.deepEqual(off.navigations, ['xenon-app:see-through-off']);
  const browser = loadBridge(null);
  assert.equal(browser.native.setSeeThrough(true), false);
  assert.deepEqual(browser.navigations, [], 'a browser would hand the scheme to the OS opener');
});

test('the page asks before a relaunch exactly when the shell will relaunch', () => {
  // Mirrors needs_restart in see_through.rs.
  const off = loadBridge(OFF).native;
  assert.equal(off.seeThroughNeedsRestart(true), true);
  assert.equal(off.seeThroughNeedsRestart(false), false);
  const on = loadBridge(ON).native;
  assert.equal(on.seeThroughNeedsRestart(false), true);
  assert.equal(on.seeThroughNeedsRestart(true), false);
  const refused = loadBridge({ ...OFF, seeThroughReady: false }).native;
  assert.equal(refused.seeThroughNeedsRestart(true), false, 'no restart into a window that comes back opaque');
  assert.match(SEE_THROUGH, /fn needs_restart\(want: bool, active: bool, ready: bool\) -> bool \{\s*want != active && \(!want \|\| ready\)/);
});

test('the shell reports all four caps and handles both signals', () => {
  for (const cap of ['seeThrough', 'seeThroughOn', 'seeThroughWanted', 'seeThroughReady']) {
    assert.match(LIB, new RegExp(`"${cap}":`), `${cap} is never reported`);
  }
  assert.match(LIB, /"seeThrough": cfg!\(any\(windows, target_os = "macos", target_os = "linux"\)\)/,
    'offered by the Windows, macOS and Linux apps alike');
  assert.match(LIB, /"seeThroughWhy": see_through\.why/);
  // Built transparent on every platform when asked, no longer behind a cfg.
  assert.doesNotMatch(LIB, /#\[cfg\(not\(target_os = "macos"\)\)\]\s*let builder = builder\.transparent/);
  assert.match(LIB, /"see-through-on" \| "see-through-off" =>/);
  assert.match(LIB, /see_through::set_from_dashboard\(&h, want\)/);
  // Decided after the GPU pin: whether it can be drawn depends on that pin.
  assert.ok(LIB.indexOf('see_through::decide(') > LIB.indexOf('gpu::arm('), 'decided before the GPU pin it depends on');
  assert.match(LIB, /builder\.transparent\(see_through\.on\)/);
  assert.match(MONITOR, /crate::see_through::watch\(&app, presenting\.as_deref\(\)\)/,
    'nothing would bring back a window a display change left blank');
});

test('the dashboard paints nothing behind the tiles in a see-through window', () => {
  assert.match(FX_CSS, /html\.see-through,\s*\r?\nhtml\.see-through body \{\s*\r?\n\s*background: transparent !important;/);
  assert.match(FX_CSS, /html\.see-through \.user-bg-layer \{ background: transparent; \}/);
  for (const layer of ['#bg-aurora', '#bg-grid', '#bg-static', '#custom-bg-layer', '.user-bg-layer video']) {
    assert.ok(FX_CSS.includes(`html.see-through ${layer}`), `${layer} could still cover the desktop`);
  }
  // And none of them is even started: a wallpaper video decoding out of sight
  // is GPU spent on nothing.
  assert.match(SETTINGS, /const media = \(safe \|\| seeThrough\) \? null : hubSettings\.backgroundMedia;/);
  for (const flag of ['customOn', 'staticOn', 'auroraOn']) {
    assert.match(SETTINGS, new RegExp(`const ${flag} = (!safe && )?!seeThrough && `), `${flag} ignores the see-through window`);
  }
  assert.match(SETTINGS, /classList\.toggle\('grid-on', !seeThrough && /);
});

test('the Settings switch lives in Background and is shown only where it works', () => {
  const at = HTML.indexOf('id="settings-see-through-row"');
  assert.ok(at > 0, 'no switch in Settings');
  const row = HTML.slice(HTML.lastIndexOf('<div', at), HTML.indexOf('id="settings-bgstatic-group"', at));
  assert.match(row, /data-settings-cat="background"/);
  assert.match(row, /onchange="updateSeeThrough\(this\)"/);
  assert.match(row, /id="settings-see-through-blocked"/, 'a refused window must say why');
  assert.match(SETTINGS, /row\.style\.display = state\.offered \? '' : 'none'/);
  assert.match(SETTINGS, /check\.disabled = !state\.ready && !state\.wanted/, 'switching off must stay possible');
});

test('every string of the switch is translated in every language', () => {
  const I18N = read('../js/i18n.js');
  const keys = [
    'settings_see_through_head', 'settings_see_through_hint', 'settings_see_through',
    'settings_see_through_desc', 'settings_see_through_blocked', 'settings_see_through_tip',
    'settings_see_through_restart_title', 'settings_see_through_restart',
  ];
  const block = I18N.slice(I18N.indexOf('// ── See-through window'));
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    const at = block.indexOf(`Object.assign(i18n.${lang}, {`);
    assert.ok(at >= 0, `${lang} has no see-through strings`);
    const part = block.slice(at, block.indexOf('});', at));
    for (const key of keys) assert.match(part, new RegExp(`\\b${key}:`), `${lang} is missing ${key}`);
  }
});

test('each platform answers "can it be drawn here" for itself', () => {
  // Windows: the GPU rule. macOS: always. Linux: only with a compositor, since
  // without one the transparent pixels come out black.
  assert.match(SEE_THROUGH, /#\[cfg\(windows\)\]\s*fn refusal[\s\S]*?see_through_ok\(presenting\)\)\.then_some\("gpu"\)/);
  assert.match(SEE_THROUGH, /#\[cfg\(target_os = "macos"\)\]\s*fn refusal\(_presenting: Option<&str>\) -> Option<&'static str> \{\s*None/);
  assert.match(SEE_THROUGH, /#\[cfg\(target_os = "linux"\)\]\s*fn refusal[\s\S]*?is_composited\(\)[\s\S]*?then_some\("compositor"\)/);
});

test('the reason travels to the page, and each one is explained in its own words', () => {
  const st = loadBridge({ ...OFF, seeThroughWanted: true, seeThroughReady: false, seeThroughWhy: 'compositor' }).native.seeThroughState();
  assert.equal(st.why, 'compositor');
  assert.equal(loadBridge(ON).native.seeThroughState().why, '');
  assert.match(SETTINGS, /state\.why === 'compositor' \? 'settings_see_through_blocked_compositor' : 'settings_see_through_blocked'/);
  // The Wallpaper Engine tip is Windows only, like Wallpaper Engine.
  assert.match(SETTINGS, /tip\.hidden = !state\.on \|\| window\.XenonPlatform !== 'win32'/);
  const I18N = read('../js/i18n.js');
  assert.equal((I18N.match(/settings_see_through_blocked_compositor:/g) || []).length, 11, 'in every language');
});

test('the Wallpaper Engine tip names the file as a file, in every language', () => {
  // The name is typed into Wallpaper Engine, so it is its own element (never
  // split at its hyphen) and every translation leaves exactly one slot for it.
  const I18N = read('../js/i18n.js');
  const block = I18N.slice(I18N.indexOf('// ── See-through window'), I18N.indexOf('// ── Discord widget: "Reply"'));
  const tips = [...block.matchAll(/settings_see_through_tip: "([^"]*)"/g)].map((m) => m[1]);
  assert.equal(tips.length, 11);
  for (const tip of tips) {
    assert.equal(tip.split('{exe}').length, 2, `one {exe} slot: ${tip}`);
    assert.ok(!tip.includes('xenon-native.exe'), 'the name comes from the code, not the string');
  }
  assert.match(SETTINGS, /const SEE_THROUGH_EXE = 'xenon-native\.exe';/);
  assert.match(SETTINGS, /code\.className = 'settings-filename'/);
  assert.match(read('../components/SettingsModal/SettingsModal.css'), /\.settings-filename \{[^}]*white-space: nowrap;/);
  // No data-i18n on the tip: translateStatic would overwrite the built element
  // with the raw sentence, {exe} and all.
  assert.match(HTML, /<span class="settings-note" id="settings-see-through-tip" hidden><\/span>/);
});

test('while it is on, the card says the other backgrounds are paused', () => {
  assert.match(HTML, /id="settings-see-through-on" data-i18n="settings_see_through_on_note" hidden/);
  assert.match(SETTINGS, /onNote\.hidden = !state\.on/);
});

test('where it is not offered it is not a Settings search result either', () => {
  assert.match(SETTINGS, /row\.dataset\.unavailable = '1'/);
  assert.match(read('../js/settings-search.js'), /card\.dataset\.unavailable === '1'/);
});
