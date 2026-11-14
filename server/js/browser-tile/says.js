// What the browser tile says while it has no page to show: a tab's name, the loading and empty
// states, and an error in words a person can act on.
'use strict';

(() => {
  const t = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : null;
    if (v && v !== k) return v;              // translated
    return fb != null ? fb : k;              // fall back to the provided default, never the raw key
  };

  // Pretty label for a tab from its URL (hostname without a leading www).
  function tabLabel(url) {
    const s = String(url || '').trim();
    if (!s) return t('browser_new_tab', 'New tab');
    try { return new URL(/^https?:/i.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, ''); }
    catch (e) { return s.replace(/^https?:\/\//, '').split('/')[0] || s; }
  }

  // Loading indicator: a spinner + text shown while the active tab has no frame yet.
  function showLoading(group) {
    const el = group.loadingEl;
    if (!el) return;
    el.classList.remove('is-error', 'is-paused');
    const spin = XenonLoader.create();
    const txt = document.createElement('span');
    txt.className = 'browser-loading-text'; txt.textContent = t('browser_loading', 'Loading…');
    el.replaceChildren(spin, txt);
    el.hidden = false;
  }

  // Empty-tab hint: a freshly added tab with no address yet.
  function showEmpty(group) {
    const el = group.loadingEl;
    if (!el) return;
    el.classList.remove('is-error', 'is-paused');
    el.textContent = t('browser_new_tab_hint', 'Enter an address to get started.');
    el.hidden = false;
    if (group.urlInput) { group.urlInput.value = ''; try { group.urlInput.focus(); } catch (e) { /* ignore */ } }
  }

  function isLaunchError(code) {
    return /timeout|connect|launch|exited|closed|port|socket|failed/i.test(String(code || ''));
  }

  function friendlyError(code) {
    const c = String(code || '');
    if (c === 'blocked_scheme') return t('browser_blocked_scheme', 'Only http:// and https:// addresses are allowed.');
    if (c === 'edge_not_found') {
      // The error code keeps its name (every log line and call site says
      // "edge"), but the sentence must match the machine reading it.
      return window.XenonPlatform && window.XenonPlatform !== 'win32'
        ? t('browser_unavailable_chromium', 'The Browser widget needs a Chromium-based browser (Chromium, Chrome, Brave or Edge). None was found.')
        : t('browser_unavailable', 'Microsoft Edge isn’t installed: it’s required for the Browser widget.');
    }
    if (isLaunchError(c)) return t('browser_err_launch', 'Couldn’t open this page right now. Please try again in a moment.');
    return '';   // no_tile / bad_url / empty_url / unknown → stay quiet
  }

  function showTabError(group, code) {
    const msg = friendlyError(code);
    if (!msg || !group.loadingEl) return;
    group.loadingEl.textContent = msg;
    group.loadingEl.classList.remove('is-paused');
    group.loadingEl.classList.add('is-error');
    group.loadingEl.hidden = false;
  }

  // A short display label for a favorite that has none — the URL's hostname.
  function favLabelFromUrl(url) { return tabLabel(url); }

  window.BrowserTileSays = {
    t, tabLabel, showLoading, showEmpty, isLaunchError, showTabError, favLabelFromUrl,
  };
})();
