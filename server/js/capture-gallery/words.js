// What the gallery of captures says and the small parts it is drawn from: the names of the kinds
// and of a day, the time of a capture, a key, the line shown when there is nothing, the grey tiles
// shown while it loads, the mark of the chosen row, and what this engine can play.
'use strict';

(() => {
  const PAGE = 60;
  const PLACEHOLDERS = 8;
  const KIND_ROWS = {
    '': ['capg_filter_all', 'All', 'gallery'],
    video: ['capg_filter_video', 'Videos', 'video'],
    screenshot: ['capg_filter_shot', 'Screenshots', 'screenshot'],
  };

  const tr = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : k;
    return v === k && fb != null ? fb : v;
  };
  const el = makeEl;

  function kindLabel(e) {
    if (e.kind === 'gif') return 'GIF'; // the format's name in every language
    return e.kind === 'screenshot' ? tr('capg_kind_screenshot', 'Screenshot')
      : e.kind === 'replay' ? tr('capg_kind_replay', 'Replay') : tr('capg_kind_recording', 'Recording');
  }

  function timeOf(ms) {
    try { return new Date(ms).toLocaleTimeString([], timeParts()); } catch { return ''; }
  }

  function dayTitle(group) {
    if (group.when === 'today') return tr('capg_today', 'Today');
    if (group.when === 'yesterday') return tr('capg_yesterday', 'Yesterday');
    try {
      const day = new Date(group.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      return day.charAt(0).toLocaleUpperCase() + day.slice(1);
    } catch { return group.key; }
  }

  function key(text, onClick, cls) {
    const b = el('button', 'capg-key' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // A line in the middle of the page, with at most one key under it.
  function status(text, act) {
    const box = el('div', 'cgal-status capg-status', text);
    if (act) box.appendChild(act);
    return box;
  }

  // The page's shape until the first answer comes.
  function placeholders() {
    const grid = el('div', 'capg-grid');
    grid.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < PLACEHOLDERS; i += 1) grid.appendChild(el('span', 'capg-thumb'));
    return grid;
  }

  function markRow(row, on) {
    row.classList.toggle('on', on);
    row.setAttribute('aria-pressed', String(on));
  }

  // A reply without `can` (an older server) keeps every button, as before.
  function engineCan(c) {
    const o = c && typeof c === 'object' ? c : {};
    return {
      export: o.export !== false, cover: o.cover !== false, speech: o.speech !== false,
      trim: o.trim !== false, copy: o.copy !== false,
    };
  }

  window.CaptureGalleryWords = {
    PAGE, KIND_ROWS, tr, el, kindLabel, timeOf, dayTitle, key, status, placeholders, markRow,
    engineCan,
  };
})();
