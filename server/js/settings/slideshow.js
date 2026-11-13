// The slideshow background: its pictures, its folder and their rows in Settings.
'use strict';

// ── Slideshow widget ──────────────────────────────────────────────────────────
// Config (ordered images as data: URIs, interval, fit) lives in hubSettings.
// slideshow; the caps + shape rules are owned by SlideshowWidget.sanitizeSlideshow
// (js/slideshow-widget.js). Persisting through normalizeSettings + saveHubSettings
// means the images ride the settings backup for free, and the widget repaints
// live. Pre-checks here mirror the sanitizer so nothing gets silently dropped.
function updateSlideshowCfg(patch) {
  const current = (hubSettings.slideshow && typeof hubSettings.slideshow === 'object') ? hubSettings.slideshow : {};
  hubSettings = normalizeSettings({ ...hubSettings, slideshow: { ...current, ...patch } });
  saveHubSettings();
  if (window.SlideshowWidget && typeof SlideshowWidget.renderWidgets === 'function') SlideshowWidget.renderWidgets();
  renderSlideshowSettings();
}

// Upload one slideshow image to the server's disk-backed store and resolve its
// served /uploads/ URL. Images live on disk (not inline in the settings blob), so
// a slideshow can hold far more of them without weighing on localStorage/backups.
async function uploadSlideshowAsset(file) {
  const type = file.type || 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('asset', file, `slide.${ext}`);
  const res = await fetch('/slideshow-asset', { method: 'POST', body: form });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.url) {
    const err = new Error((j && j.error) || 'upload failed');
    err.tooBig = res.status === 413;
    throw err;
  }
  return j.url;
}

async function addSlideshowImages(input) {
  const files = input && input.files ? Array.from(input.files) : [];
  if (input) input.value = '';   // allow re-picking the same file
  if (!files.length || !window.SlideshowWidget) return;
  const S = SlideshowWidget;
  const current = normalizeSlideshow(hubSettings.slideshow);
  const images = current.images.slice();
  let added = 0;
  const warn = (titleKey, message) => {
    if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t(titleKey), message: message || '' });
  };
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { warn('slideshow_img_invalid', file.name); continue; }
    if (images.length >= S.SLIDE_MAX_COUNT) { warn('slideshow_full'); break; }
    try {
      const uri = await uploadSlideshowAsset(file);
      images.push({ name: String(file.name || '').slice(0, 80), uri });
      added++;
    } catch (e) {
      warn(e && e.tooBig ? 'slideshow_img_too_big' : 'slideshow_img_invalid', file.name);
    }
  }
  if (added) updateSlideshowCfg({ images });
}

function removeSlideshowImage(idx) {
  const current = normalizeSlideshow(hubSettings.slideshow);
  if (idx < 0 || idx >= current.images.length) return;
  const images = current.images.slice();
  images.splice(idx, 1);
  updateSlideshowCfg({ images });
}

function moveSlideshowImage(idx, dir) {
  const current = normalizeSlideshow(hubSettings.slideshow);
  const images = current.images.slice();
  const j = idx + dir;
  if (idx < 0 || idx >= images.length || j < 0 || j >= images.length) return;
  const tmp = images[idx]; images[idx] = images[j]; images[j] = tmp;
  updateSlideshowCfg({ images });
}

// Ask the server how many images the configured folder holds, and say so under
// the field. The path is validated by the server (it owns the disk), so this is
// also where a typo, a missing drive or a folder with no images gets explained —
// the alternative was a tile that silently stayed empty.
let slideshowFolderStatusPending = false;
let _slideshowFolderStatusSeq = 0;   // a forced refresh orphans an in-flight one
function refreshSlideshowFolderStatus(force) {
  const out = $('settings-slideshow-folder-status');
  if (!out) return;
  // force supersedes a pending fetch (the seq below keeps the superseded
  // response from painting a stale answer over the fresh one).
  if (slideshowFolderStatusPending && !force) return;
  const c = normalizeSlideshow(hubSettings.slideshow);
  if (!c.folder) { out.textContent = ''; return; }
  const seq = ++_slideshowFolderStatusSeq;
  slideshowFolderStatusPending = true;
  fetch('/slideshow/folder' + (force ? '?refresh=1' : ''))
    .then(r => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
    .then(d => {
      if (seq !== _slideshowFolderStatusSeq) return;
      if (d.ok) {
        // "0 images found" is true and useless: it reads the same whether the
        // folder is empty or full of things Xenon passed over. Say which.
        out.textContent = d.truncated
          ? t('slideshow_folder_truncated').replace('{n}', String(d.count))
          : (d.count === 0 && (d.skipped | 0) > 0)
            ? t('slideshow_folder_none_readable').replace('{n}', String(d.skipped | 0))
            : t('slideshow_folder_found').replace('{n}', String(d.count));
      } else {
        // t() falls back to the key name, so an unknown code must be mapped here
        // rather than tested for truthiness — otherwise a raw key reaches the UI.
        const known = ['no_folder', 'not_found', 'not_a_dir', 'denied', 'read_failed'];
        const code = known.includes(d.error) ? d.error : 'read_failed';
        out.textContent = t('slideshow_folder_err_' + code)
          + (d.network ? ' ' + t('slideshow_folder_err_network') : '');
      }
    })
    .catch(() => { if (seq === _slideshowFolderStatusSeq) out.textContent = t('slideshow_folder_err_read_failed'); })
    .finally(() => { if (seq === _slideshowFolderStatusSeq) slideshowFolderStatusPending = false; });
}

async function updateSlideshowFolder(value) {
  updateSlideshowCfg({ folder: String(value || '') });
  // The status endpoint reads the folder from the SERVER's persisted settings,
  // and the background save above is debounced 250ms — asking now would
  // enumerate the PREVIOUS folder and the answer would stick (the widget caches
  // it under the new path for minutes). Flush the save first, then ask, and
  // force-refresh the widget's own folder cache with the real answer.
  clearTimeout(settingsServerSaveTimer);
  settingsServerSaveTimer = null;
  const token = ++_settingsSaveToken;
  try { await postHubSettingsToServer(); }
  catch { _postHubSettingsWithRetry(token, 0); }
  refreshSlideshowFolderStatus(true);
  if (window.SlideshowWidget && typeof SlideshowWidget.refreshFolderNow === 'function') SlideshowWidget.refreshFolderNow();
}

// Thumbnails are drawn to a CANVAS, not shown as <img>. An animated GIF in an
// <img> keeps animating for as long as it is in the document, so a library of a
// few hundred GIFs meant a few hundred clips playing at once inside the Settings
// overlay — reported from the field as making the whole app lag, and the reason a
// large library felt unusable even though the widget itself only ever shows one
// image. Drawing frame 0 once and dropping the decoder costs nothing afterwards.
// The Image is created detached, drawn, and released; only cells that scroll into
// view are ever loaded, so opening the pane doesn't decode the whole library.
let slideshowThumbObserver = null;
function drawSlideshowThumb(canvas, uri) {
  const img = new Image();
  img.decoding = 'async';
  // Release = clear the handlers FIRST, then drop the attribute. Assigning
  // src = '' fires 'error', and an onerror that re-assigns '' loops forever
  // (measured: hundreds of thousands of error events per thumbnail).
  // removeAttribute is the same release freezeTile uses in slideshow-widget.js.
  const release = () => { img.onload = null; img.onerror = null; img.removeAttribute('src'); };
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) { release(); return; }
    // Cover-fit the source into the square cell, same framing the tile uses.
    const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    release();   // the frame now lives in the canvas
  };
  img.onerror = release;
  img.src = uri;
}

// Fill the Slideshow settings pane: the source picker, the thumbnail grid
// (reorder + remove) or the folder field, plus the playback options. Safe to call
// anytime — no-ops when the pane isn't in the DOM, and skips the grid rebuild when
// the image set is unchanged.
function renderSlideshowSettings() {
  const c = normalizeSlideshow(hubSettings.slideshow);
  const cap = window.SlideshowWidget ? SlideshowWidget.SLIDE_MAX_COUNT : 200;
  const isFolder = c.source === 'folder';
  // Both selects are upgraded to styled dropdowns, whose trigger label only
  // follows a real `change` event — assigning .value needs the explicit re-sync
  // or the dropdown keeps showing the previous option.
  const setSelect = (el, value) => {
    if (!el || document.activeElement === el) return;
    el.value = value;
    if (typeof el._csSync === 'function') el._csSync();
  };
  const srcSel = $('settings-slideshow-source');
  setSelect(srcSel, c.source);
  const libBlock = $('settings-slideshow-library');
  if (libBlock) libBlock.hidden = isFolder;
  const folderBlock = $('settings-slideshow-folderblock');
  if (folderBlock) folderBlock.hidden = !isFolder;
  const folderInput = $('settings-slideshow-folder');
  if (folderInput && document.activeElement !== folderInput) folderInput.value = c.folder;
  const shuffleBox = $('settings-slideshow-shuffle');
  if (shuffleBox) shuffleBox.checked = c.shuffle;
  const pauseGameBox = $('settings-slideshow-pause-game');
  if (pauseGameBox) pauseGameBox.checked = c.pauseGame;
  const intInput = $('settings-slideshow-interval');
  if (intInput && document.activeElement !== intInput) intInput.value = String(Math.round(c.intervalMs / 1000));
  setSelect($('settings-slideshow-fit'), c.fit);
  const countEl = $('settings-slideshow-count');
  if (countEl) countEl.textContent = c.images.length + ' / ' + cap;
  if (isFolder) refreshSlideshowFolderStatus(false);
  const host = $('settings-slideshow-assets');
  if (!host) return;
  const sig = c.images.length + '|' + c.images.map(im => im.uri.length).join(',');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  // Rebuilding the grid orphans the previous cells — drop the observer watching
  // them rather than leaving it holding detached nodes.
  if (slideshowThumbObserver) { slideshowThumbObserver.disconnect(); slideshowThumbObserver = null; }
  const svg = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const L = svg('<path d="M15 18l-6-6 6-6"/>'), R = svg('<path d="M9 18l6-6-6-6"/>'), X = svg('<path d="M6 6l12 12M18 6L6 18"/>');
  slideshowThumbObserver = new IntersectionObserver((entries, obs) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      obs.unobserve(e.target);
      drawSlideshowThumb(e.target, e.target.dataset.uri || '');
    });
  }, { rootMargin: '200px' });
  const frag = document.createDocumentFragment();
  c.images.forEach((im, i) => {
    const cell = document.createElement('div'); cell.className = 'sl-asset';
    const canvas = document.createElement('canvas');
    canvas.width = 132; canvas.height = 132;              // 2x the 66px CSS cell
    canvas.dataset.uri = im.uri;
    if (im.name) canvas.setAttribute('aria-label', im.name);
    cell.appendChild(canvas);
    slideshowThumbObserver.observe(canvas);
    const actions = document.createElement('div'); actions.className = 'sl-asset-actions';
    const mk = (cls, html, aria, on, disabled) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sl-asset-btn ' + cls;
      b.innerHTML = html; b.setAttribute('aria-label', aria);
      if (disabled) b.disabled = true; else b.addEventListener('click', on);
      return b;
    };
    actions.appendChild(mk('sl-mv-l', L, t('slideshow_move_left', 'Move earlier'), () => moveSlideshowImage(i, -1), i === 0));
    actions.appendChild(mk('sl-mv-r', R, t('slideshow_move_right', 'Move later'), () => moveSlideshowImage(i, 1), i === c.images.length - 1));
    actions.appendChild(mk('sl-asset-rm', X, t('slideshow_remove', 'Remove'), () => removeSlideshowImage(i), false));
    cell.appendChild(actions);
    frag.appendChild(cell);
  });
  host.replaceChildren(frag);
}
