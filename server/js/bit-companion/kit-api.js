'use strict';
// The end of the Bit kit (server/bit/kit.js puts the engine before it): what a widget
// calls to draw the person's own Bit from the SDK `bit` stream. Never loaded by the
// dashboard. A widget copies the kit into its package (the frame runs no outside script):
//
//   const bit = XenonBit.mount(document.getElementById('bit'), { label: 'Bit' });
//   // on every `data` message of the `bit` stream, and on `theme`:
//   bit.set(m.data, { light: theme.appearance === 'light' });
//
// Not hatched yet: the egg. A move played on the dashboard (data.played) plays here too.
// `classic: true` draws the classic Bit with its own rhythm, as the app does where the person
// chose the classic Bit (data.everywhere === false).
(() => {
  const X = globalThis.Xenon;
  const BACKGROUND = { dark: '#15191c', light: '#f4f6f5' };

  function mount(host, opts = {}) {
    let look = null;
    let director = null;
    let seen = 0;
    let key = '';
    const player = X.bitPlayer.mount(host, {
      label: opts.label, mood: 'egg', look: () => look, director: () => director,
    });

    function set(data, { light = false, classic = false } = {}) {
      if (data?.ok !== true) return;
      if (data.hatched !== true || !data.genes) {
        look = null;
        key = '';
        player.setMood('egg');
        return;
      }
      const next = JSON.stringify([data.genes, data.worn, light, classic === true]);
      if (next !== key) {
        key = next;
        look = classic === true ? null
          : X.bitLook.lookOf(data.genes, { worn: X.bitWardrobe.outfit(data.worn || []), background: light ? BACKGROUND.light : BACKGROUND.dark });
        director = X.bitDirector.createDirector(data.genes);
        if (player.mood === 'egg') player.setMood('idle');
        player.refresh();
      }
      const p = data.played;
      if (p && p.at > seen) {
        // The first answer only says where things stand: a move from before is not replayed.
        if (seen) player.play(p.clip);
        seen = p.at;
      } else if (!seen) seen = 1;
    }

    return { set, play: (clip) => player.play(clip), destroy: () => player.destroy() };
  }

  globalThis.XenonBit = { mount, clips: () => X.bit.clips.map((c) => c.id) };
})();
