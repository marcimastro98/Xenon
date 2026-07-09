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

// Turn a user-entered host ("192.168.1.1", "https://udm.local", "udm.home:443")
// into a normalized origin ("https://host[:port]"), or '' if unusable. A bare
// host defaults to https (UniFi OS is TLS-only); a non-http scheme is rejected.
function unifiBaseUrl(host) {
  let v = String(host == null ? '' : host).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    // already an http(s) URL — use as-is
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(v)) {
    // an explicit non-http scheme (file:, javascript:, ws:, ftp://…). The `(?!\d)`
    // excludes "host:port" — a port always starts with a digit — so a bare
    // "udm.local:8443" is NOT mistaken for a scheme. Reject: a UniFi console is
    // http(s) only, and this stops a bad scheme being coerced into a hostname.
    return '';
  } else {
    v = 'https://' + v;   // bare host or host:port → default to https (UniFi OS is TLS)
  }
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (!u.hostname) return '';
  return u.protocol + '//' + u.host;   // scheme + host(:port) only, no path/query
}

// UniFi Protect camera ids are hex-ish Mongo-style tokens. Validate strictly so an
// id can be safely interpolated into the snapshot path — no traversal, no query
// injection, no slashes.
function isCameraId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9]{4,64}$/.test(s);
}

const UNIFI_MAX_CAMERAS = 60;

// The `unifi` settings sub-object: { host, username, cameras, password }. host /
// username / cameras (the user's selection to display) are client-visible; the
// console password is a SERVER-ONLY secret handled with the same preserve/redact
// pattern as the Home Assistant token.
function normalizeUnifi(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const host = String(src.host == null ? '' : src.host).trim().slice(0, 200);
  const cameras = Array.isArray(src.cameras)
    ? src.cameras.filter(isCameraId).filter((v, i, a) => a.indexOf(v) === i).slice(0, UNIFI_MAX_CAMERAS)
    : [];
  return {
    host: unifiBaseUrl(host) ? host : '',              // keep only a usable host
    username: String(src.username == null ? '' : src.username).trim().slice(0, 120),
    password: typeof src.password === 'string' ? src.password.slice(0, 200) : '',
    cameras,
  };
}

// Protect the persisted UniFi config against a client save. Two cases, mirroring
// preserveHaToken:
//   - payload has NO unifi block (older/partial/programmatic client): keep the
//     whole persisted block so nothing is wiped.
//   - payload HAS the block (the normal client, which owns host/username/cameras
//     but never receives the real password): carry the persisted password over
//     when the incoming one is empty.
function preserveUnifiCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const prevU = (prev && typeof prev === 'object' && prev.unifi) || {};
  const hasBlock = incoming.unifi && typeof incoming.unifi === 'object';
  if (!hasBlock) {
    if (prevU.host || prevU.password || prevU.username || (Array.isArray(prevU.cameras) && prevU.cameras.length)) {
      incoming.unifi = { ...prevU };
    }
    return incoming;
  }
  if (prevU.password && !incoming.unifi.password) incoming.unifi.password = prevU.password;
  return incoming;
}

// Blank the password before settings reach the browser; expose only a
// `passwordSet` boolean so the UI can show a "saved" placeholder. Shallow copy.
function redactUnifiCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const u = settings.unifi;
  if (!u || typeof u !== 'object') return settings;
  return {
    ...settings,
    unifi: {
      host: u.host || '',
      username: u.username || '',
      cameras: Array.isArray(u.cameras) ? u.cameras : [],
      password: '',
      passwordSet: !!u.password,
    },
  };
}

function isConfigured(cfg) {
  return !!(cfg && unifiBaseUrl(cfg.host) && String(cfg.username || '').trim() && String(cfg.password || '').trim());
}

// Project a raw Protect camera object down to the compact shape the tile needs.
function compactCamera(c) {
  if (!c || !c.id || !isCameraId(String(c.id))) return null;
  const state = c.state != null ? String(c.state) : '';
  return {
    id: String(c.id),
    name: String(c.name || c.type || 'Camera').slice(0, 80),
    // Protect reports state as "CONNECTED"/"DISCONNECTED"; fall back to isConnected.
    connected: state ? state.toUpperCase() === 'CONNECTED' : (c.isConnected !== false),
  };
}

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
      const chunks = [];
      const rq = lib.request(options, (rs) => {
        rs.on('data', (d) => chunks.push(d));
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

  // A single JPEG snapshot for one camera (Buffer). `force=true` requests a fresh
  // frame; `ts` cache-busts. Throws on a bad id or a non-2xx response.
  async function snapshot(id) {
    if (!isCameraId(id)) throw new Error('unifi_bad_camera_id');
    const path = '/proxy/protect/api/cameras/' + id + '/snapshot?force=true&ts=' + Date.now();
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

  // Invalidate the cached session/cameras. Bumps the generation so a login() in
  // flight won't publish its (now stale-cred) session. The keep-alive agent is
  // kept — the long-lived deckUnifi reuses it for the next pull.
  function close() { session = null; loginInflight = null; camCache = { at: 0, list: null }; generation++; }

  // Full teardown for a throwaway client (the Settings "Connect" probe): also
  // destroys the keep-alive HTTPS agent so its pooled sockets to the console don't
  // linger until idle-reaped. Never call this on the long-lived deckUnifi.
  function destroy() { close(); try { HTTPS_AGENT.destroy(); } catch (e) { /* ignore */ } }

  return { cameras, listCameras, snapshot, test, close, destroy };
}

module.exports = {
  createUnifiProtect,
  unifiBaseUrl,
  isCameraId,
  isConfigured,
  compactCamera,
  normalizeUnifi,
  preserveUnifiCreds,
  redactUnifiCreds,
};
