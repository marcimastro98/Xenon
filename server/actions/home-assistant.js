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
  HA_WS_MAX_PAYLOAD, haWsUrl, haHttpOrigin, haHttpGetBuffer, isConfigured,
} = require('./home-assistant-address.js');
require('../js/smart-home-order.js'); // nothing is taken from it here, but it runs code when it loads

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

// getConfig: async () -> { baseUrl, token }. Returns a client whose socket is
// shared, idle-closed, and (via watch) auto-reconnected.
function createHomeAssistant(getConfig) {
  let ws = null;
  let ready = null;              // Promise<void> resolved once auth_ok
  let idleTimer = null;
  let pingTimer = null;
  let retryTimer = null;
  let reconnectDelay = 2000;     // exponential backoff, reset on a good connection
  let msgId = 0;                 // per-connection incrementing command id
  const pending = new Map();     // id -> { resolve, reject, timer }
  const states = new Map();      // entity_id -> HA state object (kept fresh)
  let areaMap = new Map();       // entity_id -> area name
  let deviceMap = new Map();     // entity_id -> { id, name } of its physical device
  let watching = false;          // hold the socket open + reconnect while true
  let onChange = null;           // callback() debounced-ish notify on state change
  const IDLE_MS = 60000;
  const PING_MS = 30000;

  function clearPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  function close() {
    if (!ws && !idleTimer && pending.size === 0 && !pingTimer && !retryTimer) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // Clear any pending reconnect too — a public close() during the reconnect
    // window must not later resurrect the socket. (Callers that intend to keep
    // watching set watching=false first, e.g. the watch() stop fn.)
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    clearPing();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null; ready = null;
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('ha_closed')); });
    pending.clear();
  }

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    // While watching we hold the connection open indefinitely (no idle-close).
    idleTimer = watching ? null : setTimeout(close, IDLE_MS);
  }

  function scheduleReconnect() {
    if (!watching || retryTimer) return;
    // Exponential backoff (2s→30s) instead of a flat 8s hammer: a Deck key watching
    // an offline HA shouldn't retry at a fixed rate all day. Reset on a good connect.
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    retryTimer = setTimeout(() => { retryTimer = null; if (watching) startWatchConn(); }, delay);
  }

  function connect() {
    if (ready) return ready;
    // Assign `ready` synchronously so concurrent callers share one handshake.
    ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; if (err) { reject(err); close(); } else resolve(); };
      Promise.resolve().then(getConfig).then((cfg) => {
        if (settled) return;
        const c = cfg || {};
        const url = haWsUrl(c.baseUrl);
        const token = String(c.token || '').trim();
        if (!url || !token) { done(new Error('ha_not_configured')); return; }
        msgId = 0;
        let sock;
        // ws accepts 100 MB frames by default, all buffered in memory. HA's
        // largest legitimate replies (get_states on a big install) are a few
        // MB, so 8 MB leaves room while a broken or hostile peer can't make
        // the server allocate 100 MB per message.
        try { sock = new WebSocket(url, { maxPayload: HA_WS_MAX_PAYLOAD }); } catch (e) { done(e); return; }
        ws = sock;
        const timer = setTimeout(() => done(new Error('ha_timeout')), 8000);
        sock.on('error', () => { clearTimeout(timer); done(new Error('ha_connect_failed')); });
        sock.on('close', () => {
          clearTimeout(timer);
          if (!settled) done(new Error('ha_closed'));
          else { close(); if (watching) scheduleReconnect(); }
        });
        sock.on('message', (raw) => {
          let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
          if (!msg) return;
          if (msg.type === 'auth_required') {
            try { sock.send(JSON.stringify({ type: 'auth', access_token: token })); } catch (e) { done(new Error('ha_send_failed')); }
          } else if (msg.type === 'auth_ok') {
            clearTimeout(timer); reconnectDelay = 2000; bumpIdle(); done();
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
    ready.catch(() => {});         // no unhandled rejection if nothing awaits yet
    return ready;
  }

  // `timeoutMs` is for the few slow reads (recorder history); everything else
  // keeps the 8 s a service call should never need more than.
  function request(type, extra, timeoutMs) {
    const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 8000;
    return connect().then(() => new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('ha_request_timeout')); }, wait);
      pending.set(id, { resolve, reject, timer });
      bumpIdle();
      try { ws.send(JSON.stringify(Object.assign({ id, type }, extra || {}))); }
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
      areaMap = nextArea;
      deviceMap = nextDevice;
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
    pingTimer = setInterval(() => {
      request('ping').catch(() => { if (watching && ws) { try { ws.close(); } catch (e) { /* ignore */ } } });
    }, PING_MS);
  }

  function startWatchConn() {
    connect().then(seedAndSubscribe).catch(() => scheduleReconnect());
  }

  // ---- public surface -------------------------------------------------------

  // All entities as compact objects (for the Settings device picker). Ensures a
  // live connection + fresh cache first.
  async function listEntities() {
    if (!states.size || !ws) { await connect(); await seedStates(); }
    const out = [];
    for (const st of states.values()) { const c = compactEntity(st, (id) => areaMap.get(id), (id) => deviceMap.get(id)); if (c) out.push(c); }
    out.sort((a, b) => (a.area || '~').localeCompare(b.area || '~') || a.name.localeCompare(b.name));
    return out;
  }

  // Camera entities as compact { id, name, connected, area } for the Cameras tile.
  // Ensures a live connection + seeded cache first (mirrors listEntities), then
  // filters the camera domain. `connected` is false only when HA marks the camera
  // unavailable; the snapshot itself is the real liveness signal.
  //
  // TTL cache: the Cameras tile polls this every 30s — shorter than the 60s
  // idle-close — so without a cache every poll would revive the socket and re-seed
  // the FULL entity state forever (dial → seed → idle-close → re-dial churn).
  // Camera names/areas change rarely; serve the last list while the socket is
  // idle and only reconnect once the cache has gone stale.
  const CAMERAS_TTL_MS = 5 * 60 * 1000;
  let camerasCache = { list: null, at: 0 };
  async function cameras() {
    if (!states.size || !ws) {
      if (camerasCache.list && (Date.now() - camerasCache.at) < CAMERAS_TTL_MS) return camerasCache.list;
      await connect(); await seedStates();
    }
    const out = [];
    for (const st of states.values()) {
      if (!st || !st.entity_id || !isCameraEntity(st.entity_id)) continue;
      const a = st.attributes || {};
      out.push({
        id: st.entity_id,
        name: String(a.friendly_name || st.entity_id).slice(0, 80),
        connected: String(st.state == null ? '' : st.state) !== 'unavailable',
        area: areaMap.get(st.entity_id) || null,
      });
    }
    out.sort((a, b) => (a.area || '~').localeCompare(b.area || '~') || a.name.localeCompare(b.name));
    camerasCache = { list: out, at: Date.now() };
    return out;
  }

  // One JPEG snapshot for a camera entity (Buffer), via HA's REST camera_proxy —
  // the WS API can't stream image bytes. The long-lived token is read fresh from
  // config on each call and sent only as a Bearer header to the HA origin the user
  // typed; only the JPEG bytes leave here (streamed by the loopback proxy). Throws
  // on a bad entity, missing config, or a non-2xx response.
  async function cameraSnapshot(entityId) {
    if (!isCameraEntity(entityId)) throw new Error('ha_bad_camera');
    const cfg = (await Promise.resolve().then(getConfig)) || {};
    const origin = haHttpOrigin(cfg.baseUrl);
    const token = String(cfg.token || '').trim();
    if (!origin || !token) throw new Error('ha_not_configured');
    const url = origin + '/api/camera_proxy/' + encodeURIComponent(String(entityId).trim());
    return haHttpGetBuffer(url, token);
  }

  // What identifies a media player's current cover art: HA's entity_picture,
  // which carries a cache hash that changes with the artwork. '' = no artwork.
  // Kept in memory by the caller as a cache key only; it is never sent anywhere
  // (it can hold an access token).
  function artworkKey(entityId) {
    const st = isMediaPlayerEntity(entityId) ? states.get(String(entityId).trim()) : null;
    const pic = st && st.attributes && st.attributes.entity_picture;
    return typeof pic === 'string' ? pic : '';
  }

  // The cover art bytes (Buffer) through HA's REST media_player_proxy, which
  // fetches remote art server-side, so the URL is always the user's HA origin.
  // Same token rules as cameraSnapshot.
  async function mediaArtwork(entityId) {
    if (!isMediaPlayerEntity(entityId)) throw new Error('ha_bad_media_player');
    const cfg = (await Promise.resolve().then(getConfig)) || {};
    const origin = haHttpOrigin(cfg.baseUrl);
    const token = String(cfg.token || '').trim();
    if (!origin || !token) throw new Error('ha_not_configured');
    const url = origin + '/api/media_player_proxy/' + encodeURIComponent(String(entityId).trim());
    return haHttpGetBuffer(url, token);
  }

  // Compact snapshot for the given entity ids (tile/SSE). Missing ids are simply
  // absent. Called with the user's selection from settings.
  function snapshot(entityIds) {
    const ids = Array.isArray(entityIds) ? entityIds : [];
    const out = [];
    for (const id of ids) {
      const st = states.get(id);
      const c = st ? compactEntity(st, (x) => areaMap.get(x), (x) => deviceMap.get(x)) : null;
      if (c) out.push(c);
    }
    return out;
  }

  function hasStates() { return states.size > 0; }
  // Whether a live socket is currently open (not merely whether we have a cached
  // snapshot) — so a state read after an idle-close reports connected:false rather
  // than showing stale values as if live.
  function isConnected() { return !!ws; }

  // Execute a validated Deck HA action. Returns {ok} — never throws.
  async function runAction(action) {
    const id = action && String(action.entity == null ? '' : action.entity).trim();
    // The entity's own lists vet a chosen source or mode; a key pressed before
    // anything is cached (no tile watching) seeds the states once first. Only an
    // empty cache does: an id HA does not know must not re-seed on every press.
    if (id && !states.size) { try { await connect(); await seedStates(); } catch (e) { /* the call below says why */ } }
    const call = actionToServiceCall(action, id ? states.get(id) : null);
    if (!call) return { ok: false, error: 'bad_ha_action' };
    return callService(call.domain, call.service, call.target, call.data);
  }

  async function callService(domain, service, target, data) {
    if (!/^[a-z_]+$/.test(String(domain)) || !/^[a-z0-9_]+$/.test(String(service))) return { ok: false, error: 'bad_service' };
    try {
      const extra = { domain, service, service_data: data || {} };
      if (target && target.entity_id && isEntityId(target.entity_id)) extra.target = { entity_id: target.entity_id };
      await request('call_service', extra);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'ha_call_failed' };
    }
  }

  // Verify config by opening a connection and seeding once. Returns a compact
  // status used by the Settings "Connect" button.
  async function test() {
    try {
      await connect();
      if (!states.size) await seedStates();
      return { ok: true, count: states.size };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'ha_connect_failed' };
    }
  }

  // The dashboards for Settings. A failed connection throws (the caller says
  // so); a token that may not list them gets the Overview alone.
  async function listDashboards() {
    await connect();
    const raw = await request('lovelace/dashboards/list').catch(() => []);
    return normalizeDashboards(raw);
  }

  // Keep a live connection and notify on any state change. Returns a stop fn.
  function watch(cb) {
    onChange = cb; watching = true;
    startWatchConn();
    return () => {
      watching = false; onChange = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
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
