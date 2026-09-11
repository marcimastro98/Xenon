import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// A second Discord tile, so the notification feed and the voice controls can be
// on screen at the same time — asked for on Discord by someone who wanted one
// above the other. The widget's rendering was already written for several tiles
// (`tiles()` paints them all, every lookup is scoped to its own mount, no ids);
// two things were in the way, and both are pinned here.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const DI = require('../js/dashboard-instances.js');
const WIDGET = read('js', 'discord-widget.js');
const LAYOUT = read('js', 'dashboard-layout.js');

test('the Discord tile can be duplicated', () => {
  assert.equal(DI.isDuplicable('discord'), true);
  assert.equal(DI.isDuplicable('discord~aa'), true, 'a copy id must resolve to its base');
});

test('Discord copies are NOT mirror copies', () => {
  // A mirror copy is a dead clone of a primary that owns the real content, so
  // deleting the primary's page relocates the primary onto the copy's slot. Every
  // Discord tile builds and paints its own body, so there is no primary to follow
  // and no reason to move one — and doing it would drag the tile the user kept
  // onto the geometry of the one they deleted.
  assert.equal(DI.isMirrorWidget('discord'), false);
});

test('a Discord copy is cloned EMPTY so it rebuilds with live listeners', () => {
  // cloneNode copies markup and the data-dc-built marker but not one listener.
  // Left as-is the copy looks perfect and answers nothing: every button, tab and
  // slider dead. ensure() skips a mount already marked built, so the marker and
  // the markup both have to go.
  assert.match(LAYOUT, /discord: stripDiscordClone,/);
  const fn = LAYOUT.slice(LAYOUT.indexOf('function stripDiscordClone('), LAYOUT.indexOf('function stripChatClone('));
  assert.match(fn, /\.discord-widget-mount/);
  assert.match(fn, /replaceChildren\(\)/);
  assert.match(fn, /delete mount\.dataset\.dcBuilt/);
  // ensure()'s guard is what this exists for — if the guard changes, so must this.
  assert.match(WIDGET, /if \(mount\.dataset\.dcBuilt === '1' && mount\.firstChild\) return;/);
});

test('the open tab belongs to the tile, not to the widget', () => {
  // It used to be one module-level `activeTab`, which was invisible while only one
  // Discord tile could exist and is exactly what a second tile is for.
  assert.ok(!/\bactiveTab\b/.test(WIDGET), 'the shared activeTab variable must be gone');
  assert.match(WIDGET, /function tabOf\(mount\)/);
  assert.match(WIDGET, /mount\.dataset\.dcTab = tb\.id;/);
  // paint() must read each mount's own tab, not one value for all of them.
  const paint = WIDGET.slice(WIDGET.indexOf('function paint()'));
  assert.match(paint, /const tab = tabOf\(mount\);/);
  assert.match(paint, /p\.hidden = p\.dataset\.dtab !== tab;/);
});

test('the lazy loads and the roster poll ask whether ANY tile shows the tab', () => {
  // With two tiles, "is the tab open" has no single answer. One tile on Channels
  // is reason enough to poll the roster; one on Notifications means the feed is
  // being read, so nothing is unread.
  assert.match(WIDGET, /function anyTabOpen\(id\)/);
  for (const tab of ['notifs', 'soundboard', 'channels']) {
    assert.ok(WIDGET.includes(`anyTabOpen('${tab}')`), `${tab} gate still asks about one shared tab`);
  }
  assert.match(WIDGET, /if \(!anyTabOpen\('notifs'\)\) notifUnread \+= 1;/);
});

test('the tile-level tab attribute does not collide with the panel one', () => {
  // The tab PANELS inside a mount are already labelled data-dtab; the mount's own
  // tab is data-dc-tab, so a selector can never match both.
  assert.ok(!/mount\.dataset\.dtab\b/.test(WIDGET));
  assert.match(WIDGET, /mount\.dataset\.dcTab/);
});
