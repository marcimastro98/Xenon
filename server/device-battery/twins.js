'use strict';
// Two devices of one model share a name, and everything downstream tells devices apart by
// name. A reader that knows which unit it holds says so in `unit` (an address, a serial),
// and the second one seen gets a number. Only a value that survives a replug and a reboot
// may be a unit: a path would turn one device into two.
//
// A sleeping twin is missing from a read, so the numbers are remembered: what answers next
// keeps its own. They last until the server restarts, and units never leave this process.

const hasUnit = (device) => !!device && typeof device.unit === 'string' && device.unit !== '';
// One device can be seen by two routes, each with its own kind of unit, so a source only
// ever counts against itself: the merge after this still joins them by name.
const keyOf = (device) => `${device.source || ''}|${String(device.name || '').trim().toLowerCase()}`;

function createTwins() {
  const seen = new Map();

  function note(device) {
    const key = keyOf(device);
    if (!seen.has(key)) seen.set(key, []);
    const units = seen.get(key);
    if (!units.includes(device.unit)) units.push(device.unit);
  }

  // Sorted, so twins found together get the same numbers after a restart.
  function label(devices) {
    const list = Array.isArray(devices) ? devices : [];
    list.filter(hasUnit).sort((a, b) => a.unit.localeCompare(b.unit)).forEach(note);
    return list.map((device) => {
      const place = hasUnit(device) ? seen.get(keyOf(device)).indexOf(device.unit) : 0;
      return place > 0 ? { ...device, name: `${String(device.name).trim()} (${place + 1})` } : device;
    });
  }

  return { label };
}

module.exports = { createTwins };
