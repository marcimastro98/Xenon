// The list of open windows: drawing it, searching it, its keys, and bringing a window forward or
// closing it.
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

function renderAppWindows() {
  const list = document.getElementById('app-list');
  if (!list) return;
  if (appWindowsLoading) {
    list.innerHTML = `<div class="app-empty">${escHtml(t('apps_loading'))}</div>`;
    return;
  }
  initAppListActions(list);
  if (appWindowsError) {
    list.innerHTML = `<div class="app-empty app-error">`
      + `<span>${escHtml(t('apps_error'))}</span>`
      + `<button type="button" class="app-retry">${escHtml(t('apps_retry'))}</button>`
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

  // Window ids, icons and previews come from the window helper, and favorites
  // from settings — none of them is ever written into the markup. Each card gets
  // an index into `wins`; the delegated listener (initAppListActions) reads the
  // id from there, and fillImgSlots sets the images through the DOM.
  const imgSrcs = [];
  list.innerHTML = wins.map((win, idx) => {
    const appName = prettyAppName(win.app);
    const initial = escHtml((appName[0] || 'A').toUpperCase());
    const favorite = isAppFavorite(win);
    // Real per-app icon (exe icon extracted server-side). Shown as a small badge
    // next to the name so every card is identifiable by the app's own icon, even
    // when the screenshot preview is an unrecognisable window thumbnail. Falls back
    // to the app-name initial only when no icon could be extracted (e.g. some UWP apps).
    const iconSrc = safeIconSrc(win.icon);
    const previewSrc = safeImageDataUri(win.preview);
    // Slots in document order: the preview (or its fallback icon) comes first,
    // then the meta badge.
    let preview;
    if (previewSrc) { imgSrcs.push(previewSrc); preview = '<img data-img-slot alt="">'; }
    else if (iconSrc) { imgSrcs.push(iconSrc); preview = '<span class="app-fallback-icon"><img data-img-slot alt=""></span>'; }
    else preview = `<span class="app-fallback-icon">${initial}</span>`;
    let metaIcon;
    if (iconSrc) { imgSrcs.push(iconSrc); metaIcon = '<img data-img-slot alt="">'; }
    else metaIcon = `<span class="app-meta-letter">${initial}</span>`;
    return `
      <div class="app-card${win.active ? ' active' : ''}" role="button" tabindex="0" data-win-index="${idx}" title="${escHtml(t('apps_open'))}: ${escHtml(appName)}">
        <span class="app-preview">
          <button class="app-star${favorite ? ' favorited' : ''}" type="button" title="${escHtml(t(favorite ? 'apps_unfavorite' : 'apps_favorite'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.86L12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2Z"/></svg>
          </button>
          <button class="app-close" type="button" title="${escHtml(t('apps_close'))}" aria-label="${escHtml(t('apps_close'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm11.2 0L19 6.4 6.4 19 5 17.6 17.6 5Z"/></svg>
          </button>
          ${preview}
          <span class="app-active-pill">${escHtml(t('apps_active'))}</span>
          ${win.minimized ? `<span class="app-minimized-pill">${escHtml(t('apps_minimized'))}</span>` : ''}
        </span>
        <span class="app-meta">
          <span class="app-meta-icon">${metaIcon}</span>
          <span class="app-meta-text">
            <span class="app-name">${escHtml(appName)}</span>
            <span class="app-window-title">${escHtml(win.title || appName)}</span>
          </span>
        </span>
      </div>
    `;
  }).join('');
  _appListWins = wins;
  fillImgSlots(list, imgSrcs);
}

// The windows the cards currently on screen were rendered from, by index.
let _appListWins = [];
function _appCardWinId(card) {
  const win = card ? _appListWins[Number(card.dataset.winIndex)] : null;
  return win && win.id != null ? String(win.id) : '';
}

// One delegated listener per list instead of inline onclick="…('id')" handlers:
// an id in an inline handler is markup the browser decodes before running it,
// so a quote in a window id (or a crafted favorite) became script.
let _appListActionsInit = false;
function initAppListActions(list) {
  if (_appListActionsInit) return;
  _appListActionsInit = true;
  list.addEventListener('click', (e) => {
    if (e.target.closest('.app-retry')) { loadAppWindows(); return; }
    const card = e.target.closest('.app-card');
    if (!card || !list.contains(card)) return;
    const id = _appCardWinId(card);
    if (!id) return;
    if (e.target.closest('.app-star')) { toggleAppFavorite(e, id); return; }
    if (e.target.closest('.app-close')) { closeAppWindowCard(e, id); return; }
    focusAppWindow(id);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.app-card');
    // Only the card itself: Enter on its star / close button is that button's click.
    if (!card || e.target !== card) return;
    e.preventDefault();
    const id = _appCardWinId(card);
    if (id) focusAppWindow(id);
  });
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
