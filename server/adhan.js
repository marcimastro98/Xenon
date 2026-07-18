// adhan.js - prayer (salah) times for the Adhan widget.
//
// Times are computed locally from the sun's position, so the widget needs no
// API key, no account, and keeps working with the network down. The only thing
// that ever leaves the machine is the coordinate lookup, and that is the
// weather widget's existing ipwho.is resolver, reused rather than duplicated
// (and skipped entirely when the user pins coordinates manually).
//
// The maths is the standard astronomical solution used by every prayer-time
// implementation: solar declination and the equation of time give solar noon
// (Dhuhr); each other prayer is the hour angle at which the sun sits at a
// prescribed altitude. What differs between authorities is only the twilight
// angle chosen for Fajr and Isha, which is why the method is a setting.

'use strict';

// --- degree-based trig helpers ---------------------------------------------
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const dsin = (d) => Math.sin(d * D2R);
const dcos = (d) => Math.cos(d * D2R);
const dtan = (d) => Math.tan(d * D2R);
const darcsin = (x) => Math.asin(x) * R2D;
const darccos = (x) => Math.acos(x) * R2D;
const darctan2 = (y, x) => Math.atan2(y, x) * R2D;
const darccot = (x) => Math.atan2(1, x) * R2D;
const fixAngle = (a) => { const r = a - 360 * Math.floor(a / 360); return r < 0 ? r + 360 : r; };
const fixHour = (h) => { const r = h - 24 * Math.floor(h / 24); return r < 0 ? r + 24 : r; };

// --- calculation methods ----------------------------------------------------
// fajr/isha are degrees below the horizon. An isha given as {minutes: n} means
// "n minutes after Maghrib" (Umm al-Qura and Qatar define it that way, since at
// their latitudes a fixed interval is the traditional practice).
const CALC_METHODS = Object.freeze({
  egyptian: { key: 'egyptian', label: 'Egyptian General Authority', fajr: 19.5, isha: 17.5 },
  mwl: { key: 'mwl', label: 'Muslim World League', fajr: 18, isha: 17 },
  isna: { key: 'isna', label: 'ISNA (North America)', fajr: 15, isha: 15 },
  makkah: { key: 'makkah', label: 'Umm al-Qura (Makkah)', fajr: 18.5, isha: { minutes: 90 } },
  karachi: { key: 'karachi', label: 'Univ. of Islamic Sciences, Karachi', fajr: 18, isha: 18 },
  // Dubai and Diyanet publish fixed per-prayer corrections on top of the angles,
  // so the angle-only result is a few minutes off their official tables.
  dubai: { key: 'dubai', label: 'Dubai (UAE)', fajr: 18.2, isha: 18.2, offsets: { dhuhr: 3, maghrib: 3 } },
  turkey: {
    key: 'turkey', label: 'Diyanet (Turkey)', fajr: 18, isha: 17,
    offsets: { sunrise: -7, dhuhr: 5, asr: 4, maghrib: 7 },
  },
  singapore: { key: 'singapore', label: 'Singapore / MUIS', fajr: 20, isha: 18 },
  tehran: { key: 'tehran', label: 'Univ. of Tehran', fajr: 17.7, isha: 14, maghrib: 4.5 },
});
const METHOD_KEYS = Object.freeze(Object.keys(CALC_METHODS));
const DEFAULT_METHOD = 'egyptian';

// Asr: the shadow length factor. Standard (Shafi/Maliki/Hanbali) = 1, Hanafi = 2.
const ASR_FACTORS = Object.freeze({ standard: 1, hanafi: 2 });

// Sunrise/sunset altitude, accounting for refraction and the solar disc radius.
const SUNRISE_ANGLE = 0.833;

const PRAYER_KEYS = Object.freeze(['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']);

// --- solar position ---------------------------------------------------------
function julianDay(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

// Declination (degrees) and equation of time (hours) for a given Julian day.
function sunPosition(jd) {
  const d = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * d);          // mean anomaly
  const q = fixAngle(280.459 + 0.98564736 * d);          // mean longitude
  const l = fixAngle(q + 1.915 * dsin(g) + 0.020 * dsin(2 * g)); // ecliptic longitude
  const e = 23.439 - 0.00000036 * d;                     // obliquity
  const ra = fixHour(darctan2(dcos(e) * dsin(l), dcos(l)) / 15);
  return { declination: darcsin(dsin(e) * dsin(l)), equation: q / 15 - ra };
}

// --- core computation -------------------------------------------------------
// Returns each prayer as hours (float, local clock time) for the given date.
function computeDayTimes(date, lat, lon, tzHours, method, asrFactor, highLatRule) {
  const jd = julianDay(date.getFullYear(), date.getMonth() + 1, date.getDate()) - lon / (15 * 24);
  const { declination: decl, equation: eqt } = sunPosition(jd);

  // Solar noon in local clock time.
  const dhuhr = fixHour(12 - eqt) - lon / 15 + tzHours;

  // Hours from noon at which the sun sits `angle` degrees below the horizon.
  // Returns null inside the polar day/night, where no such moment exists.
  const hourAngle = (angle) => {
    const num = -dsin(angle) - dsin(decl) * dsin(lat);
    const den = dcos(decl) * dcos(lat);
    const x = num / den;
    if (!Number.isFinite(x) || x > 1 || x < -1) return null;
    return darccos(x) / 15;
  };

  const before = (angle) => { const h = hourAngle(angle); return h === null ? null : dhuhr - h; };
  const after = (angle) => { const h = hourAngle(angle); return h === null ? null : dhuhr + h; };

  // Asr: the sun's altitude when an object's shadow equals its noon shadow plus
  // `factor` times the object's height.
  const asrAngle = -darccot(asrFactor + dtan(Math.abs(lat - decl)));

  const sunrise = before(SUNRISE_ANGLE);
  const sunset = after(SUNRISE_ANGLE);
  let fajr = before(method.fajr);
  const asr = after(asrAngle);
  const maghrib = typeof method.maghrib === 'number' ? after(method.maghrib) : sunset;

  let isha;
  if (method.isha && typeof method.isha === 'object' && method.isha.minutes) {
    isha = maghrib === null ? null : maghrib + method.isha.minutes / 60;
  } else {
    isha = after(method.isha);
  }

  // High latitudes: above roughly 48 degrees the sun may never reach the Fajr or
  // Isha angle in summer, leaving them undefined. Fall back to a portion of the
  // night, the standard remedy.
  if (highLatRule !== 'none' && sunset !== null && sunrise !== null) {
    const night = fixHour(sunrise + 24 - sunset);
    const portion = (rule, angle) => {
      if (rule === 'oneSeventh') return night / 7;
      if (rule === 'angleBased') return (night / 60) * angle;
      return night / 2; // nightMiddle
    };
    const fajrLimit = portion(highLatRule, method.fajr);
    if (fajr === null || fixHour(sunrise - fajr) > fajrLimit) fajr = sunrise - fajrLimit;
    if (typeof method.isha === 'number') {
      const ishaLimit = portion(highLatRule, method.isha);
      if (isha === null || fixHour(isha - sunset) > ishaLimit) isha = sunset + ishaLimit;
    }
  }

  const out = { fajr, sunrise, dhuhr, asr, maghrib, isha };
  // Method-specific published corrections (see CALC_METHODS).
  if (method.offsets) {
    for (const k of Object.keys(method.offsets)) {
      if (out[k] !== null && out[k] !== undefined) out[k] += method.offsets[k] / 60;
    }
  }
  return out;
}

// --- payload assembly -------------------------------------------------------
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// Local timezone offset in hours for a specific date, so DST is handled.
function tzOffsetHours(date) {
  return -date.getTimezoneOffset() / 60;
}

function hoursToDate(base, hours) {
  if (hours === null || !Number.isFinite(hours)) return null;
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setTime(d.getTime() + Math.round(hours * 3600 * 1000));
  return d;
}

const DEFAULT_ADHAN = Object.freeze({
  method: DEFAULT_METHOD,
  asr: 'standard',
  highLat: 'nightMiddle',
  mode: 'auto',            // 'auto' = reuse the geolocated place, 'manual' = pinned
  lat: null,
  lon: null,
  city: '',
  alertMinutes: 10,        // lead time for the "approaching" visual state
  hijri: true,
  tune: Object.freeze({ fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 }),
});

function normalizeAdhan(source) {
  const s = source && typeof source === 'object' ? source : {};
  const tuneIn = s.tune && typeof s.tune === 'object' ? s.tune : {};
  const tune = {};
  for (const k of PRAYER_KEYS) tune[k] = clampInt(tuneIn[k], -60, 60, 0);
  const lat = Number(s.lat);
  const lon = Number(s.lon);
  return {
    method: METHOD_KEYS.includes(s.method) ? s.method : DEFAULT_METHOD,
    asr: s.asr === 'hanafi' ? 'hanafi' : 'standard',
    highLat: ['none', 'nightMiddle', 'oneSeventh', 'angleBased'].includes(s.highLat) ? s.highLat : 'nightMiddle',
    mode: s.mode === 'manual' ? 'manual' : 'auto',
    lat: Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
    lon: Number.isFinite(lon) && Math.abs(lon) <= 180 ? lon : null,
    city: String(s.city || '').slice(0, 80),
    alertMinutes: clampInt(s.alertMinutes, 0, 60, 10),
    hijri: s.hijri !== false,
    tune,
  };
}

// Islamic (Hijri) date via Intl, which ships with Node's full-icu build. Purely
// decorative, so any failure just drops the line rather than breaking the tile.
function hijriDate(date, lang) {
  try {
    const loc = `${lang && /^[a-z]{2}$/i.test(lang) ? lang : 'en'}-u-ca-islamic-umalqura`;
    return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  } catch {
    return '';
  }
}

// Build the widget payload: today's times, which prayer is current, and the
// next one with the seconds remaining (the client counts down from there).
function buildAdhanPayload(cfg, place, now, lang) {
  const s = normalizeAdhan(cfg);
  const lat = s.mode === 'manual' ? s.lat : (place && Number(place.lat));
  const lon = s.mode === 'manual' ? s.lon : (place && Number(place.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'no_location', method: s.method, asr: s.asr, times: [], next: null };
  }

  const method = CALC_METHODS[s.method] || CALC_METHODS[DEFAULT_METHOD];
  const asrFactor = ASR_FACTORS[s.asr] || 1;
  const ref = now instanceof Date ? now : new Date();

  const dayTimes = (date) => {
    const raw = computeDayTimes(date, lat, lon, tzOffsetHours(date), method, asrFactor, s.highLat);
    const out = {};
    for (const k of PRAYER_KEYS) {
      const d = hoursToDate(date, raw[k]);
      out[k] = d ? new Date(d.getTime() + (s.tune[k] || 0) * 60000) : null;
    }
    return out;
  };

  const today = dayTimes(ref);
  const tomorrow = dayTimes(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1));

  // Sunrise is shown for reference but is not a prayer, so it never becomes
  // "next" and never triggers the alert state.
  const ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const times = ORDER.map((k) => ({
    key: k,
    at: today[k] ? today[k].getTime() : null,
    prayer: k !== 'sunrise',
  }));

  let next = null;
  for (const k of ORDER) {
    if (k === 'sunrise') continue;
    if (today[k] && today[k].getTime() > ref.getTime()) { next = { key: k, at: today[k].getTime(), tomorrow: false }; break; }
  }
  if (!next && tomorrow.fajr) next = { key: 'fajr', at: tomorrow.fajr.getTime(), tomorrow: true };

  // Current prayer = the most recent one already passed today.
  let current = null;
  for (const k of ORDER) {
    if (k === 'sunrise') continue;
    if (today[k] && today[k].getTime() <= ref.getTime()) current = k;
  }

  return {
    ok: true,
    times,
    next,
    current,
    method: s.method,
    methodLabel: method.label,
    asr: s.asr,
    alertMinutes: s.alertMinutes,
    location: s.mode === 'manual'
      ? (s.city || `${lat.toFixed(2)}, ${lon.toFixed(2)}`)
      : ((place && (place.location || place.country)) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`),
    lat,
    lon,
    hijri: s.hijri ? hijriDate(ref, lang) : '',
    refreshedAt: ref.getTime(),
  };
}

module.exports = {
  DEFAULT_ADHAN,
  normalizeAdhan,
  buildAdhanPayload,
  CALC_METHODS,
  METHOD_KEYS,
  PRAYER_KEYS,
  // exported for tests
  computeDayTimes,
  julianDay,
  sunPosition,
};
