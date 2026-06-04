'use strict';

// ── Xenon AI Module ─────────────────────────────────────────────
// Chat / function calling: gemini-3.1-flash-tts-preview via POST /api/ai
// Voice input (STT) and output (TTS) both run server-side (/api/stt/*, /api/speak)
//   so they work focus-independently and inside the iCUE WebView.
// Voice sessions are triggered via the 🎙 button (startVoiceSession).
// Siri 2026 animated border on the ai-siri-ring element.

const AI_MAX_HISTORY = 40;

// Current AI provider config from hub settings (defaults to Gemini).
function _aiProviderCfg() {
  const s = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {};
  return {
    provider: s.aiProvider === 'ollama' ? 'ollama' : 'gemini',
    model: typeof s.ollamaModel === 'string' ? s.ollamaModel : 'auto',
    ollamaUrl: typeof s.ollamaUrl === 'string' ? s.ollamaUrl : 'http://localhost:11434',
  };
}

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

// Debug logging is OFF by default to avoid a network round-trip on every event.
// Enable from the console with `_aiDebug = true` (or `localStorage.aiDebug = '1'`)
// when you need the server-side [CLIENT] trace.
let _aiDebug = (() => { try { return localStorage.getItem('aiDebug') === '1'; } catch { return false; } })();
function _aiLog(msg) {
  if (!_aiDebug) return;
  console.log('[XenonAI]', msg);
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {});
}

let aiPanelOpen = false;
let aiConversationHistory = [];
let aiListening = false;
let aiRecognition = null;
let aiSpeaking = false;
let _aiCurrentAudio = null;
let _aiPendingImages  = []; // [{mimeType, data, previewUrl, fromScreenMode?}]
let _aiScreenMode    = false;
let _aiScreenMonitor = null;
let _aiMediaRecorder = null;
let _aiAudioChunks   = [];
let _aiServerRecordingId = null;
let _aiVoiceSessionActive = false; // true during an active voice session (button-triggered)
let _aiFollowupTimer      = null;  // auto-stop timer for the follow-up listening window
let _aiPendingVoiceReply  = '';    // reply text held until the server's speak_start fires
let _aiPendingPicker      = null;  // monitor screens held until speak_start, so the picker and the voice appear together
let _aiVoiceGen           = 0;     // bumped whenever a voice session ends/interrupts — a transcription that finishes after its session closed is discarded
let _aiVoiceOpenedAt      = 0;     // timestamp the voice view opened — used to swallow the "ghost click" that a touch which opened the overlay (e.g. a Deck key firing on pointerup) sends straight through onto the just-shown voice view, which would otherwise interrupt/close it instantly
const AI_FOLLOWUP_MS = 12000;
const AI_VOICE_TAP_GRACE_MS = 500; // ignore tap-to-interrupt within this window after opening

// ── Panel control ────────────────────────────────────────────────

function toggleAiPanel() {
  if (aiPanelOpen) closeAiPanel();
  else openAiPanel();
}

function openAiPanel() {
  const overlay = $('ai-overlay');
  if (!overlay) return;
  // Always open in the CHAT view: clear any lingering voice-mode classes from a
  // previous voice session (otherwise the chat stays hidden behind the empty orb).
  // A real voice session re-adds ai-voice-mode right after, so this is safe.
  document.body.classList.remove('ai-voice-mode', 'voice-listening', 'voice-thinking', 'voice-speaking');
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
  // Cancel any pending follow-up listening window
  _aiVoiceSessionActive = false;
  _aiVoiceGen++;            // invalidate any in-flight transcription so it can't reopen the panel / run a command
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  // Cancel any active server recording (free ffmpeg, no transcription).
  const rid = _aiServerRecordingId;
  _aiServerRecordingId = null;
  if (rid) fetch('/api/stt/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rid, key: '' }) }).catch(() => {});
  _aiCloseMonitorPicker();
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
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies(); // clear copies too
}

function _aiRenderWelcomeIfEmpty() {
  const chat = $('ai-chat');
  if (!chat || chat.children.length > 0) return;
  const cfg = _aiProviderCfg();
  const ready = cfg.provider === 'ollama' || (hubSettings && hubSettings.geminiApiKey);
  _aiAppendBubble('assistant', t(ready ? 'ai_welcome' : 'ai_welcome_no_key'));
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

// Ask a question programmatically (e.g. from a Deck key). Posts it as a normal
// text chat message — the question and the written answer appear in the chat,
// no voice. In v3.0 the text chat lives in the media tile's Chat tab (the voice
// overlay holds only the orb), so reveal that tab rather than the empty overlay.
function aiAsk(text) {
  if (typeof openMediaChat === 'function') openMediaChat();
  else openAiPanel(); // fallback for layouts without the media Chat tab
  const msg = String(text == null ? '' : text).trim();
  if (msg) aiSendMessage(msg, false); // text/chat mode, no TTS
}

// fromVoice=true → speak the reply aloud; false (text chat) → silent
// audioParts (optional) → spoken request sent as audio; Gemini transcribes + answers in one call
async function aiSendMessage(userText, fromVoice, audioParts) {
  const text = String(userText || '').trim();
  const hasAudio = Array.isArray(audioParts) && audioParts.length > 0;
  if (!text && _aiPendingImages.length === 0 && !hasAudio) return;

  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  if (!apiKey && _aiProviderCfg().provider === 'gemini') {
    _aiAppendBubble('assistant', t('ai_key_invalid'));
    return;
  }

  // If screen mode is active, replace the previous auto-screenshot with a fresh one
  if (_aiScreenMode) {
    _aiPendingImages = _aiPendingImages.filter(img => !img.fromScreenMode);
    await _aiDoCapture(_aiScreenMonitor, true);
  }

  // Capture and clear pending attachments before any async ops.
  // attachParts keeps the full objects (name/isImage) for the bubble preview;
  // imageParts is the slimmed payload (mimeType + data) sent to the model.
  const attachParts = _aiPendingImages.slice();
  const imageParts = attachParts.map(({ mimeType, data }) => ({ mimeType, data }));
  _aiPendingImages = [];
  _aiUpdateAttachPreview();

  if (text) _aiAppendBubble('user', text, attachParts);
  else if (hasAudio) _aiAppendBubble('user', '🎤');
  else _aiAppendBubble('user', '', attachParts);

  setAiStatus('thinking');
  document.body.classList.add('ai-active');

  // Only store text in history (audio/images are too large to keep for context).
  // For a spoken turn we store the wake-word command head if we have it, else a
  // placeholder; the model's own reply (stored below) carries the rest of context.
  if (text) {
    aiConversationHistory.push({ role: 'user', parts: [{ text }] });
  } else if (hasAudio) {
    aiConversationHistory.push({ role: 'user', parts: [{ text: '[richiesta vocale]' }] });
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
        voice: !!fromVoice,
        lang: (typeof lang !== 'undefined' && lang) || 'en',
        // The deck's profiles live only in the browser, so tell the server which
        // exist this turn — it injects them into the prompt so Xenon can switch
        // by exact name via the switch_deck_profile client action.
        deckProfiles: (window.Deck && window.Deck.listProfiles) ? window.Deck.listProfiles() : [],
        ..._aiProviderCfg(),
        ...(imageParts.length > 0 ? { imageParts } : {}),
        ...(hasAudio ? { audioParts } : {}),
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = (data && data.error) ? data.error : `${t('ai_http_error')} ${response.status}`;
      throw new Error(errMsg);
    }

    let pickerOpened = false;
    let deferredPickerScreens = null;
    if (Array.isArray(data.clientActions)) {
      for (const action of data.clientActions) {
        if (action.action === 'show_monitor_picker') {
          pickerOpened = true;
          // Defer the modal so it appears together with Xenon's spoken question
          // ("which monitor?") instead of popping up a beat before the voice.
          if (fromVoice) { deferredPickerScreens = (action.args && action.args.screens) || []; continue; }
        }
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
        // After speaking, keep listening for a few seconds so the user can ask a
        // follow-up without repeating the wake word (same chat, same history).
        // The mic re-opens only AFTER TTS finishes — never during — so the
        // assistant's own voice never bleeds into the recording. If the user
        // stays silent, _aiStartFollowupListen ends the session on its own.
        // Exception: when a monitor picker is open the user must tap a choice, so
        // we don't re-open the mic (it would compete with the picker).
        const afterAnswer = () => {
          if (!_aiVoiceSessionActive) return;
          if (pickerOpened) { _aiVoiceState(''); return; }
          _aiStartFollowupListen();
        };
        // Hold the deferred monitor picker until the voice actually starts.
        _aiPendingPicker = deferredPickerScreens;
        if (ttsOn) {
          // Hold the reply text until speak_start fires so text and voice appear
          // at the same moment. _aiPendingVoiceReply is cleared at the start of
          // every new turn (wake trigger + new request) so it can never carry a
          // stale value across sessions.
          _aiPendingVoiceReply = replyText;
          _aiSpeak(replyText, afterAnswer);
        } else {
          if (_aiVoiceSessionActive) {
            if (deferredPickerScreens) { _aiVoiceSetReply(replyText); _aiShowVoiceMonitorPicker(deferredPickerScreens); _aiPendingPicker = null; }
            else if (!pickerOpened) _aiVoiceState('speaking');
          }
          setTimeout(afterAnswer, 600);
        }
      }
    } else if (fromVoice && _aiVoiceSessionActive && !pickerOpened) {
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
    case 'optimize_performance':
      if (window.PerfMode && typeof window.PerfMode.optimize === 'function') window.PerfMode.optimize();
      break;
    case 'restore_performance':
      if (window.PerfMode && typeof window.PerfMode.restore === 'function') window.PerfMode.restore();
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
    case 'go_to_page':
      if (window.DashboardPager && args.page) window.DashboardPager.goToPage(String(args.page));
      break;
    case 'switch_deck_profile':
      if (window.Deck && window.Deck.switchProfileByName && args.profile) {
        window.Deck.switchProfileByName(String(args.profile));
      }
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
      if (img.isImage === false) {
        const chip = document.createElement('span');
        chip.className = 'ai-bubble-doc';
        const ext = document.createElement('span');
        ext.className = 'ai-attach-doc-ext';
        ext.textContent = _aiDocExt(img.name);
        const nm = document.createElement('span');
        nm.className = 'ai-attach-doc-name';
        nm.textContent = img.name || 'file';
        chip.appendChild(ext);
        chip.appendChild(nm);
        strip.appendChild(chip);
        return;
      }
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
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies(); // reflect into duplicated chat tiles
}

function setAiStatus(state) {
  const el = $('ai-status');
  if (!el) return;
  el.className = 'ai-status' + (state ? ` ai-status-${state}` : '');
  if (state === 'thinking') {
    el.innerHTML = '<span class="ai-thinking-dots"><span></span><span></span><span></span></span>';
  } else if (state === 'connecting') {
    el.textContent = t('ai_connecting');
  } else if (state === 'listening') {
    el.textContent = t('ai_listening');
  } else {
    el.textContent = '';
  }
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies(); // keep copy status in sync
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
    // Short timeout: on the Xenon Edge WebView getUserMedia never resolves, so we
    // fall back to server-side recording below.
    const ownStream = true;
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout microfono (300ms)')), 300)),
    ]);
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
      if (!apiKey && _aiProviderCfg().provider === 'gemini') { setAiStatus(''); return; }

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
          body: JSON.stringify({ audio: base64, mimeType: recordedMime, key: apiKey, provider: _aiProviderCfg().provider }),
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
  // Capture the session generation: if the user closes/interrupts the session
  // while transcription is in flight, the result that arrives afterwards must be
  // discarded — otherwise a phantom clip could reopen the panel and run a command
  // (e.g. "apri Spotify") right after the user closed the voice chat.
  const wasVoice = _aiVoiceSessionActive;
  const myGen = _aiVoiceGen;
  const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
  if (!apiKey && _aiProviderCfg().provider === 'gemini') { setAiStatus(''); return; }
  setAiStatus('thinking');
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
      if (!aiPanelOpen) openAiPanel();
      if (_aiVoiceSessionActive) {
        _aiPendingVoiceReply = '';
        _aiVoiceSetUser(finalText);
        _aiVoiceState('thinking');
      }
      aiSendMessage(finalText, true);
    } else {
      if (_aiVoiceSessionActive) _aiEndVoiceSession();
      else setAiStatus('');
    }
  } catch (err) {
    if (wasVoice && myGen !== _aiVoiceGen) return; // session gone — swallow the error too
    _aiLog(`Server STT: errore stop: ${err.message}`);
    setAiStatus('');
    _aiAppendBubble('assistant', _aiFormatApiError(err));
    if (_aiVoiceSessionActive) _aiEndVoiceSession();
  }
}


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

// ── Voice mode UI (stylized animated conversation) ──────────────
function _aiVoiceModeEnter() {
  if (!aiPanelOpen) openAiPanel();
  document.body.classList.add('ai-voice-mode');
  _aiVoiceOpenedAt = Date.now(); // start the grace window (see _aiVoiceOpenedAt)
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
  const tap = t('ai_tap_stop');
  h.textContent =
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
  // Swallow the ghost click that opened the overlay (Deck keys fire on pointerup,
  // so the trailing click lands on the just-shown voice view and would close it).
  if (Date.now() - _aiVoiceOpenedAt < AI_VOICE_TAP_GRACE_MS) return;
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
// Tap on the orb itself — stop TTS / recording and immediately start listening
// again, without closing the session or clearing conversation history.
async function _aiVoiceOrbTap() {
  if (!document.body.classList.contains('ai-voice-mode')) return;
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
  _aiPendingVoiceReply = '';
  _aiVoiceSetUser('');
  _aiVoiceState('listening');
  _aiPlayWakeChime();
  await new Promise(r => setTimeout(r, 450));
  if (!_aiVoiceSessionActive) return;
  await _aiStartServerRecorder();
  const capturedId = _aiServerRecordingId;
  if (capturedId) {
    setTimeout(() => {
      if (_aiServerRecordingId === capturedId) {
        _aiLog('OrbTap: auto-stop 8s');
        _aiStopServerRecorder();
      }
    }, 8000);
  }
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
  _aiVoiceGen++;           // invalidate any in-flight transcription from this session
  _aiServerRecordingId = null;
  _aiPendingPicker = null;
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
  _aiPlayWakeChime();
  // Keep the last reply on screen while we wait for a follow-up (don't blank it),
  // just clear the user line. The reply is replaced once the user speaks again.
  const u = $('ai-voice-user'); if (u) u.textContent = '';
  // Wait for the chime to finish AND for any audio tail to clear before showing
  // "Listening..." or opening the mic — prevents the label appearing while TTS
  // is still audible and prevents the mic capturing the chime itself.
  await new Promise(r => setTimeout(r, 550));
  if (!_aiVoiceSessionActive || aiListening) return; // user tapped to interrupt during the gap
  _aiVoiceState('listening');
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

// ── Button-triggered voice session ───────────────────────────────────────────
// Starts an immersive voice session (orb mode) programmatically from a button tap.

async function startVoiceSession() {
  if (aiListening) return;
  if (aiSpeaking) {
    _aiStopSpeaking();
    fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    _aiVoiceSessionActive = false;
    if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  }
  if (!_aiVoiceSessionActive) {
    aiConversationHistory = [];
    _aiLog('New voice session — history cleared');
  }
  _aiPendingVoiceReply = '';
  _aiVoiceSessionActive = true;
  _aiPlayWakeChime();
  _aiVoiceModeEnter();
  _aiVoiceSetUser('');
  _aiVoiceState('listening');
  await new Promise(r => setTimeout(r, 950));
  if (!_aiVoiceSessionActive) return;
  await _aiStartServerRecorder();
  const capturedId = _aiServerRecordingId;
  if (capturedId) {
    setTimeout(() => {
      if (_aiServerRecordingId === capturedId) {
        _aiLog('VoiceButton: auto-stop 8s');
        _aiStopServerRecorder();
      }
    }, 8000);
  }
}

// Called from settings.js when the API key changes
function onAiKeyUpdated() {
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
  // The server bounds playback too; this is the client-side guarantee.
  _guard = setTimeout(() => { aiSpeaking = false; finish(); }, 28000);
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

// ── Image / screen-capture attachment ────────────────────────────

function aiAttachImage() {
  const inp = $('ai-attach-input');
  if (inp) inp.click();
}

// Text/code files Gemini reads as plain text (sent with mimeType text/plain).
const AI_TEXT_EXT = /\.(txt|md|markdown|log|csv|json|xml|ya?ml|js|ts|jsx|tsx|py|html?|css|ini|sh|c|cpp|h|hpp|java|go|rs|rb|php)$/i;

function aiOnFileAttach(input) {
  const files = Array.from(input.files || []).slice(0, 4);
  input.value = '';
  files.forEach(file => {
    const type = file.type || '';
    const name = file.name || 'file';
    const isImage = type.startsWith('image/');
    const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
    const isText = type.startsWith('text/') || type === 'application/json' || AI_TEXT_EXT.test(name);
    if (!isImage && !isPdf && !isText) {
      setAiStatus(t('ai_attach_unsupported'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = String(e.target.result || '');
      const base64 = dataUrl.split(',')[1];
      if (!base64) return;
      const mimeType = isImage ? type : (isPdf ? 'application/pdf' : 'text/plain');
      _aiPendingImages.push({ mimeType, data: base64, previewUrl: isImage ? dataUrl : '', name, isImage });
      _aiUpdateAttachPreview();
    };
    reader.readAsDataURL(file);
  });
}

// Extension badge for a non-image attachment (e.g. "PDF", "TXT").
function _aiDocExt(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return (m ? m[1] : 'doc').toUpperCase().slice(0, 4);
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
    if (!screens || screens.length === 0) throw new Error(t('ai_screen_no_monitor'));
    if (screens.length === 1) {
      await _aiActivateScreenMode(screens[0]);
    } else {
      _aiShowScreenPicker(screens);
    }
  } catch (err) {
    setAiStatus('');
    _aiAppendBubble('assistant', `${t('ai_screen_capture_failed')} ${err.message}`);
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
  label.textContent = t('ai_pick_monitor');
  picker.appendChild(label);

  const row = document.createElement('div');
  row.className = 'ai-screen-picker-row';

  const allBtn = document.createElement('button');
  allBtn.className = 'ai-screen-picker-btn';
  allBtn.textContent = t('ai_all_monitors');
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
  // The user just chose a monitor — cut off the "which monitor?" question Xenon is
  // still speaking so it reacts instantly to the tap instead of finishing the
  // sentence first, then return to the "thinking" state (the picker has closed) so
  // the orb resumes its processing animation while we capture and analyse.
  _aiStopSpeaking();
  fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  if (_aiVoiceSessionActive) _aiVoiceState('thinking');
  setAiStatus('thinking');
  try {
    let url = '/api/screenshot';
    if (screen) url += `?x=${screen.x}&y=${screen.y}&w=${screen.width}&h=${screen.height}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { base64 } = await res.json();
    if (!base64 || base64.length < 50) throw new Error(t('ai_screenshot_empty'));
    _aiPendingImages = [{ mimeType: 'image/jpeg', data: base64,
      previewUrl: `data:image/jpeg;base64,${base64}`, fromScreenMode: false }];
    const label = screen ? `Monitor ${screen.index} (${screen.width}×${screen.height})` : t('ai_all_monitors');
    // Re-assert "thinking": the picker question's TTS callback may have raced to
    // idle while the screenshot was captured. fromVoice=true so the reply is spoken.
    if (_aiVoiceSessionActive) _aiVoiceState('thinking');
    aiSendMessage(`${t('ai_screen_analyze')} ${label}`, true);
  } catch (err) {
    setAiStatus('');
    if (_aiVoiceSessionActive) _aiVoiceState('');
    _aiAppendBubble('assistant', `${t('ai_screen_error')} ${err.message}`);
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
    if (!base64 || base64.length < 50) throw new Error(t('ai_screenshot_empty'));
    const previewUrl = `data:image/jpeg;base64,${base64}`;
    _aiPendingImages.push({ mimeType: 'image/jpeg', data: base64, previewUrl, fromScreenMode });
    _aiUpdateAttachPreview();
  } catch (err) {
    _aiAppendBubble('assistant', `${t('ai_screen_capture_failed')} ${err.message}`);
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
    if (img.isImage === false) {
      const doc = document.createElement('div');
      doc.className = 'ai-attach-doc';
      doc.title = img.name || 'file';
      const ic = document.createElement('span');
      ic.className = 'ai-attach-doc-ext';
      ic.textContent = _aiDocExt(img.name);
      const nm = document.createElement('span');
      nm.className = 'ai-attach-doc-name';
      nm.textContent = img.name || 'file';
      doc.appendChild(ic);
      doc.appendChild(nm);
      wrap.appendChild(doc);
    } else {
      const im = document.createElement('img');
      im.className = 'ai-attach-thumb';
      im.src = img.previewUrl;
      im.alt = 'allegato';
      wrap.appendChild(im);
    }
    const rm = document.createElement('button');
    rm.className = 'ai-attach-thumb-rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.onclick = () => aiRemoveAttachment(i);
    wrap.appendChild(rm);
    el.appendChild(wrap);
  });
}

// ── Initialisation ────────────────────────────────────────────────

function initAi() {
  // Nothing to initialise — voice sessions start via button tap.
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initAi, 1800));
} else {
  setTimeout(initAi, 1800);
}

// ── Expose globals ────────────────────────────────────────────────
window.toggleAiPanel       = toggleAiPanel;
window.openAiPanel         = openAiPanel;
window.closeAiPanel        = closeAiPanel;
window.aiClearHistory      = aiClearHistory;
window.aiToggleVoice       = aiToggleVoice;
window.aiSendText          = aiSendText;
window.aiAsk               = aiAsk;
window.aiHandleKeydown     = aiHandleKeydown;
window.onAiKeyUpdated      = onAiKeyUpdated;
window.aiAttachImage       = aiAttachImage;
window.aiOnFileAttach      = aiOnFileAttach;
window.aiCaptureScreen     = aiCaptureScreen;
window.aiRemoveAttachment  = aiRemoveAttachment;
window.startVoiceSession   = startVoiceSession;
window._aiOnSttSilence     = _aiOnSttSilence;
window._aiOnSpeakStart     = _aiOnSpeakStart;
window._aiVoiceTapInterrupt = _aiVoiceTapInterrupt;
window._aiVoiceOrbTap       = _aiVoiceOrbTap;
