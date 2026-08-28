'use strict';
// Server-side action registry: the single allowlisted dispatcher for Deck key
// actions. ALL execution flows through here — validation/normalisation happens
// at this boundary, and the OS side-effects are INJECTED so security decisions
// live in one testable place. Reuses the shared catalog validator.
const { validateAction } = require('../js/deck-actions.js');
const { obsRequest } = require('./obs.js');
const { streamerbotRequest } = require('./streamerbot.js');

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

// What openApp may launch — per platform, because the extension is how each OS
// spells "an application". Windows: .exe/.lnk, exactly what it always was.
// macOS adds `.app` bundles (directories, which fileExists() answers for).
// Linux has no extension convention at all: an app is a .desktop entry, an
// AppImage, or a plain executable whose name carries no extension
// (/usr/bin/firefox) — a dotted name is refused so openApp cannot become a
// second openFile for documents. Takes `platform` like the two gates below, so
// each rule is testable off the OS it targets; before that parameter existed
// the Linux branch fell back to the Windows list and every openApp key on
// Linux validated nothing and failed with bad_app_path.
const APP_PATH_EXT = /\.(exe|lnk)$/i;
const APP_PATH_EXT_DARWIN = /\.(exe|lnk|app)$/i;
const APP_PATH_EXT_LINUX = /\.(desktop|appimage)$/i;
function isAllowedAppPath(p, platform) {
  if (typeof p !== 'string') return false;
  const v = p.trim();
  if (!v) return false;
  const plat = platform || process.platform;
  if (plat === 'darwin') return APP_PATH_EXT_DARWIN.test(v);
  if (plat === 'linux') {
    if (APP_PATH_EXT_LINUX.test(v)) return true;
    const base = v.split('/').pop();
    return !!base && !base.includes('.');
  }
  return APP_PATH_EXT.test(v);
}

// macOS hides the `.app` extension everywhere a person can see a path: Finder
// shows "Helium", so does Get Info, so does the Applications folder. The path a
// Mac user reads off their own screen and types into a key is therefore
// /Applications/Helium — which is neither a bundle nor a file, so the key failed
// with bad_app_path having never launched anything. Reported on Discord by
// someone whose folder and URL keys worked and whose app keys all did not.
//
// This widens nothing. The completed path still has to pass isAllowedAppPath and
// still has to exist; the only change is that one obvious place is checked before
// giving up. A path that already carries an extension is left alone, so a
// document can never be turned into an app by appending to it.
function completeDarwinBundle(p, platform, fileExists) {
  if ((platform || process.platform) !== 'darwin' || typeof fileExists !== 'function') return '';
  const v = String(p == null ? '' : p).replace(/\/+$/, '');
  const base = v.split('/').pop();
  if (!base || base.includes('.')) return '';
  const bundle = v + '.app';
  return fileExists(bundle) ? bundle : '';
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

// Executable / script extensions that must NOT be reachable via openFile (which
// opens with the registered handler). A folder or a document is fine; a .bat or
// .ps1 would run code on one tap. openApp is the only path that may launch exes.
const BLOCKED_OPEN_EXT = /\.(exe|lnk|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|reg|msi|msp|cpl|jar|gadget|inf|appref-ms|jnlp|url|website|scf|library-ms|search-ms|desktop)$/i;

// The same rule, restated for the platforms where `open`/`xdg-open` is the
// handler. The list above is a Windows vocabulary: none of those extensions
// means anything to LaunchServices, which instead runs a .command in Terminal,
// launches an .app or an .appex, executes a .workflow, and hands a .py to the
// Python Launcher — exactly the one-tap code execution the blocklist exists to
// stop. It is kept separate rather than merged so the Windows boundary stays
// byte-for-byte what it was; a name like .sh or .py is a document there and has
// been openable since the feature shipped.
const BLOCKED_OPEN_EXT_POSIX = /\.(command|app|appex|workflow|terminal|action|definition|osax|prefpane|qlgenerator|saver|mdimporter|plugin|bundle|kext|pkg|mpkg|dmg|webloc|fileloc|inetloc|scpt|scptd|applescript|shortcut|sh|bash|zsh|csh|ksh|fish|py|pyw|rb|pl|php|lua|tcl|awk|run|appimage)$/i;

function isBlockedOpenPath(p, platform) {
  const v = String(p == null ? '' : p).trim();
  if (BLOCKED_OPEN_EXT.test(v)) return true;
  const plat = platform || process.platform;
  return plat !== 'win32' && BLOCKED_OPEN_EXT_POSIX.test(v);
}

// The 'runScript' action is the ONE deliberate, user-configured path that may
// launch a batch/PowerShell script (openFile blocks these on purpose — it opens
// with the registered handler, where a .ps1 would land in Notepad and a .bat
// would run on a single tap of anything the user double-clicks). It's no more
// privileged than openApp, which already launches arbitrary executables — the
// user picks the exact script in the editor. The path is validated to a real
// script here; execution goes through deck-actions.ps1's 'runscript' verb, which
// dispatches each type to its interpreter (Windows scripts run directly;
// .ps1 → powershell -File; .py/.js/.rb/.pl/.php/.lua/.r → their interpreter;
// .jar → java -jar; .vbs/.vbe/.wsf → cscript; .sh/.bash → bash). By default it
// runs in a VISIBLE window (an installer or interactive script needs its
// console); the key can opt into a hidden window. The interpreter must be on
// PATH — a missing one degrades to a clean {ok:false} (the key flashes red).
const RUNNABLE_SCRIPT_EXT = /\.(bat|cmd|ps1|py|pyw|js|cjs|mjs|rb|pl|php|lua|r|jar|vbs|vbe|wsf|sh|bash)$/i;

// The same list where the interpreters are POSIX ones (server.js's
// POSIX_SCRIPT_RUNNERS is the other half). It has to be its own list in both
// directions: .bat/.ps1/.vbs mean nothing here and are better refused at this
// boundary than spawned and left to fail, while .command/.zsh are real script
// types the Windows list has no reason to carry.
const RUNNABLE_SCRIPT_EXT_POSIX = /\.(sh|bash|zsh|command|py|pyw|js|cjs|mjs|rb|pl|php|lua|r|jar)$/i;

// AppleScript is macOS-only: `.scpt`/`.applescript` run through osascript,
// which is only in POSIX_SCRIPT_RUNNERS on darwin. Accepting them on Linux
// would be a key that validates here and then fails at run time with "no
// interpreter" — the exact gate/runner drift the CLAUDE.md invariant forbids,
// which is why this is a SEPARATE, platform-gated regex rather than two more
// alternatives in the list above.
const RUNNABLE_SCRIPT_EXT_DARWIN = /\.(scpt|applescript)$/i;

function isRunnableScriptPath(p, platform) {
  const v = String(p == null ? '' : p).trim();
  const plat = platform || process.platform;
  if (plat === 'win32') return RUNNABLE_SCRIPT_EXT.test(v);
  if (RUNNABLE_SCRIPT_EXT_POSIX.test(v)) return true;
  return plat === 'darwin' && RUNNABLE_SCRIPT_EXT_DARWIN.test(v);
}

// deps: { fileExists(path)->bool, openExternal(path)->Promise,
//         mediaAction(cmd)->Promise, micMute(mode)->Promise<{muted}>, volume(mode)->Promise,
//         obs(requestType, requestData)->Promise, obsNext()->Promise,
//         lighting(action)->Promise<boolean>,
//         claudeRun({projectId,prompt,model})->Promise<{ok,error}>, claudeStop()->bool,
//         remote: RemoteControl orchestrator instance (optional, injected after init),
//         platform: override for the extension gates (tests) }
function createRegistry(deps) {
  const d = deps || {};
  // An extension gate is a statement about a HANDLER, so it differs per
  // platform, and both gates below already take the platform as a parameter.
  // Threading it through the registry too is what lets the RUN path be
  // exercised off the OS it targets — without it, `.bat` could only be proven
  // runnable on Windows and refused on POSIX by running the suite twice, on two
  // machines. Same option, same reason, as createDiskSpace's.
  const platform = d.platform || process.platform;
  async function run(rawAction) {
    const action = validateAction(rawAction);
    if (!action) return { ok: false, error: 'unknown_action' };
    // A failing effect (e.g. a stalled media service) must degrade to a clean
    // {ok:false} rather than crash the request — never throw out of run().
    try {
      switch (action.type) {
        case 'openApp': {
          let p = action.path.trim();
          // A direct .exe/.lnk launches as-is. If it isn't one, the user may have
          // pointed at the app's install FOLDER — resolve it to the primary
          // executable inside (re-resolved on every tap, so versioned apps like
          // Discord/Slack 'app-X.Y.Z' keep working after an update).
          if (!isAllowedAppPath(p, platform)) {
            // On macOS the likeliest miss is the hidden .app extension; on
            // Windows it is a path to the install FOLDER. Try the bundle first —
            // resolveAppDir is a Windows notion and has nothing to say about
            // /Applications/Helium.
            const completed = completeDarwinBundle(p, platform, d.fileExists);
            const resolved = completed
              || ((typeof d.resolveAppDir === 'function') ? String(d.resolveAppDir(p) || '') : '');
            if (!resolved || !isAllowedAppPath(resolved, platform)) return { ok: false, error: 'bad_app_path' };
            p = resolved;
          }
          if (!d.fileExists(p)) return { ok: false, error: 'not_found' };
          // Linux has no registered-handler route to "run this program":
          // xdg-open on a binary or a .desktop file OPENS it as a document (or
          // refuses), so launching goes through its own dep. macOS' `open` and
          // Windows' Start-Process both launch apps natively via openExternal.
          if (platform === 'linux') {
            if (typeof d.launchApp !== 'function') return { ok: false, error: 'unavailable' };
            const r = await d.launchApp(p);
            return r && r.ok === false ? { ok: false, error: r.error || 'launch_failed' } : { ok: true };
          }
          await d.openExternal(p);
          return { ok: true };
        }
        case 'openFile': {
          const p = action.path.trim();
          if (!p) return { ok: false, error: 'empty_path' };
          // openFile opens with the registered handler, so executables/scripts
          // are blocked here — only openApp may launch an .exe/.lnk.
          if (isBlockedOpenPath(p, platform)) return { ok: false, error: 'blocked_ext' };
          if (!d.fileExists(p)) return { ok: false, error: 'not_found' };
          await d.openExternal(p);
          return { ok: true };
        }
        case 'runScript': {
          // Deliberate opt-in: run a user-chosen .bat/.cmd/.ps1/.py. Validated to
          // a real script that exists, then handed to the dedicated 'runscript'
          // runner (never openFile's registered handler). `window` (visible by
          // default) decides whether the console is shown — an installer needs it.
          const p = action.path.trim();
          if (!p) return { ok: false, error: 'empty_path' };
          if (!isRunnableScriptPath(p, platform)) return { ok: false, error: 'bad_script_ext' };
          if (!d.fileExists(p)) return { ok: false, error: 'not_found' };
          if (typeof d.runScript !== 'function') return { ok: false, error: 'unavailable' };
          await d.runScript(p, action.window === 'hidden');
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
        case 'launchSteamGame': {
          // Launch a Steam game by AppID via its registered protocol handler.
          // Digits-only validation before interpolation → injection-safe; the URL
          // is handed to the same shell launcher openUrl uses (openExternal).
          const id = action.gameId.trim();
          if (!isSteamAppId(id)) return { ok: false, error: 'bad_app_id' };
          await d.openExternal('steam://rungameid/' + id);
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
        case 'typeText': {
          if (typeof d.typeText !== 'function') return { ok: false, error: 'unavailable' };
          // Strip CR (the PS side maps '\n' to Enter) and require something typable.
          const text = String(action.text || '').replace(/\r/g, '');
          if (!text.trim()) return { ok: false, error: 'empty_text' };
          const r = await d.typeText(text);
          return r && r.ok === false ? { ok: false, error: r.error || 'type_failed' } : { ok: true };
        }
        // The paired phone. Both reach the outside world and cost the user
        // money, so the number is re-validated here even though the deck editor
        // already bounded it: this is the single gate every action passes, and
        // a Deck profile can arrive from a shared preset rather than from the
        // editor. `phoneDial`/`phoneSend` do the dialable() check again.
        case 'phoneCall': {
          if (typeof d.phoneDial !== 'function') return { ok: false, error: 'unavailable' };
          const number = String(action.number || '').trim();
          if (!number) return { ok: false, error: 'bad_number' };
          const r = await d.phoneDial(number);
          return (r && r.ok) ? { ok: true } : { ok: false, error: (r && r.error) || 'dial_failed' };
        }
        case 'phoneMessage': {
          if (typeof d.phoneSend !== 'function') return { ok: false, error: 'unavailable' };
          const number = String(action.number || '').trim();
          const text = String(action.text || '').trim();
          if (!number) return { ok: false, error: 'bad_number' };
          if (!text) return { ok: false, error: 'empty_message' };
          const r = await d.phoneSend(number, text);
          return (r && r.ok) ? { ok: true } : { ok: false, error: (r && r.error) || 'send_failed' };
        }
        case 'lockWorkstation': {
          if (typeof d.lockWorkstation !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.lockWorkstation();
          return r && r.ok === false ? { ok: false, error: r.error || 'failed' } : { ok: true };
        }
        case 'media': await d.mediaAction(action.cmd); return { ok: true };
        case 'mediaSeek': {
          const position = mediaSeekPosition(action.position);
          if (position == null) return { ok: false, error: 'bad_position' };
          if (typeof d.mediaSeek !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.mediaSeek(position);
          return r && r.ok === false ? { ok: false, error: r.error || 'seek_failed' } : { ok: true };
        }
        case 'micMute': return Object.assign({ ok: true }, (await d.micMute(action.mode)) || {});
        case 'volume': {
          if (action.mode === 'set') {
            const v = pctValue(action.value);
            if (v === null) return { ok: false, error: 'bad_value' };
            await d.volume('set', v);
            return { ok: true };
          }
          await d.volume(action.mode);
          return { ok: true };
        }
        case 'timerStart': {
          if (!d.timers || typeof d.timers.start !== 'function') return { ok: false, error: 'unavailable' };
          const label = action.label.trim();
          if (!label) return { ok: false, error: 'empty_label' };
          // Minutes accept a decimal comma too ("1,5"); clamped to 5s–24h.
          const mins = Number(String(action.minutes || '').replace(',', '.'));
          if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: 'bad_minutes' };
          const secs = Math.min(86400, Math.max(5, Math.round(mins * 60)));
          const r = await d.timers.start(label, secs);
          return (r && r.ok === false) ? { ok: false, error: r.error || 'timer_failed' } : { ok: true };
        }
        case 'timerToggle': {
          if (!d.timers || typeof d.timers.toggle !== 'function') return { ok: false, error: 'unavailable' };
          const label = action.label.trim();
          if (!label) return { ok: false, error: 'empty_label' };
          const r = await d.timers.toggle(label);
          return (r && r.ok === false) ? { ok: false, error: r.error || 'not_found' } : { ok: true };
        }
        case 'timerCancel': {
          if (!d.timers || typeof d.timers.cancel !== 'function') return { ok: false, error: 'unavailable' };
          const label = action.label.trim();
          if (!label) return { ok: false, error: 'empty_label' };
          const r = await d.timers.cancel(label);
          return (r && r.ok === false) ? { ok: false, error: r.error || 'not_found' } : { ok: true };
        }
        case 'taskAdd': {
          if (typeof d.taskAdd !== 'function') return { ok: false, error: 'unavailable' };
          const text = action.text.trim();
          if (!text) return { ok: false, error: 'empty_text' };
          const r = await d.taskAdd(text);
          return (r && r.ok === false) ? { ok: false, error: r.error || 'task_failed' } : { ok: true };
        }
        case 'taskToggle': {
          if (typeof d.taskToggle !== 'function') return { ok: false, error: 'unavailable' };
          const id = action.id.trim();
          if (!id) return { ok: false, error: 'empty_id' };
          const r = await d.taskToggle(id);
          return (r && r.ok === false) ? { ok: false, error: r.error || 'not_found' } : { ok: true };
        }
        case 'taskDelete': {
          if (typeof d.taskDelete !== 'function') return { ok: false, error: 'unavailable' };
          const id = action.id.trim();
          if (!id) return { ok: false, error: 'empty_id' };
          const r = await d.taskDelete(id);
          return (r && r.ok === false) ? { ok: false, error: r.error || 'not_found' } : { ok: true };
        }
        case 'appVolume': {
          if (typeof d.appVolume !== 'function') return { ok: false, error: 'unavailable' };
          const app = action.app.trim();
          if (!app) return { ok: false, error: 'no_app' };
          let value;
          if (action.mode === 'set') {
            value = pctValue(action.value);
            if (value === null) return { ok: false, error: 'bad_value' };
          }
          const r = await d.appVolume(app, action.mode, value);
          return r && r.ok === false ? { ok: false, error: r.error || 'app_volume_failed' } : { ok: true };
        }
        case 'appMute': {
          if (typeof d.appMute !== 'function') return { ok: false, error: 'unavailable' };
          const app = action.app.trim();
          if (!app) return { ok: false, error: 'no_app' };
          const r = await d.appMute(app, action.mode);
          return r && r.ok === false ? { ok: false, error: r.error || 'app_mute_failed' } : { ok: true };
        }
        case 'audioDevice': {
          // Only shape-checked here: the id is meaningless without the live
          // device list, so the authority check (must be a CURRENT output
          // device) lives in the dep, next to the enumeration it compares to.
          if (typeof d.audioDevice !== 'function') return { ok: false, error: 'unavailable' };
          const device = String(action.device || '').trim();
          if (!device || device.length > 260) return { ok: false, error: 'no_device' };
          const r = await d.audioDevice(device);
          return r && r.ok === false ? { ok: false, error: r.error || 'audio_device_failed' } : { ok: true };
        }
        case 'obsSceneNext': {
          if (typeof d.obsNext !== 'function') return { ok: false, error: 'obs_unavailable' };
          await d.obsNext();
          return { ok: true };
        }
        case 'obsScene':
        case 'obsRecord':
        case 'obsStream':
        case 'obsMute':
        case 'obsInputVolume': {
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
        case 'twitchTitle': {
          if (typeof d.twitchTitle !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchTitle(action.title);
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'twitchGame': {
          if (typeof d.twitchGame !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchGame(action.game);
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'twitchChat': {
          if (typeof d.twitchChat !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchChat(action.message);
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'twitchShoutout': {
          if (typeof d.twitchShoutout !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchShoutout(action.login);
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'twitchChatMode': {
          if (typeof d.twitchChatMode !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.twitchChatMode(action.mode);
          return r && r.ok === false ? { ok: false, error: r.error || 'twitch_failed' } : { ok: true };
        }
        case 'ytBroadcast': {
          if (typeof d.ytBroadcast !== 'function') return { ok: false, error: 'unavailable' };
          const r = await d.ytBroadcast(action.mode);
          return r && r.ok === false ? { ok: false, error: r.error || 'yt_failed' } : { ok: true };
        }
        case 'sbDoAction':
        case 'sbSendMessage':
        case 'sbCodeTrigger': {
          if (typeof d.streamerbot !== 'function') return { ok: false, error: 'streamerbot_unavailable' };
          const r = streamerbotRequest(action);
          if (!r) return { ok: false, error: 'bad_sb_action' };
          await d.streamerbot(r);
          return { ok: true };
        }
        case 'discordMute':
        case 'discordDeafen':
        case 'discordPtt':
        case 'discordJoin':
        case 'discordLeave':
        case 'discordInputVol':
        case 'discordOutputVol':
        case 'discordUserVol':
        case 'discordUserMute':
        case 'discordAudioToggle':
        case 'discordSoundboard': {
          // One dep for all Discord voice actions; the provider (which owns the
          // RPC connection and current-state reads) does the per-type work. The
          // action is already validated by the shared catalog.
          if (typeof d.discord !== 'function') return { ok: false, error: 'discord_unavailable' };
          const r = await d.discord(action);
          return r && r.ok === false ? { ok: false, error: r.error || 'discord_failed' } : { ok: true };
        }
        case 'spotifySave':
        case 'spotifyPlaylist':
        case 'spotifyShuffle':
        case 'spotifyDevice':
        case 'spotifyPlay':
        case 'spotifyNext':
        case 'spotifyPrev':
        case 'spotifyRepeat':
        case 'spotifyLike':
        case 'spotifyVolume':
        case 'spotifySeek': {
          // One dep for all Spotify actions; the provider maps the (already
          // catalog-validated) action to a Web API call. Playback control needs
          // Spotify Premium — the provider surfaces a 'premium_required' error.
          if (typeof d.spotify !== 'function') return { ok: false, error: 'spotify_unavailable' };
          const r = await d.spotify(action);
          return r && r.ok === false ? { ok: false, error: r.error || 'spotify_failed' } : { ok: true };
        }
        case 'haToggle':
        case 'haScene':
        case 'haScript':
        case 'haButton':
        case 'haLight':
        case 'haMedia':
        case 'haCover':
        case 'haClimate':
        case 'haFan':
        case 'haVacuum':
        case 'haLock':
        case 'haAlarm':
        case 'haCallService': {
          // Home Assistant device control. The provider maps the (already
          // catalog-validated) action to a call_service and re-validates the
          // entity_id/service before it reaches HA.
          if (typeof d.homeAssistant !== 'function') return { ok: false, error: 'ha_unavailable' };
          const r = await d.homeAssistant(action);
          return r && r.ok === false ? { ok: false, error: r.error || 'ha_failed' } : { ok: true };
        }
        case 'chromaColor':
        case 'chromaOff': {
          // Razer Chroma lighting. One dep fronts the local Chroma SDK session;
          // the provider maps the (catalog-validated) action to CHROMA_STATIC /
          // CHROMA_NONE on the targeted device(s) and degrades to {ok:false} when
          // Synapse/Chroma isn't running.
          if (typeof d.chroma !== 'function') return { ok: false, error: 'chroma_unavailable' };
          const r = await d.chroma(action);
          return r && r.ok === false ? { ok: false, error: r.error || 'chroma_failed' } : { ok: true };
        }
        case 'wlInputVolume':
        case 'wlInputMute':
        case 'wlOutputVolume':
        case 'wlOutputMute':
        case 'wlMixVolume':
        case 'wlMixMute':
        case 'wlEffect':
        case 'wlOutputDevice':
        case 'wlSwitchMonitoring':
        case 'wlSetMonitorMix': {
          // Elgato Wave Link mixer control. One dep fronts the local Wave Link
          // client, which speaks whichever dialect answered (2.x echoes the whole
          // mixer object back; 3.x takes a partial patch) and presents one model.
          //
          // The ids here are Wave Link's own — channel, mix, effect and output
          // device — so there is no allowlist to check them against: they are
          // resolved against the live mixer the client just read, and anything
          // it does not recognise comes back as {ok:false} naming which of the
          // four was not found. That is the same shape as the Spotlight result
          // ids: the client validates against state it minted, never against a
          // pattern. A Deck key pointing at a channel or mix the user deleted
          // must fail where they can see it rather than move the nearest fader.
          if (typeof d.waveLink !== 'function') return { ok: false, error: 'wavelink_unavailable' };
          const r = await d.waveLink(action);
          return r && r.ok === false ? { ok: false, error: r.error || 'wavelink_failed' } : { ok: true };
        }
        case 'lightPower':
        case 'lightColor':
        case 'lightAuto':
        case 'lightEffect':
        case 'lightDevice': {
          // Whole-system RGB lighting control (master on/off, fixed colour,
          // ambient effect, per-device mode) — the same primitives the
          // Illuminazione settings drive, persisted the same way. One dep fronts
          // the lighting hub; a disabled/empty rig degrades to {ok:false}.
          if (typeof d.lightingControl !== 'function') return { ok: false, error: 'lighting_unavailable' };
          const r = await d.lightingControl(action);
          return r && r.ok === false ? { ok: false, error: r.error || 'lighting_failed' } : { ok: true };
        }
        case 'signalRgbEffect': {
          // SignalRGB scene switcher (separate from the colour-lighting hub above):
          // applies a named effect via the SignalRGB launcher. Gated + validated
          // server-side; a missing dep / disabled integration degrades to {ok:false}.
          if (typeof d.signalRgbEffect !== 'function') return { ok: false, error: 'unavailable' };
          const effect = action.effect;
          if (!effect) return { ok: false, error: 'empty_effect' };
          const r = await d.signalRgbEffect(effect);
          return r && r.ok === false ? { ok: false, error: r.error || 'failed' } : { ok: true };
        }
        case 'windowMove': {
          // Move/snap/minimise the foreground window. `dir` is constrained to the
          // catalog's option list, so the verb handed to the PowerShell helper is
          // always one of a fixed allowlist (never free-form input).
          if (typeof d.windowAction !== 'function') return { ok: false, error: 'window_unavailable' };
          const r = await d.windowAction(action.dir);
          return r && r.ok === false ? { ok: false, error: r.error || 'window_failed' } : { ok: true };
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
        case 'sdkMacro': {
          // A macro contributed by an installed SDK widget package: "pkg/macroId".
          // The dep resolves it against the package's normalized manifest and
          // returns its steps ONLY when the step categories are user-granted —
          // null otherwise. Each step re-enters run() (so it gets the exact same
          // validation as a directly-dispatched action); nested macros are
          // skipped, so a hostile manifest can't recurse.
          if (typeof d.sdkMacro !== 'function') return { ok: false, error: 'sdk_unavailable' };
          const ref = String(action.macro || '');
          const slash = ref.indexOf('/');
          if (slash <= 0 || slash === ref.length - 1) return { ok: false, error: 'bad_macro' };
          const steps = await d.sdkMacro(ref.slice(0, slash), ref.slice(slash + 1));
          if (!Array.isArray(steps) || !steps.length) return { ok: false, error: 'macro_unavailable' };
          let result = { ok: true };
          let delayBudget = 8000;   // total wait a macro may hold this request for
          for (const s of steps.slice(0, 10)) {
            if (!s || !s.action || s.action.type === 'sdkMacro') continue;   // no nesting
            // Per-step cap matches sdk-widgets MAX_MACRO_STEP_DELAY_MS; the budget
            // bounds the whole macro so one /actions/run can't be held for minutes.
            const wait = Math.min(5000, Math.max(0, s.delayMs | 0), delayBudget);
            if (wait > 0) { delayBudget -= wait; await new Promise(r => setTimeout(r, wait)); }
            const r = await run(s.action);
            if (r && r.ok === false && result.ok) result = { ok: false, error: r.error || 'macro_step_failed' };
          }
          return result;
        }
        case 'claudeAsk': {
          // The key names a project by id and the RUNNER decides whether that id
          // exists — the allowlist is built server-side from Claude Code's own
          // history, and a stored key must not be able to widen it just by
          // outliving the project. Everything else the run does still arrives as
          // an approval card; this starts work, it does not authorise any.
          if (typeof d.claudeRun !== 'function') return { ok: false, error: 'claude_unavailable' };
          const prompt = String(action.prompt || '').trim();
          if (!prompt) return { ok: false, error: 'empty_prompt' };
          const r = await d.claudeRun({
            projectId: String(action.projectId || ''),
            prompt,
            model: String(action.model || ''),
          });
          return (r && r.ok) ? { ok: true } : { ok: false, error: (r && r.error) || 'run_failed' };
        }
        case 'claudeStop': {
          if (typeof d.claudeStop !== 'function') return { ok: false, error: 'claude_unavailable' };
          // Nothing running is not a failure of the key, but it must not report
          // success either — the user pressed stop and nothing stopped.
          return d.claudeStop() ? { ok: true } : { ok: false, error: 'nothing_running' };
        }
        case 'sdkHandler': {
          // A handler action contributed by an installed SDK widget package:
          // "pkg/handlerId" + the key's stored args (a JSON string the editor
          // composed from the handler's declared params). The dep owns every
          // check — declaration, per-handler grant, rate gate, arg coercion —
          // and waits for the widget frame's ack (or times out honestly).
          if (!d.sdkHandler || typeof d.sdkHandler !== 'function') return { ok: false, error: 'sdk_unavailable' };
          const ref = String(action.handler || '');
          const slash = ref.indexOf('/');
          if (slash <= 0 || slash === ref.length - 1) return { ok: false, error: 'bad_handler' };
          const r = await d.sdkHandler(ref.slice(0, slash), ref.slice(slash + 1), action.args);
          return (r && r.ok) ? { ok: true } : { ok: false, error: (r && r.error) || 'handler_failed' };
        }
        default: return { ok: false, error: 'unsupported' };
      }
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'effect_error' };
    }
  }
  return { run };
}

// Resolve an output-device id against a LIVE enumeration. Pure and exported so
// the check that makes `audioDevice` safe is unit-tested rather than trusted:
// SoundVolumeView's /SetDefault accepts render and capture ids from one
// namespace, so accepting an unmatched string would let a caller change the
// default MICROPHONE. Only entries present in the `speakers` (render) list are
// resolvable — an id that is merely well-formed, or that names a capture
// device, has no match and cannot be used.
function resolveOutputDevice(id, speakers) {
  const wanted = String(id == null ? '' : id).trim();
  if (!wanted) return null;
  const list = Array.isArray(speakers) ? speakers : [];
  return list.find((s) => s && typeof s.id === 'string' && s.id === wanted) || null;
}

module.exports = { createRegistry, isHttpUrl, isAllowedAppPath, completeDarwinBundle, isBlockedOpenPath, isRunnableScriptPath, isAppUserModelId, isSteamAppId, normalizeUrl, normalizeKeys, resolveOutputDevice };
