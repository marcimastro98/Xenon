// The foreground probe's ignore list decides what is NOT a game. Two opposite
// mistakes live here and both are user-visible, so the list is pinned:
//
//   - too narrow → Xenon's own kiosk window trips game mode against itself. A
//     running Windows image cannot be overwritten but CAN be renamed, so after
//     an update (or a helper refresh, which renames by design) the still-running
//     process reports `Xenon-native.old-1753…`. Under the old exact match that
//     stopped being "us", and the dashboard sat pinned to the Companion pill as
//     a "game" until the next restart.
//   - too wide → a real game whose name merely starts with "xenon" (Xenonauts,
//     Xenon Racer) is silently never detected. That is why the xenon branch is
//     anchored instead of matched as a substring, and it must stay that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const gd = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'gamedetect.js'));

test('our own process is ignored under every renamed-image shape', () => {
  for (const name of [
    'Xenon', 'xenon-native', 'xenon-helper',
    // Renamed while running: the tail differs by which side did the rename.
    'Xenon-native.old-1753', 'xenon-native.exe.old-20260723',
    'Xenon.old-1', 'xenon-helper.old-9',
  ]) {
    assert.equal(gd.isIgnoredProc(name), true, 'must be ignored: ' + name);
  }
});

test('a real game whose name starts with "xenon" is still detected', () => {
  for (const name of ['Xenonauts', 'Xenon Racer', 'xenon racer 2', 'xenonauts.old-1']) {
    assert.equal(gd.isIgnoredProc(name), false, 'must NOT be ignored: ' + name);
  }
});

test('the rest of the ignore list still holds', () => {
  for (const name of ['msedge', 'steamwebhelper', 'obs64', 'cmd', 'steam', 'explorer']) {
    assert.equal(gd.isIgnoredProc(name), true, 'must be ignored: ' + name);
  }
  for (const name of ['', 'eldenring', 'cyberpunk2077', 'steamdeck-sim']) {
    assert.equal(gd.isIgnoredProc(name), false, 'must NOT be ignored: ' + name);
  }
});
