'use strict';
// Lazy Streamer.bot WebSocket client + pure helpers. Connects on demand,
// authenticates (sha256 challenge — same scheme as OBS v5) only when the server
// has auth enabled, sends one request, and auto-closes after idle.
//
// WebSocket implementation: we use the `ws` library (already present via
// msedge-tts) instead of Node's built-in global WebSocket. Streamer.bot's
// WebSocket Server negotiates permessage-deflate compression, and the built-in
// (undici) client mangles those compressed frames into empty strings — so every
// reply (the auth ack, GetActions, …) was silently lost and the connection timed
// out (`sb_request_timeout`) even though Streamer.bot showed the client connected
// and Authenticated. `ws` decodes the compressed frames correctly. We fall back
// to the global WebSocket if `ws` is somehow unavailable. (OBS works on the
// built-in client because OBS-websocket does not enable compression.)
const crypto = require('crypto');

const DEFAULT_WS = (() => {
  try { return require('ws'); } catch (e) { return globalThis.WebSocket; }
})();

// Streamer.bot auth: base64(sha256( base64(sha256(password+salt)) + challenge )).
function computeAuth(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(String(password) + String(salt)).digest('base64');
  return crypto.createHash('sha256').update(secret + String(challenge)).digest('base64');
}

// Parse an optional user-supplied "arguments" field (a JSON object typed in the
// editor) into a safe, shallow, string-keyed map of scalar values — or undefined
// when empty/invalid. Streamer.bot's DoAction/ExecuteCodeTrigger accept an `args`
// object exposed to the action; we cap key/value size and count so a stray blob
// can't bloat the frame, and drop nested objects/arrays (SB args are flat).
function parseArgs(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return undefined;
  let obj;
  try { obj = JSON.parse(s); } catch (e) { return undefined; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const out = {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (n++ >= 32) break;
    const v = obj[k];
    if (v == null || typeof v === 'object') continue;
    out[String(k).slice(0, 100)] = typeof v === 'string' ? v.slice(0, 1024) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Map a validated deck streamer.bot action to a WS request, or null if invalid.
// Field shapes verified against the official Streamer.bot client:
//   DoAction            -> { action:{id}, args? }   (id from the live GetActions list,
//                           stable across renames, unlike the display name)
//   SendMessage         -> { platform, message, bot, internal }
//   ExecuteCodeTrigger  -> { triggerName, args? }
function streamerbotRequest(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'sbDoAction') {
    const id = String(action.action || '').trim();
    if (!id) return null;
    const args = parseArgs(action.args);
    const req = { request: 'DoAction', action: { id } };
    if (args) req.args = args;
    return req;
  }
  if (action.type === 'sbSendMessage') {
    const platform = String(action.platform || '').trim().toLowerCase();
    if (!['twitch', 'youtube', 'kick', 'trovo'].includes(platform)) return null;
    const message = String(action.message || '').trim();
    if (!message) return null;
    // Default to the bot account; 'broadcaster' sends from the streamer's own chat.
    const bot = action.sendAs !== 'broadcaster';
    return { request: 'SendMessage', platform, message: message.slice(0, 500), bot, internal: false };
  }
  if (action.type === 'sbCodeTrigger') {
    const triggerName = String(action.trigger || '').trim();
    if (!triggerName) return null;
    const args = parseArgs(action.args);
    const req = { request: 'ExecuteCodeTrigger', triggerName };
    if (args) req.args = args;
    return req;
  }
  return null;
}

// Curated Streamer.bot events surfaced in the dashboard activity feed (phase 3):
// alerts, not chat — low-volume and meaningful. Subscribed alongside the Misc
// global-variable events. Event/source names verified against the official client.
const ACTIVITY_EVENTS = {
  Twitch: ['Follow', 'Sub', 'ReSub', 'GiftSub', 'GiftBomb', 'Cheer', 'Raid', 'RewardRedemption', 'StreamOnline', 'StreamOffline', 'Announcement', 'HypeTrainStart', 'HypeTrainEnd'],
  YouTube: ['NewSubscriber', 'SuperChat', 'SuperSticker', 'NewSponsor', 'MembershipGift', 'GiftMembershipReceived', 'MemberMileStone'],
};

// Event data shapes vary wildly per platform/type, so pull the common fields
// defensively. Returns '' / undefined when absent (the feed then shows just the type).
function sbEventUser(d) {
  if (!d || typeof d !== 'object') return '';
  if (typeof d.user === 'string') return d.user.trim();
  const u = (d.user && typeof d.user === 'object') ? d.user : {};
  return String(u.display_name || u.displayName || u.name || d.displayName || d.userName || d.user_name || d.from_name || d.gifterName || '').trim();
}
function sbEventText(d) {
  if (!d || typeof d !== 'object') return '';
  const m = d.message;
  if (typeof m === 'string') return m.trim();
  if (m && typeof m === 'object') return String(m.message || m.text || '').trim();
  return String(d.text || '').trim();
}
function sbEventAmount(d) {
  if (!d || typeof d !== 'object') return undefined;
  return [d.amount, d.bits, d.viewers, d.viewerCount, d.months, d.cumulativeMonths, d.total, d.count]
    .find((x) => typeof x === 'number' && Number.isFinite(x));
}
// Project a raw event into the compact activity item the feed renders.
function projectActivity(source, type, data) {
  const item = { source: String(source || ''), type: String(type || '') };
  const user = sbEventUser(data); if (user) item.user = user.slice(0, 80);
  const text = sbEventText(data); if (text) item.text = text.slice(0, 200);
  const amount = sbEventAmount(data); if (amount != null) item.amount = amount;
  return item;
}

// getConfig: async () -> { host, port, password, endpoint }. Returns a client
// with request(requestType, payload) -> Promise<response>; the socket is shared
// and idle-closed. Streamer.bot speaks a request/response JSON protocol where
// each reply echoes the request `id` and carries a `status` ('ok' | 'error').
function createStreamerbot(getConfig, opts) {
  const WebSocketImpl = (opts && opts.WebSocketImpl) || DEFAULT_WS;
  let ws = null;
  let ready = null;          // Promise<void> resolved once connected (and authed)
  let idleTimer = null;
  let reqId = 0;
  const pending = new Map(); // requestId -> { resolve, reject }
  let retryTimer = null;     // reconnect backoff handle (watch mode)
  let pingTimer = null;      // keepalive handle (watch mode)
  let watching = false;      // hold the socket open + reconnect while true
  let onChange = null;       // notify callback while watching (globals changed)
  let onActivity = null;     // notify callback per curated stream event (feed)
  const globals = new Map(); // global name -> value (kept fresh while watching)
  const IDLE_MS = 60000;
  const PING_MS = 30000;

  function clearPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  function close() {
    if (!ws && !idleTimer && !retryTimer && !pingTimer && pending.size === 0) return;   // already clean
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // A public close() during the reconnect window must not later resurrect the
    // socket; the watch() stop fn sets watching=false before calling close().
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    clearPing();
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null; ready = null;
    pending.forEach((p) => p.reject(new Error('sb_closed')));
    pending.clear();
  }

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    // While watching we hold the connection open indefinitely (no idle-close).
    idleTimer = watching ? null : setTimeout(close, IDLE_MS);
  }

  function scheduleReconnect() {
    if (!watching || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; if (watching) startWatchConn(); }, 8000);
  }

  function connect() {
    if (ready) return ready;
    // Assign `ready` synchronously (before awaiting getConfig) so concurrent
    // requests share ONE handshake instead of each opening a socket.
    ready = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const done = (err) => {
        if (settled) return; settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (err) { reject(err); close(); } else { bumpIdle(); resolve(); }
      };
      Promise.resolve().then(getConfig).then((cfg) => {
        if (settled) return;
        const c = cfg || {};
        const host = c.host || '127.0.0.1';
        const port = Number(c.port) || 8080;
        const password = c.password || '';
        const endpoint = c.endpoint || '/';
        let sock;
        try { sock = new WebSocketImpl('ws://' + host + ':' + port + endpoint); } catch (e) { done(e); return; }
        ws = sock;
        timer = setTimeout(() => done(new Error('sb_timeout')), 10000);
        sock.addEventListener('error', () => done(new Error('sb_connect_failed')));
        sock.addEventListener('close', () => { if (!settled) done(new Error('sb_closed')); else { close(); if (watching) scheduleReconnect(); } });
        sock.addEventListener('message', (ev) => {
          // `ws` delivers text frames as a string; be tolerant of Buffer/ArrayBuffer too.
          const d = ev.data;
          const raw = typeof d === 'string' ? d
            : Buffer.isBuffer(d) ? d.toString('utf8')
            : d instanceof ArrayBuffer ? Buffer.from(d).toString('utf8') : '';
          let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
          if (!msg) return;
          if (msg.request === 'Hello') {              // greeting -> authenticate if required
            const a = msg.authentication;
            // Only authenticate when the user actually SET a password. Streamer.bot's
            // WebSocket auth can be "enabled but not enforced": Hello still advertises a
            // salt/challenge, yet unauthenticated requests are accepted — and sending a
            // WRONG Authenticate (e.g. the empty-password hash) makes the server slam the
            // socket shut with code 4009 "Authentication failed" (surfaced as sb_closed).
            // So with no password we proceed UNauthenticated (works in the non-enforced
            // mode); if the server truly enforces auth, requests then fail cleanly and the
            // user is prompted to enter their password. Verified against a live SB 1.0.4.
            if (a && a.salt && a.challenge && password) {
              // Send the challenge response, then mark the handshake ready WITHOUT
              // waiting for an Authenticate acknowledgement. WebSocket preserves
              // message order, so the server processes our Authenticate before any
              // later request, and that request's own response is the real proof of
              // success. Blocking on an auth ack hung the handshake to a timeout on
              // Streamer.bot builds that don't echo it back the way we expect (the
              // server showed the client as Authenticated while we never proceeded).
              try { sock.send(JSON.stringify({ request: 'Authenticate', id: 'auth', authentication: computeAuth(password, a.salt, a.challenge) })); done(); }
              catch (e) { done(e); }
            } else {
              done();                                 // no password / no auth: ready immediately
            }
            return;
          }
          if (msg.id != null && pending.has(msg.id)) { // response to one of our requests
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.status == null || msg.status === 'ok') p.resolve(msg);
            else p.reject(new Error(msg.error || 'sb_request_failed'));
            bumpIdle();
          } else if (msg.event && msg.event.source) {   // a subscribed push event
            applyEvent(msg);
          }
        });
      }, (e) => done(e instanceof Error ? e : new Error('sb_config_failed')));
    });
    ready.catch(() => {});   // prevent unhandled rejection if nothing awaits yet
    return ready;
  }

  async function request(requestType, payload) {
    await connect();
    bumpIdle();
    const id = 'r' + (++reqId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('sb_request_timeout')); }, 10000);
      const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
      pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) });
      try { ws.send(JSON.stringify(Object.assign({ request: requestType, id }, payload || {}))); }
      catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  // ── Globals watch (Phase 2): reflect Streamer.bot global variables on Deck keys
  // via a live event subscription — seed once, then push on change (no polling). ──

  // GetGlobals responses vary by build: `variables` as an object keyed by name, or
  // an array of {name,value}. Accept both (and a `globals` alias) defensively.
  function ingestGlobals(resp) {
    if (!resp) return;
    const v = resp.variables != null ? resp.variables : resp.globals;
    if (Array.isArray(v)) {
      for (const g of v) { if (g && g.name != null) globals.set(String(g.name), g.value); }
    } else if (v && typeof v === 'object') {
      for (const [k, g] of Object.entries(v)) {
        globals.set(String(k), (g && typeof g === 'object' && 'value' in g) ? g.value : g);
      }
    }
  }

  // A GlobalVariable{Updated,Created,Deleted} push (event.source === 'Misc'). Its
  // data carries { name, value } (older builds: newValue). Keep the cache fresh and
  // notify the watcher.
  function applyEvent(msg) {
    const ev = msg.event || {};
    const data = msg.data || {};
    if (ev.source === 'Misc' && (ev.type === 'GlobalVariableUpdated' || ev.type === 'GlobalVariableCreated' || ev.type === 'GlobalVariableDeleted')) {
      const name = data.name != null ? String(data.name) : '';
      if (!name) return;
      if (ev.type === 'GlobalVariableDeleted') globals.delete(name);
      else globals.set(name, data.value !== undefined ? data.value : data.newValue);
      if (onChange) { try { onChange(); } catch (e) { /* ignore */ } }
      return;
    }
    // Any other subscribed event is a stream activity → push to the feed.
    if (onActivity) { try { onActivity(projectActivity(ev.source, ev.type, data)); } catch (e) { /* ignore */ } }
  }

  // One-shot seed of the current globals (persisted + volatile). Does NOT subscribe
  // or start the keepalive — used by the editor picker, which then idle-closes.
  async function seedGlobalsOnce() {
    const [a, b] = await Promise.all([
      request('GetGlobals', { persisted: true }).catch(() => null),
      request('GetGlobals', { persisted: false }).catch(() => null),
    ]);
    globals.clear();
    ingestGlobals(a); ingestGlobals(b);
  }

  // Watch path: seed, subscribe to global-variable events, and hold the socket open
  // with a keepalive (idle-close is disabled while watching).
  async function seedAndSubscribe() {
    await seedGlobalsOnce();
    await request('Subscribe', { events: Object.assign({ Misc: ['GlobalVariableUpdated', 'GlobalVariableCreated', 'GlobalVariableDeleted'] }, ACTIVITY_EVENTS) });
    clearPing();
    // Keepalive: a cheap request whose failure force-closes a half-open socket so
    // the 'close' handler fires and, while watching, reconnects.
    pingTimer = setInterval(() => {
      request('GetInfo').catch(() => { if (watching && ws) { try { ws.close(); } catch (e) { /* ignore */ } } });
    }, PING_MS);
    if (onChange) { try { onChange(); } catch (e) { /* ignore */ } }
  }

  function startWatchConn() {
    connect().then(seedAndSubscribe).catch(() => scheduleReconnect());
  }

  // Keep a live connection and notify on global changes (onGlobals) and on each
  // curated stream event (onActivity). Returns a stop fn.
  function watch(onGlobals, onActivityCb) {
    onChange = onGlobals || null; onActivity = onActivityCb || null; watching = true;
    startWatchConn();
    return () => {
      watching = false; onChange = null; onActivity = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      clearPing();
      bumpIdle();                 // resume idle-close now that nobody's watching
    };
  }

  // Plain-object copy of the current globals (name -> value) for the SSE payload.
  function globalsSnapshot() {
    const out = {};
    for (const [k, v] of globals) out[k] = v;
    return out;
  }

  // Global names for the editor's "reflect a global" picker. Ensures a fresh cache
  // first (one-shot seed, no subscription), then idle-closes normally.
  async function listGlobals() {
    if (!globals.size || !ws) { await connect(); await seedGlobalsOnce(); }
    return Array.from(globals.keys()).map((name) => ({ name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  function isConnected() { return !!ws; }

  return { request, close, watch, globalsSnapshot, listGlobals, isConnected };
}

module.exports = { computeAuth, streamerbotRequest, createStreamerbot, projectActivity, ACTIVITY_EVENTS };
