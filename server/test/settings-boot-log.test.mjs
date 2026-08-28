// Which settings store the engine actually started on.
//
// Reported on Discord (macOS): "visual layout is back to the factory default —
// after an update the screen was loaded with many different widgets". From the
// dashboard those are indistinguishable: a layout that was reset, a layout that
// was never loaded, and an install pointed at a second data folder all render
// the same factory default. The engine knew which one it was — it had just read
// (or failed to read) settings.json a second earlier — and wrote it down
// nowhere.
//
// Worse, the boot read's failure path ended in `.catch(() => {})`. A settings
// file that exists but cannot be read left the engine serving
// DEFAULT_HUB_SETTINGS with the transfer caps, the bind host and the lighting
// config unapplied, while POST /settings — fail-closed against the same read —
// refused every save. Factory defaults that cannot be persisted, and silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// The boot chain, from the read to its catch.
const CHAIN = (() => {
  const start = SERVER.indexOf('let settingsBootRead = false;');
  assert.ok(start > 0, 'the boot settings read is still where this test looks');
  const end = SERVER.indexOf("console.error('[settings] boot read failed:", start);
  assert.ok(end > start, 'the boot chain still ends in a catch that reports');
  return SERVER.slice(start, end);
})();

test('both endings of the boot read are written to the log', () => {
  const writes = [...CHAIN.matchAll(/startupLog\.write\(/g)];
  assert.ok(writes.length >= 2, 'the load and the failure are both recorded');
  // The store that was loaded…
  assert.match(CHAIN, /settings: loaded ' \+ SETTINGS_FILE/, 'the loaded line names the file');
  // …and the one that was not there at all, which is the same screen as a reset.
  assert.match(CHAIN, /settings: no file at ' \+ SETTINGS_FILE/, 'a missing store is stated, not implied');
});

// The path is the half that separates "my layout reset" from "this install is
// reading a different folder than the one my layout is in" — the second install
// being the other way the reported screen appears.
test('every settings line names the file it is talking about', () => {
  const lines = CHAIN.split('startupLog.write(').slice(1);
  for (const line of lines) {
    const call = line.slice(0, line.indexOf(');'));
    assert.match(call, /SETTINGS_FILE/, 'a settings log line without the path cannot be acted on');
  }
});

// The chain's own terminal handler. Not the first `}).catch(` in it: the store-id
// mint has one of its own, and the mac-FDA poll legitimately keeps an empty one.
const TAIL = CHAIN.slice(CHAIN.lastIndexOf('}).catch('));

test('a settings file that cannot be read is reported, not swallowed', () => {
  // Asserted positively: the handler TAKES the error and reports it. Looking for
  // the absence of `.catch(() => {})` would match the comment that quotes it.
  assert.match(TAIL, /^\}\)\.catch\(err => \{/, 'the terminal handler receives the failure');
  const tail = TAIL;
  assert.match(tail, /FAILED to read/, 'the failure says it failed');
  // The user's own recovery instinct here is to rebuild the dashboard by hand,
  // which is exactly wrong while the real one is still on disk unread.
  assert.match(tail, /Do not re-create your setup yet/,
    'the line says what not to do while the file is unreadable');
});

// A throw from a later startup step lands in the same catch. Calling that "your
// settings could not be read" would send someone after a file that is fine.
test('a later startup failure is not reported as an unreadable store', () => {
  const tail = TAIL;
  assert.match(tail, /settingsBootRead/, 'the two failures are told apart');
  assert.match(tail, /a startup step after it failed/, 'and get different sentences');
});

// version-ping counts a birth from ENOENT alone (see version-ping.js). Feeding
// a read ERROR into that same null would call every unreadable store a fresh
// install and bend the retention curve permanently — so the boot read must stay
// un-flattened.
test('an unreadable store is never counted as a fresh install', () => {
  const line = CHAIN.match(/_settingsFileMissingAtBoot = \(s === null\);/);
  assert.ok(line, 'the fresh-install signal is still ENOENT-only');
  assert.doesNotMatch(CHAIN.slice(0, CHAIN.indexOf('.then(')), /catch\(\(\) => null\)/,
    'the boot read is not flattened to null before that test');
});
