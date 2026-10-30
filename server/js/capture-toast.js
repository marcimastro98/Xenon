'use strict';
// "Screenshot saved" / "Recording saved" with a "Show" button, on SSE
// `capture`, and "Recording" with "Stop" while one runs (SSE `recording`). From
// the main dashboard only: a layer window never shows a second one. The events
// never carry a path; "Show" asks the server to open the folder of the last
// file of that kind.
(function () {
  let recToast = 0;
  let stepsToast = 0;
  let exportToast = 0;

  // apiJson (utils.js): the page's global `api` is the Deck store's object
  // (deck-store.js), not a function, so calling it threw and every button here
  // did nothing.
  function run(body) {
    apiJson('/actions/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const quiet = () => !window.XenonToast || (typeof isLayerPage === 'function' && isLayerPage());

  // The game names it; the file name would only repeat the game and the time.
  const kickerOf = (d, key, fallback) => String(d.game || '').replace(/\.exe$/i, '') || t(key, fallback);

  function clock(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s % 60).padStart(2, '0');
  }

  // Why a recording ended without a stop, when that is worth a line.
  const ENDED = {
    window_closed: ['rec_window_closed', 'The window was closed'],
    disk_full: ['rec_disk_full', 'The disk is full'],
  };

  function recordingMessage(d) {
    const parts = [clock(d.seconds)];
    const reason = String(d.reason || 'stopped');
    if (ENDED[reason]) parts.push(t(ENDED[reason][0], ENDED[reason][1]));
    else if (!['stopped', 'shutdown'].includes(reason)) parts.push(t('rec_cut', 'It stopped by itself'));
    // The space limit deleted old recordings: never silently.
    const pruned = Math.max(0, Math.trunc(Number(d.pruned) || 0));
    if (pruned) {
      parts.push(t('rec_pruned', '{n} old deleted, limit {gb} GB')
        .replace('{n}', String(pruned)).replace('{gb}', String(Math.trunc(Number(d.limitGB) || 0))));
    }
    return parts.join(' · ');
  }

  // What the "Recording" card adds under its title.
  function startNotes(d) {
    const notes = [];
    // Both missing: one sentence, two would not fit the card.
    if (d.noMic === true && d.noCamera === true) notes.push(t('rec_no_mic_camera', 'Microphone and webcam not available, recording without them'));
    else if (d.noMic === true) notes.push(t('rec_no_mic', 'Microphone not available, recording without it'));
    else if (d.noCamera === true) notes.push(t('rec_no_camera', 'Webcam not available, recording without it'));
    else if (d.noSound === true) notes.push(t('rec_no_sound', 'Computer sound not available, recording without it'));
    if (d.folderMissing === true) notes.push(t('rec_folder_missing', 'Your folder is not there, saving in Videos'));
    return notes.join(' · ');
  }

  // "Open" shows the capture in the gallery on this screen; "Show" opens its
  // folder on the PC (the only action when the gallery is not loaded).
  function actionsFor(d, type) {
    const show = { label: t('shot_show', 'Show'), onClick: () => run({ type, mode: 'reveal' }) };
    if (!d.id || !window.CaptureGallery) return [{ ...show, primary: true }];
    return [{ label: t('capg_open', 'Open'), primary: true, onClick: () => window.CaptureGallery.open({ id: d.id }) }, show];
  }

  // A screenshot can also be pinned over every window (capabilities/screen-pin.js),
  // where the app draws on the screen: the server says so in `pinnable`. A toast
  // shows two actions, so Pin takes the second place: "Show in folder" is still
  // one tap away in the gallery that "Open" leads to.
  function shotActions(d) {
    const actions = actionsFor(d, 'screenshot');
    if (d.pinnable !== true || !d.id) return actions;
    return [actions[0], { label: t('shot_pin', 'Pin'), onClick: () => run({ type: 'screenPin', id: d.id }) }];
  }

  // A saved capture answers the user's own key press, most often with a game
  // in front: do-not-disturb never holds it back (toast.js `important`).
  function onCapture(d) {
    if (!d || typeof d !== 'object' || quiet()) return;
    if (d.kind === 'screenshot' && Number.isInteger(d.covered) && d.covered > 0) {
      window.XenonToast.show(coverToast(d));
    } else if (d.kind === 'cover') {
      // Nothing private found: no copy was made, say so instead of staying silent.
      window.XenonToast.show({ type: 'info', kicker: t('deck_act_screenCover', 'Cover private data'), title: t('cover_none', 'Nothing private found'), important: true });
    } else if (d.kind === 'screenshot') {
      window.XenonToast.show({
        type: 'success',
        kicker: kickerOf(d, 'deck_act_screenshot', 'Screenshot'),
        // A picked area is on the clipboard too: say so, it is what the user pastes next.
        title: d.copied === true ? t('shot_copied', 'Screenshot copied and saved') : t('shot_saved', 'Screenshot saved'),
        ...(d.folderMissing === true ? { message: t('shot_folder_missing', 'Your folder is not there, saved in Pictures') } : {}),
        actions: shotActions(d),
        important: true,
      });
    } else if (d.kind === 'recording' && d.every) {
      window.XenonToast.show(lapseSavedToast(d));
    } else if (d.kind === 'recording') {
      window.XenonToast.show({
        type: 'success',
        kicker: kickerOf(d, 'deck_act_record', 'Record video'),
        title: t('rec_saved', 'Recording saved'),
        message: recordingMessage(d),
        actions: actionsFor(d, 'record'),
        important: true,
      });
    } else if (d.kind === 'replay') {
      // A clip saved by itself around a stutter says nothing over the game; the gallery has it.
      if (d.auto === 'stutter') return;
      const notes = [recordingMessage({ seconds: d.seconds, pruned: d.pruned, limitGB: d.limitGB })];
      if (d.folderMissing === true) notes.push(t('rec_folder_missing', 'Your folder is not there, saving in Videos'));
      window.XenonToast.show({
        type: 'success',
        kicker: kickerOf(d, 'deck_act_replay', 'Instant Replay'),
        title: d.auto === 'mark' ? t('replay_clip_saved', 'Clip saved') : t('replay_saved', 'Replay saved'),
        message: notes.join(' · '),
        actions: actionsFor(d, 'replay'),
        important: true,
      });
    } else if (d.kind === 'steps') {
      window.XenonToast.show(stepsSavedToast(d));
    } else if (d.kind === 'bugreport') {
      window.XenonToast.show(bugReportToast(d));
    } else if (d.kind === 'text') {
      window.XenonToast.show(textToast(d));
    } else if (d.kind === 'color' || d.kind === 'size') {
      window.XenonToast.show(inspectToast(d));
    }
  }

  // A timelapse: how long it watched and how long the video plays.
  function lapseSavedToast(d) {
    const parts = [t('lapse_span', '{span} in {video}').replace('{span}', clock(d.span)).replace('{video}', clock(d.seconds))];
    const rest = recordingMessage({ seconds: 0, reason: d.reason, pruned: d.pruned, limitGB: d.limitGB }).split(' · ').slice(1);
    // Only the game above the title: "Timelapse" over "Timelapse saved" says it twice.
    const game = String(d.game || '').replace(/\.exe$/i, '');
    return {
      type: 'success',
      ...(game ? { kicker: game } : {}),
      title: t('lapse_saved', 'Timelapse saved'),
      message: parts.concat(rest).join(' · '),
      actions: actionsFor(d, 'timelapse'),
      important: true,
    };
  }

  // The steps document is written: how many steps, why it stopped when it
  // stopped by itself; "Open" shows the page, "Show" its folder.
  function stepsSavedToast(d) {
    const n = Math.max(0, Math.trunc(Number(d.count) || 0));
    const parts = [n === 1 ? t('steps_one', '1 step') : t('steps_count', '{n} steps').replace('{n}', String(n))];
    if (d.reason === 'full') parts.push(t('steps_cut_full', 'Stopped at 100 steps'));
    else if (d.reason === 'idle') parts.push(t('steps_cut_idle', 'Stopped after 20 minutes without clicks'));
    return {
      type: 'success',
      kicker: t('deck_act_steps', 'Record steps'),
      title: t('steps_saved', 'Steps saved'),
      message: parts.join(' · '),
      actions: [
        { label: t('capg_open', 'Open'), primary: true, onClick: () => run({ type: 'steps', mode: 'open' }) },
        { label: t('shot_show', 'Show'), onClick: () => run({ type: 'steps', mode: 'reveal' }) },
      ],
      important: true,
    };
  }

  // The bug report package (capabilities/bug-report.js): what went in, and what
  // is missing when that changes what the developer gets. "Show" opens its folder.
  // Two facts at most, what went wrong first (rank): a phone fits two lines, and the
  // README inside the package says the rest.
  function bugReportToast(d) {
    const parts = [];
    const video = Math.max(0, Math.trunc(Number(d.video) || 0));
    if (video) parts.push({ rank: 4, text: t('bug_video', 'Last {n} s of the screen').replace('{n}', String(video)) });
    else if (d.noVideo === 'off') parts.push({ rank: 3, text: t('bug_no_video', 'No video: Instant Replay is off') });
    else parts.push({ rank: 3, text: t('bug_no_video_now', 'No video: Instant Replay was not recording') });
    if (d.screenshot === false) parts.push({ rank: 2, text: t('bug_no_shot', 'No screenshot') });
    const logs = Math.max(0, Math.trunc(Number(d.logs) || 0));
    if (d.logsMissing === true) parts.push({ rank: 1, text: t('bug_logs_missing', 'Log folder not found') });
    else if (logs) parts.push({ rank: 5, text: logs === 1 ? t('bug_log_one', '1 log') : t('bug_logs', '{n} logs').replace('{n}', String(logs)) });
    if (d.folderMissing === true) parts.push({ rank: 0, text: t('bug_folder_missing', 'Your folder is not there, saved in Documents') });
    const kept = new Set([...parts].sort((a, b) => a.rank - b.rank).slice(0, 2));
    const message = parts.filter((p) => kept.has(p)).map((p) => p.text).join(' · ');
    const app = String(d.app || '');
    return {
      type: 'success',
      kicker: app && app !== 'Desktop' ? app : t('deck_act_bugReport', 'Bug report'),
      title: t('bug_saved', 'Bug report saved'),
      message,
      actions: [{ label: t('shot_show', 'Show'), primary: true, onClick: () => run({ type: 'bugReport', mode: 'reveal' }) }],
      important: true,
    };
  }

  // A copy with private data painted over (capabilities/screen-cover.js): how
  // many spots, and a reminder that names and faces are not found.
  function coverToast(d) {
    return {
      type: 'success',
      kicker: t('deck_act_screenCover', 'Cover private data'),
      title: t('cover_done', 'Covered {n}, copy saved').replace('{n}', String(d.covered)),
      message: t('cover_check', 'Names and faces are not found: check the copy'),
      actions: actionsFor(d, 'screenshot'),
      important: true,
    };
  }

  // The colour picker and the ruler: what went on the clipboard, shown as is
  // (a colour or a size, never screen content), so it can be read off too.
  function inspectToast(d) {
    const color = d.kind === 'color';
    const value = String(d.text || '').slice(0, 40);
    const base = {
      kicker: color ? t('deck_act_screenColor', 'Color picker') : t('deck_act_screenMeasure', 'Ruler'),
      important: true,
      ...(value ? { message: value } : {}),
    };
    if (d.copied !== true) return { ...base, type: 'warning', title: t('inspect_not_copied', 'The clipboard was busy, not copied') };
    return { ...base, type: 'success', title: color ? t('color_copied', 'Color copied') : t('measure_copied', 'Size copied') };
  }

  // Text from the screen: how much went on the clipboard, never the text.
  function textToast(d) {
    const lines = Math.max(0, Math.trunc(Number(d.lines) || 0));
    const base = { kicker: t('deck_act_screenText', 'Copy text from screen'), important: true };
    if (!lines) return { ...base, type: 'info', title: t('text_none', 'No text found') };
    if (d.copied !== true) return { ...base, type: 'warning', title: t('text_not_copied', 'Text read, but the clipboard was busy') };
    const count = lines === 1 ? t('text_one_line', '1 line') : t('text_lines', '{n} lines').replace('{n}', String(lines));
    return { ...base, type: 'success', title: t('text_copied', 'Text copied'), message: count };
  }

  // Instant Replay records all the time while it is on, so its start is said
  // out loud (like ShadowPlay's "Instant Replay is on"), once: a restart for a
  // changed option within a few minutes stays quiet. A failure is said once
  // per reason; the replay retries by itself.
  const REPLAY_QUIET_MS = 10 * 60 * 1000;
  const REPLAY_FAILED = {
    no_encoder: ['replay_no_encoder', 'This PC has no video encoder'],
    unsupported: ['replay_no_encoder', 'This PC has no video encoder'],
    disk_full: ['rec_disk_full', 'The disk is full'],
  };
  const replaySeen = { on: null, error: '', toldAt: 0 };

  function onReplay(d) {
    if (!d || typeof d !== 'object') return;
    const was = replaySeen.on;
    replaySeen.on = d.on === true;
    // A seed (a dashboard that just connected) only learns the state.
    if (d.seed === true || quiet()) { replaySeen.error = String(d.error || ''); return; }
    if (d.on === true && was === false && Date.now() - replaySeen.toldAt > REPLAY_QUIET_MS) {
      replaySeen.toldAt = Date.now();
      window.XenonToast.show({
        type: 'info',
        title: t('replay_on', 'Instant Replay on'),
        message: t('replay_on_msg', 'Keeping the last {time}').replace('{time}', clock(d.kept || d.seconds)),
      });
    }
    const error = d.on === true ? '' : String(d.error || '');
    if (error && error !== replaySeen.error && d.enabled === true) {
      const why = REPLAY_FAILED[error];
      window.XenonToast.show({
        type: 'error',
        title: t('replay_failed', 'Instant Replay could not start'),
        message: why ? t(why[0], why[1]) : t('replay_retry', 'Xenon tries again by itself'),
      });
    }
    replaySeen.error = error;
  }

  // A bookmark dropped on the recording or replay (SSE `capture_marker`): a
  // short "Moment marked", with the time when a recording runs. The automatic
  // ones (stutters) say nothing: they would interrupt the game they mark.
  function onMarker(d) {
    if (!d || typeof d !== 'object' || quiet()) return;
    const at = Number(d.at);
    window.XenonToast.show({
      type: 'success',
      title: t('marker_added', 'Moment marked'),
      message: Number.isFinite(at) ? clock(at) : '',
      duration: 2500,
    });
  }

  // One "Recording" card that stays while the recording runs: it is the
  // indicator, and its Stop is the quickest way out.
  function onRecording(d) {
    if (!d || typeof d !== 'object' || quiet()) return;
    if (d.on !== true) {
      if (recToast) window.XenonToast.dismiss(recToast);
      recToast = 0;
      if (d.error === 'too_short') window.XenonToast.show({ type: 'error', title: t('rec_too_short', 'Empty recording, not saved') });
      return;
    }
    if (recToast) return;
    const lapse = Number(d.every) > 0;
    const notes = [lapse ? t('lapse_on_msg', 'One picture every {n} s, no sound').replace('{n}', String(Math.trunc(Number(d.every)))) : '', startNotes(d)];
    recToast = window.XenonToast.show({
      type: 'info',
      title: lapse ? t('lapse_on', 'Timelapse running') : t('rec_on', 'Recording'),
      message: notes.filter(Boolean).join(' · '),
      duration: 0,
      actions: [{ label: t('rec_stop', 'Stop'), primary: true, onClick: () => run({ type: lapse ? 'timelapse' : 'record', mode: 'stop' }) }],
    }) || 0;
  }

  // One "Recording steps" card while the steps recorder runs, with Stop. The
  // pill on the screen counts; the card only says that clicks are being kept.
  function onSteps(d) {
    if (!d || typeof d !== 'object' || quiet()) return;
    if (d.on !== true) {
      if (stepsToast) window.XenonToast.dismiss(stepsToast);
      stepsToast = 0;
      if (d.error === 'no_steps') window.XenonToast.show({ type: 'info', title: t('steps_none', 'No clicks, nothing saved') });
      else if (d.error) window.XenonToast.show({ type: 'error', title: t('steps_failed', 'The steps could not be saved') });
      return;
    }
    if (stepsToast) return;
    stepsToast = window.XenonToast.show({
      type: 'info',
      title: t('steps_on', 'Recording steps'),
      message: t('steps_on_msg', 'Every click is a step. What you type is not recorded.'),
      duration: 0,
      actions: [{ label: t('rec_stop', 'Stop'), primary: true, onClick: () => run({ type: 'steps', mode: 'stop' }) }],
    }) || 0;
  }

  const EXPORT_KINDS = {
    vertical: ['capg_exp_vertical', 'Vertical 9:16'], fit: ['capg_exp_fit', 'Smaller'], gif: ['capg_exp_gif', 'GIF'],
  };

  // A copy for sharing asked by a key or by Bit (capabilities/export.js): one
  // card with Stop while it is made, then "Copy ready" with Open. A copy made
  // from the gallery is followed there, so nothing shows here for it.
  function onExport(d) {
    if (!d || typeof d !== 'object' || d.from !== 'action' || quiet()) return;
    const M = window.CaptureGalleryModel;
    const [kk, kf] = EXPORT_KINDS[d.kind] || EXPORT_KINDS.vertical;
    if (!d.done) {
      if (exportToast) return;
      exportToast = window.XenonToast.show({
        type: 'info',
        title: t('capg_exp_making', 'Making the copy'),
        message: t(kk, kf),
        duration: 0,
        actions: [{ label: t('capg_exp_stop', 'Stop'), primary: true, onClick: () => apiJson('/captures/export-cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }) }],
      }) || 0;
      return;
    }
    if (exportToast) window.XenonToast.dismiss(exportToast);
    exportToast = 0;
    if (d.ok && d.newId) {
      const size = M ? M.megabytes(d.bytes, document.documentElement.lang) : '';
      window.XenonToast.show({
        type: 'success',
        kicker: t(kk, kf),
        title: t('capg_exp_done', 'Copy ready: {size}').replace('{size}', size),
        actions: [{
          label: t('capg_open', 'Open'), primary: true,
          onClick: () => (window.CaptureGallery ? window.CaptureGallery.open({ id: d.newId }) : run({ type: 'gallery', filter: 'video', id: d.newId })),
        }],
        important: true,
      });
    } else if (d.error === 'cancelled') {
      window.XenonToast.show({ type: 'info', title: t('capg_exp_stopped', 'Stopped, no file was made') });
    } else {
      const [ek, ef] = M ? M.exportErrorText(d.error) : ['capg_err_failed', 'That did not work, try again'];
      window.XenonToast.show({ type: 'error', title: t('capg_exp_failed', 'The copy could not be made'), message: t(ek, ef) });
    }
  }

  window.CaptureToast = { onCapture, onRecording, onSteps, onReplay, onExport, onMarker, clock, recordingMessage, startNotes };
})();
