'use strict';

// What the Weather tile works out from the forecast before drawing it. Pure, so the tile
// (js/weather-tile.js) and the tests read the same rules. An hour here is what the tile
// hands over: { state, rain, min }, with `state` a class from classifyWeatherState, `rain`
// a chance in percent or null, `min` the minutes since midnight or null.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WeatherOutlook = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const WET_STATES = Object.freeze({ 'state-rain': 'rain', 'state-storm': 'storm', 'state-snow': 'snow' });
  // A forecast of even odds or better counts as rain coming, whatever the hour's picture says.
  const LIKELY_RAIN = 50;
  const DAY_MIN = 24 * 60;
  // A flat day should look flat: under this many degrees the line does not fill the chart.
  const SMALLEST_SPAN = 6;
  const CHART_TOP = 8;
  const CHART_BOTTOM = 88;
  // How far a neighbour must stand above a point, in chart percent, to cross its number.
  const LEAN_FROM = 10;

  function wetKind(hour) {
    if (WET_STATES[hour.state]) return WET_STATES[hour.state];
    return Number(hour.rain) >= LIKELY_RAIN ? 'rain' : null;
  }

  function hoursCovered(hours) {
    const first = hours[0].min;
    const last = hours[hours.length - 1].min;
    if (first == null || last == null) return hours.length;
    return Math.max(1, Math.round((((last - first) + DAY_MIN) % DAY_MIN) / 60));
  }

  // The one thing that changes next, or null without hours to read. The first hour is the
  // one under way, so a change is only ever looked for after it.
  // { kind, mode: 'from' | 'until', at } points at an hour; { kind, mode: 'long' | 'dry', span }
  // covers them all.
  function nextChange(hours, nowState) {
    if (!Array.isArray(hours) || hours.length < 2) return null;
    const kinds = hours.map(wetKind);
    const now = WET_STATES[nowState] || null;
    const span = hoursCovered(hours);
    if (now) {
      const dryAt = kinds.findIndex((kind, i) => i > 0 && !kind);
      return dryAt < 0 ? { kind: now, mode: 'long', span } : { kind: now, mode: 'until', at: dryAt };
    }
    const wetAt = kinds.findIndex((kind, i) => i > 0 && kind);
    return wetAt < 0 ? { kind: 'rain', mode: 'dry', span } : { kind: kinds[wetAt], mode: 'from', at: wetAt };
  }

  // Whether an hour of the forecast is the one under way, so it can be called "now" and show
  // the reading rather than the forecast: two different numbers for now would read as a bug.
  function isCurrentHour(min, nowMin) {
    if (!Number.isFinite(min) || !Number.isFinite(nowMin)) return false;
    return ((nowMin - min + DAY_MIN) % DAY_MIN) < 60;
  }

  // The temperature line as chart points: x at the middle of each column, y from 0 (top) to
  // 100, both in percent of the plot. Empty unless every hour has a number: a line with a
  // hole would invent the part it skips.
  function chartPoints(temps) {
    const values = temps.map((value) => (value === null || value === undefined || value === '' ? NaN : Number(value)));
    if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return [];
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = Math.max(SMALLEST_SPAN, high - low);
    const middle = (high + low) / 2;
    return values.map((value, i) => [
      ((i + 0.5) / values.length) * 100,
      CHART_TOP + (0.5 - (value - middle) / span) * (CHART_BOTTOM - CHART_TOP),
    ]);
  }

  // A number sits above its point, so a line coming down into the point from one side would
  // run through it. 1 sends it right, -1 left, 0 leaves it centred: on a peak nothing is in the
  // way, in a valley both sides are.
  function labelLean(points, i) {
    const y = points[i][1];
    const left = i > 0 && y - points[i - 1][1] > LEAN_FROM;
    const right = i < points.length - 1 && y - points[i + 1][1] > LEAN_FROM;
    if (left === right) return 0;
    return left ? 1 : -1;
  }

  // Hours of darkness as runs of columns: [{ from, to }] in shares of the width, 0 to 1.
  // None when every hour is dark: a band across the whole chart marks nothing.
  function nightRuns(flags) {
    if (flags.every(Boolean)) return [];
    const runs = [];
    flags.forEach((night, i) => {
      if (!night) return;
      const last = runs[runs.length - 1];
      if (last && last.end === i) last.end = i + 1;
      else runs.push({ start: i, end: i + 1 });
    });
    return runs.map(({ start, end }) => ({ from: start / flags.length, to: end / flags.length }));
  }

  // The colour of a temperature in Celsius, the same for everyone: a day's bar shows what the
  // day feels like, not just where it sits among the days around it.
  const TEMP_SCALE = Object.freeze([
    [-10, [146, 170, 255]], [0, [110, 190, 255]], [10, [92, 212, 196]],
    [18, [176, 220, 110]], [25, [255, 200, 84]], [32, [255, 136, 72]], [40, [240, 84, 84]],
  ]);
  function tempColor(celsius) {
    const value = Number(celsius);
    const at = Number.isFinite(value) ? Math.max(TEMP_SCALE[0][0], Math.min(TEMP_SCALE[TEMP_SCALE.length - 1][0], value)) : 10;
    const upper = Math.max(1, TEMP_SCALE.findIndex(([stop]) => stop >= at));
    const [fromAt, from] = TEMP_SCALE[upper - 1];
    const [toAt, to] = TEMP_SCALE[upper];
    const share = (at - fromAt) / (toAt - fromAt);
    return `rgb(${from.map((part, i) => Math.round(part + (to[i] - part) * share)).join(' ')})`;
  }

  // Details by what matters now: a warning first, the rest in the order given.
  function orderFacts(facts) {
    return [...facts.filter((fact) => fact.warn), ...facts.filter((fact) => !fact.warn)];
  }

  return Object.freeze({ wetKind, nextChange, isCurrentHour, chartPoints, labelLean, nightRuns, tempColor, orderFacts });
});
