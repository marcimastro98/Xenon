'use strict';

// Pure formatters live in @xenon/core (served at /shared). Delegate to them when
// present, keeping the original inline bodies as a fallback so the dashboard still
// works if /shared is briefly unavailable. The fallbacks must stay byte-identical
// to packages/core/src/format.js.
const _xcFmt = (typeof window !== 'undefined' && window.Xenon && window.Xenon.format) || null;

const $ = id => document.getElementById(id);

// DOM element factory shared by the widget/settings modules, which alias it
// locally as `el`. utils.js loads before every module script in index.html.
function makeEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// fetch → parsed JSON, null on any failure (offline server, non-JSON reply).
// Widget modules alias it locally as `api`.
async function apiJson(path, opts) {
  try { const r = await fetch(path, opts); return await r.json(); } catch { return null; }
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
      if (!uri) { errEl.textContent = tr('svg_paste_invalid', 'That does not look like valid SVG — it must start with <svg and end with </svg>.'); errEl.hidden = false; return; }
      finish(uri);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    ta.focus();
  });
}

// Shared raster-downscale core: decode an image File/Blob and draw it onto a
// canvas capped at maxEdge on the long side (never upscaled). Resolves the
// canvas, or null when the file can't be decoded or drawn — each caller keeps
// its own policy for GIFs, output encoding, quality and fallback.
function rasterToCanvas(file, maxEdge) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      try { cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); } catch { resolve(null); return; }
      resolve(cv);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// True unless `el` sits on a pager page the user isn't currently viewing. The
// pager keeps off-screen pages mounted (transformed away, not display:none), so
// offsetParent / document.hidden don't catch a widget parked on another page —
// polling loops gate on this so background pages stop hitting the network/API.
// Falls back to "visible" when the pager isn't present (panel mode, boot).
function onVisiblePage(el) {
  const p = window.DashboardPager;
  return !(p && p.isOnCurrentPage) || p.isOnCurrentPage(el);
}

function parseAppFavorites(raw) {
  try {
    // Accept either a JSON string (localStorage) or an already-parsed array
    // (hubSettings.appFavorites round-tripped from the server).
    const data = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    if (!Array.isArray(data)) return [];
    // Normalise to the stable app-name key and drop duplicates. This also migrates
    // legacy favorites saved under the old "app|title" key (split off the app part)
    // so a user's existing stars survive the switch without being re-added.
    const seen = new Set();
    const out = [];
    for (const item of data) {
      if (!item) continue;
      const key = appKeyFromName(item.app || String(item.key || '').split('|')[0]);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...item, key });
      if (out.length >= 12) break;
    }
    return out;
  } catch {
    return [];
  }
}

// Generic dashboard toast — thin wrapper over the unified XenonToast system
// (js/toast.js). Used by Genesis / Guardian / ambient / backup notifications.
// The kicker hints the visual type so e.g. a backup reads as "success".
const _HUB_TOAST_TYPE = { Backup: 'success', Guardian: 'warning', Genesis: 'info', Xenon: 'info' };
function showHubToast(kicker, title, meta) {
  if (!window.XenonToast) return;
  window.XenonToast.show({
    type: _HUB_TOAST_TYPE[kicker] || 'info',
    kicker: kicker || '',
    title: title || '',
    message: meta || '',
  });
}

// Whether clocks should render in 12-hour (AM/PM) form. Honours the user's
// explicit choice in Settings → Appearance; 'auto' derives it from the active
// UI language (English → 12h, every other language → 24h). Shared by the
// dashboard clock (clock.js) and the lock screen (lockscreen.js) so both agree.
function clockUses12h() {
  const fmt = (typeof hubSettings === 'object' && hubSettings && hubSettings.clockFormat) || 'auto';
  if (fmt === '12') return true;
  if (fmt === '24') return false;
  const locale = (typeof t === 'function' ? t('locale') : '') || '';
  return locale.toLowerCase().startsWith('en');
}

function toDateInputValue(date) {
  if (_xcFmt) return _xcFmt.toDateInputValue(date);
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function combineDateTime(dateValue, timeValue) {
  if (!dateValue) return null;
  const time = timeValue || '09:00';
  const date = new Date(`${dateValue}T${time}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toLocalDateTimeValue(date) {
  const d = new Date(date);
  const day = toDateInputValue(d);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}T${hours}:${minutes}:00`;
}

function formatBytes(bytes) {
  if (_xcFmt) return _xcFmt.formatBytes(bytes);
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + ' TB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  return b + ' B';
}

function formatUptime(seconds) {
  if (_xcFmt) return _xcFmt.formatUptime(seconds);
  const h = Math.floor((seconds || 0) / 3600);
  const m = Math.floor(((seconds || 0) % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function brandFromName(name) {
  if (!name) return '';
  const n = name.toUpperCase();
  if (n.includes('NVIDIA') || n.includes('GEFORCE') || n.includes('RTX') || n.includes('GTX')) return 'NVIDIA';
  if (n.includes('AMD') || n.includes('RADEON') || n.includes('RYZEN')) return 'AMD';
  if (n.includes('INTEL') || n.includes('CORE')) return 'INTEL';
  if (n.includes('APPLE')) return 'APPLE';
  return '';
}

function cleanTitle(title) {
  let s = (title || '').trim();
  s = s.replace(/^(?:[A-Za-z]:\\|(?:\/[^/]+)+\/|.*[\\/])([^\\/]+)$/, '$1');
  s = s.replace(/\.(mp3|mp4|m4a|m4v|flac|wav|ogg|opus|aac|wma|wmv|avi|mkv|mov|aiff|alac)$/i, '');
  s = s.replace(/\s+-\s+(YouTube|SoundCloud|Spotify|Deezer|Tidal|Apple Music)$/i, '').trim();
  s = s.replace(/\s*[\[(](?:official\s*(?:video|audio|music\s*video|lyric\s*video)?|lyrics?|audio|hd|4k|mv|clip)[\])]\s*$/i, '').trim();
  if (/^[A-Za-z.]+_[A-Za-z0-9]+![A-Za-z.]+$/.test(s)) return '';
  return s;
}

function prettyAppName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'App';
  const known = {
    chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', explorer: 'Explorer', spotify: 'Spotify',
    code: 'VS Code', discord: 'Discord', steam: 'Steam', notepad: 'Notepad', powershell: 'PowerShell',
    pwsh: 'PowerShell', cmd: 'Command Prompt', taskmgr: 'Task Manager', icue: 'iCUE'
  };
  const key = raw.toLowerCase();
  return known[key] || raw.replace(/(^|\s)\S/g, s => s.toUpperCase());
}

// Stable per-APP identity used for favorites — the process/app name only, NOT the
// window title. The title changes constantly (the current tab, open file, or Spotify
// track) and is different again after a reboot, so keying favorites by it silently
// lost them; the app name is stable, and the switcher already treats favorites as
// one-per-app. Reopening the app — or restarting the PC — re-matches the favorite.
function appKeyFromName(name) {
  return String(name || '').trim().toLowerCase();
}
function appWindowKey(win) {
  return appKeyFromName(win && win.app);
}

function formatBandwidth(bps) {
  if (_xcFmt) return _xcFmt.formatBandwidth(bps);
  if (bps == null || !isFinite(bps)) return { value: '--', unit: 'Mbps' };
  const bits = bps * 8;
  if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
  if (bits >= 1e6) return { value: (bits / 1e6).toFixed(1), unit: 'Mbps' };
  if (bits >= 1e3) return { value: (bits / 1e3).toFixed(0), unit: 'Kbps' };
  return { value: String(Math.round(bits)), unit: 'bps' };
}

function setFill(el, value) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  el.style.width = safe + '%';
  renderStatSpark(el, safe);
}

// ── Live sparkline for stat cards ────────────────────────────────
// Replaces the static fill bar with a small animated history graph that
// rises/falls with the metric. The path morph is animated via `transition: d`
// (Chromium). History is kept per fill element id.
const _statSparkHist = {};
const STAT_SPARK_POINTS = 40;

function _statSparkColor(fillEl) {
  const c = ' ' + (fillEl.className || '') + ' ';
  if (c.includes(' cpu ')) return 'var(--green)';
  if (c.includes(' gpu ')) return 'var(--blue)';
  if (c.includes(' ram ')) return 'var(--amber)';
  if (c.includes(' disk ')) return '#c084fc';
  if (c.includes('net-ping')) return 'var(--green)';
  if (c.includes('net-fps')) return '#7c5cff';
  if (c.includes('net-latency')) return '#ff8a3d';
  return 'var(--accent)';
}

// Drop a fill element's sparkline history so the next render starts a fresh
// series. Used when a card's underlying metric changes (e.g. GPU load ↔ VRAM),
// otherwise the two unrelated series would blend into one misleading graph.
function resetStatSparkFor(fillEl) {
  if (!fillEl) return;
  const track = fillEl.parentElement;
  const key = fillEl.id || (track && track.dataset ? track.dataset.sparkKey : null);
  if (key && _statSparkHist[key]) delete _statSparkHist[key];
}

function renderStatSpark(fillEl, value) {
  if (!fillEl) return;
  const track = fillEl.parentElement;
  if (!track || !track.classList || !track.classList.contains('stat-track')) return;
  const key = fillEl.id || (track.dataset.sparkKey || (track.dataset.sparkKey = 's' + Math.random().toString(36).slice(2)));

  let svg = track.querySelector('svg.stat-spark');
  if (!svg) {
    track.classList.add('has-spark');
    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'stat-spark');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'stat-spark-line');
    svg.append(line);
    svg.style.color = _statSparkColor(fillEl);
    track.appendChild(svg);
  }

  const hist = _statSparkHist[key] || (_statSparkHist[key] = []);
  hist.push(value);
  if (hist.length > STAT_SPARK_POINTS) hist.shift();

  const n = hist.length;
  const stepX = n > 1 ? 100 / (n - 1) : 100;
  // Auto-scale the Y axis to the recent min/max so even small fluctuations
  // fill the chart with visible peaks/valleys (a flat value stays centred).
  let min = Infinity, max = -Infinity;
  for (const val of hist) { if (val < min) min = val; if (val > max) max = val; }
  const range = (max - min) || 1;
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = (i * stepX).toFixed(2);
    const norm = max === min ? 0.5 : (hist[i] - min) / range;
    const y = (3 + (1 - norm) * 24).toFixed(2);
    d += (i === 0 ? 'M' : 'L') + x + ' ' + y + ' ';
  }
  svg.querySelector('.stat-spark-line').setAttribute('d', d.trim());
}
