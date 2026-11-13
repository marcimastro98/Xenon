// The installed idle-screen scenes: listing, saving and deleting them.
'use strict';

// ── Native canvas scene manager (Settings → Ambient) ─────────────────────────
// Lists the canvas scenes installed via Import (authored as 'ambient-layout'
// codes — Xenon Maker, the xenon-creator flow, the gallery) with edit and
// remove actions.
function renderAmbientSceneManager() {
  const list = $('settings-ambient-scene-list');
  if (!list) return;
  const scenes = Array.isArray(hubSettings.ambientScenes) ? hubSettings.ambientScenes : [];
  const activeId = normalizeAmbientMode(hubSettings.ambientMode).sceneId;
  // Gallery scenes made in code are packages: listed so the page says where
  // they are and why there is no Edit, instead of leaving them only in the picker.
  const packages = (window.CustomWidget && typeof CustomWidget.cachedPackages === 'function')
    ? CustomWidget.cachedPackages().filter(p => p && p.surface === 'ambient') : [];
  if (!scenes.length && !packages.length) {
    list.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'settings-ambient-scene-empty',
      textContent: t('ambient_scenes_empty'),
    }));
    return;
  }
  const rows = scenes.map(sc => {
    const row = document.createElement('div');
    row.className = 'settings-ambient-scene-row';
    if ('canvas:' + sc.id === activeId) row.classList.add('is-active');
    const info = document.createElement('div');
    info.className = 'settings-ambient-scene-info';
    const name = document.createElement('span');
    name.className = 'settings-ambient-scene-name';
    name.textContent = sc.name || t('ambient_editor_untitled');   // untrusted → textContent
    const meta = document.createElement('span');
    meta.className = 'settings-ambient-scene-meta';
    const count = Array.isArray(sc.components) ? sc.components.length : 0;
    meta.textContent = (count === 1 ? t('ambient_editor_count_one') : t('ambient_editor_count').replace('{n}', count))
      + (sc.imported ? ' · ' + t('ambient_imported') : '');
    if (row.classList.contains('is-active')) {
      const used = document.createElement('span');
      used.className = 'is-active-label';
      used.textContent = ' · ' + t('ambient_scene_active');
      meta.append(used);
    }
    info.append(name, meta);
    const acts = document.createElement('div');
    acts.className = 'settings-ambient-scene-acts';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'settings-btn subtle' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    // Scenes are made in Xenon Maker or imported as codes; Edit changes an
    // installed one in place (js/ambient-canvas-editor.js), it never starts one.
    const edit = window.AmbientCanvasEditor
      ? [mk(t('ace_edit'), '', () => AmbientCanvasEditor.open(sc.id))]
      : [];
    acts.append(...edit, mk(t('ambient_scene_delete'), 'settings-ambient-scene-del', () => deleteAmbientScene(sc.id)));
    row.append(info, acts);
    return row;
  });
  packages.forEach(pkg => rows.push(ambientPackageRow(pkg, pkg.id === activeId)));
  list.replaceChildren(...rows);
}

function ambientPackageRow(pkg, active) {
  const row = document.createElement('div');
  row.className = 'settings-ambient-scene-row is-package';
  if (active) row.classList.add('is-active');
  const info = document.createElement('div');
  info.className = 'settings-ambient-scene-info';
  const name = document.createElement('span');
  name.className = 'settings-ambient-scene-name';
  name.textContent = pkg.name || pkg.id;   // untrusted manifest text → textContent
  const meta = document.createElement('span');
  meta.className = 'settings-ambient-scene-meta';
  meta.textContent = t('ambient_pkg_note');
  if (active) {
    const used = document.createElement('span');
    used.className = 'is-active-label';
    used.textContent = ' · ' + t('ambient_scene_active');
    meta.append(used);
  }
  info.append(name, meta);
  row.append(info);
  return row;
}

function deleteAmbientScene(id) {
  const scenes = Array.isArray(hubSettings.ambientScenes) ? hubSettings.ambientScenes : [];
  const target = scenes.find(s => s && s.id === id);
  if (!target) return;
  if (!window.confirm(t('ambient_scene_delete_confirm').replace('{name}', target.name || t('ambient_editor_untitled')))) return;
  const next = scenes.filter(s => s && s.id !== id);
  const patch = { ambientScenes: next };
  // If the deleted scene was the active one, fall back to the builtin scene so
  // the picker/screensaver never points at a missing canvas ref.
  const cur = normalizeAmbientMode(hubSettings.ambientMode);
  if (cur.sceneId === 'canvas:' + id) patch.ambientMode = { ...cur, sceneId: 'builtin' };
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  forgetInstalledContentResource('ambientSceneIds', id);
  saveHubSettings();
  onAmbientScenesChanged();
  setSettingsStatus('settings_saved', 'ok');
}

// The in-app editor's save: replace the stored scene with the same id, keeping
// where it came from. False when it no longer exists or would not fit.
function saveAmbientScene(scene) {
  const scenes = Array.isArray(hubSettings.ambientScenes) ? hubSettings.ambientScenes : [];
  const at = scenes.findIndex(s => s && scene && s.id === scene.id);
  if (at < 0) return false;
  const prev = scenes[at];
  const next = { ...scene, ...(prev.imported ? { imported: prev.imported } : {}), ...(prev.installId ? { installId: prev.installId } : {}) };
  const others = scenes.filter((_, i) => i !== at);
  if (!AmbientScene.sceneFits(next, others)) return false;
  hubSettings = normalizeSettings({ ...hubSettings, ambientScenes: scenes.map((s, i) => (i === at ? next : s)) });
  saveHubSettings();
  onAmbientScenesChanged();
  return true;
}
window.saveAmbientScene = saveAmbientScene;

// Called after a scene is imported (preset-share applyAmbientLayout) or deleted —
// refresh the picker + manager and notify the ambient runtime.
function onAmbientScenesChanged() {
  try { syncAmbientSettings(); } catch { /* settings not open */ }
  if (window.AmbientMode && typeof AmbientMode.onSettingsChanged === 'function') AmbientMode.onSettingsChanged();
}
window.onAmbientScenesChanged = onAmbientScenesChanged;

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
