// Every weather detail switched on: what the weather tile shows until the user turns one off.

const { WEATHER_FIELD_IDS } = require('./setting-values.js');

const WEATHER_FIELDS_ALL_ON = Object.freeze(
  WEATHER_FIELD_IDS.reduce((acc, id) => { acc[id] = true; return acc; }, {}),
);


module.exports = { WEATHER_FIELDS_ALL_ON };
