'use strict';
// Lazy Razer Chroma REST client + pure helpers. The Chroma SDK exposes an
// UNAUTHENTICATED local REST server (http://127.0.0.1:54235) that must be
// initialized (POST → session `uri`), kept alive with a periodic heartbeat
// (15s server-side timeout), and torn down with DELETE. Two consumers ride ONE
// session: direct Deck/SDK actions (set a device's colour/effect) and the
// ambient lighting system (the `chroma` lighting-provider fans album/reactive
// colour to Razer gear through applyColor()).
//
// Lightweight by construction (see .claude/CLAUDE.md "lighting must stay
// lightweight" + "gate periodic work"): a session is opened only on first use
// and uninitialized after an idle period, so the 8s heartbeat runs ONLY while
// something is actively driving lights — never a perpetual timer on an idle
// dashboard. Releasing (DELETE) hands control straight back to Synapse, which
// restores the user's own lighting — no state snapshot needed.
//
// Design invariants:
//   - Never throws out of the public surface — errors degrade to {ok:false}.
//   - No new npm deps: Node's http only; every request is async + time-boxed.
//   - Graceful degrade: if Synapse/Chroma isn't running, init fails and every
//     action returns {ok:false, error:'chroma_unavailable'} — never a crash.

const http = require('http');

// The Chroma REST server is fixed at loopback:54235. The init endpoint returns a
// per-session base uri (e.g. http://127.0.0.1:54235/1/chromasdk) used for all
// subsequent effect/heartbeat/delete calls.
const CHROMA_INIT_URL = 'http://127.0.0.1:54235/razer/chromasdk';

// Heartbeat comfortably under the 15s server timeout, but far lighter than
// Razer's 1s suggestion — we also reset the timeout on every effect PUT, so 8s
// keepalive is ample and keeps idle-with-a-static-effect traffic minimal.
const HEARTBEAT_MS = 8000;
// Uninitialize the session after this long with no writes — Synapse resumes and
// the heartbeat stops. Kept short so an idle dashboard drops Chroma quickly.
const IDLE_MS = 45000;
const HTTP_TIMEOUT_MS = 2500;

// The six device endpoints Chroma exposes. 'all' fans a command to every one.
const DEVICES = ['keyboard', 'mouse', 'mousepad', 'headset', 'keypad', 'chromalink'];
const DEVICE_SET = new Set(DEVICES);

// Keyboard CHROMA_CUSTOM grid (standard layout). Only used for the advanced
// per-key custom effect exposed to widgets; single-colour effects don't need it.
const KB_ROWS = 6;
const KB_COLS = 22;

// ---- pure helpers (also unit-tested) ---------------------------------------

// Chroma colours are BGR integers (0x00BBGGRR): red is the least-significant
// byte. Getting this order wrong silently swaps red/blue — hence a single helper.
function bgrInt(r, g, b) {
  const R = Math.max(0, Math.min(255, r | 0));
  const G = Math.max(0, Math.min(255, g | 0));
  const B = Math.max(0, Math.min(255, b | 0));
  return (B << 16) | (G << 8) | R;
}

// Parse "#rrggbb" / "rrggbb" (or an {r,g,b} object) into a BGR int, or null if
// it isn't a valid colour. The only free-form value that reaches the SDK, so it
// is strictly validated at the boundary.
function parseColor(value) {
  if (value && typeof value === 'object') {
    const { r, g, b } = value;
    if ([r, g, b].every((n) => typeof n === 'number' && Number.isFinite(n))) return bgrInt(r, g, b);
    return null;
  }
  const s = String(value == null ? '' : value).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return bgrInt(r, g, b);
}

// Resolve an action's `device` field to the list of concrete device endpoints it
// targets: a specific device, or all six for 'all'. Returns [] if invalid.
function resolveDevices(device) {
  const d = String(device == null ? 'all' : device).trim().toLowerCase();
  if (d === 'all' || d === '') return DEVICES.slice();
  return DEVICE_SET.has(d) ? [d] : [];
}

// Map a validated Deck/SDK Chroma action to { devices, body }, or null if it
// can't. Kept pure so the registry/provider stays a thin dispatcher.
//   chromaColor  { device, color }  -> CHROMA_STATIC on the devices
//   chromaOff    { device }         -> CHROMA_NONE
//   chromaCustom { device, grid }   -> CHROMA_CUSTOM (keyboard grid of hex ints)
function chromaActionToEffect(action) {
  if (!action || typeof action !== 'object') return null;
  const devices = resolveDevices(action.device);
  if (!devices.length) return null;
  if (action.type === 'chromaOff') {
    return { devices, body: { effect: 'CHROMA_NONE' } };
  }
  if (action.type === 'chromaColor') {
    const color = parseColor(action.color);
    if (color == null) return null;
    return { devices, body: { effect: 'CHROMA_STATIC', param: { color } } };
  }
  if (action.type === 'chromaCustom') {
    const grid = buildCustomGrid(action.grid);
    if (!grid) return null;
    // CHROMA_CUSTOM only makes sense per-device (grids are device-shaped); apply
    // the keyboard-shaped grid to the keyboard endpoint only.
    return { devices: devices.filter((d) => d === 'keyboard'), body: { effect: 'CHROMA_CUSTOM', param: grid } };
  }
  return null;
}

// Coerce a widget-supplied grid (a 2D array of hex strings / {r,g,b} / ints) into
// the fixed keyboard-shaped 2D array of BGR ints, padding/truncating to KB_ROWS ×
// KB_COLS. Returns null if the input isn't a non-empty array.
function buildCustomGrid(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const grid = [];
  for (let row = 0; row < KB_ROWS; row++) {
    const src = Array.isArray(input[row]) ? input[row] : [];
    const out = [];
    for (let col = 0; col < KB_COLS; col++) {
      const cell = src[col];
      const c = typeof cell === 'number' && Number.isFinite(cell) ? (cell | 0) : parseColor(cell);
      out.push(c == null ? 0 : c);
    }
    grid.push(out);
  }
  return grid;
}

// ---- lazy session client ----------------------------------------------------

// Returns a client that opens the Chroma session on demand, holds it with a
// heartbeat only while active, and uninitializes after idle. `opts.appInfo`
// overrides the init identity (title/author) for tests.
function createChroma(opts) {
  const appInfo = (opts && opts.appInfo) || {
    title: 'Xenon',
    description: 'Xenon dashboard for the CORSAIR Xeneon Edge',
    author: { name: 'XenonEdge', contact: 'https://github.com/marcimastro98' },
    device_supported: DEVICES.slice(),
    category: 'application',
  };

  let sessionUri = null;      // active session base uri, or null
  let ready = null;           // Promise<string uri> shared by concurrent callers
  let heartbeatTimer = null;
  let idleTimer = null;
  let available = null;       // last known reachability (null = unknown)

  // Minimal loopback HTTP request → parsed JSON (or {} for empty 200s). Rejects
  // on network error / non-2xx / timeout; callers map that to a soft failure.
  function httpRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      let req;
      const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
      try {
        req = http.request(url, {
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {},
          timeout: HTTP_TIMEOUT_MS,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) { reject(new Error('chroma_http_' + status)); return; }
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) { resolve({}); return; }
            try { resolve(JSON.parse(text)); } catch (e) { resolve({}); }
          });
        });
      } catch (e) { reject(e); return; }
      req.on('timeout', () => { req.destroy(new Error('chroma_timeout')); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function clearHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }
  function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

  // Restart the idle countdown; every write bumps it so an active session stays
  // open and an idle one is uninitialized after IDLE_MS.
  function bumpIdle() {
    clearIdle();
    idleTimer = setTimeout(() => { release().catch(() => {}); }, IDLE_MS);
  }

  // Open (or reuse) the session. Concurrent callers share one init handshake.
  function ensureSession() {
    if (sessionUri) return Promise.resolve(sessionUri);
    if (ready) return ready;
    ready = httpRequest('POST', CHROMA_INIT_URL, appInfo).then((res) => {
      const uri = res && typeof res.uri === 'string' ? res.uri : '';
      if (!uri) { ready = null; available = false; throw new Error('chroma_init_failed'); }
      sessionUri = uri;
      available = true;
      ready = null;
      // Keepalive: PUT /heartbeat under the 15s timeout. A failed beat means the
      // session died (Synapse closed / restarted) — drop it so the next write
      // re-inits cleanly instead of hammering a dead uri.
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        httpRequest('PUT', sessionUri + '/heartbeat').catch(() => { hardClose(); });
      }, HEARTBEAT_MS);
      bumpIdle();
      return sessionUri;
    }, (e) => { ready = null; available = false; throw e; });
    ready.catch(() => {});
    return ready;
  }

  // Local teardown of timers + session handle without a DELETE (used when the
  // server already reported the session dead).
  function hardClose() {
    clearHeartbeat();
    clearIdle();
    sessionUri = null;
    ready = null;
  }

  // PUT an effect body to one device endpoint. Best-effort; resolves to a boolean.
  async function putEffect(device, body) {
    if (!DEVICE_SET.has(device)) return false;
    try {
      const uri = await ensureSession();
      await httpRequest('PUT', uri + '/' + device, body);
      bumpIdle();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- public surface -------------------------------------------------------

  // Execute a validated Deck/SDK Chroma action. Returns {ok} — never throws.
  async function runAction(action) {
    const eff = chromaActionToEffect(action);
    if (!eff || !eff.devices.length) return { ok: false, error: 'bad_chroma_action' };
    let anyOk = false;
    for (const device of eff.devices) {
      // eslint-disable-next-line no-await-in-loop -- serialized on purpose: the
      // Chroma server is single-session and dislikes parallel PUTs.
      const ok = await putEffect(device, eff.body);
      anyOk = anyOk || ok;
    }
    return anyOk ? { ok: true } : { ok: false, error: 'chroma_unavailable' };
  }

  // Ambient consumer: paint every device one colour ({r,g,b}). Fire-and-forget
  // shape (returns a promise but callers may ignore it). Used by the lighting
  // provider so album/reactive colour reaches Razer gear.
  async function applyColor(color) {
    if (!color || typeof color !== 'object') return { ok: false };
    const c = parseColor(color);
    if (c == null) return { ok: false };
    const body = { effect: 'CHROMA_STATIC', param: { color: c } };
    let anyOk = false;
    for (const device of DEVICES) {
      // eslint-disable-next-line no-await-in-loop -- single-session, see runAction
      const ok = await putEffect(device, body);
      anyOk = anyOk || ok;
    }
    return { ok: anyOk };
  }

  // Uninitialize the session — Synapse takes back control and restores the
  // user's own lighting. Safe to call when no session is open.
  async function release() {
    const uri = sessionUri;
    hardClose();
    if (!uri) return { ok: true };
    try { await httpRequest('DELETE', uri); } catch (e) { /* best effort */ }
    return { ok: true };
  }

  // Probe reachability without holding a session: init then immediately release.
  // Updates `available` for the status stream.
  async function test() {
    try {
      await ensureSession();
      await release();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'chroma_unavailable' };
    }
  }

  function isConnected() { return !!sessionUri; }

  // Compact status for the SDK/dashboard stream: whether Chroma is reachable and
  // whether we currently hold a session, plus the fixed device list.
  function getStatus() {
    return { available: available === true, active: !!sessionUri, devices: DEVICES.slice() };
  }

  return { runAction, applyColor, release, test, isConnected, getStatus, close: release };
}

module.exports = {
  createChroma,
  bgrInt,
  parseColor,
  resolveDevices,
  chromaActionToEffect,
  buildCustomGrid,
  DEVICES,
  KB_ROWS,
  KB_COLS,
};
