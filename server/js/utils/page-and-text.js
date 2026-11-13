// Small helpers every page uses: finding elements, calling the engine with a deadline, making text
// and pictures safe, copying, and the window that takes pasted SVG code.
'use strict';

const $ = id => document.getElementById(id);

// A layer window (`/?layer=…`, js/layer-host.js) draws the tiles placed on one
// surface and nothing else. What speaks, rings, chimes, notifies or announces
// on its own belongs to the main dashboard: a second copy would do it twice,
// unseen, or mark an announcement read that nobody saw. Read from the URL so
// modules that load before layer-host.js can ask too. A sheet counts as one.
function isLayerPage() {
  return /[?&]layer=/.test(String((typeof window !== 'undefined' && window.location && window.location.search) || '')) || isSheetPage();
}

// One screen of the dashboard alone (Settings, the Store, the gallery) in the
// Xenon menu's own window (`/?panel=sheet`, js/sheet-page.js). It stays as quiet
// as a layer page, but the person is using it: what they do there saves, and
// what answers them (a toast, the gallery) shows.
function isSheetPage() {
  return /[?&]panel=sheet(&|$)/.test(String((typeof window !== 'undefined' && window.location && window.location.search) || ''));
}

// A tile's "Set up" button: Settings on that category. A widget on the screen
// has no Settings of its own (read-only, or no settings.js at all), so the shell
// opens the dashboard there (layers::spec::tile_settings).
function openSettingsCategory(cat) {
  if (isLayerPage() && !isSheetPage()) {
    const onDashboard = () => {
      try { window.location.href = (window.__xenonSignal || String)('xenon-app:open-dashboard?open=settings&cat=' + encodeURIComponent(cat || '')); } catch (e) { /* not in the shell */ }
    };
    // Alone in the Xenon menu's window; the dashboard where no shell draws one.
    fetch(SERVER + '/screen-menu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet: { open: 'settings', cat } }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!d || d.where !== 'screen') onDashboard(); })
      .catch(onDashboard);
    return;
  }
  if (typeof window.openSettings === 'function') window.openSettings(cat);
}

// A tile's own choice kept in the settings (a Discord favourite, the ChatGPT
// model, a lyrics option). The dashboard saves it with the settings; a layer
// page never writes the whole blob, so it sends just these fields to
// /settings/tile (server/tile-settings.js). The change shows at once and is put
// back if the server refuses it. Resolves true when saved.
async function saveTileSetting(patch) {
  const before = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
  const norm = typeof normalizeSettings === 'function' ? normalizeSettings : (s) => s;
  hubSettings = norm({ ...before, ...patch });
  if (!isLayerPage() && typeof saveHubSettings === 'function') { saveHubSettings(); return true; }
  try {
    const r = await fetch(SERVER + '/settings/tile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }) });
    if (r.ok) return true;
    console.warn('[tile-settings] not saved:', r.status);
  } catch (e) { console.warn('[tile-settings] not saved:', e && e.message); }
  hubSettings = before;
  return false;
}

// The Vitals state (meters, Bit's truce and memory) saved from any page. The
// dashboard saves the settings as usual; a layer page, whose settings are
// read-only, posts only vitals.state, which the server merges so a stale
// copy never rewinds another screen's refill (server/vitals-state.js).
function saveVitalsStateNow() {
  if (!isLayerPage()) { if (typeof saveHubSettings === 'function') saveHubSettings(); return; }
  const state = typeof hubSettings === 'object' && hubSettings && hubSettings.vitals && hubSettings.vitals.state;
  if (!state) return;
  fetch(SERVER + '/api/vitals/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) })
    .then((r) => { if (!r.ok) console.warn('[vitals] state not saved:', r.status); })
    .catch((e) => console.warn('[vitals] state not saved:', e && e.message));
}

// DOM element factory shared by the widget/settings modules, which alias it
// locally as `el`. utils.js loads before every module script in index.html.
function makeEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// A line of separate facts (a channel and a queue position, views and likes) as one
// span each, so the look decides what sets them apart: a dot on the classic looks,
// space on Liquid. The words are remembered on the node, so a player that paints
// several times a second rebuilds the line only when they change.
function setWordParts(node, parts) {
  const words = parts.filter(Boolean).map(String);
  const key = words.join('\n');
  if (node.dataset.parts === key && node.childElementCount === words.length) return;
  node.dataset.parts = key;
  node.replaceChildren(...words.map((w) => makeEl('span', null, w)));
}

// fetch → parsed JSON, null on any failure (offline server, non-JSON reply).
// Widget modules alias it locally as `api`.
async function apiJson(path, opts) {
  try { const r = await fetch(path, opts); return await r.json(); } catch { return null; }
}

// fetch with a deadline. A `fetch` carries NO timeout of its own: a request that
// never settles leaves its awaiting function pending forever. That is harmless
// in a one-shot, and permanent in a poller guarded by an "already fetching"
// flag — the flag never clears, so every later tick returns at the guard and the
// reading is retired for the whole page until someone reloads it by hand. The
// dashboard is left open for days on the Edge and in the kiosk app, so one hung
// connection (a sleep/resume, a stack hiccup) only has to happen once. Reported
// on Discord against v4.11.3 as the weather tile emptying and never coming back
// while the same URL answered fine in a browser at that moment.
// Use this for any polled fetch, and keep the flag reset in a `finally`.
// The frequent local pollers (/system, /network, /audio). Loopback to a server
// on this machine: seconds is already far past its worst case, and the cap only
// has to be shorter than "forever". Declared here rather than in system.js
// because volume.js loads BEFORE it — a `const` in another classic script is in
// the temporal dead zone until that script runs.
const POLL_FETCH_TIMEOUT_MS = 15 * 1000;
function fetchWithDeadline(url, ms, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...(opts || {}), signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// The only kind of image data URI the dashboard shows from stored or helper-fed
// data (app icons, window previews, mixer icons): a raster type and nothing but
// base64 after the comma. Checking the `data:image/` prefix alone let anything
// follow it, quotes included, and a quote is all it takes to leave an attribute.
// Every helper (windows.ps1, WindowsTool.cs, the mixer's icon extraction)
// produces PNG. Mirrored by SAFE_IMAGE_DATA_URI_RE in server.js, which tests
// keep identical.
const SAFE_IMAGE_DATA_URI_RE = /^data:image\/(png|jpeg|gif|webp|x-icon|bmp);base64,[A-Za-z0-9+/]+={0,2}$/;
function safeImageDataUri(value) {
  const v = typeof value === 'string' ? value : '';
  return SAFE_IMAGE_DATA_URI_RE.test(v) ? v : '';
}

// Copy text to the clipboard; true only when it actually landed. The legacy
// textarea path is not vestigial: navigator.clipboard is absent or rejects in
// some WebView builds, so the async API alone silently drops the copy there.
async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

// CSS url(...) layer for a user-supplied image source: quoted, with embedded
// double quotes percent-escaped so the value can't terminate the url() token.
// Falsy src → '' (drops out of a `[grad, img].filter(Boolean)` layer list).
function cssUrl(src) {
  return src ? `url("${String(src).replace(/"/g, '%22')}")` : '';
}

// File/Blob → data: URL string, '' on any read failure. Used to keep animated
// GIFs byte-identical (a canvas re-encode would flatten them) and as the
// original-image fallback when a downscale can't run.
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(''); return; }
    const r = new FileReader();
    r.onerror = () => resolve('');
    r.onload = () => resolve(String(r.result || ''));
    r.readAsDataURL(file);
  });
}

// UTF-8-safe base64 of a string (btoa is Latin-1 only). Chunked so a large SVG
// never overflows the argument list of String.fromCharCode.
function _utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// Validate pasted SVG markup and wrap it as a base64 `data:image/svg+xml` URI so
// it can be used exactly like an uploaded image (background-image / border-image /
// <img src>). Returns '' when the text isn't a plausible <svg> document or blows
// the cap. IMPORTANT: an SVG rendered *as an image* data: URI runs in the
// browser's secure static mode — no scripts, no external fetches — so this is
// safe in a way that inlining the same markup via innerHTML would NOT be. Never
// route this value into innerHTML; keep it an image source.
const SVG_CODE_MAX_CHARS = 256 * 1024;   // source-markup cap (~256 KB before encoding)
function svgTextToDataUrl(text) {
  const s = String(text || '').trim();
  if (!s || s.length > SVG_CODE_MAX_CHARS) return '';
  // Must open with an <svg …> root (a leading XML prolog / doctype / comment is
  // fine) and carry a closing </svg>. Cheap sanity gate, not a full parser.
  if (!/<svg[\s>]/i.test(s) || !/<\/svg\s*>/i.test(s)) return '';
  try { return 'data:image/svg+xml;base64,' + _utf8ToBase64(s); }
  catch { return ''; }
}

// Shared "paste SVG code" dialog. Resolves the validated data: URI, or '' when
// the user cancels. Reused by every image-upload surface (tile decor, background,
// Deck) so a creator can paste <svg> markup instead of saving+uploading a file.
function openSvgPasteDialog() {
  return new Promise((resolve) => {
    const tr = (k, fb) => (typeof t === 'function' ? t(k) : '') || fb;
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    // Capture-phase + stopPropagation so Escape closes only this dialog, not the
    // parent editor/modal it was opened from.
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(''); } };

    const overlay = makeEl('div', 'svg-paste-overlay');
    const box = makeEl('div', 'svg-paste-box');
    box.appendChild(makeEl('div', 'svg-paste-title', tr('svg_paste_title', 'Paste SVG code')));
    box.appendChild(makeEl('div', 'svg-paste-hint', tr('svg_paste_hint', 'Paste the full <svg>…</svg> markup. It is used as an image, exactly like an uploaded picture.')));
    const ta = makeEl('textarea', 'svg-paste-input');
    ta.placeholder = tr('svg_paste_placeholder', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">…</svg>');
    ta.spellcheck = false;
    box.appendChild(ta);
    const errEl = makeEl('div', 'svg-paste-error'); errEl.hidden = true;
    box.appendChild(errEl);
    const row = makeEl('div', 'svg-paste-actions');
    const cancel = makeEl('button', 'svg-paste-btn', tr('svg_paste_cancel', 'Cancel')); cancel.type = 'button';
    const insert = makeEl('button', 'svg-paste-btn primary', tr('svg_paste_insert', 'Insert')); insert.type = 'button';
    row.appendChild(cancel); row.appendChild(insert);
    box.appendChild(row);
    overlay.appendChild(box);

    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(''); });
    cancel.addEventListener('click', () => finish(''));
    insert.addEventListener('click', () => {
      const uri = svgTextToDataUrl(ta.value);
      if (!uri) { errEl.textContent = tr('svg_paste_invalid', 'That does not look like valid SVG: it must start with <svg and end with </svg>.'); errEl.hidden = false; return; }
      finish(uri);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    ta.focus();
  });
}
