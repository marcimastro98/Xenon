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
const { haDomainAllowed } = require('./ai-pc-apps.js');

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
  // A widget's own options: only what it declared, checked by the server.
  'widgetOption', 'widgetOptionList',
  'claudeStop',
  // Performance readouts and captures the phone already shows.
  'perfStats', 'stutterWhy', 'gameSessions', 'gameSessionsCompare', 'perfHud', 'benchmark',
  'powerStatus', 'screenshot', 'screenPin', 'screenColor', 'screenMeasure', 'screenDraw',
  'captureMarker', 'markClips', 'replay', 'gallery', 'galleryList',
]);

// Never from a paired device, even when a Deck key holds them.
const PC_ONLY = new Set(['phoneCall', 'phoneMessage']);

// Bit's tools that act without a Deck action to compare. Asked from a paired
// device they stop here: the routes for them are PC-only (/api/phone/dial,
// /api/phone/send, /ai/pc-run). Every tool that builds a Deck action goes
// through remoteMayRun instead, and open_application through remoteMayLaunch.
const PC_ONLY_TOOLS = new Set(['phone_call', 'phone_message', 'run_pc_command']);

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

// The Smart Home tile sends every switch as homeassistant.toggle, so the service
// alone says nothing: the entity does.
const HA_SWITCH_SERVICES = new Set(['toggle', 'turn_on', 'turn_off']);
// service_data can carry the target too, past the entity checked here.
const HA_TARGET_KEYS = ['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id'];

/**
 * May a paired device call this Home Assistant service from the tile? Lights
 * and comfort yes, as in FREE; locks, alarms, covers, scripts and the like no
 * (ai-pc-apps.js HA_GUARDED), and nothing aimed past the entity it named.
 */
function remoteMayCallHa(domain, service, entityId, data) {
  const d = String(domain || '').trim().toLowerCase();
  const entity = String(entityId || '').trim();
  if (entity && !haDomainAllowed(entity)) return false;
  if (data && typeof data === 'object' && HA_TARGET_KEYS.some((k) => Object.hasOwn(data, k))) return false;
  if (d === 'homeassistant') return !!entity && HA_SWITCH_SERVICES.has(String(service || '').trim().toLowerCase());
  return haDomainAllowed(d);
}

/**
 * A widget's permissions after a save from a paired device. A phone may take a
 * permission away, never give one: an approved widget runs on the PC's dashboard,
 * where its calls come from loopback and the limits above no longer apply. So
 * only grants the PC already holds survive, each exactly as the PC saved it.
 */
function keepGrants(before, incoming) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const saved = (before && before.grants && typeof before.grants === 'object') ? before.grants : {};
  const asked = (incoming.grants && typeof incoming.grants === 'object') ? incoming.grants : {};
  const grants = {};
  for (const id of Object.keys(asked)) {
    if (Object.hasOwn(saved, id)) grants[id] = saved[id];
  }
  return { ...incoming, grants };
}

module.exports = {
  remoteMayRun, introduces, remoteMayLaunch, remoteMayCallHa, keepGrants,
  FREE, PC_ONLY, PC_ONLY_TOOLS, guardedIn, canonical,
};
