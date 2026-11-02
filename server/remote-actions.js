'use strict';
// What a paired phone or tablet may run on the PC through /actions/run.
//
// A paired device used to be able to send ANY action: an "open app" with any
// program and any arguments, a script, typed text, a key combination. Whoever
// held one device token (a lost phone, or a token read off a plain-HTTP Wi-Fi
// link) could therefore run anything on the PC. The phone's real job is to
// press the keys the user built and to drive media, volume, lights and the
// like, so that is what it can do now:
//
//  · FREE actions run as asked. They control playback, audio, lights, timers,
//    the dashboard and captures: nothing that starts a program, types, sends a
//    message to someone, opens a door or a garage, or goes live.
//  · Every other action runs only when it is exactly one the user already put
//    on a Deck key (on any page, profile or saved preset), so a phone can
//    press "Open OBS" but cannot invent "open powershell.exe -c ...". The
//    comparison is on the action as the registry reads it (validateAction), so
//    labels and colours do not matter and a changed path or argument does.
//  · Calls and texts placed by the PC never run from a phone: the routes for
//    them are already PC-only, and the phone can call by itself.
//
// The Deck itself cannot be used to get round this: a save from a phone that
// would ADD a guarded action the Deck did not have is refused (introduces()).
// Rearranging keys, deleting them and editing free actions still work.

const { validateAction } = require('./js/deck-actions.js');

const FREE = new Set([
  // Playback and audio.
  'media', 'mediaSeek', 'playSound', 'soundStopAll', 'micMute', 'volume',
  'appVolume', 'appMute', 'appMixer', 'audioDevice', 'audioDeviceFirst', 'audioDeviceToggle',
  'spotifyPlay', 'spotifyNext', 'spotifyPrev', 'spotifySave', 'spotifyLike', 'spotifyShuffle',
  'spotifyRepeat', 'spotifyVolume', 'spotifySeek', 'spotifyPlaylist', 'spotifyPlayUri', 'spotifyDevice',
  'wlInputVolume', 'wlInputMute', 'wlOutputVolume', 'wlOutputMute', 'wlMixVolume', 'wlMixMute',
  'wlEffect', 'wlOutputDevice', 'wlSwitchMonitoring', 'wlSetMonitorMix',
  'vmStripMute', 'vmStripGain', 'vmStripBus', 'vmBusMute', 'vmBusGain', 'vmParam',
  // Discord voice controls (joining a channel or playing to others is not here).
  'discordMute', 'discordDeafen', 'discordPtt', 'discordLeave', 'discordInputVol',
  'discordOutputVol', 'discordUserVol', 'discordUserMute', 'discordAudioToggle',
  // OBS scenes and audio (going live or recording is not here).
  'obsScene', 'obsSceneNext', 'obsMute', 'obsInputVolume',
  // Home: lights and comfort. Locks, alarms, covers, scripts and raw service
  // calls are not here.
  'haToggle', 'haLight', 'haMedia', 'haClimate', 'haFan', 'haVacuum', 'haScene',
  'lighting', 'lightPower', 'lightColor', 'lightAuto', 'lightEffect', 'lightDevice', 'lightPart',
  'chromaColor', 'chromaOff', 'signalRgbEffect',
  // Timers, tasks, the dashboard.
  'timerStart', 'stopwatchStart', 'timerToggle', 'timerCancel', 'vitalsRefill',
  'taskAdd', 'taskToggle', 'taskDelete', 'dashboardPage', 'deckState', 'lockWorkstation',
  'xenonMenu', 'dnd', 'notifications', 'screenAlerts', 'layerList', 'layersToggle', 'layerPage',
  'claudeStop',
  // Performance readouts and captures the phone already shows.
  'perfStats', 'stutterWhy', 'gameSessions', 'gameSessionsCompare', 'perfHud', 'benchmark',
  'powerStatus', 'screenshot', 'screenPin', 'screenColor', 'screenMeasure', 'screenDraw',
  'captureMarker', 'markClips', 'replay', 'gallery', 'galleryList',
]);

// Never from a paired device, even when a Deck key holds them.
const PC_ONLY = new Set(['phoneCall', 'phoneMessage']);

// The action as the registry will run it, written the same way every time.
function canonical(raw) {
  let a;
  try { a = validateAction(raw); } catch { a = null; }
  return a ? stable(a) : null;
}
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// Every guarded action found anywhere in a Deck store (keys, steps, holds,
// gestures, profiles, presets): any object whose `type` the registry accepts.
function guardedIn(store) {
  const out = new Set();
  const seen = new Set();
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 40 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node.type === 'string' && !FREE.has(node.type)) {
      const c = canonical(node);
      if (c) out.add(c);
    }
    for (const k of Object.keys(node)) walk(node[k], depth + 1);
  })(store, 0);
  return out;
}

/** May a paired device run this action? `store` is the saved Deck store. */
function remoteMayRun(raw, store) {
  let a;
  try { a = validateAction(raw); } catch { a = null; }
  if (!a) return { ok: true };                     // the registry answers unknown_action
  if (PC_ONLY.has(a.type)) return { ok: false, error: 'pc_only' };
  if (FREE.has(a.type)) return { ok: true };
  return guardedIn(store).has(stable(a)) ? { ok: true } : { ok: false, error: 'needs_pc' };
}

/** Would replacing `before` with `after` add a guarded action from a phone? */
function introduces(before, after) {
  const had = guardedIn(before);
  for (const c of guardedIn(after)) if (!had.has(c)) return true;
  return false;
}

/** An app a paired device may start from the app switcher: a favourite or a Deck key's app. */
function remoteMayLaunch(appPath, favorites, store) {
  const p = String(appPath || '').trim().toLowerCase();
  if (!p) return false;
  if (Array.isArray(favorites) && favorites.some((f) => f && String(f.path || '').trim().toLowerCase() === p)) return true;
  const c = canonical({ type: 'openApp', path: appPath });
  return !!c && guardedIn(store).has(c);
}

module.exports = { remoteMayRun, introduces, remoteMayLaunch, FREE, PC_ONLY, guardedIn, canonical };
