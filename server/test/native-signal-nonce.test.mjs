import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from './native-source.mjs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The native shell acts on `xenon-*:` navigations (restart, screen changes, the
// updater…) and used to hand any other scheme to the OS opener. On macOS and
// Linux its navigation hook also sees what a sandboxed community widget frame
// navigates to, so a widget could restart the app or launch `search-ms:`,
// `ms-settings:`, `vscode://`, `smb://` handlers. The shell now obeys only
// signals carrying a per-launch nonce that exists in the top-level page alone,
// sends only http/https/mailto/tel to the opener, and treats loopback as its own
// page only on its port. The Rust rules have unit tests in nav_policy.rs; these
// hold the wiring and the page side.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A Windows checkout has CRLF: the patterns below cut on "\n".
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const LIB = read('apps/native/src-tauri/src/lib.rs');
const POLICY = read('apps/native/src-tauri/src/nav_policy.rs');

function mainHook() {
  const at = LIB.indexOf('.on_navigation(move |raw| {');
  assert.ok(at > 0, 'the main window hook takes the raw URL');
  return LIB.slice(at, LIB.indexOf('// WebView2 browser arguments.', at));
}

test('the main window hook checks the nonce before acting on any signal', () => {
  const hook = mainHook();
  const check = hook.indexOf('nav_policy::verified_signal(raw, &signal_nonce)');
  assert.ok(check > 0);
  assert.match(hook.slice(check, check + 500), /None => return false/, 'a signal without the nonce is dropped');
  for (const s of ['xenon-update', 'xenon-app', 'xenon-setup', 'xenon-home', 'xenon-display', 'xenon-cursor', 'xenon-zoom', 'xenon-fullscreen', 'xenon-focus']) {
    const at = hook.indexOf(`scheme == "${s}"`);
    assert.ok(at > check, `${s} is handled only after the nonce check`);
  }
});

test('only web and contact links reach the OS opener, and only our port is our page', () => {
  const hook = mainHook();
  const opener = hook.indexOf('.opener().open_url(');
  assert.ok(opener > 0);
  assert.match(hook.slice(opener - 200, opener), /if nav_policy::opens_externally\(url\) \{/);
  assert.equal(hook.split('.opener().open_url(').length, 2, 'one opener call, behind the allowlist');
  assert.match(hook, /if nav_policy::is_own_page\(url, port\) \{\s*return true;/);
  assert.doesNotMatch(hook, /Some\("127\.0\.0\.1"\) \| Some\("localhost"\)/, 'no any-port loopback rule left');
  assert.match(POLICY, /matches!\(url\.scheme\(\), "http" \| "https" \| "mailto" \| "tel"\)/);
  // The YouTube player in a tile still loads in place.
  assert.match(hook, /embed_nav::is_youtube_embed\(url\)/);
});

test('the nonce reaches the page through the main window initialization script', () => {
  assert.match(LIB, /let signal_nonce = nav_policy::new_nonce\(\);/);
  assert.match(LIB, /let nonce_js = nav_policy::nonce_script\(&signal_nonce, port\);/);
  assert.match(LIB, /let init_script = format!\("[^"]*\{nonce_js\}"\);/);
  assert.match(LIB, /\.initialization_script\(&init_script\)\s*\.on_navigation\(move \|raw\|/);
  // Main frame and our own origins only (WebView2 runs init scripts in every frame).
  assert.match(POLICY, /if\(window\.top!==window\)return;if\(o\.indexOf\(location\.origin\)<0\)return;/);
});

// Rebuild the exact JS nonce_script emits for a known nonce and run it, so the
// page-side contract is exercised, not just grepped.
function nonceScript(nonce, origins) {
  const fn = POLICY.slice(POLICY.indexOf('pub fn nonce_script('));
  const m = /format!\(\s*"([\s\S]*?)"\s*\)/.exec(fn);
  assert.ok(m, 'nonce_script format string found');
  const js = m[1]
    .replace(/\\\n\s*/g, '')
    .replace(/\{\{/g, '{').replace(/\}\}/g, '}')
    .replace('{NONCE_KEY}', 'xn')
    .replace('({n},{origins})', `(${JSON.stringify(nonce)},${JSON.stringify(origins)})`);
  return js;
}

function runIn(origin, top, js) {
  const window = {};
  window.top = top ? window : {};
  const ctx = vm.createContext({ window, location: { origin }, Object, String });
  vm.runInContext(js, ctx);
  return window;
}

test('the signal helper exists only in the top-level page of our own origins', () => {
  const js = nonceScript('abc', ['http://127.0.0.1:3030', 'tauri://localhost']);
  const main = runIn('http://127.0.0.1:3030', true, js);
  assert.equal(main.__xenonSignal('xenon-app:restart'), 'xenon-app:restart?xn=abc');
  assert.equal(main.__xenonSignal('xenon-display:screen?id=1&fullscreen=0'), 'xenon-display:screen?id=1&fullscreen=0&xn=abc');
  assert.throws(() => { 'use strict'; main.__xenonSignal = null; }, 'page script cannot swap it out');
  assert.equal(runIn('tauri://localhost', true, js).__xenonSignal('xenon-setup:run'), 'xenon-setup:run?xn=abc');
  assert.equal(runIn('http://127.0.0.1:3030', false, js).__xenonSignal, undefined, 'a widget frame never gets it');
  assert.equal(runIn('null', false, js).__xenonSignal, undefined, 'a sandboxed (opaque origin) frame never gets it');
  assert.equal(runIn('https://www.youtube.com', true, js).__xenonSignal, undefined, 'nor a foreign page in the main frame');
  assert.equal(runIn('http://127.0.0.1:8080', true, js).__xenonSignal, undefined, 'nor another local port');
});

// Every signal any shell window's pages send must carry the nonce, or the
// shell drops it and the feature silently stops working. The layer windows
// and the Spotlight window check their own nonce too (layers/mod.rs,
// spotlight_window.rs): on macOS and Linux their hooks also see navigations
// from the sandboxed widget frames those pages host.
const OWN_HOOK_PAGES = new Set();

function senders() {
  const files = [];
  for (const dir of ['server/js', 'server', 'apps/native/splash']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (/\.(js|html)$/.test(f)) files.push(`${dir}/${f}`);
    }
  }
  return files;
}

test('every main-window signal is sent through the nonce helper', () => {
  const sig = /['"]xenon-(app|update|setup|home|display|cursor|zoom|fullscreen|focus):/;
  const unwrapped = [];
  for (const f of senders()) {
    if (OWN_HOOK_PAGES.has(f)) continue;
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!/location\.(href\s*=|assign\(|replace\()/.test(t)) return;
      if (!sig.test(t) && !/location\.href = \(window\.__xenonSignal/.test(t) && !/location\.href = next;/.test(t)) return;
      if (!/\(window\.__xenonSignal \|\| String\)\(/.test(t)) unwrapped.push(`${f}:${i + 1}: ${t}`);
    });
  }
  assert.deepEqual(unwrapped, []);
  const bridge = read('server/js/native-bridge.js');
  assert.match(bridge, /window\.location\.href = \(window\.__xenonSignal \|\| String\)\(next\);/, 'the display signals too');
  assert.match(LIB, /typeof window\.__xenonSignal === 'function' \? window\.__xenonSignal\(sig\) : sig/, 'and F11 from the shim');
});

test('layer windows and Spotlight require their own nonce', () => {
  const layers = read('apps/native/src-tauri/src/layers/mod.rs');
  assert.match(layers, /let nonce = crate::nav_policy::new_nonce\(\);/);
  assert.match(layers, /\.initialization_script\(&nonce_js\)/);
  assert.match(layers, /crate::nav_policy::verified_signal\(url, nonce\)/);
  assert.match(layers, /"http" \| "https" if crate::nav_policy::is_own_page\(url, port\(\)\) => true/, 'own pages on its own port only');
  const spot = read('apps/native/src-tauri/src/spotlight_window.rs');
  assert.match(spot, /let Some\(url\) = crate::nav_policy::verified_signal\(raw, &nonce\) else \{ return false \};/);
  assert.match(spot, /crate::nav_policy::is_own_page\(raw, spotlight_port\(\)\)/);
});
