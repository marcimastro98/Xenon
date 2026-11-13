// Local AI: scanning the hardware, starting Ollama, pulling a model and installing Whisper.
'use strict';

// Reflect the persisted provider settings into the AI controls. Safe to call
// repeatedly (it only reads hubSettings and writes control state).
function syncAiProviderControls() {
  const panel = $('ai-local-panel');
  const modelSel = $('ai-model-select');
  if (!panel || !modelSel) return;

  const cfg = hubSettings || {};
  const provider = AI_PROVIDER_IDS.includes(cfg.aiProvider) ? cfg.aiProvider : 'gemini';
  document.querySelectorAll('input[name="aiProvider"]').forEach((r) => {
    r.checked = (r.value === provider);
  });
  _reflectAiProviderRows(provider);

  // ChatGPT / Claude: fill the model dropdown live from the provider (only for
  // the active one), and show a "saved" placeholder for the key (which is
  // server-only, so the field itself always renders empty).
  const savedPh = t('settings_key_saved');
  const oKey = $('settings-openai-key'); if (oKey) { oKey.value = ''; oKey.placeholder = cfg.openaiApiKeySet ? savedPh : 'sk-…'; }
  const aKey = $('settings-anthropic-key'); if (aKey) { aKey.value = ''; aKey.placeholder = cfg.anthropicApiKeySet ? savedPh : 'sk-ant-…'; }
  const oReset = $('settings-openai-reset'); if (oReset) oReset.hidden = !cfg.openaiApiKeySet;
  const aReset = $('settings-anthropic-reset'); if (aReset) aReset.hidden = !cfg.anthropicApiKeySet;
  if (provider === 'openai' || provider === 'anthropic' || provider === 'gemini' || provider === 'localapi') _aiLoadProviderModels(provider);
  if (window.LocalServerSettings) window.LocalServerSettings.sync();
  if (AI_CLI_PROVIDERS.includes(provider)) aiCliRefresh(provider, false);
  // The credits card at the top shows the balance on Xenon AI and the offer
  // otherwise, so it is painted for every provider.
  if (window.XenonCreditsSettings) window.XenonCreditsSettings.refresh();

  const urlInput = $('ai-ollama-url');
  if (urlInput) urlInput.value = cfg.ollamaUrl || 'http://localhost:11434';

  _reflectModelSelection();

  if (cfg.hardwareScan) renderAiHwScan(cfg.hardwareScan);
  // When the local panel is already open on render, refresh live component state.
  if (provider === 'ollama') { aiLocalRefreshStatus(); aiLocalSyncAutostart(); aiLocalLoadModels(); }
}

// Render a hardware-scan result and gate the local provider on compatibility.
function renderAiHwScan(scan) {
  const hwBlock = $('ai-hw-block');
  const hwStats = $('ai-hw-stats');
  if (!hwStats) return;
  if (!scan || typeof scan !== 'object') { hwStats.textContent = '—'; return; }
  hwStats.textContent = `RAM ${scan.ram} GB · VRAM ${scan.vram} GB · ${scan.cores} core · ${scan.tier}`;
  const incompatible = scan.tier === 'incompatible';
  if (hwBlock) hwBlock.classList.toggle('ai-incompatible', incompatible);
  const ollamaRadio = $('ai-provider-ollama');
  if (ollamaRadio) ollamaRadio.disabled = incompatible;
  if (incompatible && ollamaRadio && ollamaRadio.checked) {
    const geminiRadio = $('ai-provider-gemini');
    if (geminiRadio) geminiRadio.checked = true;
    const panel = $('ai-local-panel');
    if (panel) panel.hidden = true;
    // Restore the cloud provider so persisted state matches the disabled UI.
    hubSettings = normalizeSettings({ ...hubSettings, aiProvider: 'gemini' });
    saveHubSettings();
  }
}

// Persist the current provider/model/url control values.
function persistAiProviderSettings() {
  const checked = document.querySelector('input[name="aiProvider"]:checked');
  const modelSel = $('ai-model-select');
  const modelCustom = $('ai-model-custom');
  const urlInput = $('ai-ollama-url');
  if (!modelSel) return;
  const model = modelSel.value === '__custom__'
    ? ((modelCustom && modelCustom.value.trim()) || 'auto')
    : modelSel.value;
  hubSettings = normalizeSettings({
    ...hubSettings,
    aiProvider: (checked && AI_PROVIDER_IDS.includes(checked.value)) ? checked.value : 'gemini',
    ollamaModel: model,
    ollamaUrl: (urlInput && urlInput.value.trim()) || 'http://localhost:11434',
  });
  saveHubSettings();
  // Bit's roast row says what this provider spends.
  syncVitalsAiBank();
}

async function aiLocalScan() {
  const hwStats = $('ai-hw-stats');
  if (hwStats) hwStats.textContent = '…';
  try {
    const data = await (await fetch('/api/ai-local/scan')).json();
    const scan = data && data.scan ? data.scan : data;
    renderAiHwScan(scan);
    hubSettings = normalizeSettings({ ...hubSettings, hardwareScan: scan });
    saveHubSettings();
  } catch {
    if (hwStats) hwStats.textContent = '—';
  }
}

async function aiLocalRefreshStatus() {
  try {
    const data = await (await fetch('/api/ai-local/status')).json();
    const status = data && data.status ? data.status : data;
    const set = (id, ok) => {
      const el = $(id);
      if (!el) return;
      el.className = ok ? 'ai-status-dot-ok' : 'ai-status-dot-bad';
      el.textContent = ok ? t('ai_comp_running') : t('ai_comp_missing');
    };
    // Ollama is reported as { installed, running }: running → green, installed but
    // stopped → amber with a "Start" button, not installed → red.
    const ollama = (status && status.ollama) || {};
    const ollamaEl = $('ai-status-ollama');
    const startBtn = $('ai-ollama-start');
    if (ollamaEl) {
      if (ollama.running) {
        ollamaEl.className = 'ai-status-dot-ok';
        ollamaEl.textContent = t('ai_comp_running');
      } else if (ollama.installed) {
        ollamaEl.className = 'ai-status-dot-warn';
        ollamaEl.textContent = t('ai_comp_installed_stopped');
      } else {
        ollamaEl.className = 'ai-status-dot-bad';
        ollamaEl.textContent = t('ai_comp_not_installed');
      }
    }
    // Show the Start button only when installed but not running.
    if (startBtn) startBtn.hidden = !(ollama.installed && !ollama.running);
    // Show the "Install Ollama" link only when Ollama is not installed at all.
    const ollamaInstallBtn = $('ai-ollama-install');
    if (ollamaInstallBtn) ollamaInstallBtn.hidden = !!ollama.installed;
    const whisperOk = !!(status && status.whisper);
    set('ai-status-whisper', whisperOk);
    // Show the "Download Whisper" button only when Whisper is not present.
    const whisperInstallBtn = $('ai-whisper-install');
    if (whisperInstallBtn) whisperInstallBtn.hidden = whisperOk;
    set('ai-status-tts', !!(status && (status.edgeTts ?? status.tts)));
  } catch { /* ignore — status stays unknown */ }
}

async function aiLocalStartOllama() {
  const startBtn = $('ai-ollama-start');
  const ollamaEl = $('ai-status-ollama');
  if (startBtn) startBtn.disabled = true;
  if (ollamaEl) ollamaEl.textContent = t('ai_comp_starting');
  try {
    await fetch('/api/ai-local/ollama-start', { method: 'POST' });
  } catch { /* ignore */ }
  if (startBtn) startBtn.disabled = false;
  await aiLocalRefreshStatus();
}

async function aiLocalSyncAutostart() {
  const cb = $('ai-ollama-autostart');
  if (!cb) return;
  try {
    const { enabled, supported } = await (await fetch('/api/ai-local/ollama-autostart')).json();
    cb.checked = !!enabled;
    // On Linux Ollama's own installer sets up the service: nothing for Xenon to switch.
    cb.closest('.ai-autostart-row').hidden = supported === false;
  } catch { /* ignore */ }
}

async function aiLocalPullModel() {
  const prog = $('ai-pull-progress');
  const bar = $('ai-pull-bar');
  const label = $('ai-pull-label');
  const modelSel = $('ai-model-select');
  const modelCustom = $('ai-model-custom');
  if (!prog || !bar || !label || !modelSel) return;
  prog.hidden = false;
  bar.style.width = '0%';
  label.textContent = t('ai_pull_progress');
  const model = modelSel.value === '__custom__'
    ? (modelCustom ? modelCustom.value.trim() : '')
    : modelSel.value;
  try {
    const res = await fetch('/api/ai-local/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.body) throw new Error('no stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/^data:\s*/, '').trim();
        buf = buf.slice(nl + 2);
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          if (p.error) {
            // Safety refusal or pull failure: show the real reason and stop —
            // never leave the bar sitting at 100% as if the model had installed.
            label.textContent = '⚠ ' + String(p.error);
            bar.style.width = '0%';
            aiLocalRefreshStatus();
            continue;
          }
          if (p.total && p.completed) {
            bar.style.width = Math.round((p.completed / p.total) * 100) + '%';
          }
          if (p.status) label.textContent = String(p.status);
          if (p.done) { bar.style.width = '100%'; aiLocalRefreshStatus(); aiLocalLoadModels(); }
        } catch { /* skip malformed progress line */ }
      }
    }
  } catch (e) {
    label.textContent = String((e && e.message) || e);
  }
}

// Stream the /api/ai-local/whisper-install SSE and hand each parsed progress
// object ({ percent }, { status }, { error }, { done }) to onEvent. Shared by
// the local-provider panel and the wake-word row.
async function _streamWhisperInstall(onEvent) {
  const res = await fetch('/api/ai-local/whisper-install', { method: 'POST' });
  if (!res.body) throw new Error('no stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/^data:\s*/, '').trim();
      buf = buf.slice(nl + 2);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* skip malformed progress line */ }
    }
  }
}

// Download + set up Whisper.cpp on demand. Mirrors aiLocalPullModel(): streams
// the whisper-install SSE and drives the shared progress bar from { percent }.
async function aiLocalInstallWhisper() {
  const prog = $('ai-pull-progress');
  const bar = $('ai-pull-bar');
  const label = $('ai-pull-label');
  if (!prog || !bar || !label) return;
  prog.hidden = false;
  bar.style.width = '0%';
  label.textContent = t('ai_pull_progress');
  try {
    await _streamWhisperInstall(p => {
      if (p.error) {
        // Surface the real reason instead of leaving the bar mid-way forever.
        label.textContent = '⚠ ' + String(p.error);
        aiLocalRefreshStatus();
        return;
      }
      if (typeof p.percent === 'number') bar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
      if (p.status) label.textContent = String(p.status);
      if (p.done) { bar.style.width = '100%'; aiLocalRefreshStatus(); }
    });
  } catch (e) {
    label.textContent = String((e && e.message) || e);
  }
}
