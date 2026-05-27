'use strict';

// ── Xenon AI Module ─────────────────────────────────────────────
// Gemini 2.5 Flash via POST /api/ai
// Web Speech API for voice input + wake word ("Hey Xenon")
// SpeechSynthesis for TTS output — only speaks on voice input, never on text chat
// Siri 2026 animated border on ai-siri-ring element

const AI_MAX_HISTORY = 40;

function _aiFormatApiError(err) {
  const msg = (err && err.message) || String(err || '');
  const isKeyError   = /API_KEY|api key|invalid key/i.test(msg);
  const isQuotaError = /quota|rate.?limit|429|free_tier/i.test(msg);
  const retryMatch   = msg.match(/retry in ([\d.]+)s/i);
  const retryAfter   = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
  if (isKeyError) return t('ai_key_invalid');
  if (isQuotaError) {
    const detail = retryAfter
      ? t('ai_quota_retry_in').replace('{n}', retryAfter)
      : t('ai_quota_wait');
    return `${t('ai_quota_limit')} ${detail}\n${t('ai_quota_hint')}`;
  }
  return `${t('ai_error_prefix')} ${msg}`;
}

function _aiLog(msg) {
  console.log('[XenonAI]', msg);
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {});
}

let aiPanelOpen = false;
let aiConversationHistory = [];
let aiListening = false;
let aiRecognition = null;
let aiWakeRecognition = null;
let aiWakeActive = false;
let aiSpeaking = false;
let _aiCurrentAudio = null;
let _aiPendingImages  = []; // [{mimeType, data, previewUrl, fromScreenMode?}]
let _aiScreenMode    = false;
let _aiScreenMonitor = null;
let _aiMediaRecorder = null;
let _aiAudioChunks   = [];
let _aiVadStream     = null;
let _aiVadCtx        = null;
let _aiVadInterval   = null;
let _aiVadTranscribing = false;
let _aiServerRecordingId = null;
let _aiClientWakeFailed  = false; // set when getUserMedia times out in iCUE WebView — stops retry loop
let _aiVoiceSessionActive = false; // true between wake word and session auto-close (follow-up window)
let _aiFollowupTimer      = null;  // auto-stop timer for the follow-up listening window
const AI_FOLLOWUP_MS = 5000;       // keep listening this long after an answer for a follow-up question

// ── Panel control ────────────────────────────────────────────────

function toggleAiPanel() {
  if (aiPanelOpen) closeAiPanel();
  else openAiPanel();
}

function openAiPanel() {
  const overlay = $('ai-overlay');
  if (!overlay) return;
  aiPanelOpen = true;
  overlay.hidden = false;
  document.body.classList.add('ai-open');
  _aiRenderWelcomeIfEmpty();
  const input = $('ai-text-input');
  if (input) setTimeout(() => input.focus(), 60);
}

function closeAiPanel() {
  const overlay = $('ai-overlay');
  if (overlay) overlay.hidden = true;
  aiPanelOpen = false;
  document.body.classList.remove('ai-open');
  // Cancel any pending follow-up listening window (manual close → no chime)
  _aiVoiceSessionActive = false;
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  _aiStopSpeaking();
  _aiVoiceModeExit();
  stopAiVoice();
  // Deactivate screen mode when panel closes
  _aiScreenMode = false;
  _aiScreenMonitor = null;
  _aiUpdateScreenBtn();
}

function aiClearHistory() {
  aiConversationHistory = [];
  const chat = $('ai-chat');
  if (chat) chat.replaceChildren();
  _aiRenderWelcomeIfEmpty();
  setAiStatus('');
}

function _aiRenderWelcomeIfEmpty() {
  const chat = $('ai-chat');
  if (!chat || chat.children.length > 0) return;
  const hasKey = hubSettings && hubSettings.geminiApiKey;
  _aiAppendBubble('assistant', t(hasKey ? 'ai_welcome' : 'ai_welcome_no_key'));
}

// ── Sending messages ─────────────────────────────────────────────

function aiSendText() {
  const input = $('ai-text-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  aiSendMessage(text, false); // text input: no TTS
}

function aiHandleKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    aiSendText();
  }
}

// fromVoice=true → speak the reply aloud; false (text chat) → silent
async function aiSendMessage(userText, fromVoice) {
  const text = String(userText || '').trim();
  if (!text && _aiPendingImages.length === 0) return;

  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  if (!apiKey) {
    _aiAppendBubble('assistant', 'API key mancante. Aggiungila in Impostazioni → Xenon AI.');
    return;
  }

  // If screen mode is active, replace the previous auto-screenshot with a fresh one
  if (_aiScreenMode) {
    _aiPendingImages = _aiPendingImages.filter(img => !img.fromScreenMode);
    await _aiDoCapture(_aiScreenMonitor, true);
  }

  // Capture and clear pending images before any async ops
  const imageParts = _aiPendingImages.map(({ mimeType, data }) => ({ mimeType, data }));
  _aiPendingImages = [];
  _aiUpdateAttachPreview();

  if (text) _aiAppendBubble('user', text, imageParts.map(p => p)); // show with image count indicator
  else _aiAppendBubble('user', '📎 ' + (imageParts.length > 1 ? `${imageParts.length} immagini` : '1 immagine'));

  setAiStatus('thinking');
  document.body.classList.add('ai-active');

  // Only store text in history (skip images — too large for repeated context)
  if (text) {
    aiConversationHistory.push({ role: 'user', parts: [{ text }] });
  } else {
    aiConversationHistory.push({ role: 'user', parts: [{ text: '[immagine allegata]' }] });
  }
  if (aiConversationHistory.length > AI_MAX_HISTORY) {
    aiConversationHistory = aiConversationHistory.slice(-AI_MAX_HISTORY);
  }

  try {
    const response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: apiKey,
        messages: aiConversationHistory,
        ...(imageParts.length > 0 ? { imageParts } : {}),
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = (data && data.error) ? data.error : `Errore HTTP ${response.status}`;
      throw new Error(errMsg);
    }

    if (Array.isArray(data.clientActions)) {
      for (const action of data.clientActions) {
        _aiExecuteClientAction(action.action, action.args || {});
      }
    }

    if (data.newContent) {
      aiConversationHistory.push(data.newContent);
    } else if (data.text) {
      aiConversationHistory.push({ role: 'model', parts: [{ text: data.text }] });
    }

    const replyText = data.text || '';
    if (replyText) {
      _aiAppendBubble('assistant', replyText);
      const ttsOn = hubSettings && hubSettings.aiTtsEnabled === true;
      if (fromVoice) {
        if (_aiVoiceSessionActive) { _aiVoiceSetReply(replyText); _aiVoiceState('speaking'); }
        // After speaking, close the session cleanly. We deliberately do NOT
        // re-open the mic for a follow-up: with a headset the speaker bleeds
        // into the mic, which desynced the UI ("listening" while still talking)
        // and produced bogus transcriptions. To continue, the user says "Xenon"
        // again, or taps the screen to interrupt at any moment.
        const afterAnswer = () => { if (_aiVoiceSessionActive) _aiEndVoiceSession(); };
        if (ttsOn) _aiSpeak(replyText, afterAnswer);
        else setTimeout(afterAnswer, 600);
      }
    } else if (fromVoice && _aiVoiceSessionActive) {
      _aiEndVoiceSession();
    }

    setAiStatus('');
  } catch (e) {
    const msg = _aiFormatApiError(e);
    _aiAppendBubble('assistant', msg);
    setAiStatus('error');
    setTimeout(() => setAiStatus(''), 3500);
    // Close the voice session on error so it doesn't hang waiting for a follow-up.
    if (fromVoice && _aiVoiceSessionActive) _aiEndVoiceSession();
  } finally {
    document.body.classList.remove('ai-active');
  }
}

function _aiExecuteClientAction(action, args) {
  switch (action) {
    case 'open_weather_panel':
      if (typeof toggleWeatherDetails === 'function') toggleWeatherDetails();
      break;
    case 'open_settings':
      if (typeof toggleSettings === 'function') toggleSettings();
      break;
    case 'open_app_switcher':
      if (typeof toggleAppSwitcher === 'function') toggleAppSwitcher();
      break;
    case 'show_lock_screen':
      if (typeof toggleWidgetLockScreen === 'function') toggleWidgetLockScreen();
      break;
    case 'change_theme':
      if (typeof setThemePreset === 'function' && args.preset) {
        setThemePreset(String(args.preset).toLowerCase());
      }
      break;
    case 'close_ai_panel':
      closeAiPanel();
      break;
    case 'refresh_tasks':
      if (typeof loadTasks === 'function') loadTasks();
      break;
    case 'refresh_calendar':
      if (typeof loadCalendarEvents === 'function') loadCalendarEvents();
      if (typeof renderUpcoming === 'function') renderUpcoming();
      break;
    case 'refresh_notes':
      if (typeof loadNotes === 'function') loadNotes();
      break;
    case 'refresh_timers':
      if (typeof loadTimers === 'function') loadTimers();
      break;
    case 'show_monitor_picker':
      _aiShowVoiceMonitorPicker(args.screens || []);
      break;
  }
}

// ── Markdown rendering ────────────────────────────────────────────
// Converts AI markdown to safe HTML for assistant chat bubbles.
// Only used for assistant messages — user text is always escaped.

function _escHtmlAI(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _inlineMarkdown(line) {
  // Process bold, italic, inline code in order (no nesting to keep it simple)
  return _escHtmlAI(line)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="ai-link">$1</a>');
}

function _aiRenderMarkdown(raw) {
  const lines = String(raw || '').split('\n');
  const out = [];
  let inList = false;
  let inOrderedList = false;

  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
    if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr class="ai-hr">'); continue; }

    // Headers
    const h4 = line.match(/^####\s+(.*)/);
    if (h4) { closeList(); out.push(`<h4 class="ai-h4">${_inlineMarkdown(h4[1])}</h4>`); continue; }
    const h3 = line.match(/^###\s+(.*)/);
    if (h3) { closeList(); out.push(`<h3 class="ai-h3">${_inlineMarkdown(h3[1])}</h3>`); continue; }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) { closeList(); out.push(`<h2 class="ai-h3">${_inlineMarkdown(h2[1])}</h2>`); continue; }

    // Unordered list
    const ul = line.match(/^[-*+]\s+(.*)/);
    if (ul) {
      if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
      if (!inList) { out.push('<ul class="ai-ul">'); inList = true; }
      out.push(`<li>${_inlineMarkdown(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\d+\.\s+(.*)/);
    if (ol) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (!inOrderedList) { out.push('<ol class="ai-ol">'); inOrderedList = true; }
      out.push(`<li>${_inlineMarkdown(ol[1])}</li>`);
      continue;
    }

    closeList();

    // Blank line → paragraph break
    if (line.trim() === '') { out.push('<br>'); continue; }

    // Regular paragraph line
    out.push(`<p class="ai-p">${_inlineMarkdown(line)}</p>`);
  }

  closeList();
  return out.join('');
}

// ── Chat UI helpers ──────────────────────────────────────────────

function _aiAppendBubble(role, text, imagesToShow) {
  const chat = $('ai-chat');
  if (!chat) return;
  const msg = document.createElement('div');
  msg.className = `ai-msg ai-msg-${role}`;
  const bubble = document.createElement('span');
  bubble.className = 'ai-msg-bubble';
  if (imagesToShow && imagesToShow.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'ai-bubble-images';
    imagesToShow.forEach(img => {
      if (!img || !img.data) return;
      const im = document.createElement('img');
      im.className = 'ai-bubble-img';
      im.src = `data:${img.mimeType};base64,${img.data}`;
      im.alt = 'immagine allegata';
      strip.appendChild(im);
    });
    bubble.appendChild(strip);
  }
  if (text) {
    const t = document.createElement('span');
    if (role === 'assistant') {
      // Assistant messages: render markdown safely
      t.className = 'ai-msg-markdown';
      t.innerHTML = _aiRenderMarkdown(text);
    } else {
      t.textContent = text;
    }
    bubble.appendChild(t);
  }
  msg.appendChild(bubble);
  chat.appendChild(msg);
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
}

function setAiStatus(state) {
  const el = $('ai-status');
  if (!el) return;
  el.className = 'ai-status' + (state ? ` ai-status-${state}` : '');
  if (state === 'thinking') {
    el.innerHTML = '<span class="ai-thinking-dots"><span></span><span></span><span></span></span>';
  } else if (state === 'connecting') {
    el.textContent = '⏳ Apertura microfono…';
  } else if (state === 'listening') {
    el.textContent = '🎙 Parla ora — tocca di nuovo per fermare';
  } else {
    el.textContent = '';
  }
}

// ── Push-to-talk voice input ─────────────────────────────────────

function aiToggleVoice() {
  _aiLog(`PTT toggle — aiListening=${aiListening} mediaDevices=${!!navigator.mediaDevices} MediaRecorder=${typeof MediaRecorder !== 'undefined'}`);
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
  aiListening = false;
  document.body.classList.remove('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.remove('active');
  if ($('ai-status') && $('ai-status').className.includes('listening')) setAiStatus('');
}

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
    // Riusa lo stream del VAD se attivo — evita conflitto su doppio getUserMedia
    const ownStream = !(_aiVadStream && _aiVadStream.active);
    let stream;
    if (ownStream) {
      // Timeout breve: su Xenon Edge WebView getUserMedia non risponde mai
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout microfono (300ms)')), 300)),
      ]);
    } else {
      stream = _aiVadStream;
    }
    // Mic browser aperto — ora mostra "Ascolto…"
    setAiStatus('listening');
    _aiLog(`PTT stream ok — ownStream=${ownStream} tracks:${stream.getAudioTracks().map(t => t.label).join(',')}`);
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
      if (!apiKey) { setAiStatus(''); return; }

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
          body: JSON.stringify({ audio: base64, mimeType: recordedMime, key: apiKey }),
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

async function _aiStartServerRecorder() {
  aiListening = true;
  document.body.classList.add('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.add('active');
  setAiStatus('connecting');
  try {
    const r = await fetch('/api/stt/start', { method: 'POST' });
    if (r.status === 409) {
      // Another tab already claimed the mic for this wake event — back off silently
      aiListening = false;
      document.body.classList.remove('ai-listening');
      if (btn) btn.classList.remove('active');
      setAiStatus('');
      return;
    }
    const { id, error } = await r.json().catch(() => ({}));
    if (error || !id) throw new Error(error || 'no id');
    _aiServerRecordingId = id;
    // Solo ORA la registrazione è confermata — l'utente può parlare
    setAiStatus('listening');
    _aiLog(`Server STT: registrazione avviata id=${id}`);
  } catch (err) {
    _aiLog(`Server STT: errore avvio: ${err.message}`);
    _aiServerRecordingId = null;
    aiListening = false;
    document.body.classList.remove('ai-listening');
    if (btn) btn.classList.remove('active');
    setAiStatus('');
    _aiAppendBubble('assistant', `Microfono non disponibile: ${err.message}`);
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
  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  if (!apiKey) { setAiStatus(''); return; }
  setAiStatus('thinking');
  try {
    const r = await fetch('/api/stt/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, key: apiKey }),
    });
    const { text, error } = await r.json().catch(() => ({}));
    _aiLog(`Server STT: trascrizione="${text}" err=${error || 'nessuno'}`);
    if (error) throw new Error(error);
    const trimmed = (text || '').trim();
    if (trimmed && _aiIsStopCommand(trimmed)) {
      _aiLog('Comando STOP rilevato → chiudo sessione');
      _aiStopSpeaking();
      _aiEndVoiceSession();
      closeAiPanel();
    } else if (trimmed && _aiIsLikelyNoise(trimmed)) {
      // Gemini sometimes hallucinates placeholder text ("00:00", ".", etc.) on
      // near-silent follow-up recordings. Ignore it so we don't fire bogus
      // actions (e.g. starting a 00:00 timer) the user never asked for.
      _aiLog(`Trascrizione scartata come rumore: "${trimmed}"`);
      if (_aiVoiceSessionActive) _aiEndVoiceSession();
      else setAiStatus('');
    } else if (trimmed) {
      if (!aiPanelOpen) openAiPanel();
      if (_aiVoiceSessionActive) { _aiVoiceSetUser(trimmed); _aiVoiceState('thinking'); }
      aiSendMessage(trimmed, true);
    } else {
      // No speech captured — if we were in a follow-up window, close the session.
      if (_aiVoiceSessionActive) _aiEndVoiceSession();
      else setAiStatus('');
    }
  } catch (err) {
    _aiLog(`Server STT: errore stop: ${err.message}`);
    setAiStatus('');
    _aiAppendBubble('assistant', _aiFormatApiError(err));
  }
  // Wake word detection runs on the server (SSE) — nothing to restart here.
}

// ── Always-listening wake word ("Hey Xenon") ─────────────────────

// Soft two-note "wake" chime so the user knows Xenon activated without looking.
// Generated with the Web Audio API — no external audio file needed.
let _aiAudioCtx = null;

// Create and try to resume the AudioContext eagerly. In iCUE WebView the
// autoplay restriction is relaxed — an eager resume succeeds without a gesture.
// In a regular browser it fails silently and the gesture-based unlock handles it.
function _aiGetAudioCtx() {
  if (!_aiAudioCtx) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        _aiAudioCtx = new Ctx();
        if (_aiAudioCtx.state === 'suspended') _aiAudioCtx.resume().catch(() => {});
      }
    } catch {}
  }
  return _aiAudioCtx;
}
// Kick off on script load so audio is warm when the wake word fires.
if (document.readyState !== 'loading') { setTimeout(_aiGetAudioCtx, 0); }
else { document.addEventListener('DOMContentLoaded', () => setTimeout(_aiGetAudioCtx, 0)); }
// Warm up SpeechSynthesis voices (loaded async) so the fallback can pick a good one.
if (window.speechSynthesis) { try { window.speechSynthesis.getVoices(); } catch {} }

// Chimes play server-side (through the system speakers) so they're audible
// regardless of which window has focus — the WebView blocks browser audio
// without a user gesture.
function _aiPlayWakeChime() {
  fetch('/api/chime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"wake"}' }).catch(() => {});
}
function _aiPlayCloseChime() {
  fetch('/api/chime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"close"}' }).catch(() => {});
}

// True when the user just wants to dismiss the assistant ("stop", "basta"…).
// Matched only for short utterances so it doesn't trip on a real question that
// merely contains the word.
function _aiIsStopCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.,!?;:]/g, '');
  if (!t || t.split(/\s+/).length > 3) return false;
  return /\b(stop|basta|ferma|fermati|fermo|fermate|esci|chiudi|chiuditi|spegniti|spegni|zitto|taci|quit|exit|close|cancel|cancella|stop xenon|ferma xenon|grazie xenon|grazie basta)\b/.test(t);
}

// Detects transcriptions that are almost certainly hallucinated noise rather
// than a real command/question — e.g. "00:00", ".", "...", a lone digit/symbol.
// Used to discard bogus follow-up transcriptions before they reach the AI.
function _aiIsLikelyNoise(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  // Only digits, colons, dots, dashes, spaces (e.g. "00:00", "0.0", "- -")
  if (/^[\d:.\-\s]+$/.test(t)) return true;
  // No letters at all (pure punctuation/symbols)
  if (!/[\p{L}]/u.test(t)) return true;
  return false;
}

// ── Voice mode UI (stylized animated conversation) ──────────────
function _aiVoiceModeEnter() {
  if (!aiPanelOpen) openAiPanel();
  document.body.classList.add('ai-voice-mode');
}
function _aiVoiceModeExit() {
  document.body.classList.remove('ai-voice-mode', 'voice-listening', 'voice-thinking', 'voice-speaking');
  ['ai-voice-user', 'ai-voice-reply', 'ai-voice-hint'].forEach(id => { const el = $(id); if (el) el.textContent = ''; });
}
function _aiVoiceState(state) {
  document.body.classList.remove('voice-listening', 'voice-thinking', 'voice-speaking');
  if (state) document.body.classList.add('voice-' + state);
  const h = $('ai-voice-hint');
  if (!h) return;
  const it = (typeof lang !== 'undefined' && lang === 'it');
  const tap = it ? ' · tocca per fermare' : ' · tap to stop';
  h.textContent =
    state === 'listening' ? (it ? 'Ti ascolto…'      : 'Listening…') :
    state === 'thinking'  ? (it ? 'Sto pensando…'    : 'Thinking…')  + tap :
    state === 'speaking'  ? (it ? 'Xenon parla…'     : 'Xenon speaking…') + tap : '';
}

// Tap-to-interrupt: a touchscreen tap on the voice view stops everything
// instantly — TTS playback, any in-flight recording, and the session — without
// waiting for speech recognition. This is the reliable "stop" on a half-duplex
// headset where the spoken "stop" can't be heard over the assistant's own voice.
function _aiVoiceTapInterrupt() {
  if (!document.body.classList.contains('ai-voice-mode')) return;
  if (document.body.classList.contains('ai-picker-open')) return; // picker handles its own taps
  _aiLog('Voice tap → interrupt');
  const rid = _aiServerRecordingId;
  _aiServerRecordingId = null;   // discard any in-flight recording (don't transcribe it)
  aiListening = false;
  // Free the server recorder (stops ffmpeg + cleans up). Empty key → no transcription.
  if (rid) fetch('/api/stt/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rid, key: '' }) }).catch(() => {});
  _aiStopSpeaking();             // stop TTS immediately (server /api/speak/stop)
  fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  _aiEndVoiceSession();
}
function _aiVoiceSetUser(text) {
  const u = $('ai-voice-user'); if (u) u.textContent = text || '';
  const r = $('ai-voice-reply'); if (r) r.textContent = '';
}
function _aiVoiceSetReply(text) {
  const r = $('ai-voice-reply');
  if (r) r.textContent = String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .trim();
}

// Ends the voice session: clears the follow-up timer, drops the listening UI,
// and plays the closing chime so the user knows Xenon stopped without looking.
function _aiEndVoiceSession() {
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  const wasActive = _aiVoiceSessionActive;
  _aiVoiceSessionActive = false;
  document.body.classList.remove('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.remove('active');
  setAiStatus('');
  _aiVoiceModeExit();
  if (wasActive) _aiPlayCloseChime();
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
  _aiPlayWakeChime();
  _aiVoiceSetUser('');
  _aiVoiceState('listening');
  await _aiStartServerRecorder();
  const capturedId = _aiServerRecordingId;
  if (!capturedId) { _aiEndVoiceSession(); return; }
  if (_aiFollowupTimer) clearTimeout(_aiFollowupTimer);
  _aiFollowupTimer = setTimeout(() => {
    if (_aiServerRecordingId === capturedId) {
      _aiLog('Follow-up: auto-stop 7s');
      _aiStopServerRecorder();
    }
  }, AI_FOLLOWUP_MS);
}

// The wake word fires from an SSE event (no user gesture), so browser autoplay
// policy would block both the chime and the TTS voice. We unlock audio output on
// the user's first interaction with the page and keep the AudioContext warm.
let _aiAudioUnlocked = false;
function _aiUnlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      if (!_aiAudioCtx) _aiAudioCtx = new Ctx();
      if (_aiAudioCtx.state === 'suspended') _aiAudioCtx.resume().catch(() => {});
    }
  } catch {}
  if (_aiAudioUnlocked) return;
  _aiAudioUnlocked = true;
  // Prime HTML <audio> playback so a later programmatic .play() (TTS) is allowed
  try {
    const a = new Audio();
    a.muted = true;
    const p = a.play();
    if (p && p.then) p.then(() => a.pause()).catch(() => {});
  } catch {}
}
['pointerdown', 'touchstart', 'click', 'keydown'].forEach(ev =>
  document.addEventListener(ev, _aiUnlockAudio, { passive: true, capture: true }));

// Called when wake word fires. Stops the wake word recognizer (Chrome allows only
// one SpeechRecognition at a time) and starts server recording with 8s auto-stop.
async function _aiWakeWordTrigger() {
  if (aiListening) return;
  // Barge-in: if Xenon is speaking, interrupt immediately and start a new session.
  if (aiSpeaking) {
    _aiStopSpeaking();
    fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    _aiVoiceSessionActive = false;
    if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  }
  _aiVoiceSessionActive = true;
  _aiPlayWakeChime();
  _aiVoiceModeEnter();
  _aiVoiceSetUser('');
  _aiVoiceState('listening');
  // Free the mic: abort wake word SpeechRecognition before starting server recording
  if (aiWakeRecognition) {
    try { aiWakeRecognition.abort(); } catch {}
    aiWakeRecognition = null;
  }
  await _aiStartServerRecorder();
  // Auto-stop so the user doesn't need to press a button
  const capturedId = _aiServerRecordingId;
  if (capturedId) {
    setTimeout(() => {
      if (_aiServerRecordingId === capturedId) {
        _aiLog('WakeWord: auto-stop 6s');
        _aiStopServerRecorder();
      }
    }, 6000);
  }
}

// Wake word detection lives entirely on the SERVER (ffmpeg captures the mic and
// asks Gemini; on a match it broadcasts the `wake_word` SSE event, which calls
// _aiWakeWordTrigger here). The old client-side SpeechRecognition/VAD path is
// disabled: it caused mic contention with the server recorder and timed out in
// the iCUE WebView (getUserMedia unavailable). Kept as a no-op so existing
// callers stay harmless.
function startAiWakeWord() {
  // Intentionally does nothing — server SSE drives wake word.
}

function stopAiWakeWord() {
  aiWakeActive = false;
  if (aiWakeRecognition) {
    try { aiWakeRecognition.abort(); } catch {}
    aiWakeRecognition = null;
  }
  if (_aiVadInterval) { clearInterval(_aiVadInterval); _aiVadInterval = null; }
  if (_aiVadStream) { _aiVadStream.getTracks().forEach(t => t.stop()); _aiVadStream = null; }
  if (_aiVadCtx) { _aiVadCtx.close().catch(() => {}); _aiVadCtx = null; }
}

async function _aiStartVadWakeWord() {
  try {
    _aiVadStream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 5000)),
    ]);
    _aiLog('VAD mic OK tracks:' + _aiVadStream.getAudioTracks().map(t => t.label).join(', '));
  } catch (err) {
    _aiLog('VAD getUserMedia fallito: ' + err.message);
    if (err.message === 'Timeout') _aiClientWakeFailed = true; // permanent in iCUE WebView
    aiWakeActive = false;
    return;
  }

  _aiVadCtx = new (window.AudioContext || window.webkitAudioContext)();
  await _aiVadCtx.resume();
  _aiLog('VAD AudioContext state:' + _aiVadCtx.state);

  // Chrome può tenere il context sospeso finché non c'è un gesto utente —
  // riprova al primo click/tasto
  const _vadResume = () => { if (_aiVadCtx && _aiVadCtx.state !== 'running') _aiVadCtx.resume().catch(() => {}); };
  document.addEventListener('click', _vadResume);
  document.addEventListener('keydown', _vadResume);

  const source = _aiVadCtx.createMediaStreamSource(_aiVadStream);
  const analyser = _aiVadCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);

  const THRESHOLD = 15;
  const SILENCE_MS = 700;
  const MAX_RECORD_MS = 7000;

  let recorder = null;
  let chunks = [];
  let recMime = '';
  let speechAt = 0;
  let silenceAt = 0;
  let _dbgTick = 0;

  _aiVadInterval = setInterval(() => {
    if (!aiWakeActive) { clearInterval(_aiVadInterval); _aiVadInterval = null; return; }
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += (buf[i] - 128) ** 2;
    const rms = Math.sqrt(sum / buf.length);
    const isSpeech = rms > THRESHOLD;
    const now = Date.now();

    if (++_dbgTick % 40 === 0)
      console.log(`[XenonAI VAD] rms=${rms.toFixed(1)} soglia=${THRESHOLD} ctx=${_aiVadCtx.state} rec=${!!recorder}`);

    if (isSpeech) {
      silenceAt = 0;
      if (!recorder && !aiListening) { // non registrare se push-to-talk è attivo
        speechAt = now;
        _aiLog('VAD voce rilevata, avvio registrazione...');
        chunks = [];
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
        recorder = new MediaRecorder(_aiVadStream, mime ? { mimeType: mime } : {});
        recMime = recorder.mimeType || 'audio/webm';
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        const _c = chunks, _m = recMime, _t = speechAt;
        recorder.onstop = () => { _aiVadCheckWake(_c, _m, Date.now() - _t); recorder = null; };
        recorder.start(200);
      }
    } else if (recorder) {
      if (!silenceAt) silenceAt = now;
      if ((now - silenceAt) > SILENCE_MS || (now - speechAt) > MAX_RECORD_MS) {
        _aiLog('VAD silenzio, fermo registrazione...');
        recorder.stop();
      }
    }
  }, 50);
}

async function _aiVadCheckWake(chunks, mime, durationMs) {
  _aiLog(`VAD checkWake chunks=${chunks.length} durata=${durationMs}ms transcribing=${_aiVadTranscribing}`);
  if (!aiWakeActive || chunks.length === 0 || durationMs < 200 || _aiVadTranscribing) return;
  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  if (!apiKey) { _aiLog('VAD API key mancante'); return; }
  _aiVadTranscribing = true;
  try {
    const blob = new Blob(chunks, { type: mime });
    const base64 = await new Promise((res) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result.split(',')[1]);
      reader.readAsDataURL(blob);
    });
    const r = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64, mimeType: mime, key: apiKey }),
    });
    const { text, error } = await r.json().catch(() => ({}));
    _aiLog(`VAD trascrizione: "${text}" errore:${error || 'nessuno'}`);
    if (text && aiWakeActive) {
      const tLow = text.trim().toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ');
      const WAKE = ['hey xenon', 'hey xeneon', 'ei xenon', 'hey zenon', 'hey senon', 'xenon hey', 'ok xenon', 'hey xeno', 'xeneon', 'xenon'];
      const matched = WAKE.some(w => tLow.includes(w));
      _aiLog(`VAD tLow="${tLow}" match=${matched}`);
      if (matched) {
        _aiWakeWordTrigger();
      }
    }
  } catch (err) {
    _aiLog('VAD errore trascrizione: ' + err.message);
  } finally {
    _aiVadTranscribing = false;
  }
}

// Called from settings.js when the API key changes
function onAiKeyUpdated() {
  const hasKey = hubSettings && hubSettings.geminiApiKey;
  if (hasKey && !aiWakeActive) {
    startAiWakeWord();
  } else if (!hasKey && aiWakeActive) {
    stopAiWakeWord();
  }
  const chat = $('ai-chat');
  if (chat && chat.children.length <= 1) {
    chat.replaceChildren();
    _aiRenderWelcomeIfEmpty();
  }
}

// ── Voice output (server-side) ───────────────────────────────────
// Speech is synthesized and played by the server (Windows SAPI) through the
// system speakers — instant and audible even when the WebView isn't focused.
// /api/speak resolves when speech finishes, so onDone can open the follow-up.

function _aiStopSpeaking() {
  aiSpeaking = false;
  fetch('/api/speak/stop', { method: 'POST' }).catch(() => {});
}

function _aiSpeak(text, onDone) {
  let _doneCalled = false;
  const finish = () => { if (!_doneCalled) { _doneCalled = true; if (typeof onDone === 'function') onDone(); } };

  // Stop anything currently playing (barge-in / overlap)
  fetch('/api/speak/stop', { method: 'POST' }).catch(() => {});

  if (!text) { finish(); return; }
  const clean = text.replace(/[*_`#>~|\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!clean) { finish(); return; }

  aiSpeaking = true;
  const uiLang = (typeof lang !== 'undefined' && lang) || 'en';
  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean, lang: uiLang, key: apiKey }),
  })
    .then(() => { aiSpeaking = false; finish(); })
    .catch(() => { aiSpeaking = false; finish(); });
}

// ── Image / screen-capture attachment ────────────────────────────

function aiAttachImage() {
  const inp = $('ai-attach-input');
  if (inp) inp.click();
}

function aiOnFileAttach(input) {
  const files = Array.from(input.files || []).slice(0, 4);
  input.value = '';
  files.forEach(file => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1];
      if (!base64) return;
      _aiPendingImages.push({ mimeType: file.type, data: base64, previewUrl: dataUrl });
      _aiUpdateAttachPreview();
    };
    reader.readAsDataURL(file);
  });
}

function _aiUpdateScreenBtn() {
  const btn = document.querySelector('.ai-screen-btn');
  if (btn) btn.classList.toggle('active', _aiScreenMode);
}

async function aiCaptureScreen() {
  document.getElementById('ai-screen-picker')?.remove();
  // Toggle off if already active
  if (_aiScreenMode) {
    _aiScreenMode = false;
    _aiScreenMonitor = null;
    _aiPendingImages = _aiPendingImages.filter(img => !img.fromScreenMode);
    _aiUpdateAttachPreview();
    _aiUpdateScreenBtn();
    return;
  }
  setAiStatus('thinking');
  try {
    const screensRes = await fetch('/api/screens');
    const { screens } = await screensRes.json();
    setAiStatus('');
    if (!screens || screens.length === 0) throw new Error('nessun monitor trovato');
    if (screens.length === 1) {
      await _aiActivateScreenMode(screens[0]);
    } else {
      _aiShowScreenPicker(screens);
    }
  } catch (err) {
    setAiStatus('');
    _aiAppendBubble('assistant', `Impossibile catturare lo schermo: ${err.message}`);
  }
}

async function _aiActivateScreenMode(monitor) {
  _aiScreenMode = true;
  _aiScreenMonitor = monitor;
  _aiUpdateScreenBtn();
  await _aiDoCapture(monitor, true);
}

function _aiShowScreenPicker(screens) {
  document.getElementById('ai-screen-picker')?.remove();
  const picker = document.createElement('div');
  picker.id = 'ai-screen-picker';
  picker.className = 'ai-screen-picker';

  const label = document.createElement('span');
  label.className = 'ai-screen-picker-label';
  label.textContent = 'Scegli il monitor (si aggiornerà ad ogni messaggio):';
  picker.appendChild(label);

  const row = document.createElement('div');
  row.className = 'ai-screen-picker-row';

  const allBtn = document.createElement('button');
  allBtn.className = 'ai-screen-picker-btn';
  allBtn.textContent = 'Tutti i monitor';
  allBtn.onclick = () => { picker.remove(); _aiActivateScreenMode(null); };
  row.appendChild(allBtn);

  screens.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'ai-screen-picker-btn' + (s.primary ? ' ai-screen-picker-primary' : '');
    btn.textContent = `Monitor ${i + 1}${s.primary ? ' ★' : ''} (${s.width}×${s.height})`;
    btn.onclick = () => { picker.remove(); _aiActivateScreenMode(s); };
    row.appendChild(btn);
  });

  picker.appendChild(row);
  const closeOnOutside = (e) => {
    if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', closeOnOutside, true); }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside, true), 80);

  const inputRow = document.querySelector('.ai-input-row');
  inputRow.parentNode.insertBefore(picker, inputRow);
}

// ── Voice-mode monitor picker ────────────────────────────────────
// Clean modal: a dimmed/blurred backdrop covers the voice view and a centered
// glass card holds one large button per monitor. The orb/reply/hint are hidden
// (via body.ai-picker-open) so nothing overlaps. Tapping a monitor captures it
// and auto-submits to the AI.
function _aiCloseMonitorPicker() {
  document.getElementById('ai-voice-monitor-picker')?.remove();
  document.body.classList.remove('ai-picker-open');
}

function _aiShowVoiceMonitorPicker(screens) {
  _aiCloseMonitorPicker();
  if (!screens || screens.length === 0) return;

  const picker = document.createElement('div');
  picker.id = 'ai-voice-monitor-picker';
  picker.className = 'ai-voice-monitor-picker';

  const card = document.createElement('div');
  card.className = 'ai-monitor-card';

  const label = document.createElement('div');
  label.className = 'ai-voice-monitor-label';
  label.textContent = t('ai_pick_monitor') || 'Scegli monitor:';
  card.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'ai-monitor-grid';

  // Build one button per monitor: bold number line + muted resolution line.
  const makeBtn = (titleText, resText, isPrimary, onPick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-voice-monitor-btn' + (isPrimary ? ' primary' : '');
    const num = document.createElement('span');
    num.className = 'ai-monitor-num';
    num.textContent = titleText;
    btn.appendChild(num);
    if (resText) {
      const res = document.createElement('span');
      res.className = 'ai-monitor-res';
      res.textContent = resText;
      btn.appendChild(res);
    }
    btn.addEventListener('click', () => { _aiCloseMonitorPicker(); onPick(); });
    return btn;
  };

  screens.forEach(s => {
    const title = `Monitor ${s.index}${s.primary ? ' ★' : ''}`;
    grid.appendChild(makeBtn(title, `${s.width}×${s.height}`, s.primary, () => _aiPickMonitorAndContinue(s)));
  });
  grid.appendChild(makeBtn(t('ai_all_monitors') || 'Tutti i monitor', '', false, () => _aiPickMonitorAndContinue(null)));

  card.appendChild(grid);
  picker.appendChild(card);

  // Attach inside the panel so the backdrop covers the voice view; fall back to body.
  const panel = document.querySelector('.ai-panel') || document.body;
  panel.appendChild(picker);
  document.body.classList.add('ai-picker-open');
}

async function _aiPickMonitorAndContinue(screen) {
  try {
    let url = '/api/screenshot';
    if (screen) url += `?x=${screen.x}&y=${screen.y}&w=${screen.width}&h=${screen.height}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { base64 } = await res.json();
    if (!base64 || base64.length < 50) throw new Error('screenshot vuoto');
    _aiPendingImages = [{ mimeType: 'image/jpeg', data: base64,
      previewUrl: `data:image/jpeg;base64,${base64}`, fromScreenMode: false }];
    const label = screen ? `Monitor ${screen.index} (${screen.width}×${screen.height})` : 'tutti i monitor';
    // fromVoice=true so the reply is spoken aloud
    aiSendMessage(`Analizza questo schermo: ${label}`, true);
  } catch (err) {
    _aiAppendBubble('assistant', `Errore cattura schermo: ${err.message}`);
  }
}

async function _aiDoCapture(monitor, fromScreenMode = false) {
  setAiStatus('thinking');
  try {
    let url = '/api/screenshot';
    if (monitor) url += `?x=${monitor.x}&y=${monitor.y}&w=${monitor.width}&h=${monitor.height}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const { base64 } = await res.json();
    if (!base64 || base64.length < 50) throw new Error('screenshot vuoto');
    const previewUrl = `data:image/jpeg;base64,${base64}`;
    _aiPendingImages.push({ mimeType: 'image/jpeg', data: base64, previewUrl, fromScreenMode });
    _aiUpdateAttachPreview();
  } catch (err) {
    _aiAppendBubble('assistant', `Impossibile catturare lo schermo: ${err.message}`);
  } finally {
    setAiStatus('');
  }
}

function aiRemoveAttachment(index) {
  _aiPendingImages.splice(index, 1);
  _aiUpdateAttachPreview();
}

function _aiHandlePaste(e) {
  // Only intercept when the AI panel is open
  if (!aiPanelOpen) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let addedImage = false;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(',')[1];
      if (base64) {
        _aiPendingImages.push({ mimeType: file.type || 'image/png', data: base64, previewUrl: dataUrl });
        _aiUpdateAttachPreview();
        // Focus the text input so the user can type a comment
        const inp = $('ai-text-input');
        if (inp && document.activeElement !== inp) inp.focus();
      }
    };
    reader.readAsDataURL(file);
    addedImage = true;
  }
  if (addedImage) e.preventDefault(); // prevent pasting as text
}

// Register paste listener once at module load
document.addEventListener('paste', _aiHandlePaste);

function _aiUpdateAttachPreview() {
  const el = $('ai-attach-preview');
  if (!el) return;
  if (_aiPendingImages.length === 0) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  el.replaceChildren();
  _aiPendingImages.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'ai-attach-thumb-wrap';
    const im = document.createElement('img');
    im.className = 'ai-attach-thumb';
    im.src = img.previewUrl;
    im.alt = 'allegato';
    const rm = document.createElement('button');
    rm.className = 'ai-attach-thumb-rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.onclick = () => aiRemoveAttachment(i);
    wrap.appendChild(im);
    wrap.appendChild(rm);
    el.appendChild(wrap);
  });
}

// ── Initialisation ────────────────────────────────────────────────

function initAi() {
  if (hubSettings && hubSettings.geminiApiKey) {
    startAiWakeWord();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initAi, 1800));
} else {
  setTimeout(initAi, 1800);
}

// ── Expose globals ────────────────────────────────────────────────
window.toggleAiPanel      = toggleAiPanel;
window.openAiPanel        = openAiPanel;
window.closeAiPanel       = closeAiPanel;
window.aiClearHistory     = aiClearHistory;
window.aiToggleVoice      = aiToggleVoice;
window.aiSendText         = aiSendText;
window.aiHandleKeydown    = aiHandleKeydown;
window.onAiKeyUpdated     = onAiKeyUpdated;
window.aiAttachImage      = aiAttachImage;
window.aiOnFileAttach     = aiOnFileAttach;
window.aiCaptureScreen    = aiCaptureScreen;
window.aiRemoveAttachment  = aiRemoveAttachment;
window._aiWakeWordTrigger  = _aiWakeWordTrigger;
window._aiOnSttSilence     = _aiOnSttSilence;
window._aiVoiceTapInterrupt = _aiVoiceTapInterrupt;
