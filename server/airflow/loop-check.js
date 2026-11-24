'use strict';
// The fan check (calibrate.js) inside Airflow's engine (loop.js): which channels it
// may move, one tick of it under the safety layer, and what is kept when it ends.

/**
 * Every control a driver can write, unless the person left it to the PC. The kind
 * comes from the fan list (a pump found by name or marked by the person); the floor
 * is the driver's own (a graphics card's lowest duty).
 * @param {any[]} found mergePolls().found @param {any} model @param {any[]} channels buildInventory()
 * @returns {import('./calibrate-plan.js').CheckChannel[]}
 */
function checkChannels(found, model, channels) {
  const kinds = new Map(channels.map((c) => [c.id, c.kind]));
  return found.filter((f) => f.controllable && !model.fans[f.id]?.leave).map((f) => ({
    id: f.id,
    kind: /** @type {'pump'|'fan'} */ (kinds.get(f.id) === 'pump' ? 'pump' : 'fan'),
    tach: f.tach ?? null,
    floor: Number.isFinite(f.min) ? f.min : 0,
    // A driver whose fans ramp slowly says how long they take (the LINK hub).
    ...(Number.isFinite(f.settleMs) ? { settleMs: f.settleMs } : {}),
    // Never tried on real hardware: the check also proves it goes back (calibrate-back.js).
    beta: f.beta === true,
  }));
}

/**
 * One tick: the check's duties, judged by the safety layer. Heat, a sensor gone, a
 * stall or the hands' own guard ends it at once, nothing kept; the safety layer's
 * answer for this tick still stands (full power, or back to the PC).
 * @param {{ check: any, snap: any, safety: any, now: number }} t
 */
function stepCheck({ check, snap, safety, now }) {
  const reading = snap.readAt == null ? null : { at: snap.readAt, tachs: snap.tachs, duty: snap.duty };
  let view = check.step(reading);
  const verdict = safety.check({
    temps: snap.temps, power: snap.power, channels: check.safetyChannels(reading),
    plan: { at: now, targets: view.targets, allowZero: true },
  });
  const firmware = Object.values(verdict.channels).find((v) => v.action === 'firmware');
  const why = verdict.mode !== 'brain' ? verdict.why : firmware?.why || snap.guard;
  if (!view.done && why) view = check.cancel(why);
  return { view, verdict };
}

/**
 * What a finished check leaves in the store: each fan's new measurements (a fan
 * never saved before keeps the place the fan list guessed), no measurements for a
 * fan it could not set up, and the problems for the menu.
 * @param {{ update: (step: (m: any) => any) => Promise<any> }} store
 * @param {{ calibs: Record<string, any>, problems: Record<string, string> }} result
 * @param {any[]} channels buildInventory() @param {number} at
 */
function keepResult(store, result, channels, at) {
  const places = new Map(channels.map((c) => [c.id, c.place]));
  return store.update((m) => {
    const fans = { ...m.fans };
    for (const [id, calib] of Object.entries(result.calibs)) fans[id] = { ...(fans[id] || { place: places.get(id) }), calib };
    for (const id of Object.keys(result.problems)) if (fans[id]) fans[id] = { ...fans[id], calib: null };
    return { ...m, fans, check: { at, problems: result.problems } };
  });
}

module.exports = { checkChannels, stepCheck, keepResult };
