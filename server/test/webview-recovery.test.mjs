// What happens when the render process dies under the app.
//
// On Linux (WebKitGTK) the page runs in a process of its own. When it dies the
// shell does NOT: the window stays up showing its last frame, every timer inside
// the page stops because the engine running them is gone, and the first repaint
// — a click — turns the window white until the app is restarted by hand.
//
// Reported from Bazzite with the AppImage: "the clock display keeps freezing",
// then "the weather information stays displayed even though it normally updates
// at regular intervals", then "when I click on Xenon, the screen goes white and
// I have to restart the app". Two independent timers stopping together is what
// identified it — the clock is a one-second interval in main.js, the weather a
// separate wall-clock chain, and they share no code. Both stop only if the thing
// that runs them is gone.
//
// Two holes, and these tests pin both: nothing recorded the event (the crash
// diary carries panics in the SHELL process, and a dead web process is not one),
// and nothing acted on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rust = (...p) => readFileSync(join(__dirname, '..', '..', 'apps', 'native', 'src-tauri', ...p), 'utf8');
const GUARD = rust('src', 'webview_guard.rs');
const LIB = rust('src', 'lib.rs');
const CRASH = rust('src', 'crash_log.rs');
const CARGO = rust('Cargo.toml');

test('the guard listens for the render process dying', () => {
  assert.match(GUARD, /connect_web_process_terminated/);
  // WebKit names the reason — Crashed / ExceededMemoryLimit / TerminatedByApi —
  // and which one it is decides whether this is a driver fault, a leak, or us.
  // It must be recorded verbatim rather than flattened into "it died".
  assert.match(GUARD, /let reason = format!\("\{reason:\?\}"\)/);
});

test('the reason reaches the crash diary the tray already exposes', () => {
  assert.match(CRASH, /pub fn web_process_died\(reason: &str, action: &str\)/);
  assert.match(CRASH, /append\("webprocess"/);
  // Both outcomes are written down, not just the happy one: a give-up leaves the
  // user exactly where they were before this existed, so it had better say so.
  assert.match(GUARD, /web_process_died\(&reason, "reloading"\)/);
  assert.match(GUARD, /web_process_died\(&reason, "gave up after repeated restarts"\)/);
});

test('it reloads the page instead of leaving a white window', () => {
  assert.match(GUARD, /view\.reload\(\)/);
  // Not from inside the signal handler: that re-enters WebKit while it is still
  // tearing the old process down. A turn of the GTK main loop first.
  assert.match(GUARD, /timeout_add_local_once\(RELOAD_DELAY/);
});

test('a crash loop is capped rather than reloaded forever', () => {
  // A process that dies immediately on every reload would spin the CPU, fill the
  // diary, and hide the real fault behind a flickering window.
  assert.match(GUARD, /const MAX_RELOADS: u32 = \d+;/);
  assert.match(GUARD, /const WINDOW: Duration/);
  const fn = GUARD.slice(GUARD.indexOf('fn allow_reload()'));
  assert.match(fn, /n\.get\(\) >= MAX_RELOADS/);
  // The cap moves with a window, so an app left running for days can recover
  // from a handful of these far apart instead of using its budget up forever.
  assert.match(fn, /duration_since\(first\) > WINDOW/);
});

test('it is Linux only, and wired in where the other guards are', () => {
  // Windows and macOS recover from this themselves (WebView2 reloads,
  // WKWebView calls webViewWebContentProcessDidTerminate).
  assert.match(GUARD, /#!\[cfg\(target_os = "linux"\)\]/);
  assert.match(LIB, /#\[cfg\(target_os = "linux"\)\]\nmod webview_guard;/);
  assert.match(LIB, /#\[cfg\(target_os = "linux"\)\]\n\s*webview_guard::start\(&window\);/);
});

test('webkit2gtk is pinned to the version wry already resolves', () => {
  // `with_webview` hands back wry's WebView. A second, differently-versioned
  // copy of the crate would compile and then refuse to match that type, so the
  // dependency is an exact pin rather than a caret range.
  assert.match(CARGO, /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]/);
  const pin = /webkit2gtk = "=(\d+\.\d+\.\d+)"/.exec(CARGO);
  assert.ok(pin, 'webkit2gtk must be pinned exactly');
  const lock = rust('Cargo.lock');
  const locked = /name = "webkit2gtk"\nversion = "([^"]+)"/.exec(lock);
  assert.ok(locked, 'webkit2gtk missing from Cargo.lock');
  assert.equal(pin[1], locked[1], 'the pin and the locked version have drifted apart');
});
