'use strict';
// change_setting: the Settings switches Bit may change that no other tool
// covers ("turn off the lyrics", "show the wave under the song", "start the
// ambient scene after 5 minutes"). An allowlist: each name maps to one settings
// field and the exact values it takes; anything else is refused with the list.
// Clock, temperature unit, language and weather city are configure_preferences;
// theme and look are change_theme and customize_appearance.

const ON_OFF = Object.freeze(['on', 'off']);

const PREFS = Object.freeze({
  lyrics: { path: ['mediaLyrics'], values: ON_OFF, def: true, about: 'song lyrics in the Music tile (sends title and artist to LRCLIB)' },
  lyrics_translate: { path: ['lyricsTranslate'], values: ON_OFF, def: false, about: 'translate the lyrics with the AI Bit uses (one request per song)' },
  visualizer: { path: ['mediaVisualizer'], values: ['off', 'minimal', 'wave'], about: 'the sound wave under the song in the Music tile' },
  hardware_temp_unit: { path: ['hwTempUnit'], values: ['auto', 'c', 'f'], about: 'CPU and GPU temperatures; auto follows the weather unit' },
  date_format: { path: ['clockDateFormat'], values: ['full', 'medium', 'short'], about: 'how the clock writes the date' },
  pause_when_idle: { path: ['idleAnimationPause'], values: ON_OFF, def: true, about: 'pause the background animations while nobody uses the PC' },
  startup_logo: { path: ['bootSplash'], values: ON_OFF, def: true, about: 'the Xenon logo while the dashboard loads' },
  ambient: { path: ['ambientMode', 'enabled'], values: ON_OFF, def: true, about: 'the Ambient scene (full-screen clock, music and weather)' },
  ambient_after: { path: ['ambientMode', 'idleMinutes'], values: ['0', '1', '2', '5', '10', '15', '30'], about: 'minutes without use before the Ambient scene opens by itself; 0 never' },
});

const NAMES = Object.freeze(Object.keys(PREFS));

// The stored value as the word Bit sees (true → "on", 5 → "5"); a missing
// switch reads as its default (the same as DEFAULT_HUB_SETTINGS).
function wordOf(pref, stored) {
  if (pref.values === ON_OFF) return (typeof stored === 'boolean' ? stored : pref.def) ? 'on' : 'off';
  return stored == null ? null : String(stored);
}

function storedOf(pref, word) {
  if (pref.values === ON_OFF) return word === 'on';
  return /^\d+$/.test(word) ? Number(word) : word;
}

function read(settings, path) {
  return path.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), settings);
}

function current(settings) {
  const out = {};
  for (const name of NAMES) out[name] = wordOf(PREFS[name], read(settings || {}, PREFS[name].path));
  return out;
}

// → { error } or { name, word }. No setting = a read of all of them.
function plan(args) {
  const a = args || {};
  if (a.setting == null || a.setting === '') return { read: true };
  const name = String(a.setting).toLowerCase();
  const pref = PREFS[name];
  if (!pref) return { error: 'unknown_setting', allowed: NAMES };
  const word = String(a.value == null ? '' : a.value).trim().toLowerCase();
  if (!pref.values.includes(word)) return { error: 'bad_value', setting: name, allowed: pref.values.slice() };
  return { name, word };
}

// Pure: the settings with the change → { patch } (a top-level key to write) or
// { patch: null } when it already has that value.
function apply(settings, p) {
  const pref = PREFS[p.name];
  const [top, sub] = pref.path;
  const before = wordOf(pref, read(settings, pref.path));
  if (before === p.word) return { patch: null, before };
  const value = storedOf(pref, p.word);
  const patch = sub ? { [top]: { ...(settings[top] || {}), [sub]: value } } : { [top]: value };
  return { patch, before };
}

module.exports = { PREFS, NAMES, current, plan, apply };
