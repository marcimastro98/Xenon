'use strict';
// Bit's actions on the PC itself (/api/vitals/nag, js/vitals-pet.js): a popup
// with what Bit says, hiding the windows, and the line Bit shows right before
// it locks the PC. The route keeps the opt-ins, presence and cooldowns; this
// file only knows HOW each OS does it, so the answer is the truth on this PC.
//
//   Windows  vitals-nag.ps1: Bit's own popup on one or every monitor, and
//            "show desktop" (Shell.Application MinimizeAll).
//   macOS    the popup goes to the Xenon app's on-screen alerts window on the
//            main screen (js/screen-alerts.js), else a Notification Center
//            banner; hiding = hide the other apps (darwin-collectors.js).
//   Linux    the same popup route, else notify-send; hiding = show desktop on
//            X11 and on KDE Plasma (linux-collectors.js). GNOME on Wayland
//            gives an app no way to hide other windows.
//
// deps (injected):
//   platform     process.platform
//   collectors   darwin/linux collectors: hideWindows(), hideWindowsTool(), notify()
//   spawnScript  (args[]) → void, runs vitals-nag.ps1 (Windows only)
//   host         layers-host.js: available() says a Xenon app window can draw
//   broadcast    (popup) → void, SSE `vitals_nag` for that window
//   now          clock, for tests

// How long the popup stays, as the Windows script's -Duration.
const POPUP_MS = 9000;
// The fonts the Windows popup needs for CJK; the .ps1 falls back to Consolas.
const NAG_FONTS = Object.freeze({ ko: 'Malgun Gothic', ja: 'Yu Gothic UI', zh: 'Microsoft YaHei' });
const MOODS = ['angry', 'ghost', 'worried'];

function cleanText(text) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

function popupFont(lang) {
  const code = String(lang || '').toLowerCase().replace('_', '-').slice(0, 2);
  return NAG_FONTS[code] || 'Consolas';
}

function createVitalsNag({ platform = process.platform, collectors = null, spawnScript = null, host = null, broadcast = null, now = Date.now } = {}) {
  const windows = platform === 'win32';
  let shown = null;

  const appWindow = () => !!(host && typeof host.available === 'function' && host.available());

  // What a popup can reach right now: 'screens' (every monitor), 'main' (the
  // main screen, through the Xenon app), 'notify' (a system banner) or ''.
  function popupReach() {
    if (windows) return typeof spawnScript === 'function' ? 'screens' : '';
    if (appWindow()) return 'main';
    return collectors && typeof collectors.notify === 'function' ? 'notify' : '';
  }

  // → { ok: true, reach } or { ok: false, error }
  async function popup({ text, mood, all = false, lang = '', extra = [] } = {}) {
    const line = cleanText(text);
    const face = MOODS.includes(mood) ? mood : 'angry';
    const reach = popupReach();
    if (reach === 'screens') {
      spawnScript(['-Text', line, '-Mood', face, '-Duration', String(POPUP_MS / 1000), '-Font', popupFont(lang),
        ...(all ? ['-AllScreens'] : []), ...extra]);
      return { ok: true, reach };
    }
    if (!line) return { ok: true, reach };
    if (reach === 'main') {
      shown = { text: line, mood: face, until: now() + POPUP_MS };
      if (typeof broadcast === 'function') broadcast(shown);
      return { ok: true, reach };
    }
    if (reach === 'notify') {
      try { await collectors.notify('Bit', line); return { ok: true, reach }; } catch { return { ok: false, error: 'notify_failed' }; }
    }
    return { ok: false, error: 'unavailable' };
  }

  // The popup the app window should show if it opens now (SSE has no replay).
  function current() {
    return shown && shown.until > now() ? { ...shown } : null;
  }

  // → { ok: true } or { ok: false, error: 'wayland' | 'needs_wmctrl' | 'failed' | 'unavailable' }
  async function hide({ text, lang = '' } = {}) {
    if (windows) {
      if (typeof spawnScript !== 'function') return { ok: false, error: 'unavailable' };
      return popup({ text, lang, extra: ['-Minimize'] }).then((r) => (r.ok ? { ok: true } : r));
    }
    if (!collectors || typeof collectors.hideWindows !== 'function') return { ok: false, error: 'unavailable' };
    try {
      await collectors.hideWindows();
    } catch (e) {
      return { ok: false, error: e && (e.code === 'wayland' || e.code === 'needs_wmctrl') ? e.code : 'failed' };
    }
    if (cleanText(text)) await popup({ text, lang });
    return { ok: true };
  }

  // What Settings shows: each step that cannot work here is hidden with its reason.
  async function capabilities() {
    const reach = popupReach();
    let minimize = { ok: windows && typeof spawnScript === 'function', reason: '' };
    if (!windows) {
      try {
        const probe = collectors && typeof collectors.hideWindowsTool === 'function' ? await collectors.hideWindowsTool() : null;
        minimize = probe && probe.tool ? { ok: true, reason: '' } : { ok: false, reason: (probe && probe.reason) || 'unavailable' };
      } catch { minimize = { ok: false, reason: 'unavailable' }; }
    }
    return { popup: reach, allScreens: reach === 'screens', minimize };
  }

  return { popup, hide, current, capabilities, popupReach };
}

module.exports = { createVitalsNag, cleanText, popupFont, POPUP_MS };
