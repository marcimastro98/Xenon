'use strict';
// Lazy UniFi Protect realtime-events client. Opens ONE WebSocket to the console's
// `/proxy/protect/ws/updates` stream while a Cameras tile is on screen (SSE clients
// > 0) AND notifications are enabled, decodes the binary update frames, and emits
// smart-detections (person / vehicle / package / animal), motion and doorbell rings
// so the server can surface them as dashboard toasts. Reconnects with fast-fail
// backoff and closes cleanly on teardown.
//
// Design invariants (see .claude/CLAUDE.md):
//   - Reuses the snapshot client's authenticated session (actions/unifi.js) — the
//     console password never leaves the server; only compact detections reach the
//     browser.
//   - A long-lived socket → must be stopped in _gracefulShutdown. Reconnect uses
//     exponential backoff (2s→30s), never a tight retry.
//   - Never throws out of the public surface; a malformed frame is ignored.
const WebSocket = require('ws');
const zlib = require('zlib');

// ── Binary update-frame decoder ──────────────────────────────────────────────
// A Protect realtime update is two concatenated frames — an ACTION frame (packet
// type 1) then a DATA frame (packet type 2). Each frame is an 8-byte header + a
// payload:
//   [0] packetType  1 = action, 2 = payload
//   [1] payloadFmt  1 = JSON, 2 = UTF-8 string, 3 = Node buffer
//   [2] deflated    1 = zlib-deflated payload, 0 = raw
//   [3] (reserved / payload-part id)
//   [4..7] payloadSize  UInt32BE
// We only act on JSON action+data frames; anything malformed → null (ignored).
function decodeFrame(buf, offset) {
  if (!Buffer.isBuffer(buf) || buf.length < offset + 8) return null;
  const fmt = buf[offset + 1];
  const deflated = buf[offset + 2];
  const size = buf.readUInt32BE(offset + 4);
  const end = offset + 8 + size;
  if (buf.length < end) return null;
  let payload = buf.subarray(offset + 8, end);
  if (deflated) { try { payload = zlib.inflateSync(payload); } catch (e) { return null; } }
  let value;
  try {
    if (fmt === 1) value = JSON.parse(payload.toString('utf8'));
    else value = payload.toString('utf8');
  } catch (e) { return null; }
  return { packetType: buf[offset], value, end };
}

// Decode a full update message into { action, data } (either may be null).
function decodeUpdatePacket(buf) {
  const action = decodeFrame(buf, 0);
  if (!action || action.packetType !== 1) return null;
  const data = decodeFrame(buf, action.end);
  return { action: action.value, data: (data && data.packetType === 2) ? data.value : null };
}

// ── Detection extraction (pure) ──────────────────────────────────────────────
const SMART_KINDS = Object.freeze(['person', 'vehicle', 'package', 'animal']);
const CAMERA_ID_RE = /^[A-Za-z0-9]{4,64}$/;

// From a decoded { action, data } pair, return { camId, kinds:[…], at } for a NEW
// detection event, or null. A single smart-detect event can carry several kinds
// (e.g. person + package); motion and doorbell rings map to a synthetic kind.
function extractDetection(action, data) {
  if (!action || action.modelKey !== 'event' || action.action !== 'add') return null;
  if (!data || typeof data !== 'object') return null;
  const camId = typeof data.camera === 'string' ? data.camera : '';
  if (!CAMERA_ID_RE.test(camId)) return null;
  const type = String(data.type || '');
  let kinds = [];
  if (type === 'smartDetectZone' || type === 'smartDetectLine') {
    kinds = (Array.isArray(data.smartDetectTypes) ? data.smartDetectTypes : []).filter((k) => SMART_KINDS.includes(k));
  } else if (type === 'motion') {
    kinds = ['motion'];
  } else if (type === 'ring') {
    kinds = ['ring'];
  }
  if (!kinds.length) return null;
  const at = Number(data.start);
  return { camId, kinds, at: Number.isFinite(at) ? at : 0 };
}

// ── Lazy watch client ────────────────────────────────────────────────────────
// `client` is the snapshot client from actions/unifi.js. We reuse its session
// (updatesWs → { wsUrl, cookie }), its camera list (for friendly names) and its
// close() (to force a re-login when the console rejects the upgrade).
function createUnifiEvents(client) {
  let ws = null;
  let watching = false;
  let onDetection = null;
  let retryTimer = null;
  let reconnectDelay = 2000;      // exponential backoff, reset after a SUSTAINED connection
  let openedAt = 0;               // when the current socket finished its upgrade
  let names = new Map();          // camId -> friendly name
  let namesAt = 0;                // last successful names refresh (TTL'd)
  let wsInfoCache = null;         // { info, at } — last updatesWs() result

  // A console/proxy can accept the upgrade and drop the socket right away; only a
  // connection that actually lived a while proves the path is healthy enough to
  // restart the backoff (otherwise accept-then-drop loops at a tight 2s forever).
  const SUSTAINED_MS = 60 * 1000;
  // updatesWs() fetches the console's full bootstrap document just for
  // lastUpdateId (best-effort) — don't re-download it on every rapid reconnect.
  const WS_INFO_TTL_MS = 10 * 60 * 1000;
  const NAMES_TTL_MS = 10 * 60 * 1000;

  function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }

  function scheduleReconnect() {
    if (!watching || retryTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    retryTimer = setTimeout(() => { retryTimer = null; if (watching) connect(); }, delay);
  }

  async function refreshNames() {
    if (names.size && Date.now() - namesAt < NAMES_TTL_MS) return;
    try {
      const list = await client.cameras();
      const m = new Map();
      for (const c of (Array.isArray(list) ? list : [])) if (c && c.id) m.set(c.id, c.name || c.id);
      names = m;
      namesAt = Date.now();
    } catch (e) { /* keep the previous names */ }
  }

  function handleMessage(raw) {
    if (!Buffer.isBuffer(raw)) return;
    let packet;
    try { packet = decodeUpdatePacket(raw); } catch (e) { return; }
    if (!packet) return;
    const det = extractDetection(packet.action, packet.data);
    if (!det || !onDetection) return;
    const payload = { camId: det.camId, name: names.get(det.camId) || det.camId, kinds: det.kinds, at: det.at || Date.now() };
    try { onDetection(payload); } catch (e) { /* ignore */ }
  }

  async function connect() {
    if (ws || !watching) return;
    let info = (wsInfoCache && Date.now() - wsInfoCache.at < WS_INFO_TTL_MS) ? wsInfoCache.info : null;
    if (!info) {
      try { info = await client.updatesWs(); } catch (e) { scheduleReconnect(); return; }
      wsInfoCache = (info && info.wsUrl) ? { info, at: Date.now() } : null;
    }
    if (!watching || ws) return;
    if (!info || !info.wsUrl) { scheduleReconnect(); return; }
    await refreshNames();
    if (!watching || ws) return;
    let sock;
    try {
      sock = new WebSocket(info.wsUrl, {
        headers: { Cookie: info.cookie || '' },
        rejectUnauthorized: false,     // the console uses a self-signed cert
        handshakeTimeout: 8000,
        perMessageDeflate: false,      // each frame carries its own zlib
      });
    } catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.on('open', () => { openedAt = Date.now(); });
    sock.on('message', handleMessage);
    sock.on('unexpected-response', (req, res) => {
      const code = res && res.statusCode;
      try { sock.close(); } catch (e) { /* ignore */ }
      // A rejected upgrade usually means the cached TOKEN cookie expired — drop the
      // shared session (and our cached ws info) so the next connect re-logs in fresh.
      wsInfoCache = null;
      if (code === 401 || code === 403) { try { client.close(); } catch (e) { /* ignore */ } }
    });
    sock.on('error', () => { try { sock.close(); } catch (e) { /* ignore */ } });
    sock.on('close', () => {
      if (ws === sock) ws = null;
      // Never upgraded → the cached url/cookie may be the problem; re-fetch next time.
      if (!openedAt) wsInfoCache = null;
      if (openedAt && Date.now() - openedAt >= SUSTAINED_MS) reconnectDelay = 2000;
      openedAt = 0;
      if (watching) scheduleReconnect();
    });
  }

  // Start watching. `cb(payload)` fires for each new detection. Returns a stop fn.
  function watch(cb) {
    onDetection = cb; watching = true; reconnectDelay = 2000;
    connect();
    return () => {
      watching = false; onDetection = null; clearRetry();
      if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    };
  }

  function close() {
    watching = false; onDetection = null; clearRetry();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    reconnectDelay = 2000;
  }

  return { watch, close };
}

module.exports = { createUnifiEvents, decodeUpdatePacket, decodeFrame, extractDetection, SMART_KINDS };
