'use strict';
// The Bit tile: the person's own Bit as big as the tile lets it be, with its
// name and age, on the dashboard, a layer page (desktop, overlay, beside a
// window) or a phone. Every copy draws the same Bit; tapping one opens what the
// person chose for a tap (companion.js tap(): its pocket, the chat or its room; sheet.js where there is no companion). It moves with every moment like the corner (moments.js:
// data-own-bit) and holds still with the dashboard (BitApp's TILE_HOLD).
// On a layer page the stream reaches it through the on* handlers below
// (layers/layer-tiles.js); on the dashboard BitApp and BitMoments listen.
(() => {
  let drawn = ''; // what the copies show now, so a word from the server that changes none of it draws nothing

  const app = () => window.BitApp;
  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

  function wordsOf(bit) {
    if (!bit.hatched) return { name: say('mybit_egg_label'), line: say('mybit_tap_hatch') };
    const stage = say(`mybit_stage_${bit.stage}`);
    return { name: bit.name || say('mybit_title'), line: say('mybit_age', { stage, n: Number(bit.days) || 1 }) };
  }

  const shownOf = (bit) => JSON.stringify(bit?.ok ? [bit.hatched, wordsOf(bit)] : null);

  function open(e) {
    if (e) e.stopPropagation();
    if (window.BitCompanion?.tap) window.BitCompanion.tap(e?.currentTarget);
    else if (window.BitSheet) window.BitSheet.open();
  }

  function render(mount, bit) {
    mount.textContent = '';
    if (bit?.ok !== true) return;
    const words = wordsOf(bit);
    const box = makeEl('div', 'bitt');
    const sprite = makeEl('button', 'bitt-sprite');
    sprite.type = 'button';
    sprite.setAttribute('data-own-bit', '');
    sprite.setAttribute('aria-label', say(bit.hatched ? 'mybit_open' : 'mybit_egg_label'));
    sprite.addEventListener('click', open);
    const text = makeEl('div', 'bitt-words');
    text.append(makeEl('strong', 'bitt-name', words.name), makeEl('span', 'bitt-line', words.line));
    box.append(sprite, text);
    mount.append(box);
    const A = app();
    if (A) A.mount(sprite, { mood: bit.hatched ? 'idle' : 'egg', fidgets: !!bit.hatched, look: () => A.personal() });
  }

  /** Draw every copy of the tile again (a layout change, a new copy). */
  function renderWidgets() {
    const bit = app()?.state() || null;
    drawn = shownOf(bit);
    for (const mount of document.querySelectorAll('.bit-tile-mount')) render(mount, bit);
    if (app()) app().sweep();
    window.BitSigns?.paint();
  }

  function heard(bit) {
    if (shownOf(bit) !== drawn) renderWidgets();
  }

  if (typeof addEventListener === 'function') {
    addEventListener('xenon-bit', (e) => { if (e.detail) heard(e.detail); });
  }

  const moments = (name) => (d) => { if (window.BitMoments) window.BitMoments[name](d); };
  window.BitTile = {
    renderWidgets,
    onBit: (d) => { if (app()) app().heard(d); },
    onStatus: moments('onStatus'),
    onSystem: moments('onSystem'),
    onMedia: moments('onMedia'),
    onPlay: moments('onPlay'),
  };
})();
