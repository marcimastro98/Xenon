'use strict';

function isAppFavorite(win) {
  const key = appWindowKey(win);
  return !!key && appFavorites.some(fav => fav.key === key);
}

function saveAppFavorites() {
  appFavorites = appFavorites.slice(0, 12);
  localStorage.setItem('appFavorites', JSON.stringify(appFavorites));
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
    };
    changed = changed || next.id !== fav.id || next.title !== fav.title || next.icon !== fav.icon;
    return next;
  });
  // Deduplicate: keep only the first (most recent) favorite per app name.
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

function renderAppFavorites() {
  const host = document.getElementById('app-favorites');
  if (!host) return;
  // Show a favorite only while its app is actually running. A closed favorite can't
  // be focused (we hold no launch path, only a live window id), so a dead button is
  // pointless — and this is exactly what the user asked for: the star's app appears
  // in the quick bar when open, is gone when closed, and returns the moment it's
  // reopened (or after a reboot, once the app is up again).
  const openKeys = new Set(appWindows.map(appWindowKey));
  const live = Array.isArray(appFavorites) ? appFavorites.filter(fav => openKeys.has(fav.key)) : [];
  if (!live.length) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = live.slice(0, 6).map(fav => {
    const appName = prettyAppName(fav.app);
    const initial = escHtml((appName[0] || 'A').toUpperCase());
    const icon = fav.icon ? `<img src="${fav.icon}" alt="">` : `<span class="qbtn-fav-letter">${initial}</span>`;
    const encodedKey = encodeURIComponent(fav.key);
    return `
      <button class="qbtn qbtn-favorite" type="button" onclick="focusFavoriteWindow(decodeURIComponent('${encodedKey}'))" title="${escHtml(t('apps_favorite_open'))}: ${escHtml(appName)}">
        ${icon}
      </button>
    `;
  }).join('');
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
  if (existing >= 0) {
    appFavorites.splice(existing, 1);
  } else {
    // Remove any stale favorite for the same app (same process name, different title/key)
    // so one app always occupies exactly one slot.
    const appName = (win.app || '').trim().toLowerCase();
    if (appName) {
      const staleIdx = appFavorites.findIndex(fav =>
        (fav.app || '').trim().toLowerCase() === appName
      );
      if (staleIdx >= 0) appFavorites.splice(staleIdx, 1);
    }
    appFavorites.unshift({
      key,
      id: String(win.id || ''),
      app: win.app || '',
      title: win.title || '',
      icon: win.icon || '',
    });
  }
  saveAppFavorites();
  renderAppFavorites();
  renderAppWindows();
}

function renderAppWindows() {
  const list = document.getElementById('app-list');
  if (!list) return;
  if (appWindowsLoading) {
    list.innerHTML = `<div class="app-empty">${escHtml(t('apps_loading'))}</div>`;
    return;
  }
  if (!appWindows.length) {
    list.innerHTML = `<div class="app-empty">${escHtml(t('apps_empty'))}</div>`;
    return;
  }

  list.innerHTML = appWindows.map(win => {
    const appName = prettyAppName(win.app);
    const initial = escHtml((appName[0] || 'A').toUpperCase());
    const favorite = isAppFavorite(win);
    const preview = win.preview
      ? `<img src="${win.preview}" alt="">`
      : `<span class="app-fallback-icon">${win.icon ? `<img src="${win.icon}" alt="">` : initial}</span>`;
    return `
      <div class="app-card${win.active ? ' active' : ''}" role="button" tabindex="0" onclick="focusAppWindow('${escHtml(win.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();focusAppWindow('${escHtml(win.id)}')}" title="${escHtml(t('apps_open'))}: ${escHtml(appName)}">
        <span class="app-preview">
          <button class="app-star${favorite ? ' favorited' : ''}" type="button" onclick="toggleAppFavorite(event,'${escHtml(win.id)}')" title="${escHtml(t(favorite ? 'apps_unfavorite' : 'apps_favorite'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.86L12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2Z"/></svg>
          </button>
          ${preview}
          <span class="app-active-pill">${escHtml(t('apps_active'))}</span>
          ${win.minimized ? `<span class="app-minimized-pill">${escHtml(t('apps_minimized'))}</span>` : ''}
        </span>
        <span class="app-meta">
          <span class="app-name">${escHtml(appName)}</span>
          <span class="app-window-title">${escHtml(win.title || appName)}</span>
        </span>
      </div>
    `;
  }).join('');
}

async function loadAppWindows(showLoading) {
  if (showLoading === undefined) showLoading = true;
  if (showLoading) {
    appWindowsLoading = true;
    renderAppWindows();
  }
  try {
    const res = await fetch('/windows');
    if (!res.ok) throw new Error('windows failed');
    const data = await res.json();
    appWindows = Array.isArray(data.windows) ? data.windows : [];
    syncAppFavorites();
  } catch {
    appWindows = [];
  }
  appWindowsLoading = false;
  renderAppFavorites();
  renderAppWindows();
}

function toggleAppSwitcher(forceOpen) {
  const bd = document.getElementById('app-switcher');
  if (!bd) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : bd.hidden;
  bd.hidden = !shouldOpen;
  if (shouldOpen) {
    closeTabSwitcher();
    loadAppWindows();
  }
}

function closeAppSwitcher() {
  const bd = document.getElementById('app-switcher');
  if (bd) bd.hidden = true;
}

async function focusAppWindow(id) {
  try {
    await fetch('/windows/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
  } catch {}
  closeAppSwitcher();
}

async function focusFavoriteWindow(key) {
  let win = appWindows.find(item => appWindowKey(item) === key);
  let fav = appFavorites.find(item => item.key === key);
  if (!win) {
    await loadAppWindows(false);
    win = appWindows.find(item => appWindowKey(item) === key);
    fav = appFavorites.find(item => item.key === key);
  }
  const id = win && win.id ? win.id : (fav && fav.id);
  if (id) await focusAppWindow(String(id));
}
