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

// Map a validated deck streamer.bot action to a WS request, or null if invalid.
// `action` is the Streamer.bot action id (a GUID), chosen in the editor from the
// live GetActions list — stable across renames, unlike the display name.
function streamerbotRequest(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'sbDoAction') {
    const id = String(action.action || '').trim();
    return id ? { request: 'DoAction', action: { id } } : null;
  }
  return null;
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
  const IDLE_MS = 60000;

  function close() {
    if (!ws && !idleTimer && pending.size === 0) return;   // already clean
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null; ready = null;
    pending.forEach((p) => p.reject(new Error('sb_closed')));
    pending.clear();
  }

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_MS);
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
        sock.addEventListener('close', () => { if (!settled) done(new Error('sb_closed')); else close(); });
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
            if (a && a.salt && a.challenge) {
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
              done();                                 // no auth on the server: ready immediately
            }
            return;
          }
          if (msg.id != null && pending.has(msg.id)) { // response to one of our requests
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.status == null || msg.status === 'ok') p.resolve(msg);
            else p.reject(new Error(msg.error || 'sb_request_failed'));
            bumpIdle();
          }
          // Subscription events (msg.event) are not used here and ignored.
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

  return { request, close };
}

module.exports = { computeAuth, streamerbotRequest, createStreamerbot };
