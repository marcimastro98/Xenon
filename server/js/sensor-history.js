// The sensor-history setting (Settings → Performance → Sensor history), shared
// by the dashboard (window.SensorHistory) and the server (require): one shape,
// one normalizer, so a value the client saves is the value the sampler reads.
//
//   { enabled: bool, everyMin: 1 | 2 | 5 | 10 | 15 }
//
// `everyMin` is how often a sample is taken. Hourly and daily averages use every
// sample; the last few hours are also kept at that resolution (guardian.js), so
// a shorter interval shows short spikes that an hourly average would hide.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SensorHistory = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EVERY_MIN_CHOICES = Object.freeze([1, 2, 5, 10, 15]);
  const DEFAULT_EVERY_MIN = 5;

  function normalizeEveryMin(value) {
    const n = Number(value);
    return EVERY_MIN_CHOICES.includes(n) ? n : DEFAULT_EVERY_MIN;
  }

  function normalizeSensorHistory(value) {
    const v = value && typeof value === 'object' ? value : {};
    return { enabled: v.enabled === true, everyMin: normalizeEveryMin(v.everyMin) };
  }

  return { EVERY_MIN_CHOICES, DEFAULT_EVERY_MIN, normalizeEveryMin, normalizeSensorHistory };
});
