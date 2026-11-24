'use strict';
// How the ring of lights around a pump moves, as cards with the ring drawn moving in each
// (js/menu/xenon-menu-pump-fx.js paints them with the pump's own maths, js/pump/ring-effects.js):
// the choice that leaves it to the style (the screen) or to Look (a line) first with the calm
// effects, then the moving ones, then those that follow something. Each card says in a line what
// its effect does, and draws it as the ring is set (`look`: its colours, speed, amount). Pure.

const RingFx = require('../js/pump/ring-effects.js');
const { k } = require('./menu-rows.js');

// The name of a move: a light effect by its name everywhere in Xenon, or the pump's own
// choices (as the style, as above).
const moveLabel = (value) => k(RingFx.isEffect(value) ? 'light_fx_' + value : 'xmenu_pump_ring_' + value);
const moveSub = (value) => k(RingFx.isEffect(value) ? 'light_fx_' + value + '_sub' : 'xmenu_pump_ring_' + value + '_sub');

/**
 * The rows of one choice of how the ring moves.
 * @param {{ id: string, label: any, sub?: any, lead: string, on: string, look?: object,
 *   allow: (e: { id: string, needs: string | null }) => boolean, act: (value: string) => any }} o
 */
function fxRows({ id, label, sub, lead, on, look, allow, act }) {
  const card = (value) => ({
    value, label: moveLabel(value), sub: moveSub(value), art: 'fx-' + value, on: value === on, act: value === on ? null : act(value),
    ...(look && RingFx.isEffect(value) ? { look: { effect: value, ...look } } : {}),
  });
  return RingFx.GROUPS.map((group, i) => {
    const effects = RingFx.LIST.filter((e) => e.group === group && allow(e)).map((e) => e.id);
    return {
      kind: 'pumpcards', id: i ? `${id}-${group}` : id, fx: true, value: on,
      label: i ? k('light_fx_group_' + group) : label, sub: i ? undefined : sub,
      cards: (i ? effects : [lead, ...effects]).map(card),
    };
  }).filter((r) => r.cards.length);
}

module.exports = { fxRows, moveLabel };
