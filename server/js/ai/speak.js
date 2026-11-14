// Reads the AI's answer aloud and stops when asked.
'use strict';

let aiSpeaking = false;

// ── Voice output (server-side) ───────────────────────────────────
// Speech is synthesized and played by the server (Windows SAPI) through the
// system speakers — instant and audible even when the WebView isn't focused.
// /api/speak resolves when speech finishes, so onDone can open the follow-up.

// Server signalled that audio playback just began — show the reply text and
// switch orb to "speaking" at the same instant.
function _aiOnSpeakStart() {
  if (!_aiVoiceSessionActive) return;
  if (_aiPendingPicker) {
    const screens = _aiPendingPicker; _aiPendingPicker = null;
    _aiShowVoiceMonitorPicker(screens);
    return;
  }
  if (document.body.classList.contains('ai-picker-open')) return;
  if (_aiPendingVoiceReply) {
    _aiVoiceSetReply(_aiPendingVoiceReply);
    _aiPendingVoiceReply = '';
  }
  _aiVoiceState('speaking');
}

function _aiStopSpeaking() {
  aiSpeaking = false;
  fetch('/api/speak/stop', { method: 'POST' }).catch(() => {});
}

function _aiSpeak(text, onDone) {
  let _doneCalled = false;
  let _guard = null;
  const finish = () => {
    if (_doneCalled) return;
    _doneCalled = true;
    if (_guard) { clearTimeout(_guard); _guard = null; }
    if (typeof onDone === 'function') onDone();
  };

  // Stop anything currently playing (barge-in / overlap)
  fetch('/api/speak/stop', { method: 'POST' }).catch(() => {});

  if (!text) { finish(); return; }
  const clean = text.replace(/[*_`#>~|\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!clean) { finish(); return; }

  aiSpeaking = true;
  // Safety net: never let the voice screen hang on "speaking" if /api/speak stalls.
  // MUST stay comfortably ABOVE the server's playback cap (see _playWavFile) so the
  // server — which alone knows when playback actually ends — is what drives onDone.
  // If this raced the server cap, it could fire mid-sentence and re-open the mic
  // while Xenon is still talking.
  _guard = setTimeout(() => { aiSpeaking = false; finish(); }, 45000);
  const uiLang = (typeof lang !== 'undefined' && lang) || 'en';
  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean, lang: uiLang, key: apiKey, provider: _aiProviderCfg().provider }),
  })
    .then(() => { aiSpeaking = false; finish(); })
    .catch(() => { aiSpeaking = false; finish(); });
}

window._aiOnSpeakStart     = _aiOnSpeakStart;
