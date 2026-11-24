// The hidden browser that films a pump's face (pump-screen/direct-browser.js): it opens the face
// page at the panel's size, asks DevTools for JPEG frames and passes each on, asks for the next
// one only after the fps gap, and a command left unanswered, a dropped connection or a browser
// that exits end it once, with the browser killed. Fake browser and DevTools only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDirectBrowser, CMD_MS } = require('../pump-screen/direct-browser.js');

// A DevTools socket that answers every command unless told to stay silent on one.
function fakeSocket(r) {
  return class {
    constructor(url) {
      this.url = url;
      this.ears = {};
      r.socket = this;
      queueMicrotask(() => this.emit('open'));
    }
    addEventListener(name, fn) { (this.ears[name] ||= []).push(fn); }
    emit(name, ev = {}) { for (const fn of this.ears[name] || []) fn(ev); }
    send(text) {
      const msg = JSON.parse(text);
      r.sent.push(msg);
      if (msg.method === r.silentOn) return;
      const result = msg.method === 'Target.createTarget' ? { targetId: 't1' } : msg.method === 'Target.attachToTarget' ? { sessionId: 's1' }
        : msg.method === 'Target.getTargets' ? { targetInfos: r.targets } : {};
      const answer = msg.method === r.refuseOn ? { id: msg.id, error: { message: 'refused' } } : { id: msg.id, result };
      queueMicrotask(() => this.emit('message', { data: JSON.stringify(answer) }));
      if (msg.method === 'Page.navigate' && !msg.error && !r.neverLoads) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', sessionId: 's1', params: {} }) }));
    }
    close() { r.closed += 1; }
  };
}

// The browser's first empty tab, the face page's own window and a worker that is not a page.
const TARGETS = [{ targetId: 'blank', type: 'page' }, { targetId: 't1', type: 'page' }, { targetId: 'w', type: 'service_worker' }];

function rig({ silentOn = null, refuseOn = null, targets = TARGETS } = {}) {
  /** @type {any} */
  const r = { sent: [], frames: [], errors: [], killed: 0, closed: 0, silentOn, refuseOn, timers: [], targets };
  r.proc = new EventEmitter();
  r.browser = createDirectBrowser({
    launch: async () => ({ proc: r.proc, wsUrl: 'ws://127.0.0.1:9/devtools/browser/x' }),
    WebSocketImpl: fakeSocket(r),
    kill: (p) => { assert.equal(p, r.proc); r.killed += 1; },
    url: 'http://127.0.0.1:3030/pump-face?via=direct', width: 480, height: 480, fps: 20, quality: 80,
    onFrame: (jpeg) => r.frames.push(jpeg),
    onError: (reason) => r.errors.push(reason),
    later: (fn, ms) => { const t = { fn, ms, live: true }; r.timers.push(t); return t; },
    cancel: (t) => { if (t) t.live = false; },
    every: (fn, ms) => ({ fn, ms }),
    stopEvery: () => {},
  });
  r.frame = (data, sessionId = 's1') => r.socket.emit('message', { data: JSON.stringify({ method: 'Page.screencastFrame', sessionId, params: { data, sessionId: 7 } }) });
  return r;
}

test('a list of tabs refused or a tab that will not close: the face page still films', async () => {
  for (const r of [rig({ refuseOn: 'Target.getTargets' }), rig({ refuseOn: 'Target.closeTarget' }), rig({ targets: 'nonsense' })]) {
    await r.browser.start();
    assert.equal(r.sent.at(-1).method, 'Page.startScreencast');
    assert.deepEqual(r.errors, []);
    r.browser.stop();
  }
});

test('it opens the face page at the panel size and films it as JPEG', async () => {
  const r = rig();
  await r.browser.start();
  assert.deepEqual(r.sent.map((m) => m.method), [
    'Target.createTarget', 'Target.attachToTarget', 'Target.getTargets', 'Target.closeTarget',
    'Emulation.setDeviceMetricsOverride', 'Page.enable', 'Page.navigate', 'Page.startScreencast',
  ]);
  assert.deepEqual(r.sent[0].params, { url: 'about:blank', newWindow: true, width: 480, height: 480 }, 'a background tab is never drawn');
  assert.deepEqual(r.sent[3].params, { targetId: 'blank' }, 'the empty first tab closed, the face page and a worker kept');
  assert.deepEqual(r.sent[4].params, { width: 480, height: 480, deviceScaleFactor: 1, mobile: false });
  assert.equal(r.sent[6].params.url, 'http://127.0.0.1:3030/pump-face?via=direct');
  assert.equal(r.sent[6].sessionId, 's1', 'page commands go to the page, not the browser');
  assert.deepEqual(r.sent[7].params, { format: 'jpeg', quality: 80, maxWidth: 480, maxHeight: 480, everyNthFrame: 1 });
  r.browser.stop();
});

test('each frame is passed on, and the next is asked for only after the fps gap', async () => {
  const r = rig();
  await r.browser.start();
  r.frame(Buffer.from('jpeg-1').toString('base64'));
  assert.deepEqual(r.frames.map(String), ['jpeg-1']);
  assert.ok(!r.sent.some((m) => m.method === 'Page.screencastFrameAck'), 'not asked for yet');
  const ack = r.timers.find((t) => t.live && t.ms <= 50);
  assert.ok(ack, 'the ack waits at most one gap (50 ms at 20 fps)');
  ack.fn();
  const sent = r.sent.find((m) => m.method === 'Page.screencastFrameAck');
  assert.deepEqual(sent.params, { sessionId: 7 });
  r.frame(Buffer.from('other').toString('base64'), 'someone-else');
  assert.equal(r.frames.length, 1, 'a frame of another page is not ours');
  r.browser.stop();
});

test('a command left unanswered makes start fail with the browser killed, and says nothing more', async () => {
  const r = rig({ silentOn: 'Page.navigate' });
  const started = r.browser.start();
  await new Promise((done) => setImmediate(done));
  const hang = r.timers.find((t) => t.live && t.ms === CMD_MS && r.sent.at(-1).method === 'Page.navigate');
  assert.ok(hang);
  hang.fn();
  await assert.rejects(started, /cdp_timeout|closed/);
  assert.equal(r.killed, 1);
  assert.deepEqual(r.errors, [], 'start says it itself');
});

test('the page is filmed only once it has loaded, and one that never loads fails start', async () => {
  const r = rig();
  r.neverLoads = true;
  const started = r.browser.start();
  await new Promise((done) => setImmediate(done));
  assert.equal(r.sent.at(-1).method, 'Page.navigate', 'no screencast before the load');
  r.timers.find((t) => t.live && t.ms === 10000).fn();
  await assert.rejects(started, /page_load_timeout/);
  assert.equal(r.killed, 1);
});

test('a command the browser refuses fails start with the browser killed too', async () => {
  const r = rig({ refuseOn: 'Page.startScreencast' });
  await assert.rejects(r.browser.start(), /refused/);
  assert.equal(r.killed, 1);
  assert.equal(r.closed, 1);
  assert.deepEqual(r.errors, []);
});

test('once running, a dropped connection or a browser that exits ends it once', async () => {
  const r = rig();
  await r.browser.start();
  r.socket.emit('close');
  r.proc.emit('exit');
  assert.deepEqual(r.errors, ['closed']);
  assert.equal(r.killed, 1);

  const e = rig();
  await e.browser.start();
  e.proc.emit('exit');
  assert.deepEqual(e.errors, ['exited']);
});

test('stop kills the browser and is quiet', async () => {
  const r = rig();
  await r.browser.start();
  r.browser.stop();
  r.browser.stop();
  assert.equal(r.killed, 1);
  assert.equal(r.closed, 1);
  assert.deepEqual(r.errors, []);
});
