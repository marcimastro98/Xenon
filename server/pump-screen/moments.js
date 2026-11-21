'use strict';
// Which face a pump screen shows right now, and why. Pure: the facts come from the
// rules engine every widget condition uses (capabilities/situations.js), read only
// while some moment asks for them.
//
// In order: a face someone asked for (a Deck key, Bit, the menu) until it runs out;
// the PC's screens off, when nobody looks at sensors and the reads wait anyway; the
// first moment that holds; the face shown normally.

const When = require('../js/layers/layer-when.js');
const Faces = require('../js/pump/pump-faces.js');
const Model = require('../js/pump/pump-model.js');

// While the PC's screens sleep: the clock, or the picture the person chose. Nothing
// that needs the sensor reads, nothing that shows a track or a message.
const QUIET_FACES = Object.freeze(['clock', 'picture']);

function quietFace(base) {
  if (QUIET_FACES.includes(base.face)) return base.face === 'clock' ? { ...base, weather: false } : base;
  return { ...Faces.defaultFace('clock'), weather: false };
}

// { show, why }: `why` is 'pinned', 'screensOff', 'base' or the moment's rule as
// text ("game", "app:obs64"), which the menu turns into words.
function faceNow(screen, facts, { pinned = null, quiet = false, now = Date.now() } = {}) {
  if (pinned && pinned.until > now) return { show: pinned.show, why: 'pinned' };
  if (quiet) return { show: quietFace(screen.base), why: 'screensOff' };
  const hit = screen.moments.find((m) => When.shows(m.when, facts || {}));
  return hit ? { show: hit.show, why: When.format(hit.when) } : { show: screen.base, why: 'base' };
}

// Every screen known: set up, or seen and still on the default setup.
const screenIds = (model) => [...new Set([...Object.keys(model.screens), ...Object.keys(model.seen)])];

// The rules every moment of every screen uses, so the situations engine reads their facts.
function rulesOf(model) {
  return screenIds(model).flatMap((id) => Model.screenFor(model, id).moments.map((m) => m.when));
}

module.exports = { faceNow, rulesOf, screenIds, QUIET_FACES };
