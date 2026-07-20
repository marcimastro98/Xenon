// Announcement preferences (hubMessages / catalogDrops) — the two switches in
// Settings → Aggiornamenti that decide whether the dashboard may interrupt you.
//
// They sit next to versionPing and are normalized the OPPOSITE way on purpose:
// versionPing is a data opt-in and stays off unless chosen, these are interruption
// preferences and default on. Both server and client must agree, or a save from
// one surface flips the value for every other. Pinned against the source because
// the whole point is that the two files cannot be allowed to drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const HUBMSG = readFileSync(new URL('../js/hub-messages.js', import.meta.url), 'utf8');
const DROP = readFileSync(new URL('../js/catalog-drop.js', import.meta.url), 'utf8');

const KEYS = ['hubMessages', 'catalogDrops'];

test('both sides default the preference to on', () => {
  for (const key of KEYS) {
    assert.match(SERVER, new RegExp('^\\s*' + key + ': true,', 'm'), 'server default for ' + key);
    assert.match(CLIENT, new RegExp('^\\s*' + key + ': true,', 'm'), 'client default for ' + key);
  }
});

// The load-bearing detail. `=== true` would silently switch these off for every
// install whose settings blob predates the key, which is the entire population
// on the day this ships.
test('both sides normalize with !== false, so an absent key means on', () => {
  for (const key of KEYS) {
    assert.match(SERVER, new RegExp(key + ': source\\.' + key + ' !== false'), 'server normalize for ' + key);
    assert.match(CLIENT, new RegExp(key + ': value\\.' + key + ' !== false'), 'client normalize for ' + key);
  }
});

// Three keys, two deliberately different rules. Guards against someone
// "harmonising" them into one style, which would either switch a new data flow
// on for every existing install or switch two interruption prefs off for them.
test('the data-reporting keys keep the stricter === true rule', () => {
  for (const key of ['versionPing', 'catalogStats']) {
    assert.match(SERVER, new RegExp(key + ': source\\.' + key + ' === true'), 'server ' + key);
    assert.match(CLIENT, new RegExp(key + ': value\\.' + key + ' === true'), 'client ' + key);
    // Default true + strict normalize is what makes it "on for fresh installs,
    // off for existing ones" — both halves are required.
    assert.match(SERVER, new RegExp('^\\s*' + key + ': true,', 'm'), 'server default ' + key);
    assert.match(CLIENT, new RegExp('^\\s*' + key + ': true,', 'm'), 'client default ' + key);
  }
});

test('the install counter is reachable from Settings', () => {
  assert.match(INDEX, /id="settings-catalog-stats"[^>]*onchange="updateCatalogStats\(this\.checked\)"/);
  assert.match(CLIENT, /\$\('settings-catalog-stats'\)/);
});

test('each preference has a switch wired to its handler', () => {
  assert.match(INDEX, /id="settings-hub-messages"[^>]*onchange="updateHubMessages\(this\.checked\)"/);
  assert.match(INDEX, /id="settings-catalog-drops"[^>]*onchange="updateCatalogDrops\(this\.checked\)"/);
  // A control that is never re-synced shows a stale state after a change made on
  // another surface arrives over SSE.
  assert.match(CLIENT, /\$\('settings-hub-messages'\)/);
  assert.match(CLIENT, /\$\('settings-catalog-drops'\)/);
});

// Before v4.9.0 both mutes were localStorage-only: per device, and one-way. If
// turning the switch back on did not clear the old flag, the user would flip it
// and see no change on the device where they originally muted.
test('switching a preference back on clears the legacy per-device mute', () => {
  assert.match(CLIENT, /xeneonedge\.hubMessagesMuted/);
  assert.match(CLIENT, /xeneonedge\.catalogDropsMuted/);
  assert.match(CLIENT, /if \(on\) \{ try \{ localStorage\.removeItem/);
});

test('each module honours the setting and the legacy flag', () => {
  assert.match(HUBMSG, /HS\(\)\.hubMessages === false/);
  assert.match(DROP, /HS\(\)\.catalogDrops === false/);
  for (const src of [HUBMSG, DROP]) {
    assert.match(src, /localStorage\.getItem\(K_MUTED\) === '1'/);
  }
});
