// The background picture or video and the custom font: checking a file, showing it, uploading and
// removing it.
'use strict';

function isVideoBackground(media) {
  return media && /^video\//.test(media.type);
}

function isSupportedBackgroundFile(file) {
  if (!file) return false;
  if (file.type && SETTINGS_BACKGROUND_TYPES.has(file.type.toLowerCase())) return true;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return SETTINGS_BACKGROUND_EXTENSIONS.has(ext);
}

function isSupportedFontFile(file) {
  if (!file) return false;
  // Browsers report font MIME types inconsistently, so the extension is the
  // authority (matching the server's POST /font validation).
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  if (SETTINGS_FONT_EXTENSIONS.has(ext)) return true;
  return !!(file.type && SETTINGS_FONT_TYPES.has(file.type.toLowerCase()));
}

// CSS format() hint by extension — helps the browser pick/decode the face.
function getFontSource(font) {
  return ThemeTokens.fontSource(font);
}

function getBackgroundSource(media) {
  return ThemeTokens.backgroundSource(media);
}

function createBackgroundImage(source) {
  const image = document.createElement('img');
  image.id = 'user-bg-image';
  image.alt = '';
  image.dataset.source = source;
  image.src = source;
  return image;
}

// The wallpaper video holds still whenever the ambient does: behind a frosted
// overlay (ambient-freeze.js, the flicker guard), while a game is in front
// (game-mode) and under Performance mode's paused animations (perf-mode).
// Decoding and compositing a full-screen video every frame is the largest steady
// cost a wallpaper adds, and during a game it competes with the game for the
// GPU. A paused video keeps its current frame: a still wallpaper, never a blank.
const BG_VIDEO_HOLD_CLASSES = ['overlay-frozen', 'game-mode', 'perf-mode'];
function backgroundVideoHeld() {
  const classes = document.body.classList;
  return BG_VIDEO_HOLD_CLASSES.some(cls => classes.contains(cls));
}

let _bgVideoWasHeld = false;
function syncBackgroundVideoHold() {
  const held = backgroundVideoHeld();
  if (held === _bgVideoWasHeld) return;
  _bgVideoWasHeld = held;
  const video = $('user-bg-video');
  if (!video || video.hidden) return;
  if (held) video.pause();
  else ensureBackgroundVideoPlayback(video);
}

function ensureBackgroundVideoPlayback(video = $('user-bg-video')) {
  if (!video || video.hidden || document.hidden) return;
  if (backgroundVideoHeld()) { video.pause(); return; }
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  const playAttempt = video.play();
  if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {});
}

function clearBackgroundVideoError(video) {
  const media = hubSettings.backgroundMedia;
  if (!video || !media || !isVideoBackground(media)) return;
  if (video.dataset.source !== getBackgroundSource(media)) return;
  const status = $('settings-status');
  if (status?.dataset.messageKey === 'settings_bg_video_failed') setSettingsStatus('', '');
}

function reportBackgroundVideoError(video) {
  const media = hubSettings.backgroundMedia;
  if (!video || !media || !isVideoBackground(media)) return;
  if (video.dataset.source !== getBackgroundSource(media)) return;
  if (video.readyState >= 2) return;
  setSettingsStatus('settings_bg_video_failed', 'error');
}

function createBackgroundVideo(source) {
  const video = document.createElement('video');
  video.id = 'user-bg-video';
  video.autoplay = true;
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.controls = false;
  video.disablePictureInPicture = true;
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.dataset.source = source;
  video.addEventListener('loadeddata', () => { clearBackgroundVideoError(video); ensureBackgroundVideoPlayback(video); });
  video.addEventListener('canplay', () => { clearBackgroundVideoError(video); ensureBackgroundVideoPlayback(video); });
  video.addEventListener('error', () => reportBackgroundVideoError(video));
  video.src = source;
  video.load();
  ensureBackgroundVideoPlayback(video);
  return video;
}

function replaceBackgroundNode(current, fresh, fallbackParent) {
  if (current) current.replaceWith(fresh);
  else fallbackParent.appendChild(fresh);
  return fresh;
}

async function uploadSettingsBackground(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!isSupportedBackgroundFile(file)) {
    input.value = '';
    setSettingsStatus('settings_bg_unsupported', 'error');
    return;
  }
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
    if (data.converted) setSettingsStatus('settings_bg_converted', 'ok');
    else if (data.conversion === 'ffmpeg-missing') setSettingsStatus('settings_bg_convert_missing', 'error');
    else if (data.conversion === 'failed') setSettingsStatus('settings_bg_convert_failed', 'error');
    else setSettingsStatus('settings_bg_uploaded', 'ok');
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

// Paste raw SVG markup as the wallpaper (stored inline as a data: URI, rendered
// only as an <img> — safe). An alternative to uploading an image/video file.
async function pasteSettingsBackgroundSvg() {
  const uri = await openSvgPasteDialog();
  if (!uri) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    backgroundMedia: { url: uri, name: 'svg', type: 'image/svg+xml', version: String(Date.now()) },
  });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_bg_uploaded', 'ok');
}

async function uploadSettingsFont(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!isSupportedFontFile(file)) {
    input.value = '';
    setSettingsStatus('settings_font_unsupported', 'error');
    return;
  }
  if (file.size > SETTINGS_MAX_FONT_BYTES) {
    input.value = '';
    setSettingsStatus('settings_font_too_large', 'error');
    return;
  }

  const form = new FormData();
  form.append('font', file);
  setSettingsStatus('settings_font_uploading', '');

  try {
    const res = await fetch('/font', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || res.statusText);
    hubSettings = normalizeSettings({
      ...hubSettings,
      uiFont: { url: data.url, name: data.name || file.name, version: String(Date.now()) },
    });
    saveHubSettings();
    applyHubSettings();
    renderSettingsModal();
    setSettingsStatus('settings_font_uploaded', 'ok');
  } catch {
    setSettingsStatus('settings_font_upload_failed', 'error');
  } finally {
    input.value = '';
  }
}

function clearSettingsFont() {
  hubSettings = normalizeSettings({ ...hubSettings, uiFont: null });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_font_removed', 'ok');
}
