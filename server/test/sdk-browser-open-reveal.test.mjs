// browserOpen used to answer `no_browser_tile` whenever no Browser tile was
// visible, and a tab group makes that the NORMAL case: the widget asking and the
// Browser it aims at are two members of one tile, so they can never be on screen
// together. Reported by a widget author whose Map Explorer sat in a tab group with
// the Browser — every open fell through to the external-browser path, which is the
// one thing the category exists to avoid.
//
// The fix brings a hidden tile into view instead of refusing. These tests pin the
// choice rule (which tile) and the guarantees around it: never navigate a tile that
// stays out of sight, never fight a perf/game pause, never turn the user's
// media-driven tab preference off behind their back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'server', 'js', 'browser-tile.js'), 'utf8');

/** Lift the pure choice rule out of the IIFE — it has no DOM dependencies. */
function loadPickRevealTarget() {
  const start = SRC.indexOf('function pickRevealTarget');
  const end = SRC.indexOf('function revealBrowserTile');
  assert.ok(start > 0 && end > start, 'pickRevealTarget not found in browser-tile.js');
  const context = vm.createContext({});
  vm.runInContext(SRC.slice(start, end), context);
  return context.pickRevealTarget;
}

const pickRevealTarget = loadPickRevealTarget();

test('a tile on the current page wins, so a tab switch beats a page change', () => {
  const elsewhere = { group: 'p2', onPage: false };
  const here = { group: 'p1', onPage: true };
  assert.equal(pickRevealTarget([elsewhere, here]), here);
  assert.equal(pickRevealTarget([here, elsewhere]), here);
});

test('a tile on another page is still used when that is all there is', () => {
  const elsewhere = { group: 'p2', onPage: false };
  assert.equal(pickRevealTarget([elsewhere]), elsewhere);
});

test('ties keep source order, which is the dashboard order', () => {
  const a = { group: 'a', onPage: true };
  const b = { group: 'b', onPage: true };
  assert.equal(pickRevealTarget([a, b]), a);
});

test('no mounted tile means no target — the refusal survives for the real case', () => {
  assert.equal(pickRevealTarget([]), null);
  assert.equal(pickRevealTarget(null), null);
  assert.equal(pickRevealTarget(undefined), null);
  assert.equal(pickRevealTarget([null, undefined]), null);
});

// The pieces below cannot be lifted out of the IIFE (they touch the pager, the tab
// group model and the live group map), so they are pinned against the shipped
// source. Each one is a guarantee that is invisible at the call site.

test('openFromSdk still prefers a visible tile and only then reveals one', () => {
  const start = SRC.indexOf('function openFromSdk');
  const body = SRC.slice(start, SRC.indexOf('\n  }', start));
  const visibleAt = body.indexOf('if (!target && group.visible) target = group;');
  const revealAt = body.indexOf('target = revealBrowserTile();');
  assert.ok(visibleAt > 0, 'the visible-tile scan is gone');
  assert.ok(revealAt > visibleAt, 'reveal must be the fallback, not the first choice');
  assert.ok(body.includes("return { ok: false, error: 'no_browser_tile' }"),
    'a dashboard with no Browser tile at all must still be refused');
});

test('a perf/game pause is not overridden to satisfy a widget', () => {
  const start = SRC.indexOf('function revealBrowserTile');
  const body = SRC.slice(start, SRC.indexOf('\n  }', start));
  assert.ok(/if \(perfPaused\) return null;/.test(body),
    'revealBrowserTile must bail while playback/perf mode has the tiles paused');
});

test('revealing never navigates a tile that stays out of sight', () => {
  const start = SRC.indexOf('function revealBrowserTile');
  const body = SRC.slice(start, SRC.indexOf('\n  }', start));
  // Both halves of "bring it into view": the page it lives on, and the tab it is.
  assert.ok(body.includes('pager.goToPage(pageId)'), 'a tile on another page must be scrolled to');
  assert.ok(body.includes('activateGroupTab(pick.group)'), 'a tile behind a tab must be activated');
  assert.ok(body.includes('section.isConnected'), 'an unmounted tile is not a target');
});

test('the tab switch does not turn off the media-driven auto-switch', () => {
  const start = SRC.indexOf('function activateGroupTab');
  const body = SRC.slice(start, SRC.indexOf('\n  }', start));
  assert.ok(/setGroupActive\(gid, group\.id, false\)/.test(body),
    'fromUser must be false — a widget asking is not the user changing a preference');
});

test('a hidden group defers the open so the page is not launched at the size floor', () => {
  const start = SRC.indexOf('function navigateActive');
  const body = SRC.slice(start, SRC.indexOf('\n  }', start));
  assert.ok(/if \(group\.visible\) openTab\(group, tab\);/.test(body),
    'openTab on a hidden group measures a 0-size stage and sticks at the 64px floor');
  assert.ok(body.includes("relaySend({ type: 'navigate', tile: tab.tileId, url }); return;"),
    'an already-open tab must still be navigated, visible or not');
});
