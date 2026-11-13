// Voice, memory, wake word and the other AI switches.
'use strict';

function updateAiTts(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiTtsEnabled: !!enabled });
  saveHubSettings();
}

function updateAiProReasoning(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiProReasoning: !!enabled });
  saveHubSettings();
}

function updateAiLiveVoice(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiLiveVoice: !!enabled });
  saveHubSettings();
}

function updateAiVoiceAmbient(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiVoiceAmbient: !!enabled });
  saveHubSettings();
  if (window.AiEdgeGlow) window.AiEdgeGlow.refresh();
}

// Why the native app cannot draw the edge glow here: it draws it wherever it
// draws widget layers (layers/linux.rs `probe`), so the reason is the same.
const AI_EDGE_GLOW_WHY_KEYS = { wayland: 'settings_ai_edge_glow_why_wayland', no_compositor: 'settings_ai_edge_glow_why_compositor' };

// The edge glow is drawn by the native app: elsewhere the row is hidden, and
// where the app cannot draw it a line says why instead.
function syncAiEdgeGlowControl() {
  const row = $('settings-ai-edge-glow-row');
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  const native = window.__XENON_NATIVE__ === true;
  if (row) row.hidden = !(native && caps.aiGlow === true);
  const whyKey = native && caps.aiGlow !== true ? AI_EDGE_GLOW_WHY_KEYS[caps.layersWhy] || '' : '';
  const whyRow = $('settings-ai-edge-glow-why-row');
  const whyLine = $('settings-ai-edge-glow-why');
  if (whyRow) whyRow.hidden = !whyKey;
  if (whyLine && whyKey) {
    whyLine.dataset.i18n = whyKey;
    whyLine.textContent = t(whyKey);
  }
  const el = $('settings-ai-edge-glow');
  if (!el) return;
  el.value = hubSettings.aiEdgeGlow || 'auto';
  if (typeof el._csSync === 'function') el._csSync();
}

function updateAiEdgeGlow(value) {
  hubSettings = normalizeSettings({ ...hubSettings, aiEdgeGlow: value });
  saveHubSettings();
  syncAiEdgeGlowControl();
  if (window.AiEdgeGlow) window.AiEdgeGlow.refresh();
}

// ── Persistent AI memory (Settings → Xenon AI) ─────────────────────────────
// The server owns the fact store (data/ai-memory.json); the client flips the
// toggle and shows/clears the remembered facts. Text is rendered with
// textContent — never innerHTML — because the facts are user/AI-authored.

function updateAiMemory(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiMemory: !!enabled });
  saveHubSettings();
  const manage = $('settings-ai-memory-manage');
  if (manage) manage.hidden = !enabled;
  if (enabled) renderAiMemoryList();
}

async function renderAiMemoryList() {
  const list = $('settings-ai-memory-list');
  const empty = $('settings-ai-memory-empty');
  if (!list) return;
  let facts = [];
  try {
    const res = await fetch('/api/ai/memory');
    const data = await res.json();
    facts = Array.isArray(data.facts) ? data.facts : [];
  } catch { /* offline — leave the list as-is */ return; }
  list.textContent = '';
  if (empty) empty.hidden = facts.length > 0;
  const clear = $('settings-ai-memory-clear');
  if (clear) clear.hidden = facts.length === 0;
  for (const fact of facts) {
    const li = document.createElement('li');
    li.className = 'settings-memory-item';
    const span = document.createElement('span');
    span.className = 'settings-memory-text';
    span.textContent = fact.text || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-memory-del';
    btn.setAttribute('aria-label', t('settings_ai_memory_forget', 'Forget'));
    btn.textContent = '×';
    btn.addEventListener('click', () => forgetAiMemoryFact(fact.id));
    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function forgetAiMemoryFact(id) {
  try {
    await fetch('/api/ai/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch { /* ignore — the list refresh below reflects the true state */ }
  renderAiMemoryList();
}

async function clearAiMemory() {
  const msg = t('settings_ai_memory_clear_confirm', 'Delete everything Xenon remembers about you?');
  if (typeof confirm === 'function' && !confirm(msg)) return;
  try {
    await fetch('/api/ai/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    if (window.XenonToast) window.XenonToast.show({ type: 'success', title: t('settings_ai_memory_cleared', 'Memory cleared'), important: true });
  } catch { /* ignore — the list refresh below reflects the true state */ }
  renderAiMemoryList();
}

function updateAiMicSensitivity(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  hubSettings = normalizeSettings({ ...hubSettings, aiMicSensitivity: v });
  saveHubSettings();
  const out = $('settings-ai-sens-val');
  if (out) out.textContent = String(v);
}

// ── "Hey Bit" wake word (Settings → Xenon AI) ────────────────────────────
// The server owns the listener (ffmpeg + whisper.cpp); the client only flips
// the persisted toggle and reflects the live status line.

function updateWakeWord(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, wakeWord: { enabled: enabled === true } });
  saveHubSettings();
  // The /settings save starts/stops the server listener; re-read its status
  // after a beat so the row shows "listening" / "whisper missing" truthfully.
  // A second pass covers the slow path (device probe + first spawn take up to
  // a few seconds before isActive() flips).
  setTimeout(refreshWakeWordStatus, 600);
  setTimeout(refreshWakeWordStatus, 4500);
}

function syncWakeWordControls() {
  const toggle = $('settings-wake-enabled');
  if (!toggle) return;
  toggle.checked = !!(hubSettings.wakeWord && hubSettings.wakeWord.enabled);
  refreshWakeWordStatus();
}

async function refreshWakeWordStatus() {
  const out = $('settings-wake-status');
  const installBtn = $('settings-wake-whisper-btn');
  if (!out) return;
  const enabled = !!(hubSettings.wakeWord && hubSettings.wakeWord.enabled);
  if (!enabled) {
    out.textContent = '';
    if (installBtn) installBtn.hidden = true;
    return;
  }
  try {
    const st = await (await fetch('/api/wake/status')).json();
    if (!st.whisper) {
      out.textContent = t('wake_status_no_whisper', 'Serve Whisper (riconoscimento vocale locale): scaricalo qui sotto e l\'ascolto parte da solo.');
      if (installBtn) installBtn.hidden = false;
      return;
    }
    if (installBtn) installBtn.hidden = true;
    out.textContent = st.listening
      ? t('wake_status_listening', 'In ascolto: di\' «Hey Bit» per aprire la chat vocale.')
      : t('wake_status_starting', 'Attivo: l\'ascolto parte quando il dashboard è aperto.');
  } catch {
    out.textContent = '';
    if (installBtn) installBtn.hidden = true;
  }
}

// One-click Whisper download from the wake-word row. Streams the same
// /api/ai-local/whisper-install SSE as the local-provider panel, but reports
// progress inline in the status line (that panel is hidden on Gemini).
async function wakeInstallWhisper(btn) {
  const out = $('settings-wake-status');
  if (btn) btn.disabled = true;
  let failure = '';
  try {
    await _streamWhisperInstall(p => {
      if (p.error) failure = String(p.error);
      if (!out) return;
      if (p.error) out.textContent = '⚠ ' + String(p.error);
      else if (p.status || typeof p.percent === 'number') {
        out.textContent = String(p.status || '') + (typeof p.percent === 'number' ? ` ${Math.round(p.percent)}%` : '');
      }
    });
  } catch (e) {
    failure = String((e && e.message) || e);
  } finally {
    if (btn) btn.disabled = false;
    // The status refresh rewrites this line with "Whisper is needed", which used
    // to wipe the reason a download failed the instant it appeared. Put it back.
    await refreshWakeWordStatus();
    if (failure && out) out.textContent = '⚠ ' + failure;
  }
}

// Toggle one advanced AI feature flag ('enabled' = master switch). Persisted
// like every other setting and re-synced so dependent rows enable/disable.
function updateAiFeature(key, checked) {
  const current = normalizeAiFeatures(hubSettings.aiFeatures);
  if (!(key in current)) return;
  current[key] = checked === true;
  hubSettings = normalizeSettings({ ...hubSettings, aiFeatures: current });
  saveHubSettings();
  syncAiFeaturesControls();
  // Let feature modules react immediately (start/stop watchers, hide UI …).
  document.dispatchEvent(new CustomEvent('ai-features-changed', { detail: normalizeAiFeatures(hubSettings.aiFeatures) }));
}
