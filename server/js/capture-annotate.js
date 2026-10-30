'use strict';
// The screenshot editor, opened from the gallery's viewer ("Edit", PC only)
// and loaded only then: arrows, boxes, text, a marker and black covers drawn
// over the picture, and "Find private data", which asks the PC's own OCR
// (POST /captures/spots, only rectangles come back) where e-mails, IBANs and
// long numbers are and covers them. Drag to draw, tap a mark to take it away,
// Ctrl+Z or Undo. "Save copy" writes a NEW screenshot of the same size beside
// the original (POST /captures/save); the original is never changed.
(function () {
  const A = window.CaptureAnnotateModel;
  const S0 = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  // Static constant markup only.
  const ICONS = {
    back: S0 + '<path d="M15 5l-7 7 7 7"/></svg>',
    undo: S0 + '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    arrow: S0 + '<path d="M5 19L19 5M10 5h9v9"/></svg>',
    box: S0 + '<rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>',
    text: S0 + '<path d="M5 7V5h14v2M12 5v14M9 19h6"/></svg>',
    highlight: S0 + '<path d="M4 20h16"/><path d="M14.5 4.5l5 5L11 18H6v-5z"/></svg>',
    cover: S0 + '<rect x="3" y="8" width="18" height="8" rx="1" fill="currentColor"/></svg>',
  };
  const TOOL_KEYS = {
    arrow: ['cann_arrow', 'Arrow'], box: ['cann_box', 'Box'], text: ['cann_text', 'Text'],
    highlight: ['cann_highlight', 'Marker'], cover: ['cann_cover', 'Cover'],
  };
  const COLOR_KEYS = [['cann_red', 'Red'], ['cann_yellow', 'Yellow'], ['cann_white', 'White']];
  const ERRORS = {
    no_ocr_language: ['cann_err_ocr', 'Windows has no text recognition for your language: add it in Settings, Time & language, Language'],
    busy: ['cann_err_busy', 'Another copy is being saved, try again in a moment'],
    write_failed: ['cann_err_save', 'It could not be saved: is the disk full?'],
    too_large: ['cann_err_save', 'It could not be saved: is the disk full?'],
    bad_image: ['cann_err_save', 'It could not be saved: is the disk full?'],
  };
  const DISCARD_ARM_MS = 4000;

  // opts: host (the viewer's root), entry, url(path), tr(key, fallback),
  // errorText(code) → [key, fallback], onSaved(entry), onClose().
  function open(opts) {
    const o = opts;
    const tr = o.tr;
    const el = makeEl;
    const history = A.createHistory();
    const size = { width: 0, height: 0 };
    let tool = 'arrow';
    let color = A.COLORS[0];
    let pending = false;
    let saved = true; // nothing drawn yet
    let drag = null; // { a, start, shape } while drawing
    let typing = null; // the text field while placing a label
    let disarm = 0;

    const root = el('div', 'cann');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', tr('capg_edit', 'Edit'));
    const top = el('div', 'cann-top');
    const back = iconBtn('back', tr('capg_back', 'Back to the gallery'), tryClose);
    const title = el('div', 'cann-title', tr('capg_edit', 'Edit'));
    const undo = iconBtn('undo', tr('cann_undo', 'Undo'), doUndo);
    const save = el('button', 'ui-btn ui-btn--primary cann-save', tr('cann_save', 'Save copy'));
    save.type = 'button';
    save.addEventListener('click', doSave);
    top.append(back, title, undo, save);

    const stage = el('div', 'cann-stage');
    const canvas = el('canvas', 'cann-canvas');
    canvas.setAttribute('aria-label', tr('cann_hint', 'Drag to draw, tap a mark to take it away'));
    stage.appendChild(canvas);

    const tools = el('div', 'cann-tools');
    const toolBtns = A.TOOLS.map((name) => {
      const [k, fb] = TOOL_KEYS[name];
      const b = el('button', 'cann-tool');
      b.type = 'button';
      b.dataset.tool = name;
      const ic = el('span', 'cann-ic');
      ic.innerHTML = ICONS[name];
      b.append(ic, el('span', 'cann-tool-label', tr(k, fb)));
      b.addEventListener('click', () => { tool = name; paintTools(); });
      return b;
    });
    const toolRow = el('div', 'cann-toolrow');
    toolRow.append(...toolBtns);
    const swatches = el('div', 'cann-colors');
    const colorBtns = A.COLORS.map((c, i) => {
      const b = el('button', 'cann-swatch cann-swatch-' + i);
      b.type = 'button';
      b.setAttribute('aria-label', tr(COLOR_KEYS[i][0], COLOR_KEYS[i][1]));
      b.title = b.getAttribute('aria-label');
      b.addEventListener('click', () => { color = c; paintTools(); });
      return b;
    });
    swatches.append(...colorBtns);
    const find = el('button', 'ui-btn ui-btn--secondary cann-find', tr('cann_find', 'Find private data'));
    find.type = 'button';
    find.addEventListener('click', doFind);
    const lower = el('div', 'cann-lower');
    // The search runs in the capture engine; one without it (macOS) shows none.
    lower.append(swatches);
    if (o.canFind !== false) lower.append(find);
    tools.append(toolRow, lower);

    const say = el('div', 'cann-say');
    say.setAttribute('role', 'status');
    root.append(top, stage, tools, say);
    o.host.appendChild(root);

    function iconBtn(name, label, onClick) {
      const b = el('button', 'cgal-iconbtn');
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      const s = el('span', 'cgal-ic');
      s.innerHTML = ICONS[name];
      b.appendChild(s);
      b.addEventListener('click', onClick);
      return b;
    }

    function tell(text, bad) {
      say.textContent = text || '';
      say.classList.toggle('is-bad', !!bad);
    }
    function tellError(code) {
      const [k, fb] = ERRORS[code] || o.errorText(code);
      tell(tr(k, fb), true);
    }

    function paintTools() {
      toolBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
      // A cover is always black: the colour does not apply to it.
      colorBtns.forEach((b, i) => {
        b.setAttribute('aria-pressed', String(A.COLORS[i] === color));
        b.disabled = tool === 'cover';
      });
      undo.disabled = !history.canUndo || pending;
      save.disabled = saved || pending;
      find.disabled = pending;
      canvas.dataset.tool = tool;
    }

    // ── Drawing ───────────────────────────────────────────────────────────
    const picture = new Image();
    picture.decoding = 'async';
    picture.addEventListener('load', () => {
      size.width = picture.naturalWidth;
      size.height = picture.naturalHeight;
      fit();
    });
    picture.addEventListener('error', () => tellError('not_found'));
    picture.src = o.url('/captures/file?id=' + encodeURIComponent(o.entry.id));

    let scale = 1; // screen pixels per picture pixel
    function fit() {
      if (!size.width) return;
      const r = stage.getBoundingClientRect();
      scale = Math.min(r.width / size.width, r.height / size.height);
      if (!(scale > 0)) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = Math.floor(size.width * scale) + 'px';
      canvas.style.height = Math.floor(size.height * scale) + 'px';
      canvas.width = Math.max(1, Math.floor(size.width * scale * dpr));
      canvas.height = Math.max(1, Math.floor(size.height * scale * dpr));
      draw();
    }
    const resize = new ResizeObserver(fit);
    resize.observe(stage);

    function draw() {
      if (!size.width) return;
      const ctx = canvas.getContext('2d');
      const k = canvas.width / size.width;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.drawImage(picture, 0, 0);
      A.paint(ctx, drag && drag.shape ? history.shapes.concat(drag.shape) : history.shapes, size);
    }

    function at(ev) {
      const r = canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
    }

    function measure(text, font) {
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.font = '600 ' + font + 'px system-ui, sans-serif';
      const w = ctx.measureText(text).width;
      ctx.restore();
      return w;
    }

    function changed() {
      // Undoing every mark leaves nothing to save or to lose.
      saved = !history.shapes.length;
      tell('');
      paintTools();
      draw();
    }

    canvas.addEventListener('pointerdown', (ev) => {
      if (!size.width || pending || ev.button > 0) return;
      if (typing) { commitText(); return; }
      ev.preventDefault();
      canvas.setPointerCapture(ev.pointerId);
      drag = { a: at(ev), start: { x: ev.clientX, y: ev.clientY }, shape: null };
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      drag.shape = A.shapeFrom(tool, drag.a, at(ev), color, size, 2 / scale);
      draw();
    });
    const endDrag = (ev, cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      const moved = Math.hypot(ev.clientX - d.start.x, ev.clientY - d.start.y);
      if (cancelled) { draw(); return; }
      if (moved < A.TAP_PX) { tap(d.a, ev); return; }
      const shape = A.shapeFrom(tool, d.a, at(ev), color, size, A.TAP_PX / scale);
      if (shape && history.add([shape])) changed();
      else if (shape) tell(tr('cann_full', 'That is a lot of marks: save this copy, then edit it again'), true);
      else draw();
    };
    canvas.addEventListener('pointerup', (ev) => endDrag(ev, false));
    canvas.addEventListener('pointercancel', (ev) => endDrag(ev, true));

    // A tap takes the mark under it away; with Text on empty picture, it
    // starts a label there.
    function tap(p, ev) {
      const hit = A.hitTest(history.shapes, p, size, A.TAP_PX / scale, measure);
      if (hit >= 0) { history.removeAt(hit); changed(); return; }
      if (tool === 'text') startText(p, ev);
      else draw();
    }

    function startText(p, ev) {
      const r = stage.getBoundingClientRect();
      const input = el('input', 'cann-input');
      input.type = 'text';
      input.maxLength = A.MAX_TEXT;
      input.placeholder = tr('cann_text_ph', 'Type, then press Enter');
      input.setAttribute('aria-label', tr('cann_text', 'Text'));
      input.style.left = Math.max(0, Math.min(ev.clientX - r.left, r.width - 200)) + 'px';
      input.style.top = Math.max(0, Math.min(ev.clientY - r.top, r.height - 44)) + 'px';
      typing = { input, p };
      input.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') { k.preventDefault(); commitText(); }
        if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); dropText(); }
      });
      input.addEventListener('blur', () => { if (typing && typing.input === input) commitText(); });
      stage.appendChild(input);
      input.focus();
    }
    function dropText() {
      if (!typing) return;
      const { input } = typing;
      typing = null;
      input.remove();
    }
    function commitText() {
      if (!typing) return;
      const shape = A.textShape(typing.p, typing.input.value, color, size);
      dropText();
      if (shape && history.add([shape])) changed();
    }

    function doUndo() {
      if (!history.canUndo || pending) return;
      history.undo();
      changed();
    }

    // ── Find private data ─────────────────────────────────────────────────
    async function doFind() {
      if (pending) return;
      busy(true);
      tell(tr('cann_finding', 'Looking for e-mails, IBANs and long numbers…'));
      const r = await apiJson(o.url('/captures/spots'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: o.entry.id }) });
      busy(false);
      if (!root.isConnected) return;
      if (!r || r.ok !== true) { tellError(r && r.error); return; }
      const covers = A.coversFrom(r.spots, history.shapes);
      if (!covers.length) {
        tell(tr('cann_none', 'No e-mails, IBANs or long numbers found. Cover names and faces by hand.'));
        return;
      }
      if (!history.add(covers)) { tell(tr('cann_full', 'That is a lot of marks: save this copy, then edit it again'), true); return; }
      changed();
      tell(tr('cann_found', 'Covered {n}: tap one to take it away. Names and faces are not found.').replace('{n}', String(covers.length)));
    }

    // ── Save ──────────────────────────────────────────────────────────────
    function render() {
      const out = document.createElement('canvas');
      out.width = size.width;
      out.height = size.height;
      const ctx = out.getContext('2d');
      ctx.drawImage(picture, 0, 0);
      A.paint(ctx, history.shapes, size);
      return new Promise(resolve => out.toBlob(resolve, 'image/png'));
    }

    async function doSave() {
      if (pending || saved || !size.width) return;
      if (typing) commitText();
      busy(true);
      tell(tr('cann_saving', 'Saving…'));
      let r = null;
      try {
        const png = await render();
        const res = await fetch(o.url('/captures/save?id=' + encodeURIComponent(o.entry.id)), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
        r = await res.json();
      } catch { r = null; }
      busy(false);
      if (!root.isConnected) return;
      if (r && r.ok === true && r.entry) {
        saved = true;
        finish();
        o.onSaved(r.entry);
        return;
      }
      tellError(r && r.error);
    }

    function busy(on) {
      pending = on;
      root.classList.toggle('is-busy', on);
      paintTools();
    }

    // ── Leaving ───────────────────────────────────────────────────────────
    // Unsaved marks: the first tap (or Esc) asks, the second leaves.
    function tryClose() {
      if (pending) return;
      if (saved || root.classList.contains('is-armed')) { finish(); o.onClose(); return; }
      root.classList.add('is-armed');
      tell(tr('cann_discard', 'Press again to leave without saving'), true);
      clearTimeout(disarm);
      disarm = setTimeout(() => { root.classList.remove('is-armed'); tell(''); }, DISCARD_ARM_MS);
    }

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (typing) dropText();
        else tryClose();
        return;
      }
      if (typing) return;
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        ev.stopPropagation();
        doUndo();
      }
    }

    function finish() {
      if (!root.isConnected) return;
      clearTimeout(disarm);
      document.removeEventListener('keydown', onKey, true);
      resize.disconnect();
      picture.removeAttribute('src');
      root.remove();
    }

    document.addEventListener('keydown', onKey, true);
    paintTools();
    back.focus();
    return { close: () => { finish(); o.onClose(); }, busy: () => pending || !saved };
  }

  window.CaptureAnnotate = { open };
})();
