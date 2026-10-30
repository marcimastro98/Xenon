'use strict';
// Recording options (Settings → Recording, the AI's set_recording_options):
// frame rate, size, quality, the "recording" pill, a space limit and where
// Xenon saves: recordings, screenshots and benchmark files each have a folder.
// Instant Replay (replay.js) lives here too: on or off (off by default: it is
// a recording that never stops), how much it keeps, when it runs and its sound.
// Stored in hubSettings.capture and SERVER-OWNED like fileTransfer: the
// folders are on this PC and the settings blob reaches every paired phone, so
// they are blanked on the wire (folderSet etc. say whether one is chosen),
// kept by the POST /settings keep-prev guard, and a backup import never brings
// another PC's folders here. The only writers are /capture/settings (loopback
// only) and the recordingOptions capability, both through update() in server.js.

const DeckShortcuts = require('./js/deck-shortcuts.js');

const FPS = Object.freeze([60, 30]);
// 0 keeps the size of the screen or window; the others bring the short side down.
const HEIGHTS = Object.freeze([0, 720, 1080, 1440]);
const QUALITIES = Object.freeze(['normal', 'high', 'small']);
// GB the recordings may take before the oldest are deleted; 0 = no limit.
const LIMITS_GB = Object.freeze([0, 10, 25, 50, 100]);
const FOLDER_MAX = 512;
// Instant Replay: how much it keeps, in seconds. Any whole number in range,
// not only the presets the pane offers; the real limit is the disk.
const REPLAY_MIN_S = 15;
const REPLAY_MAX_S = 3600;
// 'gaming': only while a game is in front (like Game Bar); 'always': the desktop too.
const REPLAY_WHEN = Object.freeze(['gaming', 'always']);
// As for a recording: the PC's sound, plus the microphone, or none.
const REPLAY_AUDIO = Object.freeze(['sound', 'sound_mic', 'silent']);
// Clips the replay saves by itself (capture-autoclips.js): around each moment
// the user marks, around every stutter too, or never.
const REPLAY_CLIPS = Object.freeze(['marks', 'all', 'off']);
// The ready-made shortcut that saves the replay (ShadowPlay's is Alt+F10, which
// stays NVIDIA's). Registered only while the replay is on; 'off' frees it.
const REPLAY_KEY = 'ctrl+shift+f10';
// What is saved → the settings key of its folder ('' = the default folder).
// `buglogs` is not where Xenon saves: it is the folder the bug report reads its logs from.
const FOLDERS = Object.freeze({
  recording: 'folder', screenshot: 'shotFolder', benchmark: 'benchFolder', bugreport: 'bugFolder', buglogs: 'bugLogs',
});
const FOLDER_KEYS = Object.freeze(Object.values(FOLDERS));

const DEFAULTS = Object.freeze({
  fps: 60, height: 0, quality: 'normal', badge: true, autoMarks: true, maxGB: 0, folder: '', shotFolder: '', benchFolder: '', bugFolder: '', bugLogs: '',
  replay: false, replaySeconds: 30, replayWhen: 'gaming', replayAudio: 'sound', replayKey: REPLAY_KEY, replayClips: 'marks',
});

const folderOf = (v, key) => (typeof v[key] === 'string' ? v[key].slice(0, FOLDER_MAX) : DEFAULTS[key]);

const pick = (list, v, d) => (list.includes(v) ? v : d);

const replaySeconds = v => (Number.isInteger(v) && v >= REPLAY_MIN_S && v <= REPLAY_MAX_S ? v : null);

// A shortcut asked for → { key } ('off', or the canonical combo; '' = back to
// the default), or { bad } / { owner } when it cannot be one. The same rules as
// a Deck key's shortcut (js/deck-shortcuts.js).
function replayKeyOf(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === '') return { key: REPLAY_KEY };
  if (s === 'off' || s === 'none') return { key: 'off' };
  const key = DeckShortcuts.normalizeShortcut(s);
  if (!key) return { bad: true };
  const owner = DeckShortcuts.reservedBy(key);
  return owner ? { owner } : { key };
}

function normalizeCaptureSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    fps: pick(FPS, Number(v.fps), DEFAULTS.fps),
    height: pick(HEIGHTS, Number(v.height), DEFAULTS.height),
    quality: pick(QUALITIES, v.quality, DEFAULTS.quality),
    badge: v.badge !== false,
    autoMarks: v.autoMarks !== false,
    maxGB: pick(LIMITS_GB, Number(v.maxGB), DEFAULTS.maxGB),
    // Kept verbatim; checked against the disk where they are chosen and again
    // at every save (a drive can be unplugged in between).
    folder: folderOf(v, 'folder'),
    shotFolder: folderOf(v, 'shotFolder'),
    benchFolder: folderOf(v, 'benchFolder'),
    bugFolder: folderOf(v, 'bugFolder'),
    bugLogs: folderOf(v, 'bugLogs'),
    replay: v.replay === true,
    replaySeconds: replaySeconds(Number(v.replaySeconds)) || DEFAULTS.replaySeconds,
    replayWhen: pick(REPLAY_WHEN, v.replayWhen, DEFAULTS.replayWhen),
    replayAudio: pick(REPLAY_AUDIO, v.replayAudio, DEFAULTS.replayAudio),
    replayClips: pick(REPLAY_CLIPS, v.replayClips, DEFAULTS.replayClips),
    replayKey: (typeof v.replayKey === 'string' && replayKeyOf(v.replayKey).key) || DEFAULTS.replayKey,
  };
}

// A change asked for by the Settings pane or the AI. Values outside the lists
// are refused by name rather than silently replaced, so the caller can say so.
// The folders are not taken here: they are set only by the folder dialog (or reset).
// `owner` names who already uses a refused shortcut (NVIDIA, Game Bar...).
function applyCaptureChange(current, change) {
  const next = normalizeCaptureSettings(current);
  const c = change && typeof change === 'object' ? change : {};
  const bad = [];
  let owner = '';
  const take = (key, list, cast) => {
    if (c[key] == null) return;
    const v = cast(c[key]);
    if (list.includes(v)) next[key] = v;
    else bad.push(key);
  };
  take('fps', FPS, Number);
  take('height', HEIGHTS, Number);
  take('quality', QUALITIES, String);
  take('maxGB', LIMITS_GB, Number);
  take('replayWhen', REPLAY_WHEN, String);
  take('replayAudio', REPLAY_AUDIO, String);
  take('replayClips', REPLAY_CLIPS, String);
  for (const key of ['badge', 'autoMarks', 'replay']) {
    if (c[key] == null) continue;
    if (typeof c[key] === 'boolean') next[key] = c[key];
    else bad.push(key);
  }
  if (c.replaySeconds != null) {
    const n = replaySeconds(Number(c.replaySeconds));
    if (n) next.replaySeconds = n;
    else bad.push('replaySeconds');
  }
  if (c.replayKey != null) {
    const k = typeof c.replayKey === 'string' ? replayKeyOf(c.replayKey) : { bad: true };
    if (k.key) next.replayKey = k.key;
    else { bad.push('replayKey'); owner = k.owner || ''; }
  }
  return { next, bad, owner };
}

function redactCaptureFolder(settings) {
  if (!settings || !settings.capture || typeof settings.capture !== 'object') return settings;
  const c = { ...settings.capture };
  for (const key of FOLDER_KEYS) {
    c[key + 'Set'] = !!c[key];
    c[key] = '';
  }
  return { ...settings, capture: c };
}

// Backup import: the options come from the backup, the folders stay this PC's.
function preserveCaptureFolder(incoming, prev) {
  if (!incoming || !incoming.capture || typeof incoming.capture !== 'object') return incoming;
  const old = (prev && prev.capture && typeof prev.capture === 'object') ? prev.capture : {};
  const kept = {};
  for (const key of FOLDER_KEYS) kept[key] = typeof old[key] === 'string' ? old[key] : '';
  return { ...incoming, capture: { ...incoming.capture, ...kept } };
}

module.exports = {
  FPS, HEIGHTS, QUALITIES, LIMITS_GB, DEFAULTS, FOLDERS, FOLDER_KEYS,
  REPLAY_MIN_S, REPLAY_MAX_S, REPLAY_WHEN, REPLAY_AUDIO, REPLAY_CLIPS, REPLAY_KEY,
  replayKeyOf, normalizeCaptureSettings, applyCaptureChange, redactCaptureFolder, preserveCaptureFolder,
};
