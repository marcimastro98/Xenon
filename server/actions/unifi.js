'use strict';
// Lazy UniFi Protect client + pure helpers. Shows a user's cameras on the
// dashboard as near-live JPEG snapshots, pulled only while the tile is on screen.
// Mirrors the Home Assistant integration: the console password stays server-side
// (preserve-on-save / redact-on-wire); the browser only ever receives camera
// names + JPEG bytes, and only through the loopback snapshot proxy.
//
// UniFi Protect runs on a UniFi OS console (UDM / UNVR / Cloud Key Gen2+). Local
// API used here (all under the console's HTTPS origin):
//   POST /api/auth/login              {username,password} -> TOKEN cookie + x-csrf-token
//   GET  /proxy/protect/api/cameras                       -> [{ id, name, state, type }]
//   GET  /proxy/protect/api/cameras/{id}/snapshot?force=… -> image/jpeg (640×360 on Protect 6+)
//
// The console presents a self-signed certificate, so TLS validation is disabled
// for it — the target is a user-entered LAN device the user explicitly trusts,
// exactly like `curl -k` or homebridge-unifi-protect. The host comes from
// server-side settings (never a per-request untrusted URL), so there is no SSRF
// surface beyond the console the user configured; the camera id is strictly
// validated before it is interpolated into the snapshot path.
//
// Design invariants (see .claude/CLAUDE.md):
//   - Password is a SERVER-ONLY secret; the public surface never throws (errors
//     degrade to a thrown Error only inside test(), which catches to {ok:false}).
//   - No persistent socket or polling loop: snapshots are PULLed on demand by the
//     tile, so a hidden/unused tile costs nothing (the client gates on visibility).
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ---- pure helpers (also unit-tested) ---------------------------------------

const {
  unifiBaseUrl, isCameraId, UNIFI_MAX_CAMERAS, UNIFI_NOTIFY_KINDS, normalizeUnifiNotify,
  normalizeUnifi, unifiSameDestination, preserveUnifiCreds, redactUnifiCreds, isConfigured,
  compactCamera,
} = require('./unifi-settings.js');


// ---- lazy connection --------------------------------------------------------

// getConfig: async () -> { host, username, password }. Returns a client that logs
// in on demand, caches the session cookie + CSRF token, and re-logs-in once on a
// 401. Holds no timers or sockets — snapshots are pulled per request.
function createUnifiProtect(getConfig) {
  let session = null;          // { base, cookie, csrf }
  let loginInflight = null;
  let camCache = { at: 0, list: null };
  // Bumped by close()/destroy(); a login() in flight when the config changes checks
  // this before publishing its session, so a session built from the OLD credentials
  // is never installed after an invalidation (POST /settings calls close()).
  let generation = 0;
  const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

  // Low-level request. Resolves { status, headers, body:Buffer } for any status
  // (non-2xx included) so callers decide; rejects only on transport failure.
  function reqRaw(base, opts) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(base + opts.path); } catch (e) { reject(new Error('unifi_bad_url')); return; }
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const options = {
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        headers: opts.headers || {},
        timeout: opts.timeout || 8000,
      };
      if (isHttps) options.agent = HTTPS_AGENT;   // trust the console's self-signed cert
      // Size cap: the timeout above is inactivity-based, so an endpoint that
      // streams (rather than answering with one JSON/JPEG body) would keep the
      // socket alive while the buffer grew without bound.
      const MAX_BODY = 10 * 1024 * 1024;
      const chunks = [];
      let size = 0;
      const rq = lib.request(options, (rs) => {
        rs.on('data', (d) => {
          size += d.length;
          if (size > MAX_BODY) { rq.destroy(new Error('unifi_body_too_large')); return; }
          chunks.push(d);
        });
        rs.on('end', () => resolve({ status: rs.statusCode || 0, headers: rs.headers, body: Buffer.concat(chunks) }));
      });
      rq.on('error', (e) => reject(e));
      rq.on('timeout', () => rq.destroy(new Error('unifi_timeout')));
      if (opts.body != null) rq.write(opts.body);
      rq.end();
    });
  }

  async function login() {
    const gen = generation;
    const cfg = (await Promise.resolve().then(getConfig)) || {};
    const base = unifiBaseUrl(cfg.host);
    const username = String(cfg.username || '').trim();
    const password = String(cfg.password || '');
    if (!base || !username || !password) throw new Error('unifi_not_configured');
    const payload = JSON.stringify({ username, password, rememberMe: false });
    const r = await reqRaw(base, {
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
      body: payload,
      timeout: 10000,
    });
    if (r.status === 401 || r.status === 403) throw new Error('unifi_auth_invalid');
    if (r.status < 200 || r.status >= 300) throw new Error('unifi_login_failed_' + r.status);
    // Session cookie (TOKEN=…) + CSRF token from the login response headers.
    const setCookie = r.headers['set-cookie'] || [];
    let cookie = '';
    for (const c of setCookie) { const m = /^(TOKEN=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const csrf = r.headers['x-csrf-token'] || r.headers['x-updated-csrf-token'] || '';
    if (!cookie) throw new Error('unifi_no_session');
    const s = { base, cookie, csrf: String(csrf || '') };
    // A close() during this login (e.g. a settings change) bumped the generation —
    // don't publish a session built from now-stale credentials/host. Callers get
    // this session for THIS request but the next ensureSession() re-logs in fresh.
    if (gen === generation) session = s;
    return s;
  }

  function ensureSession() {
    if (session) return Promise.resolve(session);
    if (!loginInflight) loginInflight = login().finally(() => { loginInflight = null; });
    return loginInflight;
  }

  // Authenticated GET with the session cookie + CSRF header; a single re-login on
  // a 401/403 (the TOKEN cookie expires). Returns the raw { status, headers, body }.
  async function authedGet(path, opts) {
    const accept = (opts && opts.accept) || 'application/json';
    const timeout = opts && opts.timeout;
    const build = (s) => {
      const h = { Cookie: s.cookie, Accept: accept };
      if (s.csrf) h['X-CSRF-Token'] = s.csrf;
      return h;
    };
    const s1 = await ensureSession();
    let r = await reqRaw(s1.base, { method: 'GET', path, headers: build(s1), timeout });
    if (r.status === 401 || r.status === 403) {
      session = null;
      const s2 = await ensureSession();
      r = await reqRaw(s2.base, { method: 'GET', path, headers: build(s2), timeout });
    }
    return r;
  }

  async function listCameras() {
    const r = await authedGet('/proxy/protect/api/cameras');
    if (r.status < 200 || r.status >= 300) throw new Error('unifi_cameras_failed_' + r.status);
    let arr;
    try { arr = JSON.parse(r.body.toString('utf8')); } catch (e) { throw new Error('unifi_bad_json'); }
    if (!Array.isArray(arr)) return [];
    return arr.map(compactCamera).filter(Boolean).slice(0, UNIFI_MAX_CAMERAS);
  }

  // Cameras with a short cache so the tile's first paint + periodic status poll
  // don't relogin/relist on every call. The camera set changes rarely.
  async function cameras() {
    const now = Date.now();
    if (camCache.list && (now - camCache.at) < 15000) return camCache.list;
    const list = await listCameras();
    camCache = { at: now, list };
    return list;
  }

  // A single JPEG snapshot for one camera (Buffer). `ts` cache-busts. Throws on a
  // bad id or a non-2xx response.
  //
  // `force` is OFF by default on purpose. `?force=true` tells Protect to CAPTURE a
  // brand-new frame synchronously — fine for a one-off, but the Cameras tile pulls
  // snapshots on a loop (grid AND the expanded view), and hammering `force=true`
  // faster than the camera can produce a fresh frame makes Protect hand back BLACK
  // frames (issue: live view black, yet a single manual click returns a real photo
  // — that click was just the first, un-hammered request). Protect's own cached
  // snapshot (no force) refreshes on its own and stays near-live and reliable, so
  // that's what the tile uses. Reserve `force` for a deliberate one-shot capture.
  async function snapshot(id, force = false) {
    if (!isCameraId(id)) throw new Error('unifi_bad_camera_id');
    const path = '/proxy/protect/api/cameras/' + id + '/snapshot?' + (force ? 'force=true&' : '') + 'ts=' + Date.now();
    const r = await authedGet(path, { accept: 'image/jpeg', timeout: 8000 });
    if (r.status < 200 || r.status >= 300) throw new Error('unifi_snapshot_failed_' + r.status);
    return r.body;
  }

  // Settings "Connect" button: log in fresh with the just-typed creds and list the
  // cameras. Returns {ok,count,cameras} — never throws.
  async function test() {
    try {
      session = null; camCache = { at: 0, list: null };
      const list = await listCameras();
      return { ok: true, count: list.length, cameras: list };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'unifi_failed' };
    }
  }

  // The console's realtime-updates WebSocket URL + the session cookie to present on
  // the upgrade request, for the events client (unifi-events.js). Ensures a session
  // (logs in if needed) and reads the current `lastUpdateId` from bootstrap so we
  // resume the live stream cleanly; best-effort — a console that streams without it
  // still works. Reuses THIS client's session so the password never leaves here.
  async function updatesWs() {
    const s = await ensureSession();
    let lastUpdateId = '';
    try {
      const r = await authedGet('/proxy/protect/api/bootstrap', { timeout: 8000 });
      if (r.status >= 200 && r.status < 300) {
        const b = JSON.parse(r.body.toString('utf8'));
        if (b && typeof b.lastUpdateId === 'string') lastUpdateId = b.lastUpdateId;
      }
    } catch (e) { /* bootstrap optional — connect without lastUpdateId */ }
    const wsBase = s.base.replace(/^http/i, 'ws');   // https→wss, http→ws
    const q = lastUpdateId ? ('?lastUpdateId=' + encodeURIComponent(lastUpdateId)) : '';
    return { wsUrl: wsBase + '/proxy/protect/ws/updates' + q, cookie: s.cookie };
  }

  // Invalidate the cached session/cameras. Bumps the generation so a login() in
  // flight won't publish its (now stale-cred) session. The keep-alive agent is
  // kept — the long-lived deckUnifi reuses it for the next pull.
  function close() { session = null; loginInflight = null; camCache = { at: 0, list: null }; generation++; }

  // Full teardown for a throwaway client (the Settings "Connect" probe): also
  // destroys the keep-alive HTTPS agent so its pooled sockets to the console don't
  // linger until idle-reaped. Never call this on the long-lived deckUnifi.
  function destroy() { close(); try { HTTPS_AGENT.destroy(); } catch (e) { /* ignore */ } }

  return { cameras, listCameras, snapshot, test, close, destroy, updatesWs };
}

module.exports = {
  createUnifiProtect,
  unifiBaseUrl,
  isCameraId,
  isConfigured,
  compactCamera,
  normalizeUnifi,
  normalizeUnifiNotify,
  UNIFI_NOTIFY_KINDS,
  unifiSameDestination,
  preserveUnifiCreds,
  redactUnifiCreds,
};
