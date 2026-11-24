'use strict';
// The pump screens' actions (js/capabilities/catalog-pump.js), run by the capability
// runner after validateAction: a face now (a Deck key, Bit, the menu), a setup, a style, a
// patch of the settings, and the list Bit reads before it changes anything.

const Faces = require('../js/pump/pump-faces.js');
const Model = require('../js/pump/pump-model.js');
const { screenIds } = require('./moments.js');
const Edit = require('./edit.js');

// The screen an action means: the one named (change.js refuses a name no screen has,
// with the choices), else the first one known. A setup may go to a screen nobody saw
// yet (it is how one gets its first settings); 'pump' is the name the iCUE widget and
// the CAM address use when none is given.
function screenOf(model, raw, { anyName = false } = {}) {
  return Model.screenId(raw) || screenIds(model)[0] || (anyName ? 'pump' : '');
}

// The face to show for `name`: the way this screen already shows it somewhere (its
// base or a moment), else that face's defaults.
function faceFor(screen, name) {
  const own = [screen.base, ...screen.moments.map((m) => m.show)].find((f) => f.face === name);
  return own || Faces.defaultFace(name);
}

function nextFace(current) {
  const at = Faces.FACES.indexOf(current?.face);
  return Faces.FACES[(at + 1) % Faces.FACES.length];
}

function answer(out, extra) {
  if (out?.error) return { ok: false, error: out.error, ...(out.choices ? { choices: out.choices } : {}) };
  return { ok: true, ...extra };
}

function parsePatch(text) {
  try {
    const p = JSON.parse(text);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

// `openIcue` builds the iCUE widget and opens it with iCUE (icue.js); `widgets` lists the
// Store widgets a pump can show (widgets.js), read with the screens so Bit can pick one;
// `here` whether a screen shows Xenon now (presence.js); `direct` Xenon drawing on a screen
// by itself (direct.js), null where it cannot run.
function createPumpActions({ store, live, change, openIcue = async () => ({ ok: false, error: 'unavailable' }), widgets = async () => [], here = (_id) => true, direct = null }) {
  async function view() {
    const model = await store.ready();
    const now = live.decide();
    return screenIds(model).map((id) => ({
      screen: id, ...Model.screenFor(model, id), set: !!model.screens[id], seen: model.seen[id] || null, here: here(id), now: now[id] || null,
    }));
  }

  async function showFace(a) {
    const model = await store.ready();
    const id = screenOf(model, a.screen);
    if (!id) return { ok: false, error: 'unknown_screen', choices: screenIds(model) };
    if (a.face === 'auto') return answer(await change({ screen: id, show: null }), { screen: id, face: 'auto' });
    const screen = Model.screenFor(model, id);
    const name = a.face === 'next' ? nextFace(live.decide()[id]?.show) : a.face;
    const out = await change({ screen: id, show: faceFor(screen, name), minutes: Number(a.minutes) || 0 });
    return answer(out, { screen: id, face: name });
  }

  async function setup(a) {
    const id = screenOf(await store.ready(), a.screen, { anyName: true });
    if (!id) return { ok: false, error: 'bad_screen' };
    return answer(await change({ screen: id, setup: a.setup }), { screen: id, setup: a.setup });
  }

  // A Deck key or Bit: Xenon, Gauge, or the next one, the Store styles for its shape included.
  async function style(a) {
    const model = await store.ready();
    const id = screenOf(model, a.screen);
    if (!id) return { ok: false, error: 'unknown_screen', choices: screenIds(model) };
    const name = a.style !== 'next' ? a.style
      : Faces.nextStyle(Model.screenFor(model, id).style, await widgets().catch(() => []), model.seen[id]?.shape || 'round');
    return answer(await change({ screen: id, patch: { style: name } }), { screen: id, style: name });
  }

  async function patch(a) {
    const p = parsePatch(a.patch);
    if (!p) return { ok: false, error: 'bad_patch' };
    const model = await store.ready();
    const id = screenOf(model, a.screen);
    if (!id) return { ok: false, error: 'unknown_screen', choices: screenIds(model) };
    const out = await change({ screen: id, patch: p });
    return answer(out, { screen: id, settings: out.model ? Model.screenFor(out.model, id) : undefined });
  }

  // On or off for every pump screen Xenon has a driver for; "on" again also tries again now.
  async function setDirect(a) {
    if (!direct) return { ok: false, error: 'unavailable' };
    const on = a.on === 'on' ? true : a.on === 'off' ? false : null;
    const out = await store.update((m) => Edit.setDirect(m, on));
    if (out?.error) return { ok: false, error: out.error, choices: out.choices };
    direct.refresh();
    return { ok: true, direct: direct.state() };
  }

  return {
    async run(action) {
      switch (action.type) {
        case 'pumpFace': return showFace(action);
        case 'pumpSetup': return setup(action);
        case 'pumpStyle': return style(action);
        case 'pumpSet': return patch(action);
        case 'pumpGet': return { ok: true, screens: await view(), widgets: await widgets().catch(() => []), direct: direct ? direct.state() : null };
        case 'pumpDirect': return setDirect(action);
        case 'pumpIcue': return openIcue();
        default: return { ok: false, error: 'unsupported' };
      }
    },
  };
}

module.exports = { createPumpActions, screenOf, faceFor, nextFace };
