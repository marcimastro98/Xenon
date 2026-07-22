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

test('edgeArgs disables extensions by default and loads them when opted in', () => {
  // Default (no ad-blocker): the lean profile keeps --disable-extensions and never
  // loads one.
  const off = eb.edgeArgs('C:/profile');
  assert.ok(off.includes('--disable-extensions'));
  assert.ok(!off.some((a) => a.startsWith('--load-extension')));

  // Empty array is treated the same as "off".
  assert.ok(eb.edgeArgs('C:/profile', []).includes('--disable-extensions'));

  // Opt-in: --disable-extensions is dropped and the chosen dirs are loaded.
  const on = eb.edgeArgs('C:/profile', ['C:/ext/ubol']);
  assert.ok(!on.includes('--disable-extensions'));
  assert.ok(on.includes('--load-extension=C:/ext/ubol'));

  // Multiple extensions join with a comma; falsy entries are ignored.
  const multi = eb.edgeArgs('C:/profile', ['C:/a', null, 'C:/b']);
  assert.ok(multi.includes('--load-extension=C:/a,C:/b'));
});

test('edgeArgs keeps off-screen tiles from being throttled (live streams stay alive, #116)', () => {
  // Every headless window is parked off-screen, so without these Chromium
  // backgrounds the renderer and throttles timers on EVERY tile — an HLS stream
  // then dies ~5 min in with hls.networkError.levelLoadTimeOut. These four flags
  // (the last carried in --disable-features) keep the page running at full speed.
  const args = eb.edgeArgs('C:/profile');
  assert.ok(args.includes('--disable-background-timer-throttling'));
  assert.ok(args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(args.includes('--disable-renderer-backgrounding'));
  const feats = args.find((a) => a.startsWith('--disable-features='));
  assert.ok(feats && feats.split('=')[1].split(',').includes('CalculateNativeWinOcclusion'));
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

test('inputToCdp maps touch events; end/cancel send empty touchPoints', () => {
  const start = eb.inputToCdp({ kind: 'touch', subtype: 'start', x: 10, y: 20 });
  assert.equal(start.method, 'Input.dispatchTouchEvent');
  assert.equal(start.params.type, 'touchStart');
  assert.deepEqual(start.params.touchPoints, [{ x: 10, y: 20 }]);
  assert.deepEqual(eb.inputToCdp({ kind: 'touch', subtype: 'move', x: 1, y: 2 }).params.touchPoints, [{ x: 1, y: 2 }]);
  assert.deepEqual(eb.inputToCdp({ kind: 'touch', subtype: 'end', x: 1, y: 2 }).params.touchPoints, []);
  assert.deepEqual(eb.inputToCdp({ kind: 'touch', subtype: 'cancel' }).params.touchPoints, []);
  assert.equal(eb.inputToCdp({ kind: 'touch', subtype: 'bogus' }), null);
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

test('a popup auto-attaches as a stacked page and detaches back to the opener', async () => {
  let wsInstance = null;
  class DriveWS extends makeFakeWS(true) {
    constructor(...a) { super(...a); wsInstance = this; }
  }
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: DriveWS, launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await host.open('browser', 'twitch.tv', 400, 300, 1, () => {});
  await host.startScreencast('browser');
  await delay(20);
  const tile = host._tiles.get('browser');
  assert.equal(tile.pages.length, 1, 'the tile starts with just its base page');
  const baseSession = tile.pages[0].sessionId;
  const baseTarget = tile.pages[0].targetId;

  // The page opens an OAuth "Continue with…" popup → discovered as a new page target
  // whose opener is our base page. We attach + stack it as the active page.
  wsInstance._emit('message', { data: JSON.stringify({
    method: 'Target.targetCreated',
    params: { targetInfo: { targetId: 'PT1', type: 'page', openerId: baseTarget } },
  }) });
  await delay(30);
  assert.equal(tile.pages.length, 2, 'the popup is stacked as a new page');
  assert.equal(tile.pages[1].targetId, 'PT1', 'the popup is now the active page');

  // A discovered target we DIDN'T open (no opener) must be ignored, not stacked.
  wsInstance._emit('message', { data: JSON.stringify({
    method: 'Target.targetCreated',
    params: { targetInfo: { targetId: 'PT-orphan', type: 'page', openerId: '' } },
  }) });
  await delay(10);
  assert.equal(tile.pages.length, 2, 'an unrelated target is not stacked');

  // The popup self-closes (window.close() / the OAuth callback) → targetDestroyed.
  wsInstance._emit('message', { data: JSON.stringify({
    method: 'Target.targetDestroyed', params: { targetId: 'PT1' } }) });
  await delay(20);
  assert.equal(tile.pages.length, 1, 'the tile hands back to the opener');
  assert.equal(tile.pages[0].sessionId, baseSession, 'the opener is active again');
  host.shutdown();
});

test('a popup whose attach fails is closed, never leaked as a live Edge tab', async () => {
  let wsInstance = null;
  const closed = [];
  class FailAttachWS extends makeFakeWS(false) {
    constructor(...a) { super(...a); wsInstance = this; }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.method === 'Target.closeTarget') closed.push(m.params.targetId);
      // Reject the popup's attach specifically — the base page attaches fine.
      if (m.method === 'Target.attachToTarget' && m.params.targetId === 'PT-fail') {
        setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, error: { message: 'No target with given id' } }) }), 0);
        return;
      }
      return super.send(raw);
    }
  }
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: FailAttachWS, launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await host.open('browser', 'example.com', 400, 300, 1, () => {});
  const baseTarget = host._tiles.get('browser').pages[0].targetId;

  wsInstance._emit('message', { data: JSON.stringify({
    method: 'Target.targetCreated',
    params: { targetInfo: { targetId: 'PT-fail', type: 'page', openerId: baseTarget } },
  }) });
  await delay(30);
  assert.equal(host._tiles.get('browser').pages.length, 1, 'the failed popup is not stacked');
  assert.ok(closed.includes('PT-fail'), 'the unattachable popup target is closed');
  host.shutdown();
});

test('the orphan sweep closes page targets owned by no tile and spares owned ones', async () => {
  let wsInstance = null;
  const closed = [];
  class SweepWS extends makeFakeWS(false) {
    constructor(...a) { super(...a); wsInstance = this; }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.method === 'Target.closeTarget') closed.push(m.params.targetId);
      if (m.method === 'Target.getTargets') {
        const owned = wsInstance._ownedTarget;
        setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, result: { targetInfos: [
          { targetId: owned, type: 'page' },            // the tile's own page — spared
          { targetId: 'GHOST-1', type: 'page' },        // leaked popup — reclaimed
          { targetId: 'SW-1', type: 'service_worker' }, // non-page — ignored
        ] } }) }), 0);
        return;
      }
      return super.send(raw);
    }
  }
  const proc = { on() {}, kill() {}, unref() {} };
  const host = eb.createEmbeddedBrowser({ WebSocketImpl: SweepWS, launch: async () => ({ proc, wsUrl: 'ws://x' }), idleMs: 10000 });
  await host.open('browser', 'example.com', 400, 300, 1, () => {});
  wsInstance._ownedTarget = host._tiles.get('browser').pages[0].targetId;

  await host._sweepOrphanTargets();
  await delay(20);
  assert.ok(closed.includes('GHOST-1'), 'the unowned page target is closed');
  assert.ok(!closed.includes(wsInstance._ownedTarget), 'the owned page target is spared');
  assert.ok(!closed.includes('SW-1'), 'non-page targets are ignored');
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
      // Answer ONLY the in-page storage wipe (it resolves to the page origin).
      // open() also fires a Widevine warm-up Runtime.evaluate; that one must fall
      // through to the default `{}` reply so the CDM warm-up bails immediately —
      // intercepting it made the probe read a non-'ok' value and spin its capped
      // (unref'd) retry loop, so open() never settled and the test hung.
      if (m.method === 'Runtime.evaluate' && /localStorage/.test((m.params && m.params.expression) || '')) {
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
  // The retry backoff between launch attempts is a deliberately unref'd timer (so
  // it never blocks a real shutdown). A live Edge keeps the process alive via its
  // ws socket; the fake ws is not a libuv handle, so hold the loop open across the
  // backoff ourselves — otherwise it drains and open() never settles.
  const keepAlive = setInterval(() => {}, 50);
  try {
    await host.open('browser', 'example.com', 400, 300, 1, () => {});
    assert.equal(launches, 2, 'the launch was retried after the first failure');
    assert.equal(host._tiles.has('browser'), true);
  } finally {
    clearInterval(keepAlive);
    host.shutdown();
  }
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
