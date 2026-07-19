// Interrupt arbiter (js/interrupt-queue.js) — the shared busy() test, the
// priority-ordered single poller and the cross-channel daily budget that keep
// modals from stacking on top of each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IQ = require('../js/interrupt-queue.js');

// ── Minimal stubs: enough surface for busy(), nothing more ──────────────────
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _map: map,
  };
}

// `classes` = body classList contents, `overlays` = selectors currently present.
function makeDoc(state) {
  const s = state;
  return {
    body: { classList: { contains: (c) => s.classes.includes(c) } },
    querySelector: (sel) => {
      const wanted = sel.split(',').map((x) => x.trim());
      return s.overlays.some((o) => wanted.includes(o)) ? {} : null;
    },
  };
}

function harness(opts) {
  const o = opts || {};
  const state = { classes: o.classes || [], overlays: o.overlays || [] };
  const clock = { t: o.now || 1_000_000 };
  const storage = makeStorage(o.seed);
  const iq = IQ.create({
    doc: makeDoc(state),
    storage,
    now: () => clock.t,
    // Timers are inert: tests drive the poller through _tick() so ordering is
    // deterministic and no test depends on wall-clock time.
    setInterval: () => 1,
    clearInterval: () => {},
  });
  return { iq, state, clock, storage };
}

// ── busy() ─────────────────────────────────────────────────────────────────
test('busy() is false on a clear dashboard and true for any immersive mode', () => {
  const { iq, state } = harness();
  assert.equal(iq.busy(), false);
  for (const cls of ['game-mode', 'lock-screen-active', 'ambient-scene-open', 'ambient-canvas-open', 'ambient-idle']) {
    state.classes = [cls];
    assert.equal(iq.busy(), true, cls + ' must block an interruption');
  }
});

test('busy() covers the SDK security dialogs the old selector list missed', () => {
  const { iq, state } = harness();
  // A promo modal over a grant/clipboard/open-external prompt is the one stacking
  // order that must never happen: the user is being asked to approve something.
  for (const sel of ['.cw-perm-backdrop', '.cw-clip-backdrop', '.cw-ext-backdrop']) {
    state.overlays = [sel];
    assert.equal(iq.busy(), true, sel + ' must block an interruption');
  }
});

test('registerOverlay extends the busy set and ignores junk', () => {
  const { iq, state } = harness();
  state.overlays = ['.my-overlay'];
  assert.equal(iq.busy(), false);
  iq.registerOverlay('.my-overlay');
  assert.equal(iq.busy(), true);
  iq.registerOverlay('');            // no-op, must not widen the selector
  iq.registerOverlay(null);
  assert.equal(iq.busy(), true);
});

// ── whenIdle() ─────────────────────────────────────────────────────────────
test('whenIdle runs immediately when nothing is on screen', () => {
  const { iq } = harness();
  let ran = false;
  iq.whenIdle(() => { ran = true; });
  assert.equal(ran, true);
  assert.equal(iq._waiting(), 0);
});

test('whenIdle waits while busy, then fires on the first idle tick', () => {
  const { iq, state } = harness({ overlays: ['.upd-overlay'] });
  let ran = false;
  iq.whenIdle(() => { ran = true; });
  assert.equal(ran, false);
  iq._tick();
  assert.equal(ran, false, 'still behind What\'s New');
  state.overlays = [];              // update modal dismissed
  iq._tick();
  assert.equal(ran, true);
});

test('the highest priority waiter wins the gap, and only one runs per tick', () => {
  const { iq, state } = harness({ overlays: ['.upd-overlay'] });
  const order = [];
  iq.whenIdle(() => order.push('tip'), { priority: IQ.PRIORITY.tip });
  iq.whenIdle(() => order.push('limited'), { priority: IQ.PRIORITY.limited });
  iq.whenIdle(() => order.push('drop'), { priority: IQ.PRIORITY.drop });

  state.overlays = [];
  iq._tick();
  assert.deepEqual(order, ['limited'], 'scarcity outranks the rest');
  assert.equal(iq._waiting(), 2, 'the others stay queued, they are not dropped');

  // Presenting made the screen busy again; nothing else may slip through.
  state.overlays = ['.xdrop-overlay'];
  iq._tick();
  assert.deepEqual(order, ['limited']);

  state.overlays = [];
  iq._tick(); iq._tick();
  assert.deepEqual(order, ['limited', 'drop', 'tip']);
});

test('equal priorities keep insertion order so nobody is starved', () => {
  const { iq, state } = harness({ overlays: ['.cgal-overlay'] });
  const order = [];
  iq.whenIdle(() => order.push('first'), { priority: IQ.PRIORITY.message });
  iq.whenIdle(() => order.push('second'), { priority: IQ.PRIORITY.message });
  state.overlays = [];
  iq._tick(); iq._tick();
  assert.deepEqual(order, ['first', 'second']);
});

test('a waiter gives up after maxTries instead of polling forever', () => {
  const { iq } = harness({ overlays: ['.upd-overlay'] });
  let ran = false;
  iq.whenIdle(() => { ran = true; }, { maxTries: 3 });
  for (let i = 0; i < 5; i++) iq._tick();
  assert.equal(iq._waiting(), 0);
  assert.equal(ran, false, 'it expired rather than firing late');
});

test('cancel removes a queued waiter', () => {
  const { iq, state } = harness({ overlays: ['.upd-overlay'] });
  let ran = false;
  const cancel = iq.whenIdle(() => { ran = true; });
  cancel();
  state.overlays = [];
  iq._tick();
  assert.equal(ran, false);
  assert.equal(iq._waiting(), 0);
});

test('a throwing channel does not stall the queue', () => {
  const { iq, state } = harness({ overlays: ['.upd-overlay'] });
  const order = [];
  iq.whenIdle(() => { throw new Error('boom'); }, { priority: IQ.PRIORITY.limited });
  iq.whenIdle(() => order.push('survivor'), { priority: IQ.PRIORITY.drop });
  state.overlays = [];
  iq._tick(); iq._tick();
  assert.deepEqual(order, ['survivor']);
});

// ── Daily budget ───────────────────────────────────────────────────────────
test('claimDaily grants one interruption per day across all channels', () => {
  const { iq, clock } = harness();
  assert.equal(iq.budgetSpent(), false);
  assert.equal(iq.claimDaily('hub-messages'), true);
  assert.equal(iq.budgetSpent(), true);
  assert.equal(iq.claimDaily('other-channel'), false, 'the budget is shared, not per channel');

  clock.t += IQ.DAY - 1;
  assert.equal(iq.claimDaily('hub-messages'), false, 'still inside the window');
  clock.t += 2;
  assert.equal(iq.budgetSpent(), false);
  assert.equal(iq.claimDaily('hub-messages'), true);
});

test('a blocked localStorage still allows the interruption', () => {
  // Losing the budget shows one extra modal; refusing shows the user nothing ever.
  const iq = IQ.create({
    doc: makeDoc({ classes: [], overlays: [] }),
    storage: { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  assert.equal(iq.claimDaily('hub-messages'), true);
});

// ── Shared announced-id set ────────────────────────────────────────────────
test('markSeen/hasSeen share one set so a drop is never announced twice', () => {
  const { iq } = harness();
  assert.equal(iq.hasSeen('neon-pack'), false);
  iq.markSeen(['neon-pack']);
  assert.equal(iq.hasSeen('neon-pack'), true);
  iq.markSeen(['neon-pack', 'retro-pack']);
  assert.deepEqual(iq.readSeen(), ['neon-pack', 'retro-pack'], 'no duplicate on re-mark');
});

test('the seen set reads the key catalog-drop.js already wrote, and stays bounded', () => {
  // Existing installs must not lose their history when ownership moved here.
  const { iq } = harness({ seed: { [IQ.K_SEEN]: JSON.stringify(['legacy-entry']) } });
  assert.equal(iq.hasSeen('legacy-entry'), true);

  const many = Array.from({ length: 300 }, (_, i) => 'e' + i);
  iq.markSeen(many);
  const set = iq.readSeen();
  assert.equal(set.length, 250);
  assert.equal(set[set.length - 1], 'e299', 'keeps the most recent');
  assert.equal(iq.hasSeen('legacy-entry'), false, 'oldest fall off the cap');
});

test('corrupt stored state degrades to empty instead of throwing', () => {
  const { iq } = harness({ seed: { [IQ.K_SEEN]: '{not json', [IQ.K_BUDGET]: 'nope' } });
  assert.deepEqual(iq.readSeen(), []);
  assert.equal(iq.budgetSpent(), false);
});
