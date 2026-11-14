// Starts and stops listening for a spoken message, and runs the microphone test.
'use strict';

let aiListening = false;
let aiRecognition = null;

// Bumped whenever a recording is cancelled or dropped. A recorder still opening
// at that moment (about a second) is let go when it answers, instead of running
// on unseen: the server takes one recording at a time, so an orphan made every
// later mic tap answer 409 until the 5-minute sweep.
let _aiRecorderCancel = 0;

// ── Push-to-talk voice input ─────────────────────────────────────

function aiToggleVoice() {
  _aiLog(`PTT toggle: aiListening=${aiListening} mediaDevices=${!!navigator.mediaDevices} MediaRecorder=${typeof MediaRecorder !== 'undefined'}`);
  if (aiListening) stopAiVoice();
  else startAiVoice();
}

function _aiLangTag() {
  const l = document.documentElement.lang || 'it';
  const map = { it: 'it-IT', en: 'en-US', ko: 'ko-KR', ja: 'ja-JP', zh: 'zh-CN' };
  return map[l] || 'it-IT';
}

function startAiVoice() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    _aiStartMediaRecorder(); // fallback: record → Gemini transcription
    return;
  }

  stopAiVoice();

  aiRecognition = new SpeechRec();
  aiRecognition.continuous = false;
  aiRecognition.interimResults = false;
  aiRecognition.lang = _aiLangTag();
  aiRecognition.maxAlternatives = 1;

  aiRecognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    if (transcript) {
      if (!aiPanelOpen) openAiPanel();
      aiSendMessage(transcript, true); // voice input → TTS reply
    }
  };

  const _onEnd = () => {
    aiListening = false;
    document.body.classList.remove('ai-listening');
    const btn = $('ai-voice-btn');
    if (btn) btn.classList.remove('active');
    setAiStatus('');
    aiRecognition = null;
  };

  aiRecognition.onend = _onEnd;
  aiRecognition.onerror = _onEnd;

  aiRecognition.start();
  aiListening = true;
  document.body.classList.add('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.add('active');
  setAiStatus('listening');
}

function stopAiVoice() {
  if (aiRecognition) {
    try { aiRecognition.abort(); } catch {}
    aiRecognition = null;
  }
  if (_aiMediaRecorder && _aiMediaRecorder.state !== 'inactive') {
    _aiMediaRecorder.stop(); // onstop handler takes over from here
    return;
  }
  if (_aiServerRecordingId) {
    _aiStopServerRecorder();
    return;
  }
  _aiRecorderCancel++;
  aiListening = false;
  document.body.classList.remove('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.remove('active');
  if ($('ai-status') && $('ai-status').className.includes('listening')) setAiStatus('');
}

// ── Microphone self-test ─────────────────────────────────────────
// Runs the EXACT server-side capture path the voice chat uses (ffmpeg via
// /api/stt/start + /api/stt/stop mode:'test') and reports the device + level, so
// a user can confirm in 3 seconds whether voice input actually hears them — and a
// bug report screenshot shows which device was captured and how loud it was. This
// is independent of the Mic panel's level meter, which reads the browser's mic
// (often a different device than the server records from). No API key needed.
let _aiMicTestRunning = false;
async function runAiMicTest() {
  if (_aiMicTestRunning) return;
  // Don't fight an in-flight voice turn — or a Voce Live session — for the mic.
  if (aiListening || _aiVoiceSessionActive || (typeof aiLiveIsActive === 'function' && aiLiveIsActive())) {
    _aiSetMicTestResult(t('ai_mictest_busy'), 'warn');
    return;
  }
  const btn = $('settings-mictest-btn');
  _aiMicTestRunning = true;
  if (btn) btn.disabled = true;
  let id = null;
  try {
    const r = await fetch('/api/stt/start', { method: 'POST' });
    if (r.status === 409) { _aiSetMicTestResult(t('ai_mictest_busy'), 'warn'); return; }
    const started = await r.json().catch(() => ({}));
    if (started.error || !started.id) throw new Error(started.error || 'no id');
    id = started.id;
    // Count down ~3s while the user speaks.
    for (let s = 3; s >= 1; s--) {
      _aiSetMicTestResult(`${t('ai_mictest_recording')} ${s}`, 'rec');
      await new Promise(res => setTimeout(res, 1000));
    }
    const stopRes = await fetch('/api/stt/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, mode: 'test' }),
    });
    id = null; // consumed by the server
    const d = await stopRes.json().catch(() => ({}));
    if (d.error) throw new Error(d.error);
    const dev = `${d.device || '?'} · ${Number.isFinite(d.db) ? d.db : '?'} dB`;
    if (d.heard) {
      _aiSetMicTestResult(`✓ ${t('ai_mictest_heard')}: ${dev}`, 'ok');
    } else {
      _aiSetMicTestResult(`✕ ${t('ai_mictest_notheard')}: ${dev}. ${t('ai_mictest_fix')}`, 'warn');
    }
  } catch (err) {
    _aiLog(`Mic test error: ${err.message}`);
    // Best-effort release the recorder if we errored mid-capture.
    if (id) fetch('/api/stt/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, mode: 'test' }) }).catch(() => {});
    _aiSetMicTestResult(`${t('ai_mictest_error')}: ${err.message}`, 'warn');
  } finally {
    _aiMicTestRunning = false;
    if (btn) btn.disabled = false;
  }
}

function _aiSetMicTestResult(text, kind) {
  const el = $('settings-mictest-result');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'settings-mictest-result' + (kind ? ` is-${kind}` : '');
}

window.aiToggleVoice       = aiToggleVoice;

window.runAiMicTest         = runAiMicTest;
