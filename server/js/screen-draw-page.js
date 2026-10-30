'use strict';

// Drawing on the screen on macOS and Linux (draw.html): the native shell shows
// this page in a see-through window over the main screen while "Draw on
// screen" is on (server/screen-draw-shell.js, the `draw:` surface of
// js/layers-shell.js). The strokes and the keys follow js/screen-draw-model.js;
// this only paints them and asks the server to stop, which closes the window.
// Nothing leaves the page: the drawing is gone when it closes.

(function () {
  if (!window.ScreenDrawModel) return;
  const M = ScreenDrawModel;
  const HINT_FOR_MS = 8000;
  const SETTINGS_TIMEOUT_MS = 3000;

  const sketch = M.create();
  const done = document.getElementById('sdraw-done');
  const live = document.getElementById('sdraw-live');
  const bar = document.getElementById('sdraw-bar');
  const hint = document.getElementById('sdraw-hint');
  const colours = document.getElementById('sdraw-colours');
  const undoBtn = document.getElementById('sdraw-undo');
  const clearBtn = document.getElementById('sdraw-clear');
  let scale = 1;
  let pointer = null;   // the pointer id drawing now
  let closing = false;

  // ── The bar ────────────────────────────────────────────────────
  M.PALETTE.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sdraw-btn';
    b.dataset.colour = String(i);
    b.setAttribute('data-i18n-title', p.label);
    b.setAttribute('data-i18n-aria-label', p.label);
    const dot = document.createElement('span');
    dot.className = 'sdraw-swatch sdraw-' + p.id;
    b.appendChild(dot);
    colours.appendChild(b);
  });

  function paintBar() {
    bar.querySelectorAll('[data-colour]').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.colour) === sketch.colour));
    });
    bar.querySelectorAll('[data-tool]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.tool === sketch.tool));
    });
    const empty = sketch.strokes.length === 0;
    undoBtn.disabled = empty;
    clearBtn.disabled = empty;
  }

  function dropHint() {
    hint.hidden = true;
  }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.colour) sketch.pick({ colour: Number(b.dataset.colour) });
    else if (b.dataset.tool) sketch.pick({ tool: b.dataset.tool });
    else if (b === undoBtn) act('undo');
    else if (b === clearBtn) act('clear');
    else if (b.id === 'sdraw-close') act('close');
    paintBar();
  });

  // ── Painting ───────────────────────────────────────────────────
  function fit() {
    scale = window.devicePixelRatio || 1;
    for (const c of [done, live]) {
      c.width = Math.round(window.innerWidth * scale);
      c.height = Math.round(window.innerHeight * scale);
    }
    redraw();
  }

  function paint(ctx, stroke) {
    const rgb = stroke.rgb.join(' ');
    ctx.save();
    ctx.scale(scale, scale);
    ctx.globalAlpha = M.ALPHA[stroke.tool];
    ctx.strokeStyle = 'rgb(' + rgb + ')';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = M.width(stroke, 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // One path for the whole stroke, so a see-through highlighter never darkens
    // where it crosses itself.
    ctx.beginPath();
    for (const line of M.paths(stroke, 1)) {
      ctx.moveTo(line[0][0], line[0][1]);
      if (line.length === 1) ctx.lineTo(line[0][0] + 0.01, line[0][1]);
      for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0], line[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  function clearCanvas(c) {
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  function redraw() {
    clearCanvas(done);
    const ctx = done.getContext('2d');
    for (const s of sketch.strokes) paint(ctx, s);
    paintLive();
  }

  function paintLive() {
    clearCanvas(live);
    if (sketch.live) paint(live.getContext('2d'), sketch.live);
  }

  // ── The pointer ────────────────────────────────────────────────
  const at = (e) => [e.clientX, e.clientY];
  const mods = (e) => ({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });

  done.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || pointer !== null) return;
    pointer = e.pointerId;
    try { done.setPointerCapture(pointer); } catch (err) { /* already released */ }
    sketch.begin(at(e), mods(e));
    dropHint();
    paintLive();
  });
  done.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const c of (events.length ? events : [e])) sketch.extend(at(c));
    paintLive();
  });
  function finish(e) {
    if (e.pointerId !== pointer) return;
    pointer = null;
    if (sketch.end()) paint(done.getContext('2d'), sketch.strokes[sketch.strokes.length - 1]);
    clearCanvas(live);
    paintBar();
  }
  done.addEventListener('pointerup', finish);
  done.addEventListener('pointercancel', finish);
  done.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── Keys and actions ───────────────────────────────────────────
  function act(what) {
    if (what === 'undo') { if (sketch.undo()) redraw(); }
    else if (what === 'clear') { if (sketch.clear()) redraw(); }
    else if (what === 'close') stop();
  }

  window.addEventListener('keydown', (e) => {
    const a = M.keyAction(e.key, { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, meta: false });
    if (!a) return;
    e.preventDefault();
    if (a.act) act(a.act);
    else sketch.pick({ colour: a.colour });
    paintBar();
  });

  // The server closes the sheet: the shell then takes the window away.
  async function stop() {
    if (closing) return;
    closing = true;
    try {
      await fetch('/actions/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'screenDraw', mode: 'stop' }),
      });
    } catch (e) { /* server gone: the shell closes the window with it */ }
    closing = false;
  }

  // ── Language ───────────────────────────────────────────────────
  async function loadLanguage() {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), SETTINGS_TIMEOUT_MS) : 0;
    try {
      const res = await fetch('/settings', { cache: 'no-store', signal: ctl && ctl.signal });
      const data = res.ok ? await res.json() : null;
      const code = data && data.settings ? normalizeLangCode(data.settings.language) : '';
      if (code && i18n[code]) lang = code;
    } catch (e) { /* the browser's language stays */ }
    clearTimeout(timer);
    document.documentElement.lang = lang;
    translateStatic(document);
  }

  window.addEventListener('resize', fit);
  fit();
  paintBar();
  translateStatic(document);
  loadLanguage();
  setTimeout(dropHint, HINT_FOR_MS);
  window.focus();
})();
