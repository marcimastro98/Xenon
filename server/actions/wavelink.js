'use strict';
// Elgato Wave Link client — speaks BOTH dialects, presents ONE model.
//
// Wave Link 2 and Wave Link 3 are different protocols wearing the same name.
// Everything about reaching them differs, and each difference on its own is
// enough to make the integration look like "the app is not running" while the
// app is plainly running:
//
//                     Wave Link 2                  Wave Link 3
//   port              scan 1824..1835              PUBLISHED in ws-info.json
//                                                  (ephemeral: 50845, 57239, …)
//   host              127.0.0.1 or ::1             127.0.0.1 only (::1 → HTTP 400)
//   credential        none                         Origin: streamdeck://
//                                                  (without it: HTTP 401)
//   identifies as     appName / appVersion         name / version + interfaceRevision
//   reads             getAllChannelInfo            getChannels / getMixes /
//                                                  getInputDevices / getOutputDevices
//   writes            setInputMixer, WHOLE object  setChannel / setMix, PARTIAL object
//   levels            0..100 integers              0..1 floats
//   sub-mixes         fixed pair: local + stream   user-defined, named, any number
//   pushes            unsolicited, always on       only after setSubscription
//
// All of that was measured against real installs of 2.x and 3.2.9, not inferred:
// the reachability rules and the shapes come from tools/wavelink-probe.mjs, the
// method surface from the app's own assembly metadata.
//
// THE MODEL IS 3.x-SHAPED AND 2.x IS ADAPTED INTO IT — not the other way round.
// A 2.x mixer becomes a channel list with exactly two synthetic mixes, `local`
// and `stream`, which is what it always was in disguise. Everything above this
// module (the widget, the Deck actions, the SSE frame) therefore knows one
// vocabulary, and adding the third dialect one day means writing one adapter
// rather than auditing every consumer for `if (v2)`.
//
// Design invariants (.claude/CLAUDE.md):
//   - Never throws out of the public surface — errors degrade to {ok:false}.
//   - No new npm deps: reuses `ws` (already present via msedge-tts).
//   - Levels are 0..100 EVERYWHERE above the transport, so the Deck action
//     contract shipped in v4.1.0 keeps working byte for byte on both dialects.
//   - Channel artwork never travels over SSE (a base64 PNG per channel, per
//     frame); it is served on demand from the cache instead.

const DEFAULT_WS = (() => {
  try { return require('ws'); } catch (e) { return globalThis.WebSocket; }
})();

// Only the `ws` module lets us set an Origin on the handshake, and on 3.x the
// Origin IS the credential. Node's global WebSocket takes protocols in that
// argument position and would silently produce a 401 forever, so the capability
// is measured once here rather than discovered as a mystery failure.
const CAN_SET_ORIGIN = (() => {
  try { require('ws'); return true; } catch (e) { return false; }
})();

const {
  WL_HOSTS, WL_START_PORT, WL_PORT_SPAN, WL_APP_NAME, WL3_ORIGIN, WL3_METER_TYPES, IDLE_MS,
  REQ_TIMEOUT_MS, readPublishedPort,
} = require('./wavelink-ports.js');

// ── pure helpers (also unit-tested) ──────────────────────────────────────────

const {
  normSlider, isWaveLinkApp, appIdentity, clampVolume, pctFromUnit, unitFromPct, compactChannel,
  v2Mixes, adaptV2Channels, adaptV3Channels, adaptV3Mixes, adaptV3Outputs, mergeChannelPatch,
  resolveMixTargets,
} = require('./wavelink-shape.js');

const { makeSocket } = require('./wavelink-socket.js');

const { makePushes } = require('./wavelink-pushes.js');

const { makeIngest } = require('./wavelink-ingest.js');

const { makeSeed } = require('./wavelink-seed.js');

const { makeActions } = require('./wavelink-actions.js');

const { makeReads } = require('./wavelink-reads.js');

// ── lazy connection ──────────────────────────────────────────────────────────
//
// getConfig: async () -> { enabled, port? }. Returns a client whose socket is
// shared, idle-closed, and (via watch) auto-reconnected.
function createWaveLink(getConfig, opts) {
  const o = opts || {};
  const WebSocketImpl = o.WebSocketImpl || DEFAULT_WS;
  const canSetOrigin = o.canSetOrigin != null ? !!o.canSetOrigin : CAN_SET_ORIGIN;
  const readPublished = o.readPublishedPort || readPublishedPort;

  const wlLink = {
    ws: null,
    ready: null,            // Promise<void> resolved once a valid WL socket is up
    idleTimer: null,
    pingTimer: null,
    retryTimer: null,
    reconnectDelay: 2000,
    reqId: 0,
    goodPort: 0,            // last port that answered as Wave Link (tried first)
    goodHost: '',           // and the loopback address it answered on
    watching: false,
  };
  const pending = new Map();   // id -> { resolve, reject, timer }
  let onChange = null;

  const wlMixer = {
    // Live state. `seeded` is what "do we know the mixer" means — NOT the size of
    // the channel map. Wave Link pushes a partial change the moment the socket
    // opens, which fills one entry with one field: inferring seededness from the
    // map size then skips the seed, so the test button reports one channel out of
    // six and a Deck key writes against a record it never read.
    dialect: 0,             // 0 unknown, 2 or 3
    identity: null,
    seeded: false,
    wantMeters: false,      // set by watch({meters:true}) — see setMeters()
    mixes: [],              // normalised mixes
    outputs: { mainId: '', devices: [] },
    meterSubs: [],          // [{ id, type }] currently subscribed
    // 2.x-only monitor controls; absent on 3.x, and the UI hides them rather than
    // offering a button that cannot work.
    monitorMix: '',
    switchState: '',
    micConnected: false,
    outputRaw: null,        // 2.x output mixer object (echoed back on write)
  };
  // The raw records each dialect needs to keep: 2.x because a write echoes the
  // WHOLE object back, 3.x because a push is a PARTIAL patch to merge into.
  const v2Raw = new Map();
  const v3MixRaw = new Map();
  const channels = new Map();  // id -> normalised channel
  const icons = new Map();     // channel id -> base64 PNG (3.x, never broadcast)
  const meters = new Map();    // "kind:id" -> [left, right] 0..100

  const {
    ingestMeters, mergeV3Raw, reindexV2, ingestV2Channels, ingestV3Channels,
  } = makeIngest({ v2Raw, channels, icons, meters });

  function clearPing() { if (wlLink.pingTimer) { clearInterval(wlLink.pingTimer); wlLink.pingTimer = null; } }

  function close() {
    if (!wlLink.ws && !wlLink.idleTimer && !wlLink.pingTimer && !wlLink.retryTimer && pending.size === 0) return;
    if (wlLink.idleTimer) { clearTimeout(wlLink.idleTimer); wlLink.idleTimer = null; }
    if (wlLink.retryTimer) { clearTimeout(wlLink.retryTimer); wlLink.retryTimer = null; }
    clearPing();
    if (wlLink.ws) { try { wlLink.ws.close(); } catch (e) { /* ignore */ } }
    wlLink.ws = null; wlLink.ready = null; wlMixer.seeded = false; wlMixer.meterSubs = [];
    meters.clear();
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('wl_closed')); });
    pending.clear();
  }

  function bumpIdle() {
    if (wlLink.idleTimer) clearTimeout(wlLink.idleTimer);
    wlLink.idleTimer = wlLink.watching ? null : setTimeout(close, IDLE_MS);
  }

  function scheduleReconnect() {
    if (!wlLink.watching || wlLink.retryTimer) return;
    const delay = wlLink.reconnectDelay;
    wlLink.reconnectDelay = Math.min(wlLink.reconnectDelay * 2, 30000);
    wlLink.retryTimer = setTimeout(() => { wlLink.retryTimer = null; if (wlLink.watching) startWatchConn(); }, delay);
  }

  const {
    refreshChannels, refreshOutputs, seedState, setMeters, startWatchConn, ensureSeeded,
  } = makeSeed({ wlLink, wlMixer, v3MixRaw, channels, meters, ingestV2Channels, ingestV3Channels, clearPing, scheduleReconnect, notify, connect, request });

  const {
    applyNotification,
  } = makePushes({ wlMixer, v2Raw, v3MixRaw, channels, ingestMeters, notify, mergeV3Raw, reindexV2, ingestV2Channels, refreshChannels, refreshOutputs });

  const {
    findSocket,
  } = makeSocket({ WebSocketImpl, canSetOrigin, readPublished, wlLink, pending, bumpIdle, applyNotification });

  function notify() { if (onChange) { try { onChange(); } catch (e) { /* ignore */ } } }

  function connect() {
    if (wlLink.ready) return wlLink.ready;
    wlLink.ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; if (err) { reject(err); close(); } else { wlLink.reconnectDelay = 2000; bumpIdle(); resolve(); } };
      Promise.resolve().then(getConfig).then((cfg) => {
        if (settled) return;
        const c = cfg || {};
        if (c.enabled === false) { done(new Error('wl_disabled')); return; }
        findSocket(c.port).then((found) => {
          if (settled) { try { found.sock.close(); } catch (e) {} return; }
          wlLink.ws = found.sock;
          wlMixer.identity = found.identity;
          wlMixer.dialect = found.identity.dialect;
          found.sock.addEventListener('close', () => { if (!settled) done(new Error('wl_closed')); else { close(); if (wlLink.watching) scheduleReconnect(); } });
          found.sock.addEventListener('error', () => { if (!settled) done(new Error('wl_connect_failed')); });
          done();
        }, (e) => done(e instanceof Error ? e : new Error('wl_connect_failed')));
      }, (e) => done(e instanceof Error ? e : new Error('wl_config_failed')));
    });
    wlLink.ready.catch(() => {});
    return wlLink.ready;
  }

  function request(method, params) {
    return connect().then(() => new Promise((resolve, reject) => {
      const id = ++wlLink.reqId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('wl_request_timeout')); }, REQ_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      bumpIdle();
      const frame = { jsonrpc: '2.0', id, method };
      // 3.x expects the member to be PRESENT: Elgato's own client sends an
      // explicit null rather than omitting it.
      frame.params = params === undefined ? (wlMixer.dialect === 3 ? null : undefined) : params;
      if (frame.params === undefined) delete frame.params;
      try { wlLink.ws.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    }));
  }

  const {
    runAction,
  } = makeActions({ wlMixer, v2Raw, channels, reindexV2, refreshOutputs, ensureSeeded, request });

  // ── public surface ─────────────────────────────────────────────────────────

  const {
    listChannels, listMixes, iconFor, snapshot, isConnected, test,
  } = makeReads({ wlLink, wlMixer, channels, icons, meters, seedState, ensureSeeded, connect });

  // `meters` is opt-in per watcher: a dashboard with the tile on screen wants
  // them, a Deck key does not, and Wave Link should not be pushing at 2 Hz for
  // the latter.
  function watch(cb, watchOpts) {
    onChange = cb; wlLink.watching = true;
    wlMixer.wantMeters = !!(watchOpts && watchOpts.meters);
    startWatchConn();
    return () => {
      wlLink.watching = false; onChange = null;
      if (wlLink.retryTimer) { clearTimeout(wlLink.retryTimer); wlLink.retryTimer = null; }
      clearPing();
      // Turn the meters off at the source before letting the socket idle out.
      if (wlMixer.wantMeters && wlLink.ws) { setMeters(false).catch(() => {}); }
      wlMixer.wantMeters = false;
      bumpIdle();
    };
  }

  return { runAction, listChannels, listMixes, snapshot, isConnected, test, watch, close, iconFor, setMeters };
}

module.exports = {
  createWaveLink,
  readPublishedPort,
  normSlider,
  clampVolume,
  compactChannel,
  isWaveLinkApp,
  appIdentity,
  pctFromUnit,
  unitFromPct,
  adaptV2Channels,
  adaptV3Channels,
  adaptV3Mixes,
  adaptV3Outputs,
  mergeChannelPatch,
  resolveMixTargets,
  v2Mixes,
  WL_START_PORT,
  WL_PORT_SPAN,
  WL_HOSTS,
  WL_APP_NAME,
  WL3_ORIGIN,
  WL3_METER_TYPES,
};
