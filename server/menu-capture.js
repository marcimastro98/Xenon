'use strict';
// The "Capture" section of the Xenon menu: only what is chosen at the moment of
// using it. What a recording takes, beside Registra; Instant Replay on or off and
// how much it keeps; where videos and pictures go, changed with the PC's folder
// dialog. Quality, space and automatic clips are set once: they live in
// Settings, and the last row leads there.

const { AUDIO_LABELS, k, run, open, heading, secondsText, choiceRow, toggleRow } = require('./menu-rows.js');

const rec = (change) => ({ type: 'recordingOptions', ...change });
const replay = (change) => ({ type: 'replayOptions', ...change });
const REPLAY_LENGTHS = Object.freeze([30, 60, 120, 300, 600]);
const WEBCAM_CORNERS = Object.freeze(['off', 'tl', 'tr', 'bl', 'br']);

// Only the sounds this PC's engine can take; silence always can.
function audioRow(c, p) {
  const can = { sound: p.captureSound, sound_mic: p.captureMic, silent: true };
  const list = Object.keys(AUDIO_LABELS).filter((v) => can[v]);
  if (list.length < 2) return [];
  const value = list.includes(c.recordAudio) ? c.recordAudio : list[0];
  const options = list.map((v) => [v, k(AUDIO_LABELS[v])]);
  return [choiceRow('recordAudio', k('settings_replay_audio'), value, options, (v) => rec({ audio: v }), k('xmenu_sub_record_audio'))];
}

// A corner changes nothing on the screen, so the row says where it will show.
const webcamLine = (c) => (c.recordWebcam && c.recordWebcam !== 'off' ? 'xmenu_sub_record_webcam_on' : 'xmenu_sub_record_webcam');

function webcamRow(c, p) {
  if (!p.captureWebcam) return [];
  const options = WEBCAM_CORNERS.map((v) => [v, k('deck_opt_cam_' + v)]);
  return [{ ...choiceRow('recordWebcam', k('deck_param_webcam'), c.recordWebcam || 'off', options, (v) => rec({ webcam: v }), k(webcamLine(c))), demo: 'webcam' }];
}

function recordRows(c, p) {
  const rows = [...audioRow(c, p), ...webcamRow(c, p)];
  return rows.length ? [heading('record', 'settings_capture_title'), ...rows] : [];
}

function replayLengths(current) {
  const cur = Math.round(Number(current) || 0);
  const list = !cur || REPLAY_LENGTHS.includes(cur) ? REPLAY_LENGTHS : [...REPLAY_LENGTHS, cur].sort((a, b) => a - b);
  return list.map((s) => [s, { text: secondsText(s) }]);
}

function replayRows(c) {
  const on = c.replay === true;
  const rows = [heading('replay', 'xmenu_replay'), toggleRow('replayOn', k('settings_replay_on'), on, replay({ enabled: 'on' }), replay({ enabled: 'off' }), k('xmenu_sub_replay_on'))];
  if (!on) return rows;
  rows.push(choiceRow('replayLength', k('settings_replay_length'), Math.round(Number(c.replaySeconds) || 0), replayLengths(c.replaySeconds), (v) => replay({ seconds: String(v) }), k('xmenu_sub_replay_length')));
  return rows;
}

// A folder as its last two names ("Videos › Xenon"): enough to know it, never
// the whole path, since the menu also reaches paired phones.
function folderShown(dir) {
  const parts = String(dir || '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join(' › ');
}

// The same choice Bit makes: the PC's folder dialog, for that kind of file.
function folderRows(st, p) {
  const f = st.captureFolders;
  if (!f) return [];
  const row = (id, label, dir, folderFor) => ({
    kind: 'button', id, label: k(label), sub: { text: folderShown(dir) }, action: k('xmenu_do_change'),
    act: run(rec({ folder: 'pick', folderFor })),
  });
  const rows = [];
  if (p.captureVideo) rows.push(row('videoFolder', 'xmenu_folder_videos', f.videos, 'recordings'));
  if (p.capture) rows.push(row('shotFolder', 'xmenu_folder_shots', f.shots, 'screenshots'));
  return rows.length ? [heading('folders', 'xmenu_folders'), ...rows] : [];
}

// Whether the screen widgets show in captures, only where the shell can keep them out.
// Where it has widgets but cannot (Linux: no capture tool leaves one window out),
// the row says they always show instead of offering a choice that does nothing.
function widgetsRow(st, p) {
  if (!p.layersCaptures) {
    return p.layers ? [{ kind: 'status', id: 'captureWidgets', label: k('xmenu_capture_widgets'), value: k('xmenu_capture_widgets_always'), sub: k('xmenu_sub_capture_widgets_always'), tone: 'off' }] : [];
  }
  const on = st.layers && st.layers.excludeFromCapture === false;
  const set = (mode) => ({ type: 'layersCaptures', mode });
  return [toggleRow('captureWidgets', k('xmenu_capture_widgets'), on, set('on'), set('off'), k(on ? 'xmenu_sub_capture_widgets_on' : 'xmenu_sub_capture_widgets_off'))];
}

function captureSection(st) {
  const p = st.probes || {};
  if (!p.capture && !p.captureVideo) return [{ kind: 'status', id: 'noCapture', label: k('xmenu_sec_capture'), value: k('xmenu_needs_engine') }];
  const c = st.capture || {};
  const rows = [{ kind: 'button', id: 'gallery', label: k('xmenu_gallery'), sub: k('xmenu_sub_gallery'), action: k('xmenu_open'), act: open('gallery'), primary: true, closes: true }];
  rows.push(...widgetsRow(st, p));
  if (p.captureVideo) rows.push(...recordRows(c, p));
  if (p.captureReplay) rows.push(...replayRows(c));
  rows.push(...folderRows(st, p));
  rows.push({ kind: 'button', id: 'all', label: k('xmenu_all_options'), sub: k('xmenu_sub_all_options'), action: k('xmenu_open'), act: open('settings:capture'), closes: true });
  return rows;
}

module.exports = { captureSection, folderShown };
