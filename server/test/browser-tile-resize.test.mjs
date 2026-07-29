// A Browser tile pushes its size to the headless page as a fire-and-forget
// 'resize'. The screencast is change-driven, so if that message is lost, or if the
// one repaint the server forces is captured while the page is still relaying out,
// the tile is left showing the old viewport and NOTHING ever corrects it — the
// "Hide toolbar leaves the page filling a fraction of the tile" report (GitHub
// #116). These tests pin the self-healing half of the fix: every frame states the
// viewport it was rendered at, a mismatch re-asks, and the re-asking is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'server', 'js', 'browser-tile.js'), 'utf8');

function slice(from, to) {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to);
  assert.ok(start > 0 && end > start, `could not lift ${from} .. ${to} out of browser-tile.js`);
  return SRC.slice(start, end);
}

/**
 * Lift the resize verification out of the IIFE. Everything it depends on that
 * lives elsewhere (the stage measurement, the relay socket) is stubbed, so the
 * tests drive the real decision logic with a fake clock and a fake wire.
 */
function loadResizeLogic() {
  const sent = [];
  const timers = new Map();
  let seq = 0;
  let now = 0;
  const stage = { w: 900, h: 160, dpr: 1 };
  let relayUp = true;

  const context = vm.createContext({
    sent, stage,
    setRelay: (up) => { relayUp = up; },
    setStage: (w, h) => { stage.w = w; stage.h = h; },
    // Fake clock. Steps to each timer's own due time rather than jumping straight
    // to the end, so a timer armed by a timer is honoured at its real delay.
    advance: (ms) => {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [id, e] of timers) if (e.at <= until && (!next || e.at < next.at)) next = { id, ...e };
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = until;
    },
    pendingTimers: () => timers.size,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    activeTab: (group) => group.tabs[group.active] || null,
    groupMetrics: () => ({ w: stage.w, h: stage.h, dpr: stage.dpr }),
    relaySend: (msg) => { if (!relayUp) return false; sent.push(msg); return true; },
  });

  vm.runInContext(slice('const RESIZE_TOLERANCE_PX', '  // A group streams only while'), context);
  vm.runInContext(slice("  // Push the group's current stage size", '  // ── Tab lifecycle'), context);
  return context;
}

function makeGroup() {
  const tab = {
    tileId: 't::0', meta: null, opened: true,
    lastW: 0, lastH: 0, resizeTimer: null, resizeTries: 0,
  };
  const group = { visible: true, active: 0, tabs: [tab] };
  tab.group = group;
  return { group, tab };
}

// A frame carries the viewport it was rendered at; that is the whole signal.
test('frameMatchesSize compares the frame viewport against the requested size', () => {
  const ctx = loadResizeLogic();
  const { frameMatchesSize } = ctx;
  assert.equal(frameMatchesSize({ deviceWidth: 900, deviceHeight: 620 }, 900, 620), true);
  assert.equal(frameMatchesSize({ deviceWidth: 900, deviceHeight: 620 }, 900, 621), true, 'sub-pixel rounding must not trip it');
  assert.equal(frameMatchesSize({ deviceWidth: 900, deviceHeight: 160 }, 900, 620), false, 'the #116 shape: full width, stale height');
  assert.equal(frameMatchesSize({ deviceWidth: 450, deviceHeight: 620 }, 900, 620), false);
});

// A frame we cannot judge must never be treated as wrong: an older server sends no
// metadata, and re-asking forever on it would be a permanent resize loop.
test('frameMatchesSize passes anything it cannot judge', () => {
  const { frameMatchesSize } = loadResizeLogic();
  assert.equal(frameMatchesSize(null, 900, 620), true, 'no metadata');
  assert.equal(frameMatchesSize({}, 900, 620), true, 'metadata without a viewport');
  assert.equal(frameMatchesSize({ deviceWidth: 0, deviceHeight: 0 }, 900, 620), true);
  assert.equal(frameMatchesSize({ deviceWidth: 900, deviceHeight: 620 }, 0, 0), true, 'nothing requested yet');
});

const sizes = (sent) => sent.map((m) => [m.w, m.h]);

test('a matching frame disarms the watchdog and sends nothing more', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();

  ctx.setStage(900, 620);
  ctx.pushResize(group, false);
  assert.deepEqual(sizes(ctx.sent), [[900, 620]]);
  assert.ok(tab.resizeTimer, 'the watchdog must be armed until a frame confirms the size');

  tab.meta = { deviceWidth: 900, deviceHeight: 620 };
  ctx.verifyFrameSize(group, tab);
  assert.equal(tab.resizeTimer, null, 'a confirmed size disarms the watchdog');
  assert.equal(ctx.pendingTimers(), 0);

  ctx.advance(5000);
  assert.equal(ctx.sent.length, 1, 'no re-ask once the page renders at the size we asked for');
});

// The reported bug end to end: hiding the toolbar grows the stage, the page keeps
// rendering the pre-hide viewport, and because the screencast is change-driven that
// frame is the last one that ever arrives.
test('a tile left rendering the pre-resize viewport heals itself', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();

  ctx.setStage(900, 160);
  ctx.pushResize(group, false);          // tile open with the toolbar shown
  tab.meta = { deviceWidth: 900, deviceHeight: 160 };
  ctx.verifyFrameSize(group, tab);
  assert.equal(ctx.sent.length, 1);

  ctx.setStage(900, 620);                // "Hide toolbar" — the stage grows
  ctx.pushResize(group, false);
  assert.deepEqual(sizes(ctx.sent), [[900, 160], [900, 620]]);

  // The page answers with a frame still rendered at the old height, then goes quiet.
  tab.meta = { deviceWidth: 900, deviceHeight: 160 };
  ctx.verifyFrameSize(group, tab);
  ctx.advance(1000);
  assert.equal(ctx.sent.length, 3, 'the stale viewport must be re-asked, not accepted');
  assert.deepEqual(sizes(ctx.sent).at(-1), [900, 620]);

  // …and once the page catches up, everything stands down.
  tab.meta = { deviceWidth: 900, deviceHeight: 620 };
  ctx.verifyFrameSize(group, tab);
  ctx.advance(60000);
  assert.equal(ctx.sent.length, 3);
  assert.equal(ctx.pendingTimers(), 0);
});

// A frame that mismatches with no re-ask in flight is the dropped-message case: the
// size was confirmed once, then a later 'resize' never reached the page.
test('a mismatch with nothing in flight re-asks straight away', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();

  ctx.setStage(900, 160);
  ctx.pushResize(group, false);
  tab.meta = { deviceWidth: 900, deviceHeight: 160 };
  ctx.verifyFrameSize(group, tab);        // confirmed → watchdog disarmed
  assert.equal(tab.resizeTimer, null);

  ctx.setRelay(false);                     // the next push is silently dropped
  ctx.setStage(900, 620);
  ctx.pushResize(group, false);
  assert.equal(ctx.sent.length, 1, 'nothing left the browser');

  ctx.setRelay(true);
  ctx.verifyFrameSize(group, tab);         // same old frame, no watchdog armed
  assert.equal(ctx.sent.length, 2, 'the lost resize is re-sent on the next frame');
  assert.deepEqual(sizes(ctx.sent).at(-1), [900, 620]);
});

// The other half: a resize that produces no frame at all leaves nothing to compare,
// so the watchdog is what recovers it.
test('the watchdog re-asks when the resize produces no frame at all', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();

  ctx.setStage(900, 620);
  tab.meta = { deviceWidth: 900, deviceHeight: 160 };   // stuck on the pre-resize frame
  ctx.pushResize(group, false);
  assert.equal(ctx.sent.length, 1);

  ctx.advance(1000);
  assert.equal(ctx.sent.length, 2, 'silence must be retried, not accepted');

  ctx.advance(1000);
  assert.equal(ctx.sent.length, 3);
});

// Re-asking must not become a permanent loop against a page that can never match.
test('re-asking is bounded, and a fresh user resize restores the budget', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();

  ctx.setStage(900, 620);
  tab.meta = { deviceWidth: 900, deviceHeight: 160 };
  ctx.pushResize(group, false);
  ctx.advance(60000);
  const settled = ctx.sent.length;
  assert.ok(settled > 1 && settled <= 6, `expected a bounded number of re-asks, got ${settled}`);
  assert.equal(ctx.pendingTimers(), 0, 'giving up must leave no timer behind');

  // The user resizes the tile again: that is a new intent, not a continuation.
  ctx.setStage(900, 400);
  ctx.pushResize(group, false);
  assert.equal(tab.resizeTries, 0, 'a user-driven resize restarts the retry budget');
  ctx.advance(60000);
  assert.ok(ctx.sent.length > settled + 1, 'the fresh resize gets its own retry budget');
});

// A tile that went off-screen or switched tabs must not keep talking to the relay.
test('the watchdog stands down for a hidden tile', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();

  ctx.setStage(900, 620);
  tab.meta = { deviceWidth: 900, deviceHeight: 160 };
  ctx.pushResize(group, false);
  assert.equal(ctx.sent.length, 1);

  group.visible = false;
  ctx.advance(60000);
  assert.equal(ctx.sent.length, 1, 'a hidden tile emits no frames, so there is nothing to heal');
});

// A dropped send is the relay's problem: its reconnect re-opens the tab at the
// current size, so arming a watchdog here would only add a second recovery path.
test('a send that the relay refuses arms nothing', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();

  ctx.setRelay(false);
  ctx.setStage(900, 620);
  ctx.pushResize(group, false);
  assert.equal(ctx.sent.length, 0);
  assert.equal(tab.resizeTimer, null);
  assert.equal(ctx.pendingTimers(), 0);
  assert.equal(tab.lastW, 900, 'the size we wanted is still recorded for the next frame check');
  assert.equal(tab.lastH, 620);
});

test('a tab with no page open is never resized', () => {
  const ctx = loadResizeLogic();
  const { group, tab } = makeGroup();
  tab.opened = false;

  ctx.setStage(900, 620);
  ctx.pushResize(group, false);
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.pendingTimers(), 0);
});
