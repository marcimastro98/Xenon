// What the call window says: its words, the reason a call could not be made, the settings of calls,
// the initials shown when a caller has no picture, and the ring.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;    // shared DOM factory from utils.js

  function callsCfg() {
    try {
      const c = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.calls : null;
      return c && typeof c === 'object' ? c : {};
    } catch { return {}; }
  }

  // Initials for the avatar. Only letters and digits count as a word: people
  // put emoji in contact names ("Amore 🐔"), and taking the emoji as a second
  // initial filled the circle with a picture instead of a letter. \p{L} keeps
  // Cyrillic, Greek and CJK working — it is emoji and punctuation that are
  // excluded, not non-Latin scripts.
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/)
      .map(w => Array.from(w).filter(ch => /[\p{L}\p{N}]/u.test(ch)).join(''))
      .filter(Boolean);
    if (!parts.length) return '';
    const first = Array.from(parts[0])[0] || '';
    const second = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || '') : '';
    return (first + second).toUpperCase();
  }

  function errorText(code) {
    const map = {
      window_not_found: t('call_err_window', 'I could not find that app’s window.'),
      no_window_tool: t('call_err_window', 'I could not find that app’s window.'),
      window_list_failed: t('call_err_window', 'I could not find that app’s window.'),
      hotkey_unavailable: t('call_err_keys', 'This machine cannot send the shortcut.'),
      hotkey_failed: t('call_err_keys', 'This machine cannot send the shortcut.'),
      accessibility_denied: t('call_err_access', 'Allow Xenon Helper under Accessibility to answer from here.'),
      discord_unavailable: t('call_err_discord', 'Discord is not connected.'),
      discord_failed: t('call_err_discord', 'Discord is not connected.'),
      not_ringing: t('call_err_gone', 'That call is no longer ringing.'),
      unavailable: t('call_err_unavailable', 'That is not possible on this PC.'),
    };
    return map[code] || t('call_err_generic', 'It did not work.');
  }

  function ring(on) {
    try { if (window.XenonSound && typeof window.XenonSound.ring === 'function') window.XenonSound.ring(!!on); }
    catch { /* audio is optional; the card is the real surface */ }
  }

  window.CallModalWords = { t, el, callsCfg, initials, errorText, ring };
})();
