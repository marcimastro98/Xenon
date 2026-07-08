'use strict';

// ── Voce Live (Gemini Live realtime) — client ────────────────────────────────
//
// Full-duplex voice mode (opt-in beta). The SERVER owns the microphone (ffmpeg
// capture) and proxies the Gemini Live socket — this client is deliberately thin:
// it opens the loopback WS, PLAYS the streamed reply audio (Web Audio, 24 kHz),
// mirrors the input/output transcripts into the existing voice orb, applies any
// forwarded dashboard actions, and handles barge-in + tap-to-interrupt. It never
// touches getUserMedia (which never resolves on the Xeneon Edge WebView), so it
// works identically on the Edge and in a desktop browser.
//
// Reuses ai.js globals: _aiVoiceModeEnter/_aiVoiceModeExit, _aiVoiceState,
// _aiVoiceSetUser/_aiVoiceSetReply, _aiExecuteClientAction, hubSettings, t, $.

let _liveWs = null;
let _liveActiveClient = false;
let _liveAudioCtx = null;
let _liveSources = [];       // scheduled AudioBufferSourceNodes (for barge-in flush)
let _livePlayHead = 0;       // next scheduled start time in the AudioContext clock
let _liveUserText = '';
let _liveReplyText = '';
let _liveGotReady = false;   // Gemini setup completed at least once this session

function aiLiveIsActive() { return _liveActiveClient; }

// Surface a Live problem to the user (no devtools needed to diagnose). Best-effort.
function _liveToast(msg) {
  try {
    if (window.XenonToast && msg) window.XenonToast.show({ type: 'warn', kicker: 'Voce Live', message: String(msg).slice(0, 200), duration: 6000 });
  } catch (e) { /* ignore */ }
}

function _liveEnsureAudioCtx() {
  if (!_liveAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    _liveAudioCtx = new Ctx();
  }
  if (_liveAudioCtx.state === 'suspended') { _liveAudioCtx.resume().catch(() => {}); }
  return _liveAudioCtx;
}

// Decode one base64 PCM16 (24 kHz mono) chunk and schedule it back-to-back after
// whatever is already queued, so consecutive chunks play gaplessly.
function _livePlayAudioChunk(base64) {
  let ctx;
  try { ctx = _liveEnsureAudioCtx(); } catch (e) { return; }
  let bin;
  try { bin = atob(base64); } catch (e) { return; }
  const n = bin.length >> 1; // 16-bit samples
  if (n <= 0) return;
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bin.charCodeAt(i * 2) & 0xff;
    const hi = bin.charCodeAt(i * 2 + 1) & 0xff;
    let s = (hi << 8) | lo;
    if (s >= 0x8000) s -= 0x10000; // sign-extend
    f32[i] = s / 32768;
  }
  // createBufferSource resamples the 24 kHz buffer to the context rate for us.
  const buf = ctx.createBuffer(1, n, 24000);
  buf.getChannelData(0).set(f32);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const now = ctx.currentTime;
  if (_livePlayHead < now) _livePlayHead = now;
  try { src.start(_livePlayHead); } catch (e) { return; }
  _livePlayHead += buf.duration;
  _liveSources.push(src);
  src.onended = () => { const i = _liveSources.indexOf(src); if (i >= 0) _liveSources.splice(i, 1); };
  if (typeof _aiVoiceState === 'function') _aiVoiceState('speaking');
}

// Barge-in / interrupt: stop everything queued immediately so the assistant goes
// quiet the instant the user starts speaking (native VAD) or taps.
function _liveFlushAudio() {
  for (const s of _liveSources) { try { s.stop(); } catch (e) { /* already stopped */ } }
  _liveSources = [];
  _livePlayHead = 0;
}

function _liveSend(obj) { try { if (_liveWs && _liveWs.readyState === WebSocket.OPEN) _liveWs.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } }

// Public: start a live voice session. Returns true if it took over, false if the
// caller should fall back to the turn-based path.
function aiStartLiveSession() {
  if (_liveActiveClient) return true;
  const provider = (typeof _aiProviderCfg === 'function') ? _aiProviderCfg().provider : 'gemini';
  if (provider !== 'gemini') return false; // Live is Gemini-only; caller falls back
  const key = (typeof hubSettings === 'object' && hubSettings && hubSettings.geminiApiKey) || '';
  if (!key) return false;

  _liveActiveClient = true;
  _liveGotReady = false;
  _liveUserText = '';
  _liveReplyText = '';
  if (typeof _aiVoiceModeEnter === 'function') _aiVoiceModeEnter();
  if (typeof _aiVoiceSetUser === 'function') _aiVoiceSetUser('');
  if (typeof _aiVoiceState === 'function') _aiVoiceState('thinking'); // connecting
  if (typeof _aiPlayWakeChime === 'function') _aiPlayWakeChime();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try { ws = new WebSocket(`${proto}//${location.host}/api/ai/live`); }
  catch (e) { _liveActiveClient = false; return false; }
  _liveWs = ws;

  ws.onopen = () => {
    const lang = (document.documentElement.lang || 'it').slice(0, 2);
    const summary = (typeof aiConversationSummary === 'string') ? aiConversationSummary : '';
    _liveSend({ type: 'start', key, lang, summary });
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        _liveGotReady = true;
        if (typeof _aiVoiceState === 'function') _aiVoiceState('listening');
        break;
      case 'audio':
        _livePlayAudioChunk(m.data);
        break;
      case 'input': // user speech transcript
        _liveUserText = (_liveUserText + ' ' + (m.text || '')).trim().slice(-400);
        if (typeof _aiVoiceSetUser === 'function') _aiVoiceSetUser(_liveUserText);
        break;
      case 'output': // assistant speech transcript
        _liveReplyText = (_liveReplyText + (m.text || '')).slice(-600);
        if (typeof _aiVoiceSetReply === 'function') _aiVoiceSetReply(_liveReplyText);
        break;
      case 'interrupted':
        _liveFlushAudio();
        _liveReplyText = '';
        _liveUserText = '';
        if (typeof _aiVoiceState === 'function') _aiVoiceState('listening');
        break;
      case 'action':
        if (typeof _aiExecuteClientAction === 'function' && m.action) _aiExecuteClientAction(m.action, m.args || {});
        break;
      case 'timeout':
      case 'closed':
        _liveStop(true);
        break;
      case 'error':
        _liveHandleError(m);
        break;
      default: break;
    }
  };
  ws.onerror = () => { /* onclose will follow */ };
  ws.onclose = () => {
    // Fires "unhandled" only when the socket closes with no preceding 'error'/
    // 'closed' message (e.g. the upgrade was rejected, or the network dropped) —
    // an 'error'/'closed' handler would already have set _liveActiveClient=false.
    if (!_liveActiveClient) return;
    const neverReady = !_liveGotReady;
    _liveToast(neverReady ? 'Connessione Voce Live non riuscita — passo alla voce a turni.' : 'Sessione Voce Live chiusa.');
    _liveStop(true);
    if (neverReady && typeof startVoiceSessionTurnBased === 'function') startVoiceSessionTurnBased();
  };
  return true;
}

function _liveHandleError(m) {
  const code = m && m.code;
  // Show the reason (so it's diagnosable without devtools) and fall back to the
  // turn-based voice path so the button is never a dead end — EXCEPT on 'busy'
  // (another Live session already owns the mic, so a turn-based recorder would
  // just be refused 409 live_active → close quietly instead).
  _liveToast((m && m.error) || 'Voce Live non disponibile');
  const fallback = code !== 'busy';
  _liveStop(false);
  if (fallback && typeof startVoiceSessionTurnBased === 'function') {
    startVoiceSessionTurnBased();
  }
}

// Stop the session. `fromServer` true means the socket is already closing.
function _liveStop(fromServer) {
  if (!_liveActiveClient && !_liveWs) return;
  _liveActiveClient = false;
  if (_liveWs) {
    try { if (!fromServer && _liveWs.readyState === WebSocket.OPEN) _liveSend({ type: 'stop' }); } catch (e) { /* ignore */ }
    try { _liveWs.onclose = null; _liveWs.close(); } catch (e) { /* ignore */ }
    _liveWs = null;
  }
  _liveFlushAudio();
  if (_liveAudioCtx) { try { _liveAudioCtx.close(); } catch (e) { /* ignore */ } _liveAudioCtx = null; }
  fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  if (typeof _aiVoiceModeExit === 'function') _aiVoiceModeExit();
  document.body.classList.remove('ai-voice-mode', 'ai-voice-ambient', 'voice-listening', 'voice-thinking', 'voice-speaking');
  if (typeof _aiPlayCloseChime === 'function') { try { _aiPlayCloseChime(); } catch (e) { /* ignore */ } }
}

function aiStopLiveSession() { _liveStop(false); }

// Tap-to-interrupt while a live session runs: the user taps to end it (a single
// tap in full-duplex means "stop", since barge-in already handles talking over).
function aiLiveTapInterrupt() { if (_liveActiveClient) { aiStopLiveSession(); return true; } return false; }
