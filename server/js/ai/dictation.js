// Dictation into the message box: the microphone button that writes what it hears.
'use strict';

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
  if (b) { b.classList.remove('active', 'busy'); b.title = t('ai_dictate'); b.setAttribute('aria-label', t('ai_dictate')); }
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
    if (btn) { btn.classList.add('active'); btn.title = t('ai_dictate_stop'); btn.setAttribute('aria-label', t('ai_dictate_stop')); }
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
  if (window.BitComposer) BitComposer.sync();
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* non-text input */ }
}

// ── Expose globals ────────────────────────────────────────────────
window.aiDictateToggle     = aiDictateToggle;
