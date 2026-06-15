import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const eb = require('../embedded-browser.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Pure helpers ──────────────────────────────────────────────────────────────

test('normalizeUrl accepts http/https and prepends https to a bare host', () => {
  assert.deepEqual(eb.normalizeUrl('https://example.com/x'), { ok: true, url: 'https://example.com/x' });
  assert.equal(eb.normalizeUrl('http://a.b/').url, 'http://a.b/');
  assert.equal(eb.normalizeUrl('example.com').url, 'https://example.com/');
});

test('normalizeUrl rejects non-http(s) schemes and empty input', () => {
  assert.equal(eb.normalizeUrl('').ok, false);
  assert.equal(eb.normalizeUrl('   ').error, 'empty_url');
  assert.equal(eb.normalizeUrl('file:///c:/secret.txt').error, 'blocked_scheme');
  assert.equal(eb.normalizeUrl('javascript:alert(1)').error, 'blocked_scheme');
  assert.equal(eb.normalizeUrl('chrome://settings').error, 'blocked_scheme');
});

test('inputToCdp maps mouse, wheel and key events; rejects unknown', () => {
  assert.deepEqual(eb.inputToCdp({ kind: 'mouse', subtype: 'pressed', x: 10, y: 20, button: 'left', clickCount: 1 }), {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
  });
  assert.equal(eb.inputToCdp({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: -120 }).params.type, 'mouseWheel');
  const key = eb.inputToCdp({ kind: 'key', subtype: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 8 });
  assert.equal(key.method, 'Input.dispatchKeyEvent');
  assert.equal(key.params.type, 'keyDown');
  assert.equal(key.params.windowsVirtualKeyCode, 65);
  assert.equal(key.params.modifiers, 8);
  assert.equal(eb.inputToCdp({ kind: 'nope' }), null);
  assert.equal(eb.inputToCdp(null), null);
});

test('available() returns a boolean', () => {
  const host = eb.createEmbeddedBrowser({ launch: async () => ({}), WebSocketImpl: function () {} });
  assert.equal(typeof host.available(), 'boolean');
});

// ── CDP lifecycle, driven by a fake launcher + fake WebSocket (no real Edge) ──

let seq = 0;
function makeFakeWS(onFrameSessions) {
  return class FakeCdpWS {
    constructor() { this.l = {}; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(type, cb) { this.l[type] = cb; }
    _emit(type, ev) { if (this.l[type]) this.l[type](ev); }
    send(raw) {
      const m = JSON.parse(raw);
      let result = {};
      if (m.method === 'Target.createTarget') result = { targetId: 'T' + (++seq) };
      else if (m.method === 'Target.attachToTarget') result = { sessionId: 'S' + (++seq) };
      else if (m.method === 'Page.getNavigationHistory') result = { currentIndex: 0, entries: [{ id: 1 }] };
      setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      // When a screencast starts, push one frame so we can assert delivery + ack.
      if (m.method === 'Page.startScreencast' && onFrameSessions) {
        setTimeout(() => this._emit('message', { data: JSON.stringify({
          method: 'Page.screencastFrame', sessionId: m.sessionId,
          params: { data: 'AAAA', metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 1 },
        }) }), 0);
      }
    }
    close() { setTimeout(() => this._emit('close', {}), 0); }
  };
}

test('open() creates a target, attaches a session and navigates; startScreencast delivers a frame and acks it', async () => {
  const acks = [];
  class TrackingWS extends makeFakeWS(true) {
    send(raw) { const m = JSON.parse(raw); if (m.method === 'Page.screencastFrameAck') acks.push(m.params.sessionId); return super.send(raw); }
  }
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: TrackingWS, launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });

  let frame = null;
  await host.open('browser', 'example.com', 400, 300, 1, (data, meta) => { frame = { data, meta }; });
  await host.startScreencast('browser');
  await delay(30);

  assert.equal(host._tiles.has('browser'), true);
  assert.ok(frame, 'a screencast frame was delivered');
  assert.equal(frame.data, 'AAAA');
  assert.equal(frame.meta.deviceWidth, 800);
  assert.deepEqual(acks, [1], 'the frame was acknowledged');
  host.shutdown();
});

test('navigate rejects a blocked scheme', async () => {
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: makeFakeWS(false), launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await host.open('browser', 'example.com', 400, 300, 1, () => {});
  await assert.rejects(host.navigate('browser', 'file:///etc/passwd'), /blocked_scheme/);
  host.shutdown();
});

test('the headless browser is killed after the last tile closes (idle)', async () => {
  let killed = false;
  const proc = { on() {}, kill() { killed = true; }, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: makeFakeWS(false), launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 20 });
  await host.open('browser', 'example.com', 400, 300, 1, () => {});
  await host.closeTile('browser');
  await delay(80);
  assert.equal(killed, true, 'Edge process killed once no tiles remain');
  assert.equal(host._tiles.size, 0);
});
