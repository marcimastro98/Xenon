'use strict';

// ── Xenon AI Module ─────────────────────────────────────────────
// Chat / function calling: gemini-3.1-flash-tts-preview via POST /api/ai
// Voice input (STT) and output (TTS) both run server-side (/api/stt/*, /api/speak)
//   so they work focus-independently and inside the iCUE WebView.
// Voice sessions are triggered via the 🎙 button (startVoiceSession).
// Siri 2026 animated border on the ai-siri-ring element.

const AI_MAX_HISTORY = 40;      // absolute backstop on raw turns sent to the model
const AI_SUMMARY_TRIGGER = 30;  // above this, fold the older turns into a running summary
const AI_RECENT_KEEP = 16;      // raw turns kept verbatim after a fold (the rest → summary)

// Current AI provider config from hub settings (defaults to Gemini).
function _aiProviderCfg() {
  const s = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {};
  const provider = ['ollama', 'openai', 'anthropic'].includes(s.aiProvider) ? s.aiProvider : 'gemini';
  // The model the client advertises. For openai/anthropic the server reads the
  // model from its own settings (server-only key path), so this is informational
  // there; for ollama it selects the local model.
  let model = 'auto';
  if (provider === 'openai') model = typeof s.openaiModel === 'string' ? s.openaiModel : 'gpt-4o';
  else if (provider === 'anthropic') model = typeof s.anthropicModel === 'string' ? s.anthropicModel : 'claude-sonnet-5';
  else if (provider === 'ollama') model = typeof s.ollamaModel === 'string' ? s.ollamaModel : 'auto';
  return {
    provider,
    model,
    ollamaUrl: typeof s.ollamaUrl === 'string' ? s.ollamaUrl : 'http://localhost:11434',
  };
}

// Whether the selected provider is usable (key present / local). For the
// server-only cloud keys we rely on the *Set booleans the server exposes.
function _aiProviderReady() {
  const s = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {};
  const p = _aiProviderCfg().provider;
  if (p === 'ollama') return true;
  if (p === 'openai') return !!s.openaiApiKeySet;
  if (p === 'anthropic') return !!s.anthropicApiKeySet;
  return !!s.geminiApiKey;
}

// Advanced AI feature flags the user explicitly enabled (Settings → Funzioni
// AI). Sent with every /api/ai turn: the server only exposes the matching
// tools when a flag is true, so disabled features cost zero extra tokens.
function _aiFeatureFlags() {
  const f = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.aiFeatures) || null;
  if (!f || f.enabled !== true) return {};
  const out = {};
  if (f.genesis === true) out.genesis = true;
  if (f.gameCompanion === true) out.gameCompanion = true;
  if (f.guardian === true) out.guardian = true;
  if (f.ambient === true) out.ambient = true;
  if (f.pcControl === true) out.pcControl = true;
  return out;
}

// Rolling conversation summary: when the raw history grows past the trigger,
// compress everything except the recent tail into a running summary (server
// side) so the model keeps the thread without an unbounded context. Runs in the
// background (fire-and-forget) — the new summary and the trimmed history apply
// to the NEXT turn, so it never adds latency to the turn that triggered it. On
// failure the absolute AI_MAX_HISTORY cap still bounds growth.
function _aiMaybeSummarize(apiKey) {
  if (_aiSummarizing) return;
  if (aiConversationHistory.length <= AI_SUMMARY_TRIGGER) return;
  const overflow = aiConversationHistory.slice(0, aiConversationHistory.length - AI_RECENT_KEEP);
  if (!overflow.length) return;
  _aiSummarizing = true;
  const cfg = _aiProviderCfg();
  fetch('/api/ai/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: apiKey,
      prevSummary: aiConversationSummary,
      messages: overflow,
      lang: (typeof lang !== 'undefined' && lang) || 'en',
      ...cfg,
    }),
  })
    .then(r => r.json().catch(() => ({})))
    .then(data => {
      if (data && data.summary) {
        aiConversationSummary = String(data.summary).slice(0, 2000);
        // Remove EXACTLY the turns we folded into the summary, from the front —
        // not slice(-KEEP), which would also drop any turns appended while this
        // request was in flight (they aren't in the summary yet). The history is
        // only ever appended to between the snapshot and here, so a front-drop of
        // overflow.length is content-safe.
        aiConversationHistory = aiConversationHistory.slice(overflow.length);
        _aiLog(`History folded: ${overflow.length} turns → summary (${aiConversationSummary.length} chars)`);
      }
    })
    .catch(() => { /* keep the raw history; the hard cap still bounds it */ })
    .finally(() => { _aiSummarizing = false; });
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
let aiConversationSummary = '';   // rolling summary of older turns folded out of the window
let _aiSummarizing = false;       // single-flight guard for the background summarize call
let _aiStickyDocs = null;         // recent non-screenshot attachments, re-sent for a few follow-ups
let _aiStickyTurns = 0;           // remaining turns the sticky docs carry forward
const AI_STICKY_TURNS = 2;        // how many follow-up turns a shared document stays in context
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
let _aiActiveListen       = false; // true while waiting on a turn the user deliberately started (open/orb-tap) vs an opportunistic follow-up — drives the "didn't hear you, retry" behaviour
let _aiPcConfirmOpen      = false; // true while a PC-Control confirmation card is on screen — the mic must NOT re-open until the user closes it
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
  document.body.classList.remove('ai-voice-mode', 'ai-voice-ambient', 'voice-listening', 'voice-thinking', 'voice-speaking');
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
  aiConversationSummary = '';
  _aiStickyDocs = null; _aiStickyTurns = 0;
  const chat = $('ai-chat');
  if (chat) chat.replaceChildren();
  _aiRenderWelcomeIfEmpty();
  setAiStatus('');
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies(); // clear copies too
}

// After a state-changing turn, surface a one-tap "undo" for the most recent
// reversible action (notes overwrite, bulk clear, a just-created task). The
// server owns the short-term action log; the chip just calls it.
async function _aiMaybeShowUndo() {
  let last;
  try {
    const res = await fetch('/api/ai/actions');
    const data = await res.json();
    last = data && data.last;
  } catch { return; }
  if (!last || !last.id) return;
  _aiAppendUndoChip(last.id, last.label || '');
}

function _aiAppendUndoChip(id, label) {
  const chat = $('ai-chat');
  if (!chat) return;
  const row = document.createElement('div');
  row.className = 'ai-undo-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-undo-btn';
  btn.textContent = '↶ ' + (typeof t === 'function' ? t('ai_undo', 'Annulla') : 'Annulla');
  if (label) btn.title = label;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await fetch('/api/ai/actions/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data && data.ok) {
        if (data.refresh) _aiExecuteClientAction(data.refresh, {});
        btn.textContent = (typeof t === 'function' ? t('ai_undo_done', 'Annullato') : 'Annullato');
        btn.classList.add('ai-undo-done');
      } else {
        btn.disabled = false;
      }
    } catch { btn.disabled = false; }
  });
  row.appendChild(btn);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

function _aiRenderWelcomeIfEmpty() {
  const chat = $('ai-chat');
  if (!chat || chat.children.length > 0) return;
  const ready = _aiProviderReady();
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

  // Sticky documents: attachments aren't kept in the text history (too large),
  // so a follow-up like "and the second page of that PDF?" used to lose the file.
  // Keep real (non-screenshot) attachments available for a couple of follow-up
  // turns by transparently re-sending them. Bounded and light — no storage, no RAG.
  const freshDocs = attachParts.filter(p => !p.fromScreenMode).map(({ mimeType, data }) => ({ mimeType, data }));
  let sentImageParts = imageParts;
  if (freshDocs.length > 0) {
    _aiStickyDocs = freshDocs;
    _aiStickyTurns = AI_STICKY_TURNS;
  } else if (_aiStickyDocs && _aiStickyTurns > 0 && !hasAudio) {
    sentImageParts = _aiStickyDocs;   // carry the recent document(s) forward
    _aiStickyTurns -= 1;
  }

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
  // Fold older turns into a running summary in the background so long
  // conversations stay coherent without an ever-growing context (and without
  // blocking this turn — the summary is applied for subsequent turns).
  _aiMaybeSummarize(apiKey);

  try {
    const featureFlags = _aiFeatureFlags();
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
        // Opt-in advanced features: the server only declares the extra tools
        // (Genesis, Guardian …) for flags that are present and true.
        ...(Object.keys(featureFlags).length > 0 ? { features: featureFlags } : {}),
        // Genesis needs the live page/widget map (client-owned, like the deck).
        ...(featureFlags.genesis && window.Genesis ? { dashboardState: window.Genesis.describeState() } : {}),
        ..._aiProviderCfg(),
        // Rolling summary of earlier turns that scrolled out of the window, so
        // the model keeps the thread of a long conversation. Empty until the
        // first fold happens.
        ...(aiConversationSummary ? { summary: aiConversationSummary } : {}),
        ...(sentImageParts.length > 0 ? { imageParts: sentImageParts } : {}),
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
    let mutated = false; // a refresh_* action means Xenon changed persisted state
    if (Array.isArray(data.clientActions)) {
      for (const action of data.clientActions) {
        if (action.action === 'show_monitor_picker') {
          pickerOpened = true;
          // Defer the modal so it appears together with Xenon's spoken question
          // ("which monitor?") instead of popping up a beat before the voice.
          if (fromVoice) { deferredPickerScreens = (action.args && action.args.screens) || []; continue; }
        }
        if (/^refresh_/.test(action.action)) mutated = true;
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
      // Offer to undo a state-changing action (notes overwrite, bulk clear, a
      // just-created task) in the text chat, where a chip can sit under the reply.
      if (mutated && !fromVoice) _aiMaybeShowUndo();
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
          // A monitor picker or a PC-Control confirmation card is modal: don't
          // re-open the mic behind it — listening resumes when it's closed.
          if (pickerOpened || _aiPcConfirmOpen) { _aiVoiceState(''); return; }
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
    case 'customize_appearance':
      if (typeof applyAiAppearance === 'function') applyAiAppearance(args);
      break;
    case 'create_dashboard_style':
      if (typeof applyAiCreateStyle === 'function') applyAiCreateStyle(args);
      break;
    case 'create_animated_background':
      if (typeof applyAiAnimatedBackground === 'function') applyAiAnimatedBackground(args);
      break;
    case 'configure_preferences':
      if (typeof applyAiPreferences === 'function') applyAiPreferences(args);
      break;
    case 'set_media_source':
      if (typeof setPreferredMediaSource === 'function') {
        const src = String(args.source || '').trim();
        setPreferredMediaSource(/^(auto|automatic|automatico)$/i.test(src) ? '' : src);
      }
      break;
    case 'confirm_pc_command':
      _aiShowPcConfirm(args || {});
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
    case 'genesis_compose_page':
      if (window.Genesis) window.Genesis.composePage(args.name, args.widgets, { tabs: args.tabs, sizes: args.sizes });
      break;
    case 'genesis_add_widgets':
      if (window.Genesis) window.Genesis.addWidgets(args.page, args.widgets, { tabs: args.tabs });
      break;
    case 'genesis_duplicate_widget':
      if (window.Genesis && window.Genesis.duplicateWidget) window.Genesis.duplicateWidget(args.widget, args.page);
      break;
    case 'genesis_remove_page':
      if (window.Genesis) window.Genesis.removePage(args.page);
      break;
    case 'genesis_setup_deck':
      if (window.Genesis && window.Genesis.setupDeck) window.Genesis.setupDeck(args);
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

// Only http(s) and mailto links are rendered as anchors. Assistant output can be
// influenced by untrusted content (vision/screen captures, media metadata, tool
// results), so a `javascript:`/`data:` URL must never become a live href — a
// single tap would run arbitrary JS in the dashboard origin. Anything else is
// shown as plain label text instead of a clickable link.
function _aiSafeLinkScheme(url) {
  // url is already HTML-escaped here; unescape the entity a scheme could hide in
  // before testing, so `java&#115;cript:` can't slip past the check.
  const probe = String(url).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').trim().toLowerCase();
  return /^(https?:|mailto:)/.test(probe);
}

function _inlineMarkdown(line) {
  // Process bold, italic, inline code in order (no nesting to keep it simple)
  return _escHtmlAI(line)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_full, label, url) =>
      _aiSafeLinkScheme(url)
        ? `<a href="${url}" target="_blank" rel="noopener" class="ai-link">${label}</a>`
        : `${label} (${url})`);
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
      t.className = 'ai-msg-text';
      t.textContent = text;
    }
    bubble.appendChild(t);
  }
  msg.appendChild(bubble);
  // Copy affordance — only when there is text to copy. The click is handled by a
  // single delegated listener (below) so it also works on the innerHTML-cloned
  // chat mirrors in duplicated tiles.
  if (text) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ai-msg-copy';
    const label = (typeof t === 'function' ? t('ai_copy') : 'Copia');
    copyBtn.title = label;
    copyBtn.setAttribute('aria-label', label);
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    msg.appendChild(copyBtn);
  }
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
      // Close the just-opened session UI too: without this the losing tab is
      // stuck showing a live voice orb with no recorder behind it.
      if (_aiVoiceSessionActive) _aiEndVoiceSession();
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
        _aiLog(`Server STT: empty capture — retry ${_aiEmptyRetries}/${AI_MAX_EMPTY_RETRIES}`);
        const hint = $('ai-voice-hint');
        if (hint) hint.textContent = t('ai_didnt_hear');
        _aiRetryActiveListen();
      } else {
        if (_aiActiveListen && _aiEmptyRetries >= AI_MAX_EMPTY_RETRIES) {
          _aiAppendBubble('assistant', t('ai_didnt_hear_end'));
        }
        _aiEmptyRetries = 0;
        _aiEndVoiceSession();
      }
    } else {
      setAiStatus('');
    }
  } catch (err) {
    if (wasVoice && myGen !== _aiVoiceGen) return; // session gone — swallow the error too
    _aiLog(`Server STT: errore stop: ${err.message}`);
    setAiStatus('');
    _aiAppendBubble('assistant', _aiFormatApiError(err));
    if (_aiVoiceSessionActive) _aiEndVoiceSession();
  }
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
      _aiSetMicTestResult(`✓ ${t('ai_mictest_heard')} — ${dev}`, 'ok');
    } else {
      _aiSetMicTestResult(`✕ ${t('ai_mictest_notheard')} — ${dev}. ${t('ai_mictest_fix')}`, 'warn');
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
  // Voce Live owns its own socket/audio lifecycle — a tap ends that session.
  if (typeof aiLiveTapInterrupt === 'function' && aiLiveTapInterrupt()) return;
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
  _aiVoiceState('listening');
  _aiPlayWakeChime();
  await new Promise(r => setTimeout(r, 450));
  if (!_aiVoiceSessionActive) return;
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
  const clean = String(text || '')
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

// Ends the voice session: clears the follow-up timer, drops the listening UI,
// and plays the closing chime so the user knows Xenon stopped without looking.
function _aiEndVoiceSession() {
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  _aiVoiceGen++;           // invalidate any in-flight transcription from this session
  _aiServerRecordingId = null;
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
  // Wait for the chime to finish AND for any audio tail to clear before showing
  // "Listening..." or opening the mic — prevents the label appearing while TTS
  // is still audible and prevents the mic capturing the chime (or the very tail
  // of Xenon's own voice) itself.
  await new Promise(r => setTimeout(r, 850));
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
  _aiVoiceState('listening');
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
    _aiStickyDocs = null; _aiStickyTurns = 0;
    _aiLog('New voice session — history cleared');
  }
  _aiPendingVoiceReply = '';
  _aiVoiceSessionActive = true;
  _aiActiveListen = true;   // user deliberately opened the voice session
  _aiEmptyRetries = 0;
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
        _aiLog('VoiceButton: auto-stop (max utterance)');
        _aiStopServerRecorder();
      }
    }, AI_MAX_UTTERANCE_MS);
  }
}

// Server-side "Hey Xenon" wake word detected (SSE `wake` from main.js) — open
// a voice session unless one is already live or the assistant is mid-turn.
function _aiHandleWake() {
  if (_aiVoiceSessionActive || aiListening || aiSpeaking) return;
  startVoiceSession();
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

// ── PC Control confirmation card (consent-gated run_pc_command) ────────────
// The server never runs a proposed command until the user approves it here. The
// command text comes from the server (by nonce) and is shown verbatim via
// textContent — we only send the nonce back to run or cancel.
function _aiShowPcConfirm(args) {
  const nonce = String(args.nonce || '');
  const command = String(args.command || '');
  const purpose = String(args.description || '');
  if (!nonce || !command) return;

  const existing = document.getElementById('ai-pc-confirm');
  if (existing) existing.remove();

  // The card is modal: while it's up, Xenon must not be listening. Stop any
  // in-flight follow-up recorder/timer and block the mic from re-opening until
  // the user closes the card.
  _aiPcConfirmOpen = true;
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  if (aiListening) { try { _aiStopServerRecorder(); } catch {} }

  const overlay = document.createElement('div');
  overlay.id = 'ai-pc-confirm';
  overlay.className = 'ai-voice-monitor-picker ai-pc-confirm';

  const card = document.createElement('div');
  card.className = 'ai-monitor-card ai-pc-card';

  const title = document.createElement('div');
  title.className = 'ai-pc-title';
  title.textContent = t('ai_pc_confirm_title') || 'Eseguire questo comando sul PC?';
  card.appendChild(title);

  if (purpose) {
    const desc = document.createElement('div');
    desc.className = 'ai-pc-desc';
    desc.textContent = purpose;
    card.appendChild(desc);
  }

  const pre = document.createElement('pre');
  pre.className = 'ai-pc-cmd';
  pre.textContent = command; // verbatim, never HTML
  card.appendChild(pre);

  const warn = document.createElement('div');
  warn.className = 'ai-pc-warn';
  warn.textContent = t('ai_pc_confirm_warn') || 'Verrà eseguito sul tuo PC con i tuoi permessi. Controlla che sia ciò che vuoi.';
  card.appendChild(warn);

  const row = document.createElement('div');
  row.className = 'ai-pc-actions';

  const close = () => {
    overlay.remove();
    document.body.classList.remove('ai-picker-open');
    _aiPcConfirmOpen = false;
    // Now that the modal is gone, resume the voice session's listening (if any).
    if (_aiVoiceSessionActive && !aiListening) _aiStartFollowupListen();
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ai-pc-btn ai-pc-cancel';
  cancelBtn.textContent = t('ai_pc_cancel') || 'Annulla';
  cancelBtn.addEventListener('click', () => {
    fetch('/ai/pc-cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) }).catch(() => {});
    close();
  });

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'ai-pc-btn ai-pc-run';
  runBtn.textContent = t('ai_pc_run') || 'Consenti ed esegui';
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true; cancelBtn.disabled = true;
    runBtn.textContent = t('ai_pc_running') || 'Esecuzione…';
    try {
      const res = await fetch('/ai/pc-run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
      const data = await res.json().catch(() => ({}));
      _aiRenderPcResult(card, row, data, close);
    } catch (e) {
      _aiRenderPcResult(card, row, { ok: false, errorMessage: String((e && e.message) || e) }, close);
    }
  });

  row.appendChild(cancelBtn);
  row.appendChild(runBtn);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.body.classList.add('ai-picker-open');
}

function _aiRenderPcResult(card, row, data, close) {
  row.remove();
  const ok = !!(data && data.ok);
  const out = document.createElement('div');
  out.className = 'ai-pc-result ' + (ok ? 'ok' : 'err');

  const head = document.createElement('div');
  head.className = 'ai-pc-result-head';
  head.textContent = ok
    ? (t('ai_pc_done') || 'Comando eseguito')
    : (t('ai_pc_failed') || 'Comando non riuscito') + (data && data.error ? ` (${data.error})` : '');
  out.appendChild(head);

  const bodyText = [
    (data && data.stdout) || '',
    (data && data.stderr) ? '\n' + data.stderr : '',
    (data && data.errorMessage) ? '\n' + data.errorMessage : '',
  ].join('').trim();
  if (bodyText) {
    const pre = document.createElement('pre');
    pre.className = 'ai-pc-cmd ai-pc-out';
    pre.textContent = bodyText.slice(0, 4000);
    out.appendChild(pre);
  }
  card.appendChild(out);

  const closeRow = document.createElement('div');
  closeRow.className = 'ai-pc-actions';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'ai-pc-btn ai-pc-run';
  okBtn.textContent = t('ai_pc_close') || 'Chiudi';
  okBtn.addEventListener('click', close);
  closeRow.appendChild(okBtn);
  card.appendChild(closeRow);
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

// ── Copy chat message to clipboard ────────────────────────────────
// One delegated listener covers the live chat plus every innerHTML-cloned mirror
// in duplicated chat tiles, so no per-button wiring is lost when a copy re-syncs.
async function _aiHandleCopyClick(e) {
  const btn = e.target && e.target.closest && e.target.closest('.ai-msg-copy');
  if (!btn) return;
  const msg = btn.closest('.ai-msg');
  const bubble = msg && msg.querySelector('.ai-msg-bubble');
  if (!bubble) return;
  const textEl = bubble.querySelector('.ai-msg-markdown, .ai-msg-text') || bubble;
  const text = (textEl.textContent || '').trim();
  if (!text) return;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) { /* fall through to legacy path */ }
  if (!ok) {
    // Legacy fallback for WebView builds without the async clipboard API.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (_) { ok = false; }
  }
  if (ok) _aiFlashCopied(btn);
}

// Briefly swap the copy icon for a check + "copied" tint, then revert.
function _aiFlashCopied(btn) {
  if (btn._copyReset) { clearTimeout(btn._copyReset); }
  if (!btn._copyIcon) btn._copyIcon = btn.innerHTML;
  btn.classList.add('is-copied');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
  const done = (typeof t === 'function' ? t('ai_copied') : 'Copiato');
  btn.title = done;
  btn.setAttribute('aria-label', done);
  btn._copyReset = setTimeout(() => {
    btn.classList.remove('is-copied');
    btn.innerHTML = btn._copyIcon;
    const label = (typeof t === 'function' ? t('ai_copy') : 'Copia');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn._copyReset = null;
  }, 1400);
}

document.addEventListener('click', _aiHandleCopyClick);

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

// ── Inline dictation for the chat composer ───────────────────────────────
// A mic button in the Media-tile chat that transcribes speech straight into
// the text input — no full-screen voice orb (the "let me dictate while I can
// still see the dashboard" request). It reuses the same server STT endpoints
// as the voice session, so it works on the Xenon Edge WebView where
// getUserMedia is unavailable and the server suspends the wake-word listener
// around the capture. Unlike the voice session it never auto-sends and never
// opens the orb: the transcript lands in the box for the user to review, edit
// and send. Tap to start (the button pulses), tap again to stop and transcribe.
let _aiDictateId = null;      // in-flight server STT recording id, or null while idle
let _aiDictateBusy = false;   // transcription round-trip in progress (blocks re-entry)
let _aiDictateTimer = null;   // safety auto-stop so a forgotten recording can't run forever

function _aiDictateReset(btn) {
  if (_aiDictateTimer) { clearTimeout(_aiDictateTimer); _aiDictateTimer = null; }
  const b = btn || $('ai-dictate-btn');
  if (b) { b.classList.remove('active', 'busy'); b.title = t('ai_dictate'); }
}

async function aiDictateToggle() {
  const btn = $('ai-dictate-btn');
  if (_aiDictateId) { await _aiDictateStop(); return; } // already recording → finish
  if (_aiDictateBusy) return;                            // start or transcription still in flight
  // Claim the slot for the WHOLE start round-trip: on the touchscreen a quick
  // double-tap would otherwise fire a second /api/stt/start before the first
  // resolves, orphaning one recording. The flag blocks re-entry until we either
  // hold an id (recording) or have reset the button (start failed / mic busy).
  _aiDictateBusy = true;
  try {
    if (btn) { btn.classList.add('active'); btn.title = t('ai_dictate_stop'); }
    const r = await fetch('/api/stt/start', { method: 'POST' });
    if (r.status === 409) { _aiDictateReset(btn); return; } // mic claimed elsewhere — back off
    const { id, error } = await r.json().catch(() => ({}));
    if (error || !id) throw new Error(error || 'no id');
    _aiDictateId = id;
    _aiLog(`Dictation: recording started id=${id}`);
    _aiDictateTimer = setTimeout(() => { if (_aiDictateId) _aiDictateStop(); }, 30000);
  } catch (err) {
    _aiLog(`Dictation start error: ${err.message}`);
    _aiDictateReset(btn);
    _aiAppendBubble('assistant', `${t('ai_dictate')}: ${err.message}`);
  } finally {
    _aiDictateBusy = false;
  }
}

async function _aiDictateStop() {
  const id = _aiDictateId;
  _aiDictateId = null;
  const btn = $('ai-dictate-btn');
  if (_aiDictateTimer) { clearTimeout(_aiDictateTimer); _aiDictateTimer = null; }
  if (!id) { _aiDictateReset(btn); return; }
  _aiDictateBusy = true;
  if (btn) { btn.classList.remove('active'); btn.classList.add('busy'); }
  _aiLog(`Dictation: stopping id=${id}`);
  try {
    const apiKey = (hubSettings && hubSettings.geminiApiKey) || '';
    const uiLang = (typeof lang !== 'undefined' && lang) || 'en';
    const r = await fetch('/api/stt/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, key: apiKey, mode: 'text', lang: uiLang, provider: _aiProviderCfg().provider }),
    });
    const { text, error } = await r.json().catch(() => ({}));
    if (error) throw new Error(error);
    const finalText = String(text || '').trim();
    _aiLog(`Dictation: text="${finalText}"`);
    if (finalText) _aiDictateInsert(finalText);
  } catch (err) {
    _aiLog(`Dictation stop error: ${err.message}`);
  } finally {
    _aiDictateBusy = false;
    _aiDictateReset(btn);
  }
}

// Append the transcript to whatever the user already typed and leave the caret
// at the end, so dictation composes with typing instead of replacing it.
function _aiDictateInsert(text) {
  const input = $('ai-text-input');
  if (!input) return;
  const cur = (input.value || '').trim();
  input.value = cur ? `${cur} ${text}` : text;
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* non-text input */ }
}

// ── Expose globals ────────────────────────────────────────────────
window.aiDictateToggle     = aiDictateToggle;
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
window._aiHandleWake       = _aiHandleWake;
window._aiOnSttSilence     = _aiOnSttSilence;
window._aiOnSpeakStart     = _aiOnSpeakStart;
window._aiVoiceTapInterrupt = _aiVoiceTapInterrupt;
window._aiVoiceOrbTap       = _aiVoiceOrbTap;
window.runAiMicTest         = runAiMicTest;
