'use strict';
// One reading of the whole PC from every Airflow driver's poll (driver-lhm.js,
// driver-hwmon.js): the channels each found, every fan speed reading, the duty each
// control runs at, the temperatures and the power. Pure. `at` is the engine's
// clock; `readAt` the newest reading any driver gave (null when none answered), so
// a reading that stopped coming is never taken for a new one.

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {{ id: string, channels: () => any[] }[]} drivers
 * @param {(any|null)[]} polls each driver's poll(), null while it is not answering
 * @param {number} at the engine's clock
 */
function mergePolls(drivers, polls, at) {
  const snap = { at, readAt: null, temps: {}, power: {}, tachs: {}, duty: {}, found: [], guard: null, answering: [] };
  drivers.forEach((d, i) => {
    const p = polls[i];
    if (!p) return;
    snap.answering.push(d.id);
    if (finite(p.at) && !(snap.readAt >= p.at)) snap.readAt = p.at;
    // A temperature two drivers both read: the fresher one.
    for (const [k, r] of Object.entries(p.temps || {})) {
      if (r && finite(r.value) && finite(r.at) && !(snap.temps[k]?.at >= r.at)) snap.temps[k] = r;
    }
    for (const [k, w] of Object.entries(p.power || {})) if (finite(w) && w >= 0) snap.power[k] = w;
    Object.assign(snap.tachs, p.tachs || {});
    Object.assign(snap.duty, p.duty || {});
    snap.guard ??= p.guard || null;
    for (const ch of d.channels()) snap.found.push({ ...ch, driver: d.id });
  });
  return snap;
}

module.exports = { mergePolls };
