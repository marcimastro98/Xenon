;(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const bit = node ? require('./bit.js') : root.Xenon.bit;
  // Read when Bit idles, not now: a page may load bit-director.js after this file.
  const director = node ? () => require('./bit-director.js') : () => root.Xenon.bitDirector || null;
  const mod = factory(bit, director);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitPlayer = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (bit, director) {
  'use strict';

  /* Bit, alive: mounts an SVG in a host element and plays clips on it.
   * A mood loops; while Bit is idle a fidget plays now and then (fitted to
   * the moment, never the same twice in a row); react() plays one clip and
   * goes back to the mood. Stops itself while the page or the element is
   * hidden, or while the host holds it (hold(true): the app's own freeze
   * states); reduced motion shows still poses and no fidgets. */

  const NS = 'http://www.w3.org/2000/svg';
  const CALM_FACTOR = 2.5;

  // Without a personal Bit's director: the classic rhythm, any fidget that fits.
  // A page without bit-director.js gets no idle fidgets, never an error.
  function classic() {
    const d = director();
    if (!d) return null;
    return {
      idleGapMs() {
        const [lo, hi] = d.IDLE_GAP_MS;
        return lo + Math.random() * (hi - lo);
      },
      nextFidget: (ctx, recent) => d.pickFidget(ctx, recent),
    };
  }
  let uid = 0;

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  // The frame a still pose shows: the longest one, usually the clearest face.
  // The page's own Bit (BitApp.setOwn): every player without a look of its own draws it.
  let pageLook = null;
  const live = new Set();

  /** Every Bit in the page wears this look from now on (null: the classic Bit). */
  function useLook(look) {
    pageLook = look || null;
    for (const p of live) p.refresh();
  }

  function stillIndex(c) {
    let best = 0;
    c.frames.forEach((f, i) => {
      if (f.ms > c.frames[best].ms) best = i;
    });
    return best;
  }

  /**
   * @param {Element} host
   * @param {object} [opts]
   * @param {string} [opts.mood]          starting mood clip id (default 'idle')
   * @param {string} [opts.label]         accessible name; omit for decorative
   * @param {boolean} [opts.fidgets]      idle surprises (default true)
   * @param {boolean} [opts.calm]         fewer surprises
   * @param {boolean} [opts.reducedMotion] force still poses (default: OS setting)
   * @param {() => object} [opts.context] the moment, for bitDirector.fits()
   * @param {(id: string) => void} [opts.onClip] told when a clip starts
   * @param {() => object|null} [opts.look] a look of its own (bit-look.js), read on every
   *   frame: a try-on preview. Without it the player draws the page's look (useLook)
   * @param {object|(() => object|null)} [opts.director] a personal Bit's rhythm
   *   (bitDirector.createDirector), or a getter for it; default the classic one
   */
  function mount(host, opts = {}) {
    const id = `bit-floor-${++uid}`;
    const { STAGE } = bit;
    const svg = el('svg', { viewBox: `${STAGE.x} ${STAGE.y} ${STAGE.w} ${STAGE.h}`, class: 'xbit' });
    if (opts.label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', opts.label);
    } else {
      svg.setAttribute('aria-hidden', 'true');
    }
    const defs = el('defs', {});
    const cp = el('clipPath', { id });
    cp.appendChild(el('rect', { x: STAGE.x, y: STAGE.y, width: STAGE.w, height: 11 - STAGE.y }));
    defs.appendChild(cp);
    const stage = el('g', {});
    svg.append(defs, stage);
    host.appendChild(svg);

    const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const state = {
      mood: bit.clip(opts.mood) ? opts.mood : 'idle',
      current: null,
      index: 0,
      timer: 0,
      idleTimer: 0,
      recent: [],
      pokes: 0,
      tint: null,
      running: false,
      pageVisible: typeof document === 'undefined' || !document.hidden,
      inView: true,
      held: false,
      resolveReact: null,
      drawn: 0,
    };

    const reduced = () => (opts.reducedMotion != null ? !!opts.reducedMotion : !!(motionQuery && motionQuery.matches));
    const rhythm = () => (typeof opts.director === 'function' ? opts.director() : opts.director) || classic();

    function draw(c, i) {
      const { layers } = bit.renderFrame(c, i, { tint: state.tint, look: opts.look ? opts.look() : pageLook });
      state.drawn = i;
      const groups = layers.map((l) => {
        const g = el('g', {});
        const tr = bit.transformAttr(l.transform);
        if (tr) g.setAttribute('transform', tr);
        for (const p of bit.paths(l.rects)) {
          const path = el('path', { d: p.d, fill: p.fill });
          if (p.o < 1) path.setAttribute('opacity', p.o);
          g.appendChild(path);
        }
        if (!l.clipFloor) return g;
        const wrap = el('g', { 'clip-path': `url(#${id})` });
        wrap.appendChild(g);
        return wrap;
      });
      stage.replaceChildren(...groups);
    }

    function clearTimers() {
      clearTimeout(state.timer);
      clearTimeout(state.idleTimer);
      state.timer = 0;
      state.idleTimer = 0;
    }

    function finishReact() {
      const done = state.resolveReact;
      state.resolveReact = null;
      if (done) done();
    }

    function scheduleIdle() {
      clearTimeout(state.idleTimer);
      const pace = rhythm();
      if (!pace || !state.running || reduced() || opts.fidgets === false || state.mood !== 'idle') return;
      const ctx = opts.context ? opts.context() : {};
      const gap = pace.idleGapMs(ctx) * (opts.calm ? CALM_FACTOR : 1);
      state.idleTimer = setTimeout(() => {
        if (state.current && state.current.kind !== 'mood') return;
        const next = pace.nextFidget(opts.context ? opts.context() : {}, state.recent);
        if (next) play(next);
      }, gap);
    }

    function step() {
      const c = state.current;
      draw(c, state.index);
      if (reduced()) return;
      state.timer = setTimeout(() => {
        state.index += 1;
        if (state.index < c.frames.length) return step();
        if (c.kind === 'mood') {
          state.index = 0;
          return step();
        }
        finishReact();
        start(bit.clip(state.mood));
      }, c.frames[state.index].ms);
    }

    function start(c) {
      clearTimeout(state.timer);
      state.current = c;
      state.index = 0;
      if (opts.onClip) opts.onClip(c.id);
      if (reduced()) {
        draw(c, stillIndex(c));
        if (c.kind !== 'mood') state.timer = setTimeout(() => (finishReact(), start(bit.clip(state.mood))), bit.duration(c));
        return;
      }
      if (!state.running) return draw(c, 0);
      step();
      if (c.kind === 'mood') scheduleIdle();
    }

    function play(clipId) {
      const c = bit.clip(clipId);
      if (!c) return Promise.resolve();
      if (c.kind === 'mood') {
        setMood(clipId);
        return Promise.resolve();
      }
      finishReact();
      state.recent.push(c.id);
      if (state.recent.length > 12) state.recent.shift();
      return new Promise((resolve) => {
        state.resolveReact = resolve;
        start(c);
      });
    }

    function setMood(mood, tint) {
      if (!bit.clip(mood)) return;
      state.tint = tint || null;
      const same = state.mood === mood;
      state.mood = mood;
      if (same && state.current && state.current.kind === 'mood') return;
      finishReact();
      start(bit.clip(mood));
    }

    function poke() {
      const order = bit.POKES;
      return play(order[state.pokes++ % order.length]);
    }

    function updateRunning() {
      const should = state.pageVisible && state.inView && !state.held;
      if (should === state.running) return;
      state.running = should;
      if (!should) {
        clearTimers();
        return;
      }
      start(state.current && state.current.kind !== 'mood' ? state.current : bit.clip(state.mood));
    }

    const onVisibility = () => {
      state.pageVisible = !document.hidden;
      updateRunning();
    };
    const onMotion = () => start(state.current || bit.clip(state.mood));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener('change', onMotion);
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            state.inView = entries.some((e) => e.isIntersecting);
            updateRunning();
          })
        : null;
    if (io) io.observe(svg);

    state.running = state.pageVisible && state.inView;
    start(bit.clip(state.mood));

    const api = {
      element: svg,
      setMood,
      play,
      poke,
      hold(held) {
        state.held = !!held;
        updateRunning();
      },
      get mood() {
        return state.mood;
      },
      get clip() {
        return state.current ? state.current.id : null;
      },
      /** Draws the frame on screen again: after the look changed. */
      refresh() {
        if (state.current) draw(state.current, state.drawn || 0);
      },
      destroy() {
        clearTimers();
        finishReact();
        state.running = false;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        if (motionQuery && motionQuery.removeEventListener) motionQuery.removeEventListener('change', onMotion);
        if (io) io.disconnect();
        svg.remove();
        live.delete(api);
      },
    };
    live.add(api);
    return api;
  }

  return { mount, stillIndex, useLook, look: () => pageLook };
});
