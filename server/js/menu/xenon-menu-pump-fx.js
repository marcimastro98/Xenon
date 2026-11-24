'use strict';

// The rings on the cards of how a pump's ring of lights moves (server/menu/menu-pump-fx.js): each
// drawn moving with the one effect engine (js/light-fx/light-fx-preview.js), so a card shows what
// the pump will do, as the ring is set (data-ring-look: colours, speed, amount, dark part); and the
// ring round a pump's own card (data-ring-*), moving as the ring does now, in its colours. Loaded
// the first time such a card is on show (xenon-menu-pumps.js), after the engine and the painter.
(() => {
  const Fx = window.LightFx;
  const Preview = window.LightFxPreview;
  const SIZE = 52;   // the ring's box, CSS px (.xm-pumpring); a pump's card says its own
  const HEX = /^#[0-9a-f]{6}$/i;
  const PREFIX = 'xm-pumpring--fx-';

  const rgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
  const coloursOf = (list) => { const c = (Array.isArray(list) ? list : []).filter((x) => HEX.test(x)).map(rgb); return c.length ? c : Preview.COLOURS; };
  // A speed as said: a place 1..100 or a name; an amount 0..1, or undefined (as the effect is made).
  const speedOf = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : v);
  const share = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

  // A card's ring as the menu said it (menu-pump-tune.js cardLook), or null.
  function cardLook(json) {
    let look;
    try { look = JSON.parse(json); } catch { return null; }
    if (!look || !Fx.isEffect(look.effect)) return null;
    return { effect: look.effect, box: SIZE, colours: coloursOf(look.colours), speed: speedOf(look.speed), reverse: look.reverse === true, amount: share(look.size), glow: share(look.glow) };
  }

  // What a ring shows: an effect card's from its class, a pump card's from what it says.
  function lookOf(node) {
    const d = node.dataset || {};
    if (d.ringLook) return cardLook(d.ringLook);
    if (d.ringFx) {
      const size = Number(d.ringSize);
      return Fx.isEffect(d.ringFx) ? {
        effect: d.ringFx, box: size > 0 ? size : SIZE, colours: coloursOf(String(d.ringColours || '').split(',')), speed: speedOf(d.ringSpeed),
        reverse: d.ringReverse === '1', amount: share(d.ringAmount), glow: share(d.ringGlow),
      } : null;
    }
    const cls = [...node.classList].find((c) => c.startsWith(PREFIX));
    const id = cls ? cls.slice(PREFIX.length) : '';
    return Fx.isEffect(id) ? { effect: id, box: SIZE } : null;
  }

  // The cards drawn since the last look: a canvas in each ring that has none yet.
  function scan(root) {
    for (const node of root.querySelectorAll(`.xm-pumpring[class*="${PREFIX}"], [data-ring-fx], [data-ring-look]`)) {
      const look = node.querySelector('canvas') ? null : lookOf(node);
      if (look) Preview.mount(node, { ...look, shape: 'ring' });
    }
  }

  window.XenonMenuPumpFx = { scan };
})();
