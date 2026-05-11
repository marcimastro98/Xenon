'use strict';

const SETTINGS_STORAGE_KEY = 'xeneonedge.settings.v1';
const SETTINGS_MAX_BACKGROUND_BYTES = 200 * 1024 * 1024;

const DEFAULT_HUB_SETTINGS = Object.freeze({
  accent: '#1ed760',
  background: '#070808',
  text: '#f0f3f1',
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  backgroundMedia: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
});

const SETTINGS_PRESETS = Object.freeze([
  { id: 'xenon',   nameKey: 'settings_preset_xenon',   accent: '#1ed760', background: '#070808', text: '#f0f3f1' },
  { id: 'ocean',   nameKey: 'settings_preset_ocean',   accent: '#46c7e8', background: '#050a12', text: '#eefaff' },
  { id: 'ember',   nameKey: 'settings_preset_ember',   accent: '#ff8a3d', background: '#100807', text: '#fff4ee' },
  { id: 'violet',  nameKey: 'settings_preset_violet',  accent: '#a78bfa', background: '#090712', text: '#f7f2ff' },
  { id: 'mono',    nameKey: 'settings_preset_mono',    accent: '#f0f3f1', background: '#000000', text: '#f7f7f2' },
]);

let hubSettings = loadHubSettings();
let settingsStatusTimer = null;
let settingsServerSaveTimer = null;

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) {
    return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  }
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

function hexToRgb(hex) {
  const safe = normalizeHex(hex, DEFAULT_HUB_SETTINGS.accent).slice(1);
  return [0, 2, 4].map(index => parseInt(safe.slice(index, index + 2), 16));
}

function sanitizeBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!url.startsWith('/uploads/')) return null;
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (!/^(image|video)\//.test(type)) return null;
  return { url, name: name || url.split('/').pop(), type, version };
}

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

function normalizeSettings(source) {
  const value = source && typeof source === 'object' ? source : {};
  return {
    accent: normalizeHex(value.accent, DEFAULT_HUB_SETTINGS.accent),
    background: normalizeHex(value.background, DEFAULT_HUB_SETTINGS.background),
    text: normalizeHex(value.text, DEFAULT_HUB_SETTINGS.text),
    panelAlpha: clampNumber(value.panelAlpha, 0.42, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(value.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(value.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    backgroundMedia: sanitizeBackgroundMedia(value.backgroundMedia),
    lockWidgets: normalizeLockWidgets(value.lockWidgets),
  };
}

function loadHubSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'));
  } catch {
    return normalizeSettings(null);
  }
}

function saveLocalHubSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(hubSettings));
}

function postHubSettingsToServer() {
  const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
  return fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  });
}

function queueHubSettingsServerSave() {
  clearTimeout(settingsServerSaveTimer);
  settingsServerSaveTimer = setTimeout(() => {
    settingsServerSaveTimer = null;
    postHubSettingsToServer().catch(() => {});
  }, 250);
}

function saveHubSettings(options = {}) {
  hubSettings = normalizeSettings(hubSettings);
  saveLocalHubSettings();
  if (options.server !== false) queueHubSettingsServerSave();
}

function sendHubSettingsBeacon() {
  try {
    const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/settings', new Blob([body], { type: 'application/json' }));
      return;
    }
    postHubSettingsToServer().catch(() => {});
  } catch {}
}

async function hydrateHubSettingsFromServer() {
  try {
    const res = await fetch('/settings', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (!data || !data.settings) {
      postHubSettingsToServer().catch(() => {});
      return;
    }
    hubSettings = normalizeSettings(data.settings);
    saveHubSettings({ server: false });
    applyHubSettings();
    if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
  } catch {}
}

function isVideoBackground(media) {
  return media && /^video\//.test(media.type);
}

function getBackgroundSource(media) {
  if (!media) return '';
  return media.version ? `${media.url}?v=${encodeURIComponent(media.version)}` : media.url;
}

function createBackgroundImage(source) {
  const image = document.createElement('img');
  image.id = 'user-bg-image';
  image.alt = '';
  image.dataset.source = source;
  image.src = source;
  return image;
}

function createBackgroundVideo(source) {
  const video = document.createElement('video');
  video.id = 'user-bg-video';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.dataset.source = source;
  video.src = source;
  video.load();
  video.play().catch(() => {});
  return video;
}

function replaceBackgroundNode(current, fresh, fallbackParent) {
  if (current) current.replaceWith(fresh);
  else fallbackParent.appendChild(fresh);
  return fresh;
}

function applyHubSettings() {
  hubSettings = normalizeSettings(hubSettings);
  const root = document.documentElement;
  const accentRgb = hexToRgb(hubSettings.accent).join(', ');
  const panelSoftAlpha = Math.max(0.35, Math.min(1, hubSettings.panelAlpha - 0.02));

  root.style.setProperty('--accent', hubSettings.accent);
  root.style.setProperty('--green', hubSettings.accent);
  root.style.setProperty('--accent-rgb', accentRgb);
  root.style.setProperty('--bg', hubSettings.background);
  root.style.setProperty('--text', hubSettings.text);
  root.style.setProperty('--panel-alpha', hubSettings.panelAlpha.toFixed(2));
  root.style.setProperty('--panel-soft-alpha', panelSoftAlpha.toFixed(2));
  root.style.setProperty('--bg-dim', hubSettings.bgDim.toFixed(2));
  root.style.setProperty('--bg-blur', `${Math.round(hubSettings.bgBlur)}px`);

  const media = hubSettings.backgroundMedia;
  const bgLayer = $('user-bg-layer');
  let image = $('user-bg-image');
  let video = $('user-bg-video');
  document.body.classList.toggle('has-user-bg', !!media);
  document.body.classList.toggle('no-user-bg', !media);

  if (!bgLayer || !image || !video) return;
  if (!media) {
    image.hidden = true;
    image.removeAttribute('src');
    delete image.dataset.source;
    video.hidden = true;
    video.pause();
    video.removeAttribute('src');
    delete video.dataset.source;
    document.body.removeAttribute('data-bg-type');
    return;
  }

  const source = getBackgroundSource(media);

  if (isVideoBackground(media)) {
    image.hidden = true;
    image.removeAttribute('src');
    delete image.dataset.source;
    if (!video || video.dataset.source !== source) {
      if (video) video.pause();
      video = replaceBackgroundNode(video, createBackgroundVideo(source), bgLayer);
    } else {
      video.hidden = false;
      video.play().catch(() => {});
    }
    video.hidden = false;
    document.body.dataset.bgType = 'video';
  } else {
    video.hidden = true;
    video.pause();
    video.removeAttribute('src');
    delete video.dataset.source;
    if (!image || image.dataset.source !== source) {
      image = replaceBackgroundNode(image, createBackgroundImage(source), bgLayer);
    } else {
      image.hidden = false;
    }
    image.hidden = false;
    document.body.dataset.bgType = 'image';
  }
}

function formatPercent(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

function findMatchingPreset() {
  return SETTINGS_PRESETS.find(preset =>
    normalizeHex(preset.accent, '') === hubSettings.accent &&
    normalizeHex(preset.background, '') === hubSettings.background &&
    normalizeHex(preset.text, '') === hubSettings.text
  );
}

function renderSettingsPresets() {
  const box = $('settings-presets');
  if (!box) return;
  const active = findMatchingPreset();
  box.replaceChildren(...SETTINGS_PRESETS.map(preset => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset-btn${active && active.id === preset.id ? ' active' : ''}`;
    btn.setAttribute('aria-label', t(preset.nameKey));
    btn.style.setProperty('--preset-accent', preset.accent);
    btn.style.setProperty('--preset-glow', `${preset.accent}88`);
    btn.addEventListener('click', () => setThemePreset(preset.id));

    const swatch = document.createElement('span');
    swatch.className = 'preset-swatch';
    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = t(preset.nameKey);
    btn.append(swatch, name);
    return btn;
  }));
}

function syncSettingsControls() {
  // Sync color preview divs + hex text for each color key
  ['accent', 'background', 'text'].forEach(key => {
    const hex = hubSettings[key];
    const preview = $(`settings-${key}-swatch`);
    const hexInput = $(`settings-${key}`);
    if (preview) preview.style.background = hex;
    if (hexInput) { hexInput.value = hex.toUpperCase(); hexInput.classList.remove('invalid'); }
  });

  const rangeMap = [
    ['settings-panel-alpha', String(hubSettings.panelAlpha)],
    ['settings-bg-dim', String(hubSettings.bgDim)],
    ['settings-bg-blur', String(hubSettings.bgBlur)],
  ];
  rangeMap.forEach(([id, value]) => { const el = $(id); if (el) el.value = value; });

  const panelValue = $('settings-panel-alpha-value');
  if (panelValue) panelValue.textContent = formatPercent(hubSettings.panelAlpha);
  const dimValue = $('settings-bg-dim-value');
  if (dimValue) dimValue.textContent = formatPercent(hubSettings.bgDim);
  const blurValue = $('settings-bg-blur-value');
  if (blurValue) blurValue.textContent = `${Math.round(hubSettings.bgBlur)}px`;

  const media = hubSettings.backgroundMedia;
  const title = $('settings-bg-title');
  const sub = $('settings-bg-sub');
  if (title) title.textContent = media ? media.name : t('settings_bg_upload');
  if (sub) sub.textContent = media ? t(isVideoBackground(media) ? 'settings_bg_video_loaded' : 'settings_bg_image_loaded') : t('settings_bg_upload_hint');
  const blurNote = $('settings-bg-blur-note');
  if (blurNote) blurNote.textContent = media ? t('settings_bg_blur_note_active') : t('settings_bg_blur_note_empty');

  // Sync active language button
  syncLangButtons();
  syncLockWidgetSettings();
}

function renderSettingsModal() {
  renderSettingsPresets();
  syncSettingsControls();
}

function setSettingsStatus(messageKey, mode) {
  const el = $('settings-status');
  if (!el) return;
  clearTimeout(settingsStatusTimer);
  el.classList.remove('ok', 'error');
  if (mode) el.classList.add(mode);
  el.textContent = messageKey ? t(messageKey) : '';
  if (messageKey) settingsStatusTimer = setTimeout(() => setSettingsStatus('', ''), 2600);
}

function syncLangButtons() {
  document.querySelectorAll('.settings-lang-btn[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
}

function toggleSettings() {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  overlay.hidden = !overlay.hidden;
  if (!overlay.hidden) renderSettingsModal();
}

function closeSettings() {
  const overlay = $('settings-overlay');
  if (overlay) overlay.hidden = true;
}

function setThemePreset(id) {
  const preset = SETTINGS_PRESETS.find(item => item.id === id);
  if (!preset) return;
  hubSettings = normalizeSettings({ ...hubSettings, accent: preset.accent, background: preset.background, text: preset.text });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
}

function updateSettingsColor(key, value) {
  if (!['accent', 'background', 'text'].includes(key)) return;
  const hex = normalizeHex(value, null);
  if (!hex) return;
  hubSettings = normalizeSettings({ ...hubSettings, [key]: hex });
  saveHubSettings();
  applyHubSettings();
  renderSettingsPresets(); // aggiorna solo l'evidenziazione dei preset, senza resettare i colori aperti
}

/* ── Hex text input helper ───────────────────────────────── */

/**
 * Chiamata da oninput/onchange del campo hex testuale.
 * Applica il colore solo se il valore è un hex valido.
 */
function onHexInput(key, rawValue) {
  const input = $(`settings-${key}`);
  const raw = rawValue.trim();
  const hex = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, null);
  if (!hex) {
    if (input) input.classList.add('invalid');
    return;
  }
  if (input) input.classList.remove('invalid');
  const preview = $(`settings-${key}-swatch`);
  if (preview) preview.style.background = hex;
  updateSettingsColor(key, hex);
}

function updateSettingsRange(key, value) {
  if (!['panelAlpha', 'bgDim', 'bgBlur'].includes(key)) return;
  hubSettings = normalizeSettings({ ...hubSettings, [key]: value });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
}

function syncLockWidgetSettings() {
  const widgets = normalizeLockWidgets(hubSettings.lockWidgets);
  Object.entries(widgets).forEach(([key, enabled]) => {
    const input = $(`settings-lock-${key}`);
    if (input) input.checked = enabled;
  });
}

function updateLockWidgetSetting(key, enabled) {
  if (!['clock', 'weather', 'media', 'calendar'].includes(key)) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    lockWidgets: { ...hubSettings.lockWidgets, [key]: !!enabled },
  });
  saveHubSettings();
  syncLockWidgetSettings();
  if (typeof refreshLockScreen === 'function') refreshLockScreen();
  setSettingsStatus('settings_saved', 'ok');
}

async function uploadSettingsBackground(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (file.size > SETTINGS_MAX_BACKGROUND_BYTES) {
    input.value = '';
    setSettingsStatus('settings_bg_too_large', 'error');
    return;
  }

  const form = new FormData();
  form.append('background', file);
  setSettingsStatus('settings_bg_uploading', '');

  try {
    const res = await fetch('/background', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || res.statusText);
    hubSettings = normalizeSettings({
      ...hubSettings,
      backgroundMedia: { url: data.url, name: data.name || file.name, type: data.type || file.type, version: String(Date.now()) },
    });
    saveHubSettings();
    applyHubSettings();
    renderSettingsModal();
    setSettingsStatus('settings_bg_uploaded', 'ok');
  } catch {
    setSettingsStatus('settings_bg_upload_failed', 'error');
  } finally {
    input.value = '';
  }
}

function clearSettingsBackground() {
  hubSettings = normalizeSettings({ ...hubSettings, backgroundMedia: null });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_bg_removed', 'ok');
}

function resetHubAppearance() {
  hubSettings = normalizeSettings(DEFAULT_HUB_SETTINGS);
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_reset_done', 'ok');
}

function reloadHubSettingsFromStorage() {
  hubSettings = loadHubSettings();
  applyHubSettings();
  if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
}

window.SETTINGS_STORAGE_KEY = SETTINGS_STORAGE_KEY;
applyHubSettings();
hydrateHubSettingsFromServer();
window.addEventListener('pagehide', sendHubSettingsBeacon);
