'use strict';

// Every light effect Xenon has, in one place: the pump's ring, every light in Settings ->
// Lighting, the Deck, Bit, widgets and the Maker read this list, and the server and the menu's
// moving cards draw with the same maths, so a card shows what the lights do.
//
// frame(effect, opts) gives the colour of each LED for one instant, brightness not applied:
//   shape    'ring' (a fan, a pump: closed), 'line' (a strip, RAM: two ends), 'one' (one colour)
//   count    how many LEDs (one when the shape is 'one')
//   colours  [{ r, g, b }], the first leading (white when there are none)
//   speed    1..100 (50 as made), or 'slow' | 'normal' | 'fast'; reverse: true runs it backwards
//   size     0..1, the effect's own amount (its tail, drops, stars, beam: LIST says which)
//   glow     0..1, how lit the dark part stays (only where LIST gives the effect a glow)
//   phase    0..1, how far behind this light runs, so several lights can go one after another
//   now      the time in ms: a frame is the same for the same time
//   inputs   what effects that follow something read: { level, sound, load 0..1, fans (rpm),
//            sky { rise, set } (minutes of the day), weather { kind, night }, timer { left 0..1 } }
//   state    an object kept between frames of one light, so a speed that changes (load, fans)
//            turns on smoothly instead of jumping; without it the turn is worked out from now.
// No effect flashes the whole set more than three times a second.
((root, factory) => {
  const parts = typeof module !== 'undefined' && module.exports
    ? { colour: require('./light-fx-colour.js'), calm: require('./light-fx-calm.js'), moving: require('./light-fx-moving.js'), pc: require('./light-fx-pc.js') }
    : root.LightFxParts;
  const api = factory(parts);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LightFx = api;
})(typeof window !== 'undefined' ? window : globalThis, (parts) => {
  const C = parts.colour;
  const { clamp01, wrap, hex } = C;

  // group: how a list sorts them. needs: what it follows besides the time. moves: whether it
  // changes by itself. colours: false when it draws in its own colours. size: what its amount
  // is called (null when it has none). glow: how lit its dark part stays as made (null: no dark part).
  // about: one plain line for Bit, the docs and the Maker; the app's words are in i18n.
  const E = (id, group, about, o = {}) => Object.freeze({ id, group, about, needs: null, moves: true, colours: true, size: null, glow: null, ...o });
  const LIST = Object.freeze([
    E('still', 'calm', 'Your colours, standing still.', { moves: false }),
    E('breathe', 'calm', 'All the lights fade in and out slowly.', { glow: 0.15 }),
    E('alternate', 'calm', 'Two colours swap places slowly, like a tide.'),
    E('aurora', 'calm', 'Soft curtains of colour drift, like northern lights.', { size: 'waves', glow: 0.1 }),
    E('candle', 'calm', 'Each light flickers on its own, like a flame.', { glow: 0.1 }),
    E('starry', 'calm', 'A few lights at a time glow softly and fade, like stars.', { size: 'stars', glow: 0.04 }),
    E('lava', 'calm', 'Slow blobs of your colours drift and melt into each other.', { size: 'blobs', glow: 0.06 }),
    E('shift', 'calm', 'Every light together, from one colour to the next.'),
    E('spin', 'moving', 'A light with a long tail goes round.', { size: 'tail', glow: 0.1 }),
    E('turn', 'moving', 'Your colours turn round, every light on.'),
    E('comet', 'moving', 'A bright head with a fading tail runs round.', { size: 'tail', glow: 0.03 }),
    E('orbit', 'moving', 'Two lights chase each other on opposite sides.', { size: 'tail', glow: 0.04 }),
    E('scanner', 'moving', 'A beam sweeps from one end to the other and back.', { size: 'beam', glow: 0.04 }),
    E('chase', 'moving', 'Small groups of lights step forward, like a theatre sign.', { size: 'gap', glow: 0.05 }),
    E('bands', 'moving', 'Bright and dim bands roll round.', { size: 'waves', glow: 0.1 }),
    E('fill', 'moving', 'The lights fill one by one, then empty, a new colour each time.', { glow: 0.04 }),
    E('ripple', 'moving', 'Rings of light spread out from the top.', { size: 'width', glow: 0.05 }),
    E('sparkle', 'moving', 'Quick white glints over your colours.', { size: 'sparkles', glow: 0.2 }),
    E('rainbow', 'moving', 'Every colour of the rainbow, turning.', { size: 'waves', colours: false }),
    E('heartbeat', 'moving', 'Two beats and a rest, like a heart.', { glow: 0.12 }),
    E('fire', 'moving', 'Flames rise from the bottom, hottest at the root.', { size: 'flames', glow: 0.03 }),
    E('rain', 'moving', 'Drops slide down and fade.', { size: 'drops', glow: 0.04 }),
    E('lighthouse', 'moving', 'One wide beam turns slowly, like a lighthouse.', { size: 'beam', glow: 0.05 }),
    E('beat', 'music', 'Pulses with the music the PC is playing.', { needs: 'sound', glow: 0.4 }),
    E('meter', 'music', 'Rises and falls with how loud the PC is.', { needs: 'sound', glow: 0.06 }),
    E('level', 'pc', 'Fills up to a reading, from your first colour to your last.', { needs: 'level', moves: false, glow: 0.08 }),
    E('heat', 'pc', 'Warms from your colour to red as a reading rises.', { needs: 'level' }),
    E('clock', 'pc', 'An arc for the hours, a dot for the minutes, a spark for the seconds.', { needs: 'time', glow: 0.05 }),
    E('load', 'pc', 'Turns faster and warmer the harder the PC works.', { needs: 'load', size: 'tail', glow: 0.1 }),
    E('fans', 'pc', 'Blades of light that turn with your fans.', { needs: 'fans', size: 'blades', glow: 0.06 }),
    E('sky', 'pc', "Today's sky: dawn, day, sunset and night at your times.", { needs: 'sky', colours: false }),
    E('weather', 'pc', 'The weather outside: sun, clouds, rain, snow, storms.', { needs: 'weather', colours: false }),
    E('timer', 'pc', 'Empties as a Xenon timer runs down.', { needs: 'timer', glow: 0.05 }),
  ]);
  const EFFECTS = Object.freeze(LIST.map((e) => e.id));
  const GROUPS = Object.freeze(['calm', 'moving', 'music', 'pc']);
  const NEEDS = Object.freeze(['sound', 'level', 'time', 'load', 'fans', 'sky', 'weather', 'timer']);
  const SHAPES = Object.freeze(['ring', 'line', 'one']);
  const SIZES = Object.freeze([...new Set(LIST.map((e) => e.size).filter(Boolean))]);
  const WEATHER_KINDS = Object.freeze(['clear', 'clouds', 'fog', 'rain', 'snow', 'storm']);
  // The three speeds the pump had before the slider, as places on it.
  const SPEED_OF = Object.freeze({ slow: 30, normal: 50, fast: 72 });
  const BY_ID = new Map(LIST.map((e) => [e.id, e]));
  // Settings -> Lighting: every effect but those that fill or warm with a line's reading (the
  // lights have no line). The names it saved before this list are read for ever as the effect
  // each became, in the colours each had: a fixed rainbow, the aurora's own, the list.
  const LIGHTING = Object.freeze(LIST.filter((e) => e.needs !== 'level').map((e) => e.id));
  const OLD_LIGHTING = Object.freeze({ solid: 'still', breathing: 'breathe', candle: 'candle', cycle: 'shift', wave: 'rainbow', aurora: 'aurora', palette: 'turn' });
  const OLD_COLOURS = Object.freeze({ cycle: ['#ff0000', '#ffb000', '#30ff00', '#00e0ff', '#2040ff', '#d000ff'], aurora: C.PALETTES.aurora });
  const CANDLE = '#ff9329';
  // The palette every look of the lights starts with: a look that still holds it chose no colours.
  const UNTOUCHED = Object.freeze(['#1ed760', '#0066ff']);
  const HEX = /^#[0-9a-f]{6}$/i;
  const FLASH_GAP = 350;   // ms: under three flashes a second, with room to spare
  const TAU = Math.PI * 2;

  const isEffect = (id) => BY_ID.has(id);
  const about = (id) => BY_ID.get(id) || BY_ID.get('still');
  const moves = (id) => about(id).moves;
  const num01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : null);

  /** 1..100 from a number or one of the old names; 50 when neither. */
  function speedOf(v) {
    if (typeof v === 'string' && SPEED_OF[v]) return SPEED_OF[v];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : 50;
  }
  // 50 runs as made; every 26 steps doubles or halves the time a turn takes. The old names keep
  // the exact pace they had, so a pump saved with them moves as it did.
  const NAMED_PACE = Object.freeze({ slow: 1.7, normal: 1, fast: 0.55 });
  const paceOf = (v) => NAMED_PACE[v] ?? 2 ** ((50 - speedOf(v)) / 26);

  // Shared by every draw (light-fx-calm.js, -moving.js, -pc.js).
  const hash = (a, b) => {
    let v = (Math.imul(a + 1, 374761393) + Math.imul(b + 7, 668265263)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const DRAW = {};
  const helpers = Object.freeze({
    ...C, TAU, FLASH_GAP,
    WHITE: Object.freeze({ r: 255, g: 255, b: 255 }), WARM: Object.freeze({ r: 255, g: 176, b: 32 }), HOT: Object.freeze({ r: 255, g: 48, b: 64 }),
    hash,
    // 0..1 that rises and falls once per period, from 0.
    swell: (p) => 0.5 - 0.5 * Math.cos(TAU * p),
    bump: (x, width) => Math.exp(-((x / width) ** 2)),
    // Smooth noise along time for one LED.
    drift: (i, t) => { const k = Math.floor(t); const f = t - k; const s = f * f * (3 - 2 * f); return hash(i, k) * (1 - s) + hash(i, k + 1) * s; },
    draw: (id) => DRAW[about(id).id],
  });
  Object.assign(DRAW, parts.calm(helpers), parts.moving(helpers), parts.pc(helpers));

  function colourList(list) {
    const ok = (c) => c && Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);
    return Array.isArray(list) ? list.filter(ok) : [];
  }
  function inputsOf(opts) {
    const inp = opts.inputs && typeof opts.inputs === 'object' ? opts.inputs : {};
    const mins = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440 ? v : null);
    const sky = inp.sky && mins(inp.sky.rise) != null && mins(inp.sky.set) != null ? { rise: inp.sky.rise, set: inp.sky.set } : null;
    const w = inp.weather;
    const left = num01(inp.timer?.left);
    return {
      level: num01(inp.level ?? opts.level), sound: num01(inp.sound ?? opts.sound), load: num01(inp.load),
      fans: typeof inp.fans === 'number' && Number.isFinite(inp.fans) && inp.fans >= 0 ? inp.fans : null,
      sky, weather: w && WEATHER_KINDS.includes(w.kind) ? { kind: w.kind, night: w.night === true } : null,
      timer: left == null ? null : { left },
    };
  }

  // Where x is along the lights, and the frame's tools for the draws.
  function context(entry, n, shape, opts) {
    const pal = C.palette(colourList(opts.colours));
    const now = Number.isFinite(opts.now) ? opts.now : 0;
    const pace = paceOf(opts.speed);
    const ring = shape === 'ring';
    const phase = num01(opts.phase) ?? 0;
    const glow = entry.glow == null ? 0 : (num01(opts.glow) ?? entry.glow);
    const memo = new Map();
    const apart = (a, b) => { const d = Math.abs(wrap(a) - wrap(b)); return Math.min(d, 1 - d); };
    const K = {
      now, pace, phase, glow, ring, count: n, size: num01(opts.size) ?? 0.5, in: inputsOf(opts),
      palette: pal, ncol: pal.size, c0: pal.pick(0), c1: pal.pick(pal.size > 1 ? 1 : 0), pick: pal.pick,
      along: (x) => (ring || x < 0 || x > 1 ? pal.loop(x) : pal.line(x)),
      lit: (c, k) => C.dim(c, glow + (1 - glow) * clamp01(k)),
      // 0..1 through a period of `period` ms at this speed; `flashes` a period keeps it under three a second.
      t: (period, flashes = 0) => wrap(now / Math.max(period * pace, flashes * FLASH_GAP) + phase),
      // 0 at the top of a ring, 1 at its bottom; along a strip from its start (`up`: from its end).
      from: (x, up) => (ring ? Math.min(wrap(x), 1 - wrap(x)) * 2 : up ? 1 - x : x),
      dist: (x, at) => (ring ? apart(x, at) : Math.abs(x - wrap(at))),
      // A light at `head` with a tail `len` long behind it, soft one LED ahead so it glides.
      tail: (x, head, len) => {
        const at = ring ? wrap(head) : wrap(head) * (1 + len);
        const behind = ring ? wrap(at - x) : at - x;
        const ahead = ring ? wrap(x - at) : x - at;
        if (ahead >= 0 && ahead < 1 / n && ahead < 0.5) return 1 - ahead * n;
        return behind >= 0 && behind <= len ? (1 - behind / len) ** 2 : 0;
      },
      // Turns made at `rate` a second, kept smooth across frames when the light has a state; with
      // `passes` lights going round, no LED is passed more than three times a second.
      turn: (rate, passes = 1) => K.memo('turn', () => {
        const r = Math.min(rate / pace, 1000 / (FLASH_GAP * passes));
        const st = opts.state && typeof opts.state === 'object' ? opts.state : null;
        if (!st) return wrap((now * r) / 1000 + phase);
        const prev = st[entry.id];
        const dt = prev ? Math.min(250, Math.max(0, now - prev.at)) : 0;
        const turns = wrap((prev ? prev.turns : 0) + (r * dt) / 1000);
        st[entry.id] = { at: now, turns };
        return wrap(turns + phase);
      }),
      memo: (key, make) => { if (!memo.has(key)) memo.set(key, make()); return memo.get(key); },
      // The same frame drawn as another effect would, with some options of its own.
      with: (id, over) => context(about(id), n, shape, { ...opts, ...over }),
    };
    return K;
  }

  function frame(effect, opts = {}) {
    const asked = SHAPES.includes(opts.shape) ? opts.shape : 'ring';
    const n = asked === 'one' ? 1 : Math.max(0, Math.floor(Number(opts.count) || 0));
    if (!n) return [];
    // One LED is one light, whatever shape it was asked as.
    const shape = n === 1 ? 'one' : asked;
    const entry = about(effect);
    const K = context(entry, n, shape, opts);
    const draw = DRAW[entry.id];
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const at = !opts.reverse ? i : shape === 'ring' ? (n - i) % n : n - 1 - i;
      const x = shape === 'ring' ? at / n : n > 1 ? at / (n - 1) : 0;
      out[i] = draw(x, at, K);
    }
    return out;
  }

  const isLighting = (style) => style === 'none' || LIGHTING.includes(style) || Object.hasOwn(OLD_LIGHTING, style);
  // Colours chosen for the look: a palette led by its colour (the page, Bit and the Deck save them
  // so), not the one it started with.
  function chose(look) {
    const pal = Array.isArray(look.palette) ? look.palette.map((c) => String(c).toLowerCase()) : [];
    const untouched = pal.length === UNTOUCHED.length && pal.every((c, i) => c === UNTOUCHED[i]);
    return pal.length > 0 && !untouched && pal[0] === String(look.color).toLowerCase();
  }

  /**
   * A look of Settings -> Lighting ({ style, color, palette }) as an effect and its colours, or
   * null for 'none' or a style it does not know. Effects of this list take the palette when the
   * look has one, else its one colour; the old names take the colours they always had, but one
   * that is an effect of the list too (aurora, candle) takes the colours chosen for it.
   */
  function lightingLook(look) {
    const style = look?.style;
    const effect = typeof style === 'string' ? (Object.hasOwn(OLD_LIGHTING, style) ? OLD_LIGHTING[style] : LIGHTING.includes(style) ? style : null) : null;
    if (!effect) return null;
    const one = [typeof look.color === 'string' && HEX.test(look.color) ? look.color : style === 'candle' ? CANDLE : null];
    const list = Array.isArray(look.palette) && look.palette.length ? look.palette : one;
    const old = Object.hasOwn(OLD_LIGHTING, style) && !(effect === style && chose(look));
    const said = (old && OLD_COLOURS[style]) || (style === 'palette' || !old ? list : one);
    return { effect, colours: said.filter((c) => typeof c === 'string' && HEX.test(c)).map(hex) };
  }

  const PALETTES = Object.freeze(Object.fromEntries(C.PALETTE_IDS.map((id) => [id, Object.freeze(C.PALETTES[id].map(hex))])));

  return Object.freeze({
    LIST, EFFECTS, GROUPS, NEEDS, SHAPES, SIZES, WEATHER_KINDS, SPEED_OF, PALETTE_IDS: C.PALETTE_IDS, PALETTES, LIGHTING, OLD_LIGHTING,
    isEffect, about, moves, speedOf, paceOf, frame, isLighting, lightingLook,
  });
});
