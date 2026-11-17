'use strict';
// What the sign-in tab needs from the engine: its port and its settings store. The store's
// functions live in server.js, which hands them in once at load (connect). A call made before
// that rejects, so the tab and the switch fail closed instead of reading empty settings.

// The same reading of XENON_PORT as server.js: a value that is not a port means 3030.
const PORT = (() => {
  const raw = parseInt(process.env.XENON_PORT, 10);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 3030;
})();

/** @type {{ readHubSettings?: () => Promise<any>, updateHubSettingKey?: (key: string, change: (cur: any) => any) => Promise<any> }} */
const engine = {};

/** @param {{ readHubSettings: () => Promise<any>, updateHubSettingKey: (key: string, change: (cur: any) => any) => Promise<any> }} parts */
function connect({ readHubSettings, updateHubSettingKey }) {
  engine.readHubSettings = readHubSettings;
  engine.updateHubSettingKey = updateHubSettingKey;
}

function linked(name) {
  const fn = engine[name];
  if (typeof fn !== 'function') throw new Error('the settings store is not connected');
  return fn;
}

const readHubSettings = async () => linked('readHubSettings')();
const updateHubSettingKey = async (key, change) => linked('updateHubSettingKey')(key, change);

module.exports = { PORT, connect, readHubSettings, updateHubSettingKey };
