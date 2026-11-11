// A background widget frame that never says hello is mounted again
// (js/custom-widget.js, watchServiceHello / onStreamBack). A frame mounted while
// the engine was restarting held the browser's error page for good, so its bar
// chip (Twin Charge's battery) kept an old number or vanished until a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('  const SERVICE_HELLO_WAITS_MS');
const end = src.indexOf('  function serviceHost() {', start);
const body = src.slice(start, end);

function rig() {
  const timers = [];
  const ctx = {
    frames: new Map(),
    synced: 0,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  ctx.syncServiceFrames = () => {
    ctx.synced++;
    // What the real sync does for a missing wanted frame: mount a new one and watch it.
    for (const id of ['svc:twin-charge']) {
      if (ctx.frames.has(id)) continue;
      const entry = { frame: { remove() {} }, ready: false, service: true };
      ctx.frames.set(id, entry);
      ctx.watchServiceHello(id, entry);
    }
  };
  vm.runInNewContext(body + '\nthis.watchServiceHello = watchServiceHello; this.onStreamBack = onStreamBack;'
    + ' this.serviceRetries = serviceRetries;', ctx);
  const fire = () => { const t = timers.filter((x) => x.live).pop(); t.live = false; t.fn(); return t.ms; };
  return { ctx, timers, fire };
}

test('a frame that never says hello is mounted again, waiting longer each time', () => {
  const { ctx, fire } = rig();
  ctx.syncServiceFrames();
  const first = ctx.frames.get('svc:twin-charge');
  assert.equal(fire(), 15000);
  assert.notEqual(ctx.frames.get('svc:twin-charge'), first, 'a new frame replaced the dead one');
  assert.equal(fire(), 30000);
  assert.equal(fire(), 60000);
  assert.equal(fire(), 120000);
  assert.equal(fire(), 300000);
  assert.equal(fire(), 300000, 'the wait stops growing at five minutes');
});

test('a frame that said hello is left alone', () => {
  const { ctx, timers } = rig();
  ctx.syncServiceFrames();
  const entry = ctx.frames.get('svc:twin-charge');
  entry.ready = true;
  const before = ctx.synced;
  timers.filter((x) => x.live).pop().fn();
  assert.equal(ctx.frames.get('svc:twin-charge'), entry);
  assert.equal(ctx.synced, before);
});

test('the stream coming back remounts a waiting frame at once and resets the wait', () => {
  const { ctx, fire } = rig();
  ctx.syncServiceFrames();
  fire(); fire();   // two failed tries: the next wait would be 60 s
  const waiting = ctx.frames.get('svc:twin-charge');
  ctx.onStreamBack();
  assert.notEqual(ctx.frames.get('svc:twin-charge'), waiting);
  assert.equal(fire(), 15000);
});

test('the stream coming back leaves ready frames and tile frames alone', () => {
  const { ctx } = rig();
  const ready = { frame: { remove() { throw new Error('removed'); } }, ready: true, service: true };
  const tile = { frame: { remove() { throw new Error('removed'); } }, ready: false };
  ctx.frames.set('svc:github-stars', ready);
  ctx.frames.set('tile-1', tile);
  ctx.frames.set('svc:twin-charge', { frame: { remove() {} }, ready: true, service: true });
  ctx.onStreamBack();
  assert.equal(ctx.frames.get('svc:github-stars'), ready);
  assert.equal(ctx.frames.get('tile-1'), tile);
  assert.equal(ctx.synced, 0);
});

test('the dashboard tells the widgets when the stream is back after a drop', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /streamDropped = true;/);
  assert.match(main, /if \(streamDropped && window\.CustomWidget[^\n]*onStreamBack\(\)/);
});
