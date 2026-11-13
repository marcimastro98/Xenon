// Moving a tile without reloading it, toasts, clock and date text, sizes, app names and the fill of
// a bar.
'use strict';

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

// Put `node` into `parent` (before `ref`, or at the end) WITHOUT reloading the
// iframes inside it. appendChild/insertBefore of a node already in the page is a
// remove and an insert, and an iframe that leaves the document is torn down and
// loads again. For the Twitch tile that was a new pre-roll ad every time the
// dashboard re-homed it (rebuilding the pages parks every tile in #widget-pool
// and puts it back: measured, one fresh load per rebuild). Element.moveBefore
// is an atomic move that keeps the frame running, including through the hidden
// pool. It only applies when both nodes are in the document; anything else, or
// an engine without it (Safari, so a paired iPhone), takes the old path.
function moveNode(parent, node, ref = null) {
  if (typeof parent.moveBefore === 'function' && parent.isConnected && node.isConnected) {
    try { parent.moveBefore(node, ref); return node; } catch { /* not movable atomically here */ }
  }
  return parent.insertBefore(node, ref);
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

// Limited-edition stock, derived rather than trusted. `catalog.json` publishes
// `total` + `claimed`; `left` and `soldOut` are ADDED by the server proxy
// (community-catalog.js → normalizeLimited) and refreshed from the hub. Any
// surface reading a catalog that did not pass through that proxy — the website's
// static demo is one, and it is the one visitors see — therefore has neither,
// and printing `lim.left` straight into the string put "undefined of 50 left" in
// front of them, with a sold-out drop still announced as available beside it.
// One derivation for every meter and count, in the shape those call sites want.
// Returns null when the entry carries no usable stock at all, which every caller
// reads as "no meter" rather than as a zero.
function limitedStock(lim) {
  if (!lim || typeof lim !== 'object') return null;
  const total = Math.max(0, Math.round(Number(lim.total) || 0));
  if (!total) return null;
  const claimed = Math.min(total, Math.max(0, Math.round(Number(lim.claimed) || 0)));
  const rawLeft = Number(lim.left);
  // An explicit `left` wins (the hub's live count is fresher than the published
  // `claimed`); absent or unusable, the published pair still answers the question.
  const left = Number.isFinite(rawLeft) ? Math.min(total, Math.max(0, Math.round(rawLeft))) : total - claimed;
  return { total, left, claimed: total - left, soldOut: lim.soldOut === true || left <= 0 };
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

// The options every clock time in the app is formatted with. It exists because
// clockUses12h() did not travel: the dashboard clock and the lock screen asked
// it, and the twelve OTHER places that print an hour did not — they handed
// Intl.DateTimeFormat a locale and let it decide. So a user who chose 24h in
// Settings still read "09:30 PM" in the calendar, the agenda, the Ambient
// scenes, the football fixtures, the stock ticker and the Discord widget.
// Reported on Discord as a missing Calendar option; it was the setting being
// ignored in eleven places at once.
//
// `extra` carries the date parts a caller also wants (weekday, day, month), so
// this composes instead of replacing each call site's own shape.
function timeParts(extra) {
  const base = Object.assign({}, extra || {}, { hour: '2-digit', minute: '2-digit' });
  // Asymmetric on purpose, and the two halves are not the same decision.
  //
  // 24h asks for hourCycle 'h23' rather than hour12:false, because hour12:false
  // lets the engine pick between h23 (00:30) and h24 (24:30) and they do not all
  // pick the same one — the "24:00" midnight is a real rendering, not a myth.
  // V8 answers h23 today; naming it means every engine does, WebKit included,
  // and a dashboard on a paired iPhone is a WebKit dashboard.
  //
  // 12h keeps hour12:true rather than 'h12', because the twelve-hour clock is
  // not written the same way everywhere: Japanese midnight is 午前00:30 (h11)
  // and forcing h12 would print 午前12:30, which is not how it is said. Here the
  // locale genuinely knows better than we do.
  if (clockUses12h()) base.hour12 = true;
  else base.hourCycle = 'h23';
  return base;
}

// timeParts() with the hour unpadded: a sentence or a chart axis has no column to keep
// straight ("9:30", "3 PM"). minutes: false leaves the bare hour.
function plainHourParts({ minutes = true } = {}) {
  const parts = timeParts();
  parts.hour = 'numeric';
  if (!minutes) delete parts.minute;
  return parts;
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
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function formatUptime(seconds) {
  if (_xcFmt) return _xcFmt.formatUptime(seconds);
  const h = Math.floor((seconds || 0) / 3600);
  const m = Math.floor(((seconds || 0) % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
  // The mixer names an app by its process ("Spotify.exe"): the name alone reads better.
  const raw = String(name || '').trim().replace(/\.exe$/i, '');
  if (!raw) return 'App';
  const known = {
    chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', explorer: 'Explorer', spotify: 'Spotify',
    code: 'VS Code', discord: 'Discord', steam: 'Steam', notepad: 'Notepad', powershell: 'PowerShell',
    pwsh: 'PowerShell', cmd: 'Command Prompt', taskmgr: 'Task Manager', icue: 'iCUE',
    msedgewebview2: 'Edge WebView2', obs64: 'OBS Studio', obs: 'OBS Studio'
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
