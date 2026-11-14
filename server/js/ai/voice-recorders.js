// Records the voice in the browser or through the server, and hands the recording to be
// transcribed.
'use strict';

let _aiMediaRecorder = null;
let _aiAudioChunks   = [];
let _aiServerRecordingId = null;

async function _aiStartMediaRecorder() {
  if (!navigator.mediaDevices) {
    _aiLog('PTT mediaDevices=undefined');
    _aiStartServerRecorder();
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    _aiLog('PTT MediaRecorder=undefined');
    _aiStartServerRecorder();
    return;
  }
  // Attiva il pulsante subito (feedback click), ma NON mostrare "Ascolto…" ancora —
  // la registrazione non è iniziata. "Ascolto…" appare solo quando il mic è aperto.
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.add('active');
  aiListening = true;
  document.body.classList.add('ai-listening');
  try {
    // Short timeout: on the Xenon Edge WebView getUserMedia never resolves, so we
    // fall back to server-side recording below.
    const ownStream = true;
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout microfono (300ms)')), 300)),
    ]);
    // Mic browser aperto — ora mostra "Ascolto…"
    setAiStatus('listening');
    _aiLog(`PTT stream ok: ownStream=${ownStream} tracks:${stream.getAudioTracks().map(t => t.label).join(',')}`);
    _aiAudioChunks = [];

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    _aiLog(`PTT mimeType="${mimeType || '(default)'}" MediaRecorder ok`);

    _aiMediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const recordedMime = _aiMediaRecorder.mimeType || mimeType || 'audio/webm';

    _aiMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _aiAudioChunks.push(e.data); };

    _aiMediaRecorder.onstop = async () => {
      if (ownStream) stream.getTracks().forEach(t => t.stop());
      aiListening = false;
      document.body.classList.remove('ai-listening');
      const btn2 = $('ai-voice-btn');
      if (btn2) btn2.classList.remove('active');
      _aiMediaRecorder = null;
      _aiLog(`PTT onstop chunks=${_aiAudioChunks.length}`);

      if (_aiAudioChunks.length === 0) { setAiStatus(''); return; }

      const blob = new Blob(_aiAudioChunks, { type: recordedMime });
      _aiAudioChunks = [];
      const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
      if (!_aiProviderReady() && _aiProviderCfg().provider === 'gemini') { setAiStatus(''); return; }

      setAiStatus('thinking');
      try {
        const base64 = await new Promise((res) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        const transcribeRes = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64, mimeType: recordedMime, key: apiKey, lang: (typeof lang !== 'undefined' && lang) || 'en', provider: _aiProviderCfg().provider }),
        });
        const { text, error } = await transcribeRes.json();
        if (error) throw new Error(error);
        if (text && text.trim()) {
          if (!aiPanelOpen) openAiPanel();
          aiSendMessage(text.trim(), true);
        } else {
          setAiStatus('');
        }
      } catch (err) {
        setAiStatus('');
        _aiAppendBubble('assistant', _aiFormatApiError(err));
      }
    };

    _aiMediaRecorder.start(250);
    // Auto-stop after 30 s to avoid runaway recording
    setTimeout(() => {
      if (_aiMediaRecorder && _aiMediaRecorder.state === 'recording') _aiMediaRecorder.stop();
    }, 30000);
  } catch (err) {
    _aiLog(`PTT errore: ${err.message}`);
    // Su Xenon Edge WebView il mic browser non è disponibile — usa registrazione server
    if (/timeout|not.allowed|notallowed|permission|denied/i.test(err.message)) {
      _aiLog('PTT: fallback a registrazione server');
      // Non resettare UI — _aiStartServerRecorder() gestisce lo stato
      _aiStartServerRecorder();
    } else {
      aiListening = false;
      document.body.classList.remove('ai-listening');
      const btnErr = $('ai-voice-btn');
      if (btnErr) btnErr.classList.remove('active');
      setAiStatus('');
      _aiAppendBubble('assistant', `Microfono: ${err.message}`);
    }
  }
}

// ── Server-side recording via Windows MCI ────────────────────────
// Used as fallback when getUserMedia is unavailable (e.g. Xenon Edge WebView).

// Frees the server recorder without using what it heard.
function _aiDropRecorder(id) {
  if (id) fetch('/api/stt/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, key: '' }) }).catch(() => {});
}

async function _aiStartServerRecorder() {
  const ticket = _aiRecorderCancel;
  aiListening = true;
  document.body.classList.add('ai-listening');
  // The chat's own mic button and status line speak for the chat only; a voice
  // session shows its state on the voice screen.
  const inChat = !_aiVoiceSessionActive;
  const btn = inChat ? $('ai-voice-btn') : null;
  if (btn) btn.classList.add('active');
  if (inChat) setAiStatus('connecting');
  try {
    const r = await fetch('/api/stt/start', { method: 'POST' });
    if (r.status === 409) {
      // Another tab already claimed the mic for this wake event — back off silently
      aiListening = false;
      document.body.classList.remove('ai-listening');
      if (btn) btn.classList.remove('active');
      setAiStatus('');
      // Close the just-opened session UI too: without this the losing tab is
      // stuck showing a live voice orb with no recorder behind it.
      if (_aiVoiceSessionActive) _aiEndVoiceSession();
      return;
    }
    const { id, error } = await r.json().catch(() => ({}));
    if (error || !id) throw new Error(error || 'no id');
    // Cancelled while the mic was opening: whoever cancelled has already reset the UI.
    if (ticket !== _aiRecorderCancel) {
      _aiDropRecorder(id);
      aiListening = false;
      _aiLog(`Server STT: annullata durante l'avvio, rilasciata id=${id}`);
      return;
    }
    _aiServerRecordingId = id;
    // Only now is the mic really recording: "listening" before this point told
    // people to talk while their first words were still being thrown away.
    if (inChat) setAiStatus('listening');
    else if (_aiVoiceSessionActive) _aiVoiceState('listening');
    _aiLog(`Server STT: registrazione avviata id=${id}`);
  } catch (err) {
    _aiLog(`Server STT: errore avvio: ${err.message}`);
    _aiServerRecordingId = null;
    aiListening = false;
    document.body.classList.remove('ai-listening');
    if (btn) btn.classList.remove('active');
    setAiStatus('');
    _aiNotice(`${t('ai_mic_unavailable')} ${err.message}`);
  }
}

async function _aiStopServerRecorder() {
  const id = _aiServerRecordingId;
  _aiServerRecordingId = null;
  if (!id) return;
  _aiLog(`Server STT: fermo registrazione id=${id}`);
  aiListening = false;
  document.body.classList.remove('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.remove('active');
  // Immediately switch the voice view out of "listening" so the user isn't
  // misled into repeating themselves while transcription/answering runs.
  if (_aiVoiceSessionActive) _aiVoiceState('thinking');
  // Capture the session generation: if the user closes/interrupts the session
  // while transcription is in flight, the result that arrives afterwards must be
  // discarded — otherwise a phantom clip could reopen the panel and run a command
  // (e.g. "apri Spotify") right after the user closed the voice chat.
  const wasVoice = _aiVoiceSessionActive;
  const myGen = _aiVoiceGen;
  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  if (!_aiProviderReady() && _aiProviderCfg().provider === 'gemini') { setAiStatus(''); return; }
  if (!wasVoice) setAiStatus('thinking');
  try {
    const uiLangForStt = (typeof lang !== 'undefined' && lang) || 'en';
    const r = await fetch('/api/stt/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, key: apiKey, mode: 'text', lang: uiLangForStt, provider: _aiProviderCfg().provider }),
    });
    // Session was closed/restarted during transcription — drop this result silently.
    if (wasVoice && myGen !== _aiVoiceGen) {
      _aiLog('Server STT: sessione chiusa durante la trascrizione → risultato scartato');
      return;
    }
    const { text, error } = await r.json().catch(() => ({}));
    if (error) throw new Error(error);
    const finalText = String(text || '').trim();
    _aiLog(`Server STT: text="${finalText}"`);

    if (finalText) {
      _aiEmptyRetries = 0; // heard something — reset the empty-capture counter
      if (!aiPanelOpen) openAiPanel();
      if (_aiVoiceSessionActive) {
        _aiPendingVoiceReply = '';
        _aiVoiceSetUser(finalText);
        _aiVoiceState('thinking');
      }
      aiSendMessage(finalText, true);
    } else if (_aiVoiceSessionActive) {
      // Nothing was captured. If the user deliberately started this turn, don't
      // silently close (the "it just hangs / doesn't hear me" complaint) — keep
      // listening a couple more times with visible feedback, then end with a clear
      // message pointing at the mic settings. An opportunistic follow-up just ends.
      if (_aiActiveListen && _aiEmptyRetries < AI_MAX_EMPTY_RETRIES) {
        _aiEmptyRetries++;
        _aiLog(`Server STT: empty capture, retry ${_aiEmptyRetries}/${AI_MAX_EMPTY_RETRIES}`);
        const hint = $('ai-voice-hint');
        if (hint) hint.textContent = t('ai_didnt_hear');
        _aiRetryActiveListen();
      } else {
        _aiEmptyRetries = 0;
        if (_aiActiveListen) _aiVoiceShowError(t('ai_didnt_hear_end'));
        else _aiEndVoiceSession();
      }
    } else {
      setAiStatus('');
    }
  } catch (err) {
    if (wasVoice && myGen !== _aiVoiceGen) return; // session gone — swallow the error too
    _aiLog(`Server STT: errore stop: ${err.message}`);
    setAiStatus('');
    _aiNotice(_aiFormatApiError(err));
  }
}
