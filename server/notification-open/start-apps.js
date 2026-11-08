'use strict';
// Windows only: the apps in the Start menu's Apps folder, by AppUserModelID,
// and starting one of them. A notification names its app by AUMID; only an
// AUMID found here is ever handed to explorer, so a tap can start an app the
// user has installed and nothing else.

const LIST_TTL_MS = 10 * 60 * 1000;
const GET_START_APPS = 'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress';

// Get-StartApps answers one object for one app, an array for more.
function parseStartApps(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || '').trim() || '[]'); } catch { return []; }
  const out = [];
  for (const a of Array.isArray(parsed) ? parsed : [parsed]) {
    const id = a && typeof a.AppID === 'string' ? a.AppID : '';
    if (!id || id.length > 260) continue;
    out.push({ name: a && typeof a.Name === 'string' ? a.Name : id, id });
  }
  return out;
}

function readStartApps(execFile) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', GET_START_APPS],
      { timeout: 9000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (_e, stdout) => resolve(parseStartApps(stdout)));
  });
}

// The ids, read once and kept for 10 minutes: a notification tap must not
// start PowerShell every time. A failed read is not kept.
function createStartAppIds(read, ttlMs = LIST_TTL_MS) {
  let ids = null;
  let at = 0;
  let inflight = null;
  return function startAppIds() {
    if (ids && Date.now() - at < ttlMs) return Promise.resolve(ids);
    if (!inflight) {
      inflight = Promise.resolve(read()).then((apps) => {
        const next = new Set((Array.isArray(apps) ? apps : []).map((a) => a.id));
        if (next.size) { ids = next; at = Date.now(); }
        return next;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  };
}

// explorer.exe exits with 1 even when it opened the app, so only a failure to
// start explorer itself (a string code such as ENOENT) is an error.
function launchAumid(execFile, aumid) {
  return new Promise((resolve, reject) => {
    execFile('explorer.exe', ['shell:AppsFolder\\' + aumid], { windowsHide: true, timeout: 8000 },
      (e) => (e && typeof e.code === 'string' ? reject(e) : resolve()));
  });
}

module.exports = { parseStartApps, readStartApps, createStartAppIds, launchAumid, LIST_TTL_MS };
