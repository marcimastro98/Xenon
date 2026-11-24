'use strict';
// The changes a person, Bit or a Deck key make to the pump screens, each one a
// pure step from one stored model to the next (js/pump/pump-model.js owns the rules).
// An unknown screen is refused for every change but a setup: a setup is how a
// screen gets its first settings, from the menu or from Bit, before it ever said hello.

const Model = require('../js/pump/pump-model.js');
const Faces = require('../js/pump/pump-faces.js');
const When = require('../js/layers/layer-when.js');

const PARTS = Object.freeze(['alerts', 'leds', 'look', 'gauge']);

function ownScreen(model, id) {
  return model.screens[id] || Model.screenFor(model, id);
}

// "pulse" is how a Deck key or Bit made before the moves said the beat: on is the beat, off
// leaves any other move as it was.
function ledsPatch(cur, p) {
  if (!('pulse' in p) || 'move' in p) return p;
  return { ...p, move: p.pulse === true ? 'beat' : (cur.move === 'beat' ? 'still' : cur.move) };
}

// A ring's choices said back when wrong, so Bit or a key never lights it in a way nobody chose:
// what it follows, how it moves (how fast: a name or 1..100; which way round; its amount and the
// light of its dark part, 0..1 or null as made), and its own colours (two #rrggbb, from where it
// starts round, or a palette by name, null for those two).
const HEX = /^#[0-9a-f]{6}$/i;
const SPEED_RANGE = '1..100';
const okSpeed = (v) => Model.LED_SPEEDS.includes(v) || (Number.isInteger(v) && v >= 1 && v <= 100);
const okShare = (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 1);
function ledsError(leds) {
  if (!leds || typeof leds !== 'object') return null;
  if (leds.follow != null && !Model.LED_FOLLOW.includes(leds.follow)) return { error: 'bad_follow', choices: Model.LED_FOLLOW };
  if (leds.move != null && !Model.LED_MOVES.includes(leds.move)) return { error: 'bad_move', choices: Model.LED_MOVES };
  if (leds.speed != null && !okSpeed(leds.speed)) return { error: 'bad_speed', choices: [...Model.LED_SPEEDS, SPEED_RANGE] };
  if (leds.reverse != null && typeof leds.reverse !== 'boolean') return { error: 'bad_reverse' };
  for (const key of ['size', 'glow']) if (key in leds && !okShare(leds[key])) return { error: 'bad_' + key, choices: ['0..1', null] };
  if ('palette' in leds && leds.palette !== null && !Model.LED_PALETTES.includes(leds.palette)) return { error: 'bad_palette', choices: Model.LED_PALETTES };
  const two = Array.isArray(leds.colors) && leds.colors.length === Model.LED_COLORS.length && leds.colors.every((c) => typeof c === 'string' && HEX.test(c));
  return leds.colors == null || two ? null : { error: 'bad_led_colors' };
}

function knows(model, id) {
  return !!(model.screens[id] || model.seen[id]);
}

// The moments after `patch`: a whole new list, one more, or one less (by position).
function nextMoments(current, patch) {
  let moments = Array.isArray(patch.moments) ? patch.moments : current;
  if (patch.addMoment) {
    const m = Model.normalizeMoment(patch.addMoment);
    if (!m) return { error: 'bad_moment' };
    // The same rule again ("when I play" on a setup that has it) means its new face:
    // two moments with one rule would leave the second never shown. Like the base line,
    // it keeps the look chosen for it unless the patch names another.
    const same = moments.findIndex((x) => When.format(x.when) === When.format(m.when));
    if (same >= 0) moments = moments.map((x, i) => (i === same ? { ...m, show: Faces.mergeFace(x.show, patch.addMoment.show) || m.show } : x));
    else if (moments.length >= Model.MAX_MOMENTS) return { error: 'too_many_moments' };
    else moments = Model.insertMoment(moments, m);
  }
  if (patch.removeMoment != null) {
    const at = Number(patch.removeMoment);
    if (!Number.isInteger(at) || at < 0 || at >= moments.length) return { error: 'bad_moment' };
    moments = moments.filter((_, i) => i !== at);
  }
  return { moments };
}

// One screen changed by `patch`; { error } when the patch names something unknown.
function patchScreen(model, id, patch) {
  const m = Model.normalize(model);
  const key = Model.screenId(id);
  if (!key) return { error: 'bad_screen' };
  const p = patch && typeof patch === 'object' ? patch : {};
  if (!m.screens[key] && Object.keys(m.screens).length >= Model.MAX_SCREENS) return { error: 'too_many_screens' };
  if (p.setup != null) {
    const set = Model.withSetup(m.screens[key], p.setup);
    if (!set) return { error: 'bad_setup', choices: Model.SETUP_NAMES };
    return { model: Model.normalize({ ...m, screens: { ...m.screens, [key]: set } }) };
  }
  if (!knows(m, key)) return { error: 'unknown_screen', choices: Object.keys({ ...m.seen, ...m.screens }) };
  if (p.style != null && !Faces.isStyle(p.style)) return { error: 'bad_style', choices: [...Faces.SCREEN_STYLES, Faces.STYLE_WIDGET + '<id>'] };
  const ringBad = ledsError(p.leds);
  if (ringBad) return ringBad;
  const cur = ownScreen(m, key);
  const base = p.base == null ? cur.base : Faces.mergeFace(cur.base, p.base);
  if (!base) return { error: 'bad_face', choices: Faces.FACES };
  const moved = nextMoments(cur.moments, p);
  if (moved.error) return moved;
  const next = { ...cur, base, moments: moved.moments };
  for (const part of PARTS) if (p[part] && typeof p[part] === 'object') next[part] = { ...cur[part], ...(part === 'leds' ? ledsPatch(cur.leds, p.leds) : p[part]) };
  if (typeof p.name === 'string') next.name = p.name;
  if (p.style != null) next.style = p.style;
  return { model: Model.normalize({ ...m, screens: { ...m.screens, [key]: next } }) };
}

// A screen forgotten: its settings and the record of it. Its page, if still open,
// says hello again and comes back with the default setup.
function forgetScreen(model, id) {
  const m = Model.normalize(model);
  const key = Model.screenId(id);
  if (!knows(m, key)) return { error: 'unknown_screen' };
  const { [key]: _s, ...screens } = m.screens;
  const { [key]: _k, ...seen } = m.seen;
  return { model: Model.normalize({ ...m, screens, seen }) };
}

// A face page said hello: { model }, or null when nothing changed or the screen
// would be one too many.
function noteSeen(model, id, raw) {
  const m = Model.normalize(model);
  const key = Model.screenId(id);
  if (!key) return null;
  const seen = Model.normalizeSeen(raw);
  if (JSON.stringify(m.seen[key]) === JSON.stringify(seen)) return null;
  if (!m.seen[key] && Object.keys(m.seen).length >= Model.MAX_SCREENS) return null;
  return { model: Model.normalize({ ...m, seen: { ...m.seen, [key]: seen } }) };
}

// Whether Xenon draws by itself on the pump screens it has a driver for (direct.js).
function setDirect(model, on) {
  const m = Model.normalize(model);
  if (typeof on !== 'boolean') return { error: 'bad_direct', choices: ['on', 'off'] };
  return m.direct === on ? null : { model: Model.normalize({ ...m, direct: on }) };
}

module.exports = { patchScreen, forgetScreen, noteSeen, setDirect };
