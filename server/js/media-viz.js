'use strict';

// ── Media visualiser ──────────────────────────────────────────────
// A scrolling waveform of the sound the playing app is ACTUALLY making, drawn
// across the bottom of the Media tile and tinted by the album cover.
//
// WHAT IT DRAWS, AND WHY THAT SHAPE. The only real audio measurement Xenon has
// is `audiolevels`: peak per process, 0..1, about twelve times a second, from
// the native helper (see server/audio-levels.js). That is one number per tick —
// an amplitude, not a spectrum. So this does not draw frequency bands. Sixty
// bars at different heights would read as a spectrum analyser, and inventing
// nine tenths of it from one number is the kind of decorative fake this codebase
// already refused once: the equaliser glyph in the Media placeholder has fixed
// bar heights and no animation on purpose.
//
// Instead every bar here is a real measured peak — just from a different moment.
// The strip is the last few seconds of level history, newest on the right,
// mirrored around the centre line. Nothing is interpolated except the position
// of the scroll between ticks, which is drawing, not data.
//
// WHOSE SOUND. `audiolevels` is keyed by process name, and the `media` stream
// says which app owns the track. So the waveform follows the music: a Discord
// call or a game does not make the Spotify strip dance. Falling back to the
// loudest app only when the player cannot be matched.
(function () {
  // One tick of history per payload. The helper's own interval is 80ms; this is
  // how far apart samples are assumed to be when interpolating the scroll.
  const TICK_MS = 80;
  const MIN_BAR = 2;            // a silent sample is a dot on the centre line, not a gap
  const FADE_MS = 900;          // how long the strip takes to fade in/out

  // Two intensities of the same honest thing, because this is an ADDITION to the
  // Media tile and an addition has to be able to stay quiet. `minimal` is a thin
  // line along the bottom edge that breathes — near invisible on a soft passage,
  // never competing with the cover or the title. `wave` is the fuller strip, and
  // even that is deliberately under half opacity: it belongs to the artwork, it
  // is not a sticker on top of it. Off is the default and draws nothing at all.
  const STYLES = {
    minimal: { h: 0.09, max: 26, bar: 2, gap: 4, alpha: 0.42, curve: 0.62 },
    wave:    { h: 0.16, max: 52, bar: 3, gap: 4, alpha: 0.58, curve: 0.72 },
  };
  const DEFAULT_STYLE = 'wave';
  let look = STYLES.wave;
  // Silence sends nothing (an app at digital zero is omitted from the map), so a
  // missing key means quiet — never "closed". Decay instead of dropping.
  const SILENCE_DECAY = 0.55;

  let canvas = null;
  let ctx = null;
  let raf = null;
  let cssW = 0, cssH = 0, dpr = 1;

  let samples = [];             // ring of 0..1 peaks, oldest first
  let capacity = 0;
  let lastTickAt = 0;           // performance.now() of the newest sample
  let palette = null;           // [hex] from the album cover, or null
  let gradient = null;          // cached, rebuilt on resize / palette change
  let gradientKey = '';

  let style = 'off';            // 'off' | 'minimal' | 'wave'
  let playing = false;          // something is actually playing
  let proc = '';                // process name of the player, lower-case, no .exe
  let problem = '';             // '' | 'no-helper' | 'helper-too-old' | 'helper-failed'
  let sawLevels = false;        // has a real payload ever arrived?
  let opacity = 0;              // eased 0..1 so it never pops in or out
  let lastFrameAt = 0;

  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function panel() { return document.getElementById('media-panel'); }

  // ── Mount ───────────────────────────────────────────────────────
  // The canvas lives behind the tile's content (z-index below .media-pane) and
  // above the blurred cover, so the waveform reads as part of the artwork rather
  // than as a control. Created on demand: a dashboard with the setting off — the
  // default — never allocates a canvas at all.
  function mount() {
    if (canvas) return canvas;
    const host = panel();
    if (!host) return null;
    canvas = document.createElement('canvas');
    canvas.className = 'media-viz';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { resize(); invalidate(); }).observe(host);
    }
    return canvas;
  }

  function unmount() {
    stop();
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null; ctx = null; gradient = null; gradientKey = '';
    samples = []; capacity = 0; opacity = 0;
  }

  function resize() {
    if (!canvas) return;
    const host = panel();
    if (!host) return;
    const r = host.getBoundingClientRect();
    // A tile scrolled off-screen measures 0; keep the last good size rather than
    // reallocating a 0x0 canvas and losing the history.
    if (r.width < 8 || r.height < 8) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);   // capped: a 3x strip costs triple for no visible gain
    cssW = Math.round(r.width);
    cssH = Math.round(Math.max(14, Math.min(look.max, r.height * look.h)));
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const next = Math.max(8, Math.ceil(cssW / (look.bar + look.gap)) + 1);
    if (next !== capacity) {
      // Keep the most recent history across a resize — a tile being dragged
      // should not blank its waveform.
      samples = samples.slice(-next);
      capacity = next;
    }
    gradient = null;
  }

  // ── Colour ──────────────────────────────────────────────────────
  // The cover's own palette (album-theme.js already extracts it for the tile
  // accent and the LED strip), spread left→right across the waveform. No cover,
  // or a cover with one usable colour: the dashboard accent, so the strip still
  // belongs to the theme instead of falling back to grey.
  function buildGradient() {
    const key = cssW + '|' + (palette ? palette.join(',') : '');
    if (gradient && key === gradientKey) return gradient;
    const g = ctx.createLinearGradient(0, 0, cssW, 0);
    const stops = (palette && palette.length >= 2)
      ? palette.slice(0, 4)
      : [accentHex(), palette && palette[0] ? palette[0] : accentHex()];
    stops.forEach((hex, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), hex));
    gradient = g; gradientKey = key;
    return g;
  }

  function accentHex() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
      const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
      if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(rgb)) return 'rgb(' + rgb + ')';
    } catch { /* fall through */ }
    return '#1ed760';
  }

  /** Cover colours, from media.js's album extraction. null clears them. */
  function setPalette(pair) {
    const next = (pair && Array.isArray(pair.ledPalette) && pair.ledPalette.length)
      ? pair.ledPalette.slice(0, 4)
      : (pair && pair.accent ? [pair.accent] : null);
    const same = JSON.stringify(next) === JSON.stringify(palette);
    palette = next;
    if (!same) gradient = null;
  }

  // ── Data in ─────────────────────────────────────────────────────
  /**
   * One `audiolevels` payload. `peaks` is process → 0..1 for the apps making
   * sound right now; `problem` explains a feed that will never start.
   */
  function onLevels(payload) {
    if (payload && payload.problem) { problem = payload.problem; syncRunning(); return; }
    problem = '';
    sawLevels = true;
    const peaks = (payload && payload.peaks) || {};
    let v = 0;
    if (proc && Object.hasOwn(peaks, proc)) {
      v = Number(peaks[proc]) || 0;
    } else if (proc) {
      // The player is known but silent this tick (omitted, per the contract) —
      // that is a real zero, not a reason to borrow another app's level.
      v = 0;
    } else {
      for (const k of Object.keys(peaks)) v = Math.max(v, Number(peaks[k]) || 0);
    }
    push(v);
  }

  function push(v) {
    const clamped = Math.max(0, Math.min(1, v));
    // A missing sample decays rather than dropping to zero, so a track's quiet
    // passage looks like a quiet passage and not like a gap in the recording.
    const prev = samples.length ? samples[samples.length - 1] : 0;
    samples.push(clamped > 0 ? clamped : prev * SILENCE_DECAY);
    while (samples.length > capacity) samples.shift();
    lastTickAt = performance.now();
    syncRunning();
  }

  /** Which app owns the track, so the waveform follows the music. */
  function setSource(appOrProc) {
    const s = String(appOrProc || '').trim().toLowerCase().replace(/\.exe$/, '');
    proc = s;
  }

  /** Whether anything is playing at all. */
  function setPlaying(on) {
    const next = !!on;
    if (next === playing) return;
    playing = next;
    syncRunning();
  }

  /**
   * The user's setting: 'off' | 'minimal' | 'wave'. Anything unrecognised is
   * off, so a settings blob from a newer build can never leave a strip running
   * that this one cannot draw. `true` is accepted as 'wave' for the one build
   * where this was a checkbox.
   */
  function setStyle(next) {
    const want = next === true ? DEFAULT_STYLE
      : (Object.hasOwn(STYLES, String(next)) ? String(next) : 'off');
    if (want === style) return;
    style = want;
    if (style === 'off') { unmount(); return; }
    look = STYLES[style];
    if (canvas) { resize(); invalidate(); } else { mount(); }
    syncRunning();
  }

  // ── Should it be drawing? ───────────────────────────────────────
  // Every gate must hold. The dashboard is fastidious about idle GPU work — the
  // blurred cover layer is only promoted while a cover is shown for exactly this
  // reason — so a visualiser must never be a permanently live compositor layer
  // on a machine playing nothing.
  //
  // The geometry half is CACHED. wanted() is asked on every animation frame and
  // on every level tick; measuring the tile there would mean a forced synchronous
  // layout sixty times a second, which is a worse tax than the drawing itself.
  // The cheap flags are read live, the expensive question is re-asked on a slow
  // timer and on the events that can actually move a tile.
  const GEOM_TTL_MS = 500;
  let geomOk = false;
  let geomAt = 0;

  function measure() {
    geomAt = performance.now();
    const host = panel();
    if (!host || host.dataset.dashboardHidden === 'true') { geomOk = false; return; }
    const r = host.getBoundingClientRect();
    geomOk = r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function wanted() {
    if (style === 'off' || !canvas) return false;
    if (document.hidden) return false;
    if (!playing) return false;
    if (problem || !sawLevels) return false;
    if (performance.now() - geomAt > GEOM_TTL_MS) measure();
    return geomOk;
  }

  function syncRunning() {
    const on = wanted();
    if (canvas) canvas.classList.toggle('is-live', on);
    if (on && raf === null) { lastFrameAt = performance.now(); raf = requestAnimationFrame(frame); }
    // Not stopped the instant it is unwanted: the fade-out is a frame loop too.
    // frame() ends the loop once the strip has actually faded to nothing.
  }

  function stop() {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  // ── Draw ────────────────────────────────────────────────────────
  function frame(now) {
    raf = null;
    if (!canvas || !ctx) return;
    const dt = Math.min(100, now - lastFrameAt);
    lastFrameAt = now;

    const on = wanted();
    const step = dt / FADE_MS;
    opacity = on ? Math.min(1, opacity + step) : Math.max(0, opacity - step);

    ctx.clearRect(0, 0, cssW, cssH);
    if (opacity > 0.001) draw(now);

    // Keep going while there is something to show OR something to fade out.
    if (on || opacity > 0.001) raf = requestAnimationFrame(frame);
  }

  function draw(now) {
    const mid = cssH / 2;
    const stepX = look.bar + look.gap;
    // Between ticks the strip slides left by a fraction of one bar, so twelve
    // samples a second read as continuous motion instead of a twelve-frame
    // stutter. Reduced motion gets the same data, parked on the grid.
    const slide = reduceMotion()
      ? 0
      : Math.max(0, Math.min(1, (now - lastTickAt) / TICK_MS)) * stepX;

    ctx.save();
    ctx.fillStyle = buildGradient();

    const n = samples.length;
    for (let i = 0; i < n; i++) {
      // Newest sample sits at the right edge; older ones march left.
      const x = cssW - (n - i) * stepX - slide;
      if (x + look.bar < 0) continue;
      const v = samples[i];
      // A touch of shaping so a loud passage fills the strip without clipping:
      // the curve is on the DRAWN height only, never on the value we keep.
      const h = Math.max(MIN_BAR, Math.pow(v, look.curve) * (cssH - 4));
      // The oldest bars fade out rather than ending on a hard edge at x=0.
      const edge = Math.min(1, x / 64);
      ctx.globalAlpha = opacity * look.alpha * (0.2 + 0.8 * edge);
      round(ctx, x, mid - h / 2, look.bar, h, look.bar / 2);
    }
    ctx.restore();
  }

  // Rounded bar. roundRect where the engine has it (every Chromium the app ships
  // on), a plain rect otherwise — at three pixels wide nobody can tell, and it
  // beats a fallback that draws nothing.
  function round(c, x, y, w, h, r) {
    c.beginPath();
    if (typeof c.roundRect === 'function') c.roundRect(x, y, w, h, Math.min(r, h / 2));
    else c.rect(x, y, w, h);
    c.fill();
  }

  // Off-screen tiles and background tabs stop the loop; coming back resumes it.
  // These invalidate the cached geometry rather than waiting out its TTL, so a
  // tile scrolled back into view starts drawing at once instead of half a second
  // later. Passive + capture: the dashboard scrolls in a pager, not on window.
  function invalidate() { geomAt = 0; syncRunning(); }
  document.addEventListener('visibilitychange', invalidate);
  window.addEventListener('xenon:page-change', invalidate);
  window.addEventListener('resize', invalidate, { passive: true });
  document.addEventListener('scroll', invalidate, { passive: true, capture: true });

  window.MediaViz = {
    setStyle, setPalette, setPlaying, setSource, onLevels,
    STYLES: Object.keys(STYLES),
    // For tests and the settings preview.
    _state: () => ({ style, playing, proc, problem, sawLevels, samples: samples.length, running: raf !== null }),
  };
})();
