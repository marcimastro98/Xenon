// A spoken conversation from the wake word to its end: listening again after each answer, and
// giving up after silence.
'use strict';

let _aiVoiceSessionActive = false; // true during an active voice session (button-triggered)
let _aiFollowupTimer      = null;  // auto-stop timer for the follow-up listening window
let _aiPendingVoiceReply  = '';    // reply text held until the server's speak_start fires
let _aiPendingPicker      = null;  // monitor screens held until speak_start, so the picker and the voice appear together
let _aiVoiceGen           = 0;     // bumped whenever a voice session ends/interrupts — a transcription that finishes after its session closed is discarded
let _aiActiveListen       = false; // true while waiting on a turn the user deliberately started (open/orb-tap) vs an opportunistic follow-up — drives the "didn't hear you, retry" behaviour

let _aiEmptyRetries       = 0;     // consecutive empty captures during active listening — retry a couple of times with feedback, then end with a clear message instead of silently hanging
const AI_FOLLOWUP_MS = 12000;
// Absolute safety cap for a single recording. The SERVER's silence detection is the
// real end-of-turn signal (it stops within ~2.5 s of you going quiet), so this only
// fires when no silence is ever detected — e.g. continuous speech or a noisy room.
// Kept long so a normal multi-second sentence is never cut off mid-word (the old 8 s
// cap was the "it stops listening while I'm still talking" bug).
const AI_MAX_UTTERANCE_MS = 30000;
const AI_MAX_EMPTY_RETRIES = 2;    // how many empty captures to forgive before ending an actively-started turn
const AI_VOICE_TAP_GRACE_MS = 500; // ignore tap-to-interrupt within this window after opening
const AI_VOICE_ERROR_HOLD_MS = 4500; // how long a voice-screen error stays up before the session closes

// Ends the voice session: clears the follow-up timer, drops the listening UI,
// and plays the closing chime so the user knows Xenon stopped without looking.
function _aiEndVoiceSession() {
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  _aiVoiceGen++;           // invalidate any in-flight transcription from this session
  // The session's recording goes with it, the one still opening too; dropping
  // only the id left ffmpeg running and every later mic tap refused.
  _aiRecorderCancel++;
  _aiDropRecorder(_aiServerRecordingId);
  _aiServerRecordingId = null;
  aiListening = false;
  _aiPendingPicker = null;
  _aiPcConfirmOpen = false; // clear the modal guard so it can't block a future session's mic
  _aiCloseMonitorPicker(); // close the monitor picker too, if open
  // Do NOT clear _aiPendingVoiceReply here: it is written by the current
  // aiSendMessage call (which set _aiSpeak in motion) and will be consumed by
  // the speak_start SSE handler. Clearing it here races with that handler and
  // causes the reply text to disappear mid-TTS-generation (intermittent blank
  // voice screen even though Xenon is speaking). It is cleared inside
  // _aiOnSpeakStart after being applied.
  const wasActive = _aiVoiceSessionActive;
  _aiVoiceSessionActive = false;
  document.body.classList.remove('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.remove('active');
  setAiStatus('');
  _aiVoiceModeExit();
  if (wasActive) {
    _aiPlayCloseChime();
    // Return to the normal dashboard — don't leave the chat panel open.
    closeAiPanel();
  }
}

// Server detected end-of-speech silence — stop the matching recording now so the
// assistant responds without waiting out the fixed window.
function _aiOnSttSilence(id) {
  if (id && _aiServerRecordingId === id) {
    _aiLog('STT: silence detected → stop early');
    _aiStopServerRecorder();
  }
}

// Re-opens listening for a short window after an answer so the user can ask a
// follow-up without repeating the wake word. Same chat, same history.
async function _aiStartFollowupListen() {
  if (!_aiVoiceSessionActive || aiListening) return;
  _aiActiveListen = false; // opportunistic listen — if the user says nothing, end quietly
  _aiPlayWakeChime();
  // Keep the last reply on screen while we wait for a follow-up (don't blank it),
  // just clear the user line. The reply is replaced once the user speaks again.
  const u = $('ai-voice-user'); if (u) u.textContent = '';
  // /api/speak resolves only after playback ends, so Xenon's own voice is
  // already over; the mic takes longer to open than the chime lasts, so the
  // chime is not recorded either. "Listening" shows once the mic is open.
  _aiVoiceState('connecting');
  await _aiStartServerRecorder();
  const capturedId = _aiServerRecordingId;
  if (!capturedId) { _aiEndVoiceSession(); return; }
  if (_aiFollowupTimer) clearTimeout(_aiFollowupTimer);
  _aiFollowupTimer = setTimeout(() => {
    if (_aiServerRecordingId === capturedId) {
      _aiLog('Follow-up: auto-stop');
      _aiStopServerRecorder();
    }
  }, AI_FOLLOWUP_MS);
}

// Re-opens the mic after an empty capture on a turn the user deliberately started,
// so a missed first word (or a slow start) gets another shot with visible feedback
// instead of the session silently closing. Mirrors the orb-tap restart but keeps
// the active-listen flag so the retry budget (AI_MAX_EMPTY_RETRIES) still applies.
async function _aiRetryActiveListen() {
  if (!_aiVoiceSessionActive) return;
  _aiActiveListen = true;
  aiListening = false;
  _aiPlayWakeChime();
  // Hold the "didn't catch that" hint long enough to read before re-opening the mic.
  await new Promise(r => setTimeout(r, 700));
  if (!_aiVoiceSessionActive) return;
  _aiVoiceSetUser('');
  _aiVoiceState('connecting');
  await _aiStartServerRecorder();
  const capturedId = _aiServerRecordingId;
  if (!capturedId) { _aiEndVoiceSession(); return; }
  setTimeout(() => {
    if (_aiServerRecordingId === capturedId) {
      _aiLog('Retry listen: auto-stop (max utterance)');
      _aiStopServerRecorder();
    }
  }, AI_MAX_UTTERANCE_MS);
}

// ── Button-triggered voice session ───────────────────────────────────────────
// Starts an immersive voice session (orb mode) programmatically from a button tap.

async function startVoiceSession() {
  // Voce Live (beta): full-duplex realtime path. Taken only when the toggle is on,
  // the provider is Gemini and a key is present; aiStartLiveSession() returns false
  // otherwise (or on any pre-flight failure) so we fall through to the turn-based
  // path, which stays the default and the fallback.
  if (hubSettings && hubSettings.aiLiveVoice === true && typeof aiStartLiveSession === 'function') {
    if (aiStartLiveSession()) return;
  }
  return startVoiceSessionTurnBased();
}

async function startVoiceSessionTurnBased() {
  if (aiListening) return;
  if (aiSpeaking) {
    _aiStopSpeaking();
    fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    _aiVoiceSessionActive = false;
    if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  }
  if (!_aiVoiceSessionActive) {
    aiConversationHistory = [];
    aiConversationSummary = '';
    aiToolGroups = [];
    _aiStickyDocs = null; _aiStickyAttach = []; _aiStickyTurns = 0;
    _aiLog('New voice session: history cleared');
  }
  _aiPendingVoiceReply = '';
  _aiVoiceSessionActive = true;
  _aiActiveListen = true;   // user deliberately opened the voice session
  _aiEmptyRetries = 0;
  // The chime and the recorder start together: opening the mic takes about a
  // second, longer than the chime, so the chime is over before recording begins
  // and "listening" shows the moment the mic is really open.
  _aiPlayWakeChime();
  _aiVoiceModeEnter();
  _aiVoiceSetUser('');
  _aiVoiceState('connecting');
  await _aiStartServerRecorder();
  const capturedId = _aiServerRecordingId;
  if (capturedId) {
    setTimeout(() => {
      if (_aiServerRecordingId === capturedId) {
        _aiLog('VoiceButton: auto-stop (max utterance)');
        _aiStopServerRecorder();
      }
    }, AI_MAX_UTTERANCE_MS);
  }
}

// Server-side "Hey Bit" wake word detected (SSE `wake` from main.js) — open
// a voice session unless one is already live or the assistant is mid-turn.
function _aiHandleWake() {
  if (_aiVoiceSessionActive || aiListening || aiSpeaking) return;
  startVoiceSession();
}

// Called from settings.js when the API key changes
function onAiKeyUpdated() {
  const chat = $('ai-chat');
  if (chat && _aiTalkNodes(chat).length <= 1) {
    _aiTalkNodes(chat).forEach((node) => node.remove());
    _aiRenderWelcomeIfEmpty();
  }
}

window.onAiKeyUpdated      = onAiKeyUpdated;

window.startVoiceSession   = startVoiceSession;
window._aiHandleWake       = _aiHandleWake;
window._aiOnSttSilence     = _aiOnSttSilence;
