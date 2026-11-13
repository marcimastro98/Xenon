// The animated background settings: the effect choices, editing custom code with its live preview
// and error notes, and their controls.
'use strict';

// ── Background FX controls (aurora + grid) ────────────────────────
function updateBgFx(group, key, value) {
  if (!['bgAurora', 'bgGrid'].includes(group)) return;
  const current = hubSettings[group] && typeof hubSettings[group] === 'object' ? hubSettings[group] : {};
  const next = { ...current, [key]: key === 'enabled' ? !!value : value };
  hubSettings = normalizeSettings({ ...hubSettings, [group]: next });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
}

// Static background style/intensity (Settings → Sfondo). Picking a style other
// than 'none' supersedes the animated aurora (see applyHubSettings).
function updateBgStatic(key, value) {
  if (!['style', 'intensity'].includes(key)) return;
  const current = hubSettings.bgStatic && typeof hubSettings.bgStatic === 'object' ? hubSettings.bgStatic : {};
  const next = { ...current, [key]: value };
  hubSettings = normalizeSettings({ ...hubSettings, bgStatic: next });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
}

function updateGridColor(rawValue) {
  const raw = String(rawValue || '').trim();
  const hex = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, null);
  const input = $('settings-grid-color');
  if (!hex) { if (input) input.classList.add('invalid'); return; }
  if (input) input.classList.remove('invalid');
  const swatch = $('settings-grid-color-swatch');
  if (swatch) swatch.style.background = hex;
  updateBgFx('bgGrid', 'color', hex);
}

function updateBgCustom(key, value) {
  if (!['enabled', 'name', 'code', 'assets', 'fps'].includes(key)) return;
  const current = hubSettings.bgCustom && typeof hubSettings.bgCustom === 'object' ? hubSettings.bgCustom : {};
  const next = { ...current, [key]: key === 'enabled' ? !!value : value };
  if (key === 'code') next.imported = false;   // user replaced the code → their own background again
  hubSettings = normalizeSettings({ ...hubSettings, bgCustom: next });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
  // No live frame means no status to show — clear any stale error.
  if (!next.enabled || !String(next.code || '').trim()) clearBgCodeError();
}

// The heavy-background guard on/off (js/bg-guard.js). A change remounts the
// background, so turning it back on measures the code again from the start.
function updateBgGuard(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, bgGuard: !!enabled });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
  setSettingsStatus('settings_saved', 'ok');
}

let bgCodeLiveTimer = 0;
// Repaint the animated background WHILE typing (debounced) instead of only on
// blur, so the editor feels live. onchange still fires on blur as a final flush.
function updateBgCustomCodeLive(value) {
  if (bgCodeLiveTimer) clearTimeout(bgCodeLiveTimer);
  bgCodeLiveTimer = setTimeout(() => { bgCodeLiveTimer = 0; updateBgCustom('code', value); }, 400);
}

// Live character counter for the code editor. The code is capped at
// BG_CUSTOM_CODE_MAX (normalizeBgCustom slices it), so without this the excess
// would be truncated silently. Fires immediately on input (not debounced) and
// on every sync, turning warning-coloured near the cap and surfacing an
// explicit over-limit note past it — so hitting the ceiling is never a surprise.
function updateBgCodeCount(len) {
  const el = $('settings-bgcode-count');
  if (el) {
    el.textContent = len + ' / ' + BG_CUSTOM_CODE_MAX;
    el.classList.toggle('is-near', len > BG_CUSTOM_CODE_MAX * 0.9 && len <= BG_CUSTOM_CODE_MAX);
    el.classList.toggle('is-over', len > BG_CUSTOM_CODE_MAX);
  }
  const note = $('settings-bgcode-overlimit');
  if (note) note.hidden = len <= BG_CUSTOM_CODE_MAX;
}

function clearBgCodeError() {
  const el = $('settings-bgcode-error');
  if (el) { el.hidden = true; el.textContent = ''; }
}
// Show/clear the inline error under the code editor from the sandbox frame's
// reported status (dispatched by custom-bg.js). Untrusted message → textContent.
function renderBgCodeError(detail) {
  const el = $('settings-bgcode-error');
  if (!el) return;
  const d = detail || {};
  if (d.ok || !d.kind) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = (d.kind === 'nodraw')
    ? t('settings_bg_code_nodraw')
    : (d.kind === 'asset')
      ? t('settings_bg_code_asset_error') + (d.message ? ': ' + d.message : '')
      : t('settings_bg_code_error') + (d.message ? ': ' + d.message : '');
  el.hidden = false;
}

// Tell the author when their snippet is frozen by the machine rather than by
// their code. On a hybrid-GPU machine the background runs for ~3s and then stops
// for the session (js/custom-bg.js hostPaused → body.low-power-gpu), which reads
// exactly like a broken animation loop: a theme author burned hours rewriting a
// working snippet before we found it (#118). This is not an error, so it is a
// separate note from renderBgCodeError's alert and says how to switch it off.
function renderBgFrozenNote() {
  const el = $('settings-bgcode-frozen');
  if (!el) return;
  const frozen = !!(window.NativeGpuPause
    && window.NativeGpuPause.isLowPowerGpu()
    && hubSettings.hybridGpuAnimationPause !== false);
  el.textContent = frozen ? t('settings_bg_code_frozen_gpu') : '';
  el.hidden = !frozen;
}

// What the heavy-background guard did to the running background, so an author
// testing a snippet knows the slowdown is the PC's guard, not their code.
const BG_SLOW_NOTES = ['', 'settings_bg_slow_fps', 'settings_bg_slow_res', 'settings_bg_slow_still'];
function renderBgSlowNote() {
  const el = $('settings-bgcode-slow');
  if (!el) return;
  const level = (window.CustomBg && typeof CustomBg.slowLevel === 'function') ? CustomBg.slowLevel() : 0;
  el.textContent = level ? t(BG_SLOW_NOTES[level]) : '';
  el.hidden = !level;
}
// The still image is the one step the user can see, so it is said once per
// background per session; the two lighter steps only show in the editor.
const _bgStillToldFor = new Set();

// Drop a starter snippet into the code box (and enable the background so the user
// sees it immediately). Never overwrites non-empty code without asking.
async function applyBgCustomTemplate(id) {
  const code = BG_CUSTOM_TEMPLATES[id];
  if (!code) return;
  const existing = (hubSettings.bgCustom && hubSettings.bgCustom.code) || '';
  if (existing.trim()) {
    const okReplace = await settingsPrompt({
      type: 'confirm',
      title: t('settings_bg_code_editor'),
      message: t('settings_bg_code_replace'),
      okLabel: t('dlg_replace'),
    });
    if (!okReplace) return;
  }
  const current = hubSettings.bgCustom && typeof hubSettings.bgCustom === 'object' ? hubSettings.bgCustom : {};
  // A picked preset ships with Xenon → the user's own choice, not an import.
  hubSettings = normalizeSettings({ ...hubSettings, bgCustom: { ...current, code, enabled: true, imported: false } });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
}

function syncBgFxControls() {
  const a = normalizeBgAurora(hubSettings.bgAurora);
  const g = normalizeBgGrid(hubSettings.bgGrid);
  const setVal = (id, val) => { const el = $(id); if (el) el.value = val; };
  const setChk = (id, on) => { const el = $(id); if (el) el.checked = on; };
  setChk('settings-aurora-enabled', a.enabled);
  setVal('settings-aurora-intensity', String(a.intensity));
  setVal('settings-aurora-speed', String(a.speed));
  setChk('settings-grid-enabled', g.enabled);
  setVal('settings-grid-intensity', String(g.intensity));
  setVal('settings-grid-speed', String(g.speed));
  const colorInput = $('settings-grid-color');
  if (colorInput) { colorInput.value = g.color.toUpperCase(); colorInput.classList.remove('invalid'); }
  const colorSwatch = $('settings-grid-color-swatch');
  if (colorSwatch) colorSwatch.style.background = g.color;

  // Static background picker
  const st = normalizeBgStatic(hubSettings.bgStatic);
  document.querySelectorAll('.bgstatic-option').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.bgstatic === st.style ? 'true' : 'false');
  });
  setVal('settings-bgstatic-intensity', String(st.intensity));
  const intensityRow = $('settings-bgstatic-intensity-row');
  if (intensityRow) intensityRow.hidden = st.style === 'none';
  const staticActive = st.style !== 'none';
  // A custom image/video background takes priority over the static bg (and every
  // FX layer). Tell the user their pick is hidden rather than silently no-op'ing.
  const mediaActive = !!hubSettings.backgroundMedia;
  const mediaNote = $('settings-bgstatic-media-off');
  if (mediaNote) mediaNote.hidden = !(staticActive && mediaActive);

  // Code-defined background controls + its own priority. When it's on it owns the
  // backdrop just like a static bg, so the aurora/grid/static are superseded.
  renderBgFrozenNote();
  renderBgSlowNote();
  const cb = normalizeBgCustom(hubSettings.bgCustom);
  setChk('settings-bgcode-enabled', cb.enabled);
  setChk('settings-bgguard-enabled', hubSettings.bgGuard !== false);
  const codeName = $('settings-bgcode-name');
  if (codeName && document.activeElement !== codeName) codeName.value = cb.name;
  const codeFps = $('settings-bgcode-fps');
  if (codeFps) {
    // Bounds come from the rule owner so the field can never drift from what
    // the sanitizer actually accepts (same contract as the ASSET_* caps).
    if (window.CustomBg && CustomBg.FPS_MIN) { codeFps.min = String(CustomBg.FPS_MIN); codeFps.max = String(CustomBg.FPS_MAX); }
    if (document.activeElement !== codeFps) codeFps.value = String(cb.fps);
  }
  const codeField = $('settings-bgcode-input');
  // An imported background is someone else's work: never surface or let them edit
  // the source. Lock the editor entirely (empty + disabled + hidden), hide the
  // "how to write code" help, and show a lock banner. A template swap below flips
  // imported off (updateBgCustom → applyBgCustomTemplate), restoring the editor.
  const codeLocked = cb.imported === true && !!cb.code;
  const editorRow = $('settings-bgcode-editor-row');
  const codeHelp = $('settings-bgcode-help');
  const codeLockNote = $('settings-bgcode-locked');
  if (editorRow) editorRow.hidden = codeLocked;
  if (codeHelp) codeHelp.hidden = codeLocked;
  if (codeLockNote) codeLockNote.hidden = !codeLocked;
  if (codeField) {
    codeField.disabled = codeLocked;
    codeField.readOnly = codeLocked;
    if (codeLocked) {
      // Do not leave the source in the DOM at all — clear the field's value.
      codeField.value = '';
    } else if (document.activeElement !== codeField) {
      codeField.value = cb.code;
    }
  }
  // Keep the counter honest: reflect the field's live length when the user is
  // typing, otherwise the stored (already-capped) code length. Hidden while locked.
  updateBgCodeCount(codeLocked ? 0 : (codeField && document.activeElement === codeField ? codeField.value.length : cb.code.length));
  renderBgAssetChips();
  const codeMediaNote = $('settings-bgcode-media-off');
  if (codeMediaNote) codeMediaNote.hidden = !(cb.enabled && mediaActive);
  const codeGroup = $('settings-bgcode-group');
  if (codeGroup) codeGroup.classList.toggle('is-superseded', mediaActive);

  // The backdrop can be owned by a static premium bg OR a code-defined one: in
  // either case the animated aurora and neon grid don't render, so their controls
  // are disabled and annotated (the UI never claims an effect that isn't showing).
  const backdropOwned = staticActive || cb.enabled;
  const auroraNote = $('settings-aurora-superseded');
  if (auroraNote) auroraNote.hidden = !backdropOwned;
  const auroraGroup = $('settings-aurora-group');
  if (auroraGroup) auroraGroup.classList.toggle('is-superseded', backdropOwned);
  const gridNote = $('settings-grid-superseded');
  if (gridNote) gridNote.hidden = !backdropOwned;
  const gridGroup = $('settings-grid-group');
  if (gridGroup) gridGroup.classList.toggle('is-superseded', backdropOwned);
  [
    'settings-aurora-enabled', 'settings-aurora-intensity', 'settings-aurora-speed',
    'settings-grid-enabled', 'settings-grid-intensity', 'settings-grid-speed', 'settings-grid-color',
  ].forEach(id => {
    const el = $(id); if (el) el.disabled = backdropOwned;
  });
  // A code-defined background supersedes the static premium picker too.
  const staticGroup = $('settings-bgstatic-group');
  if (staticGroup) staticGroup.classList.toggle('is-superseded', cb.enabled);
  // The see-through window shows the desktop instead of every one of these; the
  // switch's own group says so in words (syncSeeThroughControl).
  if (seeThroughWindowOn()) {
    ['settings-bgstatic-group', 'settings-aurora-group', 'settings-grid-group', 'settings-bgcode-group'].forEach((id) => {
      const group = $(id);
      if (group) group.classList.add('is-superseded');
    });
  }
}
