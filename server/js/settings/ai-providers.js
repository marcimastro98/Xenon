// The AI provider settings: which provider, its keys and the controls that show them.
'use strict';

function syncAiSettingsControls() {
  // The key never comes back from the server, so the field shows a "saved"
  // placeholder rather than the value — same treatment as the other providers.
  const keyInput = $('settings-gemini-key');
  if (keyInput) {
    keyInput.value = hubSettings.geminiApiKey || '';
    keyInput.placeholder = hubSettings.geminiApiKeySet ? t('settings_key_saved') : t('settings_ai_key_placeholder');
  }
  const keyReset = $('settings-gemini-reset');
  if (keyReset) keyReset.hidden = !hubSettings.geminiApiKeySet;
  const sdkAiCap = $('settings-sdk-ai-cap');
  if (sdkAiCap) {
    sdkAiCap.replaceChildren(...SDK_AI_DAILY_CAPS.map((n) => {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = t('settings_sdk_ai_cap_n').replace('{n}', String(n));
      return o;
    }));
    sdkAiCap.value = String(hubSettings.sdkAiDailyCap);
  }
  const ttsToggle = $('settings-ai-tts');
  if (ttsToggle) ttsToggle.checked = hubSettings.aiTtsEnabled !== false;
  const proToggle = $('settings-ai-pro');
  if (proToggle) proToggle.checked = hubSettings.aiProReasoning === true;
  const liveToggle = $('settings-ai-live');
  if (liveToggle) liveToggle.checked = hubSettings.aiLiveVoice === true;
  const ambientToggle = $('settings-ai-voice-ambient');
  if (ambientToggle) ambientToggle.checked = hubSettings.aiVoiceAmbient === true;
  syncAiEdgeGlowControl();
  const memToggle = $('settings-ai-memory');
  if (memToggle) {
    const on = hubSettings.aiMemory !== false;
    memToggle.checked = on;
    const manage = $('settings-ai-memory-manage');
    if (manage) manage.hidden = !on;
    if (on) renderAiMemoryList();
  }
  const sens = $('settings-ai-sens');
  if (sens) {
    const v = Number.isFinite(hubSettings.aiMicSensitivity) ? hubSettings.aiMicSensitivity : 50;
    sens.value = String(v);
    const out = $('settings-ai-sens-val');
    if (out) out.textContent = String(v);
  }
  const obsHostInput = $('settings-obs-host');
  if (obsHostInput) obsHostInput.value = hubSettings.obsHost || '';
  const obsPortInput = $('settings-obs-port');
  if (obsPortInput) obsPortInput.value = hubSettings.obsPort || 4455;
  const obsPassInput = $('settings-obs-password');
  if (obsPassInput) {
    obsPassInput.value = hubSettings.obsPassword || '';
    obsPassInput.placeholder = hubSettings.obsPasswordSet ? '••••••••  ' + t('settings_ha_token_saved', 'Saved') : '';
  }
  const obsAutoInput = $('settings-obs-autolaunch');
  if (obsAutoInput) obsAutoInput.checked = hubSettings.obsAutoLaunch !== false;
  const sbHostInput = $('settings-sb-host');
  if (sbHostInput) sbHostInput.value = hubSettings.streamerbotHost || '';
  const sbPortInput = $('settings-sb-port');
  if (sbPortInput) sbPortInput.value = hubSettings.streamerbotPort || 8080;
  const sbPassInput = $('settings-sb-password');
  if (sbPassInput) {
    sbPassInput.value = hubSettings.streamerbotPassword || '';
    sbPassInput.placeholder = hubSettings.streamerbotPasswordSet ? '••••••••  ' + t('settings_ha_token_saved', 'Saved') : '';
  }
  const wlEnabledInput = $('settings-wavelink-enabled');
  if (wlEnabledInput) wlEnabledInput.checked = !!(hubSettings.wavelink && hubSettings.wavelink.enabled === true);
  const chromaEnabledInput = $('settings-chroma-enabled');
  if (chromaEnabledInput) chromaEnabledInput.checked = !!(hubSettings.chroma && hubSettings.chroma.enabled === true);
  // Bind the local-provider section once, then refresh its values on every render.
  initAiProviderSettings();
  syncAiProviderControls();
  syncAiFeaturesControls();
  syncWakeWordControls();
}

// Reflect the advanced AI feature toggles (master + per-feature) in Settings.
// The per-feature rows are visually disabled while the master switch is off so
// the opt-in chain (master → feature) is obvious at a glance.
function syncAiFeaturesControls() {
  const f = normalizeAiFeatures(hubSettings.aiFeatures);
  const master = $('settings-aifeat-master');
  if (master) master.checked = f.enabled;
  ['genesis', 'gameCompanion', 'guardian', 'ambient', 'pcControl'].forEach(key => {
    const input = $(`settings-aifeat-${key}`);
    if (!input) return;
    input.checked = f[key];
    input.disabled = !f.enabled;
    const row = input.closest('.aifeat-row');
    if (row) row.classList.toggle('aifeat-row-disabled', !f.enabled);
  });
}

let _aiProviderBound = false;

// One-time binding of the local-AI provider controls. Idempotent via a guard.
function initAiProviderSettings() {
  if (_aiProviderBound) return;
  const panel = $('ai-local-panel');
  const modelSel = $('ai-model-select');
  if (!panel || !modelSel) return; // markup not present yet
  _aiProviderBound = true;

  document.querySelectorAll('input[name="aiProvider"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      _reflectAiProviderRows(r.value);
      persistAiProviderSettings();
      if (r.value === 'ollama') { await aiLocalScan(); await aiLocalRefreshStatus(); await aiLocalSyncAutostart(); }
      else if (AI_CLI_PROVIDERS.includes(r.value)) aiCliRefresh(r.value, true);
      else if (r.value === 'xenon') { if (window.XenonCreditsSettings) window.XenonCreditsSettings.refresh(); }
      else _aiLoadProviderModels(r.value);
      if (window.XenonCreditsSettings) window.XenonCreditsSettings.render();
      if (window.XenonCredits) window.XenonCredits.renderChips();
    });
  });

  const rescan = $('ai-hw-rescan');
  if (rescan) rescan.addEventListener('click', aiLocalScan);
  const statusRefresh = $('ai-status-refresh');
  if (statusRefresh) statusRefresh.addEventListener('click', aiLocalRefreshStatus);
  const ollamaStart = $('ai-ollama-start');
  if (ollamaStart) ollamaStart.addEventListener('click', aiLocalStartOllama);
  const autostart = $('ai-ollama-autostart');
  if (autostart) autostart.addEventListener('change', async () => {
    try { await fetch('/api/ai-local/ollama-autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: autostart.checked }) }); }
    catch { /* ignore */ }
  });

  modelSel.addEventListener('change', () => {
    const custom = modelSel.value === '__custom__';
    const modelCustom = $('ai-model-custom');
    const modelWarn = $('ai-model-custom-warn');
    if (modelCustom) modelCustom.hidden = !custom;
    if (modelWarn) modelWarn.hidden = !custom;
    persistAiProviderSettings();
    _aiUpdateModelDownloadState();
  });
  const modelCustom = $('ai-model-custom');
  if (modelCustom) {
    modelCustom.addEventListener('change', persistAiProviderSettings);
    modelCustom.addEventListener('input', _aiUpdateModelDownloadState);
  }
  const urlInput = $('ai-ollama-url');
  if (urlInput) urlInput.addEventListener('change', persistAiProviderSettings);

  const pullBtn = $('ai-pull-model');
  if (pullBtn) pullBtn.addEventListener('click', aiLocalPullModel);
  const whisperInstall = $('ai-whisper-install');
  if (whisperInstall) whisperInstall.addEventListener('click', aiLocalInstallWhisper);
  const ollamaInstall = $('ai-ollama-install');
  if (ollamaInstall) ollamaInstall.addEventListener('click', () => window.open('https://ollama.com/download', '_blank'));
}

// THE answer to "is a Gemini key configured", for every surface that used to
// test `hubSettings.geminiApiKey` directly. Since the key is redacted on the
// wire, that truthiness test is false on a freshly loaded page even when a key
// has been saved for months — it would have turned every AI surface into
// "invalid key", which is exactly the failure the old comment in server.js
// predicted and used as the reason not to redact. The value is still checked
// first so the gate opens the instant the user finishes typing one, before the
// save has round-tripped.
function geminiKeyReady(settingsObj) {
  const s = settingsObj || (typeof hubSettings === 'object' ? hubSettings : null);
  return !!(s && (String(s.geminiApiKey || '').trim() || s.geminiApiKeySet === true));
}

function updateAiKey(value) {
  const v = String(value || '').trim().slice(0, 200);
  // Keep *Set true through the redacted round-trip (the server answers with
  // key:'' once it has stored it); an explicit removal goes through resetAiKey.
  hubSettings = normalizeSettings({ ...hubSettings, geminiApiKey: v, geminiApiKeySet: v.length > 0 || hubSettings.geminiApiKeySet === true });
  saveHubSettings();
  // Notify ai.js if wake word state needs to change
  if (typeof onAiKeyUpdated === 'function') onAiKeyUpdated();
  // Refresh the Media-tile chat (show input once a key is present, hide notice)
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
}

// The only way to actually remove a stored key: a save carrying key:'' WITHOUT
// the flag, which is what `preserveAiProviderCreds` reads as "the user cleared
// it" instead of "this is the redacted copy coming back".
function resetAiKey() {
  hubSettings = normalizeSettings({ ...hubSettings, geminiApiKey: '', geminiApiKeySet: false });
  saveHubSettings();
  if (typeof onAiKeyUpdated === 'function') onAiKeyUpdated();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
  syncAiSettingsControls();
}

// ChatGPT (OpenAI) + Claude (Anthropic) key/model handlers. The keys are
// server-only: we send them on save (preserved server-side), and keep the *Set
// flag true so the ready-gate and the "saved" placeholder stay correct even
// after the server redacts the value back to '' on the next hydrate.
function updateOpenaiKey(value) {
  const v = String(value || '').trim().slice(0, 200);
  hubSettings = normalizeSettings({ ...hubSettings, openaiApiKey: v, openaiApiKeySet: v.length > 0 || hubSettings.openaiApiKeySet === true });
  saveHubSettings();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
  if (v.length > 8) _aiScheduleModelRefresh('openai'); // a real key was entered → refresh the model list once it's saved
}
function updateOpenaiModel(value) {
  updateAiModelChoice('openaiModel', value);
}
function updateAnthropicKey(value) {
  const v = String(value || '').trim().slice(0, 200);
  hubSettings = normalizeSettings({ ...hubSettings, anthropicApiKey: v, anthropicApiKeySet: v.length > 0 || hubSettings.anthropicApiKeySet === true });
  saveHubSettings();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
  if (v.length > 8) _aiScheduleModelRefresh('anthropic'); // a real key was entered → refresh the model list once it's saved
}
function updateAnthropicModel(value) {
  updateAiModelChoice('anthropicModel', value);
}

// Remove a saved OpenAI/Anthropic key. Sends key='' with *Set=false, which the
// server honours as an explicit clear (preserveAiProviderCreds skips preserving
// when *Set is false), so the key is actually removed rather than kept.
function resetOpenaiKey() {
  hubSettings = normalizeSettings({ ...hubSettings, openaiApiKey: '', openaiApiKeySet: false });
  saveHubSettings();
  syncAiProviderControls();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
}
function resetAnthropicKey() {
  hubSettings = normalizeSettings({ ...hubSettings, anthropicApiKey: '', anthropicApiKeySet: false });
  saveHubSettings();
  syncAiProviderControls();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
}
