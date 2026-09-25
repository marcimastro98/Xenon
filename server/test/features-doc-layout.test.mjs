import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// FEATURES.md is the guide people are pointed at, and it had drifted from the
// app twice over in the same area:
//
//  · It described a "Layout Pages manager" for adding and removing pages. Those
//    controls moved next to the pager dots (dashboard-pager.js), so a user
//    following the guide went looking for a panel that no longer exists — which
//    is exactly how a moderator ended up asking whether a "Create new page"
//    button could be added to something that already had one.
//  · It said every duplicated widget is a "live mirror" of its source. Five of
//    them are not: a second Deck, Browser, Remote, Discord or Custom widget is an
//    INDEPENDENT instance with its own keys/address/page. Someone duplicating a
//    page to reuse a Deck setup therefore expected keys that were never coming.
//
// Prose can't be unit-tested, but these two claims can be pinned to the code
// that decides them, so the next change to either has to bring the guide along.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const FEATURES = readFileSync(join(repo, 'FEATURES.md'), 'utf8');
const INSTANCES = require(join(repo, 'server', 'js', 'dashboard-instances.js'));

function section(heading) {
  const at = FEATURES.indexOf(`### ${heading}\n`);
  assert.ok(at > 0, `FEATURES.md has no "${heading}" section`);
  const next = FEATURES.indexOf('\n##', at + 1);
  return FEATURES.slice(at, next < 0 ? FEATURES.length : next);
}

test('the Pages section documents the controls that actually exist', () => {
  const s = section('Pages');
  // The live controls, from dashboard-pager.js renderDots().
  for (const glyph of ['+', '✎', '×', '‹ ›']) {
    assert.ok(s.includes(glyph), `the Pages section never mentions the ${glyph} control`);
  }
  assert.match(s, /page dots/i, 'it must say where the controls are');
  assert.ok(!/Pages\*\* manager|Pages manager/.test(s), 'the "Pages manager" panel does not exist any more');
});

test('the Pages section says how to reuse a page instead of rebuilding it', () => {
  const s = section('Pages');
  assert.match(s, /Save page/, 'the one-tap way to copy a page is the whole question people ask');
  assert.match(s, /new page/i);
});

test('the Pages section warns that removing a page destroys duplicated tiles', () => {
  // dashboard-pages.js removeDashboardPage() hides singleton primaries (dock
  // restorable) but strips groups and copies, and calls Deck.forgetInstance on a
  // removed Deck copy — its keys are gone. The guide must not promise otherwise.
  const s = section('Pages');
  assert.match(s, /deleted/i);
  assert.match(s, /Deck/, 'the Deck is the copy with the most to lose');
});

test('every non-mirror duplicable widget is named where the guide claims mirroring', () => {
  const nonMirror = [...INSTANCES.DUPLICABLE_WIDGETS].filter(w => !INSTANCES.MIRROR_WIDGETS.has(w));
  assert.ok(nonMirror.length, 'no independent-instance widgets left? then this claim needs rewriting');
  // Widget id → the name the guide uses for it.
  const NAMES = { deck: 'Deck', remote: 'Remote', browser: 'Browser', custom: 'Custom', discord: 'Discord' };
  const s = section('Tab-grouping & duplication');
  for (const id of nonMirror) {
    const name = NAMES[id];
    assert.ok(name, `a new independent-instance widget "${id}" needs a name here and a mention in FEATURES.md`);
    assert.ok(s.includes(name), `FEATURES.md still implies a duplicated ${name} mirrors its source`);
  }
  assert.match(s, /independent/i);
});

test('the Deck section explains how to copy a profile into a second Deck', () => {
  const at = FEATURES.indexOf('\n## Deck\n');
  assert.ok(at > 0, 'the Deck section is gone');
  const deck = FEATURES.slice(at, FEATURES.indexOf('\n## ', at + 5));
  // The exact label of the profile-menu section that does it (deck.js).
  assert.match(deck, /From another Deck/);
  assert.match(deck, /From a Deck no longer on the dashboard/);
  assert.match(deck, /starts empty/i, 'why a new Deck is blank is the part that confuses people');
});
