'use strict';

// The effects of Settings -> Lighting as cards, for all the lights (lighting-page/panels.js), one
// device (lighting/lighting-device.js) and a group of its LEDs (lighting-map/lighting-map.js): each
// drawn moving on a ring of LEDs (js/light-fx/light-fx-preview.js) with its name and a line that
// says what it does, by group as the one list of effects has them (js/light-fx/light-fx.js); the
// ones this PC cannot follow now are left out. Under the chosen one, only the choices it uses: its
// colours (one to five, a set ready made fills them), speed, which way round, its amount by the
// name the effect gives it, the light left in its dark part and, for all the lights, together or
// one after another. Loaded with the engine the first time a page shows effects (lighting-ui.js).
(() => {
  const Fx = window.LightFx;
  const Preview = window.LightFxPreview;
  const UI = () => window.LightingUI;
  const SIZES = Object.freeze([[0.2, 'less'], [0.5, 'normal'], [0.8, 'more']]);
  // The dark part: dark, as the effect is made (no value), lit more.
  const GLOWS = Object.freeze([['none', 0], ['auto', null], ['more', 0.3]]);
  const GLOW_DARK_BELOW = 0.15;
  const MAX_COLOURS = 5;
  const START = '#1ed760';
  const CHAIN = Object.freeze([['ring', 0], ['ring', 1 / 3], ['line', 2 / 3]]);
  const CHAIN_RING = 44;
  const CHAIN_LINE = 120;

  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a))[0];
  const isOld = (style) => Object.hasOwn(Fx.OLD_LIGHTING, style);
  // The effect a saved name draws: the list's own, or the one a name saved before the list became.
  const effectOf = (style) => (isOld(style) ? Fx.OLD_LIGHTING[style] : Fx.LIGHTING.includes(style) ? style : null);
  // The colours a look draws with, as the lights read them (lightingLook): '#rrggbb', at most five.
  const coloursOf = (look) => ((Fx.lightingLook(look) || { colours: [] }).colours).map(hex).slice(0, MAX_COLOURS);

  // How a card draws an effect: as the look is set on the chosen one, in the look's colours on the rest.
  function drawn(look, effect) {
    const own = effectOf(look.style) === effect;
    const said = Fx.lightingLook(own ? look : { style: effect, palette: coloursOf(look) });
    const base = { effect, colours: said?.colours.length ? said.colours : undefined, speed: look.speed };
    return own ? { ...base, reverse: look.reverse === true, amount: look.size, glow: look.glow } : base;
  }

  function card(effect, on, look, pick) {
    const b = UI().button('lighting-fxcard', '', '', () => pick(effect));
    b.setAttribute('aria-pressed', String(on));
    const ring = UI().el('span', 'lighting-fxring');
    const words = UI().el('span', 'lighting-fxcard-words');
    words.append(UI().el('span', 'lighting-fxcard-name', 'light_fx_' + effect), UI().el('span', 'settings-hint', 'light_fx_' + effect + '_sub'));
    b.append(ring, words);
    Preview.mount(ring, { ...drawn(look, effect), shape: 'ring' });
    return b;
  }

  // The plain choices before the effects (no effect; a device's temperature or album), as cards.
  function leadCard([value, key, fallback], on, pick) {
    const b = UI().button('lighting-fxcard is-plain', '', '', () => pick(value));
    b.setAttribute('aria-pressed', String(on));
    b.append(UI().el('span', 'lighting-fxring is-' + value), UI().el('span', 'lighting-fxcard-name', key, fallback));
    return b;
  }

  function groups(opts) {
    const look = opts.look || {};
    const now = effectOf(look.style);
    const cannot = opts.cannot || [];
    const out = [];
    if (opts.lead?.length) {
      const grid = UI().el('div', 'lighting-fxgrid is-plain');
      for (const l of opts.lead) grid.appendChild(leadCard(l, l[0] === look.style, opts.onPick));
      out.push(grid);
    }
    for (const group of Fx.GROUPS) {
      const list = Fx.LIST.filter((e) => e.group === group && Fx.LIGHTING.includes(e.id) && !cannot.includes(e.needs));
      if (!list.length) continue;
      const box = UI().el('div', 'lighting-fxgroup');
      box.appendChild(UI().el('h4', 'lighting-fxgroup-name', 'light_fx_group_' + group));
      const grid = UI().el('div', 'lighting-fxgrid');
      for (const e of list) grid.appendChild(card(e.id, e.id === now, look, opts.onPick));
      box.appendChild(grid);
      out.push(box);
    }
    return out;
  }

  // One to five colours of the person's own: a swatch each, x to drop one, + to add one.
  function ownColours(list, send) {
    const row = UI().el('div', 'lighting-palette-row');
    list.forEach((c, i) => {
      const cell = UI().el('span', 'lighting-palette-cell');
      cell.appendChild(UI().hexColorControl(c, (v) => { list[i] = v; send(list.slice(), false); }));
      if (list.length > 1) {
        const rm = UI().button('settings-btn lighting-remove', '', '✕', () => send(list.filter((_, j) => j !== i), true));
        rm.setAttribute('data-i18n-title', 'lighting_palette_remove');
        cell.appendChild(rm);
      }
      row.appendChild(cell);
    });
    if (list.length < MAX_COLOURS) row.appendChild(UI().button('settings-btn', 'lighting_palette_add', 'Aggiungi colore', () => send(list.concat(list[list.length - 1]), true)));
    return row;
  }

  // A set of colours ready made: its colours in a bar and its name; a tap puts them in the swatches.
  function setCard(id, colours, on, pick) {
    const b = UI().button('lighting-fxset', '', '', pick);
    b.setAttribute('aria-pressed', String(on));
    const bar = UI().el('span', 'lighting-fxset-bar');
    bar.style.setProperty('--fx-set', `linear-gradient(90deg, ${(colours.length > 1 ? colours : [colours[0], colours[0]]).join(', ')})`);
    b.append(bar, UI().el('span', 'lighting-fxset-name', 'light_fx_palette_' + id, id));
    return b;
  }

  // The colours: a set ready made, then the swatches. Colours chosen on a name saved before the
  // list move the look to the list's own name, which keeps a list of them.
  function colourRows(look, effect, onChange) {
    const own = coloursOf(look);
    const list = own.length ? own : [START];
    const send = (palette, redraw) => onChange(isOld(look.style) ? { style: effect, palette } : { palette }, redraw || isOld(look.style));
    const sets = UI().el('div', 'lighting-fxsets');
    Fx.PALETTE_IDS.forEach((id) => {
      const colours = Fx.PALETTES[id].map(hex);
      const same = colours.length === own.length && colours.every((c, i) => c === own[i]);
      sets.appendChild(setCard(id, colours, same, () => send(colours, true)));
    });
    return [UI().labeledRow('lighting_fx_sets', sets), UI().labeledRow('lighting_palette_colors', ownColours(list, send))];
  }

  // Two fans and a strip with the look, together or one after another, so the choice shows itself.
  function chainRow(look, effect) {
    const row = UI().el('div', 'lighting-fxchain');
    CHAIN.forEach(([shape, at]) => {
      const node = UI().el('span', 'lighting-fxchain-' + shape);
      row.appendChild(node);
      Preview.mount(node, { ...drawn(look, effect), shape, box: shape === 'ring' ? CHAIN_RING : CHAIN_LINE, phase: look.chain ? at : 0 });
    });
    return row;
  }

  // Which way round, the amount, the dark part and, for all the lights, together or in turn.
  function moreRows(look, entry, opts) {
    const send = opts.onChange;
    const rows = [];
    if (entry.moves) rows.push(UI().toggleRow('xmenu_pump_leds_reverse', look.reverse === true, (on) => send({ reverse: on }, true), 'xmenu_pump_leds_reverse_sub'));
    if (entry.size) {
      rows.push(UI().segmentedRow('light_fx_size_' + entry.size, SIZES.map(([n, w]) => [String(n), 'xmenu_pump_leds_size_' + w, w]),
        String(nearest(SIZES, look.size ?? 0.5)), (n) => send({ size: Number(n) }, true), 3));
    }
    if (entry.glow != null) {
      const on = look.glow == null ? 'auto' : look.glow < GLOW_DARK_BELOW ? 'none' : 'more';
      rows.push(UI().segmentedRow('xmenu_pump_leds_glow', GLOWS.map(([w]) => [w, 'xmenu_pump_leds_glow_' + w, w]), on,
        (w) => send({ glow: GLOWS.find((g) => g[0] === w)[1] }, true), 3));
    }
    if (opts.chain && entry.moves) {
      rows.push(UI().segmentedRow('lighting_chain', [['together', 'lighting_chain_together', 'Insieme'], ['after', 'lighting_chain_after', 'Una dopo l’altra']],
        look.chain ? 'after' : 'together', (v) => send({ chain: v === 'after' }, true), 2), chainRow(look, entry.id));
    }
    return rows;
  }

  // The choices of the chosen effect: only what it uses. A group of LEDs keeps one colour and a speed.
  function tune(opts) {
    const look = opts.look || {};
    const effect = effectOf(look.style);
    const entry = effect && Fx.about(effect);
    if (!entry) return [];
    const send = opts.onChange;
    const rows = [];
    if (entry.colours) {
      rows.push(...(opts.one ? [UI().labeledRow('lighting_anim_color', UI().hexColorControl(look.color || START, (v) => send({ color: v }, false)))]
        : colourRows(look, effect, send)));
    }
    if (entry.moves) rows.push(UI().labeledRow('lighting_anim_speed', UI().speedSlider(look.speed, (v) => send({ speed: v }, true))));
    if (!opts.one) rows.push(...moreRows(look, entry, opts));
    if (!rows.length) return [];
    const box = UI().el('div', 'lighting-fxtune');
    box.appendChild(UI().el('h4', 'lighting-fxgroup-name', 'lighting_fx_tune', 'Personalizza'));
    box.append(...rows);
    return [box];
  }

  /**
   * The cards and, under them, the choices of the chosen effect, in the page's words.
   * opts: { look: { style, color, palette, speed, reverse, size, glow, chain }, cannot: the needs this
   * PC cannot follow now (status.cannot), lead: [[value, i18nKey, fallback]] plain choices first,
   * one: a single colour and a speed only, chain: offer together / one after another,
   * onPick(style), onChange(patch, redraw) }.
   */
  function section(opts) {
    const nodes = [...groups(opts), ...tune(opts)];
    for (const n of nodes) UI().localizeSubtree(n);
    return nodes;
  }

  window.LightingEffects = { section };
})();
