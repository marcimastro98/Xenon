'use strict';

// The faces a pump screen can show, and the choices each one keeps. One owner for
// them: the server's store, the menu, the face page, Bit and the Deck read this file,
// so a value one accepts can never be dropped by another on the next save.
//
// A face is { face: 'music', ...its choices }. Anything unknown falls back to the
// face's default, never to an error: a setting saved by a newer Xenon still shows.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PumpFaces = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const FACES = Object.freeze(['sensors', 'game', 'music', 'clock', 'picture']);

  // What a sensor or game face can show. Each one is read from the `system` stream
  // the dashboard already gets, and a reading this PC lacks is left out on screen.
  const READINGS = Object.freeze(['cpuTemp', 'cpu', 'gpuTemp', 'gpu', 'ram', 'vram', 'power', 'fps', 'cpuClock', 'gpuClock']);
  const MAX_READINGS = 4;
  const SENSOR_STYLES = Object.freeze(['rings', 'bars', 'numbers']);
  const MUSIC_STYLES = Object.freeze(['cover', 'vinyl', 'pulse']);
  const CLOCK_STYLES = Object.freeze(['digital', 'analog']);
  const FITS = Object.freeze(['cover', 'contain']);
  // Seconds a picture of a slideshow stays.
  const PICTURE_EVERY = Object.freeze([5, 10, 30, 60, 300]);
  const MAX_PICTURES = 12;
  // A picture is a file the person added (uploads/, served by the dashboard) or one
  // of the moving pictures the face page draws itself ('art:aurora'). Never a URL
  // from elsewhere: the face page loads no host but ours.
  const UPLOAD_RE = /^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,110}\.[A-Za-z0-9]{2,5}$/;
  const OWN_ART = Object.freeze(['art:aurora', 'art:ember', 'art:tide', 'art:orbit']);
  const isPicture = (p) => typeof p === 'string' && (UPLOAD_RE.test(p) || OWN_ART.includes(p));

  // A Store widget as the face ({ face: 'widget', id }): the dashboard's own sandbox runs it
  // (pump-widget.html). Not in FACES: it needs an installed widget, so a Deck key's list,
  // "next" and a setup never pick it. The id rule is the SDK's (widget-sdk/package-names.js).
  const WIDGET = 'widget';
  const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

  const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);

  function cleanReadings(raw, fallback) {
    const list = [...new Set(Array.isArray(raw) ? raw : [])].filter((r) => READINGS.includes(r)).slice(0, MAX_READINGS);
    return list.length ? list : [...fallback];
  }

  function cleanPictures(raw) {
    const list = [...new Set(Array.isArray(raw) ? raw : [])].filter(isPicture);
    return list.length ? list.slice(0, MAX_PICTURES) : [OWN_ART[0]];
  }

  const DEFAULTS = Object.freeze({
    sensors: Object.freeze({ style: 'rings', readings: Object.freeze(['cpuTemp', 'gpuTemp']) }),
    game: Object.freeze({ readings: Object.freeze(['fps', 'gpuTemp', 'cpuTemp']), track: true }),
    music: Object.freeze({ style: 'cover' }),
    clock: Object.freeze({ style: 'digital', seconds: false, date: true, weather: true }),
    picture: Object.freeze({ items: Object.freeze([OWN_ART[0]]), every: 10, fit: 'cover' }),
  });

  const SHAPERS = {
    sensors: (r) => ({ style: pick(r.style, SENSOR_STYLES, 'rings'), readings: cleanReadings(r.readings, DEFAULTS.sensors.readings) }),
    game: (r) => ({ readings: cleanReadings(r.readings, DEFAULTS.game.readings), track: r.track !== false }),
    music: (r) => ({ style: pick(r.style, MUSIC_STYLES, 'cover') }),
    clock: (r) => ({ style: pick(r.style, CLOCK_STYLES, 'digital'), seconds: r.seconds === true, date: r.date !== false, weather: r.weather !== false }),
    picture: (r) => ({ items: cleanPictures(r.items), every: pick(Number(r.every), PICTURE_EVERY, 10), fit: pick(r.fit, FITS, 'cover') }),
  };

  // A face with its choices, or null when `raw` names no face at all (or no widget).
  function normalizeFace(raw) {
    const r = raw && typeof raw === 'object' ? raw : { face: raw };
    if (r.face === WIDGET) return typeof r.id === 'string' && WIDGET_ID_RE.test(r.id) ? { face: WIDGET, id: r.id } : null;
    if (!FACES.includes(r.face)) return null;
    return { face: r.face, ...SHAPERS[r.face](r) };
  }

  const defaultFace = (face) => normalizeFace({ face });

  // Changes `patch` makes to a face: the same face keeps the choices it had.
  function mergeFace(current, patch) {
    const p = patch && typeof patch === 'object' ? patch : { face: patch };
    const base = current && (!p.face || p.face === current.face) ? current : {};
    return normalizeFace({ ...base, ...p, face: p.face || current?.face });
  }

  return Object.freeze({
    FACES, READINGS, MAX_READINGS, SENSOR_STYLES, MUSIC_STYLES, CLOCK_STYLES, FITS, PICTURE_EVERY,
    MAX_PICTURES, OWN_ART, WIDGET, WIDGET_ID_RE, isPicture, normalizeFace, defaultFace, mergeFace,
  });
});
