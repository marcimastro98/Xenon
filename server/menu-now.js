'use strict';
// The "Now" section of the Xenon menu: every function, by group, then how things
// stand. The functions come from server/menu-functions.js.

const LayersModel = require('./js/layers-model.js');
const { FUNCTIONS, GROUPS, subKey, available, keyFor } = require('./menu-functions.js');
const { HUD_PLACE, AUDIO_LABELS, k, run, open, heading, comboText, secondsText, perfWidget } = require('./menu-rows.js');

function functionTile(st, fn) {
  const hit = keyFor(st.deck, fn);
  const combo = fn.ownKey ? st.keys.replay : hit && hit.combo;
  const tile = { kind: 'tile', id: fn.id, icon: fn.icon, label: k(fn.label), combo: comboText(combo) };
  const act = fn.action ? run(fn.action) : open(fn.open);
  if (TILE_STATE[fn.id]) return TILE_STATE[fn.id](st, tile, act);
  return { ...tile, sub: k(subKey(fn)), act, closes: fn.inPlace !== true, ...(fn.returns ? { returns: true } : {}) };
}

// One name, three meanings, so the line says which one holds right now: with the
// replay running a mark saves a clip, in a recording it is a spot to come back to,
// and with neither there is nothing to land on, so the tile leads to the replay.
function markerTile(st, tile, act) {
  const replaying = !!(st.replay && st.replay.on);
  if (!replaying && st.recording !== true) return { ...tile, sub: k('xmenu_sub_marker_idle'), act: { section: 'capture' }, closes: false };
  const saves = replaying && (st.capture || {}).replayClips !== 'off';
  return { ...tile, sub: k(saves ? 'xmenu_sub_marker_clip' : 'xmenu_sub_marker'), act, closes: false };
}

// Registra says what it will take when that is not the usual, so the choice is
// true at the moment of pressing.
function recordTile(st, tile, act) {
  const c = st.capture || {};
  const sub = [];
  if (c.recordAudio && c.recordAudio !== 'sound') sub.push(k(AUDIO_LABELS[c.recordAudio]));
  if ((st.probes || {}).captureWebcam && c.recordWebcam && c.recordWebcam !== 'off') sub.push(k('deck_param_webcam'), k('deck_opt_cam_' + c.recordWebcam));
  return { ...tile, sub: sub.length ? sub : k('xmenu_sub_record'), act, closes: true };
}

// Off, there is nothing to open: the tile leads to where it is turned on.
function companionTile(st, tile, act) {
  if (st.companionOn !== true) return { ...tile, sub: k('xmenu_sub_companion_off'), act: open('settings:ai'), closes: true };
  return { ...tile, sub: k('xmenu_sub_companion'), act, closes: true };
}

function dndTile(st, tile, act) {
  return { ...tile, sub: k(st.quiet === 'always' ? 'xmenu_sub_dnd_on' : 'xmenu_sub_dnd'), act, closes: false };
}

// Something this PC got from the Store has a newer version there: the tile says so
// in words, and leads to the Installed page, where each one has its button. The
// count is the Store's own (menu-store.js); unknown (null) reads as none.
function storeTile(st, tile, act) {
  const n = Number.isInteger(st.storeUpdates) && st.storeUpdates > 0 ? st.storeUpdates : 0;
  if (!n) return { ...tile, sub: k('xmenu_sub_store'), act, closes: true };
  const sub = n === 1 ? k('installed_update_one') : k('installed_update_n', { n });
  return { ...tile, sub, updates: n, act: open('store:__installed'), closes: true };
}

const TILE_STATE = Object.freeze({ marker: markerTile, record: recordTile, companion: companionTile, dnd: dndTile, store: storeTile });

// One meaning per label: with the HUD placed the tile shows and hides the
// overlay (its shortcut's job), without it it puts the HUD there.
function hudTile(st) {
  const perf = perfWidget(st.layers);
  return {
    kind: 'tile', id: 'hud', icon: 'gauge', label: k(perf ? 'xmenu_key_overlay' : 'xmenu_hud'), sub: k('xmenu_sub_hud'),
    act: run(perf ? { type: 'layersToggle', mode: 'toggle', surface: 'overlay' } : HUD_PLACE),
    combo: comboText(perf ? st.keys.overlay : ''), closes: true,
  };
}

function shown(st, fn) {
  if (!available(fn, st.probes)) return false;
  return fn.id !== 'replay' || !!(st.replay && st.replay.enabled);
}

function groupTiles(st, group) {
  const tiles = FUNCTIONS.filter((fn) => fn.group === group && shown(st, fn)).map((fn) => functionTile(st, fn));
  if (group === 'perf' && (st.probes || {}).layers) tiles.unshift(hudTile(st));
  // Whoever chose "widgets only" chose no dashboard: nothing here leads to it.
  if (group === 'xenon' && st.usageMode !== 'widgets') {
    tiles.unshift({ kind: 'tile', id: 'dashboard', icon: 'screens', label: k('xmenu_tile_dashboard'), sub: k('xmenu_sub_dashboard'), act: open('dashboard'), combo: '', closes: true, screenOnly: true });
  }
  return tiles;
}

function nowSection(st) {
  const rows = [];
  for (const g of GROUPS) {
    const tiles = groupTiles(st, g.id);
    if (tiles.length) rows.push(heading(g.id, g.label), ...tiles);
  }
  const status = [...statusRows(st), ...powerRows(st)];
  if (status.length) rows.push(heading('status', 'xmenu_group_status'), ...status);
  return rows;
}

// The PC's own battery and the system power mode (server/power/): a status
// line on a laptop, the mode as a choice where the OS lets Xenon change it.
function powerRows(st) {
  const pw = st.power;
  if (!pw) return [];
  const rows = [];
  const b = pw.battery;
  if (b) {
    const value = [k('xmenu_battery_pct', { n: b.percent })];
    if (b.charging) value.push(k('xmenu_battery_charging'));
    else if (b.minutesLeft) value.push(k('xmenu_battery_left', { time: Math.floor(b.minutesLeft / 60) + ':' + String(b.minutesLeft % 60).padStart(2, '0') }));
    rows.push({ kind: 'status', id: 'battery', label: k('xmenu_battery'), value, tone: !b.plugged && b.percent <= 20 ? 'warn' : 'on' });
  }
  if ((st.probes || {}).powerMode && pw.canSet) {
    rows.push({
      kind: 'choice', id: 'power', label: k('deck_act_powerMode'), value: pw.mode || '',
      options: pw.modes.map((m) => ({ value: m, label: k('power_mode_' + m), act: run({ type: 'powerMode', mode: m }) })),
    });
  }
  return rows;
}

function replayStatus(r) {
  const row = {
    kind: 'status', id: 'replayState', label: k('xmenu_replay'), sub: k('xmenu_sub_replay_on'),
    value: !r.enabled ? k('xmenu_off') : r.waiting ? k('xmenu_replay_waiting') : k('xmenu_replay_on', { time: secondsText(r.seconds) }),
    tone: r.enabled ? (r.error ? 'warn' : 'on') : 'off',
  };
  // Off, there is no tile to save with: the way to turn it on is right here.
  return r.enabled ? row : { ...row, act: run({ type: 'replayOptions', enabled: 'on' }), button: k('xmenu_turn_on') };
}

function statusRows(st) {
  const p = st.probes || {};
  const rows = [];
  if (p.captureReplay && st.replay) rows.push(replayStatus(st.replay));
  if (p.layers) {
    const on = perfWidget(st.layers) && LayersModel.surfaceShown(st.layers, 'overlay');
    rows.push({ kind: 'status', id: 'hudState', label: k('xmenu_hud'), value: on ? k('xmenu_hud_on') : k('xmenu_hud_off'), tone: on ? 'on' : 'off' });
  }
  if (st.last) {
    rows.push({
      kind: 'status', id: 'last', label: k('xmenu_last'),
      value: [st.last.seconds ? k('xmenu_last_clip', { time: secondsText(st.last.seconds) }) : k('xmenu_last_shot'), agoText(st.now - st.last.createdAt)],
      act: open('gallery'), button: k('xmenu_open'), closes: true,
    });
  }
  return rows;
}

// "just now", "12 min ago", "3 h ago", "2 days ago".
function agoText(ms) {
  const min = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  if (min < 1) return k('xmenu_ago_now');
  if (min < 60) return k('xmenu_ago_min', { n: min });
  if (min < 48 * 60) return k('xmenu_ago_h', { n: Math.floor(min / 60) });
  return k('xmenu_ago_days', { n: Math.floor(min / 1440) });
}

module.exports = { nowSection, agoText };
