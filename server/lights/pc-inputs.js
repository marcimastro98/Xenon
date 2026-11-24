'use strict';
// What the PC feeds the light effects that follow it (js/light-fx/light-fx.js `needs`): how hard
// it works, how fast its fans turn, today's sunrise and sunset, the weather outside and a Xenon
// timer running down. Read when a frame asks, from what Xenon already keeps: nothing is polled for
// the lights. The fans come from Airflow while it reads them (only read, never started), else from
// the sensors' last reading. The weather is asked for only while an effect wants it and Xenon
// holds no answer of the last hour (a weather tile keeps one fresh).

const { cpuRead } = require('../system/cpu-usage-state.js');
const { sensorCache } = require('../system/sensor-cache.js');
const { weatherCache } = require('../weather/cache.js');
const { timerState } = require('../time/timer-list.js');
const { _getTimerRemaining } = require('../time/timer-values.js');

const AIRFLOW_FRESH_MS = 5000;
const SENSORS_FRESH_MS = 15_000;
const AIRFLOW_READING = Object.freeze(['watching', 'driving', 'pc', 'checking']);
const WEATHER_FRESH_MS = 60 * 60_000;   // older, the weather is asked for again
const WEATHER_RETRY_MS = 30 * 60_000;   // at most this often, answer or not
const WEATHER_STALE_MS = 3 * 60 * 60_000;   // older, the sky outside is no longer told
const SUN_STALE_MS = 3 * 24 * 60 * 60_000;   // sunrise moves a few minutes a day

// The weather services' condition codes (WWO: wttr.in's own, and the ones
// weather/forecast-shape.js gives the other services' answers) by what the lights draw.
const KIND_OF_CODE = new Map(Object.entries({
  clear: [113], clouds: [116, 119, 122], fog: [143, 248, 260],
  rain: [176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359],
  snow: [179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377],
  storm: [200, 386, 389, 392, 395],
}).flatMap(([kind, codes]) => codes.map((c) => [c, kind])));

// Where the readings come from; tests put their own in.
const sources = {
  airflow: () => require('../airflow/index.js').loop.status(),
  getWeather: (lang) => require('../weather/get-weather.js').getWeather(lang),
};
let weatherAsked = -Infinity;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mean = (list) => (list.length ? list.reduce((a, n) => a + n, 0) / list.length : null);

const load = () => (Number.isFinite(cpuRead.usage) ? clamp01(cpuRead.usage / 100) : null);

// The fans' mean speed in rpm, the pump and the power supply's own fan left out, or null.
function fans(now) {
  let status = null;
  try { status = sources.airflow(); } catch { /* no Airflow here */ }
  if (status && AIRFLOW_READING.includes(status.state) && now - status.at < AIRFLOW_FRESH_MS) {
    const rpm = mean((status.fans || []).filter((f) => f.kind !== 'pump' && f.rpm > 0).map((f) => f.rpm));
    if (rpm != null) return rpm;
  }
  const r = sensorCache.reading;
  if (!(now - r.updatedAt < SENSORS_FRESH_MS)) return null;
  return mean((r.fans || []).filter((f) => f.kind !== 'psu' && f.rpm > 0).map((f) => f.rpm));
}

// "06:42" or wttr.in's "6:42 AM", as minutes from midnight, or null.
function minutesOf(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) h = (h % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

// The newest weather Xenon holds, any language or place; asked for again when old.
function weatherNow(now) {
  let best = null;
  for (const e of weatherCache.values()) if (e?.data && (!best || e.updatedAt > best.updatedAt)) best = e;
  if ((!best || now - best.updatedAt > WEATHER_FRESH_MS) && now - weatherAsked > WEATHER_RETRY_MS) {
    weatherAsked = now;
    Promise.resolve().then(() => sources.getWeather('en')).catch(() => { /* asked again later */ });
  }
  return best;
}

function sky(now, entry = weatherNow(now)) {
  if (!entry || now - entry.updatedAt > SUN_STALE_MS) return null;
  const rise = minutesOf(entry.data.sunrise);
  const set = minutesOf(entry.data.sunset);
  return rise != null && set != null && rise !== set ? { rise, set } : null;
}

function weather(now) {
  const entry = weatherNow(now);
  const kind = entry && now - entry.updatedAt <= WEATHER_STALE_MS ? KIND_OF_CODE.get(Number(entry.data.code)) : null;
  if (!kind) return null;
  const sun = sky(now, entry) || { rise: 390, set: 1140 };
  const d = new Date(now);
  const at = d.getHours() * 60 + d.getMinutes();
  const day = sun.rise < sun.set ? at >= sun.rise && at < sun.set : at >= sun.rise || at < sun.set;
  return { kind, night: !day };
}

// The countdown nearest its end, running ones first: how much of it is left, 0..1.
function timer() {
  const live = timerState.list.filter((t) => t.kind !== 'stopwatch' && t.durationSecs > 0 && (t.status === 'running' || t.status === 'paused'));
  const running = live.filter((t) => t.status === 'running');
  const pick = (running.length ? running : live).map((t) => ({ t, secs: _getTimerRemaining(t) })).sort((a, b) => a.secs - b.secs)[0];
  return pick ? { left: clamp01(pick.secs / pick.t.durationSecs) } : null;
}

const READ = Object.freeze({
  load: () => ({ load: load() }),
  fans: (now) => ({ fans: fans(now) }),
  sky: (now) => ({ sky: sky(now) }),
  weather: (now) => ({ weather: weather(now) }),
  timer: () => ({ timer: timer() }),
});

// What an effect with this need follows now, as LightFx.frame's `inputs` take it ({} for a need
// read elsewhere: a level, the sound, the clock).
const inputs = (need, now = Date.now()) => (READ[need] ? READ[need](now) : {});

// The needs this PC cannot follow now: the menu leaves their effects out. Only the fans can be
// missing (a laptop, a Mac, no sensors); with no weather yet, the sky keeps usual times and the
// weather is asked for.
const cannot = (now = Date.now()) => (fans(now) == null ? ['fans'] : []);

module.exports = { inputs, cannot, minutesOf, sources };
