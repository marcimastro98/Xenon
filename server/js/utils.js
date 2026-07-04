'use strict';

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
    const data = JSON.parse(raw || '[]');
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
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + ' TB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  return b + ' B';
}

function formatUptime(seconds) {
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
