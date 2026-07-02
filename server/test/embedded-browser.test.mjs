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

test('normalizeUrl searches free text instead of navigating to a dead host', () => {
  // A bare word or a phrase is a search, like a browser omnibox — not https://google.
  assert.equal(eb.normalizeUrl('google').url, 'https://www.google.com/search?q=google');
  assert.equal(eb.normalizeUrl('best pizza milano').url, 'https://www.google.com/search?q=best%20pizza%20milano');
  // Real hostnames, IPs, ports and localhost still navigate directly.
  assert.equal(eb.normalizeUrl('example.com').url, 'https://example.com/');
  assert.equal(eb.normalizeUrl('sub.example.co.uk/path').url, 'https://sub.example.co.uk/path');
  assert.equal(eb.normalizeUrl('localhost:3030').url, 'https://localhost:3030/');
  assert.equal(eb.normalizeUrl('192.168.1.10').url, 'https://192.168.1.10/');
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

test('open() strips "Headless" from the UA and injects the same-tab shim', async () => {
  const sent = [];
  class CaptureWS extends makeFakeWS(false) {
    send(raw) {
      const m = JSON.parse(raw);
      sent.push(m);
      if (m.method === 'Browser.getVersion') {
        setTimeout(() => this._emit('message', { data: JSON.stringify({
          id: m.id, result: { userAgent: 'Mozilla/5.0 HeadlessChrome/120 Edg/120' },
        }) }), 0);
        return;
      }
      return super.send(raw);
    }
  }
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: CaptureWS, launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await host.open('browser', 'twitch.tv', 400, 300, 1, () => {});

  const ua = sent.find((m) => m.method === 'Emulation.setUserAgentOverride');
  assert.ok(ua, 'a UA override was set');
  assert.equal(/Headless/i.test(ua.params.userAgent), false, 'the Headless token is stripped');
  // Brands must be supplied too, or navigator.userAgentData.brands is wiped to []
  // (itself a bot tell) — and they must not carry the Headless marker.
  const md = ua.params.userAgentMetadata;
  assert.ok(md && Array.isArray(md.brands) && md.brands.length > 0, 'UA-CH brands are provided');
  assert.equal(/Headless/i.test(JSON.stringify(md.brands)), false, 'brands carry no Headless marker');
  const shim = sent.find((m) => m.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(shim, 'the same-tab shim is injected');
  assert.ok(/navigator\).{0,20}webdriver|webdriver/.test(shim.params.source), 'the shim spoofs navigator.webdriver');
  // The shim must be set before navigation so it applies to the loaded page.
  const shimIdx = sent.findIndex((m) => m.method === 'Page.addScriptToEvaluateOnNewDocument');
  const navIdx = sent.findIndex((m) => m.method === 'Page.navigate');
  assert.ok(shimIdx >= 0 && navIdx >= 0 && shimIdx < navIdx, 'shim is injected before navigate');
  host.shutdown();
});

test('clearData wipes the tile page storage and hard-reloads', async () => {
  const sent = [];
  class CaptureWS extends makeFakeWS(false) {
    send(raw) {
      const m = JSON.parse(raw);
      sent.push(m);
      if (m.method === 'Runtime.evaluate') {
        // Simulate the in-page wipe returning the page origin.
        setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, result: { result: { value: 'https://twitch.tv' } } }) }), 0);
        return;
      }
      return super.send(raw);
    }
  }
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: CaptureWS, launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await host.open('browser', 'twitch.tv', 400, 300, 1, () => {});
  sent.length = 0;
  await host.clearData('browser');

  assert.ok(sent.find((m) => m.method === 'Runtime.evaluate'), 'the in-page storage wipe runs');
  const clear = sent.find((m) => m.method === 'Storage.clearDataForOrigin');
  assert.ok(clear, 'CDP storage clear runs for the reported origin');
  assert.equal(clear.params.origin, 'https://twitch.tv');
  assert.ok(/cookies/.test(clear.params.storageTypes) && /local_storage/.test(clear.params.storageTypes), 'cookies + local storage are cleared');
  const reload = sent.find((m) => m.method === 'Page.reload');
  assert.ok(reload && reload.params.ignoreCache === true, 'the page hard-reloads');
  host.shutdown();
});

test('clearData throws for an unknown tile', async () => {
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: makeFakeWS(false), launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await assert.rejects(host.clearData('nope'), /no_tile/);
  host.shutdown();
});

test('navigate rejects a blocked scheme', async () => {
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: makeFakeWS(false), launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await host.open('browser', 'example.com', 400, 300, 1, () => {});
  await assert.rejects(host.navigate('browser', 'file:///etc/passwd'), /blocked_scheme/);
  host.shutdown();
});

test('open() self-heals: a failed first launch is retried and then succeeds', async () => {
  let launches = 0;
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({
    WebSocketImpl: makeFakeWS(true), idleMs: 10000,
    launch: async () => {
      launches += 1;
      if (launches === 1) throw new Error('devtools_port_timeout');   // first attempt fails
      return { proc, wsUrl: 'ws://x' };
    },
  });
  await host.open('browser', 'example.com', 400, 300, 1, () => {});
  assert.equal(launches, 2, 'the launch was retried after the first failure');
  assert.equal(host._tiles.has('browser'), true);
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

// ── One-time reset of a pre-fingerprint-fix ("poisoned") profile ─────────────

test('resetPoisonedProfile wipes an unmarked existing profile once, spares fresh and current ones', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-gen-'));
  const profile = path.join(base, 'embedded-browser-profile');
  const marker = path.join(profile, 'fingerprint-generation');
  const cookieFile = path.join(profile, 'Default', 'Network', 'Cookies');

  // 1. Existing profile from before the fix (Default/ present, no marker) → wiped + marked.
  fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
  fs.writeFileSync(cookieFile, 'poisoned');
  eb.resetPoisonedProfile(profile);
  assert.equal(fs.existsSync(cookieFile), false, 'old site data wiped');
  assert.ok(parseInt(fs.readFileSync(marker, 'utf8'), 10) >= 2, 'generation marker written');

  // 2. Current-generation profile → untouched.
  fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
  fs.writeFileSync(cookieFile, 'fresh-login');
  eb.resetPoisonedProfile(profile);
  assert.equal(fs.readFileSync(cookieFile, 'utf8'), 'fresh-login', 'marked profile is never wiped again');

  // 3. Brand-new profile dir (no Default/) → nothing to wipe, marker written.
  const fresh = path.join(base, 'fresh-profile');
  fs.mkdirSync(fresh, { recursive: true });
  eb.resetPoisonedProfile(fresh);
  assert.ok(fs.existsSync(path.join(fresh, 'fingerprint-generation')), 'fresh profile is just marked');

  fs.rmSync(base, { recursive: true, force: true });
});
