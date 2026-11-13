// The idle-screen and lock-screen settings: when it starts, which scene, and what this PC allows.
'use strict';

function syncLockWidgetSettings() {
  const widgets = normalizeLockWidgets(hubSettings.lockWidgets);
  Object.entries(widgets).forEach(([key, enabled]) => {
    const input = $(`settings-lock-${key}`);
    if (input) input.checked = enabled;
  });
  syncAmbientSettings();
}

// ── Ambient / Screensaver settings panel ─────────────────────────────
function syncAmbientSettings() {
  const cfg = normalizeAmbientMode(hubSettings.ambientMode);
  const enabled = $('settings-ambient-enabled');
  if (enabled) enabled.checked = cfg.enabled;
  const onStartup = $('settings-ambient-startup');
  if (onStartup) onStartup.checked = cfg.openOnStartup;
  const idle = $('settings-ambient-idle');
  if (idle) {
    const want = String(cfg.idleMinutes);
    if (idle.value !== want) {
      idle.value = want;
      // #settings-ambient-idle is a data-custom-select: it only re-syncs its
      // visible label on a 'change' event. Setting .value alone leaves the label
      // stuck on the HTML default ("Mai"), so a saved idle time looked reverted
      // after a refresh. The guarded updateAmbientSetting makes this a no-op save.
      idle.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  syncAmbientPcSettings(cfg);
  syncAmbientScenePicker(cfg);
  renderAmbientSceneManager();
  // The lockWidgets toggles only shape the builtin scene.
  const builtinWidgets = $('settings-ambient-builtin-widgets');
  if (builtinWidgets) builtinWidgets.hidden = cfg.sceneId !== 'builtin';
  // …and say WHY they went away, which the disappearance alone does not.
  //
  // Only the classic scene is drawn on translucent layers, so only it lets the
  // wallpaper through. Every other scene — an installed package or a canvas
  // layout — sits on an opaque overlay and IS the picture, edge to edge.
  // Reported on Discord by a user who uploaded a background, opened Ambient,
  // and saw the artwork of the scene he had picked instead. Nothing was broken
  // and nothing said so: the choice that overrode his wallpaper was three rows
  // above, made days earlier. Same note the background colour row has carried
  // for the same reason.
  syncAmbientSceneNote(cfg);
  // A disabled mode also retires its topbar button.
  const topBtn = $('ambient-topbtn');
  if (topBtn) topBtn.hidden = !cfg.enabled;
}

// Fill the scene <select> with builtin + every installed surface:'ambient'
// package. Options are rebuilt from the trusted normalized manifest list;
// names are untrusted manifest text → option.textContent.
function syncAmbientScenePicker(cfg) {
  const select = $('settings-ambient-scene');
  if (!select) return;
  const packages = (window.CustomWidget && typeof CustomWidget.cachedPackages === 'function')
    ? CustomWidget.cachedPackages().filter(p => p && p.surface === 'ambient') : [];
  const builtin = document.createElement('option');
  builtin.value = 'builtin';
  builtin.setAttribute('data-i18n', 'ambient_scene_builtin');
  builtin.textContent = t('ambient_scene_builtin');
  const options = [builtin];
  // Native canvas scenes the user composed in the editor (value "canvas:<id>").
  const scenes = Array.isArray(hubSettings.ambientScenes) ? hubSettings.ambientScenes : [];
  scenes.forEach(sc => {
    if (!sc || !sc.id) return;
    const opt = document.createElement('option');
    opt.value = 'canvas:' + sc.id;
    opt.textContent = sc.name || t('ambient_editor_untitled');
    options.push(opt);
  });
  packages.forEach(pkg => {
    const opt = document.createElement('option');
    opt.value = pkg.id;
    opt.textContent = pkg.name;
    options.push(opt);
  });
  // The animated backgrounds of the saved themes (value "theme:<id>").
  const themes = themesWithBackground(hubSettings.customThemes);
  themes.forEach(theme => {
    const opt = document.createElement('option');
    opt.value = THEME_SCENE_PREFIX + theme.id;
    opt.textContent = theme.name || t('ambient_editor_untitled');
    options.push(opt);
  });
  select.replaceChildren(...options);
  // Keep the saved choice selected even while its package list hasn't loaded
  // yet — never silently rewrite the persisted sceneId from a sync pass. Canvas
  // refs are matched against the saved-scenes array, not the package list.
  const isCanvasSel = typeof AmbientScene !== 'undefined' && AmbientScene.isCanvasRef(cfg.sceneId);
  const known = cfg.sceneId === 'builtin'
    || packages.some(p => p.id === cfg.sceneId)
    || (isCanvasSel && scenes.some(s => s && 'canvas:' + s.id === cfg.sceneId))
    || themes.some(theme => THEME_SCENE_PREFIX + theme.id === cfg.sceneId);
  if (!known) {
    const ghost = document.createElement('option');
    ghost.value = cfg.sceneId;
    ghost.textContent = t('ambient_scene_missing');
    select.appendChild(ghost);
  }
  select.value = cfg.sceneId;
  // Warm the package cache whenever the picker syncs while it's empty —
  // without this, installed scenes stay invisible until some custom TILE
  // happens to paint (a dashboard with no custom tiles would never list them).
  if (window.CustomWidget && typeof CustomWidget.getPackages === 'function' && !packages.length) {
    CustomWidget.getPackages(false).then(() => {
      const fresh = CustomWidget.cachedPackages().some(p => p && p.surface === 'ambient');
      if (fresh) syncAmbientScenePicker(normalizeAmbientMode(hubSettings.ambientMode));
    }).catch(() => {});
  }
}

function syncAmbientSceneNote(cfg) {
  const sceneNote = $('settings-ambient-scene-note');
  if (!sceneNote) return;
  const waiting = ambientSceneWaiting(cfg.sceneId);
  const approve = $('settings-ambient-scene-approve');
  if (approve) approve.hidden = !waiting;
  const covers = cfg.sceneId !== 'builtin';
  sceneNote.hidden = !covers;
  if (covers) {
    sceneNote.setAttribute('data-i18n', waiting ? 'ambient_scene_wait' : 'ambient_scene_covers');
    sceneNote.textContent = t(waiting ? 'ambient_scene_wait' : 'ambient_scene_covers');
  } else {
    sceneNote.removeAttribute('data-i18n');
    sceneNote.textContent = '';
  }
}

// The animated wallpaper and the PC's screensaver (js/screen-scene-model.js):
// windows of the native app, so the rows show only where it can draw them.
function syncAmbientPcSettings(cfg) {
  const sec = $('settings-ambient-pc');
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  if (sec) sec.hidden = !(window.__XENON_NATIVE__ === true && caps.scene === true);
  // Linux has no place behind the icons: the window manager stacks the scene.
  const hint = $('settings-ambient-wallpaper-hint');
  const hintKey = caps.wallpaperBehindIcons === false ? 'ambient_wallpaper_hint_under' : 'ambient_wallpaper_hint';
  if (hint && hint.dataset.i18n !== hintKey) {
    hint.dataset.i18n = hintKey;
    hint.textContent = t(hintKey);
  }
  const wallpaper = $('settings-ambient-wallpaper');
  if (wallpaper) wallpaper.checked = cfg.wallpaper;
  const saver = $('settings-ambient-saver');
  if (saver && saver.value !== String(cfg.saverMinutes)) {
    saver.value = String(cfg.saverMinutes);
    // A custom select re-syncs its label on 'change' (see the idle select).
    saver.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

const AMBIENT_SETTING_KEYS = Object.freeze(['enabled', 'idleMinutes', 'sceneId', 'openOnStartup', 'wallpaper', 'saverMinutes']);

// A package scene runs only once it is approved and community widgets are on;
// until then every surface shows the built-in scene (js/ambient-resolve.js).
function ambientSceneWaiting(sceneId) {
  if (!window.CustomWidget || sceneId === 'builtin' || String(sceneId).startsWith('canvas:')) return false;
  const pkg = CustomWidget.cachedPackages().find((p) => p && p.id === sceneId);
  if (!pkg) return false;
  return !CustomWidget.packageGranted(pkg) || !(hubSettings.sdkWidgets && hubSettings.sdkWidgets.enabled === true);
}

function approveAmbientScene() {
  const id = normalizeAmbientMode(hubSettings.ambientMode).sceneId;
  const pkg = window.CustomWidget && CustomWidget.cachedPackages().find((p) => p && p.id === id);
  if (pkg) CustomWidget.requestGrant(pkg, syncAmbientSettings);
}

function updateAmbientSetting(key, value) {
  if (!AMBIENT_SETTING_KEYS.includes(key)) return;
  const cur = normalizeAmbientMode(hubSettings.ambientMode);
  const next = { ...cur };
  if (key === 'enabled') next.enabled = !!value;
  else if (key === 'idleMinutes') next.idleMinutes = Number(value);
  else if (key === 'openOnStartup') next.openOnStartup = !!value;
  else if (key === 'wallpaper') next.wallpaper = !!value;
  else if (key === 'saverMinutes') next.saverMinutes = Number(value);
  else next.sceneId = String(value || 'builtin');
  // Guarded: syncAmbientSettings dispatches 'change' on the custom selects to
  // re-sync their visible label — an unchanged value must be a no-op, not a save
  // (and must not re-fire the scene grant prompt below).
  if (AMBIENT_SETTING_KEYS.every((k) => next[k] === cur[k])) return;
  hubSettings = normalizeSettings({ ...hubSettings, ambientMode: next });
  saveHubSettings();
  syncAmbientSettings();
  // Selecting an SDK scene the user never approved should prompt right away — the
  // grant dialog is clearer at pick time than at first activation. Canvas scenes
  // are first-party, so they never prompt.
  const isCanvas = typeof AmbientScene !== 'undefined' && AmbientScene.isCanvasRef(next.sceneId);
  if (key === 'sceneId' && next.sceneId !== 'builtin' && !isCanvas && window.CustomWidget) {
    const pkg = CustomWidget.cachedPackages().find(p => p && p.id === next.sceneId);
    if (pkg && ambientSceneWaiting(next.sceneId)) CustomWidget.requestGrant(pkg);
  }
  setSettingsStatus('settings_saved', 'ok');
}
