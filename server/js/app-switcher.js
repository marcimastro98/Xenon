'use strict';

// App switcher + favorites dock.
//
// Favorites are keyed by the stable app (process) NAME, kept one-per-app, and now
// persist SERVER-SIDE (hubSettings.appFavorites) — localStorage is only a fast
// mirror, because it is wiped on a WebView profile reset / PC restart, which is
// exactly why a starred app used to "forget" itself. Each favorite also stores the
// app's exe path, so a favorite for a CLOSED app can be relaunched (open → focus,
// closed → launch via the allowlisted /windows/launch runner).

let appSearchQuery = '';

// Only ever emit a cached favorite icon that is a data:image URI. The server
// normalizes it, but the localStorage mirror is user-editable, so guard here too:
// an arbitrary string interpolated into an <img src> could otherwise break out of
// the attribute.
function safeIconSrc(value) {
  const v = String(value || '');
  return /^data:image\//.test(v) ? v : '';
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
  host.innerHTML = favs.map((fav, i) => {
    const appName = prettyAppName(fav.app);
    const initial = escHtml((appName[0] || 'A').toUpperCase());
    const running = openKeys.has(fav.key);
    const inert = !running && !fav.path;            // closed and no launch path
    const iconSrc = safeIconSrc(fav.icon);
    const icon = iconSrc ? `<img src="${iconSrc}" alt="">` : `<span class="qbtn-fav-letter">${initial}</span>`;
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

function renderAppWindows() {
  const list = document.getElementById('app-list');
  if (!list) return;
  if (appWindowsLoading) {
    list.innerHTML = `<div class="app-empty">${escHtml(t('apps_loading'))}</div>`;
    return;
  }
  if (appWindowsError) {
    list.innerHTML = `<div class="app-empty app-error">`
      + `<span>${escHtml(t('apps_error'))}</span>`
      + `<button type="button" class="app-retry" onclick="loadAppWindows()">${escHtml(t('apps_retry'))}</button>`
      + `</div>`;
    return;
  }
  const q = (appSearchQuery || '').trim().toLowerCase();
  const wins = q
    ? appWindows.filter(w => `${prettyAppName(w.app)} ${w.title || ''}`.toLowerCase().includes(q))
    : appWindows;
  if (!wins.length) {
    list.innerHTML = `<div class="app-empty">${escHtml(t(appWindows.length ? 'apps_no_match' : 'apps_empty'))}</div>`;
    return;
  }

  list.innerHTML = wins.map(win => {
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
          <button class="app-close" type="button" onclick="closeAppWindowCard(event,'${escHtml(win.id)}')" title="${escHtml(t('apps_close'))}" aria-label="${escHtml(t('apps_close'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm11.2 0L19 6.4 6.4 19 5 17.6 17.6 5Z"/></svg>
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
    appWindowsError = false;
    renderAppWindows();
  }
  // The server bounds window enumeration to ~12s (helper) + ~12s (PowerShell
  // fallback), but the fetch itself had no timeout — so a wedged backend left the
  // panel stuck on "Loading applications…" forever with no error and no way to
  // retry. Abort a bit past the server's own worst case and surface a retryable
  // error instead of an eternal spinner.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 26000);
  try {
    const res = await fetch('/windows', { signal: ctrl.signal });
    if (!res.ok) throw new Error('windows failed');
    const data = await res.json();
    appWindows = Array.isArray(data.windows) ? data.windows : [];
    appWindowsError = false;
    syncAppFavorites();
  } catch {
    appWindows = [];
    appWindowsError = true;
  } finally {
    clearTimeout(timer);
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
    // Fresh search on every open.
    appSearchQuery = '';
    const input = document.getElementById('app-search');
    if (input) input.value = '';
    initAppSwitcherKeys(bd);
    loadAppWindows();
    // Focus the search field so a keyboard user can type-to-filter immediately.
    if (input) setTimeout(() => { try { input.focus(); } catch { /* ignore */ } }, 30);
  }
}

function closeAppSwitcher() {
  const bd = document.getElementById('app-switcher');
  if (bd) bd.hidden = true;
}

// ── Search ───────────────────────────────────────────────────────
function onAppSearchInput(value) {
  appSearchQuery = String(value || '');
  renderAppWindows();
}

// ── Keyboard navigation (real Alt+Tab feel, on top of touch) ─────
let _appSwitcherKeysInit = false;
function initAppSwitcherKeys(overlay) {
  if (_appSwitcherKeysInit) return;
  _appSwitcherKeysInit = true;
  overlay.addEventListener('keydown', (e) => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') { closeAppSwitcher(); return; }
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const cards = Array.from(document.querySelectorAll('#app-list .app-card'));
    if (!cards.length) return;
    const active = document.activeElement;
    const inSearch = active && active.id === 'app-search';
    // From the search box, ArrowDown drops into the grid; other arrows edit text.
    if (inSearch) {
      if (e.key === 'ArrowDown') { cards[0].focus(); e.preventDefault(); }
      return;
    }
    let idx = cards.indexOf(active);
    if (idx < 0) { cards[0].focus(); e.preventDefault(); return; }
    let next = idx;
    if (e.key === 'ArrowRight') next = idx + 1;
    else if (e.key === 'ArrowLeft') next = idx - 1;
    else {
      // Row jump by comparing offsetTop.
      const y = cards[idx].offsetTop;
      if (e.key === 'ArrowDown') {
        const c = cards.find((card, i) => i > idx && card.offsetTop > y);
        next = c ? cards.indexOf(c) : idx;
      } else {
        const c = cards.slice(0, idx).reverse().find(card => card.offsetTop < y);
        next = c ? cards.indexOf(c) : idx;
      }
    }
    next = Math.max(0, Math.min(cards.length - 1, next));
    cards[next].focus();
    e.preventDefault();
  });
}

// ── Actions ──────────────────────────────────────────────────────
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

async function closeAppWindowCard(event, id) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  try {
    const res = await fetch('/windows/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(id) })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.error === 'protected' && typeof showHubToast === 'function') {
      showHubToast(t('apps_title'), t('apps_close_protected'), '');
    }
  } catch {}
  // Give the window a moment to close, then refresh the list in place.
  setTimeout(() => loadAppWindows(false), 500);
}

// Focus a running favorite, or launch a closed one by its stored exe path (the
// server re-validates the path through the allowlisted openApp runner).
async function focusOrLaunchFavorite(key) {
  if (!key) return;
  const openWin = appWindows.find(item => appWindowKey(item) === key);
  if (openWin && openWin.id) { await focusAppWindow(String(openWin.id)); return; }
  const fav = appFavorites.find(item => item.key === key);
  if (!fav || !fav.path) return;
  try {
    await fetch('/windows/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fav.path })
    });
  } catch {}
  closeAppSwitcher();
  // The app takes a moment to open a window — refresh so its running state updates.
  setTimeout(() => loadAppWindows(false), 1400);
}

// Back-compat alias (older call sites): focus-or-launch by favorite key.
function focusFavoriteWindow(key) { return focusOrLaunchFavorite(key); }
