'use strict';
// Airflow's actions (js/capabilities/catalog-airflow.js), run by the capability runner
// after validateAction: the menu's switches, a Deck key's mode, Bit's questions and
// changes, a paired phone. One rule set for all of them, so none can do what another
// cannot. Nothing here names a raw fan speed: a mode, a few choices and the fan check
// are all there is, and every speed still goes through safety.js.

const Model = require('../js/airflow/airflow-model.js');

// The choices a patch may carry; anything else in it is ignored.
const OPTION_KEYS = Object.freeze(['callQuiet', 'allowZero', 'linkHub', 'riseAlert']);
const FAN_KEYS = Object.freeze(['place', 'leave', 'pump']);

function parsePatch(text) {
  try {
    const p = JSON.parse(text);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

// A fan Xenon can drive: the check measured it and the person did not leave it to the PC.
const drivable = (model) => Object.values(model.fans).some((f) => f.calib && !f.leave);

/** The patch applied to a copy of the model, or { error } when it cannot be. */
function patched(model, p) {
  const next = { ...model, options: { ...model.options }, fans: { ...model.fans } };
  if (p.drive !== undefined) {
    if (!Model.DRIVES.includes(p.drive)) return { error: 'bad_value', choices: Model.DRIVES };
    // Watching and driving both plan on what the fan check measured.
    if (p.drive !== 'off' && !drivable(model)) return { error: 'needs_check' };
    next.drive = p.drive;
  }
  if (p.mode !== undefined) {
    if (!Model.MODES.includes(p.mode)) return { error: 'bad_value', choices: Model.MODES };
    next.mode = p.mode;
  }
  if (p.slider !== undefined) next.slider = p.slider;
  if (p.night !== undefined) next.options.night = { ...model.options.night, ...(p.night && typeof p.night === 'object' ? p.night : {}) };
  for (const key of OPTION_KEYS) if (typeof p[key] === 'boolean') next.options[key] = p[key];
  if (p.fan !== undefined) {
    const f = p.fan && typeof p.fan === 'object' ? p.fan : {};
    if (!Model.isFanId(f.id)) return { error: 'unknown_fan' };
    const change = Object.fromEntries(FAN_KEYS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));
    if (change.place !== undefined && !Model.PLACES.includes(change.place)) return { error: 'bad_value', choices: Model.PLACES };
    next.fans[f.id] = { ...(model.fans[f.id] || {}), ...change };
  }
  return { model: next };
}

/**
 * @param {{ store: any, loop: any, start?: () => Promise<any>, clock?: () => number, hubLights?: () => string|null,
 *   lastRise?: () => any }} deps
 *   hubLights: why the LINK hub Airflow holds shows no lights (drivers.js), or null;
 *   lastRise: the last climb told and the program behind it (rise.js), or null
 */
function createAirflowActions({ store, loop, start = async () => {}, clock = Date.now, hubLights = () => null, lastRise = () => null }) {
  // The status as fresh as it needs to be: a running engine has it from its last tick,
  // otherwise the fans are read once (a menu or a phone asking).
  async function fresh() {
    await start();
    const s = loop.status();
    return s && clock() - s.at < 2000 ? s : loop.look();
  }

  async function view() {
    const [s, model] = await Promise.all([fresh(), store.ready()]);
    const fans = (s?.fans || []).map((f) => {
      const own = model.fans[f.id];
      return { ...f, leave: own?.leave === true, checked: !!own?.calib, problem: model.check?.problems?.[f.id] || null };
    });
    return { ...s, fans, slider: model.slider, options: model.options, hubLights: hubLights(), rise: lastRise() };
  }

  async function change(p) {
    let refused = null;
    await store.update((m) => {
      const out = patched(m, p);
      if (out.error) { refused = out; return null; }
      return out.model;
    });
    if (refused) return { ok: false, ...refused };
    // These decide whether a driver may take its fans (the LINK hub): ask the drivers again now.
    if (p.linkHub !== undefined || p.mode !== undefined || p.drive !== undefined) loop.recheck?.();
    loop.refresh();
    return { ok: true };
  }

  async function run(a) {
    switch (a.type) {
      case 'airflowGet': return { ok: true, ...(await view()) };
      case 'airflowMode': {
        const model = await store.ready();
        // A mode means nothing while Airflow is off: say so rather than store it unseen.
        if (model.drive === 'off') return { ok: false, error: 'airflow_off' };
        const out = await change({ mode: a.mode });
        return out.ok ? { ok: true, mode: a.mode } : out;
      }
      case 'airflowSet': {
        const p = parsePatch(a.patch);
        if (!p) return { ok: false, error: 'bad_value' };
        // Not a choice but a fact, told once: the filters were cleaned today (health.js).
        if (p.cleaned === true) { await start(); return loop.cleaned() ? { ok: true } : { ok: false, error: 'unavailable' }; }
        // Only a fan this PC has now: the choices kept are capped, and a made-up id would
        // take the place of a real one.
        if (p.fan !== undefined && !((await fresh())?.fans || []).some((f) => f.id === p.fan?.id)) return { ok: false, error: 'unknown_fan' };
        return change(p);
      }
      case 'airflowCheck': {
        if (a.do === 'cancel') { loop.cancelCheck(); return { ok: true }; }
        await start();
        const out = loop.startCheck();
        return out.ok ? { ok: true } : { ok: false, error: out.why === 'running' ? 'busy' : 'unavailable' };
      }
      default: return { ok: false, error: 'unsupported' };
    }
  }

  return { run, view, fresh };
}

module.exports = { createAirflowActions, patched };
