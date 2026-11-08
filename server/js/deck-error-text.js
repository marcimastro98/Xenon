// Why a Deck key could not run, in a sentence.
//
// Sentences for the reasons a person can act on; anything else still shows its
// raw code, because an unexplained code is what gets pasted into a report and
// swallowing it is what made this invisible. A sentence stands alone: next to
// one, a code is noise.
//
// Shared by deck.js (the dashboard and the Virtual Deck popup) and the
// on-screen alerts window of "Solo widget" (screen-alerts.js), which shows a
// keyboard shortcut that failed while no dashboard is open.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckErrorText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DECK_ERR_TEXT = Object.freeze({
    not_found: ['deck_err_not_found', 'that path does not exist on this PC'],
    bad_when: ['deck_err_bad_when', 'that is not a situation Xenon knows'],
    name_taken: ['deck_err_name_taken', 'another page already has that name'],
    // A paired phone runs only keys set up on the PC (server/remote-actions.js).
    needs_pc: ['deck_err_needs_pc', 'from a phone or tablet this works only as a key already set up on the PC'],
    pc_only: ['deck_err_pc_only', 'this works only on the PC itself'],
    bad_app_path: ['deck_err_bad_app_path', 'that is not something this system can launch'],
    launch_failed: ['deck_err_launch_failed', 'the app would not start'],
    blocked_ext: ['deck_err_blocked_ext', 'that kind of file cannot be opened this way'],
    unavailable: ['deck_err_unavailable', 'that action is not available on this system'],
    vitals_off: ['deck_err_vitals_off', 'Vitals is off: turn it on in Settings'],
    vital_off: ['deck_err_vital_off', 'that meter is off in Settings'],
    bad_page: ['deck_err_bad_page', 'this screen has no such page, pick another for this key'],
    unknown_page: ['deck_err_bad_page', 'this screen has no such page, pick another for this key'],
    no_pages: ['deck_err_no_pages', 'There is only one widget page: add another in the Xenon menu, Widgets'],
    over_exclusive: ['deck_err_over_exclusive', 'This cannot open over this game: in its display settings, pick borderless or windowed'],
    no_widgets: ['deck_err_no_widgets', 'There are no widgets yet: add one in the Xenon menu, Widgets'],
    no_dashboard: ['deck_err_no_dashboard', 'this step needs the Xenon dashboard open on this PC'],
    no_action: ['deck_err_no_action', 'this key has nothing to do on a tap'],
    no_key: ['deck_err_no_key', 'that key is not in the Deck'],
    not_set_up: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    unknown_device: ['deck_err_unknown_device', 'that output device is not connected right now'],
    none_connected: ['deck_err_none_connected', 'none of these outputs is connected right now'],
    // A key pointing at one light that Xenon does not drive right now.
    bad_part: ['deck_err_light_missing', 'that light is not available right now'],
    bad_device: ['deck_err_light_missing', 'that light is not available right now'],
    // Screenshot and recording keys.
    no_window: ['deck_err_no_window', 'no window in front'],
    no_encoder: ['deck_err_no_encoder', 'this Windows has no video encoder'],
    disk_full: ['deck_err_disk_full', 'the disk is full'],
    too_short: ['deck_err_too_short', 'nothing was recorded yet, try again in a moment'],
    save_failed: ['deck_err_save_failed', 'the clip could not be saved, try again'],
    no_file: ['deck_err_no_file', 'nothing has been saved yet'],
    no_steps: ['steps_none', 'No clicks, nothing saved'],
    // One package (or copy) at a time; a write that failed (bug-report.js).
    busy: ['deck_err_busy', 'one is already being made, wait for it to finish'],
    bad_shortcut: ['deck_err_bad_shortcut', 'Xenon cannot use that combination: hold two of Ctrl, Alt and Shift with a key, or one of them with an F key'],
    reserved: ['deck_err_reserved', 'the system or another app already uses that combination: pick another'],
    in_use: ['deck_err_in_use', 'another Xenon shortcut already uses that combination: pick another'],
    // Keys for widgets (capabilities/widget-key.js).
    not_placed: ['deck_err_not_placed', 'that widget is not on the screen: add it first in the Xenon menu, Widgets'],
    no_widget: ['deck_err_no_widget', 'no installed widget has that function'],
    no_function: ['deck_err_no_function', 'that widget has no such function'],
    needs_settings: ['deck_err_needs_settings', 'this function asks for settings: put it on a Deck key, where you choose them'],
    not_granted: ['deck_err_not_granted', 'you did not allow this function when you installed the widget'],
    not_a_picture: ['deck_err_not_a_picture', 'that one is a video, not a picture: pick a screenshot'],
    too_big: ['deck_err_too_big', 'the package would be over 4 GB: try fewer seconds of video'],
    write_failed: ['deck_err_write_failed', 'the file could not be written: check the folder'],
    // Export keys (capabilities/export.js): the gallery's own words.
    already_small: ['capg_exp_err_small', 'It is already smaller than that: send it as it is'],
    no_webcam: ['capg_exp_err_no_webcam', 'This video has no webcam'],
    // "Clips from marks" keys (capabilities/mark-clips.js): the gallery's own words.
    no_marks: ['capg_clips_err_none', 'This video has no marks'],
    whole_video: ['capg_clips_err_whole', 'The video is already as short as a clip'],
    // "Send to phone" keys (capabilities/send-capture.js): the gallery's own words.
    not_recording: ['deck_err_not_recording', 'nothing is recording right now'],
    no_phone: ['capg_send_err_phone', 'No phone is paired: pair one in Settings, Phone'],
    transfer_off: ['capg_send_err_off', 'File transfer is off: turn it on in Settings, Phone'],
    send_too_big: ['capg_send_err_big', 'Too big for the file transfer: trim it or make a lighter copy'],
    send_full: ['capg_send_err_full', 'The file transfer is full: take some files out of its list'],
    send_busy: ['capg_send_err_busy', 'Other files are on their way, try again in a moment'],
    no_space: ['xfer_failed_space', 'There is no space left on the PC.'],
    // Text from the screen: Windows reads text only in languages with an OCR pack.
    no_ocr_language: ['deck_err_no_ocr_language', 'Windows has no text recognition for your language: add it in Settings, Time & language, Language'],
    // Instant Replay keys (server/replay.js).
    off: ['deck_err_replay_off', 'Instant Replay is off: turn it on in Settings, Capture'],
    // Also the benchmark and the frame reads, so it names no feature.
    no_game: ['deck_err_no_game', 'Open a game first'],
    not_running: ['deck_err_replay_starting', 'Instant Replay is starting, try again in a moment'],
    saving: ['deck_err_saving', 'a clip is already being saved'],
    bad_seconds: ['deck_err_bad_seconds', 'the length on this key is not a number of seconds'],
    // "Why does it stutter?" before there is anything to read (stutter-why.js).
    no_frames: ['deck_err_no_frames', 'no game is drawing frames right now'],
    too_soon: ['deck_err_too_soon', 'the game just started, try again in a few seconds'],
    // The power mode key (server/power/): what the system allows, said plainly.
    plan: ['deck_err_power_plan', 'Windows is on a power plan without a power mode: pick Balanced in Control Panel, Power Options'],
    mode_missing: ['deck_err_power_mode_missing', 'this PC does not offer that power mode'],
    no_daemon: ['deck_err_power_no_daemon', 'this system has no power profiles: install power-profiles-daemon'],
    needs_admin: ['deck_err_power_needs_admin', 'macOS changes this only in System Settings, Battery'],
    // A clip the PC plays itself, for a shortcut with no dashboard (deck-sound-player.js).
    sound_format: ['deck_err_sound_format', 'this PC cannot play this kind of file without the dashboard: use mp3, wav, m4a or flac'],
    sound_failed: ['deck_err_sound_failed', 'the sound file would not open: it may be damaged'],
    // The Game Companion key while the opt-in switch is off (capabilities/game-companion.js).
    companion_off: ['deck_err_companion_off', 'Game Companion is off: turn it on in Settings, Bit, Advanced AI features'],
    screen_alerts_off: ['deck_err_screen_alerts_off', 'on-screen alerts are off: turn them on in Settings, Notifications'],
    // Voicemeeter. Every one of these is something the person holding the
    // machine can fix — install it, start it, pick a strip their edition has —
    // which is the bar this map sets. The opaque ones (read/write refused by
    // the DLL) deliberately stay raw codes: a sentence that says nothing is
    // worse than a code somebody can paste into a report.
    voicemeeter_not_installed: ['deck_err_vm_not_installed', 'Voicemeeter is not installed on this PC'],
    voicemeeter_not_running: ['deck_err_vm_not_running', 'Voicemeeter is installed but not running'],
    voicemeeter_windows_only: ['deck_err_vm_windows_only', 'Voicemeeter only exists on Windows'],
    voicemeeter_unavailable: ['deck_err_vm_unavailable', 'Xenon cannot reach Voicemeeter'],
    voicemeeter_bad_strip: ['deck_err_vm_bad_strip', 'the Voicemeeter you are running does not have that strip'],
    voicemeeter_bad_bus: ['deck_err_vm_bad_bus', 'the Voicemeeter you are running does not have that bus'],
    voicemeeter_bad_param: ['deck_err_vm_bad_param', 'that is not a Voicemeeter parameter name'],
    voicemeeter_bad_macro: ['deck_err_vm_bad_macro', 'that macro button number does not exist'],
    voicemeeter_bad_value: ['deck_err_vm_bad_value', 'Voicemeeter will not take that value'],
  });

  // Nothing is wrong with the key or the PC: it just cannot happen right now.
  const NOTICES = new Set([
    'no_game', 'no_frames', 'too_soon', 'too_short', 'no_file', 'no_steps', 'no_pages', 'no_widgets', 'over_exclusive', 'not_recording',
    'no_marks', 'whole_video', 'already_small', 'no_webcam', 'no_phone', 'transfer_off', 'send_busy',
    'off', 'not_running', 'saving', 'busy', 'vitals_off', 'vital_off', 'companion_off', 'screen_alerts_off',
  ]);

  // The sentence, or the bare code when there is none: an unexplained code is
  // what gets pasted into a report, never nothing. `tt(key, fallback)` is the
  // caller's translator.
  function describe(code, tt) {
    const c = String(code || '');
    const known = Object.prototype.hasOwnProperty.call(DECK_ERR_TEXT, c) ? DECK_ERR_TEXT[c] : null;
    const said = known ? tt(known[0], known[1]) : '';
    return said ? said.charAt(0).toUpperCase() + said.slice(1) : c;
  }

  // The toast for a key just pressed. `important`: the person is waiting for an
  // answer, so a note gets through Do not disturb the way an error does.
  function keyToast(code, msg, tt) {
    if (NOTICES.has(code)) return { type: 'info', important: true, title: msg, duration: 3600 };
    return { type: 'error', title: tt('deck_err_title', 'This key could not run'), message: msg, duration: 3600 };
  }

  // A key's keyboard shortcut failed on the PC (SSE deck_shortcut_failed).
  function shortcutFailed(info, tt) {
    const d = info && typeof info === 'object' ? info : {};
    return {
      type: 'error',
      title: (d.via === 'button'
        ? tt('deck_key_failed_title', 'A key on your screen could not run')
        : tt('deck_shortcut_failed_title', 'A keyboard shortcut could not run')) + (d.title ? ': ' + String(d.title).slice(0, 60) : ''),
      message: describe(d.error, tt),
      duration: 4200,
    };
  }

  // A row of the Xenon menu failed after the menu closed (SSE xenon_menu_failed).
  function menuFailed(info, tt) {
    const d = info && typeof info === 'object' ? info : {};
    return {
      type: 'error',
      title: tt('xmenu_failed_title', 'The Xenon menu could not do that'),
      message: describe(d.error, tt),
      duration: 4200,
    };
  }

  return { DECK_ERR_TEXT, describe, keyToast, shortcutFailed, menuFailed };
});
