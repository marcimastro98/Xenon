'use strict';

// Light effects drawn moving on a page, with the one effect engine (js/light-fx/light-fx.js): a
// node given a look gets a canvas of LEDs, round as a fan or a pump ring, or in a row as a strip,
// so a card shows what the lights will do. One loop for all of them at the lights' own pace, which
// stops by itself while none is on screen or the page is hidden; with less motion asked, each
// shows one moment, still. The Xenon menu's pump cards (js/menu/xenon-menu-pump-fx.js) and
// Settings -> Lighting (js/lighting-page/effect-cards.js) use it; the engine's scripts load first.
// A page that colours LEDs of its own (the lighting map, lighting-map/map-motion.js) runs on the
// same loop with run().
(() => {
  const FRAME_MS = 66;   // as the lights' own ticker (lights/upkeep.js)
  const RING_LEDS = 24;
  const LINE_LEDS = 12;
  const BOX = 52;        // a ring's side, CSS px, when the look says none
  const DOT = 3.2;       // at BOX, and in proportion on a box of another size
  const LINE_HIGH = 14;  // a strip's height, CSS px
  // Xenon's colours, when a look says none.
  const COLOURS = Object.freeze([{ r: 110, g: 231, b: 135 }, { r: 138, g: 180, b: 248 }, { r: 255, g: 215, b: 94 }]);
  const shows = new Set();   // { canvas, ctx, look, state }, or { canvas: a node, tick } (run)
  const byNode = new WeakMap();
  let frame = 0;
  let last = 0;

  const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // What the effects that follow something play for a card: a reading that rises and falls, a
  // sound that pumps, a PC working harder and easier, fans at a steady speed, rain, a timer running
  // down. A whole day goes by in DAY_MS: sunrise and sunset are set round the clock so that the sky
  // reads the played hour (rise 6:30, set 19:00).
  const TIMER_MS = 20_000;
  const DAY_MS = 24_000;
  const DAY_MIN = 1440;
  function playedSky(now) {
    const d = new Date(now);
    const clock = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    const shift = clock - ((now % DAY_MS) / DAY_MS) * DAY_MIN;
    const at = (m) => Math.round((((m + shift) % DAY_MIN) + DAY_MIN) % DAY_MIN);
    return { rise: at(390), set: at(1140) };
  }
  const played = (now) => ({
    level: 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(now / 1600)), sound: 0.15 + 0.75 * Math.abs(Math.sin(now / 280)),
    load: 0.5 + 0.4 * Math.sin(now / 5000), fans: 1100, sky: playedSky(now), weather: { kind: 'rain' },
    timer: { left: 1 - (now % TIMER_MS) / TIMER_MS },
  });

  // Where each LED sits on the canvas, CSS px, and how big it is.
  function places(look) {
    const n = look.count;
    if (look.shape === 'line') {
      const r = Math.min(LINE_HIGH / 2 - 1, (look.box / n) * 0.36);
      const step = (look.box - 2 * r - 2) / Math.max(1, n - 1);
      return { r, at: Array.from({ length: n }, (_, i) => [r + 1 + i * step, LINE_HIGH / 2]) };
    }
    const mid = look.box / 2;
    const r = DOT * look.box / BOX;
    const radius = mid - r - 2;
    return { r, at: Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; return [mid + radius * Math.cos(a), mid + radius * Math.sin(a)]; }) };
  }

  function draw(show, now) {
    if (show.tick) { show.tick(now, played(now)); return; }
    const { ctx, look } = show;
    ctx.clearRect(0, 0, look.box, look.shape === 'line' ? LINE_HIGH : look.box);
    const leds = window.LightFx.frame(look.effect, {
      shape: look.shape, count: look.count, colours: look.colours, speed: look.speed, reverse: look.reverse,
      size: look.amount, glow: look.glow, phase: look.phase, now, inputs: played(now), state: show.state,
    });
    const { r, at } = places(look);
    leds.forEach((c, i) => {
      ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      ctx.beginPath();
      ctx.arc(at[i][0], at[i][1], r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // A canvas the page drew over goes, so a page redrawn for hours keeps no old ones.
  const prune = () => { for (const s of shows) if (!s.canvas.isConnected) shows.delete(s); };

  function loop(at) {
    frame = 0;
    prune();
    if (!shows.size || document.hidden) return;
    if (at - last >= FRAME_MS) {
      last = at;
      const now = Date.now();
      for (const s of shows) draw(s, now);
    }
    if (!still()) frame = requestAnimationFrame(loop);
  }
  const go = () => { if (!frame && shows.size && !still() && !document.hidden) frame = requestAnimationFrame(loop); };

  // A look as the page says it, made whole: { effect, shape, box, count, colours, speed, reverse, amount, glow, phase }.
  function whole(look) {
    const shape = look.shape === 'line' ? 'line' : 'ring';
    const box = Number(look.box) > 0 ? Number(look.box) : BOX;
    const count = Number(look.count) > 0 ? Math.round(Number(look.count)) : shape === 'line' ? LINE_LEDS : RING_LEDS;
    const colours = Array.isArray(look.colours) && look.colours.length ? look.colours : COLOURS;
    return { ...look, shape, box, count, colours, phase: Number(look.phase) || 0 };
  }

  // Draws a look in a node, moving: a node drawn before keeps its canvas and takes the new look.
  // False when the engine is not loaded or the effect is not one of its own.
  function mount(node, look) {
    if (!window.LightFx || !look || !window.LightFx.isEffect(look.effect)) return false;
    const known = byNode.get(node);
    if (known?.canvas.isConnected) {
      known.look = whole(look);
      draw(known, Date.now());
      return true;
    }
    const full = whole(look);
    const canvas = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = full.box * dpr;
    canvas.height = (full.shape === 'line' ? LINE_HIGH : full.box) * dpr;
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.scale(dpr, dpr);
    node.appendChild(canvas);
    const show = { canvas, ctx, look: full, state: {} };
    shows.add(show);
    byNode.set(node, show);
    draw(show, Date.now());
    go();
    return true;
  }

  // tick(now, inputs) runs on the loop while node is on the page, at once and at each frame after,
  // in place of the one run on that node before; no tick stops it. inputs are the ones the cards
  // play (played above).
  function run(node, tick) {
    const known = byNode.get(node);
    if (known?.tick) { shows.delete(known); byNode.delete(node); }
    if (typeof tick !== 'function') return;
    const show = { canvas: node, tick };
    shows.add(show);
    byNode.set(node, show);
    const now = Date.now();
    tick(now, played(now));
    go();
  }

  document.addEventListener('visibilitychange', go);

  window.LightFxPreview = { mount, run, COLOURS };
})();
