// Favorite apps: saving them, drawing them and dragging them into a new order.
'use strict';

// Only ever show a cached favorite icon that is a plain base64 raster data URI.
// The server normalizes it, but the localStorage mirror is user-editable and a
// restored backup is outside data, so guard here too (utils.js safeImageDataUri).
// The <img> elements are also built with DOM properties, never by putting the
// value into markup, so even a value that slipped past this check stays a URL.
function safeIconSrc(value) {
  return safeImageDataUri(value);
}

// Give each <img data-img-slot> placeholder rendered by a template its src,
// through the DOM property. `srcs` is parallel to the slots, in document order.
function fillImgSlots(root, srcs) {
  const slots = root.querySelectorAll('img[data-img-slot]');
  slots.forEach((img, i) => {
    img.removeAttribute('data-img-slot');
    if (srcs[i]) img.src = srcs[i];
  });
}

function isAppFavorite(win) {
  const key = appWindowKey(win);
  return !!key && appFavorites.some(fav => fav.key === key);
}

function saveAppFavorites() {
  appFavorites = appFavorites.slice(0, 12);
  // Fast local mirror.
  try { localStorage.setItem('appFavorites', JSON.stringify(appFavorites)); } catch { /* ignore */ }
  // Durable copy: survives a browser-storage reset and syncs across dashboards.
  if (typeof hubSettings !== 'undefined') {
    hubSettings.appFavorites = appFavorites.slice();
    if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
  }
}

function syncAppFavorites() {
  let changed = false;
  appFavorites = appFavorites.map(fav => {
    const live = appWindows.find(win => appWindowKey(win) === fav.key);
    if (!live) return fav;
    const next = {
      ...fav,
      id: String(live.id || fav.id || ''),
      app: live.app || fav.app || '',
      title: live.title || fav.title || '',
      icon: live.icon || fav.icon || '',
      // Keep the launch path fresh — a versioned app (Discord/Slack) changes path
      // after an update, and older favorites saved before we captured it get one now.
      path: live.path || fav.path || '',
    };
    // Only a change to a DURABLE field triggers a save. id and title are volatile
    // (the live window id, the current tab/track/file) and are refreshed in memory
    // each sync — persisting them would rewrite settings.json on nearly every open.
    changed = changed || next.icon !== fav.icon || next.path !== fav.path;
    return next;
  });
  // Deduplicate: keep only the first favorite per app name.
  const seenApps = new Set();
  const deduped = appFavorites.filter(fav => {
    const appName = (fav.app || '').trim().toLowerCase();
    if (!appName || seenApps.has(appName)) { changed = true; return false; }
    seenApps.add(appName);
    return true;
  });
  appFavorites = deduped;
  if (changed) saveAppFavorites();
}

// ── Favorites dock (topbar quick bar) ────────────────────────────
// Shows EVERY favorite, always — not just the currently-open ones — so the dock
// doubles as a quick launcher. A running favorite focuses its window; a closed one
// with a known path launches it; a closed one without a path is shown but inert.
function renderAppFavorites() {
  const host = document.getElementById('app-favorites');
  if (!host) return;
  const favs = Array.isArray(appFavorites) ? appFavorites.slice(0, 8) : [];
  if (!favs.length) {
    host.innerHTML = '';
    host.classList.remove('has-favs');
    return;
  }
  host.classList.add('has-favs');
  const openKeys = new Set(appWindows.map(appWindowKey));
  const imgSrcs = [];
  host.innerHTML = favs.map((fav, i) => {
    const appName = prettyAppName(fav.app);
    const initial = escHtml((appName[0] || 'A').toUpperCase());
    const running = openKeys.has(fav.key);
    const inert = !running && !fav.path;            // closed and no launch path
    const iconSrc = safeIconSrc(fav.icon);
    if (iconSrc) imgSrcs.push(iconSrc);
    const icon = iconSrc ? '<img data-img-slot alt="">' : `<span class="qbtn-fav-letter">${initial}</span>`;
    const cls = 'qbtn qbtn-favorite'
      + (running ? ' running' : ' closed')
      + (inert ? ' inert' : '');
    const titleKey = running ? 'apps_favorite_open' : (inert ? 'apps_favorite_closed' : 'apps_favorite_launch');
    return `
      <button class="${cls}" type="button" draggable="false" data-fav-index="${i}" data-fav-key="${escHtml(encodeURIComponent(fav.key))}" ${inert ? 'aria-disabled="true"' : ''} title="${escHtml(t(titleKey))}: ${escHtml(appName)}">
        ${icon}
        ${running ? '<span class="qbtn-fav-dot" aria-hidden="true"></span>' : ''}
      </button>
    `;
  }).join('');
  fillImgSlots(host, imgSrcs);
  initAppFavDrag(host);
}

// Pointer-based tap-vs-drag on the dock: a tap focuses/launches the favorite, a
// drag past a small threshold reorders it. Pointer events (not HTML5 DnD) so it
// works with touch on the Xeneon Edge. Installed once, delegated on the host.
let _appFavDragInit = false;
function initAppFavDrag(host) {
  if (_appFavDragInit) return;
  _appFavDragInit = true;
  let btn = null, fromIndex = -1, startX = 0, startY = 0, dragging = false;

  host.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.qbtn-favorite');
    if (!b || b.classList.contains('inert')) { btn = null; return; }
    btn = b; fromIndex = Number(b.dataset.favIndex);
    startX = e.clientX; startY = e.clientY; dragging = false;
    try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  host.addEventListener('pointermove', (e) => {
    if (!btn) return;
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 6) {
      dragging = true;
      btn.classList.add('dragging');
      host.classList.add('reordering');
    }
  });

  const finish = (e, commit) => {
    if (!btn) return;
    const b = btn; btn = null;
    b.classList.remove('dragging');
    host.classList.remove('reordering');
    if (!dragging) {
      // A plain tap acts on the favorite; a browser/OS-canceled gesture must not.
      if (commit) focusOrLaunchFavorite(decodeURIComponent(b.dataset.favKey || ''));
      return;
    }
    if (!commit) { renderAppFavorites(); return; }
    // Drop: insertion index = how many other favorites sit left of the pointer.
    let insert = 0;
    for (const s of host.querySelectorAll('.qbtn-favorite')) {
      if (s === b) continue;
      const r = s.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2) insert++;
    }
    if (fromIndex >= 0 && fromIndex < appFavorites.length) {
      const [item] = appFavorites.splice(fromIndex, 1);
      appFavorites.splice(Math.max(0, Math.min(appFavorites.length, insert)), 0, item);
      saveAppFavorites();
    }
    renderAppFavorites();
  };

  host.addEventListener('pointerup', (e) => finish(e, true));
  host.addEventListener('pointercancel', (e) => finish(e, false));
}

function toggleAppFavorite(event, id) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const win = appWindows.find(item => String(item.id) === String(id));
  if (!win) return;
  const key = appWindowKey(win);
  if (!key) return;
  const existing = appFavorites.findIndex(fav => fav.key === key);
  // From a paired phone or tablet a favourite can be removed or moved, not
  // added: favourites are what a phone may start on the PC, and the server
  // keeps only the ones the PC saved (server.js, POST /settings). Say so
  // instead of showing a star that would vanish on the next sync.
  if (existing < 0 && window.__xenonRemote) {
    if (typeof showHubToast === 'function') {
      showHubToast('Xenon', t('apps_fav_pc_only_title'), t('apps_fav_pc_only'));
    }
    return;
  }
  if (existing >= 0) {
    appFavorites.splice(existing, 1);
  } else {
    // Remove any stale favorite for the same app so one app occupies one slot.
    const appName = (win.app || '').trim().toLowerCase();
    if (appName) {
      const staleIdx = appFavorites.findIndex(fav => (fav.app || '').trim().toLowerCase() === appName);
      if (staleIdx >= 0) appFavorites.splice(staleIdx, 1);
    }
    appFavorites.unshift({
      key,
      id: String(win.id || ''),
      app: win.app || '',
      title: win.title || '',
      icon: win.icon || '',
      path: win.path || '',
    });
  }
  saveAppFavorites();
  renderAppFavorites();
  renderAppWindows();
}
