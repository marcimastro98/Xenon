'use strict';
// Lazy Elgato Wave Link client + pure helpers. Wave Link exposes an
// UNAUTHENTICATED local JSON-RPC 2.0 WebSocket (ws://127.0.0.1:<port>, scanned
// across 1824..1834) that pushes mixer state changes proactively (no subscribe
// call) and answers request/response for reads and set-commands. Method/param
// shapes verified against Elgato's own WaveLinkClient.js (reused by every
// community plugin) — see docs/WIDGET_SDK.md.
//
// While a listener is attached (a Wave Link dashboard tile / Deck key on screen)
// we keep ONE live connection that mirrors mixer state and pushes it over SSE;
// idle-closes when nobody is watching, so it costs nothing unused. Mirrors the
// lifecycle of actions/home-assistant.js + actions/streamerbot.js.
//
// Design invariants (.claude/CLAUDE.md):
//   - Never throws out of the public surface — errors degrade to {ok:false}.
//   - No new npm deps: reuses `ws` (already present via msedge-tts).
//   - Set-commands replace the WHOLE mixer object, so we keep a fresh cache from
//     getAllChannelInfo + the inputMixerChanged/outputMixerChanged pushes and
//     echo every field back, changing only the targeted one.

const DEFAULT_WS = (() => {
  try { return require('ws'); } catch (e) { return globalThis.WebSocket; }
})();

// Wave Link scans a small port range starting at 1824 (the app picks the first
// free one), so the sweep carries headroom rather than stopping where the app
// usually lands. appName gates a false match against some other :182x listener.
// The loopback address is swept as IPv4 first (what Elgato's own client dials)
// and IPv6 only after that fails — a socket refused there costs nothing, and a
// user whose Wave Link binds ::1 otherwise sees "not running" forever.
const WL_HOSTS = Object.freeze(['127.0.0.1', '::1']);
const WL_START_PORT = 1824;
const WL_PORT_SPAN = 12;
// The canonical name Wave Link has reported for years. Kept as the reference
// isWaveLinkApp() is pinned against, NOT as an equality test — see that helper.
const WL_APP_NAME = 'Elgato Wave Link';

const IDLE_MS = 60000;
const PING_MS = 30000;
const REQ_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 1500;

// ---- pure helpers (also unit-tested) ---------------------------------------

// The two sub-mixers every Wave Link channel carries: the local monitor mix and
// the stream mix. 'all' targets both (used by mute toggles).
function normSlider(mix) {
  const m = String(mix == null ? 'stream' : mix).trim().toLowerCase();
  return (m === 'local' || m === 'stream' || m === 'all') ? m : 'stream';
}

// Is this getApplicationInfo answer Wave Link? The gate exists to reject some
// OTHER listener that happens to sit on :182x, so it must not also reject Wave
// Link itself under a name Elgato changed: an exact === on 'Elgato Wave Link'
// makes a rename indistinguishable from "the app is not running", and the user
// can do nothing about either. Match the product name, ignoring spacing, case
// and any vendor prefix or version suffix around it.
function isWaveLinkApp(appName) {
  if (typeof appName !== 'string') return false;
  return appName.toLowerCase().replace(/[^a-z0-9]+/g, '').includes('wavelink');
}

function clampVolume(v) {
  // Reject null/empty explicitly — Number('') and Number(null) are 0, which would
  // silently turn an empty "set volume" field into a mute.
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Project a raw channel object (server field names) into the compact shape the
// dashboard/SSE needs — small, no icon blobs unless asked.
function compactChannel(ch) {
  if (!ch || typeof ch !== 'object') return null;
  const id = ch.mixId != null ? String(ch.mixId) : '';
  if (!id) return null;
  return {
    mixId: id,
    name: String(ch.mixerName == null ? id : ch.mixerName),
    bgColor: ch.bgColor ? String(ch.bgColor) : '',
    inputType: Number.isFinite(ch.inputType) ? ch.inputType : 0,
    localVolumeIn: Number.isFinite(ch.localVolumeIn) ? ch.localVolumeIn : 0,
    streamVolumeIn: Number.isFinite(ch.streamVolumeIn) ? ch.streamVolumeIn : 0,
    isLocalInMuted: !!ch.isLocalInMuted,
    isStreamInMuted: !!ch.isStreamInMuted,
    isAvailable: ch.isAvailable !== false,
  };
}

// ---- lazy connection --------------------------------------------------------

// getConfig: async () -> { enabled, port? }. Returns a client whose socket is
// shared, idle-closed, and (via watch) auto-reconnected.
function createWaveLink(getConfig, opts) {
  const WebSocketImpl = (opts && opts.WebSocketImpl) || DEFAULT_WS;
  let ws = null;
  let ready = null;            // Promise<void> resolved once a valid WL socket is up
  let idleTimer = null;
  let pingTimer = null;
  let retryTimer = null;
  let reconnectDelay = 2000;
  let reqId = 0;
  const pending = new Map();   // id -> { resolve, reject, timer }
  let goodPort = 0;            // last port that answered as Wave Link (tried first)
  let goodHost = '';           // and the loopback address it answered on
  let watching = false;
  let onChange = null;

  // Live state cache (kept fresh from seeds + pushed notifications).
  // `seeded` is what "do we know the mixer" means — NOT `inputs.size`. Wave Link
  // may push a partial inputMixerChanged the moment the socket opens, which
  // fills one entry with one field: inferring seededness from the map size then
  // skips the seed, so the test button reports one channel out of six and a
  // Deck key echoes undefined volumes back for the rest of the object. It also
  // resets on close, so a reconnect re-reads the mixer instead of serving the
  // previous session's cache.
  let seeded = false;
  const inputs = new Map();    // mixId -> raw channel object
  let output = null;           // { localVolumeOut, streamVolumeOut, isLocalOutMuted, isStreamOutMuted }
  let monitorMix = '';
  let switchState = '';
  let micConnected = false;

  function clearPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  function close() {
    if (!ws && !idleTimer && !pingTimer && !retryTimer && pending.size === 0) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    clearPing();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null; ready = null; seeded = false;
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('wl_closed')); });
    pending.clear();
  }

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = watching ? null : setTimeout(close, IDLE_MS);
  }

  function scheduleReconnect() {
    if (!watching || retryTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    retryTimer = setTimeout(() => { retryTimer = null; if (watching) startWatchConn(); }, delay);
  }

  // Raw JSON-RPC send over an already-open socket (used during port probing,
  // before `ws`/`ready` are committed).
  function rawSend(sock, method, params) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('wl_request_timeout')); }, REQ_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const frame = { jsonrpc: '2.0', id, method };
      if (params !== undefined) frame.params = params;
      try { sock.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  function handleMessage(raw) {
    const text = typeof raw === 'string' ? raw
      : Buffer.isBuffer(raw) ? raw.toString('utf8')
      : raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8') : '';
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id != null && pending.has(msg.id)) {          // response to one of our requests
      const p = pending.get(msg.id);
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error((msg.error && msg.error.message) || 'wl_request_failed'));
      else p.resolve(msg.result);
      bumpIdle();
      return;
    }
    if (typeof msg.method === 'string') applyNotification(msg.method, msg.params || {});
  }

  // Wave Link pushes state changes as JSON-RPC notifications (no id). Keep the
  // cache fresh and notify the watcher.
  function applyNotification(method, params) {
    if (method === 'inputMixerChanged') {
      const id = params.mixId != null ? String(params.mixId) : '';
      if (id) { inputs.set(id, Object.assign(inputs.get(id) || {}, params, { mixId: id })); notify(); }
    } else if (method === 'outputMixerChanged') {
      output = Object.assign(output || {}, params); notify();
    } else if (method === 'microphoneStateChanged') {
      micConnected = !!params.isMicrophoneConnected; notify();
    } else if (method === 'localMonitorOutputChanged') {
      monitorMix = params.monitorMix != null ? String(params.monitorMix) : monitorMix; notify();
    } else if (method === 'monitorSwitchOutputChanged') {
      switchState = params.switchState != null ? String(params.switchState) : switchState; notify();
    } else if (method === 'channelsChanged') {
      ingestChannels(params.channels); notify();
    }
  }

  function notify() { if (onChange) { try { onChange(); } catch (e) { /* ignore */ } } }

  function ingestChannels(list) {
    if (!Array.isArray(list)) return;
    inputs.clear();
    for (const ch of list) { if (ch && ch.mixId != null) inputs.set(String(ch.mixId), ch); }
  }

  // Open a single port and verify it's Wave Link (getApplicationInfo → appName).
  // Resolves the live socket, or rejects (caller tries the next port).
  function probePort(host, port) {
    return new Promise((resolve, reject) => {
      let sock, settled = false;
      const fail = (e) => { if (settled) return; settled = true; try { sock && sock.close(); } catch (x) {} reject(e || new Error('wl_probe_failed')); };
      const authority = host.includes(':') ? '[' + host + ']' : host;
      try { sock = new WebSocketImpl('ws://' + authority + ':' + port); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => fail(new Error('wl_probe_timeout')), PROBE_TIMEOUT_MS);
      sock.addEventListener('error', () => { clearTimeout(timer); fail(new Error('wl_connect_failed')); });
      sock.addEventListener('message', (ev) => handleMessage(ev.data));
      sock.addEventListener('open', () => {
        rawSend(sock, 'getApplicationInfo').then((info) => {
          clearTimeout(timer);
          if (settled) return;
          if (info && isWaveLinkApp(info.appName)) { settled = true; resolve(sock); }
          else fail(new Error('wl_wrong_app'));
        }, () => { clearTimeout(timer); fail(new Error('wl_no_appinfo')); });
      });
    });
  }

  // Which failure is worth reporting: a port that ANSWERED and was rejected
  // says far more than the 20 refused connections around it, and "could not
  // reach Wave Link" is the same sentence for both. Highest rank wins.
  const FAIL_RANK = { wl_connect_failed: 1, wl_probe_timeout: 2, wl_no_appinfo: 3, wl_wrong_app: 4 };

  // Try the last good address first, then sweep the range on IPv4 and, only if
  // that finds nothing, on IPv6. First valid socket wins.
  async function findSocket(preferredPort) {
    const ports = [];
    const first = Number(preferredPort) || goodPort;
    if (first) ports.push(first);
    for (let i = 0; i < WL_PORT_SPAN; i++) { const p = WL_START_PORT + i; if (!ports.includes(p)) ports.push(p); }
    const hosts = goodHost ? [goodHost].concat(WL_HOSTS.filter((h) => h !== goodHost)) : WL_HOSTS.slice();
    let bestErr = new Error('wl_not_found');
    let bestRank = 0;
    for (const host of hosts) {
      for (const port of ports) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential by design: stop at the first live port
          const sock = await probePort(host, port);
          goodPort = port; goodHost = host;
          return sock;
        } catch (e) {
          const rank = FAIL_RANK[(e && e.message) || ''] || 0;
          if (rank >= bestRank) { bestRank = rank; bestErr = e; }
        }
      }
    }
    throw bestErr;
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; if (err) { reject(err); close(); } else { reconnectDelay = 2000; bumpIdle(); resolve(); } };
      Promise.resolve().then(getConfig).then((cfg) => {
        if (settled) return;
        const c = cfg || {};
        if (c.enabled === false) { done(new Error('wl_disabled')); return; }
        findSocket(c.port).then((sock) => {
          if (settled) { try { sock.close(); } catch (e) {} return; }
          ws = sock;
          sock.addEventListener('close', () => { if (!settled) done(new Error('wl_closed')); else { close(); if (watching) scheduleReconnect(); } });
          sock.addEventListener('error', () => { if (!settled) done(new Error('wl_connect_failed')); });
          done();
        }, (e) => done(e instanceof Error ? e : new Error('wl_connect_failed')));
      }, (e) => done(e instanceof Error ? e : new Error('wl_config_failed')));
    });
    ready.catch(() => {});
    return ready;
  }

  function request(method, params) {
    return connect().then(() => new Promise((resolve, reject) => {
      const id = ++reqId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('wl_request_timeout')); }, REQ_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      bumpIdle();
      const frame = { jsonrpc: '2.0', id, method };
      if (params !== undefined) frame.params = params;
      try { ws.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    }));
  }

  // Seed the full mixer state once (no keepalive) — used by one-shot reads
  // (the editor channel picker), which then idle-close.
  async function seedState() {
    const [channels, monitoring, sw, mm, mic] = await Promise.all([
      request('getAllChannelInfo').catch(() => null),
      request('getMonitoringState').catch(() => null),
      request('getSwitchState').catch(() => null),
      request('getMonitorMixOutputList').catch(() => null),
      request('getMicrophoneState').catch(() => null),
    ]);
    ingestChannels(channels);
    if (monitoring && typeof monitoring === 'object') output = monitoring;
    if (sw && sw.switchState != null) switchState = String(sw.switchState);
    if (mm && mm.monitorMix != null) monitorMix = String(mm.monitorMix);
    if (mic) micConnected = !!mic.isMicrophoneConnected;
    seeded = true;
  }

  // Watch path: seed, then hold the socket open with a keepalive. Wave Link
  // pushes changes on its own (no subscribe call needed).
  async function seedAndHold() {
    await seedState();
    clearPing();
    pingTimer = setInterval(() => {
      request('getApplicationInfo').catch(() => { if (watching && ws) { try { ws.close(); } catch (e) {} } });
    }, PING_MS);
    notify();
  }

  function startWatchConn() {
    connect().then(seedAndHold).catch(() => scheduleReconnect());
  }

  // ---- set-commands (echo the whole object, change one field) ---------------

  // Push a cached input channel back with the fields the server expects. Only the
  // targeted volume/mute field(s) were mutated by the caller.
  function pushInput(ch, slider) {
    return request('setInputMixer', {
      mixId: ch.mixId,
      slider,
      localVolumeIn: ch.localVolumeIn,
      isLocalInMuted: !!ch.isLocalInMuted,
      streamVolumeIn: ch.streamVolumeIn,
      isStreamInMuted: !!ch.isStreamInMuted,
      filters: ch.filters || [],
      localMixFilterBypass: !!ch.localMixFilterBypass,
      streamMixFilterBypass: !!ch.streamMixFilterBypass,
    });
  }

  function pushOutput() {
    const o = output || {};
    return request('setOutputMixer', {
      localVolumeOut: o.localVolumeOut,
      isLocalOutMuted: !!o.isLocalOutMuted,
      streamVolumeOut: o.streamVolumeOut,
      isStreamOutMuted: !!o.isStreamOutMuted,
    });
  }

  // ---- public surface -------------------------------------------------------

  // Execute a validated Deck/SDK Wave Link action. Returns {ok} — never throws.
  //   wlInputVolume  { mixId, mix, value }  absolute 0..100
  //   wlInputMute    { mixId, mix }         toggle (mix: local|stream|all)
  //   wlOutputVolume { mix, value }
  //   wlOutputMute   { mix }                toggle
  //   wlSwitchMonitoring {}                 flip the monitor A/B switch
  //   wlSetMonitorMix { monitorMix }
  async function runAction(action) {
    try {
      if (!action || typeof action !== 'object') return { ok: false, error: 'bad_wl_action' };
      const type = action.type;
      if (type === 'wlInputVolume' || type === 'wlInputMute') {
        await ensureInputs();
        const id = String(action.mixId == null ? '' : action.mixId);
        const ch = inputs.get(id);
        if (!ch) return { ok: false, error: 'wl_unknown_channel' };
        const slider = normSlider(action.mix);
        if (type === 'wlInputVolume') {
          const vol = clampVolume(action.value);
          if (vol == null) return { ok: false, error: 'bad_volume' };
          if (slider === 'stream' || slider === 'all') ch.streamVolumeIn = vol;
          if (slider === 'local' || slider === 'all') ch.localVolumeIn = vol;
        } else {
          if (slider === 'stream' || slider === 'all') ch.isStreamInMuted = !ch.isStreamInMuted;
          if (slider === 'local' || slider === 'all') ch.isLocalInMuted = !ch.isLocalInMuted;
        }
        await pushInput(ch, slider);
        return { ok: true };
      }
      if (type === 'wlOutputVolume' || type === 'wlOutputMute') {
        await ensureOutput();
        if (!output) return { ok: false, error: 'wl_no_output' };
        const slider = normSlider(action.mix);
        if (type === 'wlOutputVolume') {
          const vol = clampVolume(action.value);
          if (vol == null) return { ok: false, error: 'bad_volume' };
          if (slider === 'stream' || slider === 'all') output.streamVolumeOut = vol;
          if (slider === 'local' || slider === 'all') output.localVolumeOut = vol;
        } else {
          if (slider === 'stream' || slider === 'all') output.isStreamOutMuted = !output.isStreamOutMuted;
          if (slider === 'local' || slider === 'all') output.isLocalOutMuted = !output.isLocalOutMuted;
        }
        await pushOutput();
        return { ok: true };
      }
      if (type === 'wlSwitchMonitoring') {
        const next = switchState === 'Stream Mix' ? 'Local Mix' : 'Stream Mix';
        const r = await request('switchMonitoring', { switchState: next }).catch(() => null);
        if (r && r.switchState != null) switchState = String(r.switchState);
        return { ok: true };
      }
      if (type === 'wlSetMonitorMix') {
        const mix = String(action.monitorMix == null ? '' : action.monitorMix).trim();
        if (!mix) return { ok: false, error: 'bad_monitor_mix' };
        const r = await request('setMonitorMixOutput', { monitorMix: mix }).catch(() => null);
        if (r && r.monitorMix != null) monitorMix = String(r.monitorMix);
        return { ok: true };
      }
      return { ok: false, error: 'bad_wl_action' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'wl_failed' };
    }
  }

  async function ensureInputs() { if (!seeded || !ws) { await connect(); if (!seeded) await seedState(); } }
  async function ensureOutput() { if (!seeded || !ws) { await connect(); if (!seeded) await seedState(); } }

  // Channel list for the editor's mixer picker: [{ value: mixId, label: name }].
  async function listChannels() {
    await ensureInputs();
    return Array.from(inputs.values())
      .map((ch) => ({ value: String(ch.mixId), label: String(ch.mixerName || ch.mixId) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // Compact snapshot for the SSE/SDK stream.
  function snapshot() {
    const list = [];
    for (const ch of inputs.values()) { const c = compactChannel(ch); if (c) list.push(c); }
    const o = output || {};
    return {
      connected: !!ws,
      inputs: list,
      output: {
        localVolumeOut: Number.isFinite(o.localVolumeOut) ? o.localVolumeOut : 0,
        streamVolumeOut: Number.isFinite(o.streamVolumeOut) ? o.streamVolumeOut : 0,
        isLocalOutMuted: !!o.isLocalOutMuted,
        isStreamOutMuted: !!o.isStreamOutMuted,
      },
      monitorMix,
      switchState,
      micConnected,
    };
  }

  function isConnected() { return !!ws; }

  async function test() {
    try { await connect(); if (!seeded) await seedState(); return { ok: true, count: inputs.size }; }
    catch (e) { return { ok: false, error: (e && e.message) || 'wl_connect_failed' }; }
  }

  function watch(cb) {
    onChange = cb; watching = true;
    startWatchConn();
    return () => {
      watching = false; onChange = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      clearPing();
      bumpIdle();
    };
  }

  return { runAction, listChannels, snapshot, isConnected, test, watch, close };
}

module.exports = {
  createWaveLink,
  normSlider,
  clampVolume,
  compactChannel,
  isWaveLinkApp,
  WL_START_PORT,
  WL_PORT_SPAN,
  WL_HOSTS,
  WL_APP_NAME,
};
