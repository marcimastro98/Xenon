'use strict';
// Server-side action registry: the single allowlisted dispatcher for Deck key
// actions. ALL execution flows through here — validation/normalisation happens
// at this boundary, and the OS side-effects are INJECTED so security decisions
// live in one testable place. Reuses the shared catalog validator.
const { validateAction } = require('../js/deck-actions.js');
const { obsRequest } = require('./obs.js');

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

function isAllowedAppPath(p) {
  return typeof p === 'string' && /\.(exe|lnk)$/i.test(p.trim());
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

// Executable / script extensions that must NOT be reachable via openFile (which
// opens with the registered handler). A folder or a document is fine; a .bat or
// .ps1 would run code on one tap. openApp is the only path that may launch exes.
const BLOCKED_OPEN_EXT = /\.(exe|lnk|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|reg|msi|msp|cpl|jar|gadget|inf)$/i;
function isBlockedOpenPath(p) {
  return BLOCKED_OPEN_EXT.test(String(p == null ? '' : p).trim());
}

// deps: { fileExists(path)->bool, openExternal(path)->Promise,
//         mediaAction(cmd)->Promise, micMute(mode)->Promise<{muted}>, volume(mode)->Promise,
//         obs(requestType, requestData)->Promise, obsNext()->Promise,
//         lighting(action)->Promise<boolean>,
//         remote: RemoteControl orchestrator instance (optional, injected after init) }
function createRegistry(deps) {
  const d = deps || {};
  async function run(rawAction) {
    const action = validateAction(rawAction);
    if (!action) return { ok: false, error: 'unknown_action' };
    // A failing effect (e.g. a stalled media service) must degrade to a clean
    // {ok:false} rather than crash the request — never throw out of run().
    try {
      switch (action.type) {
        case 'openApp': {
          const p = action.path.trim();
          if (!isAllowedAppPath(p)) return { ok: false, error: 'bad_app_path' };
          if (!d.fileExists(p)) return { ok: false, error: 'not_found' };
          await d.openExternal(p);
          return { ok: true };
        }
        case 'openFile': {
          const p = action.path.trim();
          if (!p) return { ok: false, error: 'empty_path' };
          // openFile opens with the registered handler, so executables/scripts
          // are blocked here — only openApp may launch an .exe/.lnk.
          if (isBlockedOpenPath(p)) return { ok: false, error: 'blocked_ext' };
          if (!d.fileExists(p)) return { ok: false, error: 'not_found' };
          await d.openExternal(p);
          return { ok: true };
        }
        case 'openStoreApp': {
          // Launch a Store/UWP app by its AppUserModelID (Microsoft Store apps live in
          // a protected WindowsApps folder and can't be started by path — they need
          // shell:AppsFolder\<aumid>). The AUMID is strictly validated first.
          const id = action.appId.trim();
          if (!isAppUserModelId(id)) return { ok: false, error: 'bad_app_id' };
          if (typeof d.openStoreApp !== 'function') return { ok: false, error: 'unavailable' };
          await d.openStoreApp(id);
          return { ok: true };
        }
        case 'openUrl': {
          const url = normalizeUrl(action.url);
          if (!url) return { ok: false, error: 'bad_url' };
          await d.openExternal(url);
          return { ok: true };
        }
        case 'webhook': {
          const url = normalizeUrl(action.url);
          if (!url) return { ok: false, error: 'bad_url' };
          const init = { method: action.method, signal: AbortSignal.timeout(5000) };
          // body is always a string from validateAction; falsy = empty, so skip body/headers.
          if (action.method === 'POST' && action.body) {
            init.body = action.body;
            init.headers = { 'Content-Type': 'application/json' };
          }
          try {
            const res = await fetch(url, init);
            return res.ok ? { ok: true } : { ok: false, error: 'http_' + res.status };
          } catch (e) {
            return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed' };
          }
        }
        case 'hotkey': {
          if (typeof d.sendHotkey !== 'function') return { ok: false, error: 'hotkey_unavailable' };
          const keys = normalizeKeys(action.keys);
          if (!keys) return { ok: false, error: 'bad_keys' };
          const r = await d.sendHotkey(keys);
          return r && r.ok === false ? { ok: false, error: r.error || 'hotkey_failed' } : { ok: true };
        }
        case 'media':   await d.mediaAction(action.cmd); return { ok: true };
        case 'micMute': return Object.assign({ ok: true }, (await d.micMute(action.mode)) || {});
        case 'volume':  await d.volume(action.mode);     return { ok: true };
        case 'appVolume': {
          if (typeof d.appVolume !== 'function') return { ok: false, error: 'unavailable' };
          const app = action.app.trim();
          if (!app) return { ok: false, error: 'no_app' };
          const r = await d.appVolume(app, action.mode);
          return r && r.ok === false ? { ok: false, error: r.error || 'app_volume_failed' } : { ok: true };
        }
        case 'appMute': {
          if (typeof d.appMute !== 'function') return { ok: false, error: 'unavailable' };
          const app = action.app.trim();
          if (!app) return { ok: false, error: 'no_app' };
          const r = await d.appMute(app, action.mode);
          return r && r.ok === false ? { ok: false, error: r.error || 'app_mute_failed' } : { ok: true };
        }
        case 'obsSceneNext': {
          if (typeof d.obsNext !== 'function') return { ok: false, error: 'obs_unavailable' };
          await d.obsNext();
          return { ok: true };
        }
        case 'obsScene':
        case 'obsRecord':
        case 'obsStream':
        case 'obsMute': {
          if (typeof d.obs !== 'function') return { ok: false, error: 'obs_unavailable' };
          const r = obsRequest(action);
          if (!r) return { ok: false, error: 'bad_obs' };
          await d.obs(r.requestType, r.requestData);
          return { ok: true };
        }
        case 'lighting': {
          if (typeof d.lighting !== 'function') return { ok: false, error: 'lighting_unavailable' };
          const ok = await d.lighting(action);
          return ok === false ? { ok: false, error: 'lighting_failed' } : { ok: true };
        }
        case 'twitchClip': {
          if (typeof d.twitchClip !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchClip();
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'twitchMarker': {
          if (typeof d.twitchMarker !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchMarker(action.description);
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'twitchAd': {
          if (typeof d.twitchAd !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchAd(action.length);
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'ytBroadcast': {
          if (typeof d.ytBroadcast !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.ytBroadcast(action.mode);
          return r && r.ok === false ? { ok: false, error: r.error || 'yt_failed' } : { ok: true };
        }
        case 'remoteDisconnect': {
          if (!d.remote) return { ok: false, error: 'remote_unavailable' };
          await d.remote.closeSession();
          return { ok: true };
        }
        case 'remoteBlock': {
          if (!d.remote) return { ok: false, error: 'remote_unavailable' };
          const mode = action.mode || 'toggle';
          if (mode === 'block') {
            await d.remote.blockAccess();
          } else if (mode === 'unblock') {
            await d.remote.unblockAccess();
          } else {
            // toggle: read current state then flip
            const st = await d.remote.status();
            if (st && st.blocked) await d.remote.unblockAccess(); else await d.remote.blockAccess();
          }
          return { ok: true };
        }
        case 'remoteScreenCycle': {
          if (!d.remote) return { ok: false, error: 'remote_unavailable' };
          await d.remote.cycleScreen();
          return { ok: true };
        }
        default:        return { ok: false, error: 'unsupported' };
      }
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'effect_error' };
    }
  }
  return { run };
}

module.exports = { createRegistry, isHttpUrl, isAllowedAppPath, isAppUserModelId, normalizeUrl, normalizeKeys };
