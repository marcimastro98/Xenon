'use strict';

// What a new client of the live feed starts from. Each reading goes out the moment
// it lands: waiting for the slowest of them held back the others, and with the
// first `system` event the boot splash, which then waited out its whole timer.

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Sends each reading as it lands. A reading that fails or comes back empty sends
 * its `fallback`, or nothing. Resolves when all of them are done.
 */
function seedReadings(res, readings) {
  return Promise.all(readings.map(async ({ event, read, fallback }) => {
    const data = await Promise.resolve().then(read).catch(() => null);
    if (data) res.write(frame(event, data));
    else if (fallback) res.write(frame(event, fallback));
  }));
}

module.exports = { seedReadings };
