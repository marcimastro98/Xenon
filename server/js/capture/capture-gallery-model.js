'use strict';
// The gallery's pure parts (js/capture-gallery.js draws them): captures
// grouped by day, the times on the trim bar, the trim range the handles allow,
// and the words for an error code. No DOM, so node:test runs it as is.
(function () {
  // Shorter than this is a slip of the handles (the server says too_short).
  const MIN_TRIM_S = 0.5;
  const KINDS = ['screenshot', 'recording', 'replay', 'gif'];
  const VIDEO_KINDS = ['recording', 'replay'];
  // What each filter button shows (the server reads the same names).
  const FILTERS = ['', 'video', 'screenshot'];
  // "Export": the sizes a smaller copy can fit (capture-export.js FIT_SIZES_MB),
  // and the length past which a GIF is worth a warning (it has no fixed limit).
  const EXPORT_SIZES_MB = [10, 25, 50, 100];
  const GIF_LONG_S = 15;

  const pad = n => String(n).padStart(2, '0');

  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Newest first in, newest first out: [{ key, when, at, items }], `when`
  // 'today', 'yesterday' or 'date' (`at` is the first item's time, for the
  // date line).
  function groupByDay(entries, now) {
    const today = dayKey(now);
    const yesterday = dayKey(new Date(now).setDate(new Date(now).getDate() - 1));
    const groups = [];
    for (const e of entries || []) {
      if (!e || !Number.isFinite(e.createdAt)) continue;
      const key = dayKey(e.createdAt);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        g = { key, when: key === today ? 'today' : key === yesterday ? 'yesterday' : 'date', at: e.createdAt, items: [] };
        groups.push(g);
      }
      g.items.push(e);
    }
    return groups;
  }

  // "1:05" for a clip length on a preview, "1:05.4" on the trim bar.
  function stamp(seconds, tenths) {
    const v = Math.max(0, Number(seconds) || 0);
    const whole = tenths ? Math.floor(v) : Math.round(v);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const head = h ? `${h}:${pad(m)}` : String(m);
    return `${head}:${pad(s)}${tenths ? '.' + Math.floor((v - whole) * 10) : ''}`;
  }

  // The handles' range after one of them moved to `value`: inside the clip,
  // and never closer than MIN_TRIM_S (the other handle is pushed back first,
  // so the moved one goes where the finger is).
  function clampRange(range, which, value, duration) {
    const len = Math.max(0, Number(duration) || 0);
    const v = Math.min(len, Math.max(0, Number(value) || 0));
    let { start, end } = range;
    if (which === 'start') {
      start = Math.min(v, Math.max(0, len - MIN_TRIM_S));
      end = Math.max(end, Math.min(len, start + MIN_TRIM_S));
    } else {
      end = Math.max(v, Math.min(len, MIN_TRIM_S));
      start = Math.min(start, Math.max(0, end - MIN_TRIM_S));
    }
    return { start, end };
  }

  // A trim that keeps everything is not a trim.
  const trimChanges = (range, duration) => range.start > 0.05 || range.end < (Number(duration) || 0) - 0.05;

  // [key, fallback] for a server error code; unknown codes get the plain one.
  const ERRORS = {
    busy: ['capg_err_busy', 'Another trim is running, try again in a moment'],
    too_short: ['capg_err_too_short', 'Pick at least half a second'],
    empty: ['capg_err_too_short', 'Pick at least half a second'],
    disk_full: ['capg_err_disk_full', 'The disk is full'],
    unavailable: ['capg_err_unavailable', 'Screenshots and recordings are not available on this PC'],
    not_found: ['capg_err_not_found', 'The file is not there any more'],
    copy_failed: ['capg_err_copy', 'Another app is using the clipboard, try again'],
    delete_failed: ['capg_err_delete', 'It could not be deleted: is the file open in another app?'],
    too_many: ['pin_err_too_many', 'There are already 24 widgets on the screen: take one away first'],
    not_a_picture: ['deck_err_not_a_picture', 'That one is a video, not a picture: pick a screenshot'],
    not_picture: ['deck_err_not_a_picture', 'That one is a video, not a picture: pick a screenshot'],
    no_marks: ['capg_clips_err_none', 'This video has no marks'],
    whole_video: ['capg_clips_err_whole', 'The video is already as short as a clip'],
  };
  const errorText = code => ERRORS[code] || ['capg_err_failed', 'That did not work, try again'];

  // "To phone" (capture-send.js on the server).
  const SEND_ERRORS = {
    no_phone: ['capg_send_err_phone', 'No phone is paired: pair one in Settings, Phone'],
    disabled: ['capg_send_err_off', 'File transfer is off: turn it on in Settings, Phone'],
    too_big: ['capg_send_err_big', 'Too big for the file transfer: trim it or make a lighter copy'],
    quota: ['capg_send_err_full', 'The file transfer is full: take some files out of its list'],
    no_space: ['xfer_failed_space', 'There is no space left on the PC.'],
    busy: ['capg_send_err_busy', 'Other files are on their way, try again in a moment'],
  };
  const sendErrorText = code => SEND_ERRORS[code] || errorText(code);

  // An export's own errors (busy means another export here, not a trim).
  const EXPORT_ERRORS = {
    busy: ['capg_exp_err_busy', 'Another copy is being made, try again when it is done'],
    too_long: ['capg_exp_err_too_long', 'Too long for that size: pick a bigger one or trim it first'],
    too_big: ['capg_exp_err_too_big', 'The GIF went over 256 MB: trim the clip first'],
    no_webcam: ['capg_exp_err_no_webcam', 'This video has no webcam'],
    already_small: ['capg_exp_err_small', 'It is already smaller than that: send it as it is'],
  };
  const exportErrorText = code => EXPORT_ERRORS[code] || errorText(code);

  // A long clip makes a heavy GIF: said before, never refused.
  const gifIsLong = e => !!e && Number(e.seconds) > GIF_LONG_S;

  // "23.1 MB" in the user's number format.
  function megabytes(bytes, locale) {
    const mb = Math.max(0, Number(bytes) || 0) / 1e6;
    try { return mb.toLocaleString(locale || undefined, { maximumFractionDigits: 1 }) + ' MB'; } catch { return mb.toFixed(1) + ' MB'; }
  }

  const isVideo = e => !!e && VIDEO_KINDS.includes(e.kind);

  // The moments shown under a video (server/capture-markers.js): the user's
  // bookmarks first when there are too many to show, then in time order.
  const MARKS_SHOWN = 12;
  const MARK_KINDS = Object.freeze(['mark', 'stutter']);
  // A jump lands a little before the moment, so it is seen happening.
  const MARK_LEAD_S = 2;
  function marksOf(e) {
    if (!isVideo(e) || !Array.isArray(e.markers)) return [];
    const valid = e.markers.filter(m => m && MARK_KINDS.includes(m.kind) && Number.isFinite(m.at) && m.at >= 0);
    const mine = valid.filter(m => m.kind === 'mark');
    const kept = mine.concat(valid.filter(m => m.kind !== 'mark')).slice(0, MARKS_SHOWN);
    return kept.sort((a, b) => a.at - b.at).map(m => ({ at: m.at, kind: m.kind }));
  }
  const seekFor = at => Math.max(0, (Number(at) || 0) - MARK_LEAD_S);

  // A game's folder label from what the index stored ("Game.exe" → "Game").
  const gameLabel = g => String(g || '').replace(/\.exe$/i, '');

  const exported = {
    MIN_TRIM_S, KINDS, VIDEO_KINDS, FILTERS, EXPORT_SIZES_MB, GIF_LONG_S, MARKS_SHOWN, MARK_LEAD_S,
    marksOf, seekFor, dayKey, groupByDay, stamp, clampRange, trimChanges, errorText, sendErrorText, exportErrorText, gifIsLong, megabytes, isVideo, gameLabel,
  };
  if (typeof window !== 'undefined') window.CaptureGalleryModel = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
