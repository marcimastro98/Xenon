'use strict';

// A device drawn with the one effect engine (light-fx.js), part by part in its own shape, the same
// on the server that paints the lights (lights/fx-look.js) and on the page that shows them moving
// (lighting-map/map-motion.js): a fan and each ring of a pump closed, a strip, a RAM stick or a
// block open, a board's zones as one line, keys and other placed LEDs from left to right.
// A device here is { ledIds, segments: [{ kind, ledIds, rings?, pos? }] }.
((root, factory) => {
  const Fx = typeof module !== 'undefined' && module.exports ? require('./light-fx.js') : root.LightFx;
  const api = factory(Fx);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LightFxDevice = api;
})(typeof window !== 'undefined' ? window : globalThis, (Fx) => {
  const SAMPLES = 48;   // places across a line of placed LEDs (keys), each LED takes the nearest
  const OPEN = Object.freeze(['strip', 'dram', 'block']);
  const shapes = new WeakMap();   // device -> its parts

  const share = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

  // A pump's rings, as { from, n } over its LEDs: the sizes it says when they add up, else one ring.
  function ringSizes(seg) {
    const sizes = Array.isArray(seg.rings) ? seg.rings : [];
    const whole = [{ from: 0, n: seg.ledIds.length }];
    if (!sizes.length || !sizes.every((n) => Number.isInteger(n) && n > 0)) return whole;
    if (sizes.reduce((a, n) => a + n, 0) !== seg.ledIds.length) return whole;
    let from = 0;
    return sizes.map((n) => { const r = { from, n }; from += n; return r; });
  }

  // Where each LED of a placed part sits from left to right, 0..1.
  function across(pos) {
    const xs = pos.map((p) => (Array.isArray(p) ? Number(p[0]) || 0 : 0));
    const lo = Math.min(...xs);
    const span = Math.max(...xs) - lo;
    return xs.map((x) => (span > 0 ? (x - lo) / span : 0));
  }

  // A device's parts: { shape, at (indexes into dev.ledIds), x? }, worked out once per device object.
  function partsOf(dev) {
    if (shapes.has(dev)) return shapes.get(dev);
    const index = new Map(dev.ledIds.map((id, i) => [id, i]));
    const parts = [];
    let zones = null;
    for (const seg of Array.isArray(dev.segments) ? dev.segments : []) {
      const ids = Array.isArray(seg.ledIds) ? seg.ledIds : [];
      const at = ids.map((id) => index.get(id));
      if (!at.length || at.some((i) => i === undefined)) continue;
      if (seg.kind === 'zone') {
        if (!zones) { zones = { shape: 'line', at: [] }; parts.push(zones); }
        zones.at.push(...at);
      } else if (seg.kind === 'pos' && Array.isArray(seg.pos) && seg.pos.length === at.length) {
        parts.push({ shape: 'line', at, x: across(seg.pos) });
      } else if (seg.kind === 'pump') {
        for (const r of ringSizes(seg)) parts.push({ shape: 'ring', at: at.slice(r.from, r.from + r.n) });
      } else {
        parts.push({ shape: OPEN.includes(seg.kind) ? 'line' : 'ring', at });
      }
    }
    if (!parts.length && dev.ledIds.length) parts.push({ shape: 'line', at: dev.ledIds.map((_, i) => i) });
    shapes.set(dev, parts);
    return parts;
  }

  // Some LEDs of a device (indexes into dev.ledIds) as pieces: each part they fill whole in its own
  // shape, keyed by its place, the rest as one line keyed 'rest'.
  function piecesOf(dev, idx) {
    const place = new Set(idx);
    const pieces = (dev ? partsOf(dev) : []).map((part, k) => ({ part, k })).filter(({ part }) => part.at.every((i) => place.has(i)));
    const whole = new Set(pieces.flatMap(({ part }) => part.at));
    const left = idx.filter((i) => !whole.has(i));
    if (left.length) pieces.push({ part: { shape: 'line', at: left }, k: 'rest' });
    return pieces;
  }

  /**
   * One part's colours now, one per part.at: `fx` is { effect, colours } (LightFx.lightingLook), `look`
   * gives speed, reverse, size and glow, `opts` { now, inputs, phase, state } go to LightFx.frame.
   */
  function drawPart(fx, look, part, opts) {
    const n = part.x ? Math.min(SAMPLES, part.at.length) : part.at.length;
    const leds = Fx.frame(fx.effect, {
      ...opts, shape: part.shape, count: n, colours: fx.colours, speed: look.speed, reverse: look.reverse === true,
      size: share(look.size), glow: share(look.glow),
    });
    return part.x ? part.x.map((f) => leds[Math.round(f * (n - 1))]) : leds;
  }

  return { ringSizes, partsOf, piecesOf, drawPart, share };
});
