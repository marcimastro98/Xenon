'use strict';
// The Xenon menu's content (plan §20): one description of the seven sections,
// read by both places that show the menu (over the main screen, /menu, and the
// dashboard panel), so neither can have a row the other lacks. Pure: server.js
// gathers the state, this turns it into rows; js/xenon-menu.js draws them.
//
// A row is { kind, id, label, ... }. Texts are { key, vars? } (an i18n key),
// { text } (a name the user chose) or a list of those, shown joined by commas. Every change a row makes is an `act`:
//   { run: <Deck action> }   POST /actions/run, the capability validates it
//   { open: <verb> }         gallery, settings:<cat>, dashboard, bit
// Kinds: tile, status, toggle, choice, widget, pages, key, mode, button, add.
// Nothing here carries a path, a window title or a file name.

const LayersModel = require('./js/layers-model.js');
const DeckShortcuts = require('./js/deck-shortcuts.js');
const { SECTIONS } = require('./screen-menu.js');

const k = (key, vars) => (vars ? { key, vars } : { key });
const run = (action) => ({ run: action });
const open = (verb) => ({ open: verb });
const cornerKey = (corner) => k('xmenu_corner_' + corner.replace('-', '_'));
const comboText = (combo) => (combo && combo !== 'off' ? DeckShortcuts.formatShortcut(combo) : '');

// The keys shown on the "Now" tiles: a built-in one, else a Deck key whose
// only step does the same thing.
function deckComboFor(deck, type, test) {
  const hit = (deck || []).find((s) => s.does && s.does.type === type && (!test || test(s.does)));
  return hit ? hit.combo : '';
}

function nowSection(st) {
  const p = st.probes || {};
  const rows = [];
  const tile = (id, icon, label, act, combo) => rows.push({ kind: 'tile', id, icon, label: k(label), act, combo: comboText(combo), closes: true });
  if (p.capture) {
    tile('shot', 'camera', 'xmenu_shot', run({ type: 'screenshot', target: 'screen', mode: 'take' }),
      deckComboFor(st.deck, 'screenshot', (d) => d.mode !== 'reveal'));
    tile('area', 'area', 'xmenu_area', run({ type: 'screenshot', target: 'region', mode: 'take' }), '');
  }
  if (p.captureVideo) {
    tile('record', 'record', 'xmenu_record', run({ type: 'record', target: 'screen', audio: 'sound', mode: 'toggle' }),
      deckComboFor(st.deck, 'record', (d) => d.mode !== 'reveal'));
  }
  if (p.captureReplay && st.replay && st.replay.enabled) {
    tile('replay', 'replay', 'xmenu_replay_save', run({ type: 'replay', mode: 'save' }), st.keys.replay);
  }
  if (p.capture) rows.push({ kind: 'tile', id: 'gallery', icon: 'gallery', label: k('xmenu_gallery'), act: open('gallery'), combo: comboText(deckComboFor(st.deck, 'gallery')), closes: true });
  if (p.layers) {
    const perf = perfWidget(st.layers);
    // One meaning per label: with the HUD placed the tile shows and hides the
    // overlay (its shortcut's job), without it it puts the HUD there.
    tile('hud', 'gauge', perf ? 'xmenu_key_overlay' : 'xmenu_hud', perf ? run({ type: 'layersToggle', mode: 'toggle', surface: 'overlay' })
      : run({ type: 'layerPlace', widget: 'perf', surface: 'overlay', position: 'top-left', size: 'small' }), perf ? st.keys.overlay : '');
  }
  rows.push(...statusRows(st), ...powerRows(st));
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

function statusRows(st) {
  const p = st.probes || {};
  const rows = [];
  if (p.captureReplay && st.replay) {
    const r = st.replay;
    rows.push({
      kind: 'status', id: 'replayState', label: k('xmenu_replay'),
      value: !r.enabled ? k('xmenu_off') : r.waiting ? k('xmenu_replay_waiting') : k('xmenu_replay_on', { time: secondsText(r.seconds) }),
      tone: r.enabled ? (r.error ? 'warn' : 'on') : 'off',
    });
  }
  if (p.layers) {
    const perf = perfWidget(st.layers);
    const shown = perf && LayersModel.surfaceShown(st.layers, 'overlay');
    rows.push({ kind: 'status', id: 'hudState', label: k('xmenu_hud'), value: shown ? k('xmenu_hud_on') : k('xmenu_hud_off'), tone: shown ? 'on' : 'off' });
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

function secondsText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function perfWidget(layers) {
  return layers.widgets.find((w) => w.kind === 'tile' && w.widget === 'perf' && w.surface === 'overlay') || null;
}

// The corner a widget sits in, read from its box.
function cornerOf(rect) {
  const v = rect.y + rect.h / 2 < 0.5 ? 'top' : 'bottom';
  const h = rect.x + rect.w / 2 < 0.5 ? 'left' : 'right';
  return v + '-' + h;
}

const ANCHOR_CORNERS = Object.freeze({ tr: 'top-right', tl: 'top-left', br: 'bottom-right', bl: 'bottom-left' });

// Where a widget is: an attached one sits on its app's window, so its box on the
// screen says nothing; the app's name and the corner do.
function placeOf(w) {
  if (w.surface === 'anchor' && w.anchor) {
    return [k('xmenu_surface_anchor'), { text: w.anchor.app }, cornerKey(ANCHOR_CORNERS[w.anchor.corner] || 'top-right')];
  }
  return [k('xmenu_surface_' + w.surface), cornerKey(cornerOf(w.rect))];
}

function widgetName(w, packages) {
  if (w.kind === 'sdk') return { text: ((packages || []).find((p) => p.id === w.pkg) || {}).name || w.pkg };
  return k('layout_widget_' + w.widget);
}

function widgetsSection(st) {
  if (!(st.probes || {}).layers) return [{ kind: 'status', id: 'noLayers', label: k('xmenu_widgets_none'), value: k('xmenu_needs_app') }];
  const L = st.layers;
  const rows = [{ kind: 'add', id: 'add', label: k('xmenu_add'), choices: addChoices(st) }];
  if (L.pages.length > 1) {
    rows.push({
      kind: 'pages', id: 'pages', label: k('xmenu_pages'),
      options: L.pages.map((pg, i) => ({ value: pg.id, label: pg.name ? { text: pg.name } : k('layer_page_n', { n: i + 1 }), act: run({ type: 'layerPage', page: pg.id }) })),
      value: L.page,
    });
  }
  const shown = L.pages.length > 1 ? L.widgets.filter((w) => !w.page || w.page === L.page) : L.widgets;
  for (const w of shown) {
    if (w.group && !w.active) continue;
    rows.push({
      kind: 'widget', id: w.id, label: widgetName(w, st.packages),
      value: placeOf(w).concat(w.show === 'always' ? [] : [k('xmenu_when_' + w.show)]),
      act: run({ type: 'layerRemove', target: w.id }),
    });
  }
  if (L.widgets.length) {
    rows.push({ kind: 'toggle', id: 'shown', label: k('xmenu_widgets_shown'), on: L.enabled && LayersModel.surfaceShown(L, 'all'),
      acts: { on: run({ type: 'layersToggle', mode: 'on', surface: 'all' }), off: run({ type: 'layersToggle', mode: 'off', surface: 'all' }) } });
    rows.push({ kind: 'button', id: 'edit', label: k('xmenu_edit'), act: run({ type: 'layersEdit', mode: 'on' }), closes: true });
  }
  return rows;
}

// Every tile and installed widget, the same list as edit mode's "Add".
function addChoices(st) {
  const tiles = (st.tiles || []).map((id) => ({ value: id, label: k('layout_widget_' + id) }));
  const pkgs = (st.packages || []).map((p) => ({ value: p.id, label: { text: p.name } }));
  return tiles.concat(pkgs).map((c) => ({ ...c, act: run({ type: 'layerPlace', widget: c.value, surface: 'desktop', position: 'top-right', size: 'medium' }) }));
}

function overlaySection(st) {
  if (!(st.probes || {}).layers) return [{ kind: 'status', id: 'noLayers', label: k('xmenu_hud'), value: k('xmenu_needs_app') }];
  const perf = perfWidget(st.layers);
  const rows = [{
    kind: 'toggle', id: 'hud', label: k('xmenu_hud'), sub: k('xmenu_hud_sub'), on: !!perf,
    acts: perf ? { off: run({ type: 'layerRemove', target: perf.id }) }
      : { on: run({ type: 'layerPlace', widget: 'perf', surface: 'overlay', position: 'top-left', size: 'small' }) },
  }];
  if (!perf) return rows;
  rows.push({
    kind: 'choice', id: 'corner', label: k('xmenu_where'), value: cornerOf(perf.rect),
    options: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((c) => ({
      value: c, label: cornerKey(c), act: run({ type: 'layerMove', target: perf.id, position: c }),
    })),
  });
  rows.push({
    kind: 'choice', id: 'when', label: k('xmenu_when'), value: perf.show === 'gaming' ? 'gaming' : 'always',
    options: ['gaming', 'always'].map((v) => ({ value: v, label: k('xmenu_when_' + v), act: run({ type: 'layerMove', target: perf.id, show: v }) })),
  });
  return rows;
}

function captureSection(st) {
  const p = st.probes || {};
  if (!p.capture && !p.captureVideo) return [{ kind: 'status', id: 'noCapture', label: k('xmenu_sec_capture'), value: k('xmenu_needs_engine') }];
  const c = st.capture || {};
  const rows = [];
  if (p.captureVideo) {
    rows.push({ kind: 'status', id: 'video', label: k('xmenu_video'),
      value: [k('xmenu_fps', { n: c.fps || 60 }), k('xmenu_quality_' + (c.quality || 'normal')), k(c.folder ? 'xmenu_folder_chosen' : 'xmenu_folder_video')] });
  }
  if (p.captureReplay) {
    rows.push({ kind: 'toggle', id: 'replayOn', label: k('xmenu_replay'),
      sub: [k('xmenu_keeps', { time: secondsText(c.replaySeconds) }), k('xmenu_when_' + (c.replayWhen === 'always' ? 'always' : 'gaming'))], on: c.replay === true,
      acts: { on: run({ type: 'replayOptions', enabled: 'on' }), off: run({ type: 'replayOptions', enabled: 'off' }) } });
  }
  if (p.captureBadge) {
    rows.push({ kind: 'toggle', id: 'pill', label: k('xmenu_pill'), on: c.badge !== false,
      acts: { on: run({ type: 'recordingOptions', pill: 'show' }), off: run({ type: 'recordingOptions', pill: 'hide' }) } });
  }
  if (p.captureVideo) {
    rows.push({ kind: 'status', id: 'limit', label: k('xmenu_limit'), value: c.maxGB ? k('xmenu_limit_gb', { gb: c.maxGB }) : k('xmenu_limit_none') });
  }
  rows.push({ kind: 'button', id: 'gallery', label: k('xmenu_gallery_open'), act: open('gallery'), primary: true, closes: true });
  rows.push({ kind: 'button', id: 'all', label: k('xmenu_all_options'), act: open('settings:capture'), closes: true });
  return rows;
}

const KEY_NOTES = Object.freeze({
  listening: ['xmenu_key_ok', 'on'], off: ['xmenu_key_idle', 'off'], starting: ['xmenu_key_idle', 'off'],
  taken: ['xmenu_key_taken', 'warn'], full: ['xmenu_key_full', 'warn'], duplicate: ['xmenu_key_dup', 'warn'],
  clash: ['xmenu_key_dup', 'warn'], helper: ['xmenu_key_helper', 'warn'], error: ['xmenu_key_error', 'warn'],
});

function keyRow(id, label, combo, state, extra) {
  const owner = combo && combo !== 'off' ? DeckShortcuts.reservedBy(combo) : '';
  const [note, tone] = owner ? ['deck_shortcut_res_' + owner, 'warn'] : (KEY_NOTES[state] || KEY_NOTES.off);
  return { kind: 'key', id, label, combo: comboText(combo), note: combo && combo !== 'off' ? k(note) : k('xmenu_key_none'), tone, ...extra };
}

function keysSection(st) {
  const s = st.keyStates || {};
  const L = st.layers;
  const rows = [];
  if ((st.probes || {}).layers) {
    rows.push(keyRow('menuKey', k('xmenu_key_menu'), L.menuKey, s.menu, { record: { action: { type: 'layersShortcut', key: 'menu' }, param: 'combo' } }));
    rows.push(keyRow('overlayKey', k('xmenu_key_overlay'), L.overlayKey, s.overlay, { record: { action: { type: 'layersShortcut', key: 'overlay' }, param: 'combo' } }));
    // A game controller opens the menu too (View + Menu held, layers/pad.rs).
    if ((st.probes || {}).menuPad) {
      rows.push({ kind: 'toggle', id: 'menuPad', label: k('xmenu_key_pad'), sub: k('xmenu_key_pad_sub'), on: L.menuPad !== false,
        acts: { on: run({ type: 'layersShortcut', key: 'pad', combo: 'on' }), off: run({ type: 'layersShortcut', key: 'pad', combo: 'off' }) } });
    }
  }
  if ((st.probes || {}).captureReplay) {
    rows.push(keyRow('replayKey', k('xmenu_key_replay'), (st.capture || {}).replayKey, s.replay, { record: { action: { type: 'replayOptions' }, param: 'shortcut' } }));
  }
  for (const d of st.deck || []) {
    rows.push(keyRow('deck-' + d.keyId, d.title ? k('xmenu_key_deck', { name: d.title }) : k('xmenu_key_deck_untitled'), d.combo, d.state,
      { record: { action: { type: 'deckShortcut', keyId: d.keyId }, param: 'shortcut' } }));
  }
  rows.push({ kind: 'button', id: 'newKey', label: k('xmenu_key_new'), sub: k('xmenu_key_new_sub'), act: open('dashboard'), closes: true });
  return rows;
}

function lookSection(st) {
  const rows = [{ kind: 'button', id: 'theme', label: k('xmenu_theme'), sub: k('xmenu_theme_sub'), act: open('settings:appearance'), closes: true }];
  if ((st.probes || {}).scene) {
    const sc = st.scene || {};
    rows.push({ kind: 'toggle', id: 'wallpaper', label: k('xmenu_wallpaper'), sub: k('xmenu_wallpaper_sub'), on: sc.wallpaper === true,
      acts: { on: run({ type: 'desktopWallpaper', mode: 'on' }), off: run({ type: 'desktopWallpaper', mode: 'off' }) } });
    rows.push({
      kind: 'choice', id: 'saver', label: k('xmenu_saver'), sub: k('xmenu_saver_sub'), value: String(sc.saverMinutes || 0),
      options: savers(sc.saverMinutes).map((m) => ({ value: m, label: m === '0' ? k('xmenu_never') : k('xmenu_minutes', { n: Number(m) }),
        act: run({ type: 'desktopSaver', minutes: m }) })),
    });
  }
  return rows;
}

// Never, 5, 15, 30 minutes, plus the one chosen in Settings if it is another.
function savers(current) {
  const list = ['0', '5', '15', '30'];
  const cur = String(current || 0);
  return list.includes(cur) ? list : list.concat(cur);
}

function modeSection(st) {
  const rows = [];
  if ((st.probes || {}).usageMode) {
    const value = st.usageMode || 'dashboard';
    rows.push({
      kind: 'mode', id: 'mode', label: k('xmenu_mode'), value,
      options: ['dashboard', 'widgets', 'both'].map((m) => ({ value: m, label: k('xmenu_mode_' + m), sub: k('xmenu_mode_' + m + '_sub'),
        act: run({ type: 'usageMode', mode: m }) })),
    });
    if (value === 'widgets') {
      rows.push({ kind: 'toggle', id: 'alerts', label: k('xmenu_alerts'), on: st.alertsOn !== false,
        acts: { on: run({ type: 'screenAlerts', alerts: 'on' }), off: run({ type: 'screenAlerts', alerts: 'off' }) } });
    }
  }
  rows.push({ kind: 'button', id: 'dashboard', label: k('xmenu_open_dashboard'), act: open('dashboard'), primary: true, closes: true, screenOnly: true });
  return rows;
}

const BUILDERS = Object.freeze({
  now: nowSection, widgets: widgetsSection, overlay: overlaySection, capture: captureSection,
  keys: keysSection, look: lookSection, mode: modeSection,
});
const ICONS = Object.freeze({ now: 'bolt', widgets: 'widgets', overlay: 'gauge', capture: 'camera', keys: 'keyboard', look: 'palette', mode: 'screens' });

// → { menuKey, sections: [{ id, icon, title, sub, rows }] }
function compose(state) {
  const st = { ...state, layers: LayersModel.normalize(state && state.layers), keys: (state && state.keys) || {} };
  return {
    menuKey: comboText(st.keys.menu),
    sections: SECTIONS.map((id) => ({
      id, icon: ICONS[id], title: k('xmenu_sec_' + id), sub: k('xmenu_sec_' + id + '_sub'), rows: BUILDERS[id](st),
    })),
  };
}

module.exports = { compose, cornerOf, secondsText, agoText, deckComboFor };
