// What the weather settings may hold: the languages a forecast can come in and the fields that
// can be shown or hidden.

const WEATHER_LANGS = new Set(['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);

// Individually toggleable weather fields (hero chips + detail metrics); mirror of
// the client list. Hiding one removes it from both the tile and the modal.
const WEATHER_FIELD_IDS = Object.freeze([
  'feels', 'wind', 'rain',
  'aqi', 'humidity', 'pm25', 'pm10', 'no2', 'pollen', 'pressure', 'visibility', 'uv', 'clouds',
]);

module.exports = { WEATHER_LANGS, WEATHER_FIELD_IDS };
