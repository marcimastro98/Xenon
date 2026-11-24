'use strict';
// The fields of a Lighting look that every way in checks the same: the settings, the page, Bit,
// the Deck. `style` is 'none', a LightFx effect of the Lighting list or a name saved before it
// (js/light-fx/light-fx.js LIGHTING, OLD_LIGHTING); the knobs below are kept only when set, so a
// look saved before them reads as it always did.

const LightFx = require('../js/light-fx/light-fx.js');

const STYLES = Object.freeze([...new Set(['none', ...Object.keys(LightFx.OLD_LIGHTING), ...LightFx.LIGHTING])]);
const AMOUNTS = Object.freeze(['size', 'glow']);

const isStyle = (style) => STYLES.includes(style);
const share = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 : undefined);

/** reverse, size, glow (and with `chain` allowed, chain) of a look, cleaned; unset ones left out. */
function extrasOf(v, chain = false) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  if (typeof v.reverse === 'boolean') out.reverse = v.reverse;
  for (const k of AMOUNTS) { const s = share(v[k]); if (s !== undefined) out[k] = s; }
  if (chain && typeof v.chain === 'boolean') out.chain = v.chain;
  return out;
}

/** A patch's knobs onto a look: a value sets one, null gives it back to the effect as made. */
function mergeExtras(cur, patch, chain = false) {
  Object.assign(cur, extrasOf(patch, chain));
  for (const k of [...AMOUNTS, 'reverse', ...(chain ? ['chain'] : [])]) if (patch && patch[k] === null) delete cur[k];
  return cur;
}

module.exports = { STYLES, isStyle, extrasOf, mergeExtras };
