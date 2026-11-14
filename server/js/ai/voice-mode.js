// The voice mode on screen: its chimes, the orb and what a tap on it does, the words heard and
// answered, and its errors.
'use strict';

let _aiVoiceOpenedAt      = 0;     // timestamp the voice view opened — used to swallow the "ghost click" that a touch which opened the overlay (e.g. a Deck key firing on pointerup) sends straight through onto the just-shown voice view, which would otherwise interrupt/close it instantly

function _aiPlayWakeChime() {
  fetch('/api/chime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"wake"}' }).catch(() => {});
}
function _aiPlayCloseChime() {
  fetch('/api/chime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"close"}' }).catch(() => {});
}

// ── Voice mode UI (stylized animated conversation) ──────────────
function _aiVoiceModeEnter() {
  if (!aiPanelOpen) openAiPanel();
  document.body.classList.add('ai-voice-mode');
  // Ambient presentation (opt-in): keep the dashboard visible with only an edge
  // glow instead of the full opaque room. Read once per session on entry.
  document.body.classList.toggle('ai-voice-ambient',
    !!(typeof hubSettings !== 'undefined' && hubSettings && hubSettings.aiVoiceAmbient));
  _aiVoiceOpenedAt = Date.now(); // start the grace window (see _aiVoiceOpenedAt)
}
function _aiVoiceModeExit() {
  document.body.classList.remove('ai-voice-mode', 'ai-voice-ambient', 'voice-listening', 'voice-thinking', 'voice-speaking');
  ['ai-voice-user', 'ai-voice-reply', 'ai-voice-hint'].forEach(id => { const el = $(id); if (el) el.textContent = ''; });
}
function _aiVoiceState(state) {
  document.body.classList.remove('voice-listening', 'voice-thinking', 'voice-speaking');
  // "connecting" (the mic is opening) looks like thinking: busy, not yet listening.
  if (state) document.body.classList.add('voice-' + (state === 'connecting' ? 'thinking' : state));
  if (window.BitChat) BitChat.voiceState(state);
  const h = $('ai-voice-hint');
  if (!h) return;
  const tap = t('ai_tap_stop');
  h.textContent =
    state === 'connecting' ? t('ai_connecting') :
    state === 'listening' ? t('ai_state_listening') :
    state === 'thinking'  ? t('ai_state_thinking')  + tap :
    state === 'speaking'  ? t('ai_state_speaking')  + tap : '';
}

// Tap-to-interrupt: a touchscreen tap on the voice view stops everything
// instantly — TTS playback, any in-flight recording, and the session — without
// waiting for speech recognition. This is the reliable "stop" on a half-duplex
// headset where the spoken "stop" can't be heard over the assistant's own voice.
function _aiVoiceTapInterrupt() {
  if (!document.body.classList.contains('ai-voice-mode')) return;
  // Voce Live owns its own socket/audio lifecycle — a tap ends that session.
  if (typeof aiLiveTapInterrupt === 'function' && aiLiveTapInterrupt()) return;
  // Swallow the ghost click that opened the overlay (Deck keys fire on pointerup,
  // so the trailing click lands on the just-shown voice view and would close it).
  if (Date.now() - _aiVoiceOpenedAt < AI_VOICE_TAP_GRACE_MS) return;
  if (document.body.classList.contains('ai-picker-open')) return; // picker handles its own taps
  _aiLog('Voice tap → interrupt');
  aiListening = false;
  _aiStopSpeaking();             // stop TTS immediately (server /api/speak/stop)
  fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  _aiEndVoiceSession();
}
// Tap on the orb itself — stop TTS / recording and immediately start listening
// again, without closing the session or clearing conversation history.
async function _aiVoiceOrbTap() {
  if (!document.body.classList.contains('ai-voice-mode')) return;
  // In a Live session, an orb tap ends it (barge-in is automatic, so there's no
  // separate "restart listening" gesture to run).
  if (typeof aiLiveIsActive === 'function' && aiLiveIsActive()) { aiStopLiveSession(); return; }
  if (Date.now() - _aiVoiceOpenedAt < AI_VOICE_TAP_GRACE_MS) return; // ignore the opening ghost click
  if (document.body.classList.contains('ai-picker-open')) return;
  _aiLog('Orb tap → interrupt + restart listening');
  // Invalidate any in-flight transcription from the previous turn so its result
  // can't arrive and run a stale command after we restart listening.
  _aiVoiceGen++;
  // Stop any active recording (discard clip, no transcription)
  const rid = _aiServerRecordingId;
  _aiServerRecordingId = null;
  if (rid) fetch('/api/stt/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rid, key: '' }) }).catch(() => {});
  // Stop TTS
  _aiStopSpeaking();
  fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  // Mark listening=true immediately so any pending afterAnswer/followup callback
  // bails out and doesn't compete with the recorder we're about to open.
  aiListening = true;
  _aiActiveListen = true;   // user deliberately re-started this turn
  _aiEmptyRetries = 0;
  _aiPendingVoiceReply = '';
  _aiVoiceSetUser('');
  _aiVoiceState('connecting');
  _aiPlayWakeChime();
  await _aiStartServerRecorder();
  const capturedId = _aiServerRecordingId;
  if (capturedId) {
    setTimeout(() => {
      if (_aiServerRecordingId === capturedId) {
        _aiLog('OrbTap: auto-stop (max utterance)');
        _aiStopServerRecorder();
      }
    }, AI_MAX_UTTERANCE_MS);
  }
}
function _aiVoiceSetUser(text) {
  const u = $('ai-voice-user'); if (u) u.textContent = text || '';
  const r = $('ai-voice-reply'); if (r) r.textContent = '';
}
function _aiVoiceSetReply(text) {
  const r = $('ai-voice-reply');
  if (!r) return;
  const said = window.AiReplyChoices ? AiReplyChoices.spoken(text) : text;
  const clean = String(said || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '• ') // normalise raw bullet markers to a clean dot
    .replace(/\n{2,}/g, '\n')
    .trim();
  r.textContent = clean;
  // Long answers (e.g. a capability rundown) get a smaller, scrollable, left-
  // aligned treatment so they stay readable instead of overflowing the compact
  // voice view.
  r.classList.toggle('ai-voice-reply-long', clean.length > 200);
}

// A voice turn's failure belongs on the voice screen, where the user is looking;
// it stays up long enough to read, then the session closes (a tap closes it sooner).
function _aiVoiceShowError(msg) {
  const gen = _aiVoiceGen;
  _aiVoiceSetReply(msg);
  _aiVoiceState('');
  setTimeout(() => { if (gen === _aiVoiceGen && _aiVoiceSessionActive) _aiEndVoiceSession(); }, AI_VOICE_ERROR_HOLD_MS);
}
// A notice from the shared recorder: on the voice screen during a voice
// session, in the chat otherwise.
function _aiNotice(msg) {
  if (_aiVoiceSessionActive) _aiVoiceShowError(msg);
  else _aiAppendBubble('assistant', msg);
}

window._aiVoiceTapInterrupt = _aiVoiceTapInterrupt;
window._aiVoiceOrbTap       = _aiVoiceOrbTap;
