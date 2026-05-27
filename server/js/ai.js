'use strict';

// ── Xenon AI Module ─────────────────────────────────────────────
// Gemini 2.5 Flash via POST /api/ai
// Web Speech API for voice input + wake word ("Hey Xenon")
// SpeechSynthesis for TTS output — only speaks on voice input, never on text chat
// Siri 2026 animated border on ai-siri-ring element

const AI_MAX_HISTORY = 40;

let aiPanelOpen = false;
let aiConversationHistory = [];
let aiListening = false;
let aiRecognition = null;
let aiWakeRecognition = null;
let aiWakeActive = false;
let aiSpeaking = false;
let _aiVoicesCache = null;
let _aiPendingImages = []; // [{mimeType, data, previewUrl}]

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
  stopAiVoice();
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
  const welcomeText = hasKey
    ? 'Ciao! Sono Xenon. Posso controllare il microfono, i media, il volume, le note e molto altro. Come posso aiutarti?'
    : 'Ciao! Per usare Xenon AI inserisci la tua Gemini API key nelle Impostazioni (⚙).';
  _aiAppendBubble('assistant', welcomeText);
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
      const ttsOn = hubSettings && hubSettings.aiTtsEnabled !== false;
      if (ttsOn && fromVoice) _aiSpeak(replyText); // speak only when triggered by voice
    }

    setAiStatus('');
  } catch (e) {
    const isKeyError = /API_KEY|api key|invalid key/i.test(e.message);
    const msg = isKeyError
      ? 'API key non valida. Controllala in Impostazioni → Xenon AI.'
      : `Errore: ${e.message}`;
    _aiAppendBubble('assistant', msg);
    setAiStatus('error');
    setTimeout(() => setAiStatus(''), 3500);
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
  }
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
    t.textContent = text;
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
  } else if (state === 'listening') {
    el.textContent = '🎙 Ascolto…';
  } else {
    el.textContent = '';
  }
}

// ── Push-to-talk voice input ─────────────────────────────────────

function aiToggleVoice() {
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
    _aiAppendBubble('assistant', 'Il riconoscimento vocale non è supportato su questo browser.');
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
  aiListening = false;
  document.body.classList.remove('ai-listening');
  const btn = $('ai-voice-btn');
  if (btn) btn.classList.remove('active');
  if ($('ai-status') && $('ai-status').className.includes('listening')) setAiStatus('');
}

// ── Always-listening wake word ("Hey Xenon") ─────────────────────

function startAiWakeWord() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec || aiWakeActive) return;

  aiWakeActive = true;

  const tryStart = () => {
    if (!aiWakeActive || aiListening) return;

    const wr = new SpeechRec();
    wr.continuous = true;
    wr.interimResults = true;
    // Always use en-US for wake word — "Hey Xenon" is English regardless of UI language
    wr.lang = 'en-US';

    wr.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript.toLowerCase();
        const WAKE = ['hey xenon', 'hey xeneon', 'ei xenon', 'hey zenon', 'hey senon', 'xenon hey', 'ok xenon', 'hey xeno', 'xeneon'];
        if (WAKE.some(w => t.includes(w))) {
          if (!aiPanelOpen) openAiPanel();
          setTimeout(startAiVoice, 400);
        }
      }
    };

    wr.onend = () => { if (aiWakeActive) setTimeout(tryStart, 1200); };
    wr.onerror = (e) => {
      if (e.error === 'not-allowed') { aiWakeActive = false; return; } // mic denied — stop retrying
      if (aiWakeActive) setTimeout(tryStart, 2400);
    };

    try { wr.start(); aiWakeRecognition = wr; }
    catch { if (aiWakeActive) setTimeout(tryStart, 3000); }
  };

  tryStart();
}

function stopAiWakeWord() {
  aiWakeActive = false;
  if (aiWakeRecognition) {
    try { aiWakeRecognition.abort(); } catch {}
    aiWakeRecognition = null;
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

// ── TTS output ───────────────────────────────────────────────────

// Warm up voices cache as soon as they become available
if (window.speechSynthesis) {
  const _loadVoices = () => {
    const v = window.speechSynthesis.getVoices();
    if (v.length) _aiVoicesCache = v;
  };
  _loadVoices();
  window.speechSynthesis.addEventListener('voiceschanged', _loadVoices);
}

// Pick the highest-quality available voice for the given BCP-47 tag (e.g. "it-IT")
function _aiPickVoice(langTag) {
  const voices = _aiVoicesCache || window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const lc = langTag.toLowerCase();           // "it-it"
  const base = lc.split('-')[0];              // "it"

  const scored = voices.map(v => {
    const vl = v.lang.toLowerCase();
    let s = 0;

    // Language match: exact > same base language
    if (vl === lc) s += 100;
    else if (vl.startsWith(base + '-') || vl === base) s += 50;
    else return { voice: v, score: -1 };      // wrong language entirely

    // Quality signals — prefer neural/online voices bundled in Edge/Chrome on Windows
    if (/online|natural|neural/i.test(v.name)) s += 40;
    if (/google/i.test(v.name)) s += 20;
    if (/microsoft/i.test(v.name)) s += 15;
    // Penalise older lower-fidelity voices
    if (/compact/i.test(v.name)) s -= 25;
    if (/zira|david|hazel|mark/i.test(v.name)) s -= 10;

    return { voice: v, score: s };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return (best && best.score >= 0) ? best.voice : null;
}

function _aiSpeak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  const langTag = _aiLangTag();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 600));
  utterance.lang = langTag;

  const voice = _aiPickVoice(langTag);
  if (voice) utterance.voice = voice;

  utterance.rate = 1.05;
  utterance.pitch = 1;
  utterance.volume = 0.90;
  utterance.onend = () => { aiSpeaking = false; };
  utterance.onerror = () => { aiSpeaking = false; };
  aiSpeaking = true;
  window.speechSynthesis.speak(utterance);
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

async function aiCaptureScreen() {
  document.getElementById('ai-screen-picker')?.remove();
  setAiStatus('thinking');
  try {
    const screensRes = await fetch('/api/screens');
    const { screens } = await screensRes.json();
    setAiStatus('');
    if (!screens || screens.length === 0) throw new Error('nessun monitor trovato');
    if (screens.length === 1) {
      await _aiDoCapture(screens[0]);
    } else {
      _aiShowScreenPicker(screens);
    }
  } catch (err) {
    setAiStatus('');
    _aiAppendBubble('assistant', `Impossibile catturare lo schermo: ${err.message}`);
  }
}

function _aiShowScreenPicker(screens) {
  document.getElementById('ai-screen-picker')?.remove();
  const picker = document.createElement('div');
  picker.id = 'ai-screen-picker';
  picker.className = 'ai-screen-picker';

  const label = document.createElement('span');
  label.className = 'ai-screen-picker-label';
  label.textContent = 'Scegli il monitor da catturare:';
  picker.appendChild(label);

  const row = document.createElement('div');
  row.className = 'ai-screen-picker-row';

  const allBtn = document.createElement('button');
  allBtn.className = 'ai-screen-picker-btn';
  allBtn.textContent = 'Tutti';
  allBtn.onclick = () => { picker.remove(); _aiDoCapture(null); };
  row.appendChild(allBtn);

  screens.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'ai-screen-picker-btn' + (s.primary ? ' ai-screen-picker-primary' : '');
    btn.textContent = `Monitor ${i + 1}${s.primary ? ' ★' : ''} (${s.width}×${s.height})`;
    btn.onclick = () => { picker.remove(); _aiDoCapture(s); };
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

async function _aiDoCapture(monitor) {
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
    _aiPendingImages.push({ mimeType: 'image/jpeg', data: base64, previewUrl });
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
window.aiRemoveAttachment = aiRemoveAttachment;
