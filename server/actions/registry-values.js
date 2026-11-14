'use strict';
// Checks of the small values an action carries: a web address, a percentage, a position in a
// track, a key combination, a Store app id, a Steam app id. Part of the action registry: only
// registry.js requires this file.

function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
}

// Accept a bare domain (e.g. "www.google.com") by defaulting it to https://.
// Returns a safe http(s) URL string, or '' if it isn't / can't be one. A value
// that already carries a non-http scheme (javascript:, file:, …) is rejected.
function normalizeUrl(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : 'https://' + v;
  return isHttpUrl(withScheme) ? withScheme : '';
}

// Percentage value for the volume/brightness 'set' modes: accepts a decimal
// comma, clamps to 0–100, returns null on anything non-numeric (reject loud).
// Empty/whitespace is EXPLICITLY null — Number('') is 0, and a "set volume"
// key saved with a blank value must fail loud, not slam the volume to zero.
function pctValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
}

// Absolute media positions are whole seconds. Bound the value before it reaches
// any platform adapter: the current media stream is second-resolution, and no
// widget should be able to turn an accidental exponential value into an
// oversized native timestamp. The host may clamp further to the active track.
const MAX_MEDIA_SEEK_SECONDS = 24 * 60 * 60;
function mediaSeekPosition(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(MAX_MEDIA_SEEK_SECONDS, Math.round(n));
}

// Allowed hotkey tokens: the five modifiers, a set of named keys, single
// letters/digits, and F1–F24. Anything else makes the whole combo invalid.
const HOTKEY_MODS = new Set(['ctrl', 'control', 'alt', 'shift', 'win']);
const HOTKEY_NAMED = new Set([
  'enter', 'return', 'esc', 'escape', 'tab', 'space', 'backspace', 'delete', 'del',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'insert',
]);
function isHotkeyToken(tok) {
  if (HOTKEY_MODS.has(tok) || HOTKEY_NAMED.has(tok)) return true;
  if (/^[a-z0-9]$/.test(tok)) return true;
  return /^f([1-9]|1[0-9]|2[0-4])$/.test(tok);
}
// Canonicalise a hotkey combo ("Ctrl+Shift+M") to a safe lowercase "+"-joined
// form, or '' if it contains anything unknown — so an injection attempt (shell
// metachars, spaces, unknown tokens) can never reach the PowerShell runner. A
// valid combo has exactly one non-modifier key.
function normalizeKeys(s) {
  const parts = String(s == null ? '' : s).toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  let mainKeyCount = 0;
  for (const p of parts) {
    if (!isHotkeyToken(p)) return '';
    if (!HOTKEY_MODS.has(p)) mainKeyCount++;
  }
  return mainKeyCount === 1 ? parts.join('+') : '';
}

// A Store/UWP launch target is an AppUserModelID: PackageFamilyName!AppId (e.g.
// SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify). The strict charset means the value
// can be safely handed to the shell (shell:AppsFolder\<aumid>) with no injection.
function isAppUserModelId(s) {
  return typeof s === 'string' && /^[\w.-]+![\w.-]+$/.test(s.trim());
}

// A Steam AppID is a plain integer (e.g. 1086940 for Baldur's Gate 3). Digits
// only — the value is interpolated into a steam://rungameid/<id> URL, so the
// strict charset guarantees there's nothing to inject. 1–12 digits covers every
// real store AppID with headroom.
function isSteamAppId(s) {
  return typeof s === 'string' && /^\d{1,12}$/.test(s.trim());
}

module.exports = {
  isHttpUrl, normalizeUrl, pctValue, MAX_MEDIA_SEEK_SECONDS, mediaSeekPosition, HOTKEY_MODS,
  HOTKEY_NAMED, isHotkeyToken, normalizeKeys, isAppUserModelId, isSteamAppId,
};
