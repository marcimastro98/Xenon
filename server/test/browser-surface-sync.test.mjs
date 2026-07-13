import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBrowserSurfaceSync } = require('../browser-surface-sync.js');

const LOGIN = 'https://cam.example/login';
const STREAM = 'https://cam.example/stream';
const OTHER = 'https://cam.example/other';

// Bring two surfaces of the same tile to a shared URL, as the real flow does:
// each fires its own initial navigation, which never fans out (no prior URL).
function bothOn(sync, url, { at = 0 } = {}) {
  assert.deepEqual(sync.navigated('t::0', 'A', url, { at }), []);
  assert.deepEqual(sync.navigated('t::0', 'B', url, { at }), []);
}

test('#96: a login on one surface fans out to the idle sibling stuck on the same page', () => {
  const sync = createBrowserSurfaceSync();
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::0', 'B', 'B:t::0');
  bothOn(sync, LOGIN);

  // Surface A logs in → its page redirects LOGIN -> STREAM. B, idle on LOGIN, follows.
  const plan = sync.navigated('t::0', 'A', STREAM, { at: 100000 });
  assert.deepEqual(plan, [{ tid: 'B:t::0', url: STREAM }]);
});

test('the follower cannot bounce back — its own resulting nav is a no-op', () => {
  const sync = createBrowserSurfaceSync();
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::0', 'B', 'B:t::0');
  bothOn(sync, LOGIN);

  const plan = sync.navigated('t::0', 'A', STREAM, { at: 100000 });
  assert.deepEqual(plan, [{ tid: 'B:t::0', url: STREAM }]);
  // The caller re-navigates B → B's page fires navigated(STREAM). B was moved to
  // STREAM optimistically, so this is prev===url → nobody follows (no ping-pong).
  assert.deepEqual(sync.navigated('t::0', 'B', STREAM, { at: 100001 }), []);
});

test('a sibling that wandered off on its own is never yanked', () => {
  const sync = createBrowserSurfaceSync();
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::0', 'B', 'B:t::0');
  sync.navigated('t::0', 'A', LOGIN, { at: 0 });
  sync.navigated('t::0', 'B', OTHER, { at: 0 });   // B is on a different page

  // A navigates away from LOGIN — B is not on LOGIN, so it stays put.
  assert.deepEqual(sync.navigated('t::0', 'A', STREAM, { at: 100000 }), []);
});

test('a sibling the user just touched is left alone (idle guard)', () => {
  const sync = createBrowserSurfaceSync({ idleMs: 8000 });
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::0', 'B', 'B:t::0');
  bothOn(sync, LOGIN, { at: 0 });

  sync.markInput('t::0', 'B', 99000);              // B touched at t=99s
  // A navigates at t=100s → only 1s since B's input (< 8s) → B is spared.
  assert.deepEqual(sync.navigated('t::0', 'A', STREAM, { at: 100000 }), []);
  // Well past the idle window, the same transition does fan out.
  sync.navigated('t::0', 'A', LOGIN, { at: 100000 });   // put A back on LOGIN (no-op fanout: B not on LOGIN)
  sync.navigated('t::0', 'B', LOGIN, { at: 100000 });   // B settles back on LOGIN
  assert.deepEqual(sync.navigated('t::0', 'A', STREAM, { at: 200000 }), [{ tid: 'B:t::0', url: STREAM }]);
});

test('an explicit user navigation does not fan out (markUserNav)', () => {
  const sync = createBrowserSurfaceSync();
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::0', 'B', 'B:t::0');
  bothOn(sync, LOGIN);

  // A user types a new address on surface A → flagged, so B (idle, same page) is
  // not dragged along; state still advances so later redirects behave.
  sync.markUserNav('t::0', 'A', 100000);
  assert.deepEqual(sync.navigated('t::0', 'A', OTHER, { at: 100000 }), []);
  // The flag is one-shot: a subsequent page-driven redirect fans out again.
  sync.navigated('t::0', 'B', OTHER, { at: 100000 });        // B independently ends up on OTHER
  assert.deepEqual(sync.navigated('t::0', 'A', STREAM, { at: 100001 }), [{ tid: 'B:t::0', url: STREAM }]);
});

test('the first load and same-URL no-ops never fan out', () => {
  const sync = createBrowserSurfaceSync();
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::0', 'B', 'B:t::0');
  // First navigation on each surface has no prior URL → nothing to mirror.
  assert.deepEqual(sync.navigated('t::0', 'A', LOGIN, { at: 0 }), []);
  assert.deepEqual(sync.navigated('t::0', 'B', LOGIN, { at: 0 }), []);
  // Re-landing on the same URL (a reload) is a no-op transition.
  assert.deepEqual(sync.navigated('t::0', 'A', LOGIN, { at: 1 }), []);
});

test('surfaces are matched per logical tile, not across different tiles', () => {
  const sync = createBrowserSurfaceSync();
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::1', 'B', 'B:t::1');       // a different tab/tile entirely
  sync.navigated('t::0', 'A', LOGIN, { at: 0 });
  sync.navigated('t::1', 'B', LOGIN, { at: 0 });
  // A's tile has no sibling on t::0 → no fanout to the unrelated t::1.
  assert.deepEqual(sync.navigated('t::0', 'A', STREAM, { at: 100000 }), []);
});

test('close removes a surface and empties the tile entry', () => {
  const sync = createBrowserSurfaceSync();
  sync.open('t::0', 'A', 'A:t::0');
  sync.open('t::0', 'B', 'B:t::0');
  bothOn(sync, LOGIN);
  sync.close('t::0', 'B');
  // B is gone → A's login no longer has anyone to follow it.
  assert.deepEqual(sync.navigated('t::0', 'A', STREAM, { at: 100000 }), []);
  sync.close('t::0', 'A');
  assert.equal(sync._surfaces.has('t::0'), false);
});

test('three surfaces: every idle sibling on the shared page follows', () => {
  const sync = createBrowserSurfaceSync();
  for (const c of ['A', 'B', 'C']) sync.open('t::0', c, c + ':t::0');
  for (const c of ['A', 'B', 'C']) sync.navigated('t::0', c, LOGIN, { at: 0 });
  const plan = sync.navigated('t::0', 'A', STREAM, { at: 100000 });
  assert.deepEqual(
    plan.sort((x, y) => x.tid.localeCompare(y.tid)),
    [{ tid: 'B:t::0', url: STREAM }, { tid: 'C:t::0', url: STREAM }],
  );
});
