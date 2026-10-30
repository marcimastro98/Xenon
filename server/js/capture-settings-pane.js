// Settings → Capture (screenshot folder; recording frame rate, size, quality,
// the time pill, a space limit and folder) and the benchmark folder under
// Settings → Performance (server/capture-settings.js). The values live on the
// server (GET/POST /capture/settings, loopback only, because they name folders
// on this PC); a paired device sees only that they are set at the PC. Each
// folder is chosen with the system's own folder dialog, never typed.
(function () {
  'use strict';

  const SELECTS = {
    fps: 'settings-capture-fps', height: 'settings-capture-height', quality: 'settings-capture-quality', maxGB: 'settings-capture-maxgb',
    replayWhen: 'settings-replay-when', replayAudio: 'settings-replay-audio', replayClips: 'settings-replay-clips',
  };
  const BOOLEANS = ['badge', 'autoMarks', 'replay'];
  const STRINGS = ['quality', 'replayWhen', 'replayAudio', 'replayClips'];
  // The lengths the list offers; any other (set by voice, or "Other") shows as "Other".
  const REPLAY_PRESETS = [15, 30, 60, 120, 300, 600, 1200, 3600];
  const REPLAY_MIN_S = 15;
  const REPLAY_MAX_S = 3600;
  // Why the replay is not running, when it should.
  const REPLAY_ERRORS = {
    no_encoder: ['replay_no_encoder', 'This PC has no video encoder'],
    unsupported: ['replay_no_encoder', 'This PC has no video encoder'],
    disk_full: ['rec_disk_full', 'The disk is full'],
  };
  // Why a chosen folder was refused, in the words the transfer folder uses.
  const FOLDER_ERRORS = {
    not_found: 'xfer_folder_not_found',
    not_a_dir: 'xfer_folder_not_a_dir',
    inside_data: 'xfer_folder_inside',
    inside_app: 'xfer_folder_inside',
    symlink: 'xfer_folder_symlink',
    picking: 'settings_folder_busy',
  };

  // Each folder row (data-folder-for in index.html) → its settings key and the
  // GET answer's standard folder. The bug report's log folder has none: it
  // reads "No folder" until one is picked.
  const FOLDERS = {
    recording: { key: 'folder', def: 'defaultFolder' },
    screenshot: { key: 'shotFolder', def: 'defaultShotFolder' },
    benchmark: { key: 'benchFolder', def: 'defaultBenchFolder' },
    bugreport: { key: 'bugFolder', def: 'defaultBugFolder' },
    buglogs: { key: 'bugLogs', none: ['settings_bug_logs_none', 'No folder'] },
  };

  const $id = (id) => document.getElementById(id);
  const rowOf = (kind) => document.querySelector(`.settings-capture-folder[data-folder-for="${kind}"]`);
  const isRemote = () => !!window.__xenonRemote;
  let probing = null;
  let current = null;
  let engine = null;   // the catalog's capabilities, once read
  let platform = '';   // the server's OS, from the same catalog

  // Why a part of this page is missing on this PC, when the OS or a missing
  // tool is the reason ([key, English]); null when nothing is missing or the
  // reason is not known. Recording first: without it there is no replay either.
  function missingWhy(caps, os) {
    if (!caps || caps.capture !== true) return null;
    if (os === 'linux' && caps.captureVideo === false) {
      return ['capture_why_linux_record', 'Recording the screen needs ffmpeg on X11, wf-recorder on Sway and Hyprland, or ffmpeg and the GStreamer PipeWire plugin on GNOME and KDE with Wayland.'];
    }
    if (caps.captureReplay !== false) return null;
    if (os === 'linux') return ['capture_why_linux_replay', 'Instant Replay needs ffmpeg. It is not available on GNOME and KDE with Wayland.'];
    if (os === 'darwin') return ['capture_why_mac_replay', 'Instant Replay is not on the Mac yet.'];
    return null;
  }

  function applyEngine() {
    if (!engine || isRemote()) return;
    // A catalog without the key (an older server) keeps the row, as before.
    setSettingsCardAvailable($id('settings-capture-video-group'), engine.captureVideo !== false);
    setSettingsCardAvailable($id('settings-replay-group'), engine.captureReplay !== false);
    for (const row of document.querySelectorAll('[data-capture-tuning]')) row.hidden = engine.captureTuning === false;
    // The timer pill is drawn by the Windows engine only.
    for (const row of document.querySelectorAll('[data-capture-badge]')) row.hidden = engine.captureBadge === false;
    // Stutter markers read the game's frames: only where frame times are readable.
    for (const row of document.querySelectorAll('[data-capture-automarks]')) row.hidden = engine.frameStats === false;
    // No folder dialog here (Linux without zenity or kdialog): the standard folders stay.
    for (const b of document.querySelectorAll('[data-folder-pick]')) b.hidden = engine.capturePick === false;
    const why = missingWhy(engine, platform);
    const row = $id('settings-capture-why');
    if (row) {
      row.textContent = why ? t(why[0], why[1]) : '';
      row.hidden = !why;
    }
  }

  // The nav entry shows only where the capture engine runs; the benchmark
  // folder also needs a benchmark that can run here. What this engine cannot
  // do (on macOS: the timer pill) is
  // hidden, not offered and then refused.
  function probe() {
    const nav = $id('settings-nav-capture');
    if (!nav || probing) return;
    probing = apiJson('/actions/catalog').then((d) => {
      if (!d) { probing = null; return; }   // asked again on the next open
      const caps = d.capabilities || {};
      nav.hidden = caps.capture !== true;
      setSettingsCardAvailable($id('settings-bench-group'), caps.capture === true && caps.benchmark === true && !isRemote());
      engine = caps;
      platform = typeof d.platform === 'string' ? d.platform : '';
      applyEngine();
    });
  }

  function post(path, body) {
    return apiJson(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
  }

  function setSelect(id, value) {
    const el = $id(id);
    if (!el) return;
    el.value = String(value);
    if (typeof el._csSync === 'function') el._csSync();
  }

  // The line under the switch: what the replay is doing right now.
  function replayStateText(st, o) {
    if (!o.replay || !st) return '';
    if (st.on) {
      const kept = window.CaptureToast ? window.CaptureToast.clock(st.kept || o.replaySeconds) : String(st.kept);
      return t('settings_replay_state_on', 'On: keeping the last {time}').replace('{time}', kept);
    }
    if (st.waiting) return t('settings_replay_state_waiting', 'Starts by itself when a game is in front');
    if (st.error) {
      const why = REPLAY_ERRORS[st.error];
      return t('replay_failed', 'Instant Replay could not start') + '. '
        + (why ? t(why[0], why[1]) : t('replay_retry', 'Xenon tries again by itself'));
    }
    return '';
  }

  function renderReplayState(st) {
    const el = $id('settings-replay-state');
    if (!el || !current) return;
    const text = replayStateText(st, current);
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('settings-note-warn', !!(st && st.error && !st.on && current.replay));
  }

  // "About 1.2 GB on the disk while it is on"; a warning when it would not fit.
  function renderReplayDisk(o) {
    const el = $id('settings-replay-disk');
    if (!el) return;
    const rate = Number(o.replayBytesPerSecond) || 0;
    const free = Number(o.replayFreeBytes) || 0;
    const need = rate * ((Number(o.replaySeconds) || 30) + 2);
    let text = '';
    if (need > 0) text = t('settings_replay_disk', 'About {size} on the disk while it is on').replace('{size}', formatBytes(need));
    const short = need > 0 && free > 0 && need > free;
    if (short) text = t('settings_replay_disk_short', 'Needs {size}, the disk has {free} free').replace('{size}', formatBytes(need)).replace('{free}', formatBytes(free));
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('settings-note-warn', short);
  }

  function renderReplayLength(o) {
    const secs = Number(o.replaySeconds) || 30;
    const preset = REPLAY_PRESETS.includes(secs);
    setSelect('settings-replay-seconds', preset ? secs : 'custom');
    const row = $id('settings-replay-custom');
    if (row) row.hidden = preset;
    const input = $id('settings-replay-minutes');
    if (input && !preset) input.value = String(Math.round((secs / 60) * 100) / 100);
  }

  function render(o) {
    current = o;
    const replayOn = $id('settings-replay-on');
    if (replayOn) replayOn.checked = o.replay === true;
    renderReplayLength(o);
    renderReplayDisk(o);
    renderReplayState(o.replayState);
    if (window.CaptureReplayKey) window.CaptureReplayKey.render(o);
    for (const [key, id] of Object.entries(SELECTS)) setSelect(id, o[key]);
    const badge = $id('settings-capture-badge');
    if (badge) badge.checked = o.badge !== false;
    const autoMarks = $id('settings-capture-automarks');
    if (autoMarks) autoMarks.checked = o.autoMarks !== false;
    for (const [kind, f] of Object.entries(FOLDERS)) {
      const row = rowOf(kind);
      if (!row) continue;
      const shown = row.querySelector('[data-folder-path]');
      if (shown) shown.textContent = o[f.key] || (f.none ? t(f.none[0], f.none[1]) : o[f.def]) || '';
      const reset = row.querySelector('[data-folder-reset]');
      if (reset) reset.hidden = !o[f.key];
    }
    const hint = $id('settings-capture-limit-hint');
    if (hint) {
      // Nothing recorded yet: no "0 B" line.
      const bytes = Number(o.usedBytes) || 0;
      const parts = [];
      if (bytes > 0) parts.push(t('settings_capture_used', 'Le registrazioni ora occupano {size}').replace('{size}', formatBytes(bytes)) + '.');
      if (Number(o.maxGB) > 0) parts.push(t('settings_capture_limit_hint', 'Oltre il limite, dopo ogni registrazione Xenon cancella le più vecchie.'));
      hint.textContent = parts.join(' ');
      hint.hidden = !parts.length;
    }
  }

  async function show() {
    const remote = isRemote();
    const note = $id('settings-capture-remote');
    if (note) note.hidden = !remote;
    for (const id of ['settings-capture-grid', 'settings-replay-grid']) {
      const grid = $id(id);
      if (grid) grid.hidden = remote;
    }
    if (remote) {
      setSettingsCardAvailable($id('settings-capture-shots'), false);
      setSettingsCardAvailable($id('settings-replay-group'), false);
      setSettingsCardAvailable($id('settings-bench-group'), false);
      setSettingsCardAvailable($id('settings-bug-group'), false);
      return;
    }
    const o = await apiJson('/capture/settings');
    if (o && o.ok) render(o);
    applyEngine();
  }

  async function set(key, raw) {
    const value = BOOLEANS.includes(key) ? raw === true : STRINGS.includes(key) ? String(raw) : Number(raw);
    const res = await post('/capture/settings', { [key]: value });
    if (res && res.ok) {
      setSettingsStatus('settings_saved', 'ok');
      // These change a line the pane shows (space used, disk estimate, state).
      if (['maxGB', 'replay', 'replaySeconds', 'replayAudio', 'fps', 'height', 'quality'].includes(key)) show();
      else if (current) current = { ...current, ...res };
    } else {
      setSettingsStatus('settings_capture_failed', 'error');
      show();
    }
  }

  async function pick(kind = 'recording') {
    const btn = rowOf(kind) && rowOf(kind).querySelector('[data-folder-pick]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t('settings_capture_picking', 'Scegli nella finestra aperta');
    try {
      const res = await post('/capture/settings/pick', { for: kind });
      if (res && res.ok && !res.cancelled) setSettingsStatus('settings_saved', 'ok');
      else if (res && !res.ok) setSettingsStatus(FOLDER_ERRORS[res.error] || 'settings_capture_failed', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = t('settings_capture_pick', 'Cambia');
      show();
    }
  }

  async function resetFolder(kind = 'recording') {
    const f = FOLDERS[kind] || FOLDERS.recording;
    const res = await post('/capture/settings', { [f.key]: '' });
    setSettingsStatus(res && res.ok ? 'settings_saved' : 'settings_capture_failed', res && res.ok ? 'ok' : 'error');
    show();
  }

  // The length list: a preset saves at once; "Other" opens the minutes field
  // with the length in force, and saves nothing until it is changed.
  function setReplayLength(value) {
    if (value === 'custom') {
      const row = $id('settings-replay-custom');
      if (row) row.hidden = false;
      const input = $id('settings-replay-minutes');
      if (input) {
        input.value = String(Math.round(((current && current.replaySeconds) || 30) / 60 * 100) / 100);
        input.focus();
      }
      return;
    }
    set('replaySeconds', value);
  }

  // Minutes (a comma works too) → whole seconds; outside 15 s to 60 min is refused.
  function setReplayMinutes(raw) {
    const secs = Math.round(Number(String(raw).replace(',', '.')) * 60);
    if (!(secs >= REPLAY_MIN_S && secs <= REPLAY_MAX_S)) {
      setSettingsStatus('settings_replay_bad_length', 'error');
      if (current) renderReplayLength(current);
      return;
    }
    set('replaySeconds', secs);
  }

  // Live state from SSE `replay` (main.js): only the line under the switch.
  window.addEventListener('xenon:replay', (e) => {
    const st = e && e.detail;
    if (!st || !current) return;
    if (typeof st.enabled === 'boolean' && st.enabled !== current.replay) { show(); return; }
    renderReplayState(st);
  });

  window.CaptureSettingsPane = { probe, show, set, pick, resetFolder, render, setReplayLength, setReplayMinutes, replayStateText, missingWhy };
})();
