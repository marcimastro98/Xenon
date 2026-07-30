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

const fsp = require('fs').promises;
const path = require('path');

// ── Wave Link 2 ──────────────────────────────────────────────────────────────
// Wave Link 2 picks the first free port from a small range, so the sweep carries
// headroom. IPv4 first (what Elgato's own client dialled), IPv6 only after that
// fails — a refused socket costs nothing, and a user whose Wave Link bound ::1
// would otherwise see "not running" forever.
const WL_HOSTS = Object.freeze(['127.0.0.1', '::1']);
const WL_START_PORT = 1824;
const WL_PORT_SPAN = 12;
// The canonical name Wave Link has reported for years. Kept as the reference
// isWaveLinkApp() is pinned against, NOT as an equality test — see that helper.
const WL_APP_NAME = 'Elgato Wave Link';

// ── Wave Link 3 ──────────────────────────────────────────────────────────────
// The app is an MSIX package and writes its port into LocalState. There is no
// range to scan: the number is ephemeral and differs per launch, so this file
// is the only reliable answer.
const WL3_ORIGIN = 'streamdeck://';
const WL3_PACKAGE_RE = /^Elgato\.WaveLink_/i;
const WL3_PORT_FILE = 'ws-info.json';
// Level meters are per subscription and the server accepts exactly these two
// kinds (output/input were refused against ids of their own kind).
const WL3_METER_TYPES = Object.freeze(['channel', 'mix']);

const IDLE_MS = 60000;
const PING_MS = 30000;
const REQ_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 1500;

// ── pure helpers (also unit-tested) ──────────────────────────────────────────

// The legacy sub-mix selector: the two sliders Wave Link 2 keeps per channel.
// 'all' targets both (used by mute toggles). Deliberately narrow — a 3.x mix id
// is NOT run through this, see resolveMixTargets().
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

// Wave Link 3 renamed the identity fields (appName/appVersion → name/version).
// Reading only the 2.x spelling meant a perfectly connected 3.x server reported
// `undefined` and was rejected as "not Wave Link" — a correct connection thrown
// away at the last step. Accept either, and let the caller ask which dialect.
function appIdentity(info) {
  const i = info && typeof info === 'object' ? info : {};
  const name = typeof i.name === 'string' ? i.name : (typeof i.appName === 'string' ? i.appName : '');
  const version = typeof i.version === 'string' ? i.version : (typeof i.appVersion === 'string' ? i.appVersion : '');
  const revision = Number.isFinite(i.interfaceRevision) ? i.interfaceRevision : 0;
  // interfaceRevision only exists on 3.x; the 2.x-only field names are the
  // fallback signal, so a future 4.x that keeps `name` still reads as modern.
  const dialect = (revision >= 2 || typeof i.name === 'string') ? 3 : 2;
  return { name, version, revision, dialect, isWaveLink: isWaveLinkApp(name) };
}

function clampVolume(v) {
  // Reject null/empty explicitly — Number('') and Number(null) are 0, which would
  // silently turn an empty "set volume" field into a mute.
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 3.x carries levels as 0..1 floats; everything above the transport speaks
// 0..100 so the Deck action contract is dialect-independent. Rounding on the way
// up and NOT on the way down keeps a fader from drifting: 63 → 0.63 → 63.
function pctFromUnit(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}
function unitFromPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n / 100));
}

// A meter reading, already a percentage on the wire. Kept separate from
// pctFromUnit so the two scales cannot be confused at a call site.
function meterPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Project a raw 2.x channel (server field names) into the compact shape the
// dashboard needs — small, no icon blobs.
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

// The two synthetic mixes a 2.x mixer has always had, named so the UI can show
// them the same way it shows a 3.x user's own mixes.
const V2_MIX_LOCAL = 'local';
const V2_MIX_STREAM = 'stream';
function v2Mixes() {
  return [
    { id: V2_MIX_LOCAL, name: 'Local', level: 0, muted: false, icon: 'headphones' },
    { id: V2_MIX_STREAM, name: 'Stream', level: 0, muted: false, icon: 'stream' },
  ];
}

// 2.x channels → the normalised model.
function adaptV2Channels(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const c = compactChannel(item);
    if (!c) continue;
    out.push({
      id: c.mixId,
      name: c.name,
      kind: 'hardware',
      available: c.isAvailable,
      // 2.x has no per-channel master, only the two sub-mixes. Reporting the
      // stream value as a master would give the widget a fader that writes
      // nowhere, so the master is explicitly absent.
      level: null,
      muted: null,
      mixes: [
        { id: V2_MIX_LOCAL, level: c.localVolumeIn, muted: c.isLocalInMuted },
        { id: V2_MIX_STREAM, level: c.streamVolumeIn, muted: c.isStreamInMuted },
      ],
      effects: [],
      hasIcon: false,
    });
  }
  return out;
}

// 3.x channels → the normalised model. `image.imgData` is deliberately dropped:
// it is a base64 PNG per channel and this object is broadcast over SSE. Whether
// one EXISTS is kept, so the widget can ask for it once by URL.
function adaptV3Channels(raw) {
  const out = [];
  for (const ch of Array.isArray(raw) ? raw : []) {
    if (!ch || typeof ch !== 'object' || ch.id == null) continue;
    const mixes = [];
    for (const m of Array.isArray(ch.mixes) ? ch.mixes : []) {
      if (!m || m.id == null) continue;
      mixes.push({ id: String(m.id), level: pctFromUnit(m.level), muted: !!m.isMuted });
    }
    const effects = [];
    for (const e of Array.isArray(ch.effects) ? ch.effects : []) {
      if (!e || e.id == null) continue;
      effects.push({ id: String(e.id), name: String(e.name == null ? e.id : e.name), enabled: !!e.isEnabled });
    }
    out.push({
      id: String(ch.id),
      name: String(ch.name == null ? ch.id : ch.name),
      kind: String(ch.type || '').toLowerCase() === 'software' ? 'software' : 'hardware',
      available: true,
      level: pctFromUnit(ch.level),
      muted: !!ch.isMuted,
      mixes,
      effects,
      hasIcon: !!(ch.image && typeof ch.image.imgData === 'string' && ch.image.imgData.length > 0),
    });
  }
  return out;
}

function adaptV3Mixes(raw) {
  const out = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || m.id == null) continue;
    out.push({
      id: String(m.id),
      name: String(m.name == null ? m.id : m.name),
      level: pctFromUnit(m.level),
      muted: !!m.isMuted,
      icon: m.image && typeof m.image.name === 'string' ? m.image.name : '',
    });
  }
  return out;
}

function adaptV3Outputs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const devices = [];
  for (const d of Array.isArray(r.outputDevices) ? r.outputDevices : []) {
    if (!d || d.id == null) continue;
    const outs = [];
    for (const o of Array.isArray(d.outputs) ? d.outputs : []) {
      if (!o || o.id == null) continue;
      outs.push({ id: String(o.id), name: String(o.name == null ? o.id : o.name), level: pctFromUnit(o.level), muted: !!o.isMuted, mixId: String(o.mixId || '') });
    }
    devices.push({ id: String(d.id), name: String(d.name == null ? d.id : d.name), kind: String(d.deviceType || ''), outputs: outs });
  }
  // The main output can name a device the list does not contain — measured on a
  // real 3.2.9, where mainOutput pointed at an id none of the four listed
  // devices carried. So BOTH identifiers travel: a consumer that highlights the
  // active device has to be able to match on either, and has to accept that
  // sometimes neither matches rather than showing a row with nothing lit and no
  // explanation.
  const mainId = r.mainOutput && r.mainOutput.outputDeviceId != null ? String(r.mainOutput.outputDeviceId) : '';
  const mainOutputId = r.mainOutput && r.mainOutput.outputId != null ? String(r.mainOutput.outputId) : '';
  const listed = devices.some((d) => d.id === mainId || d.outputs.some((o) => o.id === mainOutputId));
  return { mainId, mainOutputId, mainListed: listed, devices };
}

// 3.x notifications carry ONLY the fields that changed — `channelChanged` for a
// volume move arrives as {id, name, type, level} with no mixes and no effects.
// Replacing the cached record with that patch silently deletes the rest of the
// channel, which reads on screen as a mixer that loses its faders whenever you
// touch one. Merge, and merge the nested mix list BY ID for the same reason.
function mergeChannelPatch(prev, patch) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = Object.assign({}, base);
  for (const k of Object.keys(p)) {
    if (k === 'mixes') continue;
    if (p[k] !== undefined) next[k] = p[k];
  }
  if (Array.isArray(p.mixes)) {
    const byId = new Map((Array.isArray(base.mixes) ? base.mixes : []).map((m) => [String(m.id), m]));
    for (const m of p.mixes) {
      if (!m || m.id == null) continue;
      const id = String(m.id);
      byId.set(id, Object.assign({}, byId.get(id) || { id }, m));
    }
    next.mixes = Array.from(byId.values());
  }
  return next;
}

// Which mix ids does a Deck action mean? The action contract predates 3.x, where
// `mix` could only be 'local' | 'stream' | 'all'. On 3.x the user's mixes are
// named and there can be any number, so those three words are resolved BY
// POSITION (first mix is the personal/local one, second is the stream one) and
// anything else is taken as an explicit mix id.
//
// An id that no longer exists returns nothing rather than falling back to a
// default: a Deck key pointing at a deleted mix must fail visibly, not quietly
// move a fader the user did not mean.
function resolveMixTargets(mixes, selector) {
  const list = (Array.isArray(mixes) ? mixes : []).map((m) => String(m && m.id != null ? m.id : '')).filter(Boolean);
  if (!list.length) return [];
  const raw = selector == null ? 'stream' : String(selector).trim();
  const lower = raw.toLowerCase();
  if (lower === 'all') return list.slice();
  if (lower === 'local') return [list[0]];
  if (lower === 'stream') return [list.length > 1 ? list[1] : list[0]];
  return list.includes(raw) ? [raw] : [];
}

// ── lazy connection ──────────────────────────────────────────────────────────

// getConfig: async () -> { enabled, port? }. Returns a client whose socket is
// shared, idle-closed, and (via watch) auto-reconnected.
function createWaveLink(getConfig, opts) {
  const o = opts || {};
  const WebSocketImpl = o.WebSocketImpl || DEFAULT_WS;
  const canSetOrigin = o.canSetOrigin != null ? !!o.canSetOrigin : CAN_SET_ORIGIN;
  const readPublished = o.readPublishedPort || readPublishedPort;

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

  // Live state. `seeded` is what "do we know the mixer" means — NOT the size of
  // the channel map. Wave Link pushes a partial change the moment the socket
  // opens, which fills one entry with one field: inferring seededness from the
  // map size then skips the seed, so the test button reports one channel out of
  // six and a Deck key writes against a record it never read.
  let dialect = 0;             // 0 unknown, 2 or 3
  let identity = null;
  let seeded = false;
  let wantMeters = false;      // set by watch({meters:true}) — see setMeters()
  // The raw records each dialect needs to keep: 2.x because a write echoes the
  // WHOLE object back, 3.x because a push is a PARTIAL patch to merge into.
  const v2Raw = new Map();
  const v3Raw = new Map();
  const v3MixRaw = new Map();
  const channels = new Map();  // id -> normalised channel
  let mixes = [];              // normalised mixes
  let outputs = { mainId: '', devices: [] };
  const icons = new Map();     // channel id -> base64 PNG (3.x, never broadcast)
  const meters = new Map();    // "kind:id" -> [left, right] 0..100
  let meterSubs = [];          // [{ id, type }] currently subscribed
  // 2.x-only monitor controls; absent on 3.x, and the UI hides them rather than
  // offering a button that cannot work.
  let monitorMix = '';
  let switchState = '';
  let micConnected = false;
  let outputRaw = null;        // 2.x output mixer object (echoed back on write)

  function clearPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  function close() {
    if (!ws && !idleTimer && !pingTimer && !retryTimer && pending.size === 0) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    clearPing();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null; ready = null; seeded = false; meterSubs = [];
    meters.clear();
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

  // Raw JSON-RPC send over an already-open socket (used during discovery, before
  // `ws`/`ready` are committed).
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

  function applyNotification(method, params) {
    if (dialect === 3) return applyV3Notification(method, params);
    return applyV2Notification(method, params);
  }

  function applyV2Notification(method, params) {
    if (method === 'inputMixerChanged') {
      const id = params.mixId != null ? String(params.mixId) : '';
      if (!id) return;
      // Keep the RAW 2.x record: a write echoes the WHOLE object back, so the
      // cache has to carry every field, not just the normalised subset.
      v2Raw.set(id, Object.assign(v2Raw.get(id) || {}, params, { mixId: id }));
      reindexV2();
      notify();
    } else if (method === 'outputMixerChanged') {
      outputRaw = Object.assign(outputRaw || {}, params); notify();
    } else if (method === 'microphoneStateChanged') {
      micConnected = !!params.isMicrophoneConnected; notify();
    } else if (method === 'localMonitorOutputChanged') {
      monitorMix = params.monitorMix != null ? String(params.monitorMix) : monitorMix; notify();
    } else if (method === 'monitorSwitchOutputChanged') {
      switchState = params.switchState != null ? String(params.switchState) : switchState; notify();
    } else if (method === 'channelsChanged') {
      ingestV2Channels(params.channels); notify();
    }
  }

  function applyV3Notification(method, params) {
    if (method === 'channelChanged') {
      const id = params.id != null ? String(params.id) : '';
      if (!id) return;
      const [patched] = adaptV3Channels([mergeV3Raw(id, params)]);
      if (patched) channels.set(id, patched);
      notify();
    } else if (method === 'channelsChanged') {
      // A structural change (added/removed/renamed) — re-read rather than patch.
      refreshChannels().catch(() => {});
    } else if (method === 'mixChanged') {
      const id = params.id != null ? String(params.id) : '';
      if (!id) return;
      const next = mixes.slice();
      const at = next.findIndex((m) => m.id === id);
      const [adapted] = adaptV3Mixes([Object.assign({}, at >= 0 ? v3MixRaw.get(id) || {} : {}, params)]);
      if (adapted) { if (at >= 0) next[at] = adapted; else next.push(adapted); }
      v3MixRaw.set(id, Object.assign(v3MixRaw.get(id) || {}, params));
      mixes = next;
      notify();
    } else if (method === 'outputDeviceChanged') {
      refreshOutputs().catch(() => {});
    } else if (method === 'levelMeterChanged') {
      ingestMeters(params);
      notify();
    }
  }

  // Meters arrive bucketed by kind. Anything we did not subscribe to is ignored
  // rather than stored: an unbounded map keyed by whatever the server names is
  // exactly the growth the codebase avoids elsewhere.
  // The wire field is named `levelLeftPercentage`, so it is read as 0..100 and
  // clamped. Every frame observed on a live 3.2.9 carried 0 (nothing was routed
  // into Wave Link on that machine), so the SCALE is the one thing here taken
  // from the field's name rather than from a measurement: if a future build
  // turns out to send 0..1, meterPct is the single line to change.
  function ingestMeters(params) {
    const p = params && typeof params === 'object' ? params : {};
    for (const [bucket, kind] of [['channels', 'channel'], ['mixes', 'mix']]) {
      for (const m of Array.isArray(p[bucket]) ? p[bucket] : []) {
        if (!m || m.id == null) continue;
        meters.set(kind + ':' + String(m.id), [meterPct(m.levelLeftPercentage), meterPct(m.levelRightPercentage)]);
      }
    }
  }

  function notify() { if (onChange) { try { onChange(); } catch (e) { /* ignore */ } } }

  function mergeV3Raw(id, patch) {
    const merged = mergeChannelPatch(v3Raw.get(id) || { id }, patch);
    v3Raw.set(id, merged);
    return merged;
  }

  function reindexV2() {
    channels.clear();
    for (const ch of adaptV2Channels(Array.from(v2Raw.values()))) channels.set(ch.id, ch);
  }

  function ingestV2Channels(list) {
    if (!Array.isArray(list)) return;
    v2Raw.clear();
    for (const ch of list) { if (ch && ch.mixId != null) v2Raw.set(String(ch.mixId), ch); }
    reindexV2();
  }

  function ingestV3Channels(list) {
    if (!Array.isArray(list)) return;
    v3Raw.clear(); channels.clear(); icons.clear();
    for (const ch of list) {
      if (!ch || ch.id == null) continue;
      const id = String(ch.id);
      v3Raw.set(id, ch);
      if (ch.image && typeof ch.image.imgData === 'string' && ch.image.imgData) icons.set(id, ch.image.imgData);
    }
    for (const ch of adaptV3Channels(list)) channels.set(ch.id, ch);
  }

  // ── discovery ──────────────────────────────────────────────────────────────

  function socketFor(host, port, origin) {
    const authority = host.includes(':') ? '[' + host + ']' : host;
    const url = 'ws://' + authority + ':' + port;
    return origin ? new WebSocketImpl(url, { origin }) : new WebSocketImpl(url);
  }

  // Open one endpoint and ask who it is. Resolves { sock, identity }, or rejects
  // so the caller can try the next candidate.
  function probeEndpoint(host, port, origin) {
    return new Promise((resolve, reject) => {
      let sock, settled = false;
      const fail = (e) => { if (settled) return; settled = true; try { sock && sock.close(); } catch (x) {} reject(e || new Error('wl_probe_failed')); };
      try { sock = socketFor(host, port, origin); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => fail(new Error('wl_probe_timeout')), PROBE_TIMEOUT_MS);
      sock.addEventListener('error', () => { clearTimeout(timer); fail(new Error('wl_connect_failed')); });
      sock.addEventListener('message', (ev) => handleMessage(ev.data));
      sock.addEventListener('open', () => {
        rawSend(sock, 'getApplicationInfo').then((info) => {
          clearTimeout(timer);
          if (settled) return;
          const ident = appIdentity(info);
          if (ident.isWaveLink) { settled = true; resolve({ sock, identity: ident }); }
          else fail(new Error('wl_wrong_app'));
        }, () => { clearTimeout(timer); fail(new Error('wl_no_appinfo')); });
      });
    });
  }

  // Which failure is worth reporting: a port that ANSWERED and was rejected says
  // far more than the 20 refused connections around it, and "could not reach
  // Wave Link" is the same sentence for both. Highest rank wins.
  const FAIL_RANK = { wl_connect_failed: 1, wl_probe_timeout: 2, wl_no_appinfo: 3, wl_wrong_app: 4, wl_no_origin: 5 };

  // Wave Link 3 first (it is what a new install gets, and its answer is exact),
  // then the 2.x sweep. Returns { sock, identity }.
  async function findSocket(preferredPort) {
    let bestErr = new Error('wl_not_found');
    let bestRank = 0;
    const note = (e) => {
      const rank = FAIL_RANK[(e && e.message) || ''] || 0;
      if (rank >= bestRank) { bestRank = rank; bestErr = e; }
    };

    const published = await readPublished().catch(() => null);
    if (published && published.port) {
      if (!canSetOrigin) {
        // Saying this out loud matters: without `ws` the 3.x door cannot be
        // opened at all, and every symptom looks like "Wave Link is not running".
        note(new Error('wl_no_origin'));
      } else {
        // 3.x refuses ::1 with HTTP 400 — it is 127.0.0.1 only.
        try { return await probeEndpoint('127.0.0.1', published.port, WL3_ORIGIN); }
        catch (e) { note(e); }
      }
    }

    const ports = [];
    const first = Number(preferredPort) || goodPort;
    if (first) ports.push(first);
    for (let i = 0; i < WL_PORT_SPAN; i++) { const p = WL_START_PORT + i; if (!ports.includes(p)) ports.push(p); }
    const hosts = goodHost ? [goodHost].concat(WL_HOSTS.filter((h) => h !== goodHost)) : WL_HOSTS.slice();
    for (const host of hosts) {
      for (const port of ports) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential by design: stop at the first live port
          const found = await probeEndpoint(host, port, '');
          goodPort = port; goodHost = host;
          return found;
        } catch (e) { note(e); }
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
        findSocket(c.port).then((found) => {
          if (settled) { try { found.sock.close(); } catch (e) {} return; }
          ws = found.sock;
          identity = found.identity;
          dialect = found.identity.dialect;
          found.sock.addEventListener('close', () => { if (!settled) done(new Error('wl_closed')); else { close(); if (watching) scheduleReconnect(); } });
          found.sock.addEventListener('error', () => { if (!settled) done(new Error('wl_connect_failed')); });
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
      // 3.x expects the member to be PRESENT: Elgato's own client sends an
      // explicit null rather than omitting it.
      frame.params = params === undefined ? (dialect === 3 ? null : undefined) : params;
      if (frame.params === undefined) delete frame.params;
      try { ws.send(JSON.stringify(frame)); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    }));
  }

  // ── seeding ────────────────────────────────────────────────────────────────

  async function refreshChannels() {
    if (dialect === 3) {
      const r = await request('getChannels').catch(() => null);
      ingestV3Channels(r && r.channels);
    } else {
      const r = await request('getAllChannelInfo').catch(() => null);
      ingestV2Channels(r);
    }
  }

  async function refreshOutputs() {
    if (dialect !== 3) return;
    const r = await request('getOutputDevices').catch(() => null);
    outputs = adaptV3Outputs(r);
  }

  async function seedState() {
    if (dialect === 3) {
      const [chans, mixList, outs] = await Promise.all([
        request('getChannels').catch(() => null),
        request('getMixes').catch(() => null),
        request('getOutputDevices').catch(() => null),
      ]);
      ingestV3Channels(chans && chans.channels);
      v3MixRaw.clear();
      for (const m of (mixList && Array.isArray(mixList.mixes)) ? mixList.mixes : []) if (m && m.id != null) v3MixRaw.set(String(m.id), m);
      mixes = adaptV3Mixes(mixList && mixList.mixes);
      outputs = adaptV3Outputs(outs);
    } else {
      const [chans, monitoring, sw, mm, mic] = await Promise.all([
        request('getAllChannelInfo').catch(() => null),
        request('getMonitoringState').catch(() => null),
        request('getSwitchState').catch(() => null),
        request('getMonitorMixOutputList').catch(() => null),
        request('getMicrophoneState').catch(() => null),
      ]);
      ingestV2Channels(chans);
      mixes = v2Mixes();
      if (monitoring && typeof monitoring === 'object') outputRaw = monitoring;
      if (sw && sw.switchState != null) switchState = String(sw.switchState);
      if (mm && mm.monitorMix != null) monitorMix = String(mm.monitorMix);
      if (mic) micConnected = !!mic.isMicrophoneConnected;
      // The 2.x output mixer is the master of the two synthetic mixes.
      if (outputRaw) {
        mixes[0].level = Number.isFinite(outputRaw.localVolumeOut) ? outputRaw.localVolumeOut : 0;
        mixes[0].muted = !!outputRaw.isLocalOutMuted;
        mixes[1].level = Number.isFinite(outputRaw.streamVolumeOut) ? outputRaw.streamVolumeOut : 0;
        mixes[1].muted = !!outputRaw.isStreamOutMuted;
      }
    }
    seeded = true;
  }

  // ── level meters (3.x only) ────────────────────────────────────────────────
  //
  // Meters are OFF until asked for, one subscription per target, and they are
  // turned off again on teardown. Leaving them on would keep Wave Link pushing
  // at a dashboard nobody is looking at, which is the same "periodic work with
  // no listener" this codebase gates everywhere else.
  async function setMeters(on) {
    if (dialect !== 3) return { ok: true };
    const wanted = [];
    if (on) {
      for (const ch of channels.values()) wanted.push({ id: ch.id, type: 'channel' });
      for (const m of mixes) wanted.push({ id: m.id, type: 'mix' });
    }
    const key = (s) => s.type + ':' + s.id;
    const have = new Set(meterSubs.map(key));
    const want = new Set(wanted.map(key));
    for (const s of meterSubs) {
      if (want.has(key(s))) continue;
      // eslint-disable-next-line no-await-in-loop -- sequential by design: one small call each
      await request('setSubscription', { levelMeterChanged: { id: s.id, subId: '', type: s.type, isEnabled: false } }).catch(() => {});
      meters.delete(key(s));
    }
    for (const s of wanted) {
      if (have.has(key(s))) continue;
      // eslint-disable-next-line no-await-in-loop -- same
      await request('setSubscription', { levelMeterChanged: { id: s.id, subId: '', type: s.type, isEnabled: true } }).catch(() => {});
    }
    meterSubs = wanted;
    return { ok: true };
  }

  async function seedAndHold() {
    await seedState();
    clearPing();
    pingTimer = setInterval(() => {
      request('getApplicationInfo').catch(() => { if (watching && ws) { try { ws.close(); } catch (e) {} } });
    }, PING_MS);
    if (wantMeters) await setMeters(true).catch(() => {});
    notify();
  }

  function startWatchConn() {
    connect().then(seedAndHold).catch(() => scheduleReconnect());
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  // 2.x replaces the WHOLE input object, so every field is echoed back with only
  // the targeted one changed. 3.x accepts a partial patch (measured: sending
  // {id, level} left name, mute, mixes and effects untouched), so it sends only
  // what it means to change and never risks reviving a stale cached field.
  function pushV2Input(raw, slider) {
    return request('setInputMixer', {
      mixId: raw.mixId,
      slider,
      localVolumeIn: raw.localVolumeIn,
      isLocalInMuted: !!raw.isLocalInMuted,
      streamVolumeIn: raw.streamVolumeIn,
      isStreamInMuted: !!raw.isStreamInMuted,
      filters: raw.filters || [],
      localMixFilterBypass: !!raw.localMixFilterBypass,
      streamMixFilterBypass: !!raw.streamMixFilterBypass,
    });
  }

  function pushV2Output() {
    const o = outputRaw || {};
    return request('setOutputMixer', {
      localVolumeOut: o.localVolumeOut,
      isLocalOutMuted: !!o.isLocalOutMuted,
      streamVolumeOut: o.streamVolumeOut,
      isStreamOutMuted: !!o.isStreamOutMuted,
    });
  }

  async function ensureSeeded() { if (!seeded || !ws) { await connect(); if (!seeded) await seedState(); } }

  // ── public surface ─────────────────────────────────────────────────────────

  async function runAction(action) {
    try {
      if (!action || typeof action !== 'object') return { ok: false, error: 'bad_wl_action' };
      const type = action.type;

      if (type === 'wlInputVolume' || type === 'wlInputMute') {
        await ensureSeeded();
        const id = String(action.mixId == null ? '' : action.mixId);
        const ch = channels.get(id);
        if (!ch) return { ok: false, error: 'wl_unknown_channel' };
        const targets = resolveMixTargets(ch.mixes, action.mix);
        if (!targets.length) {
          // A mix the user can see but this channel is not routed INTO is a
          // different problem from a mix that no longer exists, and only one of
          // the two is the user's mistake. Wave Link genuinely cannot set a
          // level for an unrouted channel, so both refuse — but they say which.
          const known = mixes.some((m) => m.id === String(action.mix));
          return { ok: false, error: known ? 'wl_channel_not_in_mix' : 'wl_unknown_mix' };
        }
        const setVol = type === 'wlInputVolume';
        const vol = setVol ? clampVolume(action.value) : null;
        if (setVol && vol == null) return { ok: false, error: 'bad_volume' };

        if (dialect === 3) {
          const patch = targets.map((mixId) => {
            const cur = ch.mixes.find((m) => m.id === mixId) || {};
            return setVol ? { id: mixId, level: unitFromPct(vol) } : { id: mixId, isMuted: !cur.muted };
          });
          await request('setChannel', { id, mixes: patch });
        } else {
          const raw = v2Raw.get(id);
          if (!raw) return { ok: false, error: 'wl_unknown_channel' };
          for (const mixId of targets) {
            if (mixId === V2_MIX_LOCAL) { if (setVol) raw.localVolumeIn = vol; else raw.isLocalInMuted = !raw.isLocalInMuted; }
            else { if (setVol) raw.streamVolumeIn = vol; else raw.isStreamInMuted = !raw.isStreamInMuted; }
          }
          await pushV2Input(raw, targets.length > 1 ? 'all' : (targets[0] === V2_MIX_LOCAL ? 'local' : 'stream'));
          reindexV2();
        }
        return { ok: true };
      }

      // The mix master. On 2.x this is the output mixer's two sliders; on 3.x it
      // is setMix on the user's own mix, which is the same control wearing the
      // name its owner gave it.
      if (type === 'wlOutputVolume' || type === 'wlOutputMute' || type === 'wlMixVolume' || type === 'wlMixMute') {
        await ensureSeeded();
        const setVol = (type === 'wlOutputVolume' || type === 'wlMixVolume');
        const selector = (type === 'wlMixVolume' || type === 'wlMixMute') ? action.mixId : action.mix;
        const targets = resolveMixTargets(mixes, selector);
        if (!targets.length) return { ok: false, error: 'wl_unknown_mix' };
        const vol = setVol ? clampVolume(action.value) : null;
        if (setVol && vol == null) return { ok: false, error: 'bad_volume' };

        if (dialect === 3) {
          for (const mixId of targets) {
            const cur = mixes.find((m) => m.id === mixId) || {};
            // eslint-disable-next-line no-await-in-loop -- sequential by design: one call per mix
            await request('setMix', setVol ? { id: mixId, level: unitFromPct(vol) } : { id: mixId, isMuted: !cur.muted });
          }
        } else {
          outputRaw = outputRaw || {};
          for (const mixId of targets) {
            if (mixId === V2_MIX_LOCAL) { if (setVol) outputRaw.localVolumeOut = vol; else outputRaw.isLocalOutMuted = !outputRaw.isLocalOutMuted; }
            else { if (setVol) outputRaw.streamVolumeOut = vol; else outputRaw.isStreamOutMuted = !outputRaw.isStreamOutMuted; }
          }
          await pushV2Output();
        }
        return { ok: true };
      }

      // Per-channel effect chain (3.x only — 2.x has no effect list on the wire).
      if (type === 'wlEffect') {
        await ensureSeeded();
        if (dialect !== 3) return { ok: false, error: 'wl_unsupported' };
        const id = String(action.mixId == null ? '' : action.mixId);
        const ch = channels.get(id);
        if (!ch) return { ok: false, error: 'wl_unknown_channel' };
        const effectId = String(action.effectId == null ? '' : action.effectId);
        const eff = ch.effects.find((e) => e.id === effectId);
        if (!eff) return { ok: false, error: 'wl_unknown_effect' };
        const mode = String(action.mode || 'toggle').toLowerCase();
        const next = mode === 'on' ? true : mode === 'off' ? false : !eff.enabled;
        await request('setChannel', { id, effects: [{ id: effectId, isEnabled: next }] });
        return { ok: true };
      }

      // Switch which physical device the main output goes to (3.x only).
      if (type === 'wlOutputDevice') {
        await ensureSeeded();
        if (dialect !== 3) return { ok: false, error: 'wl_unsupported' };
        const deviceId = String(action.deviceId == null ? '' : action.deviceId);
        const dev = outputs.devices.find((d) => d.id === deviceId);
        if (!dev) return { ok: false, error: 'wl_unknown_device' };
        const outId = (dev.outputs[0] && dev.outputs[0].id) || deviceId;
        await request('setOutputDevice', { mainOutput: { outputDeviceId: deviceId, outputId: outId } });
        await refreshOutputs();
        return { ok: true };
      }

      // 2.x-only monitor controls. On 3.x the mixes ARE the monitoring model, so
      // there is nothing to flip; say unsupported rather than pretend.
      if (type === 'wlSwitchMonitoring') {
        await ensureSeeded();
        if (dialect === 3) return { ok: false, error: 'wl_unsupported' };
        const next = switchState === 'Stream Mix' ? 'Local Mix' : 'Stream Mix';
        const r = await request('switchMonitoring', { switchState: next }).catch(() => null);
        if (r && r.switchState != null) switchState = String(r.switchState);
        return { ok: true };
      }
      if (type === 'wlSetMonitorMix') {
        await ensureSeeded();
        if (dialect === 3) return { ok: false, error: 'wl_unsupported' };
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

  // Channel list for the editor's picker: [{ value, label }].
  async function listChannels() {
    await ensureSeeded();
    return Array.from(channels.values())
      .map((ch) => ({ value: ch.id, label: ch.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // Mix list for the editor's picker. On 2.x these are the two synthetic mixes,
  // so the same key works on both dialects and the user sees words rather than
  // ids either way.
  async function listMixes() {
    await ensureSeeded();
    return mixes.map((m) => ({ value: m.id, label: m.name }));
  }

  // The channel artwork 3.x ships as base64. Served on demand by URL so it never
  // rides the SSE frame.
  function iconFor(id) {
    const data = icons.get(String(id || ''));
    if (!data) return null;
    try { return Buffer.from(data, 'base64'); } catch (e) { return null; }
  }

  function snapshot() {
    const list = [];
    for (const ch of channels.values()) {
      const meter = meters.get('channel:' + ch.id) || null;
      list.push(Object.assign({}, ch, { meter }));
    }
    return {
      connected: !!ws,
      dialect,
      version: identity ? identity.version : '',
      channels: list,
      mixes: mixes.map((m) => Object.assign({}, m, { meter: meters.get('mix:' + m.id) || null })),
      outputs,
      // 2.x-only; the widget hides the control when these are absent.
      monitor: dialect === 2 ? { monitorMix, switchState, micConnected } : null,
      capabilities: {
        meters: dialect === 3,
        effects: dialect === 3,
        outputDevices: dialect === 3,
        monitorSwitch: dialect === 2,
        namedMixes: dialect === 3,
      },
    };
  }

  function isConnected() { return !!ws; }

  async function test() {
    try {
      await connect();
      if (!seeded) await seedState();
      return { ok: true, count: channels.size, dialect, version: identity ? identity.version : '' };
    } catch (e) { return { ok: false, error: (e && e.message) || 'wl_connect_failed' }; }
  }

  // `meters` is opt-in per watcher: a dashboard with the tile on screen wants
  // them, a Deck key does not, and Wave Link should not be pushing at 2 Hz for
  // the latter.
  function watch(cb, watchOpts) {
    onChange = cb; watching = true;
    wantMeters = !!(watchOpts && watchOpts.meters);
    startWatchConn();
    return () => {
      watching = false; onChange = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      clearPing();
      // Turn the meters off at the source before letting the socket idle out.
      if (wantMeters && ws) { setMeters(false).catch(() => {}); }
      wantMeters = false;
      bumpIdle();
    };
  }

  return { runAction, listChannels, listMixes, snapshot, isConnected, test, watch, close, iconFor, setMeters };
}

// Where Wave Link 3 publishes its port. Scans for the package folder rather than
// hardcoding the publisher hash, so a differently-signed build is still found.
async function readPublishedPort(localAppData) {
  const base = localAppData || process.env.LOCALAPPDATA;
  if (!base) return null;
  const packages = path.join(base, 'Packages');
  let names = [];
  try { names = await fsp.readdir(packages); } catch (e) { return null; }
  for (const name of names) {
    if (!WL3_PACKAGE_RE.test(name)) continue;
    const file = path.join(packages, name, 'LocalState', WL3_PORT_FILE);
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      const port = Number(data && data.port);
      if (port > 0 && port < 65536) return { port, file };
    } catch (e) { /* try the next package */ }
  }
  return null;
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
