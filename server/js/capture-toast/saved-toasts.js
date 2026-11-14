// The toast each kind of capture gets once it is saved: a timelapse, a steps document, a bug
// report, a copy with private data covered, a colour or a size, and text from the screen, with the
// buttons that open it or show its folder.
'use strict';

(() => {
  // apiJson (utils.js): the page's global `api` is the Deck store's object
  // (deck-store.js), not a function, so calling it threw and every button here
  // did nothing.
  function run(body) {
    apiJson('/actions/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

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

  // "Open" shows the capture in the gallery on this screen; "Show" opens its
  // folder on the PC (the only action when the gallery is not loaded).
  function actionsFor(d, type) {
    const show = { label: t('shot_show', 'Show'), onClick: () => run({ type, mode: 'reveal' }) };
    if (!d.id || !window.CaptureGallery) return [{ ...show, primary: true }];
    return [{ label: t('capg_open', 'Open'), primary: true, onClick: () => window.CaptureGallery.open({ id: d.id }) }, show];
  }

  // A timelapse: how long it watched and how long the video plays.
  function lapseSavedToast(d) {
    // A video under a second would read "in 0:00", as if nothing had been saved.
    const span = Number(d.seconds) >= 1
      ? t('lapse_span', '{span} in {video}').replace('{span}', clock(d.span)).replace('{video}', clock(d.seconds))
      : clock(d.span);
    const parts = [span];
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

  window.CaptureToastSavedToasts = {
    run, clock, recordingMessage, actionsFor, lapseSavedToast, stepsSavedToast, bugReportToast,
    coverToast, inspectToast, textToast,
  };
})();
