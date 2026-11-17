'use strict';
// Game mode, the "not a game" list and the sensor history, from a Deck key, Bit
// or an SDK widget: the same switches and list as Settings, Performance.
//
//   gameMode     hubSettings.gameMode (true by default): animated effects pause
//                while a game is in front.
//   gameIgnore   hubSettings.gameIgnore (js/performance/game-ignore.js): apps the detector
//                must never treat as a game. "current" rules out the app that
//                counts as a game right now, the one-tap answer to a false
//                positive.
//   gameAlways   hubSettings.gameAlways, the opposite list: apps that ARE games
//                although the detector cannot see it (a game in a window that
//                Windows composes like a desktop app). "current" adds the app
//                in front. A name sits on one list at most: adding it to one
//                takes it off the other, so the last word the user said wins.
//
// deps (injected):
//   settingKeys { get(key), update(key, change) → Promise<stored value> }
//            update runs `change` inside the settings lock
//   game     () → bare process name of the game running now, or ''
//   front    () → bare process name of the app in front, or ''
//   neverGame(name) → true for the built-in apps that are never a game (the
//            dashboard's own host, the shell, browsers): not addable as a game
//   handToDashboard(action) → Promise<bool>  offers a step to this PC's
//            dashboard or "widgets only" driver page; true when one took it

const GameIgnore = require('../js/performance/game-ignore.js');
const SensorHistory = require('../js/system/sensor-history.js');

const SWITCH = Object.freeze(['toggle', 'on', 'off']);
const IGNORE_MODES = Object.freeze(['current', 'add', 'remove', 'list']);

function usable(s) {
  return !!(s && typeof s.get === 'function' && typeof s.update === 'function');
}

async function setGameMode(d, action) {
  if (!usable(d && d.settingKeys)) return { ok: false, error: 'unavailable' };
  const mode = action && action.mode;
  if (!SWITCH.includes(mode)) return { ok: false, error: 'bad_mode', choices: SWITCH.slice() };
  const saved = await d.settingKeys.update('gameMode', (cur) => (mode === 'toggle' ? cur === false : mode === 'on'));
  return { ok: true, gameMode: saved !== false };
}

function currentGame(d) {
  try { return GameIgnore.normalizeGameIgnoreName(typeof d.game === 'function' ? d.game() : ''); } catch { return ''; }
}

function frontApp(d) {
  try { return GameIgnore.normalizeGameIgnoreName(typeof d.front === 'function' ? d.front() : ''); } catch { return ''; }
}

function neverGame(d, name) {
  try { return typeof d.neverGame === 'function' && d.neverGame(name) === true; } catch { return false; }
}

// The two lists differ only in which app "current" means, what a full list is
// called and which names they refuse; the writing is the same.
const LISTS = Object.freeze({
  gameIgnore: { other: 'gameAlways', current: currentGame, noCurrent: 'no_game', full: 'list_full' },
  gameAlways: { other: 'gameIgnore', current: frontApp, noCurrent: 'no_app', full: 'games_full', refuse: neverGame },
});

async function editList(d, action, key) {
  if (!usable(d && d.settingKeys)) return { ok: false, error: 'unavailable' };
  const spec = LISTS[key];
  const a = action || {};
  if (!IGNORE_MODES.includes(a.mode)) return { ok: false, error: 'bad_mode', choices: IGNORE_MODES.slice() };
  const read = (k) => GameIgnore.normalizeGameIgnore(d.settingKeys.get(k));
  if (a.mode === 'list') return { ok: true, list: read(key), current: spec.current(d) };
  const name = a.mode === 'current' ? spec.current(d) : GameIgnore.normalizeGameIgnoreName(a.name);
  if (!name) return { ok: false, error: a.mode === 'current' ? spec.noCurrent : 'bad_app_name' };
  const adding = a.mode !== 'remove';
  if (adding && spec.refuse && spec.refuse(d, name)) return { ok: false, error: 'never_a_game', name };
  if (adding && !read(key).includes(name) && read(key).length >= GameIgnore.GAME_IGNORE_MAX) {
    return { ok: false, error: spec.full, max: GameIgnore.GAME_IGNORE_MAX };
  }
  const saved = await d.settingKeys.update(key, (cur) => {
    const list = GameIgnore.normalizeGameIgnore(cur);
    if (!adding) return list.filter((n) => n !== name);
    return list.includes(name) ? list : [...list, name];
  });
  if (adding && read(spec.other).includes(name)) {
    await d.settingKeys.update(spec.other, (cur) => GameIgnore.normalizeGameIgnore(cur).filter((n) => n !== name));
  }
  return { ok: true, name, [adding ? 'added' : 'removed']: true, list: GameIgnore.normalizeGameIgnore(saved) };
}

const editIgnore = (d, action) => editList(d, action, 'gameIgnore');
const editAlways = (d, action) => editList(d, action, 'gameAlways');

// The sensor history switch and interval (hubSettings.sensorHistory,
// js/system/sensor-history.js); guardian.js reads both on its next tick.
async function setSensorHistory(d, action) {
  if (!usable(d && d.settingKeys)) return { ok: false, error: 'unavailable' };
  const a = action || {};
  if (![...SWITCH, 'interval'].includes(a.mode)) return { ok: false, error: 'bad_mode', choices: [...SWITCH, 'interval'] };
  const every = a.every == null || a.every === '' ? null : Number(a.every);
  if (every != null && !SensorHistory.EVERY_MIN_CHOICES.includes(every)) {
    return { ok: false, error: 'bad_every', choices: SensorHistory.EVERY_MIN_CHOICES.slice() };
  }
  if (a.mode === 'interval' && every == null) return { ok: false, error: 'bad_every', choices: SensorHistory.EVERY_MIN_CHOICES.slice() };
  const saved = await d.settingKeys.update('sensorHistory', (raw) => {
    const cur = SensorHistory.normalizeSensorHistory(raw);
    const enabled = a.mode === 'interval' ? cur.enabled : (a.mode === 'toggle' ? !cur.enabled : a.mode === 'on');
    return { enabled, everyMin: every == null ? cur.everyMin : every };
  });
  const now = SensorHistory.normalizeSensorHistory(saved);
  return { ok: true, enabled: now.enabled, everyMin: now.everyMin };
}

// Performance Mode lives in the page that runs the session (js/performance/performance.js),
// so a press from a Stream Deck, a widget or a phone is offered to it here.
async function perfMode(d, action) {
  const mode = action && action.mode;
  if (!SWITCH.includes(mode)) return { ok: false, error: 'bad_mode', choices: SWITCH.slice() };
  if (!d || typeof d.handToDashboard !== 'function') return { ok: false, error: 'unavailable' };
  return (await d.handToDashboard({ type: 'perfMode', mode })) ? { ok: true } : { ok: false, error: 'no_dashboard' };
}

module.exports = { SWITCH, IGNORE_MODES, setGameMode, editIgnore, editAlways, setSensorHistory, perfMode };
