// Lets the AI see the screen: the screen mode, the choice of the monitor and the capture.
'use strict';

let _aiPendingImages  = []; // [{mimeType, data, previewUrl, fromScreenMode?}]
let _aiScreenMode    = false;
let _aiScreenMonitor = null;

function _aiUpdateScreenBtn() {
  document.querySelectorAll('.ai-attach-btn').forEach((btn) => btn.classList.toggle('active', _aiScreenMode));
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

window.aiCaptureScreen     = aiCaptureScreen;
