// Why Xenon opened as a small window on the main screen after a restart.
//
// Reported on Discord: after starting the computer the app did not seem to start,
// and when it opened it was a window on the main screen instead of full screen on
// the Xeneon Edge. On Windows the saved screen id is `\\.\DISPLAYn`, numbered in
// the order the screens come up, and after a restart the Edge often comes up
// last, so the saved "Display 2" can be the main screen. The shape saved with the
// choice was only read when NO screen had the id, which is never the case after
// a renumbering. The Rust side has unit tests for the rule (`pick_tests`); this
// keeps the wiring, since `npm test` does not build the native crate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const MON = read('../../apps/native/src-tauri/src/monitor.rs');
const LIB = read('../../apps/native/src-tauri/src/lib.rs');

function fnBody(src, name) {
  const start = src.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} exists`);
  const rest = src.slice(start);
  return rest.slice(0, rest.search(/\n}\n/) + 2);
}

test('the saved id has to agree with the saved shape, and the shape wins', () => {
  const pick = fnBody(MON, 'pick_chosen');
  assert.match(pick, /fp_size\(s\) == fp_size\(saved\)/, 'the id is checked against the shape');
  assert.match(pick, /Pick::Shape \{ index, moved: by_name\.is_some\(\) \}/);
  assert.match(pick, /fp_is_edge\(saved\) => Pick::Waiting/, 'a missing Edge is waited for, never replaced');
});

test('the first frame and every later placement use the same rule', () => {
  assert.match(fnBody(MON, 'chosen_monitor'), /pick_in\(/);
  assert.match(fnBody(MON, 'initial_window'), /pick_in\(/);
  assert.doesNotMatch(MON, /fn monitor_by_fingerprint\(/, 'the id-first lookup is gone');
});

test('a choice found by its shape is saved again under its current id', () => {
  const chosen = fnBody(MON, 'chosen_monitor');
  assert.match(chosen, /heal_saved_id\(/);
  const heal = fnBody(MON, 'heal_saved_id');
  assert.match(heal, /p\.monitor == old/, 'only if the choice did not change in the meantime');
  assert.match(heal, /set_placement_cache\(/);
});

test('a window hidden at login in Auto mode is shown once a screen can be read', () => {
  const wd = fnBody(MON, 'start_watchdog');
  const hidden = wd.indexOf('if NO_SCREEN.load(Ordering::SeqCst) {');
  const edge = wd.indexOf('if let Some(edge) = find_edge(&window)');
  assert.ok(hidden > 0 && edge > hidden, 'checked before the Edge branch, which only moves the window');
  assert.match(wd.slice(hidden, edge), /place_now\(&window\)/);
});

test('opening Xenon again places it, and a second login launch changes nothing', () => {
  const si = LIB.slice(LIB.indexOf('tauri_plugin_single_instance::init('));
  const body = si.slice(0, si.indexOf('}))'));
  assert.match(body, /args\.iter\(\)\.any\(\|a\| a == "--autostart"\)/);
  assert.match(body, /monitor::reveal\(app\)/);
  assert.match(fnBody(MON, 'reveal'), /show_now\(app\)/);
});

test('the Windows login entry is written with the path in quotes', () => {
  const sync = fnBody(LIB, 'sync_autostart');
  assert.match(sync, /#\[cfg\(windows\)\]\s*quote_login_entry\(app\)/);
  const quote = fnBody(LIB, 'quote_login_entry');
  assert.match(quote, /format!\("\\"\{\}\\" --autostart", exe\.display\(\)\)/);
  assert.match(quote, /CurrentVersion\\Run/);
});

test('every launch writes where the window went to the crash log', () => {
  assert.match(LIB, /monitor::place_now\(&window\);\n\s*monitor::note_startup\(&window, autostarted\);/);
  const note = fnBody(MON, 'note_startup');
  assert.match(note, /started \{\}; show on: \{asked\}; screens: \{\}; placed: \{placed\}/);
  assert.match(fnBody(MON, 'note_pick'), /LAST_PICK_NOTE/, 'said once, not every 3 seconds');
});
