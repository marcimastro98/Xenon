'use strict';
// "Export" in the gallery's viewer (js/capture-gallery-viewer.js loads this on
// the first tap; on the PC or a paired phone): a copy of the video made for sharing, beside the
// original, which stays as it is (server: capture-export.js).
//   Vertical 9:16: which part of the picture to keep, and "Webcam on top" when
//                  the recording has a webcam bubble (the face above, the game
//                  below).
//   Smaller:       fits a size (10 to 100 MB), for a chat's upload limit.
//   GIF:           no sound, long side 480 px; a long clip is warned about
//                  before (it may come out heavy), never refused.
// The copy takes seconds to a minute: the progress comes over SSE
// `capture_export`, "Stop" leaves nothing on disk.
(function () {
  const el = (tag, cls, text) => makeEl(tag, cls, text);
  const KINDS = [['vertical', 'capg_exp_vertical', 'Vertical 9:16'], ['fit', 'capg_exp_fit', 'Smaller'], ['gif', 'capg_exp_gif', 'GIF']];
  const FOCUS = [['left', 'capg_exp_left', 'Left'], ['center', 'capg_exp_center', 'Centre'], ['right', 'capg_exp_right', 'Right']];

  // A row of choices, one pressed: [value, key, fallback] items.
  function choices(o, label, items, value, onPick) {
    const row = el('div', 'capg-exp-row');
    if (label) row.appendChild(el('span', 'capg-exp-label', label));
    const seg = el('div', 'capg-exp-seg');
    seg.setAttribute('role', 'group');
    if (label) seg.setAttribute('aria-label', label);
    for (const [v, k, fb] of items) {
      const b = el('button', 'capg-exp-opt', k ? o.tr(k, fb) : fb);
      b.type = 'button';
      b.setAttribute('aria-pressed', v === value ? 'true' : 'false');
      b.addEventListener('click', () => onPick(v));
      seg.appendChild(b);
    }
    row.appendChild(seg);
    return row;
  }

  // opts: host (the viewer's actions row), entry, url(path), tr(key, fallback),
  // M (CaptureGalleryModel), post(path, body), onDone(newId, note), onClose().
  function open(opts) {
    const o = opts;
    const e = o.entry;
    const M = o.M;
    const pick = { kind: 'vertical', focus: 'center', webcam: !!e.webcam, mb: M.EXPORT_SIZES_MB[0] };
    let working = false;
    let starting = false;
    let closed = false;
    const status = el('div', 'capg-note capg-exp-status');
    status.setAttribute('role', 'status');
    const bar = el('div', 'capg-exp-bar');
    const fill = bar.appendChild(el('div', 'capg-exp-fill'));

    const say = (text, bad) => { status.textContent = text || ''; status.classList.toggle('is-bad', !!bad); };
    const sayError = (code) => { const [k, fb] = M.exportErrorText(code); say(o.tr(k, fb), true); };

    function note() {
      if (pick.kind === 'gif' && M.gifIsLong(e)) return [o.tr('capg_exp_gif_long', 'A long clip: the GIF may come out heavy. Trim it first if needed.'), true];
      if (pick.kind === 'gif') return [o.tr('capg_exp_note_gif', 'No sound, long side 480 px. The original stays.')];
      if (pick.kind === 'fit') return [o.tr('capg_exp_note_fit', 'To send it in a chat. The original stays.')];
      return [o.tr('capg_exp_note_vertical', 'For TikTok, Shorts and Reels. The original stays.')];
    }

    function paint() {
      o.host.replaceChildren();
      o.host.classList.add('is-trim');
      if (working) {
        const row = el('div', 'capg-trim-row');
        row.appendChild(button('capg_exp_stop', 'Stop', '', stop));
        o.host.append(bar, status, row);
        return;
      }
      o.host.appendChild(choices(o, '', KINDS, pick.kind, (v) => { pick.kind = v; say(''); paint(); }));
      if (pick.kind === 'vertical') {
        o.host.appendChild(choices(o, o.tr('capg_exp_keep', 'Keep'), FOCUS, pick.focus, (v) => { pick.focus = v; paint(); }));
        if (e.webcam) {
          o.host.appendChild(choices(o, o.tr('capg_exp_webcam', 'Webcam on top'),
            [[true, 'capg_exp_yes', 'Yes'], [false, 'capg_exp_no', 'No']], pick.webcam, (v) => { pick.webcam = v; paint(); }));
        }
      }
      if (pick.kind === 'fit') {
        o.host.appendChild(choices(o, o.tr('capg_exp_size', 'Up to'),
          M.EXPORT_SIZES_MB.map(mb => [mb, '', mb + ' MB']), pick.mb, (v) => { pick.mb = v; paint(); }));
      }
      const [text, warn] = note();
      const n = el('div', 'capg-note' + (warn ? ' is-warn' : ''), text);
      const row = el('div', 'capg-trim-row');
      row.append(button('capg_exp_save', 'Make the copy', 'ui-btn--primary', start), button('capg_cancel', 'Cancel', '', close));
      o.host.append(n, status, row);
    }

    function button(key, fb, cls, onClick) {
      const b = el('button', 'ui-btn ' + (cls || 'ui-btn--secondary'), o.tr(key, fb));
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    }

    function progress(pct) {
      const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      fill.style.width = p + '%';
      say(o.tr('capg_exp_working', 'Making the copy… {pct}%').replace('{pct}', String(p)));
    }

    async function start() {
      if (working || starting) return;
      starting = true;
      o.host.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const body = { id: e.id, kind: pick.kind };
      if (pick.kind === 'vertical') Object.assign(body, { focus: pick.focus, webcam: !!e.webcam && pick.webcam });
      if (pick.kind === 'fit') body.mb = pick.mb;
      const r = await o.post('/captures/export', body);
      starting = false;
      if (closed) return;
      if (!r || r.ok !== true) {
        o.host.querySelectorAll('button').forEach(b => { b.disabled = false; });
        sayError(r && r.error);
        return;
      }
      working = true;
      paint();
      progress(0);
    }

    async function stop() {
      const r = await o.post('/captures/export-cancel', {});
      if (!closed && (!r || r.ok !== true)) sayError(r && r.error);
    }

    // SSE `capture_export` for this video: progress, then the end.
    function onState(ev) {
      if (closed || !ev || ev.id !== e.id) return;
      if (!ev.done) {
        if (!working && !starting) { working = true; paint(); } // started from this gallery on another screen
        if (working) progress(ev.pct);
        return;
      }
      if (!working) return;
      working = false;
      if (ev.ok && ev.newId) {
        const text = o.tr('capg_exp_done', 'Copy ready: {size}').replace('{size}', M.megabytes(ev.bytes, document.documentElement.lang));
        close();
        o.onDone(ev.newId, text);
        return;
      }
      paint();
      if (ev.error === 'cancelled') say(o.tr('capg_exp_stopped', 'Stopped, no file was made'));
      else sayError(ev.error);
    }

    function close() {
      if (closed) return;
      closed = true;
      o.onClose();
    }

    paint();
    const first = o.host.querySelector('.capg-exp-opt[aria-pressed="true"]');
    if (first) first.focus();
    return { close, onState, busy: () => working || starting };
  }

  window.CaptureExport = { open };
})();
