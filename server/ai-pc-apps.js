'use strict';
// What Bit's open_application and close_application tools may touch.
//
// Both run with no confirmation card, so they must never be more than what
// their names promise. The model's arguments can be steered by text it read
// (a web page, a news headline, a message, a calendar invite), and before
// this open_application handed ANY string to Windows' ShellExecute: a network
// path (\\host\share\x.hta), a search-ms: or ms-*: link, a script file. And
// close_application matched process names with wildcards, so a target of "*"
// or "e" force-closed nearly everything the user had open.
//
// open: an app by name, a website, or a file on this PC that is not a script
// or another type that runs when opened. Anything else is refused with a
// reason the model can repeat. Running commands has its own tool with a
// confirmation card (PC Control).
// close: one process by its exact name, never one of Windows' own or Xenon.

const { normalizeUrl, isBlockedOpenPath, isAllowedAppPath } = require('./actions/registry');

const DRIVE_PATH = /^[a-z]:[\\/]/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+&'-]{0,63}$/u;

function isNetworkPath(p) {
  const s = String(p || '').trim();
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s);
  return /^[\\/]{2}/.test(s);
}

/**
 * @returns {{ ok: true, target: string, kind: 'protocol'|'url'|'path'|'name' } | { ok: false, error: string }}
 */
function openTarget(raw, protocolMap = {}) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: false, error: 'empty' };
  const mapped = protocolMap[v.toLowerCase()];
  if (mapped) return { ok: true, target: mapped, kind: 'protocol' };
  if (isNetworkPath(v)) return { ok: false, error: 'network_path' };
  if (/^https?:\/\//i.test(v)) {
    const url = normalizeUrl(v);
    return url ? { ok: true, target: url, kind: 'url' } : { ok: false, error: 'bad_url' };
  }
  if (DRIVE_PATH.test(v)) {
    // An app (.exe/.lnk) starts as it would from the Start menu; any other file
    // opens with its program unless it is a type that runs code when opened.
    if (isAllowedAppPath(v, 'win32')) return { ok: true, target: v, kind: 'path' };
    if (isBlockedOpenPath(v, 'win32')) return { ok: false, error: 'blocked_type' };
    return { ok: true, target: v, kind: 'path' };
  }
  if (SCHEME.test(v)) return { ok: false, error: 'scheme_not_allowed' };
  // A name Windows looks up in App Paths ("spotify", "notepad.exe"): no path
  // separators, and not a script name that would resolve in some folder.
  if (!APP_NAME.test(v) || v.includes('..')) return { ok: false, error: 'bad_name' };
  if (/\.[a-z0-9-]+$/i.test(v) && !isAllowedAppPath(v, 'win32') && isBlockedOpenPath(v, 'win32')) {
    return { ok: false, error: 'blocked_type' };
  }
  return { ok: true, target: v, kind: 'name' };
}

// Processes that are Windows itself, or Xenon: closing one logs the user out,
// crashes the session or takes the assistant down mid-answer.
const PROTECTED = new Set([
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
  'svchost', 'dwm', 'explorer', 'fontdrvhost', 'sihost', 'ctfmon', 'taskhostw', 'runtimebroker',
  'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost', 'audiodg',
  'spoolsv', 'securityhealthservice', 'msmpeng', 'nissrv', 'conhost', 'dllhost', 'wudfhost',
  'node', 'xenon-native', 'xenon-helper', 'powershell', 'pwsh',
]);

/** @returns {{ ok: true, name: string } | { ok: false, error: string }} */
function closeTarget(raw, closeMap = {}) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: false, error: 'empty' };
  const name = String(closeMap[v.toLowerCase()] || v).replace(/\.exe$/i, '').trim();
  // Exact names only: no wildcards, no paths.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._+-]{0,63}$/u.test(name)) return { ok: false, error: 'bad_name' };
  if (PROTECTED.has(name.toLowerCase())) return { ok: false, error: 'protected' };
  return { ok: true, name };
}

// Home Assistant domains Bit may not drive by itself. Its tool has no
// confirmation card, and a sentence it read could otherwise unlock the front
// door, disarm the alarm, open the garage or run any script the house has.
// turn_on and toggle count too: Home Assistant maps them onto unlock and open.
// Lights, climate, media, fans, vacuums and scenes stay; the rest is done
// from Home Assistant itself or from a Deck key the user built.
const HA_GUARDED = new Set([
  'lock', 'alarm_control_panel', 'cover', 'valve', 'siren', 'button', 'input_button',
  'script', 'automation', 'shell_command', 'rest_command', 'python_script', 'pyscript',
  'homeassistant', 'hassio', 'notify', 'persistent_notification', 'camera', 'update',
]);
function haDomainAllowed(entityOrService) {
  const domain = String(entityOrService || '').split('.')[0].trim().toLowerCase();
  return !!domain && !HA_GUARDED.has(domain);
}

// Did the user give this phone number themselves? Compares digits only, so
// "+39 333 123 4567", "0039 3331234567" and "333-1234567" all match one
// another; at least 6 digits must line up, and they must be the number's last
// ones (the part that is not a country prefix).
function numberSaidByUser(number, userText) {
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const n = digits(number).replace(/^00/, '');
  if (n.length < 3) return false;
  const said = String(userText || '').split(/[^\d+().\s-]+/).map(digits).filter(Boolean);
  const tail = n.slice(-Math.min(n.length, 9));
  return said.some((d) => d.replace(/^00/, '').endsWith(tail) || (d.length >= 6 && n.endsWith(d)));
}

module.exports = { openTarget, closeTarget, isNetworkPath, PROTECTED, HA_GUARDED, haDomainAllowed, numberSaidByUser };
