// The search shortcut opens one window: the native one when the app claims it,
// the Edge popup only when nothing native answers in time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createSpotlightClaim, CLAIM_MS, NATIVE_CLAIM_MS } = require('../spotlight-hotkey/claim.js');

function rig() {
  const timers = [];
  const calls = { broadcast: 0, fallback: 0 };
  const c = createSpotlightClaim({
    broadcast: () => calls.broadcast++,
    openFallback: () => calls.fallback++,
    timers: { set: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clear: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); } },
  });
  const fire = () => { const h = timers.shift(); h.fn(); };
  return { c, calls, timers, fire };
}

test('with no native app the Edge popup opens after the short wait', () => {
  const r = rig();
  r.c.route();
  assert.equal(r.calls.broadcast, 1);
  assert.equal(r.timers[0].ms, CLAIM_MS);
  r.fire();
  assert.equal(r.calls.fallback, 1);
});

test('a claim in time means no popup', () => {
  const r = rig();
  r.c.route();
  r.c.claim();
  assert.equal(r.timers.length, 0);
  assert.equal(r.calls.fallback, 0);
});

test('once the native app has claimed, a slow claim no longer opens Edge over its window', () => {
  const r = rig();
  r.c.route();
  r.c.claim();
  r.c.route();
  assert.equal(r.timers[0].ms, NATIVE_CLAIM_MS);
  assert.ok(NATIVE_CLAIM_MS >= 2000 && NATIVE_CLAIM_MS <= 5000);
  r.c.claim();
  assert.equal(r.calls.fallback, 0);
  r.c.route();
  r.fire();
  assert.equal(r.calls.fallback, 1, 'the native app gone: the popup still comes');
});

test('a new press starts the wait again', () => {
  const r = rig();
  r.c.route();
  r.c.route();
  assert.equal(r.timers.length, 1);
});

test('the search page claims on every show, besides the kiosk', () => {
  const page = readFileSync(new URL('../js/spotlight-page.js', import.meta.url), 'utf8');
  assert.match(page, /window\.__spotlightShown = function \(\) \{[\s\S]{0,400}if \(FRAMELESS\) fetch\('\/spotlight\/claimed', \{ method: 'POST' \}\)\.catch\(\(\) => \{\}\);/);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /reqPath === '\/spotlight\/claimed' && req\.method === 'POST'[\s\S]{0,200}spotlightClaim\.claim\(\);/);
});

test('the native app says it is here on every stream open, so even the first press after a restart waits for it', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /es\.onopen = \(\) => \{[\s\S]{0,1600}if \(\(window\.__XENON_NATIVE__ === true \|\| window\.isTauri === true\) && !isLayerPage\(\)\) \{\n\s+fetch\('\/spotlight\/claimed', \{ method: 'POST' \}\)/);
  const driver = readFileSync(new URL('../js/shell-driver.js', import.meta.url), 'utf8');
  assert.match(driver, /function onStreamOpen\(\) \{[\s\S]{0,300}fetch\(SERVER \+ '\/spotlight\/claimed', \{ method: 'POST' \}\)/);
  const r = rig();
  r.c.claim();
  r.c.route();
  assert.equal(r.timers[0].ms, NATIVE_CLAIM_MS);
});

test('a list drawn under a resting pointer never picks the row it lands on', () => {
  const src = readFileSync(new URL('../js/spotlight.js', import.meta.url), 'utf8');
  assert.equal(src.split("row.addEventListener('mouseenter', () => { if (hoverArmed && selIndex !== index) setSelected(index); });").length - 1, 2);
  assert.doesNotMatch(src, /mouseenter', \(\) => \{ if \(selIndex !== index\)/);
  assert.match(src, /listEl\.addEventListener\('pointermove', \(e\) => \{\n\s+if \(hoverArmed \|\| !\(e\.movementX \|\| e\.movementY\)\) return;/, 'a synthetic move (content under the pointer) has no movement');
  assert.match(src, /function renderIdle\(\) \{\n\s+hoverArmed = false;/, 'every open starts unarmed');
});
