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

  const {
    run, clock, recordingMessage, actionsFor, lapseSavedToast, stepsSavedToast, bugReportToast,
    coverToast, inspectToast, textToast,
  } = window.CaptureToastSavedToasts;

  const quiet = () => !window.XenonToast || (typeof isLayerPage === 'function' && isLayerPage());

  // The game names it; the file name would only repeat the game and the time.
  // The size says which monitor it took, when they differ.
  function shotNote(d) {
    if (d.folderMissing === true) return { message: t('shot_folder_missing', 'Your folder is not there, saved in Pictures') };
    return d.width > 0 && d.height > 0 ? { message: d.width + ' × ' + d.height } : {};
  }

  const kickerOf = (d, key, fallback) => String(d.game || '').replace(/\.exe$/i, '') || t(key, fallback);

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
        ...shotNote(d),
        // On the card and on the menu's result line: what it took.
        ...(d.id ? { image: '/captures/thumb?id=' + encodeURIComponent(d.id) } : {}),
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
      important: true, // the answer to a press, and a game is where it is pressed
    });
  }

  // Started with the engine's pill on the screen: the pill is the indicator and
  // has its own Stop, so only something the user must know is said.
  function pillNote(d) {
    if (d.seed === true) return;
    const note = startNotes(d);
    if (note) window.XenonToast.show({ type: 'warning', title: note, duration: 6000 });
  }

  // Without a pill (turned off, or an engine that draws none) one "Recording"
  // card stays while it runs: it is the indicator, and its Stop the way out.
  function onRecording(d) {
    if (!d || typeof d !== 'object' || quiet()) return;
    if (d.on !== true) {
      if (recToast) window.XenonToast.dismiss(recToast);
      recToast = 0;
      if (d.error === 'too_short') window.XenonToast.show({ type: 'error', title: t('rec_too_short', 'Empty recording, not saved') });
      return;
    }
    if (d.pill === true) { pillNote(d); return; }
    if (recToast) return;
    const lapse = Number(d.every) > 0;
    const notes = [lapse ? t('lapse_on_msg', 'One picture every {n} s, no sound').replace('{n}', String(Math.trunc(Number(d.every)))) : '', startNotes(d)];
    recToast = window.XenonToast.show({
      type: 'info',
      title: lapse ? t('lapse_on', 'Timelapse running') : t('rec_on', 'Recording'),
      message: notes.filter(Boolean).join(' · '),
      duration: 0,
      important: true, // the only indicator: a game must not swallow it
      actions: [{ label: t('rec_stop', 'Stop'), primary: true, onClick: () => run({ type: lapse ? 'timelapse' : 'record', mode: 'stop' }) }],
    }) || 0;
  }

  // One "Recording steps" card with Stop where no pill on the screen says it.
  function onSteps(d) {
    if (!d || typeof d !== 'object' || quiet()) return;
    if (d.on !== true) {
      if (stepsToast) window.XenonToast.dismiss(stepsToast);
      stepsToast = 0;
      if (d.error === 'no_steps') window.XenonToast.show({ type: 'info', title: t('steps_none', 'No clicks, nothing saved'), important: true });
      else if (d.error) window.XenonToast.show({ type: 'error', title: t('steps_failed', 'The steps could not be saved') });
      return;
    }
    if (stepsToast || d.pill === true) return;
    stepsToast = window.XenonToast.show({
      type: 'info',
      title: t('steps_on', 'Recording steps'),
      message: t('steps_on_msg', 'Every click is a step. What you type is not recorded.'),
      important: true,
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
        important: true,
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
      window.XenonToast.show({ type: 'info', title: t('capg_exp_stopped', 'Stopped, no file was made'), important: true });
    } else {
      const [ek, ef] = M ? M.exportErrorText(d.error) : ['capg_err_failed', 'That did not work, try again'];
      window.XenonToast.show({ type: 'error', title: t('capg_exp_failed', 'The copy could not be made'), message: t(ek, ef) });
    }
  }

  window.CaptureToast = { onCapture, onRecording, onSteps, onReplay, onExport, onMarker, clock, recordingMessage, startNotes };
})();
