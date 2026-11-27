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
    // A paired phone runs only keys set up on the PC (server/paired/remote-actions.js).
    needs_pc: ['deck_err_needs_pc', 'from a phone or tablet this works only as a key already set up on the PC'],
    pc_only: ['deck_err_pc_only', 'this works only on the PC itself'],
    bad_app_path: ['deck_err_bad_app_path', 'that is not something this system can launch'],
    launch_failed: ['deck_err_launch_failed', 'the app would not start'],
    no_notification: ['deck_err_no_notification', 'there is no notification to open'],
    not_launchable: ['deck_err_not_launchable', 'that app cannot be opened from here, open it yourself'],
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
    // Opening iCUE with the Xenon Pump widget (pump-screen/icue.js).
    no_icue: ['deck_err_no_icue', 'iCUE is not installed on this PC: install it from corsair.com, then try again'],
    build_failed: ['deck_err_build_failed', 'the iCUE widget could not be prepared, try again in a moment'],
    // Airflow (airflow/actions.js).
    airflow_off: ['deck_err_airflow_off', 'Airflow is off: turn it on in the Xenon menu, Fans'],
    needs_check: ['deck_err_needs_check', 'run the fan check first, in the Xenon menu, Fans'],
    // The home cameras (smart-home/camera-show.js).
    no_cameras: ['deck_err_no_cameras', 'no camera is connected: add Home Assistant or UniFi Protect in Settings'],
    no_camera: ['deck_err_no_camera', 'no camera has that name: check it on the key'],
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
    // Instant Replay keys (server/screens/replay.js).
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
    // The not-a-game list (capabilities/game-mode.js).
    bad_app_name: ['deck_err_bad_app_name', 'the app name on this key is not a program name'],
    bad_every: ['deck_err_bad_every', 'choose how often to sample: 1, 2, 5, 10 or 15 minutes'],
    list_full: ['deck_err_game_ignore_full', 'the Not games list is full: remove an app in Settings, Performance'],
    // The "this is a game" list, its opposite.
    games_full: ['deck_err_games_full', 'the Always games list is full: remove an app in Settings, Performance'],
    no_app: ['deck_err_no_app', 'Bring the game to the front first'],
    never_a_game: ['deck_err_never_a_game', 'Xenon never treats this app as a game: a browser, the desktop or Xenon itself'],
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
    // Wave Link (actions/wavelink.js), on the same bar: what the person can fix
    // gets a sentence; a refused handshake or a failed request stays its code.
    wl_disabled: ['deck_err_wl_off', 'Wave Link is off in Xenon: turn it on in Settings, Streaming'],
    wl_not_found: ['deck_err_wl_unreachable', 'Xenon cannot reach Wave Link: is the app open?'],
    wl_connect_failed: ['deck_err_wl_unreachable', 'Xenon cannot reach Wave Link: is the app open?'],
    wl_probe_timeout: ['deck_err_wl_unreachable', 'Xenon cannot reach Wave Link: is the app open?'],
    wl_probe_failed: ['deck_err_wl_unreachable', 'Xenon cannot reach Wave Link: is the app open?'],
    wl_closed: ['deck_err_wl_unreachable', 'Xenon cannot reach Wave Link: is the app open?'],
    wl_request_timeout: ['deck_err_wl_unreachable', 'Xenon cannot reach Wave Link: is the app open?'],
    wl_unknown_channel: ['deck_err_wl_channel', 'that Wave Link channel is not in your mixer: pick it again in the Deck editor'],
    wl_unknown_mix: ['deck_err_wl_mix', 'that Wave Link mix does not exist anymore: pick another in the Deck editor'],
    wl_channel_not_in_mix: ['deck_err_wl_not_in_mix', 'that channel is not in this Wave Link mix'],
    wl_unknown_effect: ['deck_err_wl_effect', 'that channel does not have this effect in Wave Link'],
    wl_unknown_device: ['deck_err_unknown_device', 'that output device is not connected right now'],
    wl_unsupported: ['deck_err_wl_unsupported', 'your version of Wave Link does not have this'],
    // The other apps keys talk to (actions/obs.js, streamerbot.js, home-assistant.js,
    // chroma.js). "unavailable" from the registry means the build lacks the
    // module, which no person can fix: it stays a code.
    obs_connect_failed: ['deck_err_obs_unreachable', 'Xenon cannot reach OBS: is it open, with its WebSocket server on?'],
    obs_closed: ['deck_err_obs_unreachable', 'Xenon cannot reach OBS: is it open, with its WebSocket server on?'],
    obs_timeout: ['deck_err_obs_unreachable', 'Xenon cannot reach OBS: is it open, with its WebSocket server on?'],
    obs_request_timeout: ['deck_err_obs_unreachable', 'Xenon cannot reach OBS: is it open, with its WebSocket server on?'],
    sb_connect_failed: ['deck_err_sb_unreachable', 'Xenon cannot reach Streamer.bot: is it open, with its WebSocket server on?'],
    sb_closed: ['deck_err_sb_unreachable', 'Xenon cannot reach Streamer.bot: is it open, with its WebSocket server on?'],
    sb_timeout: ['deck_err_sb_unreachable', 'Xenon cannot reach Streamer.bot: is it open, with its WebSocket server on?'],
    sb_request_timeout: ['deck_err_sb_unreachable', 'Xenon cannot reach Streamer.bot: is it open, with its WebSocket server on?'],
    ha_not_configured: ['deck_err_ha_not_set_up', 'Home Assistant is not set up yet: add it in Settings, Smart Home'],
    ha_auth_invalid: ['deck_err_ha_auth', 'Home Assistant refused the token: paste a new one in Settings, Smart Home'],
    ha_connect_failed: ['deck_err_ha_unreachable', 'Xenon cannot reach Home Assistant: is it on, and is its address right in Settings, Smart Home?'],
    ha_closed: ['deck_err_ha_unreachable', 'Xenon cannot reach Home Assistant: is it on, and is its address right in Settings, Smart Home?'],
    ha_timeout: ['deck_err_ha_unreachable', 'Xenon cannot reach Home Assistant: is it on, and is its address right in Settings, Smart Home?'],
    ha_request_timeout: ['deck_err_ha_unreachable', 'Xenon cannot reach Home Assistant: is it on, and is its address right in Settings, Smart Home?'],
    chroma_init_failed: ['deck_err_chroma_unreachable', 'Xenon cannot reach Razer Chroma: is Razer Synapse open?'],
    chroma_timeout: ['deck_err_chroma_unreachable', 'Xenon cannot reach Razer Chroma: is Razer Synapse open?'],
    // A key whose field was left empty (actions/registry.js).
    empty_path: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    empty_text: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    empty_message: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    empty_prompt: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    empty_id: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    empty_effect: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    empty_app: ['deck_err_not_set_up', 'this key is not set up yet: pick its app, file or device in the Deck editor'],
    // Close or minimize an app (actions/registry-app-window.js).
    app_not_open: ['deck_err_app_not_open', 'that app has no window open right now'],
    app_protected: ['deck_err_app_protected', 'Xenon does not close or minimize this app: it is part of the system, or Xenon itself'],
    app_close_refused: ['deck_err_app_close_refused', 'the app did not close: it may be asking you something, like saving your work'],
    no_window_tool: ['deck_err_no_window_tool', 'this needs wmctrl and xdotool: install them with your package manager'],
    // Nothing wrong, nothing to do (registry.js, capabilities/record.js, timelapse.js, layers.js).
    nothing_running: ['deck_err_nothing_running', 'nothing is running to stop'],
    running: ['deck_err_already_recording', 'a recording is already going: stop it first'],
    no_second_screen: ['deck_err_no_second_screen', 'this needs a second screen connected'],
    // A Store widget its creator kept to the top bar (manifest `tile: false`, capabilities/layers.js).
    bar_only: ['deck_err_bar_only', 'this widget lives in the top bar: it is not placed on a screen'],
    nothing_to_undo: ['deck_err_nothing_to_undo', 'there is nothing to undo'],
  });

  // Nothing is wrong with the key or the PC: it just cannot happen right now.
  const NOTICES = new Set([
    'no_game', 'no_app', 'no_frames', 'too_soon', 'too_short', 'no_file', 'no_steps', 'no_pages', 'no_widgets', 'over_exclusive', 'not_recording',
    'no_marks', 'whole_video', 'already_small', 'no_webcam', 'no_phone', 'transfer_off', 'send_busy',
    'off', 'not_running', 'saving', 'busy', 'vitals_off', 'vital_off', 'companion_off', 'screen_alerts_off', 'wl_disabled',
    'nothing_running', 'running', 'no_second_screen', 'nothing_to_undo', 'app_not_open', 'airflow_off', 'needs_check',
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
