// The RGB bridge's slow device rescan could wedge the whole server.
//
// boundedReenumerate()'s rescan branch fired enumerate() and stamped only
// lastEnumerate, never lastDeviceScan — that stamp lived exclusively in
// enumerate()'s finally. But enumerate() returned BEFORE its try/finally when an
// enumeration was already in flight (`if (enumerating) return;`), handing the
// caller an instantly-resolved promise. maybeReenumerate() chains apply() onto
// that promise, and apply() calls straight back into boundedReenumerate():
//
//   apply → boundedReenumerate → enumerate (early return, settled promise)
//         → .then(apply) on the microtask queue → apply → ...
//
// Microtasks drain completely before the event loop advances, so that chain never
// yields. The first, real enumeration was awaiting a koffi worker-thread callback
// that only the event loop can deliver, so lastDeviceScan was never stamped and
// the rescan test stayed true forever. The process pegged one core at 100% and
// stopped answering HTTP entirely — no timeout, no crash, no recovery: observed
// live as a dashboard whose media controls simply stopped responding, with every
// request stuck on "provisional headers" while /version timed out from outside
// the browser too.
//
// Both halves are pinned here: enumerate() must hand a concurrent caller the
// in-flight promise, and the rescan branch must stamp its own throttle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(ROOT, 'server', 'lighting.js'), 'utf8');

test('a concurrent enumerate() joins the in-flight promise, never a settled one', () => {
  assert.match(src, /if \(enumerating\) return enumeratePending;/);
  // The bare `return;` is what produced the settled promise.
  assert.doesNotMatch(src, /if \(enumerating\) return;/);
  // The pending promise must be published before it can be joined, and cleared
  // alongside the flag that guards reading it.
  assert.match(src, /enumerating = true;\s*\n\s*enumeratePending = enumerateOnce\(\);/);
  assert.match(src, /enumerating = false;\s*\n\s*enumeratePending = null;/);
});

test('the slow-rescan branch stamps its own throttle', () => {
  // Without lastDeviceScan on this line the branch re-fires on every apply() tick.
  assert.match(src, /if \(now - lastDeviceScan >= DEVICE_RESCAN_MS\) \{[^}]*lastDeviceScan = now;[^}]*return enumerate\(\); \}/);
});

test('enumerate() always returns a thenable, so maybeReenumerate() can chain', () => {
  // maybeReenumerate() does `const p = boundedReenumerate(); if (p) p.then(...)`.
  // The no-SDK path returns early and must still be chainable rather than undefined.
  assert.match(src, /if \(!fns\) \{ devices = \[\]; return Promise\.resolve\(\); \}/);
});

test('chaining onto a settled promise starves the event loop (the mechanism)', async () => {
  // Executable proof of why the early return was fatal, independent of the SDK:
  // a self-rescheduling microtask chain lets no timer or I/O callback run.
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 0);

  let hops = 0;
  await new Promise(done => {
    const settled = Promise.resolve();          // what the early return handed back
    const spin = () => {
      if (++hops >= 500) return done();         // bounded here; unbounded in production
      settled.then(spin);                       // re-arms on the microtask queue
    };
    spin();
  });
  assert.equal(timerRan, false, 'a 0ms timer could not run across 500 microtask hops');

  // Awaiting real work yields to the loop, so the timer finally fires.
  await new Promise(r => setTimeout(r, 0));
  assert.equal(timerRan, true);
});
