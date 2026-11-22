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

  // How a face looks, chosen line by line (a red Game face while playing, a calm one the rest
  // of the time). Defaults are the look every face had before these choices existed.
  // colors: a set of the face page's (PumpFace.css), 'theme' (the accent of Settings),
  // 'picture' (the colours of the cover, GIF or background on show, read live) or one colour
  // of the person's own. bg: black, a soft glow of the first colour, or a picture behind,
  // dimmed. warn: a reading turns amber, then red, when warm or hot.
  const COLOR_SETS = Object.freeze(['xenon', 'theme', 'picture', 'fire', 'ice', 'violet', 'mono']);
  const HEX_RE = /^#[0-9a-f]{6}$/;
  const BACKGROUNDS = Object.freeze(['black', 'glow']);
  const SIZES = Object.freeze(['normal', 'big']);
  const UNITS = Object.freeze(['auto', 'c', 'f']);
  const TEXT_MAX = 24;
  // How the ring of lights around the pump moves while this line shows (lights/pump-ring.js):
  // 'auto' as the screen's lights say (still, or with the sound), or still, breathing, a light
  // running round, or with the beat of the sound the PC plays. Its colours are the line's.
  const LED_EFFECTS = Object.freeze(['auto', 'still', 'breathe', 'spin', 'beat']);
  const LOOK = Object.freeze({ colors: 'xenon', bg: 'black', size: 'normal', units: 'auto', warn: true, text: '', leds: 'auto' });
  // A widget face draws itself: its line keeps only these. colors, size and units are what the
  // widget is told (placement.look, face-widget.js); colours read off a picture are the face
  // page's own, so a widget gets Xenon's set instead. leds moves the ring, never the widget.
  const WIDGET_LOOK = Object.freeze(['colors', 'size', 'units', 'leds']);
  const widgetLook = (r) => cleanLook(r.colors === 'picture' ? { ...r, colors: LOOK.colors } : r, WIDGET_LOOK);

  // The four colours of each set, one per reading (the first one leads: rings, hands, glow).
  // 'xenon' is Bit's moods (PumpFace.css); 'theme' and a colour of one's own are shaded here.
  const COLOR_HEX = Object.freeze({
    xenon: Object.freeze(['#6ee787', '#8ab4f8', '#ffd75e', '#b4a0ff']),
    fire: Object.freeze(['#ff7a45', '#ffc145', '#ff4d6d', '#ffa3a3']),
    ice: Object.freeze(['#7dd3fc', '#e0f2fe', '#60a5fa', '#a5f3fc']),
    violet: Object.freeze(['#c084fc', '#f0abfc', '#818cf8', '#f9a8d4']),
    mono: Object.freeze(['#ffffff', '#c8c8c8', '#9a9a9a', '#e4e4e4']),
  });

  // `hex` mixed toward white (w > 0) or black (w < 0) by |w|.
  function mix(hex, w) {
    const to = w > 0 ? 255 : 0;
    const at = (i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - Math.abs(w)) + to * Math.abs(w));
    return '#' + [1, 3, 5].map((i) => at(i).toString(16).padStart(2, '0')).join('');
  }
  const shades = (hex) => [hex, mix(hex, 0.45), mix(hex, -0.3), mix(hex, 0.7)];

  // The four colours a look shows, or null for 'picture' (read from what the face shows).
  function colorsOf(colors, accent) {
    if (COLOR_HEX[colors]) return [...COLOR_HEX[colors]];
    if (colors === 'theme') return shades(HEX_RE.test(String(accent).toLowerCase()) ? String(accent).toLowerCase() : COLOR_HEX.xenon[0]);
    if (HEX_RE.test(colors)) return shades(colors);
    return colors === 'picture' ? null : [...COLOR_HEX.xenon];
  }

  function cleanColors(raw) {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return COLOR_SETS.includes(v) || HEX_RE.test(v) ? v : LOOK.colors;
  }

  // Letters, numbers, spaces and plain marks on one line: the pump is often on camera, and
  // nothing here is ever read as markup.
  function cleanText(raw) {
    if (typeof raw !== 'string') return '';
    const flat = raw.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim();
    return [...flat].slice(0, TEXT_MAX).join('').trim();
  }

  // Only what differs from the default look is kept, so a face saved before looks had choices,
  // and one that never changed them, stays as short as it was.
  /** @param {any} r @param {readonly string[]} [keys] */
  function cleanLook(r, keys = Object.keys(LOOK)) {
    const all = {
      colors: cleanColors(r.colors),
      bg: BACKGROUNDS.includes(r.bg) || isPicture(r.bg) ? r.bg : LOOK.bg,
      size: pick(r.size, SIZES, LOOK.size),
      units: pick(r.units, UNITS, LOOK.units),
      warn: r.warn !== false,
      text: cleanText(r.text),
      leds: pick(r.leds, LED_EFFECTS, LOOK.leds),
    };
    return Object.fromEntries(keys.filter((k) => all[k] !== LOOK[k]).map((k) => [k, all[k]]));
  }

  // Only the look, of a face or a patch: what a line keeps when its face changes.
  const lookOf = (show) => (show && typeof show === 'object' ? Object.fromEntries(Object.keys(LOOK).filter((k) => k in show).map((k) => [k, show[k]])) : {});

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
    if (r.face === WIDGET) return typeof r.id === 'string' && WIDGET_ID_RE.test(r.id) ? { face: WIDGET, id: r.id, ...widgetLook(r) } : null;
    if (!FACES.includes(r.face)) return null;
    return { face: r.face, ...SHAPERS[r.face](r), ...cleanLook(r) };
  }

  const defaultFace = (face) => normalizeFace({ face });

  // Changes `patch` makes to a face: the same face keeps the choices it had, another one
  // keeps the line's look (its colours, background, size, units, text, lights).
  function mergeFace(current, patch) {
    const p = patch && typeof patch === 'object' ? patch : { face: patch };
    const base = current && (!p.face || p.face === current.face) ? current : lookOf(current);
    return normalizeFace({ ...base, ...p, face: p.face || current?.face });
  }

  return Object.freeze({
    FACES, READINGS, MAX_READINGS, SENSOR_STYLES, MUSIC_STYLES, CLOCK_STYLES, FITS, PICTURE_EVERY,
    MAX_PICTURES, OWN_ART, WIDGET, WIDGET_ID_RE, isPicture, normalizeFace, defaultFace, mergeFace,
    COLOR_SETS, COLOR_HEX, BACKGROUNDS, SIZES, UNITS, TEXT_MAX, LED_EFFECTS, LOOK, WIDGET_LOOK, lookOf, colorsOf,
  });
});
