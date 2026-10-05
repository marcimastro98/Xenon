// Why Xenon came back on the wrong screen after a Mac woke from sleep.
//
// Reported from macOS with a Xeneon Edge as the second display: every wake left
// the dashboard as a small window on the main screen, and the way back was by
// hand (Show on > Display 1, drag the window onto the Edge, Show on > Display 2).
//
// Three things together. Nothing noticed the wake, and the layout reads the same
// after it, so only the drift chase ran. That chase stopped for good after five
// quick attempts. And on macOS the move and the resize are both queued, so the
// window could be sized while it was still on the main screen, where AppKit then
// kept it. The Rust side has unit tests for the pure parts (`repin_tests`); this
// file keeps the wiring from being undone, since the native crate is not built by
// `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const MON = read('../../apps/native/src-tauri/src/monitor.rs');
const LOG = read('../../apps/native/src-tauri/src/crash_log.rs');

/** The body of `fn name(` up to the next top-level item. */
function fnBody(src, name) {
  const start = src.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} exists`);
  const rest = src.slice(start);
  const end = rest.search(/\n}\n/);
  return rest.slice(0, end + 2);
}

test('the watchdog measures the gap with the wall clock, which keeps running in sleep', () => {
  const wd = fnBody(MON, 'start_watchdog');
  assert.match(wd, /SystemTime::now\(\)/);
  assert.match(wd, /slept\(last_tick, now\)/, 'a long gap between ticks is read as a wake');
  assert.doesNotMatch(wd, /Instant::now\(\)/, 'Instant stops while a Mac sleeps, so it cannot see the gap');
  assert.match(fnBody(MON, 'slept'), /duration_since/);
});

test('a wake gives the repair a fresh start, and a while to settle', () => {
  const wd = fnBody(MON, 'start_watchdog');
  const wake = wd.slice(wd.indexOf('slept(last_tick, now)'));
  assert.match(wake.slice(0, 400), /settle_until = Some\(now \+ SETTLE_AFTER_WAKE\)/);
  assert.match(wake.slice(0, 400), /repin_attempts = 0/);
});

test('past the quick attempts it keeps trying, once a minute', () => {
  assert.match(MON, /const SLOW_REPIN_EVERY: Duration = Duration::from_secs\(60\)/);
  const ra = fnBody(MON, 'repin_action');
  assert.match(ra, /since_last: Option<Duration>/);
  assert.match(ra, /SLOW_REPIN_EVERY/);
  // Both branches that chase a drifted window pass the time since the last try.
  const calls = MON.match(/repin_action\(game_mode\(\), [^)]*\)/g) || [];
  assert.ok(calls.length >= 2, 'the chosen-screen and Edge branches both ask repin_action');
  for (const c of calls) assert.match(c, /since_last\)$/);
});

test('on macOS the window reaches its screen before it is sized', () => {
  const edge = fnBody(MON, 'place_on_edge');
  const move = edge.indexOf('set_position(point(');
  const wait = edge.indexOf('wait_until_on(window, edge)');
  const size = edge.indexOf('enter_borderless_fullscreen(window, edge)');
  assert.ok(move >= 0 && wait > move && size > wait, 'move, then wait, then size');
  assert.match(edge.slice(move, wait), /#\[cfg\(target_os = "macos"\)\]/, 'only macOS waits');

  const full = fnBody(MON, 'place_fullscreen_on');
  const fMove = full.indexOf('set_position(point(');
  const fWait = full.indexOf('wait_until_on(window, monitor)');
  const fFull = full.indexOf('set_fullscreen(true)');
  assert.ok(fMove >= 0 && fWait > fMove && fFull > fWait, 'move, then wait, then full screen');
});

test('the wait never runs on the main thread, where it could only freeze the app', () => {
  const w = fnBody(MON, 'wait_until_on');
  const guard = w.indexOf('thread::current().name() == Some("main")');
  const loop = w.indexOf('thread::sleep(LANDING_POLL)');
  assert.ok(guard >= 0 && loop > guard, 'the main-thread check comes before any sleeping');
  assert.match(w, /Instant::now\(\) \+ LANDING_WAIT/, 'and it gives up after a bounded time');
});

test('what the repair did is written to the crash log', () => {
  assert.match(LOG, /pub fn note\(kind: &str, detail: &str\)/);
  assert.match(fnBody(MON, 'start_watchdog'), /crash_log::note\("display", &format!\("woke after/);
  assert.match(fnBody(MON, 'note_repin'), /crash_log::note\("display"/);
  assert.match(fnBody(MON, 'note_repin'), /should_log_repin/, 'slow retries are logged sparingly');
});
