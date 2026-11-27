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
   * hidden. Its pace (setPace, bitDirector.PACES) says how much it moves;
   * still (hold(true): the app's own freeze states) stops it, and a reaction
   * asked meanwhile waits, the last one only. Reduced motion shows still poses
   * and no fidgets. A page without bit-director.js gets no fidgets, never an error. */

  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  // The page's own Bit (BitApp.setOwn): every player without a look of its own draws it.
  let pageLook = null;
  const live = new Set();

  /** Every Bit in the page wears this look from now on (null: the classic Bit). */
  function useLook(look) {
    pageLook = look || null;
    for (const p of live) p.refresh();
  }
  const { stillIndex } = bit;

  /**
   * @param {Element} host
   * @param {object} [opts]
   * @param {string} [opts.mood]          starting mood clip id (default 'idle')
   * @param {string} [opts.label]         accessible name; omit for decorative
   * @param {boolean|string[]} [opts.fidgets] idle surprises (default true), or only these clip ids
   * @param {boolean} [opts.calm]         fewer surprises
   * @param {boolean} [opts.reducedMotion] force still poses (default: OS setting)
   * @param {() => object} [opts.context] the moment, for bitDirector.fits()
   * @param {(id: string) => void} [opts.onClip] told when a clip starts
   * @param {() => void} [opts.onWake] told when it starts playing again after a stop
   * @param {() => object|null} [opts.look] a look of its own (bit-look.js), read on every
   *   frame: a try-on preview. Without it the player draws the page's look (useLook)
   * @param {boolean} [opts.home] its home always behind it (its room), not only while it sleeps
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
      current: null, index: 0, timer: 0, idleTimer: 0, recent: [], pokes: 0, tint: null, running: false,
      pageVisible: typeof document === 'undefined' || !document.hidden,
      inView: true,
      held: false,
      pace: 'live',
      resolveReact: null,
      shown: null,
      drawn: 0,
      sign: null, // what it has to tell (bit-signs.js signal()), or null
    };

    const reduced = () => (opts.reducedMotion != null ? !!opts.reducedMotion : !!(motionQuery && motionQuery.matches));
    const rhythm = () => (typeof opts.director === 'function' ? opts.director() : opts.director) || director()?.CLASSIC || null;

    function draw(c, i) {
      const { layers } = bit.renderFrame(c, i, { tint: state.tint, look: opts.look ? opts.look() : pageLook, home: opts.home === true, signal: state.sign });
      state.shown = c;
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

    function finishReact() { const done = state.resolveReact; state.resolveReact = null; if (done) done(); }

    // Between clips off the live pace: the mood's clearest frame, or asleep its sleeping pose.
    function rest() {
      const c = bit.clip(state.pace === 'asleep' && bit.clip('sleep') ? 'sleep' : state.mood);
      draw(c, stillIndex(c));
    }

    // fidgets: false none, an array of clip ids only those (the clock's calm Bit), else the rhythm's pick.
    function scheduleIdle() {
      clearTimeout(state.idleTimer);
      const d = director();
      const pace = rhythm();
      if (!d || !pace || !state.running || reduced() || opts.fidgets === false || state.mood !== 'idle') return;
      const ctx = () => (opts.context ? opts.context() : {});
      const gap = d.idleGap(pace, state.pace, ctx(), opts.calm);
      if (!gap) return;
      state.idleTimer = setTimeout(() => {
        if (state.current && state.current.kind !== 'mood') return;
        const next = d.idleFidget(pace, ctx(), state.recent, opts.fidgets);
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
      // Held, a reaction waits as the current clip and shows the rest pose, never its first frame.
      // A calm loop (bit-clips-move.js 'code', 'gamer') plays on the slow and game paces too.
      if (!state.running || (c.kind === 'mood' && state.pace !== 'live' && !(c.calm && /^(slow|game)$/.test(state.pace)))) {
        rest();
        if (state.running) scheduleIdle();
        return;
      }
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
        if (state.current && state.current.kind !== 'mood') rest();
        return;
      }
      start(state.current && state.current.kind !== 'mood' ? state.current : bit.clip(state.mood));
      if (opts.onWake) opts.onWake();
    }

    function setPace(name) {
      const next = (director()?.PACES || ['live', 'still']).includes(name) ? name : 'live';
      if (next === state.pace) return;
      const was = state.running;
      state.pace = next;
      state.held = next === 'still';
      updateRunning();
      // A reaction playing ends into the new pace by itself; a mood starts again in it.
      if (was && state.running && (!state.current || state.current.kind === 'mood')) {
        clearTimers();
        start(bit.clip(state.mood));
      }
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
        setPace(held ? 'still' : 'live');
      },
      setPace,
      get pace() { return state.pace; },
      /** Plays now: shown, on screen and not held. */
      get running() { return state.running; },
      get mood() { return state.mood; },
      get clip() { return state.current ? state.current.id : null; },
      /** What it has to tell (bit-signs.js signal(kind)), or null for none: its antenna and its computer's
       *  screen show it at once, on every frame. */
      sign(next) {
        state.sign = next && typeof next.tip === 'string' && Array.isArray(next.screen) ? next : null;
        if (state.shown) draw(state.shown, state.drawn || 0);
      },
      /** Draws the frame on screen again: after the look changed. */
      refresh() {
        if (state.shown) draw(state.shown, state.drawn || 0);
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
