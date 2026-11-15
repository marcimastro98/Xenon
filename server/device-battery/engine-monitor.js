// The engine's reader of the battery of wireless devices.

const lighting = require('../lighting.js');
const { createBatteryMonitor } = require('../battery.js');
const { hub } = require('../settings/current.js');
const { runPowerShellScript } = require('../powershell/run-command.js');

// Wireless peripheral battery (Corsair via the iCUE bridge + Bluetooth via the
// battery.ps1 PnP collector). TTL-cached inside the monitor; consumed by
// GET /api/battery, the SSE 'battery' tick and the get_battery_status AI tool.
const batteryMonitor = createBatteryMonitor({
  runScript: runPowerShellScript,
  lighting,
  systemBattery: async () => { const r = await require('../power/index.js').read(); return r && r.battery; },
  peripherals: () => require('./index.js').read({ ask: !hub.settings || hub.settings.batteryAskDevices !== false }),
});

module.exports = { batteryMonitor };
