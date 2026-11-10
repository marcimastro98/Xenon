'use strict';
// Game mode, the "not a game" list and the sensor history, from a Deck key, Bit
// or an SDK widget: the same switches and list as Settings, Performance.
//
//   gameMode     hubSettings.gameMode (true by default): animated effects pause
//                while a game is in front.
//   gameIgnore   hubSettings.gameIgnore (js/game-ignore.js): apps the detector
//                must never treat as a game. "current" rules out the app that
//                counts as a game right now, the one-tap answer to a false
//                positive.
//
// deps (injected):
//   settingKeys { get(key), update(key, change) → Promise<stored value> }
//            update runs `change` inside the settings lock
//   game     () → bare process name of the game running now, or ''
//   handToDashboard(action) → Promise<bool>  offers a step to this PC's
//            dashboard or "widgets only" driver page; true when one took it

const GameIgnore = require('../js/game-ignore.js');
const SensorHistory = require('../js/sensor-history.js');

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

// The app the action is about: the game in front for "current", else `name`.
function targetName(d, action) {
  return action.mode === 'current' ? currentGame(d) : GameIgnore.normalizeGameIgnoreName(action.name);
}

async function editIgnore(d, action) {
  if (!usable(d && d.settingKeys)) return { ok: false, error: 'unavailable' };
  const a = action || {};
  if (!IGNORE_MODES.includes(a.mode)) return { ok: false, error: 'bad_mode', choices: IGNORE_MODES.slice() };
  const read = () => GameIgnore.normalizeGameIgnore(d.settingKeys.get('gameIgnore'));
  if (a.mode === 'list') return { ok: true, list: read(), current: currentGame(d) };
  const name = targetName(d, a);
  if (!name) return { ok: false, error: a.mode === 'current' ? 'no_game' : 'bad_app_name' };
  const adding = a.mode !== 'remove';
  if (adding && !read().includes(name) && read().length >= GameIgnore.GAME_IGNORE_MAX) {
    return { ok: false, error: 'list_full', max: GameIgnore.GAME_IGNORE_MAX };
  }
  const saved = await d.settingKeys.update('gameIgnore', (cur) => {
    const list = GameIgnore.normalizeGameIgnore(cur);
    if (!adding) return list.filter((n) => n !== name);
    return list.includes(name) ? list : [...list, name];
  });
  return { ok: true, name, [adding ? 'added' : 'removed']: true, list: GameIgnore.normalizeGameIgnore(saved) };
}

// The sensor history switch and interval (hubSettings.sensorHistory,
// js/sensor-history.js); guardian.js reads both on its next tick.
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

// Performance Mode lives in the page that runs the session (js/performance.js),
// so a press from a Stream Deck, a widget or a phone is offered to it here.
async function perfMode(d, action) {
  const mode = action && action.mode;
  if (!SWITCH.includes(mode)) return { ok: false, error: 'bad_mode', choices: SWITCH.slice() };
  if (!d || typeof d.handToDashboard !== 'function') return { ok: false, error: 'unavailable' };
  return (await d.handToDashboard({ type: 'perfMode', mode })) ? { ok: true } : { ok: false, error: 'no_dashboard' };
}

module.exports = { SWITCH, IGNORE_MODES, setGameMode, editIgnore, setSensorHistory, perfMode };
