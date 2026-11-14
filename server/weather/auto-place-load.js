// Reads the place found for this PC at an earlier start from disk.

const fs = require('node:fs');
const { WEATHER_GEO_FILE } = require('./geo-file.js');
const { weatherGeo } = require('./auto-place-state.js');

async function loadPersistedAutoLocation() {
  try {
    const raw = JSON.parse(await fs.promises.readFile(WEATHER_GEO_FILE, 'utf8'));
    const lat = Number(raw && raw.lat);
    const lon = Number(raw && raw.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      weatherGeo.place = {
        value: {
          lat, lon,
          location: String(raw.location || ''),
          region: String(raw.region || ''),
          country: String(raw.country || ''),
        },
        updatedAt: Number(raw.updatedAt) || 0,
      };
    }
  } catch { /* first run or unreadable — resolve fresh below */ }
}

module.exports = { loadPersistedAutoLocation };
