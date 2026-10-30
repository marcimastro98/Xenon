'use strict';
// Capabilities: the features added for single-screen Xenon (layers, the
// performance overlay, capture, gallery), each declared ONCE here and offered
// everywhere from this one entry.
//
// An entry is a Deck action spec (same shape as js/deck-actions.js
// ACTION_CATALOG, which appends these) plus a `capability` block:
//
//   domain    'layers' | 'perf' | 'capture' | 'gallery' | 'ai' | 'deck'
//   risk      'safe'      reads, or a reversible change on screen
//             'sensitive' saves or records what is on screen; an SDK widget may
//                         only TRIGGER it, with its own consent line, and never
//                         gets pixels, paths or files back
//             There is no 'dangerous' tier: overclocking, voltages, fans and
//             driver overrides are not features of Xenon.
//   requires  a capability name the server answers in /actions/catalog
//             (`capabilities`), never an OS standing in for one
//   ai        { name, description, params: { <param>: description } } — the
//             Xenon AI function. Arguments become the action's params and run
//             through the same allowlisted registry as a Deck key.
//
// Data only: no DOM, no execution. Validation happens where it always has, in
// validateAction (js/deck-actions.js) and server/actions/registry.js; the
// effects live in server/capabilities/.

const CAPABILITIES = [
  // The frame rate with the numbers around it: average, 1% and 0.1% lows,
  // 99th-percentile frame time. Read-only, so it is no key in the Deck editor.
  {
    type: 'perfStats', group: 'perf', hidden: true, labelKey: 'deck_act_perfStats', params: [],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'frameStats',
      ai: {
        name: 'get_game_performance',
        description: 'Read how the game in front of the user is running right now: average FPS, 1% and 0.1% lows (the frame rate of the slowest frames, which is what stutter feels like), 99th-percentile and worst frame time, the process name, and "exclusive": true when the game runs in exclusive full screen, where no widget or overlay can show over it (the fix is borderless or windowed full screen in the game display settings). Use it when the user asks how a game runs, whether it stutters, or what their FPS or lows are. Returns error "no_game" when nothing is presenting frames.',
        params: {},
      },
    },
  },

  // "Why does it stutter?" (server/stutter-why.js): local rules over the frame
  // times and the PC's readings, one cause and a next step. A Deck key because
  // it is asked mid-game; the answer is a toast, and Bit words it by voice.
  {
    type: 'stutterWhy', group: 'perf', labelKey: 'deck_act_stutterWhy', params: [],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'frameStats',
      ai: {
        name: 'explain_stutter',
        description: 'Say why the game in front of the user stutters or runs slowly, from local rules over its last frames and the last minute of PC readings (no guess from a model). Returns verdict ("smooth", "stutter" or "low"), reason (the main cause: smooth, capped, vram_full, ram_full, gpu_hot, cpu_hot, gpu_bound, cpu_bound, mixed, no_gpu_reading, loading), also (up to 2 more causes), summary (one English sentence with the cause and what to do: say it in the language of the user, in your own words), and the numbers behind it: fps, low1Fps, low01Fps, hitches (frames far longer than the others) over seconds, cap (the FPS limit when capped), gpu and cpu load %, busiestCore %, vramPct, memPct, gpuTemp, cpuTemp (°C; null = not measured). Use it for "why does it stutter?", "perché scatta?", "why is my FPS low?". Errors: "no_frames" (no game is drawing frames), "too_soon" (the game just started, ask again in a few seconds).',
        params: {},
      },
    },
  },

  // Game sessions (server/game-sessions.js): one summary per game played, kept
  // on this PC. Read and compared by voice; switched or cleared from Settings,
  // a Deck key or the voice.
  {
    type: 'gameSessions', group: 'perf', hidden: true, labelKey: 'deck_act_gameSessions',
    params: [{ name: 'game', kind: 'text', maxLen: 80, optional: true }],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'gameSessions',
      ai: {
        name: 'get_game_session_stats',
        description: 'Read the games the user played recently, newest first (up to 10): game process name, start and end time (ms since epoch), duration in seconds, average FPS, 1% and 0.1% lows (null when the PC could not measure single frames), average CPU and GPU load and peak temperatures. Use it for "how did my last match go?", "what FPS did I get in Cyberpunk yesterday?", "how long did I play?". Errors: "no_sessions" (nothing played long enough yet, sessions under 2 minutes are not kept), "off" (the user turned the log off).',
        params: { game: 'optional game process name to filter, e.g. "cyberpunk2077"; empty for every game' },
      },
    },
  },
  {
    type: 'gameSessionsCompare', group: 'perf', hidden: true, labelKey: 'deck_act_gameSessionsCompare',
    params: [{ name: 'game', kind: 'text', maxLen: 80, optional: true }],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'gameSessions',
      ai: {
        name: 'compare_game_sessions',
        description: 'Compare the latest session of a game with the session before it of the same game: both summaries plus deltaAvgFps, deltaLow1Fps and deltaLow01Fps (latest minus previous; positive = better). Use it for "did the driver update help?", "is it running better than last time?". Without a game it takes the game played last. Errors: "first_session" (only one session of that game, returned as latest), "no_sessions", "off".',
        params: { game: 'optional game process name; empty for the game played last' },
      },
    },
  },
  {
    type: 'gameSessionsSet', group: 'perf', hidden: true, labelKey: 'deck_act_gameSessionsSet',
    params: [{ name: 'mode', kind: 'select', options: ['on', 'off', 'clear'], strict: true }],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'gameSessions',
      ai: {
        name: 'manage_game_sessions',
        description: 'Turn the log of games played on or off, or delete every saved session. Use "clear" only when the user explicitly asks to delete or reset their game history, never to tidy up.',
        params: { mode: 'on, off or clear' },
      },
    },
  },

  // What the Game performance tile shows besides the FPS (js/perf-hud.js),
  // the same switches as Settings, Performance. Voice only: it is set once.
  {
    type: 'perfHud', group: 'perf', hidden: true, labelKey: 'deck_act_perfHud',
    params: ['low1', 'low01', 'frame', 'graph', 'hw'].map(name => ({ name, kind: 'select', options: ['keep', 'show', 'hide'] })),
    capability: {
      domain: 'perf', risk: 'safe', requires: 'perfTile',
      ai: {
        name: 'set_perf_tile',
        description: 'Read or change what the Game performance tile (the FPS widget, also over the game) shows besides the FPS. Each part is "show" or "hide"; leave out what the user did not mention, and with none the call only returns what is shown now. low1: the 1% low. low01: the 0.1% low. frame: the frame time (between games, how long the last game lasted). graph: the graph of the latest frame times. hw: the row with CPU and GPU load and the GPU temperature. Use it for "show only the FPS", "hide the graph", "put the CPU back on the FPS widget".',
        params: { low1: 'show or hide', low01: 'show or hide', frame: 'show or hide', graph: 'show or hide', hw: 'show or hide' },
      },
    },
  },

  // Benchmark (server/benchmark.js): every frame time of the running game, from
  // a start to a stop, saved as a CSV in Documents/Xenon/Benchmark. A Deck key
  // because it is pressed mid-game; the file is shown, never sent.
  {
    type: 'benchmark', group: 'perf', labelKey: 'deck_act_benchmark',
    params: [{ name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop', 'reveal'] }],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'benchmark',
      ai: {
        name: 'run_benchmark',
        description: 'Record a benchmark of the game in front of the user: every frame time from start to stop, saved as a CSV file in the benchmark folder (standard Documents/Xenon/Benchmark; the user can change it, see set_recording_options folderFor "benchmarks"). "start" begins (error "no_game" without a running game, "running" if one is already going), "stop" ends and saves it and returns game, durationS, frames, avgFps, low1Fps, low01Fps and the file name; "toggle" (default) does whichever applies; "reveal" opens the folder of the last saved file. A run also ends by itself when the game closes, after 30 minutes, or with "no_frames" when the game drew no frame in its first 5 seconds. "start" answers "no_frames" when the frame capture does not see the game. Errors on stop: "too_short" (under 100 frames, nothing saved), "no_frames", "not_running".',
        params: { mode: 'toggle (default), start, stop or reveal' },
      },
    },
  },

  // The system power mode (server/power/): the switch the OS itself shows
  // (Windows "Power mode" on the Balanced plan, power-profiles-daemon on Linux).
  // Never a vendor tool, never TDP or fans. The Deck key needs a machine where
  // the mode can change; macOS needs an administrator, so there it is read only.
  {
    type: 'powerMode', group: 'perf', labelKey: 'deck_act_powerMode',
    params: [{ name: 'mode', kind: 'select', options: ['next', 'saver', 'balanced', 'performance'], optionKeys: { saver: 'power_mode_saver', balanced: 'power_mode_balanced', performance: 'power_mode_performance' } }],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'powerMode',
      ai: {
        name: 'set_power_mode',
        description: 'Change the system power mode of this PC, the same switch the operating system shows (Windows: Settings, Power, "Power mode"; Linux: the power profile). "saver" lasts longer on battery and runs cooler and quieter, "balanced" is the everyday choice, "performance" is the fastest and uses the most power; "next" moves to the following one. Returns mode and changed. Errors: "plan" (Windows is on a power plan other than Balanced, such as High performance, which has no power mode: the user picks Balanced in Control Panel, Power Options), "mode_missing" (this PC does not offer that mode), "no_daemon" (Linux without power-profiles-daemon), "needs_admin" (macOS: Low Power Mode is in System Settings, Battery). Use get_power_status first when unsure what this PC offers.',
        params: { mode: 'saver, balanced, performance or next' },
      },
    },
  },
  {
    type: 'powerStatus', group: 'perf', hidden: true, labelKey: 'deck_act_powerStatus', params: [],
    capability: {
      domain: 'perf', risk: 'safe', requires: 'powerStatus',
      ai: {
        name: 'get_power_status',
        description: 'Read this PC\'s own battery and power mode. Returns battery (null on a desktop PC: percent, plugged, charging, minutesLeft or null when the system does not know), saver (battery saver / Low Power Mode is on), mode (saver, balanced, performance, or null when it cannot be read), modes (the ones set_power_mode can pick here, empty when it cannot change it), canSet and, when the mode cannot be read or changed, why: "plan" (Windows on a plan other than Balanced), "custom" (a mode added by the PC maker), "needs_admin" (macOS), "no_daemon" (Linux without power-profiles-daemon). Wireless headsets, mice and controllers are not here: they are in the battery tile.',
      },
    },
  },

  // ── Capture: screenshots and recordings (the replay comes next) ────────────
  // Saves what is on screen, so 'sensitive'. The PNG stays on this PC; the
  // result names it, never its path.
  {
    type: 'screenshot', group: 'capture', labelKey: 'deck_act_screenshot',
    params: [
      { name: 'target', kind: 'select', options: ['screen', 'window', 'region'] },
      { name: 'mode', kind: 'select', options: ['take', 'reveal'] },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'capture',
      ai: {
        name: 'take_screenshot',
        description: 'Save a screenshot as a PNG file in the user\'s Pictures/Xenon folder, in a subfolder named after the running game (or "Desktop"). HDR screens are converted so the picture looks like the screen. "screen" (default) is the whole monitor the user is working on, "window" only the window in front, "region" freezes every screen and lets the user drag an area or click a window: the picture is saved AND copied to the clipboard, and the call waits until they pick. Returns the file name, size, whether it came from an HDR screen and "copied". "cancelled": true means the user pressed Esc (nothing saved, not an error); "picking": true means a picker is already open on screen. This saves a file for the user; to LOOK at the screen yourself use capture_screen instead. "reveal" opens the folder of the last screenshot. Errors: "no_window" (nothing in front), "no_file" (reveal with no screenshot yet), "unsupported" (this Windows cannot capture).',
        params: { target: 'screen (default), window, or region (the user picks an area)', mode: 'take (default) or reveal' },
      },
    },
  },

  // Text from the screen (OCR): read on this PC and put on the clipboard,
  // nothing saved. 'sensitive' like a screenshot: it reads what is on screen.
  {
    type: 'screenText', group: 'capture', labelKey: 'deck_act_screenText',
    params: [
      { name: 'target', kind: 'select', options: ['region', 'window', 'screen'] },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureOcr',
      ai: {
        name: 'read_screen_text',
        description: 'Read the text on the user\'s screen with the PC\'s own text recognition (no picture leaves the PC) and copy it to the clipboard. "region" (default) freezes every screen and lets the user drag over the text or click a window, and the call waits until they pick; "window" reads the window in front; "screen" the whole monitor they are working on. Returns the text itself (cut after 6000 characters, "cut": true), "lines" and "copied". Use it for "copia il testo di questa finestra", "what does this say", "translate the text on screen", or text in a picture or a scanned PDF. "empty": true means no text was found. "cancelled": true means the user pressed Esc (not an error); "picking": true means a picker is already open. Errors: "no_ocr_language" (Windows has no text recognition for the user\'s languages: they add it in Settings, Time & language, Language, the language\'s options), "no_window", "unsupported". To look at pictures, layout or colours instead of text, use capture_screen.',
        params: { target: 'region (default: the user picks), window, or screen' },
      },
    },
  },

  // A screenshot pinned over everything (capabilities/screen-pin.js): a layer
  // widget showing the picture, moved by dragging it, sized with the wheel.
  {
    type: 'screenPin', group: 'capture', labelKey: 'deck_act_screenPin',
    params: [
      { name: 'source', kind: 'select', options: ['region', 'last'], labelKey: 'deck_param_screenPin_source' },
      // Its own words: the layer toggle's 'Over the game' would be wrong for a pin.
      { name: 'surface', kind: 'select', options: ['overlay', 'desktop'], labelKey: 'deck_param_screenPin_surface', optionKeys: { overlay: 'deck_opt_over_windows' } },
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'layers',
      ai: {
        name: 'pin_screenshot',
        description: 'Pin a screenshot on the screen, above every window ("overlay", default) or on the desktop under them, like a sticky picture: to copy numbers from it into a form, or keep a reference image over a drawing app. "region" (default) freezes the screens and lets the user drag over an area (it is also saved and copied like a screenshot), and the call waits until they pick; "last" pins the newest screenshot; "id" (from list_captures) pins that one. The user moves it by dragging, resizes it with the mouse wheel and changes how see-through it is with Ctrl + wheel; the x on it unpins it. To unpin by voice use remove_layer_widget with the "pinned" id this returns (or "pin" for all of them); to make it see-through use move_layer_widget with "opacity". "cancelled": true means the user pressed Esc (not an error). Errors: "no_file" (no screenshot yet), "not_found", "not_a_picture" (that capture is a video), "too_many" (24 widgets on screen already), "unavailable" (the Xenon app is not running, or it cannot take screenshots here).',
        params: { source: 'region (default: the user picks an area now) or last', surface: 'overlay (default, above everything) or desktop', id: 'optional: a screenshot id from list_captures' },
      },
    },
  },

  // A screenshot made safe to share (capabilities/screen-cover.js): e-mails,
  // IBANs and long numbers the PC's own OCR finds are painted black in a new
  // copy; the original stays. What comes back is a count, never the text.
  {
    type: 'screenCover', group: 'capture', labelKey: 'deck_act_screenCover',
    params: [
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureCover',
      ai: {
        name: 'cover_private_data',
        description: 'Make a copy of a screenshot with private data painted black, ready to share: e-mail addresses, IBANs and long numbers (phone, card, account, id numbers with 7 or more digits) found by the PC\'s own text recognition (nothing leaves the PC). Without "id" it covers the newest screenshot; "id" (from list_captures) covers that one. The original is never changed; the copy is a new screenshot beside it. Returns "covered" (how many spots) and "found" (how many of each kind: email, iban, number), never the text. "covered": 0 means nothing private was found and no copy was made. It cannot find names, addresses or faces: tell the user to check the copy, and that they can cover more by hand with Edit in the gallery. Errors: "no_file" (no screenshot yet), "not_found", "not_a_picture" (that capture is a video), "no_ocr_language" (Windows has no text recognition for the user\'s languages: they add it in Settings, Time & language, Language), "busy", "unavailable".',
        params: { id: 'optional: a screenshot id from list_captures (default: the newest)' },
      },
    },
  },

  // The colour picker and the ruler (capabilities/screen-inspect.js): the
  // screens freeze, the user clicks a pixel or drags an area, and the colour or
  // the size goes on the clipboard. 'sensitive' because the picker shows the
  // screen; what comes back is one colour or two numbers, never a picture.
  {
    type: 'screenColor', group: 'capture', labelKey: 'deck_act_screenColor',
    params: [
      { name: 'format', kind: 'select', options: ['hex', 'rgb', 'hsl'], labelKey: 'deck_param_screenColor_format' },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureInspect',
      ai: {
        name: 'pick_screen_color',
        description: 'Let the user pick a colour anywhere on their screens: the user clicks a pixel (on Windows the screens freeze with a magnifier under the cursor; elsewhere the system picker shows), and the colour is copied to the clipboard as "hex" (default, #1E90FF), "rgb" (rgb(30, 144, 255)) or "hsl" (hsl(210, 100%, 56%)). The call waits until they click. Returns "hex", "rgb" (three numbers), "text" (what was copied) and "copied". Use it for "che colore è questo?", "copy this colour", a colour for a theme or a design. "cancelled": true means the user pressed Esc or right-clicked (not an error); "picking": true means a picker is already open. Errors: "unsupported" (this computer cannot pick colours), "unavailable".',
        params: { format: 'hex (default), rgb or hsl' },
      },
    },
  },
  {
    type: 'screenMeasure', group: 'capture', labelKey: 'deck_act_screenMeasure',
    params: [],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureMeasure',
      ai: {
        name: 'measure_screen',
        description: 'Let the user measure something on their screens in pixels: the user drags over it, and the size ("333 × 177", width × height in screen pixels) is copied to the clipboard. A click without dragging does nothing; the call waits until they drag. Returns "width", "height", "text" (what was copied) and "copied". Use it for "quanto è grande questa finestra/immagine?", "measure this button". "cancelled": true means the user pressed Esc or right-clicked (not an error); "picking": true means a picker is already open. Errors: "unsupported", "unavailable".',
        params: {},
      },
    },
  },

  // Drawing on the screen (capabilities/screen-draw.js): a see-through sheet
  // over the monitor under the pointer, strokes in screenshots and recordings,
  // the bar never. 'safe': it shows the user's own strokes and reads nothing.
  {
    type: 'screenDraw', group: 'capture', labelKey: 'deck_act_screenDraw',
    params: [
      { name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop'] },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'captureDraw',
      ai: {
        name: 'draw_on_screen',
        description: 'Let the user draw on their screen with the mouse, over everything, to point at things while presenting, teaching or recording a video: a see-through sheet covers the monitor under the pointer, with a small bar at its top for the colour (red, yellow, green, blue, white, black), the tool (pen, highlighter, arrow, box), undo, clear and close. Shift draws a straight line, Ctrl a box, Ctrl+Shift an arrow; Ctrl+Z undoes, E clears; Esc closes. The strokes show in screenshots and recordings, the bar does not. Nothing is saved. "toggle" (default) opens it or closes it, "start" opens, "stop" closes. Returns "drawing": whether it is open now. Errors: "unsupported", "unavailable".',
        params: { mode: 'toggle (default), start or stop' },
      },
    },
  },

  // The steps recorder (server/steps-recorder.js): every click becomes a step
  // with a picture, written up as a document in Documents/Xenon/Steps.
  // 'sensitive': it sees every click and the screen under it; it only starts
  // by hand, its pill shows all along, and the document stays on the PC.
  {
    type: 'steps', group: 'capture', labelKey: 'deck_act_steps',
    params: [
      { name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop', 'open', 'reveal'], optionKeys: { open: 'deck_opt_steps_open' } },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureSteps',
      ai: {
        name: 'record_steps',
        description: 'Record the steps of a procedure, to explain to someone how to do something on the PC: while it runs, every click (outside Xenon) saves a picture of that screen with a red ring where the click landed, plus what was clicked and in which app. On Windows a small pill at the top of the screen shows the count and clicking it ends the recording; on a Mac and on Linux the capture card shows it runs. What was typed is never recorded, only that some typing happened. At the end the steps become a document in Documents/Xenon/Steps: a page with the pictures inside (opens in any browser, prints, can be sent as one file) and a Markdown copy. "start" begins (error "running" if one is already going), "stop" ends it and returns "count", "folder" (the folder name) and "steps" (the sentence and app of each step) so you can write the procedure up for the user in your own words if they ask; "toggle" (default) does whichever applies; "open" opens the last document, "reveal" shows its folder. It also ends by itself at 100 steps or after 20 minutes without a click. Errors: "no_steps" (stopped before any click: nothing was saved), "not_recording", "no_file" (no document yet), "hook_failed" (the system refused to watch the clicks; on a Mac, Xenon needs Input Monitoring in Privacy & Security), "unsupported", "unavailable".',
        params: { mode: 'toggle (default), start, stop, open or reveal' },
      },
    },
  },

  // Recording (server/recorder.js): the monitor in use or the window in front, as
  // an MP4 in Videos/Xenon. 'sensitive' like a screenshot; the file stays here.
  {
    type: 'record', group: 'capture', labelKey: 'deck_act_record',
    params: [
      { name: 'target', kind: 'select', options: ['screen', 'window'] },
      { name: 'audio', kind: 'select', options: ['sound', 'sound_mic', 'silent'] },
      {
        name: 'webcam', kind: 'select', options: ['off', 'br', 'bl', 'tr', 'tl'],
        optionKeys: { off: 'deck_opt_cam_off', tl: 'deck_opt_cam_tl', tr: 'deck_opt_cam_tr', bl: 'deck_opt_cam_bl', br: 'deck_opt_cam_br' },
      },
      { name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop', 'reveal'] },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureVideo',
      ai: {
        name: 'record_screen',
        description: 'Record a video (MP4, 60 fps) of the whole monitor the user is working on ("screen", default) or only the window in front ("window"), saved in the user\'s Videos/Xenon folder in a subfolder named after the running game (or "Desktop"). HDR screens are converted so the video looks like the screen. Sound: "sound" (default) records only the sound of that app for a window and everything the PC plays for the screen; "sound_mic" adds the microphone (only when the user asks for it, e.g. for a commentary or a tutorial); "silent" records no sound. The start result says what is recorded: "sound" is "app", "system" or null, "mic" true or false (false after "sound_mic" means Windows refused the microphone: tell the user, the video goes on without it). "start" begins (error "running" if one is already going), "stop" ends it and returns the file name and its length in seconds; "toggle" (default) does whichever applies; "reveal" opens the folder of the last recording. A recording of a window also ends by itself when the window closes. Webcam: "off" (default) or a corner, "br", "bl", "tr" or "tl", puts the camera of the user in a round bubble in that corner of the video (only when the user asks for it, e.g. "record with my webcam"); the start result then has "camera" true, or false when no camera could be opened (tell the user, the video goes on without it). Errors: "no_window" (nothing in front), "too_short" (nothing was recorded), "disk_full", "no_encoder" (this Windows has no video encoder), "not_recording", "no_file".',
        params: { target: 'screen (default) or window', audio: 'sound (default), sound_mic or silent', webcam: 'off (default), br, bl, tr or tl', mode: 'toggle (default), start, stop or reveal' },
      },
    },
  },

  // Timelapse (server/recorder.js with `every`): one picture every N seconds,
  // played at 30 fps, silent, in the recordings folder. 'sensitive' like a recording.
  {
    type: 'timelapse', group: 'capture', labelKey: 'deck_act_timelapse',
    params: [
      {
        name: 'every', kind: 'select', options: ['5', '1', '2', '10', '30', '60'],
        optionKeys: { 1: 'deck_opt_lapse_1', 2: 'deck_opt_lapse_2', 5: 'deck_opt_lapse_5', 10: 'deck_opt_lapse_10', 30: 'deck_opt_lapse_30', 60: 'deck_opt_lapse_60' },
      },
      { name: 'target', kind: 'select', options: ['screen', 'window'] },
      { name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop', 'reveal'] },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureLapse',
      ai: {
        name: 'record_timelapse',
        description: 'Record a timelapse: one picture of the whole monitor the user is working on ("screen", default) or only the window in front ("window") every N seconds, played back at 30 fps, so an hour at "every 2 s" becomes a one-minute video. For drawing, building or long work the user wants to show sped up. Saved as an MP4 next to the recordings (Videos/Xenon), with "Timelapse" in its name; it has no sound. "every" is 1, 2, 5 (default), 10, 30 or 60 seconds: pick a short interval for a short session, a long one for hours. "start" begins (error "running" if a recording or timelapse is already going), "stop" ends it and returns the file name, its length in seconds and "span", the seconds it watched; "toggle" (default) does whichever applies; "reveal" opens the folder of the last timelapse. Errors: "no_window", "too_short" (no picture was taken), "disk_full", "no_encoder", "not_recording", "no_file".',
        params: { every: 'seconds between pictures: 1, 2, 5 (default), 10, 30 or 60', target: 'screen (default) or window', mode: 'toggle (default), start, stop or reveal' },
      },
    },
  },

  // Recording options (server/capture-settings.js): the same choices as
  // Settings → Capture, for the voice. Not a key: "keep" (the first option,
  // what an absent param becomes) leaves a choice as it is.
  {
    type: 'recordingOptions', group: 'capture', hidden: true, labelKey: 'deck_act_recordingOptions',
    params: [
      { name: 'fps', kind: 'select', options: ['keep', '60', '30'] },
      { name: 'size', kind: 'select', options: ['keep', 'native', '1440', '1080', '720'] },
      { name: 'quality', kind: 'select', options: ['keep', 'normal', 'high', 'small'] },
      { name: 'pill', kind: 'select', options: ['keep', 'show', 'hide'] },
      { name: 'limit', kind: 'select', options: ['keep', 'none', '10', '25', '50', '100'] },
      { name: 'folder', kind: 'select', options: ['keep', 'pick', 'default'] },
      { name: 'folderFor', kind: 'select', options: ['recordings', 'screenshots', 'benchmarks', 'bugReports', 'bugLogs'] },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'captureVideo',
      ai: {
        name: 'set_recording_options',
        description: 'Read or change how screen recordings are made (record_screen). Every parameter is optional: leave out what the user did not mention; with none, the call only returns the current options. fps: 60 or 30. size: "native" (the size of the screen or window) or a height to bring it down to, 1440, 1080 or 720 (smaller files). quality: "normal", "high" (bigger files) or "small" (half the size, for sharing). pill: "show" or "hide" the small red "recording" pill with the time and a stop button at the top of the recorded screen. limit: the space recordings may take in GB, "none", 10, 25, 50 or 100; past it, after each new recording, the OLDEST recordings Xenon made are deleted, so say that when the user sets one. folder: "pick" opens a folder dialog on the PC and waits for the user to choose (cancelled: true if they close it), "default" goes back to the standard folder. folderFor says whose folder that is: "recordings" (default, standard Videos/Xenon), "screenshots" (take_screenshot, standard Pictures/Xenon), "benchmarks" (run_benchmark CSV files, standard Documents/Xenon/Benchmark), "bugReports" (make_bug_report packages, standard Documents/Xenon/Bug reports) or "bugLogs" (the folder whose newest logs go into a bug report; "default" means none). The answer has the options now in force; "folder", "screenshotFolder", "benchmarkFolder", "bugReportFolder" and "bugLogFolder" are only folder names. Use it for "record at 30 fps", "smaller videos", "hide the recording pill", "keep my recordings under 50 GB", "save recordings somewhere else", "save my screenshots in another folder".',
        params: {
          fps: '60 or 30', size: 'native, 1440, 1080 or 720', quality: 'normal, high or small',
          pill: 'show or hide', limit: 'none, 10, 25, 50 or 100 (GB)', folder: 'pick or default',
          folderFor: 'recordings (default), screenshots, benchmarks, bugReports or bugLogs',
        },
      },
    },
  },

  // Instant Replay (server/replay.js): the last seconds of the screen kept on
  // disk, saved to Videos/Xenon on a key press. Off by default (it never stops
  // recording), so saving while it is off is an error that says so.
  {
    type: 'replay', group: 'capture', labelKey: 'deck_act_replay',
    params: [
      { name: 'mode', kind: 'select', options: ['save', 'toggle', 'on', 'off', 'reveal'] },
      { name: 'seconds', kind: 'text', maxLen: 8, optional: true, labelKey: 'deck_param_replay_seconds' },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureReplay',
      ai: {
        name: 'save_replay',
        description: 'Instant Replay: while it is on, Xenon keeps the last minutes of the screen (the monitor the game is on) and this saves them as an MP4 in the user\'s Videos/Xenon folder, in a subfolder named after the game, in about a second. Use it for "save the last 30 seconds", "salva gli ultimi 30 secondi", "clip that", "save the replay". "save" (default) saves; "seconds" asks for only the last N seconds (a number, or "2m"; leave it out to save everything kept). The answer has the file name and its length; when it also has "asked" and "keeps", the replay held less than asked: say the clip is that long and offer to keep more with set_instant_replay seconds. "on" and "off" turn the replay on or off, "toggle" switches it, "reveal" opens the folder of the last clip. The replay is OFF until the user turns it on, and by default runs only while a game is in front. Errors: "off" (the replay is off: offer to turn it on, it starts keeping from now), "no_game" (it runs only in games and none is in front), "saving" (a save is already going), "too_short" (nothing kept yet), "disk_full", "not_running", "bad_seconds", "no_file". For how long it keeps, when it runs and its sound use set_instant_replay.',
        params: { mode: 'save (default), toggle, on, off or reveal', seconds: 'optional: save only the last N seconds, e.g. "30" or "2m"' },
      },
    },
  },

  // A bookmark on the recording or replay that is running (server/capture-markers.js).
  // The saved video carries it and the gallery jumps to it.
  {
    type: 'captureMarker', group: 'capture', labelKey: 'deck_act_captureMarker',
    params: [],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'captureVideo',
      ai: {
        name: 'add_capture_marker',
        description: 'Drop a bookmark at this moment of the recording or Instant Replay that is running, so the user finds the moment later: the saved video carries it and the gallery jumps to it with one tap. Use it for "mark this", "segna questo momento", "bookmark that", "add a marker". It only works while a recording or the replay runs. The answer has "at" (seconds into the recording) when a recording runs. Errors: "not_recording" (nothing is recording: say so, and offer to start a recording or turn on Instant Replay), "unavailable". Xenon also marks where the game stutters by itself, while the setting is on.',
      },
    },
  },

  // "Clips from marks" (server/capabilities/mark-clips.js): a short copy around
  // each marked moment of the newest video (Bit: any video), beside it.
  {
    type: 'markClips', group: 'capture', labelKey: 'deck_act_markClips',
    params: [
      {
        name: 'which', kind: 'select', options: ['auto', 'marks', 'all'], labelKey: 'deck_param_markclips_which',
        optionKeys: { auto: 'deck_opt_markclips_auto', marks: 'deck_opt_markclips_marks', all: 'deck_opt_markclips_all' },
      },
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
      { name: 'name', kind: 'hidden', maxLen: 160, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'captureTrim',
      ai: {
        name: 'make_clips_from_marks',
        description: 'Cut a short clip around each marked moment of a recording or Instant Replay video: 15 seconds before the mark to 5 after, moments close together share one clip (up to 60 seconds), at most 20 clips. Each clip is a new video next to the original, which stays as it is; no re-encoding, so it takes a moment. "which": "auto" (default: the moments the user marked, or the stutters when there are none), "marks" (only the moments the user marked), "all" (the stutters Xenon marked too). Without "id" or "name" it uses the newest video. The answer has "clips" (how many were made), "names" (their file names), and "stopped" with a reason when it stopped midway (say how many were made). Use it for "make clips from my marks", "taglia le clip dai segni", "fammi le clip dei momenti segnati". Errors: "no_marks" (the video has no marks: marks are added with add_capture_marker while recording), "whole_video" (the video is already as short as a clip), "no_file" (no video yet), "not_found", "not_video", "busy" (a trim is running), "disk_full", "unavailable".',
        params: {
          which: 'auto (default), marks or all',
          id: 'optional: a capture id from list_captures',
          name: 'optional: the file name of the video, as the gallery shows it',
        },
      },
    },
  },

  // Instant Replay options: the same choices as Settings → Capture, for the
  // voice. "keep" (the first option) leaves a choice as it is.
  {
    type: 'replayOptions', group: 'capture', hidden: true, labelKey: 'deck_act_replayOptions',
    params: [
      { name: 'enabled', kind: 'select', options: ['keep', 'on', 'off'] },
      { name: 'seconds', kind: 'text', maxLen: 8, optional: true },
      { name: 'when', kind: 'select', options: ['keep', 'gaming', 'always'] },
      { name: 'audio', kind: 'select', options: ['keep', 'sound', 'sound_mic', 'silent'] },
      { name: 'clips', kind: 'select', options: ['keep', 'marks', 'all', 'off'] },
      { name: 'shortcut', kind: 'text', maxLen: 40, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'captureReplay',
      ai: {
        name: 'set_instant_replay',
        description: 'Read or change Instant Replay (save_replay). Every parameter is optional; with none, the call only returns the current state. enabled: "on" or "off" (off by default: it records all the time while on). seconds: how much it keeps, any length from 15 seconds to 60 minutes, as a number of seconds or like "5m"; longer takes more disk space while it runs (about 1 GB per 2 minutes at 4K, much less at 1080p). when: "gaming" (default, only while a game is in front) or "always" (the desktop too). audio: "sound" (default, what the PC plays), "sound_mic" (adds the microphone, only when the user asks) or "silent". shortcut: the keys that save the replay from anywhere (Ctrl+Shift+F10 by default, armed only while the replay is on): two of Ctrl, Alt, Shift and Win with a letter or a number, or one of them with F1-F12; "off" turns it off, "default" brings it back. clips: the short clips the replay saves by itself, 15 seconds before a moment to 5 after, in the gallery: "marks" (default, when the user marks a moment with add_capture_marker), "all" (also where the game stutters, at most one every 2 minutes) or "off". Error "reserved" names who already uses it (system, nvidia, gamebar, apps, altgr): suggest another. "bad_shortcut": not a combination Xenon can hold (two of Ctrl, Alt, Shift, Win plus a letter, digit or F key, or one of them plus an F key). The answer has "enabled", "running", "seconds", "when", "audio", "clips", "shortcut", and "waitingForGame" when it is on but no game is in front. Use it for "turn on instant replay", "keep the last 5 minutes", "replay on the desktop too", "replay without sound", "save the replay with Alt+Shift+R", "make a clip every time the game stutters", "stop the automatic clips".',
        params: {
          enabled: 'on or off', seconds: 'how much to keep: 15 seconds to 60 minutes, e.g. "300" or "5m"',
          when: 'gaming or always', audio: 'sound, sound_mic or silent',
          clips: 'marks, all or off',
          shortcut: 'e.g. "ctrl+shift+f10", "off" or "default"',
        },
      },
    },
  },

  // Bit's Game Companion card (capabilities/game-companion.js). With "widgets
  // only" this is the way to it: no pill sits over the game.
  {
    type: 'gameCompanion', group: 'ai', labelKey: 'deck_act_gameCompanion', params: [],
    capability: {
      domain: 'ai', risk: 'safe', requires: 'gameCompanion',
      ai: {
        name: 'open_game_companion',
        description: 'Open the Game Companion card on the PC screen: the game being played, how long the session runs, the live FPS, and a button the user taps to have the screen looked at for a tip. Use it for "apri il game companion", "open the game companion". To answer a question about what is on screen yourself, use capture_screen instead. Error "companion_off": the user has not turned Game Companion on (Settings, Bit assistant, Advanced AI features). Error "screen_alerts_off": in Widgets only mode the card shows in the on-screen alerts, which the user turned off (Settings, Notifications).',
        params: {},
      },
    },
  },

  // The gallery of what Xenon captured. The Deck key opens it on the screen it
  // is pressed on (js/deck.js); from the voice or the Virtual Deck it opens on
  // the PC's screens. `id` (voice only) opens one capture.
  {
    type: 'gallery', group: 'capture', labelKey: 'deck_act_gallery',
    params: [
      { name: 'filter', kind: 'select', options: ['all', 'video', 'screenshot'], labelKey: 'deck_param_gallery_filter' },
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'capture',
      ai: {
        name: 'open_gallery',
        description: 'Open the gallery on the PC screen: every screenshot, recording and Instant Replay clip Xenon saved, newest first, grouped by day. There the user plays a clip, trims it (a new copy, the original stays), copies it to paste into a chat, shows it in its folder or deletes it; a paired phone can watch and download. Use it for "show me my clips", "apri la galleria", "fammi vedere gli screenshot". "filter": "video" or "screenshot" (default all). "id" (from list_captures) opens that one capture. Error "not_found": the id is not a capture.',
        params: { filter: 'all (default), video or screenshot', id: 'optional: a capture id from list_captures, to open that one' },
      },
    },
  },
  {
    type: 'galleryList', group: 'capture', hidden: true, labelKey: 'deck_act_galleryList',
    params: [
      { name: 'kind', kind: 'select', options: ['all', 'video', 'screenshot', 'recording', 'replay', 'gif'] },
      { name: 'game', kind: 'text', maxLen: 80, optional: true },
      { name: 'limit', kind: 'text', maxLen: 3, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'capture',
      ai: {
        name: 'list_captures',
        description: 'List what Xenon captured, newest first: id, kind (screenshot, recording, replay, gif), file name, game ("Desktop" outside a game), when (ISO time) and seconds for videos; "more" says there are older ones, "games" lists every game with captures. Use it to answer "what did I record yesterday?", "quanti screenshot ho di Elden Ring?", or to find an id for open_gallery. "kind": all (default), video (GIFs too), screenshot, recording, replay or gif. "game": a game name, matched loosely. "limit": how many, 1 to 30 (default 10). Error "no_such_game" comes with the games that do have captures.',
        params: { kind: 'all (default), video (GIFs too), screenshot, recording, replay or gif', game: 'optional: a game name', limit: 'optional: 1 to 30, default 10' },
      },
    },
  },

  // What is said in a recording, written down on this PC by the local speech
  // recognition (server/capture-transcripts.js). Bit reads it to summarise a
  // video and split it into chapters, then keeps the chapters, which the
  // gallery shows under the player. Voice and gallery only: the result is
  // something to read, so it is no Deck key.
  {
    type: 'transcript', group: 'capture', hidden: true, labelKey: 'deck_act_transcript',
    params: [
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
      { name: 'name', kind: 'text', maxLen: 160, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'captureSpeech',
      ai: {
        name: 'transcribe_recording',
        description: 'Read what is said in a recording or Instant Replay clip, written down on this PC by the local speech recognition (nothing is uploaded). The first time it transcribes the video, which takes about a fifth of its length; after that it is instant. Returns "text" (one line per sentence, "[m:ss] words"), "seconds", "lang", the saved "chapters" ("m:ss Title") and "summary" if any; "cut": true when the text was too long and only the start is there. Without "id" or "name" it reads the newest video. Use it for "what did I say in the last video?", "riassumi la registrazione", "dividi il video in capitoli": then write the summary and the chapters from the text and keep them with save_recording_chapters. "working": true means the transcription is still running (a long video): tell the user it shows up in the gallery when it is done. Errors: "no_file" (no video yet), "not_found", "not_video" (that capture is a picture), "no_audio" (recorded without sound), "whisper_missing" (the local speech recognition is not installed: Settings, Bit assistant, Whisper), "too_long" (over 2 hours), "busy" (another video is being transcribed), "unavailable".',
        params: { id: 'optional: a capture id from list_captures', name: 'optional: the file name of the video, as the gallery shows it' },
      },
    },
  },
  {
    type: 'transcriptChapters', group: 'capture', hidden: true, labelKey: 'deck_act_transcriptChapters',
    params: [
      { name: 'id', kind: 'hidden', maxLen: 16 },
      { name: 'chapters', kind: 'text', maxLen: 3000, optional: true },
      { name: 'summary', kind: 'text', maxLen: 800, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'captureSpeech',
      ai: {
        name: 'save_recording_chapters',
        description: 'Keep the chapters and the summary you wrote for a video you read with transcribe_recording; the gallery shows them under the player, and a tap on a chapter jumps there. "chapters": one per line, "m:ss Title" (or "h:mm:ss Title"), the first at 0:00, 3 to 12 for most videos, short titles in the language of the video. "summary": two or three plain sentences. Sending them again replaces them; an empty "chapters" removes them. Errors: "no_transcript" (call transcribe_recording first), "bad_chapters" (no line had a time), "not_found".',
        params: { id: 'the capture id transcribe_recording returned', chapters: 'one chapter per line: "m:ss Title"', summary: 'optional: two or three sentences' },
      },
    },
  },

  // A copy of a video for sharing (server/capture-export.js): vertical 9:16,
  // fitted to a size for a chat, or a GIF. 'safe': it re-encodes a file Xenon
  // made, beside the original, and never sends anything anywhere. The Deck's
  // one choice is `as`; `focus`, `mb`, `id` and `name` are for Bit.
  {
    type: 'exportCapture', group: 'capture', labelKey: 'deck_act_exportCapture',
    params: [
      {
        name: 'as', kind: 'select', options: ['vertical', 'vertical_cam', 'fit25', 'fit10', 'fit50', 'fit100', 'gif'],
        labelKey: 'deck_param_export_as',
        optionKeys: {
          vertical: 'deck_opt_exp_vertical', vertical_cam: 'deck_opt_exp_vertical_cam', fit10: 'deck_opt_exp_fit10',
          fit25: 'deck_opt_exp_fit25', fit50: 'deck_opt_exp_fit50', fit100: 'deck_opt_exp_fit100', gif: 'deck_opt_exp_gif',
        },
      },
      { name: 'focus', kind: 'hidden', maxLen: 6, optional: true },
      { name: 'mb', kind: 'hidden', maxLen: 4, optional: true },
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
      { name: 'name', kind: 'hidden', maxLen: 160, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'captureExport',
      ai: {
        name: 'export_capture',
        description: 'Make a copy of a recording or Instant Replay clip ready to share, saved next to it (the original stays as it is; nothing is uploaded). "as": "vertical" (default) is 9:16 for TikTok, Shorts and Reels, cropped from the middle of the picture ("focus": "left", "center" or "right" keeps that part instead); "vertical_cam" puts the webcam bubble of the recording on top and the game below (error "no_webcam" when the video was recorded without the webcam); "fit10", "fit25", "fit50", "fit100" makes a smaller copy that fits under that many MB, to send in a chat (Discord without Nitro takes 10 MB); "mb" makes a smaller copy of any other size, a whole number of MB from 1 to 4000 (e.g. 8), whatever "as" says; "gif" makes a silent GIF, long side 480 px (a clip over 15 seconds can come out heavy: say so). Without "id" or "name" it uses the newest video. It waits for the copy and returns "copy" (its file name), "copyId", "bytes", "width" and "height"; "working": true means it is still being made (a long video): the user sees a message on the screen when it is ready. Use it for "make the last clip vertical", "comprimi il replay per Discord", "fammi una GIF di questo video". Errors: "no_file" (no video yet), "not_found", "not_video", "busy" (another copy is being made), "too_long" (too long for that size: suggest a bigger one or trimming it), "already_small" (the video is already under that size: no copy needed, say so), "bad_size" (a size outside 1 to 4000 MB), "too_big" (the GIF went over 256 MB: trim it first), "disk_full", "unavailable".',
        params: {
          as: 'vertical (default), vertical_cam, fit10, fit25, fit50, fit100 or gif',
          focus: 'optional, with vertical: left, center (default) or right',
          mb: 'optional: a size in MB (1 to 4000) for a smaller copy, instead of the fit choices',
          id: 'optional: a capture id from list_captures',
          name: 'optional: the file name of the video, as the gallery shows it',
        },
      },
    },
  },

  // "Send to phone" (server/capture-send.js): a screenshot or a video into the
  // file transfer's list for the paired phone, over the local network only.
  {
    type: 'sendCapture', group: 'capture', labelKey: 'deck_act_sendCapture',
    params: [
      {
        name: 'what', kind: 'select', options: ['last', 'video', 'screenshot'], labelKey: 'deck_param_send_what',
        optionKeys: { last: 'deck_opt_send_last', video: 'deck_opt_send_video', screenshot: 'deck_opt_send_shot' },
      },
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
      { name: 'name', kind: 'hidden', maxLen: 160, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'capture',
      ai: {
        name: 'send_capture_to_phone',
        description: 'Send a screenshot or a video from the gallery to the paired phone of the user: it appears in the File transfer list on the phone to download, over the local network (no account, nothing uploaded). "what": "last" (default, the newest screenshot or video), "video" (the newest recording or replay clip) or "screenshot". "id" (from list_captures) or "name" picks one. Returns "name"; "already": true means it was already in the list of the phone. Use it for "send the last clip to my phone", "mandami lo screenshot sul telefono". Errors: "no_file", "not_found", "no_phone" (no phone paired: tell the user to pair one in Settings, Phone), "transfer_off" (file transfer is off in Settings, Phone), "send_too_big" (over the file transfer limit: suggest trimming it or a lighter copy with export_capture), "send_full" (the transfer list is full: the user takes some files out of it), "send_busy" (other files are on their way), "no_space".',
        params: {
          what: 'last (default), video or screenshot',
          id: 'optional: a capture id from list_captures',
          name: 'optional: the file name, as the gallery shows it',
        },
      },
    },
  },

  // "Copy to a folder" (server/capture-copy.js): a screenshot or a video copied
  // into one of the user's own folders, named, never a path from the caller.
  {
    type: 'copyCapture', group: 'capture', labelKey: 'deck_act_copyCapture',
    params: [
      {
        name: 'to', kind: 'select', options: ['desktop', 'downloads', 'documents', 'pictures', 'videos'], labelKey: 'deck_param_copy_to',
        optionKeys: {
          desktop: 'deck_opt_copy_desktop', downloads: 'deck_opt_copy_downloads', documents: 'deck_opt_copy_documents',
          pictures: 'deck_opt_copy_pictures', videos: 'deck_opt_copy_videos',
        },
      },
      {
        name: 'what', kind: 'select', options: ['last', 'video', 'screenshot'], labelKey: 'deck_param_send_what',
        optionKeys: { last: 'deck_opt_send_last', video: 'deck_opt_send_video', screenshot: 'deck_opt_send_shot' },
      },
      { name: 'id', kind: 'hidden', maxLen: 16, optional: true },
      { name: 'name', kind: 'hidden', maxLen: 160, optional: true },
    ],
    capability: {
      domain: 'capture', risk: 'safe', requires: 'capture',
      ai: {
        name: 'copy_capture_to_folder',
        description: 'Copy a screenshot or a video from the gallery into one of the user\'s own folders: "to": "desktop" (default), "downloads", "documents", "pictures" or "videos". The original stays in the gallery; a name already taken there gets " (2)". "what": "last" (default, the newest screenshot or video), "video" or "screenshot"; "id" (from list_captures) or "name" picks one. Returns "name" (the file name of the copy) and "folder". Chain it after save_replay, take_screenshot or record_screen when the user says where to put the file: "save the last 42 seconds on the desktop" = save_replay with seconds 42, then this with to desktop; "metti lo screenshot nei download". Errors: "no_file" (nothing saved yet), "not_found", "bad_place" (only those five folders), "no_space", "write_failed" (the folder would not take the file).',
        params: {
          to: 'desktop (default), downloads, documents, pictures or videos',
          what: 'last (default), video or screenshot',
          id: 'optional: a capture id from list_captures',
          name: 'optional: the file name, as the gallery shows it',
        },
      },
    },
  },

  // Bug report package (server/bug-report.js): the window in front, the last
  // seconds from Instant Replay, system facts and a chosen log folder, in one
  // .zip in Documents/Xenon/Bug reports. 'sensitive' like a screenshot.
  {
    type: 'bugReport', group: 'capture', labelKey: 'deck_act_bugReport',
    params: [
      { name: 'mode', kind: 'select', options: ['make', 'reveal'], optionKeys: { make: 'deck_opt_bug_make' } },
      {
        name: 'seconds', kind: 'select', options: ['30', '10', '60'], labelKey: 'deck_param_bug_seconds',
        optionKeys: { 10: 'deck_opt_bug_10', 30: 'deck_opt_bug_30', 60: 'deck_opt_bug_60' },
      },
    ],
    capability: {
      domain: 'capture', risk: 'sensitive', requires: 'capture',
      ai: {
        name: 'make_bug_report',
        description: 'Make a bug report package for a problem in the app in front, to send to its developer: one .zip in Documents/Xenon/Bug reports with a screenshot of the window in front, the last "seconds" (10, 30 default, or 60) of the screen from Instant Replay when it is running, the PC and system facts (no user or PC name), the newest files of the log folder the user chose in Settings, Capture, and a README saying what is inside and what is missing. Nothing is uploaded. "make" (default) builds it and returns "name" (the file name), "bytes", "video" (seconds of video, 0 when Instant Replay was not running: then "noVideo" is "off" or "not_running", tell the user they can turn Instant Replay on to include a video next time), "screenshot" (true or false), "logs" (how many log files); "logsMissing" means the chosen log folder is gone. "reveal" shows the last package in its folder. Use it for "make a bug report", "prepara un bug report di questa app". Errors: "busy" (one is being made), "no_file", "disk_full", "too_big", "write_failed", "unavailable".',
        params: { mode: 'make (default) or reveal', seconds: '10, 30 (default) or 60' },
      },
    },
  },

  // ── Layers: widgets on the desktop, in the overlay, anchored to an app ──────
  // The option lists repeat js/layers-model.js (POSITIONS, the size names) on
  // purpose: this file stays data with no load-order dependency, and a test
  // pins the two copies equal.
  {
    type: 'layerPlace', group: 'window', hidden: true, labelKey: 'deck_act_layerPlace',
    params: [
      { name: 'widget', kind: 'text', maxLen: 128 },
      { name: 'surface', kind: 'select', options: ['desktop', 'overlay'] },
      { name: 'position', kind: 'select', options: ['top-right', 'top-left', 'top', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] },
      { name: 'size', kind: 'select', options: ['medium', 'small', 'large'] },
      { name: 'screen', kind: 'select', options: ['main', 'second'] },
      // "Add" in edit mode: the monitor key of the window it was pressed on.
      { name: 'monitor', kind: 'text', maxLen: 64, optional: true },
      { name: 'page', kind: 'text', maxLen: 40, optional: true },
    ],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'place_widget',
        description: 'Put a widget on the screen of the user, outside the dashboard: on the desktop (under the windows, always clickable) or in the overlay (above everything, including games, clicks pass through). Use it for "put the weather on my desktop top right", "show my CPU over the game". For "show my FPS over the game" use the tile "perf" (frame rate of the game, 1% and 0.1% lows and a frame-time graph) in the overlay. The widget is a built-in tile id (weather, media, system, perf, agenda, notes, tasks, timer, claude, spotify…) or the name of an installed Store widget; call list_layer_widgets first when unsure what exists. Returns error "unknown_widget" with the choices when the name matches nothing.',
        params: {
          widget: 'Built-in tile id or installed widget name, e.g. "weather" or "Wall Plate"',
          surface: 'desktop (default) or overlay',
          position: 'Where on the screen; default top-right',
          size: 'small, medium (default) or large',
          screen: 'main (default) or second when the user names their other monitor',
          page: 'Only when the user has widget pages and names one: its name or number. Default: the page shown now',
        },
      },
    },
  },
  {
    type: 'layerAnchor', group: 'window', hidden: true, labelKey: 'deck_act_layerAnchor',
    params: [
      { name: 'widget', kind: 'text', maxLen: 128 },
      { name: 'app', kind: 'text', maxLen: 128, optional: true },
      { name: 'corner', kind: 'select', options: ['top-right', 'top-left', 'bottom-right', 'bottom-left'] },
      { name: 'size', kind: 'select', options: ['medium', 'small', 'large'] },
      // on = attach (default), off = back to the desktop, apps = the open apps (edit mode).
      { name: 'mode', kind: 'select', options: ['on', 'off', 'apps'] },
    ],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layerAnchor',
      ai: {
        name: 'attach_widget_to_app',
        description: 'Attach a widget to an open app: it follows that app window, at one of its corners, and hides when the app is minimized. Use it for "put my notes on Excel", "keep the timer on Zoom", "attach the weather to this window". A widget already on the screen moves there; otherwise it is added. mode "off" puts an attached widget back on the desktop. Error "no_app" comes with the names of the open apps; the app must be open. Error "unavailable": this computer cannot follow the windows of other apps (Linux on Wayland, or no Xenon app running); say so plainly.',
        params: {
          widget: 'Built-in tile id, installed widget name, or the id list_layer_widgets returns',
          app: 'The app to follow, e.g. "Excel" or "krita". Leave empty for the app in front',
          corner: 'Which corner of the app window: top-right (default), top-left, bottom-right, bottom-left',
          size: 'small, medium (default) or large',
          mode: 'on (default) to attach, off to put it back on the desktop',
        },
      },
    },
  },
  {
    type: 'layerRemove', group: 'window', hidden: true, labelKey: 'deck_act_layerRemove',
    params: [{ name: 'target', kind: 'text', maxLen: 128 }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'remove_layer_widget',
        description: 'Take a widget off the desktop or the overlay. The target is the id list_layer_widgets returns, or a widget name, which removes every copy of that widget. The dashboard is not touched.',
        params: { target: 'The id of the placed widget, or its name to remove every copy' },
      },
    },
  },
  {
    type: 'layerMove', group: 'window', hidden: true, labelKey: 'deck_act_layerMove',
    params: [
      { name: 'target', kind: 'text', maxLen: 128 },
      { name: 'position', kind: 'select', options: ['keep', 'top-right', 'top-left', 'top', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] },
      { name: 'size', kind: 'select', options: ['keep', 'small', 'medium', 'large'] },
      // Exact place from edit mode: "x,y,w,h" as fractions of the screen.
      { name: 'rect', kind: 'text', maxLen: 64, optional: true },
      { name: 'page', kind: 'text', maxLen: 40, optional: true },
      // How opaque, in percent (20-100): a pinned screenshot's wheel, or the AI.
      { name: 'opacity', kind: 'text', maxLen: 4, optional: true },
      // When it shows: always, only while a game runs, or only without one.
      { name: 'show', kind: 'select', options: ['keep', 'always', 'gaming', 'notGaming'] },
    ],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'move_layer_widget',
        description: 'Move or resize a widget already placed on the desktop or in the overlay: "move the weather to the bottom left", "make the music bigger", or to another widget page: "put the music on my Games page" (it leaves its tabs). Widgets grouped as tabs move together on the screen. A name placed more than once returns error "ambiguous" with the ids to use instead.',
        params: {
          target: 'The placed widget: its id from list_layer_widgets or its name',
          position: 'Where on the screen; keep (default) leaves it where it is',
          size: 'small, medium or large; keep (default) leaves the size',
          page: 'Another widget page to move it to (name or number), only when the user asks',
          show: 'When it shows: always, gaming (only while a game runs) or notGaming; keep (default) leaves it',
          opacity: 'How opaque, 20 to 100 percent (100 = solid), only when the user asks to see through it: "make the pinned screenshot half transparent" = 50',
        },
      },
    },
  },
  {
    type: 'layerGroup', group: 'window', hidden: true, labelKey: 'deck_act_layerGroup',
    params: [
      { name: 'widget', kind: 'text', maxLen: 128 },
      { name: 'with', kind: 'text', maxLen: 128 },
      { name: 'mode', kind: 'select', options: ['join', 'leave'] },
    ],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'group_layer_widgets',
        description: 'Make a placed widget a tab in the box of another placed widget on the desktop or in the overlay, the way tiles are grouped as tabs on the dashboard: "put the music as a tab under the weather". With mode "leave" the widget comes out of its tabs into a box of its own. Both widgets must already be placed (place_widget first). A name placed more than once returns error "ambiguous" with the ids to use instead.',
        params: {
          widget: 'The placed widget that becomes (or stops being) a tab: its id from list_layer_widgets or its name',
          with: 'The placed widget whose box it joins (not needed to leave)',
          mode: 'join (default) or leave',
        },
      },
    },
  },
  {
    type: 'layerList', group: 'window', hidden: true, labelKey: 'deck_act_layerList', params: [],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'list_layer_widgets',
        description: 'List the widgets placed on the desktop and in the overlay (id, name, where, on which screen, on which page), whether they are switched on, the widget pages (which one is shown, which one is for games) and the widgets that could be placed.',
        params: {},
      },
    },
  },
  {
    type: 'layersEdit', group: 'window', labelKey: 'deck_act_layersEdit',
    params: [{ name: 'mode', kind: 'select', options: ['toggle', 'on', 'off'] }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'edit_layer_widgets',
        description: 'Turn on (or off) the editing of the widgets on the desktop and in the overlay, so the user moves them by dragging, resizes them from the corner, drops one on another to make tabs and removes them with the cross. While it is on those windows take every click; "Done" on screen, this tool with mode off, or ten minutes without changes end it. Use it for "let me move my widgets" or "I want to arrange my desktop widgets".',
        params: { mode: 'toggle (default), on or off' },
      },
    },
  },
  {
    type: 'layersToggle', group: 'window', labelKey: 'deck_act_layersToggle',
    params: [
      { name: 'mode', kind: 'select', options: ['toggle', 'on', 'off'] },
      { name: 'surface', kind: 'select', options: ['all', 'overlay', 'desktop'] },
    ],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'toggle_layer_widgets',
        description: 'Show or hide the widgets placed on the screen, keeping where each one sits: all of them, only the overlay (the ones above games, such as the FPS) or only the desktop ones. Hiding is instant and showing again too. Use it for "hide my desktop widgets", "hide the FPS", "bring my widgets back".',
        params: { mode: 'toggle (default), on or off', surface: 'all (default), overlay or desktop' },
      },
    },
  },
  // The ready-made shortcut for the overlay (Ctrl+Shift+F9 unless changed). It
  // is held only while a widget sits in the overlay, so it costs nothing to
  // people who never put one there.
  {
    type: 'layersShortcut', group: 'window', hidden: true, labelKey: 'deck_act_layersShortcut',
    params: [{ name: 'combo', kind: 'text', maxLen: 40 }, { name: 'key', kind: 'select', options: ['overlay', 'menu', 'pad'] }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'set_overlay_shortcut',
        description: 'Change the keyboard shortcut that shows and hides the widgets in the overlay (Ctrl+Shift+F9 by default; it works only while a widget is in the overlay), or turn it off. Two of Ctrl, Alt, Shift and Win with a letter or a number, or one of them with F1-F12. Error "reserved" names who already uses it (system, nvidia, gamebar, apps, altgr), error "in_use" names the Xenon shortcut that has it ("by": search, page, a Deck key title, overlay, menu or replay): suggest another. Use it for "use Alt+Shift+O to hide the overlay" or "turn off the overlay shortcut". With key "menu" it changes the shortcut that opens the Xenon menu instead (Alt+Shift+X by default). With key "pad" and combo "on" or "off" it turns on or off opening the Xenon menu by holding the two small middle buttons together on a game controller, View and Menu on an Xbox-style pad, Create and Options (Share on a DualShock 4) on a PlayStation one (on by default; Xbox-style and PlayStation pads on Windows, any pad on Linux and macOS). Use it for "stop the controller opening the menu".',
        params: { combo: 'e.g. "ctrl+shift+f9", or "off"; empty restores the default; on or off for key pad', key: 'overlay (default), menu or pad' },
      },
    },
  },

  // Pages of the screen widgets ("Work", "Games"): one shown at a time on every
  // screen (server/layer-pages.js). Switching is a Deck key too; creating and
  // deleting happen by voice or in edit mode.
  {
    type: 'layerPage', group: 'window', labelKey: 'deck_act_layerPage',
    params: [{ name: 'page', kind: 'text', maxLen: 40, optional: true, labelKey: 'deck_param_layerPage' }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'switch_widget_page',
        description: 'Show another page of the widgets on the desktop and in the overlay: the user groups them in pages such as "Work" or "Games" and one page is shown at a time. Use it for "show my work widgets" or "next widget page". Error "no_pages" means the user has none yet (manage_widget_pages creates them); "unknown_page" comes with the names.',
        params: { page: 'The page name or number; empty or "next" goes to the next one' },
      },
    },
  },
  {
    type: 'layerPageEdit', group: 'window', hidden: true, labelKey: 'deck_act_layerPageEdit',
    params: [
      { name: 'mode', kind: 'select', options: ['create', 'rename', 'delete', 'gaming', 'notGaming', 'desktop'] },
      { name: 'page', kind: 'text', maxLen: 40, optional: true },
      { name: 'name', kind: 'text', maxLen: 32, optional: true },
      { name: 'desktop', kind: 'select', options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], optional: true },
    ],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'layers',
      ai: {
        name: 'manage_widget_pages',
        description: 'Create, rename or delete pages of the widgets on the desktop and in the overlay, or choose the page shown while a game runs. create: a new empty page, shown at once (the first one also keeps every widget placed so far on a page of its own). delete: removes the page AND the widgets on it, so say so and ask before deleting a page with widgets. gaming: that page appears by itself when a game starts and the previous page comes back when it ends (one page at most); notGaming stops it. desktop: that page is shown whenever the user switches to that virtual desktop (Windows desktops, Mac Spaces, Linux workspaces, counted from 1; 0 unties it; one page per desktop), and a desktop with no page brings back the page shown before. The result has desktopShown, the desktop shown right now. Error "no_desktops": this computer cannot tell which desktop is shown (Linux on Wayland, or no Xenon app running); say so plainly. Use it for "make a Games page", "rename page 2 to Study", "show my Games page when I play", "show my Work widgets on desktop 2".',
        params: {
          mode: 'create, rename, delete, gaming, notGaming or desktop',
          page: 'The page to change (name or number); not needed to create',
          name: 'The name for create or rename, short, e.g. "Work"',
          desktop: 'For desktop: the virtual desktop number from 1, or 0 to untie the page',
        },
      },
    },
  },

  // The edge glow on other screens while a voice chat is on (js/ai-edge-glow.js).
  {
    type: 'aiEdgeGlow', group: 'window', hidden: true, labelKey: 'deck_act_aiEdgeGlow',
    params: [{ name: 'screens', kind: 'select', options: ['auto', 'main', 'second', 'all', 'off'] }],
    capability: {
      domain: 'ai', risk: 'safe', requires: 'aiGlow',
      ai: {
        name: 'set_voice_edge_glow',
        description: 'Choose which screens light up at the edges while the user talks to you by voice: auto (only the screen they called you from: the dashboard one, or the main screen in widgets-only mode; the default), main, second, all, or off. Use it for "light up all my screens when we talk", "no glow on the main screen", "turn off the glowing edge".',
        params: { screens: 'auto, main, second, all or off' },
      },
    },
  },

  // How this PC uses Xenon (js/usage-mode.js): the dashboard, only widgets on
  // the screen, or both. A Deck key can switch it, so the choice is never
  // buried in Settings.
  {
    type: 'usageMode', group: 'window', labelKey: 'deck_act_usageMode',
    params: [{ name: 'mode', kind: 'select', options: ['dashboard', 'widgets', 'both'] }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'usageMode',
      ai: {
        name: 'set_usage_mode',
        description: 'Choose how this PC uses Xenon: dashboard (the full dashboard window, on a second screen, the Xeneon Edge or this one), widgets (no dashboard window at all: only the widgets placed on the screen, the menu and the shortcuts, the lightest) or both. The app window switches at once; the tray\'s "Show Xenon" still opens the dashboard when asked. Use it for "I only want the widgets", "no dashboard on this PC", "give me the dashboard back".',
        params: { mode: 'dashboard, widgets or both' },
      },
    },
  },
  // The Xenon menu (server/screen-menu.js): over the main screen with a key when
  // a native shell can draw it, otherwise as a panel on the dashboard. Opening
  // it changes nothing; every row inside runs its own capability.
  {
    type: 'xenonMenu', group: 'window', labelKey: 'deck_act_xenonMenu',
    params: [
      { name: 'mode', kind: 'select', options: ['toggle', 'open', 'close'], optionKeys: { open: 'deck_opt_xmenu_open' } },
      { name: 'section', kind: 'select', labelKey: 'deck_param_xmenu_section', options: ['now', 'widgets', 'overlay', 'capture', 'keys', 'look', 'mode'], optionKeys: {
        now: 'xmenu_sec_now', widgets: 'xmenu_sec_widgets', overlay: 'xmenu_sec_overlay', capture: 'xmenu_sec_capture',
        keys: 'xmenu_sec_keys', look: 'xmenu_sec_look', mode: 'xmenu_sec_mode',
      } },
    ],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'xenonMenu',
      ai: {
        name: 'open_xenon_menu',
        description: 'Open or close the Xenon menu: one place for everything Xenon does on the main screen. Sections: now (screenshot, area, record, save the replay, gallery, performance over the game), widgets (the widgets on the screen and their pages), overlay (what shows over the game, where and when), capture (recording and replay options), keys (every shortcut and macro, with conflicts), look (theme, animated wallpaper, screensaver) and mode (dashboard, widgets only or both). With the app it opens over the screen (Alt+Shift+X by default); otherwise it opens as a panel on the dashboard. mode: toggle (default), open or close; section: which one to show first (now by default). Returns "where": screen, dashboard or closed. Use it for "open the Xenon menu", "show me the shortcuts", "where are my widget settings". To change a setting directly, call its own function instead.',
        params: { mode: 'toggle (default), open or close', section: 'now (default), widgets, overlay, capture, keys, look or mode' },
      },
    },
  },
  // The Ambient scene on the PC itself (js/screen-scene-model.js): the animated
  // wallpaper behind the desktop icons is a key (on when working, off for a
  // call); the screensaver delay is a Settings choice, so only Bit sets it.
  {
    type: 'desktopWallpaper', group: 'window', labelKey: 'deck_act_desktopWallpaper',
    params: [{ name: 'mode', kind: 'select', options: ['toggle', 'on', 'off'] }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'scene',
      ai: {
        name: 'set_desktop_wallpaper',
        description: 'Turn the animated desktop wallpaper on or off: the Ambient scene (the one picked in Settings, Ambient) drawn behind the desktop icons on the screens without the dashboard, or on the only screen. It stops by itself while a game runs, with a full-screen window and on battery. mode: toggle (default), on or off. Use it for "animated wallpaper", "put the scene on my desktop", "turn off the moving background".',
        params: { mode: 'toggle (default), on or off' },
      },
    },
  },
  {
    type: 'desktopSaver', group: 'window', hidden: true, labelKey: 'deck_act_desktopSaver',
    params: [{ name: 'minutes', kind: 'select', options: ['0', '5', '10', '15', '30', '60'], strict: true }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'scene',
      ai: {
        name: 'set_pc_screensaver',
        description: 'Set the PC screensaver: the Ambient scene full screen on the screens without the dashboard (or the only screen) after the PC sits idle for this many minutes, never during a game, while an app keeps the screen on (a video player does) or while a window is full screen; any key, click or mouse move ends it. minutes: 0 (off), 5, 10, 15, 30 or 60. Use it for "start the screensaver after 10 minutes", "turn off the screensaver".',
        params: { minutes: '0 (off), 5, 10, 15, 30 or 60' },
      },
    },
  },
  // The pop-ups of "widgets only" (js/screen-alerts.js). A Settings switch, no key.
  {
    type: 'screenAlerts', group: 'window', hidden: true, labelKey: 'deck_act_screenAlerts',
    params: [{ name: 'alerts', kind: 'select', options: ['on', 'off'] }],
    capability: {
      domain: 'layers', risk: 'safe', requires: 'usageMode',
      ai: {
        name: 'set_screen_alerts',
        description: 'In "widgets only" (no dashboard window) the dashboard pop-ups (a saved screenshot or replay, a timer that ended, Guardian, scores, cameras, a Deck shortcut that failed) show in the top right corner of the main screen. on shows them (the default), off keeps them away. Use it for "stop the pop-ups on my screen", "show me the alerts again".',
        params: { alerts: 'on or off' },
      },
    },
  },

  // Notifications (hubSettings.notifications, server/capabilities/notifications.js):
  // Do not disturb is a key people press at the start of a call or a game; the
  // other switches are for Bit only, like Settings, Notifications.
  {
    type: 'dnd', group: 'system', labelKey: 'deck_act_dnd',
    params: [{ name: 'mode', kind: 'select', options: ['toggle', 'always', 'auto', 'off'], optionKeys: { always: 'settings_notif_quiet_always', auto: 'settings_notif_quiet_auto', off: 'settings_notif_quiet_off' } }],
    capability: {
      domain: 'deck', risk: 'safe', requires: 'notifications',
      ai: {
        name: 'set_do_not_disturb',
        description: 'Turn Do not disturb on or off for Xenon\'s pop-ups. "always" holds routine pop-ups back the whole time, "auto" (the default) only while a game or a full-screen scene is on, "off" never holds them back; "toggle" switches between always and auto. Errors, warnings, reminders and finished timers always show. Returns the notification switches as they are now. Use it for "do not disturb", "no pop-ups during my meeting", "turn do not disturb off".',
        params: { mode: 'always, auto, off or toggle' },
      },
    },
  },
  {
    type: 'notifications', group: 'system', hidden: true, labelKey: 'deck_act_notifications',
    params: ['enabled', 'popups', 'sounds'].map(name => ({ name, kind: 'select', options: ['keep', 'on', 'off'] })),
    capability: {
      domain: 'deck', risk: 'safe', requires: 'notifications',
      ai: {
        name: 'set_notifications',
        description: 'Read or change Xenon\'s notification switches (Settings, Notifications). Each is "on" or "off"; leave out what the user did not mention, and with none the call only returns them with quiet (the Do not disturb mode, changed with set_do_not_disturb). enabled: every notification source at once (Windows and Discord notifications, scores, cameras, pop-ups); off silences all of them. popups: the pop-up cards (the feeds keep filling). sounds: the sound a pop-up plays. Use it for "mute the notification sounds", "turn off all notifications", "are my notifications on?".',
        params: { enabled: 'on or off', popups: 'on or off', sounds: 'on or off' },
      },
    },
  },

  // Keyboard shortcuts on Deck keys (js/deck-shortcuts.js). The Deck editor has
  // its own card for them, so neither is a key action.
  {
    type: 'deckShortcut', group: 'system', hidden: true, labelKey: 'deck_act_deckShortcut',
    params: [{ name: 'key', kind: 'text', maxLen: 80, optional: true }, { name: 'shortcut', kind: 'text', maxLen: 40, optional: true }, { name: 'keyId', kind: 'text', maxLen: 64, optional: true }],
    capability: {
      domain: 'deck', risk: 'safe', requires: 'shortcuts',
      ai: {
        name: 'set_key_shortcut',
        description: 'Give a Deck key a keyboard shortcut that runs it from any app on the PC, or take it away. The key is named by its title. A shortcut is two of ctrl, alt, shift, win plus a letter or digit, or one of them plus F1-F12, e.g. "ctrl+shift+f9" or "ctrl+alt+shift+m". Combinations the system, NVIDIA, Xbox Game Bar or common apps already use are refused (error "reserved" with the owner), and so is one another key or page shortcut holds ("in_use"). "ambiguous" or "no_key" come with the key titles to ask the user about. Use it for "put ctrl shift F9 on my Music key" or "remove the shortcut from Mute".',
        params: { key: 'the title of the Deck key', shortcut: 'the combination, or empty to remove it' },
      },
    },
  },
  {
    type: 'deckShortcutList', group: 'system', hidden: true, labelKey: 'deck_act_deckShortcutList', params: [],
    capability: {
      domain: 'deck', risk: 'safe', requires: 'shortcuts',
      ai: {
        name: 'list_key_shortcuts',
        description: 'List the Deck keys that have a keyboard shortcut, with the combination and whether it works right now (state "listening" = works; "taken" = another app holds it; "full" = past the 16 shortcuts Xenon can hold; "duplicate" or "clash" = another key or page uses it; "helper_missing" = Xenon Helper is not installed). Use it for "which shortcuts do I have?" or before choosing a free combination.',
        params: {},
      },
    },
  },
];

if (typeof window !== 'undefined') {
  window.CapabilityCatalog = { CAPABILITIES };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CAPABILITIES };
}
