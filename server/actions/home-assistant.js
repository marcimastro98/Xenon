'use strict';
// Lazy Home Assistant WebSocket client + pure helpers. Mirrors the shape of
// actions/obs.js: connects on demand, authenticates with a long-lived access
// token, can fetch states / call a service, and — while a listener is attached
// (a dashboard tile is on screen) — keeps ONE live connection that pushes state
// changes via `subscribe_events`. Idle-closes when nobody is watching, so it
// costs nothing when the Smart Home tile isn't in use.
//
// Design invariants (see .claude/CLAUDE.md):
//   - The long-lived token stays server-side; only booleans/compact state reach
//     the browser (server projects the snapshot before broadcasting).
//   - Never throws out of the public surface — errors degrade to {ok:false}.
//   - No synchronous work on the event loop; all I/O is the async WS.
//
// Cameras are the ONE exception to "everything over the WS": the WS API can't
// stream image bytes, so a camera snapshot is a plain authenticated HTTP GET to
// HA's /api/camera_proxy/<entity> (haHttpGetBuffer, home-assistant-address.js). That single REST path covers
// EVERY camera HA supports — TAPO, Reolink, ONVIF, generic MJPEG, Ring… — because
// HA normalizes them all to the `camera` domain and does the RTSP transcoding
// itself, exposing a uniform JPEG snapshot.
const WebSocket = require('ws');
const {
  HA_WS_MAX_PAYLOAD, haWsUrl, haHttpOrigin, isConfigured,
} = require('./home-assistant-address.js');
require('../js/smart-home/smart-home-order.js'); // nothing is taken from it here, but it runs code when it loads

// ---- pure helpers (also unit-tested) ---------------------------------------

const {
  compactEntity, isEntityId, isCameraEntity, isMediaPlayerEntity,
} = require('./home-assistant-entity.js');

const { actionToServiceCall } = require('./home-assistant-service.js');

const {
  normalizeDashboards, normalizeHaCamAngles, normalizeHomeAssistant, haSameDestination,
  preserveHaToken, redactHaToken,
} = require('./home-assistant-settings.js');

// ---- lazy connection --------------------------------------------------------

const { makeReads } = require('./home-assistant-reads.js');

const { makeCalls } = require('./home-assistant-calls.js');

// getConfig: async () -> { baseUrl, token }. Returns a client whose socket is
// shared, idle-closed, and (via watch) auto-reconnected.
function createHomeAssistant(getConfig) {
  const haLink = {
    ws: null,
    ready: null,              // Promise<void> resolved once auth_ok
    idleTimer: null,
    pingTimer: null,
    retryTimer: null,
    reconnectDelay: 2000,     // exponential backoff, reset on a good connection
    msgId: 0,                 // per-connection incrementing command id
    watching: false,          // hold the socket open + reconnect while true
  };
  const pending = new Map();     // id -> { resolve, reject, timer }
  const states = new Map();      // entity_id -> HA state object (kept fresh)
  const haMaps = {
    areaMap: new Map(),       // entity_id -> area name
    deviceMap: new Map(),     // entity_id -> { id, name } of its physical device
  };
  let onChange = null;           // callback() debounced-ish notify on state change
  const IDLE_MS = 60000;
  const PING_MS = 30000;

  function clearPing() { if (haLink.pingTimer) { clearInterval(haLink.pingTimer); haLink.pingTimer = null; } }

  function close() {
    if (!haLink.ws && !haLink.idleTimer && pending.size === 0 && !haLink.pingTimer && !haLink.retryTimer) return;
    if (haLink.idleTimer) { clearTimeout(haLink.idleTimer); haLink.idleTimer = null; }
    // Clear any pending reconnect too — a public close() during the reconnect
    // window must not later resurrect the socket. (Callers that intend to keep
    // watching set watching=false first, e.g. the watch() stop fn.)
    if (haLink.retryTimer) { clearTimeout(haLink.retryTimer); haLink.retryTimer = null; }
    clearPing();
    if (haLink.ws) { try { haLink.ws.close(); } catch (e) { /* ignore */ } }
    haLink.ws = null; haLink.ready = null;
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('ha_closed')); });
    pending.clear();
  }

  function bumpIdle() {
    if (haLink.idleTimer) clearTimeout(haLink.idleTimer);
    // While watching we hold the connection open indefinitely (no idle-close).
    haLink.idleTimer = haLink.watching ? null : setTimeout(close, IDLE_MS);
  }

  function scheduleReconnect() {
    if (!haLink.watching || haLink.retryTimer) return;
    // Exponential backoff (2s→30s) instead of a flat 8s hammer: a Deck key watching
    // an offline HA shouldn't retry at a fixed rate all day. Reset on a good connect.
    const delay = haLink.reconnectDelay;
    haLink.reconnectDelay = Math.min(haLink.reconnectDelay * 2, 30000);
    haLink.retryTimer = setTimeout(() => { haLink.retryTimer = null; if (haLink.watching) startWatchConn(); }, delay);
  }

  function connect() {
    if (haLink.ready) return haLink.ready;
    // Assign `ready` synchronously so concurrent callers share one handshake.
    haLink.ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; if (err) { reject(err); close(); } else resolve(); };
      Promise.resolve().then(getConfig).then((cfg) => {
        if (settled) return;
        const c = cfg || {};
        const url = haWsUrl(c.baseUrl);
        const token = String(c.token || '').trim();
        if (!url || !token) { done(new Error('ha_not_configured')); return; }
        haLink.msgId = 0;
        let sock;
        // ws accepts 100 MB frames by default, all buffered in memory. HA's
        // largest legitimate replies (get_states on a big install) are a few
        // MB, so 8 MB leaves room while a broken or hostile peer can't make
        // the server allocate 100 MB per message.
        try { sock = new WebSocket(url, { maxPayload: HA_WS_MAX_PAYLOAD }); } catch (e) { done(e); return; }
        haLink.ws = sock;
        const timer = setTimeout(() => done(new Error('ha_timeout')), 8000);
        sock.on('error', () => { clearTimeout(timer); done(new Error('ha_connect_failed')); });
        sock.on('close', () => {
          clearTimeout(timer);
          if (!settled) done(new Error('ha_closed'));
          else { close(); if (haLink.watching) scheduleReconnect(); }
        });
        sock.on('message', (raw) => {
          let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
          if (!msg) return;
          if (msg.type === 'auth_required') {
            try { sock.send(JSON.stringify({ type: 'auth', access_token: token })); } catch (e) { done(new Error('ha_send_failed')); }
          } else if (msg.type === 'auth_ok') {
            clearTimeout(timer); haLink.reconnectDelay = 2000; bumpIdle(); done();
          } else if (msg.type === 'auth_invalid') {
            clearTimeout(timer); done(new Error('ha_auth_invalid'));
          } else if (msg.type === 'result' || msg.type === 'pong') {
            // HA answers a command with {type:'result'} and a `ping` with
            // {type:'pong'} — both carry the request id and settle its pending
            // entry (so the keepalive ping actually resolves instead of orphaning
            // until timeout, which is what lets it detect a dead socket).
            const p = pending.get(msg.id);
            if (p) {
              pending.delete(msg.id); clearTimeout(p.timer);
              if (msg.type === 'pong' || msg.success) p.resolve(msg.result);
              else p.reject(new Error((msg.error && msg.error.message) || 'ha_request_failed'));
            }
            bumpIdle();
          } else if (msg.type === 'event') {
            applyEvent(msg.event);
          }
        });
      }, (e) => done(e instanceof Error ? e : new Error('ha_config_failed')));
    });
    haLink.ready.catch(() => {});         // no unhandled rejection if nothing awaits yet
    return haLink.ready;
  }

  // `timeoutMs` is for the few slow reads (recorder history); everything else
  // keeps the 8 s a service call should never need more than.
  function request(type, extra, timeoutMs) {
    const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 8000;
    return connect().then(() => new Promise((resolve, reject) => {
      const id = ++haLink.msgId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('ha_request_timeout')); }, wait);
      pending.set(id, { resolve, reject, timer });
      bumpIdle();
      try { haLink.ws.send(JSON.stringify(Object.assign({ id, type }, extra || {}))); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    }));
  }

  // A state_changed event carries the full new_state; keep the local cache fresh
  // and notify the watcher. Unknown/entity-removed events drop the entity.
  function applyEvent(event) {
    const data = event && event.data;
    if (!data || !data.entity_id) return;
    if (data.new_state) states.set(data.entity_id, data.new_state);
    else states.delete(data.entity_id);
    if (onChange) { try { onChange(); } catch (e) { /* ignore */ } }
  }

  // Fetch the entity→area map once per connection (areas change rarely). Best
  // effort: if the registry commands aren't permitted, grouping falls back to
  // domain and nothing breaks.
  async function loadAreas() {
    try {
      const [areas, devices, entReg] = await Promise.all([
        request('config/area_registry/list').catch(() => []),
        request('config/device_registry/list').catch(() => []),
        request('config/entity_registry/list').catch(() => []),
      ]);
      const areaName = new Map((Array.isArray(areas) ? areas : []).map((a) => [a.area_id, a.name]));
      // device_id -> { name, area_id }; name_by_user (the user's rename) wins.
      const devInfo = new Map();
      for (const d of (Array.isArray(devices) ? devices : [])) {
        if (!d || !d.id) continue;
        devInfo.set(d.id, { name: d.name_by_user || d.name || '', area_id: d.area_id || null });
      }
      const nextArea = new Map();
      const nextDevice = new Map();
      for (const e of (Array.isArray(entReg) ? entReg : [])) {
        if (!e || !e.entity_id) continue;
        const dev = e.device_id ? devInfo.get(e.device_id) : null;
        // Entity area, falling back to the device's area (now actually resolved).
        const aid = e.area_id || (dev ? dev.area_id : null) || null;
        const nm = aid ? areaName.get(aid) : null;
        if (nm) nextArea.set(e.entity_id, nm);
        if (e.device_id) nextDevice.set(e.entity_id, { id: e.device_id, name: (dev && dev.name) || '' });
      }
      haMaps.areaMap = nextArea;
      haMaps.deviceMap = nextDevice;
    } catch (e) { /* keep whatever we had */ }
  }

  // Fetch the full state + area map once (events only fire on change). Used by the
  // one-shot reads (listEntities/test) which then idle-close normally — so this
  // deliberately does NOT subscribe or start the keepalive ping (that would bump
  // the idle timer forever and defeat the idle-close).
  async function seedStates() {
    const all = await request('get_states');
    states.clear();
    for (const st of (Array.isArray(all) ? all : [])) { if (st && st.entity_id) states.set(st.entity_id, st); }
    await loadAreas();
    if (onChange) { try { onChange(); } catch (e) { /* ignore */ } }
  }

  // Watch path: seed, then subscribe to live changes and hold the socket open with
  // a keepalive ping (only while watching — idle-close is disabled in this mode).
  async function seedAndSubscribe() {
    await seedStates();
    await request('subscribe_events', { event_type: 'state_changed' });
    clearPing();
    // Keepalive: a ping that fails (no pong before its timeout — e.g. a half-open
    // socket after a Wi-Fi/router drop that never raised 'close') force-closes the
    // socket so the 'close' handler fires and, while watching, reconnects.
    haLink.pingTimer = setInterval(() => {
      request('ping').catch(() => { if (haLink.watching && haLink.ws) { try { haLink.ws.close(); } catch (e) { /* ignore */ } } });
    }, PING_MS);
  }

  function startWatchConn() {
    connect().then(seedAndSubscribe).catch(() => scheduleReconnect());
  }

  // ---- public surface -------------------------------------------------------

  const {
    listEntities, cameras, cameraSnapshot, artworkKey, mediaArtwork, snapshot, hasStates, isConnected,
  } = makeReads({ getConfig, haLink, states, haMaps, connect, seedStates });



  const {
    runAction, callService, test, listDashboards,
  } = makeCalls({ states, connect, request, seedStates });

  // Keep a live connection and notify on any state change. Returns a stop fn.
  function watch(cb) {
    onChange = cb; haLink.watching = true;
    startWatchConn();
    return () => {
      haLink.watching = false; onChange = null;
      if (haLink.retryTimer) { clearTimeout(haLink.retryTimer); haLink.retryTimer = null; }
      bumpIdle();
    };
  }

  return { request, callService, runAction, listEntities, listDashboards, cameras, cameraSnapshot, artworkKey, mediaArtwork, snapshot, hasStates, isConnected, test, watch, close };
}

module.exports = {
  createHomeAssistant,
  haWsUrl,
  haHttpOrigin,
  isConfigured,
  isEntityId,
  isCameraEntity,
  isMediaPlayerEntity,
  normalizeDashboards,
  compactEntity,
  actionToServiceCall,
  normalizeHomeAssistant,
  normalizeHaCamAngles,
  haSameDestination,
  preserveHaToken,
  redactHaToken,
};
