'use strict';
// Lazy OBS WebSocket v5 client + pure helpers. Connects on demand, authenticates
// (sha256 challenge), sends one request, and auto-closes after idle. Uses Node's
// built-in global WebSocket (Node 21+) — no dependency.
const crypto = require('crypto');

// OBS v5 auth: base64(sha256( base64(sha256(password+salt)) + challenge )).
function computeAuth(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(String(password) + String(salt)).digest('base64');
  return crypto.createHash('sha256').update(secret + String(challenge)).digest('base64');
}

// Map a validated deck obs action to an OBS request, or null if invalid.
function obsRequest(action) {
  if (!action || typeof action !== 'object') return null;
  switch (action.type) {
    case 'obsScene':
      return action.scene ? { requestType: 'SetCurrentProgramScene', requestData: { sceneName: action.scene } } : null;
    case 'obsRecord':
      return { requestType: action.mode === 'start' ? 'StartRecord' : action.mode === 'stop' ? 'StopRecord' : 'ToggleRecord', requestData: {} };
    case 'obsStream':
      return { requestType: action.mode === 'start' ? 'StartStream' : action.mode === 'stop' ? 'StopStream' : 'ToggleStream', requestData: {} };
    case 'obsMute':
      if (!action.source) return null;
      return action.mode === 'toggle'
        ? { requestType: 'ToggleInputMute', requestData: { inputName: action.source } }
        : { requestType: 'SetInputMute', requestData: { inputName: action.source, inputMuted: action.mode === 'mute' } };
    default:
      return null;
  }
}

// Given OBS's scene-name list and the current one, return the next scene (wraps
// around). null if there are no scenes. With 2 scenes this is an A↔B toggle.
function nextSceneName(scenes, current) {
  const list = Array.isArray(scenes) ? scenes.filter(Boolean) : [];
  if (!list.length) return null;
  let i = list.indexOf(current);
  if (i < 0) i = 0;
  return list[(i + 1) % list.length];
}

// Build the OBS request for a small JPEG thumbnail of a scene (a scene is a valid
// sourceName). Fixed, low-res params keep the pushed image a few KB.
function scenePreviewRequest(sceneName) {
  return {
    requestType: 'GetSourceScreenshot',
    // Width only (no imageHeight): OBS returns the scene's TRUE aspect ratio, so no
    // black letterbox/pillarbox bars get baked in; the widget's CSS `cover` then
    // fills the tile cleanly. 960px keeps the mini-screen crisp yet light over SSE.
    requestData: { sourceName: String(sceneName == null ? '' : sceneName), imageFormat: 'jpg', imageWidth: 960, imageCompressionQuality: 60 },
  };
}

// Map an OBS event (op5) to a partial deck OBS snapshot, or null if not relevant.
function obsEventToState(type, data) {
  const d = data || {};
  switch (type) {
    case 'RecordStateChanged': return { obsRecording: !!d.outputActive };
    case 'StreamStateChanged': return { obsStreaming: !!d.outputActive };
    case 'CurrentProgramSceneChanged': return { obsScene: d.sceneName || '' };
    case 'InputMuteStateChanged': return { obsMutes: { [d.inputName]: !!d.inputMuted } };
    default: return null;
  }
}

// getConfig: async () -> { host, port, password }. Returns a client with a single
// request(requestType, requestData) method; the socket is shared and idle-closed.
function createObs(getConfig) {
  let ws = null;
  let ready = null;          // Promise<void> resolved once identified
  let idleTimer = null;
  let reqId = 0;
  const pending = new Map(); // requestId -> { resolve, reject }
  const IDLE_MS = 60000;
  let watching = false;      // when true: keep the socket alive + reconnect on drop
  let onEvent = null;        // callback(partialSnapshot) while watching
  let retryTimer = null;
  let reconnectDelay = 2000; // exponential backoff, reset on a good connection

  function close() {
    if (!ws && !idleTimer && pending.size === 0) return;   // already clean (re-entrant close from the socket 'close' event)
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null; ready = null;
    pending.forEach((p) => p.reject(new Error('obs_closed')));
    pending.clear();
  }

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    // While watching we hold the connection open indefinitely (no idle-close).
    idleTimer = watching ? null : setTimeout(close, IDLE_MS);
  }

  function connect() {
    if (ready) return ready;
    // Assign `ready` synchronously (before awaiting getConfig) so concurrent
    // requests share ONE handshake instead of each opening a socket.
    ready = new Promise((resolve, reject) => {
      let settled = false;
      // Reject the handshake BEFORE close() (which flushes others with obs_closed)
      // so the original caller sees the real cause (obs_timeout / connect_failed).
      const done = (err) => { if (settled) return; settled = true; if (err) { reject(err); close(); } else resolve(); };
      Promise.resolve().then(getConfig).then((cfg) => {
        if (settled) return;
        const c = cfg || {};
        const host = c.host || '127.0.0.1';
        const port = Number(c.port) || 4455;
        const password = c.password || '';
        let sock;
        try { sock = new WebSocket('ws://' + host + ':' + port); } catch (e) { done(e); return; }
        ws = sock;
        const timer = setTimeout(() => done(new Error('obs_timeout')), 5000);
        sock.addEventListener('error', () => { clearTimeout(timer); done(new Error('obs_connect_failed')); });
        sock.addEventListener('close', () => { clearTimeout(timer); if (!settled) done(new Error('obs_closed')); else { close(); if (watching) scheduleReconnect(); } });
        sock.addEventListener('message', (ev) => {
          let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
          if (!msg) return;
          if (msg.op === 0) {                         // Hello -> Identify
            const ident = { op: 1, d: { rpcVersion: 1 } };
            const a = msg.d && msg.d.authentication;
            if (a) ident.d.authentication = computeAuth(password, a.salt, a.challenge);
            sock.send(JSON.stringify(ident));
          } else if (msg.op === 2) {                  // Identified
            clearTimeout(timer); reconnectDelay = 2000; bumpIdle(); done();
          } else if (msg.op === 7) {                  // RequestResponse
            const d = msg.d || {};
            const p = pending.get(d.requestId);
            if (p) {
              pending.delete(d.requestId);
              if (d.requestStatus && d.requestStatus.result) p.resolve(d.responseData || {});
              else p.reject(new Error((d.requestStatus && d.requestStatus.comment) || 'obs_request_failed'));
            }
            bumpIdle();
          } else if (msg.op === 5) {                  // Event
            if (onEvent) { const p = obsEventToState((msg.d || {}).eventType, (msg.d || {}).eventData); if (p) onEvent(p); }
          }
        });
      }, (e) => done(e instanceof Error ? e : new Error('obs_config_failed')));
    });
    ready.catch(() => {});   // prevent unhandled rejection if nothing awaits yet
    return ready;
  }

  async function request(requestType, requestData) {
    await connect();
    bumpIdle();
    const requestId = 'r' + (++reqId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.delete(requestId)) reject(new Error('obs_request_timeout')); }, 5000);
      const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
      pending.set(requestId, { resolve: wrap(resolve), reject: wrap(reject) });
      try { ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } })); }
      catch (e) { pending.delete(requestId); clearTimeout(timer); reject(e); }
    });
  }

  // Advance OBS to the next program scene (wraps). One GetSceneList + one set.
  async function nextScene() {
    const d = await request('GetSceneList', {});
    const scenes = (d.scenes || []).map((s) => s.sceneName).filter(Boolean);
    const next = nextSceneName(scenes, d.currentProgramSceneName || '');
    if (next) await request('SetCurrentProgramScene', { sceneName: next });
  }

  function scheduleReconnect() {
    if (!watching || retryTimer) return;
    // Exponential backoff (2s→30s) instead of a flat 8s hammer while OBS is closed.
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    retryTimer = setTimeout(() => { retryTimer = null; if (watching) startWatchConn(); }, delay);
  }
  function startWatchConn() {
    connect().then(seedAndNotify).catch(() => scheduleReconnect());
  }
  // Fetch the current state once (events only fire on change) and emit it.
  async function seedAndNotify() {
    try {
      const [rec, str, scn, inp] = await Promise.all([
        request('GetRecordStatus', {}).catch(() => ({})),
        request('GetStreamStatus', {}).catch(() => ({})),
        request('GetCurrentProgramScene', {}).catch(() => ({})),
        request('GetInputList', {}).catch(() => ({})),
      ]);
      const obsMutes = {};
      const inputs = (inp.inputs || []).filter((i) => /audio|wasapi|coreaudio|pulse|sndio|alsa/i.test(i.inputKind || ''));
      await Promise.all(inputs.map((i) => request('GetInputMute', { inputName: i.inputName })
        .then((m) => { obsMutes[i.inputName] = !!m.inputMuted; }).catch(() => {})));
      if (onEvent) onEvent({ obsRecording: !!rec.outputActive, obsStreaming: !!str.outputActive, obsScene: scn.currentProgramSceneName || '', obsMutes });
    } catch (e) { /* ignore */ }
  }
  // Keep a live connection and forward state changes. Returns a stop function.
  function watch(cb) {
    onEvent = cb; watching = true;
    startWatchConn();
    return () => { watching = false; onEvent = null; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } bumpIdle(); };
  }

  return { request, nextScene, watch, close };
}

module.exports = { obsRequest, nextSceneName, obsEventToState, scenePreviewRequest, computeAuth, createObs };
