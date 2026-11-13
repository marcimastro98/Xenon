// Whether anything shows a device's battery right now: the Battery widget, a Deck key, or a
// widget that was given the battery stream.

const { sdkStreamGranted } = require('../widget-sdk/grants.js');
const { readDeckStore } = require('../deck/store-read.js');
const { _feedWidgetInUse } = require('../grid/feed-widget-in-use.js');

// Peripheral battery moves on a minutes scale and its sources are relatively
// expensive (iCUE SDK round-trips + a Bluetooth PnP scan), so it gets its own
// slow tick with a change-dedup instead of riding the 7s system broadcast.
// Each read is a PowerShell spawn sweeping every PnP device (~2 s of CPU) plus iCUE
// round-trips, so it runs only while something can show the result: the Battery
// widget on the dashboard, a Deck key bound to `battery:<device>`, or a widget
// granted the `battery` stream. GET /api/battery and the AI tool still read on
// demand. Like _feedWidgetInUse, any unexpected shape fails OPEN.
async function batteryWanted() {
  if (_feedWidgetInUse('battery') || sdkStreamGranted('battery')) return true;
  try {
    const store = await readDeckStore();
    return JSON.stringify(store.configs).includes('"battery:');
  } catch { return true; }
}

module.exports = { batteryWanted };
