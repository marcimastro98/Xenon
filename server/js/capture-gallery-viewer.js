'use strict';
// The gallery's viewer (js/capture-gallery.js opens it over its grid): one
// capture full size, ←/→ through the list, Esc back to the grid.
//   PC:    Trim (videos), Edit (pictures: js/capture-annotate.js, loaded on
//          first use), Copy (the file, as Explorer copies it), Show in folder,
//          Delete (a second tap confirms).
//   Phone: Download, and new copies (Trim, Export, Transcript); Copy, Show in
//          folder and Delete act on the PC's files and stay the PC's.
//   Videos: Transcript (js/capture-transcript-view.js, loaded on first use):
//          written down on the PC, from it or a phone. Export (
//          js/capture-export-view.js): a vertical, smaller or GIF copy.
// Trim: two handles on a bar under the video, each seeking the video to where
// it is; "Save trimmed copy" writes a NEW capture beside the original (the
// engine copies the streams from the keyframe at or before the start, so it is
// instant and lossless, and starts at most 1 s earlier than asked).
(function () {
  const M = window.CaptureGalleryModel;
  const tr = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : k;
    return v === k && fb != null ? fb : v;
  };
  const el = makeEl;
  const S0 = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const ICONS = {
    back: S0 + '<path d="M15 5l-7 7 7 7"/></svg>',
    next: S0 + '<path d="M9 5l7 7-7 7"/></svg>',
    mark: S0 + '<path d="M7 4h10v16l-5-3.5L7 20z"/></svg>',
    stutter: S0 + '<path d="M3 12h4l2-6 3 12 2-6h7"/></svg>',
  };
  const DELETE_ARM_MS = 4000;
  const EDITOR_FILES = ['js/capture-annotate-model.js', 'js/capture-annotate.js'];
  let editorLoad = null;
  const scripts = new Map(); // src → Promise<boolean>

  // A panel's script, once per page (`ready` says it is already there); false when it fails.
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve(true);
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = src;
        s.addEventListener('load', () => resolve(true));
        s.addEventListener('error', () => { scripts.delete(src); resolve(false); });
        document.head.appendChild(s);
      }));
    }
    return scripts.get(src);
  }
  const loadTranscript = () => loadScript('js/capture-transcript-view.js', () => !!window.CaptureTranscript);
  const loadExport = () => loadScript('js/capture-export-view.js', () => !!window.CaptureExport);

  // The editor's script and style, once per page; false when they fail.
  function loadEditor() {
    if (window.CaptureAnnotate) return Promise.resolve(true);
    if (editorLoad) return editorLoad;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'components/CaptureGallery/CaptureAnnotate.css';
    document.head.appendChild(css);
    editorLoad = EDITOR_FILES.reduce((chain, src) => chain.then(ok => ok && new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.addEventListener('load', () => resolve(true));
      s.addEventListener('error', () => resolve(false));
      document.head.appendChild(s);
    })), Promise.resolve(true)).then((ok) => { if (!ok) editorLoad = null; return ok; });
    return editorLoad;
  }
  const STEP_S = 0.1;

  function iconBtn(name, label, onClick) {
    const b = el('button', 'cgal-iconbtn');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    const s = el('span', 'cgal-ic');
    s.innerHTML = ICONS[name]; // static constant markup only
    b.appendChild(s);
    b.addEventListener('click', onClick);
    return b;
  }

  function btn(text, cls, onClick) {
    const b = el('button', 'ui-btn ' + (cls || 'ui-btn--secondary'), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function post(url, path, body) {
    return apiJson(url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  // opts: host (the gallery's modal), entries, id, editable, remote,
  // can {export, cover, speech} (what this PC's engine does),
  // kindLabel(e), timeOf(ms), url(path), onClose(), onChanged(focusId),
  // askBit(text) or null (Bit's chat is not on this screen), note (a line to
  // show once, as "Copy ready").
  function open(opts) {
    const o = opts;
    const can = o.can || { export: true, cover: true, speech: true, trim: true, copy: true };
    let entries = o.entries.slice();
    let index = Math.max(0, entries.findIndex(e => e.id === o.id));
    let pending = false;
    let trim = null; // { start, end, duration } while trimming
    let disarm = 0;
    let editor = null; // the screenshot editor while it is open
    let words = null; // the transcript panel while it is open
    let exporting = null; // the export sheet while it is open

    const root = el('div', 'capg-viewer');
    const top = el('div', 'capg-vtop');
    const title = el('div', 'capg-vtitle');
    const name = el('div', 'capg-vname');
    const sub = el('div', 'capg-vsub');
    title.append(name, sub);
    top.append(iconBtn('back', tr('capg_back', 'Back to the gallery'), close), title);
    const stage = el('div', 'capg-stage');
    const prev = iconBtn('back', tr('capg_prev', 'Previous'), () => go(-1));
    const next = iconBtn('next', tr('capg_next', 'Next'), () => go(1));
    prev.classList.add('capg-nav', 'capg-nav-prev');
    next.classList.add('capg-nav', 'capg-nav-next');
    const marks = el('div', 'capg-marks');
    const actions = el('div', 'capg-actions');
    const say = el('div', 'capg-say');
    say.setAttribute('role', 'status');
    root.append(top, stage, marks, actions, say);
    o.host.appendChild(root);

    const current = () => entries[index];

    function tell(text, bad) {
      say.textContent = text || '';
      say.classList.toggle('is-bad', !!bad);
    }
    const tellError = (code) => { const [k, fb] = M.errorText(code); tell(tr(k, fb), true); };

    function media(e) {
      if (!M.isVideo(e)) {
        const img = el('img', 'capg-media');
        img.alt = e.name || '';
        img.src = o.url('/captures/file?id=' + encodeURIComponent(e.id));
        return img;
      }
      const v = el('video', 'capg-media');
      v.controls = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.src = o.url('/captures/file?id=' + encodeURIComponent(e.id));
      // While trimming, play only the part that will be kept.
      v.addEventListener('timeupdate', () => {
        if (trim && v.currentTime >= trim.end) { v.currentTime = trim.start; }
      });
      return v;
    }

    function paint() {
      const e = current();
      if (!e) { close(); return; }
      if (editor) { const ed = editor; editor = null; ed.close(); }
      if (words) { words.close(); words = null; }
      if (exporting) { const x = exporting; exporting = null; x.close(); }
      clearTimeout(disarm);
      trim = null;
      tell('');
      name.textContent = M.gameLabel(e.game) || tr('capg_desktop', 'Desktop');
      const bits = [o.kindLabel(e), o.timeOf(e.createdAt)];
      if (M.isVideo(e) && e.seconds) bits.push(M.stamp(e.seconds));
      if (e.width && e.height) bits.push(e.width + '×' + e.height);
      if (e.hdr) bits.push('HDR');
      sub.textContent = bits.join(', ');
      const old = stage.querySelector('video');
      if (old) { old.pause(); old.removeAttribute('src'); old.load(); }
      stage.replaceChildren(media(e));
      paintMarks(e);
      prev.disabled = index === 0;
      next.disabled = index >= entries.length - 1;
      if (entries.length > 1) stage.append(prev, next);
      paintActions();
    }

    // The video's bookmarks and stutters: one tap plays from just before it.
    function paintMarks(e) {
      const list = M.marksOf(e);
      marks.replaceChildren();
      marks.hidden = list.length === 0;
      for (const m of list) {
        const what = m.kind === 'stutter' ? tr('capg_mark_stutter', 'Stutter') : tr('capg_mark', 'Your mark');
        const b = el('button', 'capg-mark capg-mark-' + m.kind);
        b.type = 'button';
        b.title = what + ', ' + M.stamp(m.at);
        b.setAttribute('aria-label', b.title);
        const ic = el('span', 'cgal-ic');
        ic.innerHTML = ICONS[m.kind === 'stutter' ? 'stutter' : 'mark']; // static constant markup only
        b.append(ic, el('span', 'capg-mark-at', M.stamp(m.at)));
        b.addEventListener('click', () => {
          const v = stage.querySelector('video');
          if (!v) return;
          v.currentTime = M.seekFor(m.at);
          v.play().catch(() => { /* the user presses play */ });
        });
        marks.appendChild(b);
      }
    }

    function paintActions() {
      const e = current();
      actions.replaceChildren();
      actions.classList.remove('is-trim');
      root.classList.remove('is-trimming');
      if (o.remote) {
        const dl = el('a', 'ui-btn ui-btn--primary', tr('capg_download', 'Download'));
        dl.href = o.url('/captures/file?id=' + encodeURIComponent(e.id) + '&dl=1');
        dl.setAttribute('download', e.name || '');
        actions.appendChild(dl);
        // From a phone: new copies only (remote-access.js). Delete, copy to the
        // PC's clipboard and "Show in folder" act on the PC and stay there.
        if (M.isVideo(e)) {
          if (o.editable && can.trim) actions.appendChild(btn(tr('capg_trim', 'Trim'), '', startTrim));
          if (o.editable && can.trim && e.clips > 0) actions.appendChild(btn(tr('capg_clips', 'Clips from marks'), '', makeClips));
          if (o.editable && can.export) actions.appendChild(btn(tr('capg_exp_button', 'Export'), '', startExport));
          if (e.transcript || (o.editable && can.speech)) actions.appendChild(wordsButton());
        }
        return;
      }
      if (!o.editable) {
        actions.appendChild(el('span', 'capg-note', tr('capg_no_engine', 'Trim, copy and delete are not available on this PC right now.')));
        return;
      }
      if (M.isVideo(e)) {
        if (can.trim) actions.appendChild(btn(tr('capg_trim', 'Trim'), 'ui-btn--primary', startTrim));
        if (can.trim && e.clips > 0) actions.appendChild(btn(tr('capg_clips', 'Clips from marks'), '', makeClips));
        if (can.export) actions.appendChild(btn(tr('capg_exp_button', 'Export'), '', startExport));
        if (can.speech || e.transcript) actions.appendChild(wordsButton());
      }
      // Over every window, like a sticky picture (capabilities/screen-pin.js).
      // Only a still picture: the server refuses a GIF (not_a_picture).
      if (o.pinnable && e.kind === 'screenshot') actions.appendChild(btn(tr('shot_pin', 'Pin'), '', pin));
      if (e.kind === 'screenshot') actions.appendChild(btn(tr('capg_edit', 'Edit'), '', edit));
      if (can.copy) actions.appendChild(btn(tr('capg_copy', 'Copy'), '', () => act('/captures/copy', () => tell(tr('capg_copied', 'Copied: paste it into a chat, a mail or a folder')))));
      // Into the file transfer's list for the paired phone (capture-send.js).
      if (o.sendable) actions.appendChild(btn(tr('capg_send', 'To phone'), '', () => act('/captures/send', () => tell(tr('capg_sent', 'Sent: it is on your phone in File transfer')), M.sendErrorText)));
      actions.appendChild(btn(tr('capg_show', 'Show in folder'), '', () => act('/captures/reveal', () => tell(tr('capg_shown', 'Opened its folder on the PC')))));
      const del = btn(tr('capg_delete', 'Delete'), 'ui-btn--secondary capg-del', () => {
        if (!del.classList.contains('is-armed')) {
          del.classList.add('is-armed');
          del.textContent = tr('capg_delete_confirm', 'Tap again to delete');
          clearTimeout(disarm);
          disarm = setTimeout(() => { del.classList.remove('is-armed'); del.textContent = tr('capg_delete', 'Delete'); }, DELETE_ARM_MS);
          return;
        }
        clearTimeout(disarm);
        act('/captures/delete', () => {
          const after = entries[index + 1] || entries[index - 1];
          o.onChanged(after ? after.id : '');
        });
      });
      actions.appendChild(del);
    }

    // "Transcript": opens or closes the panel under the video.
    function wordsButton() {
      const b = btn(tr('capg_tx_button', 'Transcript'), 'capg-tx-btn', () => toggleWords(b));
      b.setAttribute('aria-pressed', words ? 'true' : 'false');
      return b;
    }

    async function toggleWords(b) {
      if (words) { words.close(); words = null; b.setAttribute('aria-pressed', 'false'); return; }
      const e = current();
      if (pending) return;
      pending = true;
      const ok = await loadTranscript();
      pending = false;
      if (!root.isConnected || current() !== e || words) return;
      if (!ok) { tellError('failed'); return; }
      words = window.CaptureTranscript.open({
        before: actions, entry: e, url: o.url, tr, remote: o.remote, errorText: M.errorText,
        video: () => stage.querySelector('video'),
        askBit: o.askBit || null,
      });
      b.setAttribute('aria-pressed', 'true');
    }

    // "Export": the sheet takes the actions row, as Trim does.
    async function startExport() {
      const e = current();
      if (pending || exporting) return;
      pending = true;
      const ok = await loadExport();
      pending = false;
      if (!root.isConnected || current() !== e || exporting) return;
      if (!ok) { tellError('failed'); return; }
      if (words) { words.close(); words = null; }
      tell('');
      root.classList.add('is-trimming');
      exporting = window.CaptureExport.open({
        host: actions, entry: e, url: o.url, tr, M,
        post: (path, body) => post(o.url, path, body),
        onDone: (id, note) => o.onChanged(id, note),
        onClose: () => { exporting = null; paintActions(); },
      });
    }

    async function pin() {
      const r = await post(o.url, '/actions/run', { type: 'screenPin', id: current().id });
      if (!root.isConnected) return;
      if (r && r.ok === true) tell(tr('capg_pinned', 'Pinned over your windows: drag it, wheel to resize, x to unpin'));
      else tellError(r && r.error);
    }

    async function edit() {
      const e = current();
      if (editor || pending) return;
      pending = true;
      const ok = await loadEditor();
      pending = false;
      if (!root.isConnected || current() !== e) return;
      if (!ok) { tellError('failed'); return; }
      editor = window.CaptureAnnotate.open({
        host: root, entry: e, url: o.url, tr, errorText: M.errorText,
        canFind: can.cover,
        onSaved: (entry) => { editor = null; o.onChanged(entry.id); },
        onClose: () => { editor = null; top.querySelector('button').focus(); },
      });
    }

    async function act(path, done, errText) {
      if (pending) return;
      pending = true;
      actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const r = await post(o.url, path, { id: current().id });
      pending = false;
      if (!root.isConnected) return;
      actions.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (r && r.ok === true) done(r);
      else if (errText) { const [k, fb] = errText(r && r.error); tell(tr(k, fb), true); }
      else tellError(r && r.error);
    }

    // "Clips from marks": a short copy around each mark, beside the video
    // (capture-gallery.js clips() on the server). The first clip opens.
    function makeClips() {
      tell(tr('capg_clips_making', 'Making the clips…'));
      act('/captures/clips', (r) => {
        const n = Number(r.clips) || 0;
        let line = n === 1 ? tr('capg_clips_one', '1 clip made, next to the video') : tr('capg_clips_done', '{n} clips made, next to the video').replace('{n}', n);
        if (r.stopped) line = tr('capg_clips_part', '{n} of {of} clips made, then it stopped').replace('{n}', n).replace('{of}', Number(r.of) || n);
        o.onChanged(r.first, line);
      });
    }

    // ── Trim ──────────────────────────────────────────────────────────────
    function startTrim() {
      const v = stage.querySelector('video');
      const e = current();
      const duration = v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Number(e.seconds) || 0;
      if (!(duration > M.MIN_TRIM_S)) { tellError('too_short'); return; }
      trim = { start: 0, end: duration, duration };
      tell('');
      actions.replaceChildren();
      actions.classList.add('is-trim');
      root.classList.add('is-trimming');

      const bar = el('div', 'capg-trimbar');
      const kept = el('div', 'capg-kept');
      const head = el('div', 'capg-playhead');
      const hs = el('button', 'capg-handle capg-handle-start');
      const he = el('button', 'capg-handle capg-handle-end');
      [[hs, 'start', tr('capg_trim_start', 'Start')], [he, 'end', tr('capg_trim_end', 'End')]].forEach(([h, which, label]) => {
        h.type = 'button';
        h.setAttribute('role', 'slider');
        h.setAttribute('aria-label', label);
        h.setAttribute('aria-valuemin', '0');
        h.setAttribute('aria-valuemax', String(Math.round(duration * 10) / 10));
        h.addEventListener('pointerdown', (ev) => drag(ev, which));
        h.addEventListener('keydown', (ev) => {
          const step = ev.shiftKey ? 1 : STEP_S;
          const d = ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -step : ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? step : 0;
          if (!d) return;
          ev.preventDefault();
          ev.stopPropagation();
          move(which, trim[which] + d);
        });
      });
      bar.append(kept, head, hs, he);
      // A tap on the bar moves the nearer handle there.
      bar.addEventListener('pointerdown', (ev) => {
        if (ev.target === hs || ev.target === he) return;
        const at = timeAt(ev.clientX);
        const which = Math.abs(at - trim.start) <= Math.abs(at - trim.end) ? 'start' : 'end';
        move(which, at);
        drag(ev, which);
      });
      const times = el('div', 'capg-times');
      const note = el('div', 'capg-note', tr('capg_trim_note', 'The copy may start up to 1 s before the point you chose. The original stays.'));
      const row = el('div', 'capg-trim-row');
      const save = btn(tr('capg_trim_save', 'Save trimmed copy'), 'ui-btn--primary', saveTrim);
      row.append(save, btn(tr('capg_cancel', 'Cancel'), '', () => { trim = null; tell(''); paintActions(); }));
      actions.append(bar, times, note, row);

      function timeAt(clientX) {
        const r = bar.getBoundingClientRect();
        return r.width > 0 ? ((clientX - r.left) / r.width) * duration : 0;
      }
      function drag(ev, which) {
        ev.preventDefault();
        const handle = which === 'start' ? hs : he;
        handle.focus();
        const moveTo = (x) => move(which, timeAt(x));
        const onMove = (m) => moveTo(m.clientX);
        const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }
      function move(which, value) {
        Object.assign(trim, M.clampRange(trim, which, value, duration));
        if (v) { v.pause(); v.currentTime = which === 'start' ? trim.start : Math.max(trim.start, trim.end - 0.05); }
        draw();
      }
      function draw() {
        const a = (trim.start / duration) * 100;
        const b = (trim.end / duration) * 100;
        hs.style.left = a + '%';
        he.style.left = b + '%';
        kept.style.left = a + '%';
        kept.style.width = (b - a) + '%';
        hs.setAttribute('aria-valuenow', String(Math.round(trim.start * 10) / 10));
        he.setAttribute('aria-valuenow', String(Math.round(trim.end * 10) / 10));
        hs.setAttribute('aria-valuetext', M.stamp(trim.start, true));
        he.setAttribute('aria-valuetext', M.stamp(trim.end, true));
        times.textContent = tr('capg_trim_times', '{start} to {end} ({len})')
          .replace('{start}', M.stamp(trim.start, true)).replace('{end}', M.stamp(trim.end, true))
          .replace('{len}', M.stamp(trim.end - trim.start, true));
        save.disabled = !M.trimChanges(trim, duration);
      }
      if (v) v.addEventListener('timeupdate', () => { head.style.left = ((v.currentTime / duration) * 100) + '%'; });
      draw();
      hs.focus();
    }

    async function saveTrim() {
      if (!trim || pending) return;
      pending = true;
      actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
      tell(tr('capg_trimming', 'Trimming…'));
      const r = await post(o.url, '/captures/trim', { id: current().id, start: trim.start, end: trim.end });
      pending = false;
      if (!root.isConnected) return;
      if (r && r.ok === true && r.entry) {
        trim = null;
        o.onChanged(r.entry.id);
        return;
      }
      actions.querySelectorAll('button').forEach(b => { b.disabled = false; });
      tellError(r && r.error);
    }

    function go(step) {
      if (trim || pending || exporting) return;
      const to = index + step;
      if (to < 0 || to >= entries.length) return;
      index = to;
      paint();
    }

    function onKey(ev) {
      if (editor) return; // the editor has its own keys
      if (ev.key === 'Escape') {
        // Back to the grid only: the gallery's own Escape must not see it.
        ev.preventDefault();
        ev.stopPropagation();
        if (exporting) exporting.close();
        else if (trim) { trim = null; tell(''); paintActions(); } else close();
        return;
      }
      // Arrows belong to the video's controls and the handles when they have focus.
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (trim || exporting || tag === 'VIDEO' || tag === 'SELECT' || tag === 'INPUT') return;
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(-1); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); go(1); }
    }

    function close() {
      if (!root.isConnected) return;
      clearTimeout(disarm);
      if (editor) { const ed = editor; editor = null; ed.close(); }
      if (words) { words.close(); words = null; }
      if (exporting) { const x = exporting; exporting = null; x.close(); }
      document.removeEventListener('keydown', onKey, true);
      const v = stage.querySelector('video');
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
      root.remove();
      o.onClose();
    }

    // The list changed under the viewer (another device deleted or trimmed).
    function sync(list) {
      const id = current() && current().id;
      entries = list.slice();
      const at = entries.findIndex(e => e.id === id);
      if (at >= 0) { index = at; prev.disabled = index === 0; next.disabled = index >= entries.length - 1; return; }
      if (!entries.length) { close(); return; }
      index = Math.min(index, entries.length - 1);
      paint();
    }

    document.addEventListener('keydown', onKey, true);
    paint();
    if (o.note) tell(o.note);
    top.querySelector('button').focus();
    // SSE `transcript`: progress and the end of a transcription.
    const onTranscript = (ev) => { if (words) words.onState(ev); };
    // SSE `capture_export`: progress and the end of a copy.
    const onExport = (ev) => { if (exporting) exporting.onState(ev); };
    return {
      close, sync, onTranscript, onExport,
      busy: () => pending || !!trim || !!(editor && editor.busy()) || !!(exporting && exporting.busy()),
    };
  }

  window.CaptureGalleryViewer = { open };
})();
