'use strict';
// The end of the Bit kit (server/bit/kit.js puts the engine before it): what a widget
// calls to draw the person's own Bit from the SDK `bit` stream. Never loaded by the
// dashboard. A widget copies the kit into its package (the frame runs no outside script):
//
//   const bit = XenonBit.mount(document.getElementById('bit'), { label: 'Bit' });
//   // on every `data` message of the `bit` stream, and on `theme`:
//   bit.set(m.data, { light: theme.appearance === 'light' });
//
// Not hatched yet: the egg. A move played on the dashboard (data.played) plays here too, and the
// sign over its head (data.signal) shows in the top-right corner; `signs: false` leaves it to you.
// `XenonBit.signs(svg)` draws the same sign over a Bit drawn without mount (the Maker's Bit layer).
// Its home (a worn item of place 'home') shows while it sleeps; `home: true` keeps it behind Bit always.
// `classic: true` draws the classic Bit with its own rhythm, as the app does where the person
// chose the classic Bit (data.everywhere === false).
(() => {
  const X = globalThis.Xenon;
  const BACKGROUND = { dark: '#15191c', light: '#f4f6f5' };
  const NS = 'http://www.w3.org/2000/svg';

  /** The sign over its head (shared/src/bit-signs.js), drawn over the frame in the stage's top-right corner. */
  function signer(svg) {
    const S = X.bitSigns;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'xbit-sign');
    svg.append(g);
    const { x, y, w } = X.bit.STAGE;
    let shown = '';
    return (kind) => {
      const next = S?.KINDS.includes(kind) ? kind : '';
      if (next === shown) return;
      shown = next;
      g.replaceChildren(...(next ? S.cells(next) : []).map((c) => {
        const r = document.createElementNS(NS, 'rect');
        for (const [k, v] of [['x', x + w - S.SIZE + c.x], ['y', y + c.y], ['width', 1], ['height', 1], ['fill', '#' + c.hex]]) r.setAttribute(k, String(v));
        return r;
      }));
    };
  }

  function mount(host, opts = {}) {
    let look = null;
    let director = null;
    let seen = 0;
    let key = '';
    const player = X.bitPlayer.mount(host, {
      label: opts.label, mood: 'egg', look: () => look, director: () => director, home: opts.home === true,
    });
    const sign = opts.signs === false ? () => {} : signer(player.element);

    function set(data, { light = false, classic = false } = {}) {
      if (data?.ok !== true) return;
      if (data.hatched !== true || !data.genes) {
        look = null;
        key = '';
        player.setMood('egg');
        sign('');
        return;
      }
      const next = JSON.stringify([data.genes, data.worn, data.items, light, classic === true]);
      if (next !== key) {
        key = next;
        X.bitWardrobe.addItems(data.items); // the hub's items it wears, each checked again by the wardrobe
        look = classic === true ? null
          : X.bitLook.lookOf(data.genes, { worn: X.bitWardrobe.outfit(data.worn || []), background: light ? BACKGROUND.light : BACKGROUND.dark });
        director = X.bitDirector.createDirector(data.genes);
        if (player.mood === 'egg') player.setMood('idle');
        player.refresh();
      }
      sign(data.signal);
      const p = data.played;
      if (p && p.at > seen) {
        // The first answer only says where things stand: a move from before is not replayed.
        if (seen) player.play(p.clip);
        seen = p.at;
      } else if (!seen) seen = 1;
    }

    return { set, play: (clip) => player.play(clip), destroy: () => player.destroy() };
  }

  globalThis.XenonBit = { mount, signs: signer, clips: () => X.bit.clips.map((c) => c.id) };
})();
