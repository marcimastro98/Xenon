// What a Deck key says after it worked, when nothing on screen would show it.
//
// Only for keys whose effect cannot be seen: a note on a key that opens a sheet
// or moves a widget would repeat what is already in front of you. Capture keys
// have their own cards (capture-toast.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckDoneText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const QUIET_MODES = Object.freeze(['always', 'auto', 'off']);
  const COPY_FOLDERS = Object.freeze(['desktop', 'downloads', 'documents', 'pictures', 'videos']);
  const FOLDER_FALLBACK = Object.freeze({
    desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures', videos: 'Videos',
  });

  function dndNote(data, tt) {
    if (!QUIET_MODES.includes(data.quiet)) return null;
    // `important`: the key may have just turned quiet on, and it must still answer.
    return {
      type: 'info', important: true, duration: 3000,
      kicker: tt('deck_act_dnd', 'Do not disturb'),
      title: tt('settings_notif_quiet_' + data.quiet, data.quiet),
    };
  }

  function copyNote(data, tt) {
    if (!COPY_FOLDERS.includes(data.folder)) return null;
    const folder = tt('deck_opt_copy_' + data.folder, FOLDER_FALLBACK[data.folder]);
    return {
      type: 'info', important: true, duration: 3600,
      title: tt('deck_done_copied', 'Copied to {folder}').replace('{folder}', folder),
      message: String(data.name || ''),
    };
  }

  function sendNote(data, tt) {
    return {
      type: 'info', important: true, duration: 3600,
      title: tt('capg_sent', 'Sent: it is on your phone in File transfer'),
      message: String(data.name || ''),
    };
  }

  function clipsNote(data, tt) {
    const n = Number(data.clips) || 0;
    if (n < 1) return null;
    const count = String(n);
    let title = n === 1
      ? tt('capg_clips_one', '1 clip made, next to the video')
      : tt('capg_clips_done', '{n} clips made, next to the video').replace('{n}', count);
    if (data.stopped) {
      title = tt('capg_clips_part', '{n} of {of} clips made, then it stopped')
        .replace('{n}', count).replace('{of}', String(Number(data.of) || n));
    }
    return { type: 'info', important: true, duration: 3600, title };
  }

  const NOTES = Object.freeze({ dnd: dndNote, copyCapture: copyNote, sendCapture: sendNote, markClips: clipsNote });

  // The toast for a key that just worked, or null when it has nothing to add.
  function note(action, data, tt) {
    const make = action && Object.prototype.hasOwnProperty.call(NOTES, action.type) ? NOTES[action.type] : null;
    return make && data ? make(data, tt) : null;
  }

  return { note };
});
