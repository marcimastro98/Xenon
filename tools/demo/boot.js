'use strict';
// The static browser demo's engine. Loaded FIRST — before shared/src/constants.js
// and therefore before every one of the dashboard's ~115 scripts — because
// settings.js reads localStorage synchronously at script-evaluation time and
// several modules probe location.hash on their way up.
//
// Why four global shims instead of patching call sites: server/index.html carries
// ~200 inline onclick= handlers that resolve against global scope and 22 modules
// capture `const api = apiJson` at evaluation time, so neither can be gated
// individually. But apiJson IS fetch, so shimming fetch covers apiJson, all its
// aliases and every raw fetch() in one move. EventSource, WebSocket and
// sendBeacon are the three paths that bypass fetch entirely.
//
// The ONLY source file the build patches is server/js/state.js (its `SERVER`
// const is not reachable from script scope). Everything else here is an override.
(function () {
  const D = window.__XD__;
  const BUILD = '__BUILD__';
  const VERSION = '__V__';

  // ── 1. Park the fragment ──────────────────────────────────────────────────
  // Read it, remember it, and REMOVE it before anything else looks. Two things
  // depend on that: edge-preview.js tests `hash.indexOf('edge') >= 0`, so a
  // preset code containing "edge" anywhere would silently boot the demo into the
  // 2560x720 letterbox; and preset-share.js's own checkHash() would race us for
  // a #preset= code.
  try {
    const m = /[#&?](try|preset)=([A-Za-z0-9_\-]+)/.exec(location.hash || '');
    if (m) {
      window.__XENON_DEMO_PRESET__ = { mode: m[1], value: m[2] };
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch { /* fragment stays; worst case is a cosmetic letterbox */ }

  // ── 2. Seed the settings mirror ───────────────────────────────────────────
  const SETTINGS_KEY = 'xeneonedge.settings.v1';
  const SEED_KEY = 'xenon.demo.seed';
  let settings = null;
  try {
    if (localStorage.getItem(SEED_KEY) !== BUILD) {
      const seed = Object.assign({}, D.settings);
      // Follow the site's language so a visitor arriving from a Japanese catalog
      // page gets a Japanese dashboard. i18n.js reads its own `uiLang` key, so
      // both have to be written or the two disagree on the first paint; with
      // neither set the app auto-detects from the browser, which is the right
      // default for a demo whose whole point is global reach.
      const siteLang = localStorage.getItem('xenon.site.lang');
      if (siteLang) { seed.language = siteLang; localStorage.setItem('uiLang', siteLang); }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(seed));
      localStorage.setItem(SEED_KEY, BUILD);
    }
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch { settings = Object.assign({}, D.settings); }
  let settingsRev = 1;

  // ── 3. The simulator ──────────────────────────────────────────────────────
  // Deterministic, never Math.random() per tick: raw noise reads as broken
  // hardware. Layered sinusoids over elapsed time, plus a seeded spike envelope,
  // plus first-order lag on the temperatures so they look thermal instead of
  // twitchy. That lag is the detail that sells it.
  const T0 = Date.now();
  const el = () => Date.now() - T0;
  const wob = (t, base, amp, period, phase) => base + amp * Math.sin(2 * Math.PI * (t / period) + phase);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function seeded(n) {           // mulberry32, one draw per integer
    let s = (n * 0x6D2B79F5) | 0;
    s = (s + 0x6D2B79F5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }
  // A ~6 s burst roughly every 40 s, its size fixed per window so replays match.
  function spike(t) {
    const win = Math.floor(t / 40000);
    const into = t - win * 40000;
    if (into > 6000) return 0;
    const shape = Math.sin(Math.PI * (into / 6000));
    return shape * (18 + seeded(win) * 42);
  }

  const sim = {
    cpuTemp: 44, gpuTemp: 41,
    micMuted: false,
    speakerVolume: D.audio.speaker.volume,
    speakerMuted: false,
    micVolume: D.audio.mic.volume,
    track: 0, position: 0, playing: true, lastTick: Date.now(),
    bootAt: new Date(T0 - (4 * 3600 + 37 * 60) * 1000).toISOString(),
  };

  function cpuLoad() {
    const t = el();
    return clamp(wob(t, 26, 9, 17000, 0) + wob(t, 0, 4, 3100, 1.7) + spike(t), 2, 97);
  }
  function gpuLoad() {
    const t = el() - 4000;            // trails the CPU
    return clamp(wob(t, 18, 12, 21000, 0.9) + wob(t, 0, 5, 4700, 2.4) + spike(t) * 0.8, 1, 98);
  }
  function stepTemps(dtMs) {
    const k = Math.min(0.35, dtMs / 3000);
    sim.cpuTemp += ((38 + cpuLoad() * 0.42) - sim.cpuTemp) * k;
    sim.gpuTemp += ((36 + gpuLoad() * 0.38) - sim.gpuTemp) * k;
  }
  function stepMedia() {
    const now = Date.now();
    const dt = Math.max(0, (now - sim.lastTick) / 1000);
    sim.lastTick = now;
    if (!sim.playing) return;
    sim.position += dt;
    const cur = D.playlist[sim.track];
    if (sim.position >= cur.duration) { sim.position = 0; sim.track = (sim.track + 1) % D.playlist.length; }
  }

  function systemPayload() {
    const cpu = cpuLoad();
    const ramPct = clamp(wob(el(), 47, 3, 61000, 0.4), 20, 92);
    const total = D.system.memoryTotal;
    return {
      hostname: D.system.hostname,
      uptime: Math.floor((Date.now() - new Date(sim.bootAt).getTime()) / 1000),
      cpu: Math.round(cpu),
      cpuName: D.system.cpuName,
      cpuTemp: Math.round(sim.cpuTemp),
      memory: { used: Math.round(total * ramPct / 100), total, percent: Math.round(ramPct) },
      ramDetail: D.system.ramDetail,
      gpu: Math.round(gpuLoad()),
      gpuName: D.system.gpuName,
      gpuTemp: Math.round(sim.gpuTemp),
      vramUsed: Math.round(D.system.vramTotal * clamp(wob(el(), 0.44, 0.09, 33000, 1.1), 0.08, 0.95)),
      vramTotal: D.system.vramTotal,
      disks: D.system.disks.map((d) => Object.assign({}, d, {
        free: d.total - d.used, percent: Math.round(d.used / d.total * 100),
      })),
      fans: D.system.fans.map((f) => Object.assign({}, f, {
        rpm: Math.round(f.rpm + cpu * 6 + wob(el(), 0, 25, 9000, 0)),
      })),
    };
  }
  function mediaPayload() {
    stepMedia();
    const tr = D.playlist[sim.track];
    return {
      active: true, app: 'Spotify', title: tr.title, artist: tr.artist, album: tr.album,
      thumbnail: tr.thumbnail, playbackStatus: sim.playing ? 'Playing' : 'Paused',
      position: Math.round(sim.position), duration: tr.duration,
    };
  }
  function audioPayload() {
    return {
      speaker: Object.assign({}, D.audio.speaker, { volume: sim.speakerVolume, muted: sim.speakerMuted }),
      mic: Object.assign({}, D.audio.mic, { volume: sim.micVolume, muted: sim.micMuted }),
      speakerApps: D.audio.speakerApps, micApps: D.audio.micApps,
    };
  }
  function networkPayload() {
    const t = el();
    return {
      downloadBps: Math.max(0, Math.round(D.network.downloadBps * clamp(wob(t, 1, 0.85, 13000, 0.3) + spike(t) / 90, 0.02, 3))),
      uploadBps: Math.max(0, Math.round(D.network.uploadBps * clamp(wob(t, 1, 0.6, 9400, 1.9), 0.05, 2.4))),
      ping: Math.round(clamp(wob(t, 12, 4, 23000, 0.7), 4, 40)),
      latency: Math.round(clamp(wob(t, 9, 3, 17000, 2.2), 2, 30)),
      // No fps field: nothing is playing, and the tile's own "N/A" is more
      // honest than a hard 0.
    };
  }
  function statusPayload() {
    return {
      muted: sim.micMuted, gaming: false, activity: 'other', process: 'explorer.exe',
      gameRunning: false, gameProcess: '', idleSec: 12, bootAt: sim.bootAt,
      // Constant, so main.js's version fence never triggers a reload loop.
      version: VERSION,
    };
  }

  // ── 4. The route table ────────────────────────────────────────────────────
  // Three tiers. The default tier is what makes it safe to mock ~28 endpoints
  // instead of the ~116 the client can call.
  const ok = (body) => ({ status: 200, body: Object.assign({ ok: true }, body) });

  // Tier B — anything that would touch a real PC. Answered with a refusal AND a
  // toast, because a silently dead button is worse than an honest "not here".
  const BLOCKED = [
    '/actions/run', '/actions/perf', '/disk/scan', '/disk/clean', '/disk/scan/cancel',
    '/disk/clean/cancel', '/api/disk/advisor', '/windows/launch', '/windows/focus', '/windows/close',
    '/system/enable-sensors', '/api/performance/plan', '/api/performance/powerplan',
    '/update/prepare', '/update/apply', '/sdk/install', '/icon-pack', '/sound-pack',
    '/search/open', '/search/reveal', '/search/ai', '/spotlight/claimed', '/lock',
    '/api/community/rate', '/api/community/redeem', '/api/screenshot', '/api/screenshot/monitor',
  ];
  const blockedPrefixes = ['/api/ai/', '/api/stt/', '/remote/', '/api/lighting/set', '/deck/press'];

  let lastToastAt = 0;
  function refuse() {
    const now = Date.now();
    // The highest-intent moment in the demo: the visitor just tried to do
    // something real. demo.js turns this into the conversion sheet, once.
    try { window.dispatchEvent(new CustomEvent('xenon:demo-blocked')); } catch { /* ignore */ }
    if (now - lastToastAt > 4000 && window.XenonToast) {
      lastToastAt = now;
      const tr = (k, fb) => (typeof window.t === 'function' && window.t(k) !== k) ? window.t(k) : fb;
      window.XenonToast.show({
        type: 'notification', kicker: 'Demo',
        title: tr('demo_blocked_title', 'This one runs on your PC'),
        message: tr('demo_blocked_msg', 'Not available in the browser demo — get Xenon free at xenon-app.com'),
        duration: 7000,
      });
    }
    return { status: 200, body: { ok: false, error: 'demo', demo: true } };
  }

  const seenUnmocked = new Set();
  const realFetch = window.fetch.bind(window);

  async function passthroughJson(path) {
    try {
      const r = await realFetch(path, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  async function passthroughText(path) {
    try {
      const r = await realFetch(path, { cache: 'no-store' });
      return r.ok ? await r.text() : null;
    } catch { return null; }
  }

  async function route(url, init) {
    const p = url.pathname;
    const method = ((init && init.method) || 'GET').toUpperCase();
    const q = url.searchParams;

    if (BLOCKED.includes(p) || blockedPrefixes.some((pre) => p.startsWith(pre))) return refuse();

    switch (p) {
      case '/settings':
        if (method === 'POST') {
          // Mirror the write so a re-read is consistent. The localStorage copy is
          // written by the app itself (saveLocalHubSettings), untouched here.
          try {
            const body = JSON.parse((init && init.body) || '{}');
            if (body && body.settings) settings = body.settings;
          } catch { /* keep the previous blob */ }
          return ok({ rev: ++settingsRev });
        }
        // THE keystone. Answering this on the FIRST try sets
        // _hubHydratedFromServer, which stops the 4 s retry loop, unparks every
        // server-bound save, and lets Onboarding.maybeStart() run — the guided
        // tour only ever fires from the hydrate success path.
        return ok({ settings: Object.assign({}, settings, { rev: settingsRev }) });

      case '/status': return { status: 200, body: statusPayload() };
      case '/system': return { status: 200, body: systemPayload() };
      case '/audio': return { status: 200, body: audioPayload() };
      case '/media': return { status: 200, body: mediaPayload() };
      case '/network': return { status: 200, body: networkPayload() };
      case '/weather': return { status: 200, body: D.weather };
      case '/version': return ok({ version: VERSION });

      // Live controls. Deliberately NOT blocked: there is no PC to affect, and
      // "I pressed pause and it actually paused" is the moment the demo earns
      // its trust.
      case '/toggle':
        sim.micMuted = !sim.micMuted;
        push('status', statusPayload());
        return { status: 200, body: { muted: sim.micMuted } };
      case '/mic/volume':
        sim.micVolume = clamp(parseInt(q.get('v') || q.get('value'), 10) || sim.micVolume, 0, 100);
        push('audio', audioPayload());
        return ok({});
      case '/volume/set':
        sim.speakerVolume = clamp(parseInt(q.get('v') || q.get('value'), 10) || sim.speakerVolume, 0, 100);
        push('audio', audioPayload());
        return ok({});
      case '/speaker/mute':
        sim.speakerMuted = !sim.speakerMuted;
        push('audio', audioPayload());
        return ok({});
      case '/media/playpause':
        sim.playing = !sim.playing; stepMedia(); push('media', mediaPayload()); return ok({});
      case '/media/next':
        sim.track = (sim.track + 1) % D.playlist.length; sim.position = 0; push('media', mediaPayload()); return ok({});
      case '/media/previous': case '/media/prev':
        sim.track = (sim.track + D.playlist.length - 1) % D.playlist.length; sim.position = 0;
        push('media', mediaPayload()); return ok({});

      case '/notes/list': return ok(D.notes);
      case '/notes/save': return ok({ rev: ++D.notes.rev });
      case '/tasks': return ok({ tasks: D.tasks });
      case '/events': return ok({ events: D.events });
      case '/external-events': return ok({ events: [] });
      case '/api/timers': return ok({ timers: D.timers });
      case '/api/battery': return ok(D.battery);
      case '/api/stocks': return ok({ quotes: D.stocks });
      case '/api/news': return ok({ items: D.news });
      case '/api/football': return ok({ matches: D.football });
      case '/api/gamemode/status': return ok({ gaming: false });
      case '/api/native/status': case '/api/native/install-status': return ok({ installed: false });
      case '/remote/status': return ok({ ready: false, installed: false, blocked: false, connectedClients: [] });
      case '/sdk/widgets': return ok({ packages: [] });
      // An empty Deck store is a real, valid store: the widget renders its own
      // "add a key" empty state rather than an error, and the editor works.
      // Inventing keys here would mean carrying deck.json's schema in this file.
      case '/deck-config':
        return method === 'POST'
          ? ok({ rev: 1, configs: {}, instanceRevs: {} })
          : ok({ configs: {}, rev: 1, savedAt: null, instanceRevs: {}, presets: [], keyPresets: [] });
      // Empty on purpose: a "what's new in this version" modal makes no sense
      // over an install the visitor does not have.
      case '/whatsnew': return ok({ id: '', items: [] });
      case '/actions/catalog': return ok({ actions: [] });
      case '/index/status': return ok({ ready: false, building: false, count: 0 });
      case '/update/check': case '/update/self-status':
        return ok({ current: VERSION, latest: VERSION, updateAvailable: false });

      // The in-app Store, served from the site's OWN catalog files. Two proxy
      // routes and the whole storefront works: browse the real catalog, import a
      // real theme, watch it apply. Best moment in the demo, cheapest to build.
      case '/api/community/catalog': {
        const cat = await passthroughJson('../community/catalog.json');
        return cat ? ok(cat) : ok({ entries: [] });
      }
      case '/api/community/code': {
        const id = String(q.get('id') || '');
        if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(id)) return { status: 200, body: { ok: false, error: 'bad id' } };
        const code = await passthroughText('../community/codes/' + id + '.txt');
        return code ? ok({ code: code.trim() }) : { status: 200, body: { ok: false, error: 'missing' } };
      }
      case '/api/community/ratings': return ok({ ratings: {} });
      case '/api/community/installs': return ok({ installs: {} });
      case '/api/community/limited-status': return ok({ drops: {} });
      default: break;
    }

    // Tier C. HTTP 200 with ok:false, never a 404: dozens of call sites treat a
    // non-ok RESPONSE as a hard error and start a backoff loop, while {ok:false}
    // is the shape a disabled feature already returns. Each unique path is
    // logged once — that list is the deliverable of a QA pass.
    if (!seenUnmocked.has(p)) {
      seenUnmocked.add(p);
      console.info('[demo] unmocked', method, p);
    }
    return { status: 200, body: { ok: false, error: 'demo_unavailable' } };
  }

  // ── 5. fetch shim ─────────────────────────────────────────────────────────
  window.fetch = function (input, init) {
    let raw = '';
    if (typeof input === 'string') raw = input;
    else if (input && typeof input.url === 'string') raw = input.url;
    let url;
    try { url = new URL(raw, location.href); } catch { return realFetch(input, init); }
    // Fonts, the R2 asset host and the supporter-hub Worker are real.
    if (url.origin !== location.origin) return realFetch(input, init);
    // The demo's own assets and the site's static files are real too. The
    // leading ^ is load-bearing: an unanchored /community/ also matches inside
    // /api/community/catalog, which sent the in-app Store to the site's 404 page
    // instead of to its mock.
    if (/^\/(demo|community|images|get|catalog|submit|create)\//.test(url.pathname)
      || /\.(js|css|png|jpe?g|webp|svg|gif|woff2?|json|txt|mp4|ico)$/i.test(url.pathname)) {
      return realFetch(input, init);
    }
    return route(url, init || {}).then((r) => new Response(JSON.stringify(r.body), {
      // A real Response matters: settings.js reads res.ok after res.arrayBuffer(),
      // and several call sites read res.status.
      status: r.status || 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  };

  // ── 6. EventSource shim ───────────────────────────────────────────────────
  // It never errors and never reaches readyState CLOSED. That single property is
  // the entire mechanism that keeps main.js's polling fallback from ever
  // starting (it only fires on es.onerror with readyState === CLOSED).
  const streams = new Set();
  function push(type, obj) {
    streams.forEach((s) => s._emit(type, obj));
  }
  function DemoEventSource(url) {
    this.url = String(url);
    this.readyState = 0;
    this.withCredentials = false;
    this._handlers = Object.create(null);
    this.onopen = null; this.onmessage = null; this.onerror = null;
    streams.add(this);
    setTimeout(() => {
      this.readyState = 1;
      if (typeof this.onopen === 'function') this.onopen(new Event('open'));
      seed(this);
    }, 0);
  }
  DemoEventSource.prototype.addEventListener = function (type, fn) {
    (this._handlers[type] || (this._handlers[type] = [])).push(fn);
  };
  DemoEventSource.prototype.removeEventListener = function (type, fn) {
    const a = this._handlers[type];
    if (a) this._handlers[type] = a.filter((h) => h !== fn);
  };
  DemoEventSource.prototype._emit = function (type, obj) {
    if (this.readyState !== 1) return;
    const ev = new MessageEvent(type, { data: JSON.stringify(obj) });
    (this._handlers[type] || []).forEach((h) => { try { h(ev); } catch (e) { console.error(e); } });
    if (type === 'message' && typeof this.onmessage === 'function') this.onmessage(ev);
  };
  DemoEventSource.prototype.close = function () { this.readyState = 2; streams.delete(this); };
  DemoEventSource.CONNECTING = 0; DemoEventSource.OPEN = 1; DemoEventSource.CLOSED = 2;
  window.EventSource = DemoEventSource;

  // Seed order mirrors the real server exactly: system, media, audio, then
  // status LAST, because the status handler is what calls setOnline().
  function seed(s) {
    s._emit('system', systemPayload());
    s._emit('media', mediaPayload());
    s._emit('audio', audioPayload());
    s._emit('status', statusPayload());
    s._emit('notes', D.notes);
    s._emit('battery', D.battery);
    s._emit('stocks', { quotes: D.stocks });
    s._emit('news', { items: D.news });
    s._emit('football', { matches: D.football });
    s._emit('discord', D.discord);
    s._emit('homeassistant', D.homeassistant);
    s._emit('wavelink', D.wavelink);
    s._emit('claude', D.claude);
    s._emit('obs', { connected: false });
    s._emit('timer_update', { timers: D.timers });
  }

  // Cadences mirror the real broadcaster so the UI's own change-detection behaves.
  let lastStatus = '';
  setInterval(() => { stepTemps(2000); push('system', systemPayload()); }, 2000);
  setInterval(() => {
    const p = statusPayload();
    const key = JSON.stringify(p);
    if (key !== lastStatus) { lastStatus = key; push('status', p); }
  }, 3000);
  setInterval(() => push('audio', audioPayload()), 5000);
  setInterval(() => { if (sim.playing) push('media', mediaPayload()); }, 1000);
  setInterval(() => {
    const tm = D.timers[0];
    if (tm && tm.running && tm.remaining > 0) { tm.remaining--; push('timer_update', { timers: D.timers }); }
  }, 1000);

  // ── 7. WebSocket + sendBeacon ─────────────────────────────────────────────
  // Stuck at CONNECTING forever, deliberately: browser-tile.js and
  // second-screen-tile.js both early-return from ensureRelay() while
  // readyState is 0 or 1, so the first call is also the last — no reconnect
  // churn, no error spam.
  function DemoWebSocket(url) {
    this.url = String(url); this.readyState = 0; this.bufferedAmount = 0;
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
  }
  DemoWebSocket.prototype.addEventListener = function () {};
  DemoWebSocket.prototype.removeEventListener = function () {};
  DemoWebSocket.prototype.send = function () {};
  DemoWebSocket.prototype.close = function () { this.readyState = 3; };
  DemoWebSocket.CONNECTING = 0; DemoWebSocket.OPEN = 1; DemoWebSocket.CLOSING = 2; DemoWebSocket.CLOSED = 3;
  window.WebSocket = DemoWebSocket;

  // Four call sites bypass fetch entirely (deck.js, settings.js x2, main.js) and
  // a beacon to a 404 reports nothing, so the failure would be invisible.
  if (navigator.sendBeacon) navigator.sendBeacon = function () { return true; };

  // ── 8. Splash ─────────────────────────────────────────────────────────────
  // 115 classic scripts execute serially; on a mid laptop that is seconds of
  // blank page. This is the highest-value 30 lines in the whole demo.
  (function splash() {
    const s = document.createElement('div');
    s.id = 'demo-splash';
    s.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483600', 'display:flex',
      'flex-direction:column', 'align-items:center', 'justify-content:center', 'gap:18px',
      'background:#070808', 'color:#f0f3f1', 'font:600 15px/1.5 system-ui,sans-serif',
      'letter-spacing:.02em', 'transition:opacity .45s ease',
    ].join(';'));
    s.innerHTML = '<div style="width:46px;height:46px;border-radius:50%;'
      + 'border:3px solid rgba(30,215,96,.18);border-top-color:#1ed760;'
      + 'animation:demospin 900ms linear infinite"></div>'
      + '<div style="opacity:.7">Loading the Xenon demo…</div>'
      + '<style>@keyframes demospin{to{transform:rotate(360deg)}}</style>';
    const mount = () => { if (document.body) document.body.appendChild(s); };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
    window.addEventListener('load', () => {
      setTimeout(() => {
        s.style.opacity = '0';
        setTimeout(() => s.remove(), 500);
      }, 250);
    });
  })();

  window.__XENON_DEMO__ = { push, sim, seenUnmocked, build: BUILD, version: VERSION };
})();
