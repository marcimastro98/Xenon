'use strict';

// The lighting map's LEDs moving as the lights do: a device's effect, or the effect of each group of
// its LEDs, drawn part by part in the parts' own shapes with the code that paints the lights
// (js/light-fx/light-fx-device.js), on the cards' loop (js/light-fx/light-fx-preview.js, which stops
// off screen, on a hidden page and with less motion asked). What follows the PC plays the cards'
// readings. Loaded with the effect cards (lighting/lighting-ui.js loadEffects).
(() => {
  const Fx = () => window.LightFx;
  const Device = () => window.LightFxDevice;

  // The device as the shared code reads it: its parts' LEDs, once each, and its parts.
  function shapeOf(dev) {
    const segments = (Array.isArray(dev.segments) ? dev.segments : []).filter((s) => Array.isArray(s.ledIds) && s.ledIds.length);
    return { ledIds: [...new Set(segments.flatMap((s) => s.ledIds))], segments };
  }

  // The LEDs that show an effect, by look: the whole device, or each group of its LEDs that share one.
  function looksOf(dev, shape) {
    const all = shape.ledIds.map((_, i) => i);
    if (dev.mode === 'animation' && dev.modeAnim) return [{ look: dev.modeAnim, idx: all }];
    if (dev.mode !== 'custom' || !dev.modeLeds) return [];
    const groups = new Map();
    shape.ledIds.forEach((id, i) => {
      const v = dev.modeLeds[id];
      if (!v || typeof v !== 'object' || !v.style) return;
      const key = `${v.style}|${v.color}|${v.speed}`;
      if (!groups.has(key)) groups.set(key, { look: { style: v.style, color: v.color, speed: v.speed }, idx: [] });
      groups.get(key).idx.push(i);
    });
    return [...groups.values()];
  }

  // What to draw: { fx, look, part, luids, state } per piece of each look that shows an effect.
  function piecesOf(dev) {
    const shape = shapeOf(dev);
    const out = [];
    for (const { look, idx } of looksOf(dev, shape)) {
      const fx = Fx().lightingLook(look);
      if (!fx) continue;
      for (const { part } of Device().piecesOf(shape, idx)) out.push({ fx, look, part, luids: part.at.map((i) => shape.ledIds[i]), state: {} });
    }
    return out;
  }

  const rgb = (c) => `rgb(${c.r},${c.g},${c.b})`;

  // Colours root's LEDs with dev's effects, moving while one of them moves; with none, leaves them.
  function start(root, dev) {
    const list = Fx() && Device() ? piecesOf(dev) : [];
    const dots = new Map(Array.from(root.querySelectorAll('.lighting-led'), (c) => [Number(c.dataset.luid), c]));
    const tick = (now, inputs) => {
      for (const p of list) {
        const leds = Device().drawPart(p.fx, p.look, p.part, { now, inputs, state: p.state });
        p.luids.forEach((id, j) => {
          const dot = dots.get(id);
          if (!dot || !leds[j]) return;
          dot.style.fill = rgb(leds[j]);
          dot.classList.remove('is-neutral');
        });
      }
    };
    const moving = list.some((p) => Fx().moves(p.fx.effect));
    window.LightFxPreview.run(root, moving ? tick : null);
    if (!moving && list.length) tick(Date.now(), {});
  }

  window.LightingMapMotion = { start };
})();
