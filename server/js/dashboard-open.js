'use strict';

// One screen asked for when the dashboard loads: `/?open=update` (the update
// card of the alerts window, through the shell), `/?open=gallery` (Bit or a
// Deck key opening the gallery while "widgets only" had no dashboard; the
// driver, js/shell-driver.js, loads the dashboard with it), or `mixer` and
// `chat` (a Deck key's shortcut with those steps, same way), `settings` with a
// category or plain `dashboard` (the Xenon menu over the screen, through the
// shell, see layers::spec::dashboard_page). Read once,
// validated, then dropped from the address so a reload does not open it again.
// A question for the chat never rides in the address: the driver leaves it in
// this tab's sessionStorage (same window, same origin) and run() takes it once.
// The shell also calls run() directly when the dashboard is already loaded
// (monitor::open_dashboard).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DashboardOpen = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PARAMS = ['open', 'filter', 'id', 'cat'];
  const GALLERY_FILTERS = ['video', 'screenshot'];
  const CAPTURE_ID = /^[a-f0-9]{16}$/;
  const SIMPLE = ['update', 'mixer', 'chat', 'dashboard'];
  // Settings categories the shell may ask for: the ones the Xenon menu opens
  // (xenon-menu.js `settings:<cat>`) and a tile's Set up button on a widget on
  // the screen (utils.js openSettingsCategory), mirrored by SETTINGS_CATS in spec.rs.
  const SETTINGS_CATS = ['appearance', 'capture', 'general', 'notifications',
    'ai', 'smarthome', 'spotify', 'streaming', 'unifi', 'slideshow'];
  const ASK_KEY = 'xenon.deckAsk';
  const ASK_MAX_AGE_MS = 60 * 1000;
  const ASK_MAX_CHARS = 2000;

  // What a request may carry, from untrusted input (a URL or an SSE payload).
  function normalize(o) {
    if (!o || typeof o !== 'object') return null;
    if (SIMPLE.includes(o.open)) return { open: o.open };
    if (o.open === 'settings') return SETTINGS_CATS.includes(o.cat) ? { open: 'settings', cat: o.cat } : { open: 'settings' };
    if (o.open !== 'gallery') return null;
    const out = { open: 'gallery' };
    if (GALLERY_FILTERS.includes(o.filter)) out.filter = o.filter;
    if (typeof o.id === 'string' && CAPTURE_ID.test(o.id)) out.id = o.id;
    return out;
  }

  function parse(search) {
    const q = new URLSearchParams(search || '');
    return normalize({ open: q.get('open'), filter: q.get('filter'), id: q.get('id'), cat: q.get('cat') });
  }

  // `&open=…` for the driver's way to the dashboard; '' when nothing valid.
  function query(o) {
    const req = normalize(o);
    if (!req) return '';
    return PARAMS.filter((k) => req[k]).map((k) => '&' + k + '=' + encodeURIComponent(req[k])).join('');
  }

  // The driver's question for the chat, kept for the dashboard it becomes.
  function storeAsk(text, store) {
    const msg = String(text == null ? '' : text).trim().slice(0, ASK_MAX_CHARS);
    if (!msg || !store) return false;
    try { store.setItem(ASK_KEY, JSON.stringify({ text: msg, at: Date.now() })); return true; } catch { return false; }
  }

  // Taken once; a stale one (a reload long after) is dropped, never asked.
  function takeAsk(store, now) {
    if (!store) return '';
    let raw = null;
    try { raw = store.getItem(ASK_KEY); store.removeItem(ASK_KEY); } catch { return ''; }
    try {
      const o = JSON.parse(raw);
      const fresh = o && typeof o.text === 'string' && Number.isFinite(o.at) && Math.abs((now || Date.now()) - o.at) <= ASK_MAX_AGE_MS;
      return fresh ? o.text.trim().slice(0, ASK_MAX_CHARS) : '';
    } catch { return ''; }
  }

  function openChat() {
    const ask = takeAsk(window.sessionStorage);
    if (ask && typeof window.aiAsk === 'function') { window.aiAsk(ask); return true; }
    if (typeof window.openMediaChat === 'function') { window.openMediaChat(); return true; }
    if (typeof window.openAiPanel === 'function') { window.openAiPanel(); return true; }
    return false;
  }

  function run(o) {
    const req = normalize(o);
    if (!req) return false;
    if (req.open === 'chat') return openChat();
    // Shown by the shell already: nothing more to open.
    if (req.open === 'dashboard') return true;
    if (req.open === 'settings') {
      if (typeof window.openSettings !== 'function') return false;
      window.openSettings(req.cat);
      return true;
    }
    if (req.open === 'mixer') {
      if (typeof window.DeckClientRun !== 'function') return false;
      window.DeckClientRun({ type: 'appMixer' });
      return true;
    }
    if (req.open === 'gallery') {
      if (!window.CaptureGallery) return false;
      window.CaptureGallery.open({ filter: req.filter, id: req.id });
      return true;
    }
    // The update, as the native app's own update card starts it (native-bridge.js).
    const upd = window.XenonUpdate;
    if (!upd || typeof upd.check !== 'function' || typeof upd.nativeOrchestrate !== 'function') return false;
    upd.check(true).then((info) => { if (info && info.updateAvailable) upd.nativeOrchestrate(info); }).catch(() => {});
    return true;
  }

  function fromAddress() {
    const req = parse(window.location.search);
    if (!req) return;
    const url = new URL(window.location.href);
    PARAMS.forEach((k) => url.searchParams.delete(k));
    try { window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash); } catch { /* kept: run() still runs once */ }
    run(req);
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined'
      && !(document.documentElement && document.documentElement.hasAttribute('data-shell-driver'))) {
    // After every script's own DOMContentLoaded work (the gallery, update.js).
    window.addEventListener('load', fromAddress, { once: true });
  }

  return Object.freeze({ SETTINGS_CATS, normalize, parse, query, run, storeAsk, takeAsk });
});
